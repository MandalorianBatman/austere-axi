// Durable notes: hub.db is the record, poll is a cursor read with at-least-once
// delivery, a page always takes notes (a final batch only tells the agent to stop
// listening), and only an archived page refuses them.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import type { IncomingHttpHeaders } from "node:http";
import { SessionStore, sessionId } from "../src/cli/sessions.ts";
import type { Session } from "../src/cli/sessions.ts";
import { Hub } from "../src/cli/hub.ts";
import { freePort } from "./port.ts";
import { ownerKey } from "../src/cli/invites.ts";
import { ownerHeaders } from "./owner.ts";

interface Note {
  id: string;
  text: string;
  author?: string;
  held?: boolean;
}

interface SessionRow {
  id: string;
  archived: boolean;
  pending: number;
}

/** Every response body field these tests read; each route fills in its own. */
interface Body {
  status: string;
  final: boolean;
  cursor: number;
  items: Note[];
  entries: { items: Note[]; end?: boolean }[];
  entry: Note;
  session: { id: string; archived: boolean };
  sessions: SessionRow[];
  link: string;
  pid: number;
  version: string;
  persist: boolean;
}

interface Res {
  status: number | undefined;
  data: Body;
  headers: IncomingHttpHeaders;
}

interface ServerProc {
  child: ChildProcessWithoutNullStreams;
  out: string;
  exited: Promise<number | null>;
}

interface Ctx {
  port: number;
  state: string;
  id: string;
  proc: ServerProc;
}

const tmp = (p: string) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const WORK = tmp("austere-durable-work-");
const FILE = path.join(WORK, "plan.html");
const BASE_ENV = { ...process.env, AUSTERE_AXI_NO_TAILSCALE: "1", AUSTERE_AXI_NO_OPEN: "1", OPENUI_TELEMETRY_DISABLED: "1" };

// The state dir of the server on each port: requests go as its owner, unless they bring a reviewer's cookie.
const stateOf = new Map<number, string>();

function request(port: number, method: string, route: string, body?: unknown, headers: Record<string, string> = {}): Promise<Res> {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const owner = stateOf.has(port) ? ownerHeaders(stateOf.get(port) as string) : {};
    const r = http.request(
      { host: "127.0.0.1", port, method, path: route, headers: { host: `127.0.0.1:${port}`, ...(payload ? { "content-type": "application/json" } : {}), ...owner, ...headers } },
      (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => {
          let parsed: unknown = data;
          try {
            parsed = JSON.parse(data);
          } catch {}
          resolve({ status: res.statusCode, data: parsed as Body, headers: res.headers });
        });
      },
    );
    r.on("error", reject);
    if (payload) r.write(payload);
    r.end();
  });
}

/** Run the server in the foreground; `out` collects what it prints. */
function startServer(port: number, state: string, extraEnv: Record<string, string> = {}): ServerProc {
  stateOf.set(port, state);
  const child = spawn(process.execPath, ["src/cli/main.ts", "server", "--port", String(port)], {
    env: { ...BASE_ENV, AUSTERE_AXI_STATE_DIR: state, ...extraEnv },
  });
  const proc: ServerProc = { child, out: "", exited: new Promise<number | null>((r) => child.once("exit", r)) };
  child.stdout.on("data", (c) => (proc.out += c));
  child.stderr.on("data", (c) => (proc.out += c));
  return proc;
}

async function up(port: number) {
  for (let i = 0; i < 200; i++) {
    try {
      if ((await request(port, "GET", "/api/health")).status === 200) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error("server did not start");
}

async function kill(proc: ServerProc, signal: NodeJS.Signals = "SIGTERM") {
  if (proc.child.exitCode === null && proc.child.signalCode === null) {
    proc.child.kill(signal);
    await proc.exited;
  }
}

function cli(port: number, state: string, ...args: string[]): Promise<{ code: number | null; out: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["src/cli/main.ts", ...args], {
      env: { ...BASE_ENV, AUSTERE_AXI_STATE_DIR: state, AUSTERE_AXI_PORT: String(port) },
    });
    let out = "";
    child.stdout.on("data", (c) => (out += c));
    child.stderr.on("data", (c) => (out += c));
    child.on("close", (code) => resolve({ code, out }));
  });
}

const page = (port: number) => ({ origin: `http://127.0.0.1:${port}` });
const message = (text: string) => ({ items: [{ kind: "message", text }] });

/** Share the plan with a reviewer and join as them, through the invite form; returns their cookie header. */
async function invite(port: number, id: string, name: string): Promise<string> {
  const share = await request(port, "POST", "/api/share", { file: FILE, name });
  assert.equal(share.status, 200, JSON.stringify(share.data));
  const token = new URL(share.data.link).searchParams.get("invite");
  const set = await new Promise<string[] | undefined>((resolve, reject) => {
    const r = http.request(
      { host: "127.0.0.1", port, method: "POST", path: `/s/${id}/join`, headers: { host: `127.0.0.1:${port}`, origin: `http://127.0.0.1:${port}`, "content-type": "application/x-www-form-urlencoded" } },
      (res) => {
        res.resume();
        res.on("end", () => resolve(res.headers["set-cookie"]));
      },
    );
    r.on("error", reject);
    r.end(new URLSearchParams({ invite: token as string }).toString());
  });
  return ([] as string[]).concat(set ?? [])[0].split(";")[0];
}

before(() => {
  fs.writeFileSync(
    FILE,
    `<!doctype html><html><head><title>Plan</title><script src="https://cdn.jsdelivr.net/npm/austere-axi@0/dist/austere.js"></script></head>
<body><script type="text/openui">
root = Stack([intro])
intro = TextContent("hello")
</script></body></html>`,
  );
});

after(() => fs.rmSync(WORK, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }));

/** A server of its own for one test, with the plan open. */
async function withServer(fn: (ctx: Ctx) => Promise<void>, extraEnv?: Record<string, string>) {
  const port = await freePort();
  const state = tmp("austere-durable-state-");
  const proc = startServer(port, state, extraEnv);
  try {
    await up(port);
    const id = (await request(port, "POST", "/api/open", { file: FILE })).data.session.id;
    await fn({ port, state, id, proc });
  } finally {
    await kill(proc);
    fs.rmSync(state, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  }
}

test("a note sent after a final batch is kept, and the next poll returns it", () =>
  withServer(async ({ port, state, id }) => {
    // The reviewer's Send & End: the batch is final, the agent stops listening after it.
    await request(port, "POST", `/s/${id}/send`, { ...message("last words"), end: true }, page(port));
    const last = await request(port, "POST", "/api/poll", { file: FILE });
    assert.equal(last.data.status, "feedback");
    assert.equal(last.data.final, true);
    const peeked = await cli(port, state, "feedback", FILE, "--peek");
    assert.match(peeked.out, /^final: true$/m, "the catch-up read says the same");
    assert.equal(last.data.items[0].text, "last words");

    // The page still takes notes; the next poll gets them, and that batch is not final.
    const sent = await request(port, "POST", `/s/${id}/send`, message("one more thing"), page(port));
    assert.equal(sent.status, 200, "a page always takes notes");
    assert.equal((await request(port, "GET", "/api/sessions")).data.sessions.find((s) => s.id === id)?.pending, 2, "last words still unacknowledged, one more thing waiting");
    const poll = await request(port, "POST", "/api/poll", { file: FILE, cursor: last.data.cursor });
    assert.equal(poll.data.status, "feedback");
    assert.deepEqual(poll.data.items.map((i) => i.text), ["one more thing"]);
    assert.equal(poll.data.final, undefined, "not handed over as a final batch");

    // A plain note that follows an end batch in the same answer means the reviewer carries on.
    await request(port, "POST", `/s/${id}/send`, { ...message("wrap up"), end: true }, page(port));
    await request(port, "POST", `/s/${id}/send`, message("actually, one more"), page(port));
    const mixed = await request(port, "POST", "/api/poll", { file: FILE, cursor: poll.data.cursor });
    assert.deepEqual(mixed.data.items.map((i) => i.text), ["wrap up", "actually, one more"]);
    assert.equal(mixed.data.final, undefined);
  }));

test("a note survives the server being killed between send and poll", async () => {
  const port = await freePort();
  const state = tmp("austere-durable-crash-");
  let proc = startServer(port, state);
  try {
    await up(port);
    const id = (await request(port, "POST", "/api/open", { file: FILE })).data.session.id;
    assert.equal((await request(port, "POST", `/s/${id}/send`, message("do not lose me"), page(port))).status, 200);
    await kill(proc, "SIGKILL"); // no shutdown handler runs
    proc = startServer(port, state); // the dead server's lock is stale
    await up(port);
    const poll = await request(port, "POST", "/api/poll", { file: FILE });
    assert.equal(poll.data.status, "feedback");
    assert.equal(poll.data.items[0].text, "do not lose me");
  } finally {
    await kill(proc);
    fs.rmSync(state, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  }
});

test("feedback is unread until acknowledged: a poll without a cursor gets it again, a cursor or a reply acknowledges it", () =>
  withServer(async ({ port, state, id }) => {
    await request(port, "POST", `/s/${id}/send`, message("first"), page(port));
    let r = await cli(port, state, "poll", FILE);
    assert.match(r.out, /status: feedback/);
    const cursor = Number((/cursor: (\d+)/.exec(r.out) as RegExpExecArray)[1]);
    assert.match(r.out, new RegExp(`poll \\S+ --cursor ${cursor} --agent-reply`), "the next hint carries the cursor");

    // The agent lost that answer (crashed, or its tool call timed out): it comes back.
    r = await cli(port, state, "poll", FILE);
    assert.match(r.out, /message: first/);
    assert.match(r.out, new RegExp(`cursor: ${cursor}\\b`));

    // Acknowledged with the cursor: gone, and the page shows it seen.
    const ack = await request(port, "POST", "/api/poll", { file: FILE, cursor, timeoutMs: 200 });
    assert.equal(ack.data.status, "timeout");
    assert.equal((await request(port, "GET", "/api/sessions")).data.sessions.find((s) => s.id === id)?.pending, 0);

    // --after replays what was acknowledged.
    const replay = await request(port, "POST", "/api/poll", { file: FILE, after: cursor - 1 });
    assert.equal(replay.data.items[0].text, "first");

    // A reply without a cursor acknowledges what the last poll handed over.
    await request(port, "POST", `/s/${id}/send`, message("second"), page(port));
    const second = await request(port, "POST", "/api/poll", { file: FILE });
    assert.equal(second.data.items[0].text, "second");
    assert.equal((await request(port, "POST", "/api/reply", { file: FILE, text: "done" })).status, 200);
    assert.equal((await request(port, "POST", "/api/poll", { file: FILE, timeoutMs: 200 })).data.status, "timeout");

    assert.equal((await request(port, "POST", "/api/poll", { file: FILE, cursor: "x" })).status, 400);
  }));

test("a held note released after the cursor moved past its time still reaches the agent", () =>
  withServer(async ({ port, id }) => {
    const invited = await invite(port, id, "Ana");
    const held = await request(port, "POST", `/s/${id}/send`, message("held by the owner"), { ...page(port), cookie: invited });
    assert.equal(held.data.entry.held, true);

    // Later notes go through and are acknowledged.
    await request(port, "POST", `/s/${id}/send`, message("later, from the owner"), page(port));
    const got = await request(port, "POST", "/api/poll", { file: FILE });
    assert.deepEqual(got.data.items.map((i) => i.text), ["later, from the owner"]);
    await request(port, "POST", "/api/reply", { file: FILE, text: "ok", cursor: got.data.cursor });

    // Released now: it gets a new seq after the cursor.
    await request(port, "POST", `/s/${id}/release`, { ids: [held.data.entry.id] }, page(port));
    const released = await request(port, "POST", "/api/poll", { file: FILE });
    assert.equal(released.data.status, "feedback");
    assert.equal(released.data.items[0].text, "held by the owner");
    assert.equal(released.data.items[0].author, "Ana");
    assert.ok(released.data.cursor > got.data.cursor);
  }, { AUSTERE_AXI_LINK_HOST: "127.0.0.1" }));

test("a held note released after a final batch reaches the next poll", () =>
  withServer(async ({ port, id }) => {
    const invited = await invite(port, id, "Ana");

    const held = await request(port, "POST", `/s/${id}/send`, message("held before the end"), { ...page(port), cookie: invited });
    await request(port, "POST", `/s/${id}/send`, { ...message("final words"), end: true }, page(port));
    const final = await request(port, "POST", "/api/poll", { file: FILE });
    assert.equal(final.data.final, true);
    assert.deepEqual(final.data.items.map((i) => i.text), ["final words"]);

    await request(port, "POST", `/s/${id}/release`, { ids: [held.data.entry.id] }, page(port));
    const poll = await request(port, "POST", "/api/poll", { file: FILE, cursor: final.data.cursor });
    assert.equal(poll.data.status, "feedback");
    assert.deepEqual(poll.data.items.map((i) => i.text), ["held before the end"]);
    assert.equal(poll.data.final, undefined);
  }, { AUSTERE_AXI_LINK_HOST: "127.0.0.1" }));

test("feedback lists notes in delivery order, so a note released after Send & End is last and not final", () =>
  withServer(async ({ port, id }) => {
    const invited = await invite(port, id, "Ana");
    const held = await request(port, "POST", `/s/${id}/send`, message("held before the end"), { ...page(port), cookie: invited });
    await request(port, "POST", `/s/${id}/send`, { ...message("final words"), end: true }, page(port));
    await request(port, "POST", `/s/${id}/release`, { ids: [held.data.entry.id] }, page(port));

    const r = await request(port, "POST", "/api/feedback", { file: FILE, all: true, peek: true });
    assert.deepEqual(r.data.entries.map((e) => e.items[0].text), ["final words", "held before the end"]);
    assert.equal(r.data.entries[1].end, undefined, "the newest note was not sent with Send & End");
  }, { AUSTERE_AXI_LINK_HOST: "127.0.0.1" }));

test("open and archive meet on one page however the path is spelled", () =>
  withServer(async ({ port, id }) => {
    const link = path.join(tmp("austere-durable-link-"), "work");
    fs.symlinkSync(WORK, link, "junction");
    try {
      const viaLink = path.join(link, "plan.html");
      assert.equal((await request(port, "POST", "/api/open", { file: viaLink })).data.session.id, id, "open through a symlinked folder keys on the real path");
      assert.equal((await request(port, "POST", "/api/archive", { file: viaLink })).status, 200);
      const listed = (await request(port, "GET", "/api/sessions")).data.sessions.find((s) => s.id === id);
      assert.equal(listed?.archived, true);
    } finally {
      fs.rmSync(path.dirname(link), { recursive: true, force: true });
    }
  }));

test("archiving locks the composer for everyone and unarchive restores it; no other state refuses notes", () =>
  withServer(async ({ port, state, id }) => {
    const listed = async () => (await request(port, "GET", "/api/sessions")).data.sessions.find((s) => s.id === id);
    assert.equal((await listed())?.archived, false);

    // Archiving leaves a listening poll alone: it still waits for the next note.
    const listening = request(port, "POST", "/api/poll", { file: FILE, timeoutMs: 600 });
    await new Promise((r) => setTimeout(r, 100));
    const archived = await request(port, "POST", "/api/archive", { file: FILE });
    assert.equal(archived.status, 200);
    assert.equal((await listed())?.archived, true);
    assert.equal((await request(port, "POST", `/s/${id}/send`, message("while archived"), page(port))).status, 409);
    assert.equal((await listening).data.status, "timeout");

    // open leaves an archived page archived.
    assert.equal((await request(port, "POST", "/api/open", { file: FILE })).data.session.archived, true, "open does not unarchive");
    const opened = await cli(port, state, FILE, "--no-open");
    assert.match(opened.out, /^archived: /m, opened.out);
    assert.match(opened.out, /austere-axi unarchive \S+plan\.html/, "the hint asks to unarchive before polling");
    assert.doesNotMatch(opened.out, /leave it running/);
    assert.equal((await request(port, "POST", `/s/${id}/unarchive`, {}, page(port))).status, 200);
    assert.equal((await listed())?.archived, false);
    assert.equal((await request(port, "POST", `/s/${id}/send`, message("after unarchive"), page(port))).status, 200);

    // From the owner's menu.
    assert.equal((await request(port, "POST", `/s/${id}/archive`, {}, page(port))).status, 200);
    assert.equal((await request(port, "POST", `/s/${id}/send`, message("archived again"), page(port))).status, 409);
    const cliOut = await cli(port, state, "unarchive", FILE);
    assert.match(cliOut.out, /status: unarchived/);
    assert.equal((await listed())?.archived, false, "the CLI went through the running server");
  }));

test("a page archived while no server runs is still archived when the next server starts", async () => {
  const port = await freePort();
  const state = tmp("austere-durable-archive-");
  let proc: ServerProc | undefined;
  try {
    assert.match((await cli(port, state, "check", FILE)).out, /status: ok/);
    const archived = await cli(port, state, "archive", FILE);
    assert.match(archived.out, /status: archived/);
    proc = startServer(port, state);
    await up(port);
    const open = await request(port, "POST", "/api/open", { file: FILE });
    assert.equal(open.data.session.archived, true);
    assert.equal((await request(port, "POST", `/s/${open.data.session.id}/send`, message("locked"), page(port))).status, 409);
    assert.match((await cli(port, state, "unarchive", FILE)).out, /status: unarchived/);
    assert.equal((await request(port, "POST", `/s/${open.data.session.id}/send`, message("open again"), page(port))).status, 200);
  } finally {
    if (proc) await kill(proc);
    fs.rmSync(state, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  }
});

test("a newer poll replaces the older one; the older returns replaced", () =>
  withServer(async ({ port, id }) => {
    const older = request(port, "POST", "/api/poll", { file: FILE });
    await new Promise((r) => setTimeout(r, 100));
    const newer = request(port, "POST", "/api/poll", { file: FILE });
    assert.equal((await older).data.status, "replaced");
    await request(port, "POST", `/s/${id}/send`, message("for the newer"), page(port));
    const got = await newer;
    assert.equal(got.data.status, "feedback");
    assert.equal(got.data.items[0].text, "for the newer");
  }));

test("closing every tab does not end a poll: it waits for a note", () =>
  withServer(
    async ({ port, id }) => {
      const listening = request(port, "POST", "/api/poll", { file: FILE });
      let settled = false;
      void listening.then(() => (settled = true));
      const tab = http.get({ host: "127.0.0.1", port, path: `/s/${id}/events`, headers: { host: `127.0.0.1:${port}`, ...ownerHeaders(stateOf.get(port) as string) } });
      await new Promise<void>((resolve) => tab.once("response", (res) => res.once("data", () => resolve())));
      tab.destroy();
      await new Promise((r) => setTimeout(r, 700)); // well past the grace the old server allowed here
      assert.equal(settled, false, "the poll is still listening");
      await request(port, "POST", `/s/${id}/send`, message("hello after the tabs closed"), page(port));
      assert.deepEqual((await listening).data.items.map((i) => i.text), ["hello after the tabs closed"]);
    },
    { AUSTERE_AXI_DISCONNECT_GRACE_MS: "100" },
  ));

test("a second server on the same state dir refuses to start", () =>
  withServer(async ({ port, state }) => {
    const other = startServer(await freePort(), state);
    const code = await other.exited;
    assert.notEqual(code, 0);
    assert.match(other.out, new RegExp(`another austere-axi server \\(pid \\d+, port ${port}\\) is using`));
  }));

test("a lock left by a dead server does not block a start when its pid now belongs to another process", async () => {
  const port = await freePort();
  const state = tmp("austere-durable-lock-");
  // This test's own pid is alive but serves nothing on the port the lock names.
  fs.writeFileSync(path.join(state, "server.lock"), JSON.stringify({ pid: process.pid, port: await freePort(), at: Date.now() - 10 * 60_000 }));
  const proc = startServer(port, state);
  try {
    await up(port);
    const lock = JSON.parse(fs.readFileSync(path.join(state, "server.lock"), "utf8"));
    assert.deepEqual([lock.pid, lock.port], [(await request(port, "GET", "/api/health")).data.pid, port]);
  } finally {
    await kill(proc);
    fs.rmSync(state, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  }
});

test("a newer CLI that replaces an older server keeps --persist", async () => {
  const port = await freePort();
  const state = tmp("austere-durable-replace-");
  // An older server that runs with --persist and proves it holds the owner key; it exits when asked to.
  const old = http.createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    const url = new URL(req.url ?? "", "http://x");
    if (url.pathname === "/api/health") {
      const proof = crypto.createHmac("sha256", ownerKey(state)).update(`${port}:${url.searchParams.get("nonce")}`).digest("base64url");
      return res.end(JSON.stringify({ name: "austere-axi", version: "0.0.1", pid: 1, port, stateDir: state, proof, listen: ["127.0.0.1"], persist: true }));
    }
    if (url.pathname === "/api/shutdown") {
      res.on("finish", () => {
        old.close();
        old.closeAllConnections();
      });
    }
    res.end("{}");
  });
  await new Promise<void>((r) => old.listen(port, "127.0.0.1", r));
  stateOf.set(port, state);
  try {
    const r = await cli(port, state, FILE, "--no-open");
    assert.match(r.out, /status: open/);
    const h = (await request(port, "GET", "/api/health")).data;
    assert.notEqual(h.version, "0.0.1", "replaced");
    assert.equal(h.persist, true);
  } finally {
    old.close();
    await cli(port, state, "stop");
    // The stopped server may still hold hub.db for a moment; Windows refuses to remove it until it exits.
    fs.rmSync(state, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  }
});

test("session files from before the database are imported once, every state intact", async () => {
  const dir = tmp("austere-import-");
  const file = path.join(dir, "plan.html");
  const id = sessionId(file);
  const items = (text: string) => [{ kind: "message", text, id: `${text}-item` }];
  const legacy = {
    id,
    file,
    title: "Plan",
    createdAt: 1,
    updatedAt: 9,
    status: "ended",
    endedBy: "agent",
    endedAt: 8,
    pending: ["u-pending"],
    transcript: [
      { id: "u-done", role: "user", at: 2, items: items("addressed"), seenAt: 3, doneAt: 4 },
      { id: "a-1", role: "agent", at: 4, text: "did it" },
      { id: "u-seen", role: "user", at: 5, items: items("received"), seenAt: 6, doneAt: null },
      { id: "u-pending", role: "user", at: 6, items: items("open"), seenAt: null, doneAt: null },
      { id: "u-held", role: "user", at: 7, items: items("held"), author: "Ana", held: true },
      { id: "u-gone", role: "user", at: 7, items: items("discarded"), author: "Ana", held: false, discarded: true },
    ],
  };
  const sessions = path.join(dir, "sessions");
  fs.mkdirSync(sessions);
  fs.writeFileSync(path.join(sessions, `${id}.json`), JSON.stringify(legacy));
  try {
    const check = (store: SessionStore) => {
      const s = store.get(id) as Session;
      assert.equal(s.archivedAt, null);
      assert.deepEqual(store.heldEntries(s).map((e) => e.id), ["u-held"]);
      assert.deepEqual(
        store.feedback(s, { all: true, peek: true }).entries.map((e) => [e.id, e.status]),
        [["u-done", "addressed"], ["u-seen", "received"], ["u-pending", "open"]],
      );
      assert.deepEqual(s.transcript.map((e) => e.id), ["u-done", "a-1", "u-seen", "u-pending", "u-held", "u-gone"]);
      const hub = new Hub(store.db);
      assert.deepEqual(
        Object.fromEntries(hub.db.prepare("SELECT entry_id, status FROM items").all().map((r) => [r.entry_id, r.status])),
        { "u-done": "addressed", "u-seen": "received", "u-pending": "open", "u-held": "held", "u-gone": "discarded" },
      );
    };
    let store = await SessionStore.open(dir);
    check(store);
    // A server's other changes to the row leave the notes alone.
    store.touch(store.get(id) as Session);
    store.close();
    assert.deepEqual(fs.readdirSync(sessions), [`${id}.json.imported`]);

    // A rename that did not happen: importing again changes nothing, not even the status.
    fs.writeFileSync(path.join(sessions, `${id}.json`), JSON.stringify(legacy));
    store = await SessionStore.open(dir);
    check(store);
    store.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  }
});
