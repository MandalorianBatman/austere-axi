// The local server as a sync peer of hosted pages, against a stub page object: rows after a
// cursor, live changes, mutations acked once per (clientId, n). Covers held and --auto remote
// notes in poll and feedback, Send on one machine reaching another, a crash between the notes
// and the cursor, offline local review, and replies pushed live and replayed after being offline.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, before, test } from "node:test";
import type { AddressInfo } from "node:net";
import { WebSocketServer } from "ws";
import type { WebSocket } from "ws";
import { freePort } from "./port.ts";
import { quote } from "../src/cli/paths.ts";
import { ownerHeaders } from "./owner.ts";
import { SUBPROTOCOL, SYNC_VERSION, parseClientFrame, readProtocols } from "../src/shared/sync.ts";
import type { AckFrame, ClientPresence, MutationArgs, NoteItem, NoteRow, PageRow, PresenceStatus, ReplyRow, Row, ServerPresence, ViewerHello } from "../src/shared/sync.ts";

const tmp = (p: string) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const WORK = tmp("austere-peer-work-");
const BASE_ENV = { ...process.env, AUSTERE_AXI_NO_TAILSCALE: "1", AUSTERE_AXI_NO_OPEN: "1", OPENUI_TELEMETRY_DISABLED: "1", AUSTERE_AXI_SYNC_RETRY_MS: "200" };
const TOKEN = crypto.randomBytes(32).toString("base64url");
const page = (title: string) =>
  `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title>\n<script src="https://cdn.jsdelivr.net/npm/austere-axi@0/dist/austere.js"></script></head>\n<body><script type="text/openui">\nroot = TextContent("hello")\n</script></body></html>\n`;

// ── stub page objects ──

interface StubViewer {
  /** null: a hosted reviewer the test plays, with no socket of its own. */
  ws: WebSocket | null;
  hello: ViewerHello;
}

interface StubPage {
  seq: number;
  rows: Map<string, Row>;
  acks: Map<string, AckFrame>;
  live: Set<WebSocket>;
  viewers: Map<string, StubViewer>;
  /** Presence frames the owner peer sent. */
  heard: ClientPresence[];
}

const stub = {
  pages: new Map<string, StubPage>(),
  /** Handshakes are dropped, as when the machine is offline. */
  offline: false,
  /** Every mutation applied, once per (clientId, n). */
  applied: [] as { page: string; name: string; args: unknown }[],
  sockets: new Set<WebSocket>(),
};
let CLOUD = "";
let server: http.Server;
const wss = new WebSocketServer({ noServer: true, handleProtocols: (p) => (p.has(SUBPROTOCOL) ? SUBPROTOCOL : false) });

function newPage(): string {
  const id = crypto.randomBytes(16).toString("base64url");
  stub.pages.set(id, { seq: 0, rows: new Map(), acks: new Map(), live: new Set(), viewers: new Map(), heard: [] });
  return id;
}

/** Writes a row at the page's next seq and sends it to every live socket. */
function put(id: string, row: Omit<NoteRow, "v" | "seq"> | Omit<ReplyRow, "v" | "seq"> | Omit<PageRow, "v" | "seq">): Row {
  const p = stub.pages.get(id) as StubPage;
  const full = { ...row, v: SYNC_VERSION, seq: ++p.seq } as Row;
  p.rows.set(`${full.type}:${full.id}`, full);
  for (const ws of p.live) ws.send(JSON.stringify({ v: SYNC_VERSION, t: "changes", rows: [full], cursor: p.seq }));
  return full;
}

function addNote(id: string, author: string, items: NoteItem[], state: NoteRow["state"] = "held"): string {
  const note = crypto.randomBytes(9).toString("base64url");
  put(id, { type: "note", id: note, author, items, at: Date.now(), state });
  return note;
}

const rowsOf = (id: string) => [...(stub.pages.get(id) as StubPage).rows.values()];

// Presence as the page object keeps it: viewers with a socket get every other viewer's frames.
function toViewers(p: StubPage, frame: ServerPresence, except?: string) {
  for (const [id, v] of p.viewers) if (id !== except && v.ws) v.ws.send(JSON.stringify(frame));
}

function presenceFrame(p: StubPage, ws: WebSocket, f: ClientPresence) {
  p.heard.push(f);
  const page = [...p.rows.values()].find((r): r is PageRow => r.type === "page");
  if (page && !page.presence) return;
  const mine = [...p.viewers.entries()].find(([, v]) => v.ws === ws);
  if (f.t === "hello") {
    const id = mine?.[0] ?? crypto.randomBytes(6).toString("base64url");
    const hello: ViewerHello = { v: SYNC_VERSION, t: "hello", viewer: { id, name: "Owner", colour: "#334455", role: "owner" }, status: f.status, focus: mine?.[1].hello.focus ?? null, self: false };
    p.viewers.set(id, { ws, hello });
    for (const [other, v] of p.viewers) if (other !== id) ws.send(JSON.stringify(v.hello));
    ws.send(JSON.stringify({ ...hello, self: true }));
    return toViewers(p, hello, id);
  }
  if (!mine) return;
  const [id, v] = mine;
  if (f.t === "bye") {
    p.viewers.delete(id);
    return toViewers(p, { v: SYNC_VERSION, t: "bye", viewer: id }, id);
  }
  if (f.t === "status") {
    v.hello.status = f.status;
    return toViewers(p, { v: SYNC_VERSION, t: "status", viewer: id, status: f.status }, id);
  }
  v.hello.focus = f.statement;
  toViewers(p, { v: SYNC_VERSION, t: "focus", viewer: id, statement: f.statement }, id);
}

/** A hosted reviewer joins page `id`; returns what it does next. */
function hostedViewer(id: string, name: string) {
  const p = stub.pages.get(id) as StubPage;
  const vid = crypto.randomBytes(6).toString("base64url");
  const hello: ViewerHello = { v: SYNC_VERSION, t: "hello", viewer: { id: vid, name, colour: "#aa3366", role: "reviewer" }, status: "viewing", focus: null, self: false };
  p.viewers.set(vid, { ws: null, hello });
  toViewers(p, hello, vid);
  return {
    id: vid,
    status(status: PresenceStatus) {
      hello.status = status;
      toViewers(p, { v: SYNC_VERSION, t: "status", viewer: vid, status }, vid);
    },
    focus(statement: string | null) {
      hello.focus = statement;
      toViewers(p, { v: SYNC_VERSION, t: "focus", viewer: vid, statement }, vid);
    },
    leave() {
      p.viewers.delete(vid);
      toViewers(p, { v: SYNC_VERSION, t: "bye", viewer: vid }, vid);
    },
  };
}

function pageSocket(ws: WebSocket, id: string) {
  const p = stub.pages.get(id) as StubPage;
  stub.sockets.add(ws);
  ws.on("close", () => {
    p.live.delete(ws);
    stub.sockets.delete(ws);
    const mine = [...p.viewers.entries()].find(([, v]) => v.ws === ws);
    if (mine) {
      p.viewers.delete(mine[0]);
      toViewers(p, { v: SYNC_VERSION, t: "bye", viewer: mine[0] });
    }
  });
  ws.on("message", (data) => {
    const parsed = parseClientFrame(data.toString());
    assert.ok(parsed.ok, `the CLI sent a frame the schema rejects: ${data.toString()}`);
    const f = parsed.value;
    if (f.t === "pull") {
      const rows = [...p.rows.values()].filter((r) => r.seq > f.after).sort((a, b) => a.seq - b.seq);
      ws.send(JSON.stringify({ v: SYNC_VERSION, t: "changes", rows, cursor: p.seq }));
      p.live.add(ws);
      return;
    }
    if (f.t === "hello" || f.t === "status" || f.t === "focus" || f.t === "bye") return presenceFrame(p, ws, f);
    if (f.t !== "mutation") return;
    const key = `${f.clientId}:${f.n}`;
    const known = p.acks.get(key);
    if (known) return ws.send(JSON.stringify(known));
    const ack: AckFrame = { v: SYNC_VERSION, t: "ack", clientId: f.clientId, n: f.n };
    p.acks.set(key, ack);
    stub.applied.push({ page: id, name: f.name, args: f.args });
    ws.send(JSON.stringify(ack));
    if (f.name === "releaseNote" || f.name === "discardNote") {
      const note = p.rows.get(`note:${(f.args as MutationArgs["releaseNote"]).note}`) as NoteRow;
      if (note.state === "held") put(id, { ...note, state: f.name === "releaseNote" ? "released" : "discarded" });
    }
    if (f.name === "addReply") put(id, { type: "reply", id: crypto.randomBytes(9).toString("base64url"), text: (f.args as MutationArgs["addReply"]).text, at: Date.now() });
  });
}

before(async () => {
  server = http.createServer((_req, res) => {
    res.writeHead(404);
    res.end();
  });
  server.on("upgrade", (req, socket, head) => {
    if (stub.offline) return socket.destroy();
    const u = new URL(req.url ?? "", "http://stub");
    const m = /^\/api\/pages\/([^/]+)\/sync$/.exec(u.pathname);
    const creds = readProtocols(req.headers["sec-websocket-protocol"]);
    if (!m || !creds.sync || creds.owner !== TOKEN) return socket.destroy();
    if (!stub.pages.has(m[1])) {
      // An expired or deleted page: a plain HTTP refusal.
      const body = JSON.stringify({ error: { code: "invalid", message: "page not found" } });
      return socket.end(`HTTP/1.1 404 Not Found\r\ncontent-type: application/json\r\ncontent-length: ${body.length}\r\nconnection: close\r\n\r\n${body}`);
    }
    wss.handleUpgrade(req, socket, head, (ws) => pageSocket(ws, m[1]));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  CLOUD = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(() => {
  for (const ws of stub.sockets) ws.terminate();
  wss.close();
  server.close();
  fs.rmSync(WORK, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
});

function goOffline() {
  stub.offline = true;
  for (const ws of stub.sockets) ws.terminate();
}

// ── a machine: state dir, port, cloud.json ──

interface Machine {
  state: string;
  port: number;
  run: (...args: string[]) => Promise<{ code: number | null; out: string }>;
  api: (method: string, route: string, body?: unknown) => Promise<{ status: number; data: Record<string, unknown> }>;
}

async function machine(pages: Record<string, { id: string; auto: boolean }>): Promise<Machine> {
  const state = tmp("austere-peer-state-");
  fs.writeFileSync(path.join(state, "cloud.json"), JSON.stringify({ url: CLOUD, token: TOKEN, pages }), { mode: 0o600 });
  const port = await freePort();
  const env = { ...BASE_ENV, AUSTERE_AXI_STATE_DIR: state, AUSTERE_AXI_PORT: String(port) };
  const run = (...args: string[]) =>
    new Promise<{ code: number | null; out: string }>((resolve) => {
      const child = spawn(process.execPath, ["src/cli/main.ts", ...args], { env });
      let out = "";
      child.stdout.on("data", (c: Buffer) => (out += c));
      child.on("close", (code) => resolve({ code, out }));
    });
  const api = async (method: string, route: string, body?: unknown) => {
    const res = await fetch(`http://127.0.0.1:${port}${route}`, {
      method,
      headers: { ...ownerHeaders(state), host: `127.0.0.1:${port}`, origin: `http://127.0.0.1:${port}`, "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, data: (text ? JSON.parse(text) : {}) as Record<string, unknown> };
  };
  return { state, port, run, api };
}

async function cleanup(...ms: Machine[]) {
  for (const m of ms) {
    await m.run("stop");
    fs.rmSync(m.state, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  }
}

function file(name: string): string {
  const f = path.join(WORK, name);
  fs.writeFileSync(f, page(name));
  return fs.realpathSync(f);
}

/** Opens the file's review on `m` (starting its server) and returns the session id. */
async function open(m: Machine, f: string): Promise<string> {
  const r = await m.run(f, "--no-open");
  assert.equal(r.code, 0, r.out);
  return (/\/s\/([a-f0-9]{12})/.exec(r.out) as RegExpExecArray)[1];
}

/** The session's remote notes, as the owner's review page gets them. */
async function remoteNotes(m: Machine, sid: string): Promise<{ id: string; held?: boolean; remote?: boolean }[]> {
  const r = await m.api("GET", `/s/${sid}/transcript`);
  return (r.data.entries as { id: string; held?: boolean; remote?: boolean }[]).filter((e) => e.remote);
}

async function until<T>(what: string, fn: () => T | Promise<T>, ms = 10_000): Promise<NonNullable<T>> {
  const deadline = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

const field = (out: string, name: string) => new RegExp(`^${name}: (.*)$`, "m").exec(out)?.[1];

/** The owner's review page, as far as presence goes: its event stream's `viewer` events. */
async function reviewPage(m: Machine, sid: string) {
  const ctrl = new AbortController();
  const res = await fetch(`http://127.0.0.1:${m.port}/s/${sid}/events`, { headers: { ...ownerHeaders(m.state), host: `127.0.0.1:${m.port}` }, signal: ctrl.signal });
  const viewer: ServerPresence[] = [];
  const reader = (res.body as ReadableStream<Uint8Array>).getReader();
  const decoder = new TextDecoder();
  let buf = "";
  void (async () => {
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) return;
        buf += decoder.decode(value, { stream: true });
        let cut;
        while ((cut = buf.indexOf("\n\n")) >= 0) {
          const block = buf.slice(0, cut);
          buf = buf.slice(cut + 2);
          const event = /^event: (.*)$/m.exec(block)?.[1];
          const data = /^data: (.*)$/m.exec(block)?.[1];
          if (event === "viewer" && data) viewer.push(JSON.parse(data) as ServerPresence);
        }
      }
    } catch {
      // aborted
    }
  })();
  return { viewer, close: () => ctrl.abort() };
}

// ── tests ──

test("a held remote note stays out of poll until Send; an --auto note arrives at once; both are marked remote", async () => {
  const held = file("held.html");
  const auto = file("auto.html");
  const heldPage = newPage();
  const autoPage = newPage();
  const m = await machine({ [held]: { id: heldPage, auto: false }, [auto]: { id: autoPage, auto: true } });
  try {
    const heldNote = addNote(heldPage, "Ana", [{ kind: "annotation", target: "root", note: "Why now?" }]);
    addNote(autoPage, "Bo", [{ kind: "message", text: "Ship it" }], "released");
    const sid = await open(m, held);
    await open(m, auto);

    let r = await m.run("poll", held, "--timeout-ms", "1500");
    assert.equal(field(r.out, "status"), "timeout", r.out);

    // feedback catches up on its own, without a listening poll.
    r = await m.run("feedback", auto, "--peek");
    assert.match(r.out, /from: Bo\n\s+remote: true/, r.out);
    r = await m.run("poll", auto, "--timeout-ms", "5000");
    assert.equal(field(r.out, "status"), "feedback", r.out);
    assert.match(r.out, /message: Ship it/);
    assert.match(r.out, /remote: true/);

    // Send in the side panel: released here, and on the page object.
    const [note] = await until("the held note", () => remoteNotes(m, sid).then((n) => (n.length ? n : null)));
    assert.equal(note.held, true);
    const sent = await m.api("POST", `/s/${sid}/release`, { ids: [note.id] });
    assert.equal(sent.data.count, 1);
    r = await m.run("poll", held, "--timeout-ms", "5000");
    assert.equal(field(r.out, "status"), "feedback", r.out);
    assert.match(r.out, /from: Ana\n\s+remote: true/);
    assert.match(r.out, /Why now\?/);
    await until("releaseNote on the page", () => stub.applied.some((a) => a.page === heldPage && a.name === "releaseNote"));
    assert.equal((rowsOf(heldPage).find((x) => x.id === heldNote) as NoteRow).state, "released");
  } finally {
    await cleanup(m);
  }
});

test("Send on machine A arrives released on machine B", async () => {
  const f = file("shared.html");
  const id = newPage();
  addNote(id, "Ana", [{ kind: "message", text: "From the hosted page" }]);
  const a = await machine({ [f]: { id, auto: false } });
  const b = await machine({ [f]: { id, auto: false } });
  try {
    const sidA = await open(a, f);
    await open(b, f);
    // B listens; its socket stays open for live rows.
    const waiting = b.run("poll", f, "--timeout-ms", "15000");
    const [note] = await until("the held note on A", () => remoteNotes(a, sidA).then((n) => (n.length ? n : null)));
    await a.api("POST", `/s/${sidA}/release`, { ids: [note.id] });
    const r = await waiting;
    assert.equal(field(r.out, "status"), "feedback", r.out);
    assert.match(r.out, /From the hosted page/);
    assert.match(r.out, /remote: true/);
  } finally {
    await cleanup(a, b);
  }
});

test("a crash after the notes but before the cursor delivers each note once", async () => {
  const f = file("crash.html");
  const id = newPage();
  addNote(id, "Ana", [{ kind: "message", text: "first" }], "released");
  addNote(id, "Bo", [{ kind: "message", text: "second" }], "released");
  const m = await machine({ [f]: { id, auto: true } });
  try {
    await open(m, f);
    let r = await m.run("feedback", f, "--peek");
    assert.match(r.out, /second/, r.out);
    await m.run("stop");

    // What a crash leaves: the first note committed, the second not, the cursor not saved.
    const db = new DatabaseSync(path.join(m.state, "hub.db"));
    const second = db.prepare("SELECT id FROM notes WHERE items LIKE '%second%'").get() as { id: string };
    db.prepare("DELETE FROM items WHERE entry_id = ?").run(second.id);
    db.prepare("DELETE FROM notes WHERE id = ?").run(second.id);
    db.exec("DELETE FROM cloud_pages; DELETE FROM cloud_rows;");
    db.close();

    await open(m, f);
    r = await m.run("poll", f, "--timeout-ms", "5000");
    assert.equal(field(r.out, "status"), "feedback", r.out);
    assert.equal(r.out.match(/message: first/g)?.length, 1, r.out);
    assert.equal(r.out.match(/message: second/g)?.length, 1, r.out);
    const cursor = field(r.out, "cursor") as string;
    r = await m.run("poll", f, "--cursor", cursor, "--timeout-ms", "1500");
    assert.equal(field(r.out, "status"), "timeout", "nothing comes twice");
  } finally {
    await cleanup(m);
  }
});

test("offline: local review works, a reply is queued with a warning and replayed once; online replies go out at once", async () => {
  const f = file("offline.html");
  const id = newPage();
  const m = await machine({ [f]: { id, auto: false } });
  goOffline();
  try {
    const sid = await open(m, f);
    const sent = await m.api("POST", `/s/${sid}/send`, { items: [{ kind: "message", text: "local note" }] });
    assert.equal(sent.status, 200);
    const started = Date.now();
    let r = await m.run("poll", f, "--timeout-ms", "5000");
    assert.equal(field(r.out, "status"), "feedback", r.out);
    assert.match(r.out, /local note/);
    assert.ok(Date.now() - started < 4000, "the service being down does not slow poll");

    r = await m.run("reply", f, "--agent-reply", "Done offline.");
    assert.equal(r.code, 0, r.out);
    assert.match(field(r.out, "warning") ?? "", /queued/, r.out);

    stub.offline = false;
    await until("the queued reply on the page", () => rowsOf(id).some((x) => x.type === "reply"), 15_000);
    r = await m.run("reply", f, "--agent-reply", "Done online.");
    assert.equal(field(r.out, "warning"), undefined, r.out);
    const replies = rowsOf(id).filter((x): x is ReplyRow => x.type === "reply").map((x) => x.text);
    assert.deepEqual(replies, ["Done offline.", "Done online."], "each reply once, in order");
  } finally {
    stub.offline = false;
    await cleanup(m);
  }
});

test("Discard goes out as discardNote, a row discarded upstream never reaches the agent, and a page gone from the service stops its sync", async () => {
  const f = file("discard.html");
  const id = newPage();
  addNote(id, "Ana", [{ kind: "message", text: "drop me" }]);
  addNote(id, "Bo", [{ kind: "message", text: "keep me" }]);
  addNote(id, "Cy", [{ kind: "message", text: "dropped upstream" }], "discarded");
  const m = await machine({ [f]: { id, auto: false } });
  try {
    const sid = await open(m, f);
    const notes = await until("the remote notes", () => remoteNotes(m, sid).then((n) => (n.length === 2 ? n : null)));
    const t = (await m.api("GET", `/s/${sid}/transcript`)).data.entries as { id: string; items: { text: string }[] }[];
    const idOf = (text: string) => (t.find((e) => e.items[0]?.text === text) as { id: string }).id;
    assert.equal(notes.length, 2, "the note discarded upstream is on record, not in the panel");
    await m.api("POST", `/s/${sid}/discard`, { ids: [idOf("drop me")] });
    await m.api("POST", `/s/${sid}/release`, { ids: [idOf("keep me")] });
    let r = await m.run("poll", f, "--timeout-ms", "5000");
    assert.match(r.out, /keep me/, r.out);
    assert.doesNotMatch(r.out, /drop me|dropped upstream/);
    await until("discardNote on the page", () => stub.applied.some((a) => a.page === id && a.name === "discardNote"));
    assert.equal((rowsOf(id).find((x) => x.type === "note" && x.author === "Ana") as NoteRow).state, "discarded");

    // The page expires: the handshake answers 404, the reply stands locally with a warning, and nothing stays queued.
    stub.pages.delete(id);
    r = await m.run("reply", f, "--agent-reply", "Too late.");
    assert.equal(field(r.out, "status"), "replied", r.out);
    assert.match(field(r.out, "warning") ?? "", /answered 404: page not found/, r.out);
    const db = new DatabaseSync(path.join(m.state, "hub.db"), { readOnly: true });
    assert.equal((db.prepare("SELECT COUNT(*) AS n FROM cloud_queue").get() as { n: number }).n, 0);
    db.close();
    assert.match(fs.readFileSync(path.join(m.state, "server.log"), "utf8"), /sync-stopped \S+ .*404/);
  } finally {
    await cleanup(m);
  }
});

test("a closed review holds remote notes, released rows too, and a replayed row does not release them", async () => {
  const f = file("closed.html");
  const id = newPage();
  const m = await machine({ [f]: { id, auto: true } });
  try {
    const sid = await open(m, f);
    await m.api("POST", `/s/${sid}/close`, {});
    addNote(id, "Ana", [{ kind: "message", text: "after close" }], "released");
    await m.run("feedback", f, "--peek");
    assert.equal((await remoteNotes(m, sid))[0]?.held, true);

    // Pull everything again, as after a crash before the cursor: the known note stays held.
    await m.run("stop");
    const db = new DatabaseSync(path.join(m.state, "hub.db"));
    db.exec("DELETE FROM cloud_pages; DELETE FROM cloud_rows;");
    db.close();
    // feedback starts the server for a published file, and the server pulls from 0.
    const r = await m.run("feedback", f, "--peek");
    assert.doesNotMatch(r.out, /after close/, r.out);
    assert.equal((await remoteNotes(m, sid))[0]?.held, true);
  } finally {
    await cleanup(m);
  }
});

test("presence relay: hosted viewers reach the owner's review page; the owner's status and focus reach the hosted page; --no-presence keeps out", async () => {
  const f = file("presence.html");
  const quiet = file("quiet.html");
  const id = newPage();
  const off = newPage();
  const pageRow: Omit<PageRow, "v" | "seq" | "id" | "presence"> = {
    type: "page",
    title: "x",
    cliVersion: "0.9.0",
    html: "0".repeat(64),
    packs: [],
    auto: false,
    unlisted: false,
    publishedAt: Date.now(),
    expiresAt: Date.now() + 86400000,
    deleted: false,
  };
  put(id, { ...pageRow, id, presence: true });
  put(off, { ...pageRow, id: off, presence: false });
  const m = await machine({ [f]: { id, auto: false }, [quiet]: { id: off, auto: false } });
  try {
    const sid = await open(m, f);
    const p = stub.pages.get(id) as StubPage;

    // The review page opens: the server's socket joins as the owner, and the page learns which viewer is itself.
    const local = await reviewPage(m, sid);
    await until("the owner's hello on the page object", () => p.heard.some((x) => x.t === "hello"));
    const self = await until("our own hello, relayed", () => local.viewer.find((x): x is ViewerHello => x.t === "hello" && x.self));
    assert.equal(self.viewer.role, "owner");

    // A hosted viewer joins, starts writing, clicks a statement: all three show locally.
    const ana = hostedViewer(id, "Ana");
    ana.status("writing");
    ana.focus("root");
    await until("Ana's focus, relayed", () => local.viewer.some((x) => x.t === "focus" && x.viewer === ana.id && x.statement === "root"));
    assert.ok(local.viewer.some((x) => x.t === "hello" && x.viewer.name === "Ana"));
    assert.ok(local.viewer.some((x) => x.t === "status" && x.viewer === ana.id && x.status === "writing"));

    // A local click goes to the hosted viewers, who outline it.
    const posted = await m.api("POST", `/s/${sid}/presence`, { v: SYNC_VERSION, t: "focus", statement: "root" });
    assert.equal(posted.status, 204);
    await until("the owner's focus on the page object", () => p.heard.some((x) => x.t === "focus" && x.statement === "root"));
    assert.equal(p.viewers.get(self.viewer.id)?.hello.focus, "root");

    // A second tab gets the roster so far, with Ana's latest status and focus.
    const second = await reviewPage(m, sid);
    const roster = await until("the roster", () => second.viewer.find((x): x is ViewerHello => x.t === "hello" && x.viewer.id === ana.id));
    assert.equal(roster.status, "writing");
    assert.equal(roster.focus, "root");

    // The last review page closes while a poll keeps the socket open: the owner leaves the page.
    const polling = m.run("poll", f, "--timeout-ms", "6000");
    const listening = async () => {
      const r = await fetch(`http://127.0.0.1:${m.port}/api/sessions`, { headers: { "x-austere-key": ownerHeaders(m.state)["x-austere-key"] } });
      return ((await r.json()) as { sessions: { id: string; presence: string }[] }).sessions.some((x) => x.id === sid && x.presence === "listening");
    };
    await until("the poll listening", listening);
    local.close();
    second.close();
    await until("the owner gone from the page object", () => !p.viewers.has(self.viewer.id));
    assert.ok(p.live.size > 0, "the poll keeps the socket");

    // Ana leaves while no review page is open; the next one does not show her.
    ana.leave();
    const third = await reviewPage(m, sid);
    await until("the owner back on the page", () => third.viewer.some((x) => x.t === "hello" && x.self));
    assert.ok(!third.viewer.some((x) => x.t === "hello" && x.viewer.id === ana.id), "no stale chip for Ana");
    third.close();
    await polling;

    // A --no-presence page: pulled (its page row says so), never joined, and an open review page keeps no socket for it.
    const quietSid = await open(m, quiet);
    const q = await reviewPage(m, quietSid);
    await until("the quiet page's row in the cache", () => {
      const db = new DatabaseSync(path.join(m.state, "hub.db"), { readOnly: true });
      const row = db.prepare("SELECT 1 FROM cloud_rows WHERE page_id = ? AND type = 'page'").get(off);
      db.close();
      return row;
    });
    await m.api("POST", `/s/${quietSid}/presence`, { v: SYNC_VERSION, t: "status", status: "viewing" });
    assert.deepEqual((stub.pages.get(off) as StubPage).heard, []);
    q.close();
  } finally {
    await cleanup(m);
  }
});

test("the agent prompt names the file and the poll command, the shared page when published, and never a secret", async () => {
  const held = file("prompt-held.html");
  const auto = file("prompt-auto.html");
  const plain = file("prompt local's.html");
  const live = file("prompt-live.html");
  const heldPage = newPage();
  const autoPage = newPage();
  const livePage = newPage();
  // Published without --auto on this machine, but the page now releases at once (a publish from another machine).
  put(livePage, { type: "page", id: livePage, title: "x", cliVersion: "0.9.0", html: "0".repeat(64), packs: [], auto: true, unlisted: false, presence: true, publishedAt: Date.now(), expiresAt: Date.now() + 86400000, deleted: false });
  const m = await machine({ [held]: { id: heldPage, auto: false }, [auto]: { id: autoPage, auto: true }, [live]: { id: livePage, auto: false } });
  try {
    const prompt = async (f: string) => {
      const sid = await open(m, f);
      const res = await fetch(`http://127.0.0.1:${m.port}/s/${sid}/agent-prompt`, { headers: { ...ownerHeaders(m.state), host: `127.0.0.1:${m.port}` } });
      assert.equal(res.status, 200);
      return res.text();
    };

    const h = await prompt(held);
    assert.ok(h.includes(`austere-axi poll ${quote(held)}`), h);
    assert.ok(h.includes(`austere-axi poll ${quote(held)} --cursor <n> --agent-reply`), h);
    assert.match(h, /listener_active/);
    assert.match(h, /--takeover/);
    assert.ok(h.includes(`Shared page: ${CLOUD}/p/${heldPage}`), h);
    assert.match(h, /only after I send them on/);

    const a = await prompt(auto);
    assert.ok(a.includes(`Shared page: ${CLOUD}/p/${autoPage}`), a);
    assert.match(a, /as they are posted/);
    assert.doesNotMatch(a, /only after I send them on/);

    // The page's live mode decides, not cloud.json's copy: the pull that caches its row may land just after the page opens.
    const sid = await open(m, live);
    const l: string = await until("the live mode in the prompt", async (): Promise<string> => {
      const res = await fetch(`http://127.0.0.1:${m.port}/s/${sid}/agent-prompt`, { headers: { ...ownerHeaders(m.state), host: `127.0.0.1:${m.port}` } });
      const text = await res.text();
      return /as they are posted/.test(text) ? text : "";
    });
    assert.doesNotMatch(l, /only after I send them on/);

    // Not published: the file and the command only, and a path with a quote stays one shell word.
    const p = await prompt(plain);
    assert.ok(p.includes(`austere-axi poll ${quote(plain)}`), p);
    assert.match(p, /austere-axi poll "/, "a path with a space or quote is double-quoted");
    assert.doesNotMatch(p, /Shared page|remote: true/);

    // The owner token, the owner key and invite or login parameters never reach the text.
    const key = fs.readFileSync(path.join(m.state, "owner.key"), "utf8").trim();
    for (const text of [h, a, l, p]) {
      assert.ok(!text.includes(TOKEN) && !text.includes(key), "no secret");
      assert.doesNotMatch(text, /[?&#](key|invite|login|i)=/);
    }
  } finally {
    await cleanup(m);
  }
});
