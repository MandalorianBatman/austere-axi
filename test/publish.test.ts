// `publish` against a stub of austere-cloud: the owner HTTP routes (owners, pages, objects) and
// the owner socket, which checks every frame with the shared schema module. Covers create,
// republish to the same link, --new, list, rm, the bundling rules and the state file; plus the
// guard that no other command contacts the service.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { DatabaseSync } from "node:sqlite";
import { after, before, beforeEach, test } from "node:test";
import type { AddressInfo } from "node:net";
import type { Duplex } from "node:stream";
import { WebSocketServer } from "ws";
import type { WebSocket } from "ws";
import { freePort } from "./port.ts";
import { ownerHeaders } from "./owner.ts";
import { SUBPROTOCOL, SYNC_VERSION, grantId, parseClientFrame, readProtocols } from "../src/shared/sync.ts";
import type { AclRow, MutationArgs, PageRow, ServerFrame, SyncError } from "../src/shared/sync.ts";
import { format } from "../src/cli/output.ts";

const tmp = (p: string) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const STATE = tmp("austere-publish-state-");
const WORK = tmp("austere-publish-work-");
process.env.AUSTERE_AXI_STATE_DIR = STATE;
const { bundlePage } = await import("../src/cli/cloud.ts");
const { VERSION } = await import("../src/cli/paths.ts");

const BASE_ENV = { ...process.env, AUSTERE_AXI_NO_TAILSCALE: "1", AUSTERE_AXI_NO_OPEN: "1", OPENUI_TELEMETRY_DISABLED: "1" };
const RUNTIME_TAG = '<script src="https://cdn.jsdelivr.net/npm/austere-axi@0/dist/austere.js"></script>';
const page = (program: string, head = "") =>
  `<!doctype html><html><head><meta charset="utf-8"><title>Plan</title>\n${head}${RUNTIME_TAG}</head>\n<body><script type="text/openui">\n${program}\n</script></body></html>\n`;
const sha256 = (data: string | Buffer) => crypto.createHash("sha256").update(data).digest("hex");

// ── stub service ──

interface StubPage {
  owner: string;
  row: PageRow | null;
  notes: number;
  /** Invites by name: the acl row and the token hash the grant sent. */
  acl: Map<string, { row: AclRow; tokenHash: string }>;
}

const stub = {
  /** "METHOD /path" for HTTP, "ws <frame or mutation name>" for socket frames. */
  requests: [] as string[],
  owners: new Set<string>(),
  objects: new Map<string, { type: string; data: Buffer }>(),
  pages: new Map<string, StubPage>(),
  publishes: [] as MutationArgs["publish"][],
  /** The next HTTP request gets this answer. */
  fail: null as { status: number; error: string } | null,
  /** The next mutation (named `ackErrorOn`, or any) is acked with this error. */
  ackError: null as SyncError | null,
  ackErrorOn: null as string | null,
  /** The next handshake is refused like this. */
  refuse: null as { status: number; code: string; message: string } | null,
  /** Close the socket right after the next ack, before the page row is pulled. */
  closeAfterAck: false,
  /** Close the socket when the next pull arrives: every mutation is acked, no rows come back. */
  closeBeforePull: false,
  /** On the next pull, send the page row with more:true, then close before the rest. */
  splitPull: false,
  /** On the next pull, first re-grant this name with another token, as another machine would. */
  regrantBeforePull: null as string | null,
  seq: 0,
  /** Everything that reached the service: each HTTP request (headers and body, unzipped) and each socket handshake and frame, as text. */
  wire: [] as string[],
};
let CLOUD = "";
let server: http.Server;
const wss = new WebSocketServer({ noServer: true, handleProtocols: (protocols) => (protocols.has(SUBPROTOCOL) ? SUBPROTOCOL : false) });

const json = (res: http.ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
};

function refuse(socket: Duplex, status: number, code: string, message: string) {
  const body = JSON.stringify({ error: { code, message } });
  socket.end(`HTTP/1.1 ${status} ${http.STATUS_CODES[status]}\r\ncontent-type: application/json\r\ncontent-length: ${Buffer.byteLength(body)}\r\nconnection: close\r\n\r\n${body}`);
}

function send(ws: WebSocket, frame: ServerFrame | Record<string, unknown>) {
  ws.send(JSON.stringify(frame));
}

/** The owner socket: mutations checked by the shared parser, publish and delete applied, pull answered. */
function ownerSocket(ws: WebSocket, id: string) {
  ws.on("message", (data) => {
    stub.wire.push(data.toString());
    const parsed = parseClientFrame(data.toString());
    if (!parsed.ok) {
      stub.requests.push(`ws invalid: ${parsed.error.message}`);
      if (parsed.key) return send(ws, { v: SYNC_VERSION, t: "ack", ...parsed.key, error: parsed.error });
      return send(ws, { v: SYNC_VERSION, t: "error", ...parsed.error });
    }
    const f = parsed.value;
    const p = stub.pages.get(id) as StubPage;
    if (f.t === "pull") {
      stub.requests.push(`ws pull ${f.after}`);
      if (stub.closeBeforePull) {
        stub.closeBeforePull = false;
        return ws.close(1001);
      }
      if (stub.regrantBeforePull) {
        const a = p.acl.get(stub.regrantBeforePull)!;
        const tokenHash = crypto.createHash("sha256").update("another machine").digest("base64url");
        a.row = { ...a.row, grantedAt: Date.now() + 1, grant: grantId(tokenHash), seq: ++stub.seq };
        a.tokenHash = tokenHash;
        stub.regrantBeforePull = null;
      }
      if (stub.splitPull) {
        stub.splitPull = false;
        send(ws, { v: SYNC_VERSION, t: "changes", rows: [p.row], cursor: p.row!.seq, more: true });
        return ws.close(1001);
      }
      // A row type this CLI does not know is skipped, as the contract requires.
      const rows: unknown[] = [{ v: SYNC_VERSION + 1, type: "future", id: "x", seq: ++stub.seq }];
      if (p.row) rows.push(p.row);
      for (const a of p.acl.values()) rows.push(a.row);
      return send(ws, { v: SYNC_VERSION, t: "changes", rows, cursor: stub.seq });
    }
    if (f.t !== "mutation") return;
    stub.requests.push(`ws ${f.name}`);
    const ack = { v: SYNC_VERSION, t: "ack" as const, clientId: f.clientId, n: f.n };
    if (stub.ackError && (stub.ackErrorOn === null || stub.ackErrorOn === f.name)) {
      const error = stub.ackError;
      stub.ackError = null;
      stub.ackErrorOn = null;
      return send(ws, { ...ack, error });
    }
    if (f.name === "grant") {
      const args = f.args as MutationArgs["grant"];
      // As the service: grantedAt stays while the token stays the same.
      const prev = p.acl.get(args.name);
      const grantedAt = prev && prev.tokenHash === args.tokenHash ? prev.row.grantedAt : Date.now();
      const row: AclRow = {
        v: SYNC_VERSION,
        type: "acl",
        id: args.name,
        seq: ++stub.seq,
        name: args.name,
        grantedAt,
        expiresAt: args.expiresAt,
        revoked: false,
        grant: grantId(args.tokenHash),
      };
      p.acl.set(args.name, { row, tokenHash: args.tokenHash });
      return send(ws, ack);
    }
    if (f.name === "revoke") {
      const a = p.acl.get((f.args as MutationArgs["revoke"]).name);
      if (!a) return send(ws, { ...ack, error: { code: "invalid", message: `invite ${(f.args as MutationArgs["revoke"]).name} does not exist` } });
      a.row = { ...a.row, revoked: true, seq: ++stub.seq };
      return send(ws, ack);
    }
    if (f.name === "publish") {
      const args = f.args as MutationArgs["publish"];
      for (const sha of [args.html, ...args.packs.map((x) => x.sha256)]) {
        if (!stub.objects.has(sha)) return send(ws, { ...ack, error: { code: "invalid", message: `object ${sha} was not uploaded` } });
      }
      stub.publishes.push(args);
      const now = Date.now();
      p.row = { v: SYNC_VERSION, type: "page", id, seq: ++stub.seq, ...args, publishedAt: now, expiresAt: now + 30 * 86400000, deleted: false };
      send(ws, ack);
      if (stub.closeAfterAck) ws.close(1001);
      stub.closeAfterAck = false;
      return;
    }
    if (f.name === "delete") {
      stub.pages.delete(id);
      send(ws, ack);
      return ws.close(1000);
    }
  });
}

before(async () => {
  server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const url = req.url ?? "";
      const raw = Buffer.concat(chunks);
      stub.wire.push(`${req.method} ${url} ${JSON.stringify(req.headers)} ${(req.headers["content-encoding"] === "gzip" ? zlib.gunzipSync(raw) : raw).toString("utf8")}`);
      stub.requests.push(`${req.method} ${url}`);
      if (stub.fail) {
        const { status, error } = stub.fail;
        stub.fail = null;
        return json(res, status, { error });
      }
      if (req.method === "POST" && url === "/api/owners") {
        const token = crypto.randomBytes(32).toString("base64url");
        stub.owners.add(token);
        return json(res, 201, { token });
      }
      const auth = /^Bearer (\S+)$/.exec(req.headers.authorization || "")?.[1] ?? "";
      if (!stub.owners.has(auth)) return json(res, 401, { error: "invalid token" });
      const obj = /^\/api\/objects\/([0-9a-f]{64})$/.exec(url);
      if (req.method === "PUT" && obj) {
        let data = Buffer.concat(chunks);
        if (req.headers["content-encoding"] === "gzip") data = zlib.gunzipSync(data);
        if (sha256(data) !== obj[1]) return json(res, 400, { error: "sha256 does not match" });
        stub.objects.set(obj[1], { type: String(req.headers["content-type"]), data });
        res.writeHead(204);
        return res.end();
      }
      if (req.method === "POST" && url === "/api/pages") {
        const id = crypto.randomBytes(16).toString("base64url");
        stub.pages.set(id, { owner: auth, row: null, notes: 0, acl: new Map() });
        return json(res, 201, { id, url: `${CLOUD}/p/${id}` });
      }
      if (req.method === "GET" && url === "/api/pages") {
        const pages = [...stub.pages]
          .filter(([, p]) => p.owner === auth && p.row)
          .map(([id, p]) => ({ id, title: p.row?.title, url: `${CLOUD}/p/${id}`, expiresAt: p.row?.expiresAt, notes: p.notes }));
        return json(res, 200, { pages });
      }
      const login = /^\/api\/pages\/([^/]+)\/login$/.exec(url);
      if (req.method === "POST" && login) {
        const p = stub.pages.get(login[1]);
        if (!p || p.owner !== auth || !p.row) return json(res, 404, { error: "page not found" });
        return json(res, 200, { code: "c0de_".padEnd(43, "x"), ttlMs: 60_000 });
      }
      json(res, 404, { error: "not found" });
    });
  });
  server.on("upgrade", (req, socket, head) => {
    const u = new URL(req.url ?? "", "http://stub");
    const m = /^\/api\/pages\/([^/]+)\/sync$/.exec(u.pathname);
    const creds = readProtocols(req.headers["sec-websocket-protocol"]);
    stub.requests.push(`WS ${u.pathname}`);
    stub.wire.push(`WS ${req.url} ${JSON.stringify(req.headers)}`);
    if (stub.refuse) {
      const r = stub.refuse;
      stub.refuse = null;
      return refuse(socket, r.status, r.code, r.message);
    }
    if (!m || !creds.sync || u.searchParams.get("cli") !== VERSION) return refuse(socket, 426, "upgrade_required", "offer austere-sync.1 and ?cli=");
    const p = stub.pages.get(m[1]);
    if (!creds.owner || !stub.owners.has(creds.owner)) return refuse(socket, 403, "forbidden", "owner token required");
    if (!p || p.owner !== creds.owner) return refuse(socket, 404, "invalid", "page not found");
    wss.handleUpgrade(req, socket, head, (ws) => ownerSocket(ws, m[1]));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const address: AddressInfo = server.address() as AddressInfo; // listening on TCP, not a pipe
  CLOUD = `http://127.0.0.1:${address.port}`;
});

after(() => {
  wss.close();
  server.close();
  fs.rmSync(STATE, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  fs.rmSync(WORK, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
});

beforeEach(() => {
  stub.requests.length = 0;
  stub.publishes.length = 0;
  stub.wire.length = 0;
  stub.fail = null;
  stub.ackError = null;
  stub.ackErrorOn = null;
  stub.refuse = null;
  stub.closeBeforePull = false;
  stub.splitPull = false;
  stub.regrantBeforePull = null;
});

function cli(args: string[], env: Record<string, string> = {}): Promise<{ code: number | null; out: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["src/cli/main.ts", ...args], {
      env: { ...BASE_ENV, AUSTERE_AXI_STATE_DIR: STATE, AUSTERE_AXI_CLOUD_URL: CLOUD, ...env },
    });
    let out = "";
    child.stdout.on("data", (c: Buffer) => (out += c));
    child.stderr.on("data", (c: Buffer) => (out += c));
    child.on("close", (code) => resolve({ code, out }));
  });
}

interface CloudJson {
  url: string;
  token: string;
  pages: Record<string, { id: string; auto: boolean; unlisted: boolean; presence: boolean; invites: Record<string, { token: string; expiresAt: number | null }> }>;
}
const cloudState = (): CloudJson => JSON.parse(fs.readFileSync(path.join(STATE, "cloud.json"), "utf8"));
/** A top-level output field, unquoted: a Windows path has backslashes, so the output JSON-quotes it. */
const field = (out: string, name: string) => {
  const v = new RegExp(`^${name}: (.*)$`, "m").exec(out)?.[1];
  return v?.startsWith('"') ? (JSON.parse(v) as string) : v;
};

// ── the command ──

test("publish uploads objects and sends the publish mutation; republish keeps the link; --new makes another; list and rm", async () => {
  const file = path.join(WORK, "plan.html");
  fs.writeFileSync(file, page('root = Stack([intro])\nintro = TextContent("hello")'));
  const abs = fs.realpathSync(file);

  let r = await cli(["publish", file]);
  assert.equal(r.code, 0, r.out);
  assert.equal(field(r.out, "status"), "published");
  assert.equal(field(r.out, "mode"), "hold");
  assert.match(field(r.out, "expires") ?? "", /^\d{4}-\d\d-\d\d \d\d:\d\d$/, "expiry comes from the page row");
  const html = fs.readFileSync(file, "utf8").replace(RUNTIME_TAG, `<script src="/rt/${VERSION}/austere.js"></script>`);
  const first = cloudState();
  const id = first.pages[abs].id;
  assert.deepEqual(stub.requests, [
    "POST /api/owners",
    `PUT /api/objects/${sha256(html)}`,
    "POST /api/pages",
    `WS /api/pages/${id}/sync`,
    "ws publish",
    "ws pull 0",
  ]);
  assert.equal(stub.objects.get(sha256(html))?.data.toString(), html, "only the runtime tag changes");
  assert.match(stub.objects.get(sha256(html))?.type ?? "", /^text\/html/);
  assert.deepEqual(stub.publishes, [{ title: "Plan", cliVersion: VERSION, html: sha256(html), packs: [], auto: false, unlisted: false, presence: true }]);
  assert.equal(field(r.out, "id"), id);
  assert.equal(field(r.out, "url"), undefined, "an invite-only page has no link to hand out without an invite");
  assert.equal(field(r.out, "access"), "invite-only");
  assert.match(r.out, /Nobody can open this page yet: add --invite <name>, or --unlisted/);
  assert.equal(first.url, CLOUD);
  assert.ok(first.token.length >= 43);
  assert.deepEqual(first.pages[abs], { id, auto: false, unlisted: false, presence: true, invites: {} });
  if (process.platform !== "win32") assert.equal(fs.statSync(path.join(STATE, "cloud.json")).mode & 0o777, 0o600);

  // Republish: same id, no new page, the same token on the socket.
  stub.requests.length = 0;
  r = await cli(["publish", file, "--auto", "--no-presence"]);
  assert.equal(r.code, 0, r.out);
  assert.equal(field(r.out, "status"), "updated");
  assert.equal(field(r.out, "presence"), "off");
  assert.equal(field(r.out, "id"), id);
  assert.ok(!stub.requests.includes("POST /api/pages"));
  assert.ok(stub.requests.includes(`WS /api/pages/${id}/sync`));
  assert.equal(stub.publishes.at(-1)?.auto, true);
  assert.equal(stub.publishes.at(-1)?.presence, false);
  assert.match(field(r.out, "next") ?? "", /--auto --no-presence again/);
  assert.deepEqual(cloudState().pages[abs], { id, auto: true, unlisted: false, presence: false, invites: {} });

  // --new: a fresh page, and the file now maps to it.
  r = await cli(["publish", file, "--new"]);
  assert.equal(field(r.out, "status"), "published");
  const second = cloudState().pages[abs].id;
  assert.notEqual(second, id);
  assert.equal(field(r.out, "id"), second);

  // list: both pages, the current one mapped back to the file.
  r = await cli(["publish", "list"]);
  assert.equal(r.code, 0, r.out);
  assert.equal(r.out.match(/^ {2}- id: /gm)?.length, 2);
  assert.ok(r.out.includes(format({ file: abs })), r.out);

  // rm by id (the first page, no longer mapped), then by file: each a delete mutation.
  stub.requests.length = 0;
  r = await cli(["publish", "rm", id]);
  assert.equal(r.code, 0, r.out);
  assert.equal(field(r.out, "status"), "removed");
  assert.deepEqual(stub.requests, [`WS /api/pages/${id}/sync`, "ws delete"]);
  r = await cli(["publish", "rm", file]);
  assert.equal(r.code, 0, r.out);
  assert.equal(field(r.out, "file"), abs);
  assert.deepEqual(cloudState().pages, {});
  assert.equal(stub.pages.size, 0);
  assert.match((await cli(["publish", "list"])).out, /pages: none/);
});

test("a page gone from the service: republish points at --new; rm drops the local record", async () => {
  const file = path.join(WORK, "gone.html");
  fs.writeFileSync(file, page('root = TextContent("x")'));
  assert.equal((await cli(["publish", file])).code, 0);
  stub.pages.clear(); // expired
  let r = await cli(["publish", file]);
  assert.equal(r.code, 1);
  assert.match(r.out, /is gone from .*publish --new/);
  r = await cli(["publish", "rm", file]);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /already gone/);
  assert.equal(cloudState().pages[fs.realpathSync(file)], undefined);
});

test("service errors print the service's message: HTTP, handshake and mutation ack", async () => {
  const file = path.join(WORK, "err.html");
  fs.writeFileSync(file, page('root = TextContent("x")'));
  assert.equal((await cli(["publish", file])).code, 0);

  stub.fail = { status: 413, error: "object is 2000000 bytes; the limit is 1048576" };
  let r = await cli(["publish", file]);
  assert.equal(r.code, 1);
  assert.ok(r.out.includes("answered 413: object is 2000000 bytes; the limit is 1048576"), r.out);
  assert.match(r.out, /http: 413/);

  stub.refuse = { status: 426, code: "upgrade_required", message: "austere-axi 0.0.1 is below MIN_CLI_VERSION 9.9.9" };
  r = await cli(["publish", file]);
  assert.equal(r.code, 1);
  assert.ok(r.out.includes("answered 426: austere-axi 0.0.1 is below MIN_CLI_VERSION 9.9.9"), r.out);
  assert.match(r.out, /code: upgrade_required/);

  stub.ackError = { code: "rate_limited", message: "20 publishes a day", retryAfter: 3600 };
  r = await cli(["publish", file]);
  assert.equal(r.code, 1);
  assert.ok(r.out.includes("rejected publish: rate_limited: 20 publishes a day (retry after 3600s)"), r.out);
});

test("a socket lost after the publish ack still records the page, without an expiry", async () => {
  const file = path.join(WORK, "lost.html");
  fs.writeFileSync(file, page('root = TextContent("x")'));
  stub.closeAfterAck = true;
  let r = await cli(["publish", file]);
  assert.equal(r.code, 0, r.out);
  assert.equal(field(r.out, "status"), "published");
  assert.equal(field(r.out, "expires"), undefined);
  const id = cloudState().pages[fs.realpathSync(file)].id;
  r = await cli(["publish", file]);
  assert.equal(field(r.out, "status"), "updated", "the next publish reuses the page instead of making another");
  assert.equal(field(r.out, "id"), id);
});

test("a token for another service URL is not sent there", async () => {
  const state = tmp("austere-publish-other-");
  fs.writeFileSync(path.join(state, "cloud.json"), JSON.stringify({ url: "https://elsewhere.test", token: "t".repeat(43), pages: {} }));
  try {
    const r = await cli(["publish", "list"], { AUSTERE_AXI_STATE_DIR: state });
    assert.equal(r.code, 1);
    assert.match(r.out, /holds an owner token for https:\/\/elsewhere\.test/);
    assert.deepEqual(stub.requests, []);
  } finally {
    fs.rmSync(state, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  }
});

test("a page that cannot be bundled fails before any request", async () => {
  const file = path.join(WORK, "broken.html");
  fs.writeFileSync(file, page('root = Image("x", "nope.png")'));
  const r = await cli(["publish", file]);
  assert.equal(r.code, 1);
  assert.match(r.out, /images the hosted page could not show: nope\.png \(no such file next to the page\)/);
  assert.deepEqual(stub.requests, []);
});

test("session ids stay on this machine: nothing publish sends carries the agent session the hub registered (RLM-343)", async () => {
  const sid = "5e55d343-aaaa-4bbb-8ccc-0123456789ab";
  const env = { PI_SESSION_ID: sid, PI_SESSION_FILE: path.join(STATE, `${sid}.jsonl`) };
  const file = path.join(WORK, "session.html");
  fs.writeFileSync(file, page('root = Stack([intro])\nintro = TextContent("hello")'));
  const patched = await new Promise<string>((resolve) => {
    const child = spawn(process.execPath, ["src/cli/main.ts", "patch", file], { env: { ...BASE_ENV, AUSTERE_AXI_STATE_DIR: STATE, ...env } });
    let out = "";
    child.stdout.on("data", (c: Buffer) => (out += c));
    child.on("close", () => resolve(out));
    child.stdin.end('intro = TextContent("patched")\n');
  });
  assert.match(patched, /^session: omp 6789ab registered$/m);
  const db = new DatabaseSync(path.join(STATE, "hub.db"), { readOnly: true });
  try {
    assert.equal((db.prepare("SELECT count(*) AS n FROM agent_sessions WHERE session_id = ?").get(sid) as { n: number }).n, 1, "the session is registered here");
  } finally {
    db.close();
  }

  const r = await cli(["publish", file, "--invite", "Ana"], env);
  assert.equal(r.code, 0, r.out);
  assert.ok(stub.wire.some((w) => w.includes("patched")), "the page itself went out");
  for (const secret of [sid, "6789ab", env.PI_SESSION_FILE]) {
    assert.ok(!stub.wire.some((w) => w.includes(secret)), `${secret} reached the service`);
    assert.ok(!r.out.includes(secret), `${secret} is in the printed links`);
  }
});

// ── invites ──

const tokenHash = (token: string) => crypto.createHash("sha256").update(token).digest("base64url");
/** The `name: …` / `link: …` pairs of the printed invites list. */
const links = (out: string) =>
  Object.fromEntries(
    [...out.matchAll(/- name: (.+)\n((?: {4,}\S.*\n)*)/g)].flatMap((x) => {
      const link = / link: (\S+)/.exec(x[2]);
      // The printer quotes values it cannot leave bare (emoji, `: `); names come back as typed.
      return link ? [[x[1].startsWith('"') ? JSON.parse(x[1]) : x[1], link[1]]] : [];
    }),
  );

test("--invite grants each name on the publish socket and prints its own link; the same name keeps its link", async () => {
  const file = path.join(WORK, "invite.html");
  fs.writeFileSync(file, page('root = TextContent("x")'));
  const abs = fs.realpathSync(file);
  const before = Date.now();
  let r = await cli(["publish", file, "--invite", "Ana", "--invite", "Ben", "--expires", "7d"]);
  assert.equal(r.code, 0, r.out);
  const id = cloudState().pages[abs].id;
  assert.deepEqual(stub.requests.filter((x) => x.startsWith("ws")), ["ws publish", "ws grant", "ws grant", "ws pull 0"]);
  assert.equal(field(r.out, "access"), "invite-only");
  assert.doesNotMatch(r.out, /Nobody can open/);
  const first = links(r.out);
  assert.deepEqual(Object.keys(first), ["Ana", "Ben"]);
  const acl = stub.pages.get(id)!.acl;
  for (const name of ["Ana", "Ben"]) {
    const m = new RegExp(`^${CLOUD}/p/${id}#i=([A-Za-z0-9_-]{43})$`).exec(first[name]);
    assert.ok(m, first[name]);
    assert.equal(acl.get(name)!.tokenHash, tokenHash(m[1]), "only the token's SHA-256 is sent");
    const expires = acl.get(name)!.row.expiresAt!;
    assert.ok(expires >= before + 7 * 86400000 && expires <= Date.now() + 7 * 86400000);
  }
  assert.notEqual(first.Ana, first.Ben);
  assert.deepEqual(Object.keys(cloudState().pages[abs].invites), ["Ana", "Ben"]);

  // Again with Ana: the same link and expiry; Ben stays; no --invite sends no grant.
  stub.requests.length = 0;
  r = await cli(["publish", file, "--invite", " Ana "]);
  assert.equal(r.code, 0, r.out);
  assert.deepEqual(links(r.out), { Ana: first.Ana });
  assert.equal(acl.get("Ana")!.row.expiresAt, cloudState().pages[abs].invites.Ana.expiresAt);
  assert.ok(cloudState().pages[abs].invites.Ana.expiresAt! > Date.now());
  stub.requests.length = 0;
  r = await cli(["publish", file]);
  assert.deepEqual(stub.requests.filter((x) => x.startsWith("ws")), ["ws publish", "ws pull 0"]);
  assert.doesNotMatch(r.out, /Nobody can open/, "earlier invites still open it");

  // invites: both live, with this machine's links.
  r = await cli(["publish", "invites", file]);
  assert.equal(r.code, 0, r.out);
  assert.deepEqual(links(r.out), first);
  assert.equal(r.out.match(/status: live/g)?.length, 2);

  // revoke Ben: a revoke mutation; Ben is listed as revoked, without a link, and forgotten locally.
  stub.requests.length = 0;
  r = await cli(["publish", "revoke", file, "Ben"]);
  assert.equal(r.code, 0, r.out);
  assert.equal(field(r.out, "status"), "revoked");
  assert.deepEqual(stub.requests, [`WS /api/pages/${id}/sync`, "ws revoke"]);
  assert.equal(acl.get("Ben")!.row.revoked, true);
  assert.deepEqual(Object.keys(cloudState().pages[abs].invites), ["Ana"]);
  r = await cli(["publish", "invites", file]);
  assert.deepEqual(links(r.out), { Ana: first.Ana });
  assert.match(r.out, /- name: Ben\n\s+status: revoked\n/);

  r = await cli(["publish", "revoke", file, "Zoe"]);
  assert.equal(r.code, 1);
  assert.ok(r.out.includes("rejected revoke Zoe: invalid: invite Zoe does not exist"), r.out);
});

test("--unlisted publishes the open link and prints the page URL", async () => {
  const file = path.join(WORK, "open.html");
  fs.writeFileSync(file, page('root = TextContent("x")'));
  const r = await cli(["publish", file, "--unlisted"]);
  assert.equal(r.code, 0, r.out);
  const id = cloudState().pages[fs.realpathSync(file)].id;
  assert.equal(stub.publishes.at(-1)?.unlisted, true);
  assert.equal(field(r.out, "url"), `${CLOUD}/p/${id}`);
  assert.match(field(r.out, "access") ?? "", /^"?unlisted/);
  assert.match(field(r.out, "next") ?? "", /--unlisted again/);
});

test("publish login prints the page's single-use owner sign-in link; an unpublished file or extra argument is an error", async () => {
  const file = path.join(WORK, "mine.html");
  fs.writeFileSync(file, page('root = TextContent("x")'));
  let r = await cli(["publish", "login", file]);
  assert.equal(r.code, 1);
  assert.match(r.out, /has not been published from this machine/);
  assert.ok(!stub.requests.some((x) => x.includes("/login")), "nothing is asked before the page is published");

  assert.equal((await cli(["publish", file])).code, 0);
  const id = cloudState().pages[fs.realpathSync(file)].id;
  r = await cli(["publish", "login", file]);
  assert.equal(r.code, 0, r.out);
  assert.ok(stub.requests.includes(`POST /api/pages/${id}/login`), stub.requests.join("\n"));
  assert.equal(field(r.out, "url"), `${CLOUD}/p/${id}?login=${"c0de_".padEnd(43, "x")}`);
  assert.match(field(r.out, "expires") ?? "", /after one use, or in 60s/);

  r = await cli(["publish", "login", file, "extra"]);
  assert.equal(r.code, 2, r.out);
  assert.match(r.out, /login takes one file/);
});

test("invite flags are checked before any request; a failed grant still records the published page", async () => {
  const file = path.join(WORK, "flags.html");
  fs.writeFileSync(file, page('root = TextContent("x")'));
  for (const [args, msg] of [
    [["--expires", "7d"], /--expires applies to the invites of this publish/],
    [["--invite", "Ana", "--expires", "soon"], /use a duration like 30m, 12h, 7d or 2w/],
    [["--invite", "  "], /must be 1-40 characters/],
    [["--invite", "N".repeat(41)], /must be 1-40 characters/],
    // The schema counts UTF-16 units: 21 emoji are 42, which the service would refuse after the publish.
    [["--invite", "😀".repeat(21)], /must be 1-40 characters/],
  ] as const) {
    const r = await cli(["publish", file, ...args]);
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, msg);
  }
  assert.deepEqual(stub.requests, []);
  assert.match((await cli(["publish", "invites", file])).out, /has not been published from this machine/);

  stub.ackError = { code: "invalid", message: "grant.tokenHash belongs to another invite" };
  stub.ackErrorOn = "grant";
  let r = await cli(["publish", file, "--invite", "Ana"]);
  assert.equal(r.code, 1);
  assert.ok(r.out.includes("rejected grant Ana: invalid: grant.tokenHash belongs to another invite"), r.out);
  const id = cloudState().pages[fs.realpathSync(file)].id;
  r = await cli(["publish", file, "--invite", "Ana"]);
  assert.equal(r.code, 0, r.out);
  assert.equal(field(r.out, "status"), "updated");
  assert.equal(cloudState().pages[fs.realpathSync(file)].id, id);
});

test("invite edge cases: special names keep their link, missing sources can still revoke, re-grants elsewhere hide stale links, dead invites warn", async () => {
  const file = path.join(WORK, "edge.html");
  fs.writeFileSync(file, page('root = TextContent("x")'));
  const abs = fs.realpathSync(file);
  const emoji = "😀".repeat(20); // 40 UTF-16 units: the limit

  // "__proto__" and "constructor" are names like any other: saved, and re-sent with the same link.
  let r = await cli(["publish", file, "--invite", "__proto__", "--invite", "constructor", "--invite", emoji]);
  assert.equal(r.code, 0, r.out);
  const first = links(r.out);
  assert.deepEqual(Object.keys(first), ["__proto__", "constructor", emoji]);
  assert.deepEqual(Object.keys(cloudState().pages[abs].invites).sort(), ["__proto__", "constructor", emoji].sort());
  r = await cli(["publish", file, "--invite", "__proto__", "--invite", "constructor"]);
  assert.equal(r.code, 0, r.out);
  // Entries, not object literals: `{ __proto__: … }` would set a prototype instead of a key.
  assert.deepEqual(Object.entries(links(r.out)), [
    ["__proto__", first["__proto__"]],
    ["constructor", first["constructor"]],
  ]);
  const id = cloudState().pages[abs].id;
  const acl = stub.pages.get(id)!.acl;

  // Another machine re-grants "constructor" (a new token): this machine no longer shows its old link.
  const other = acl.get("constructor")!;
  acl.set("constructor", { row: { ...other.row, grantedAt: other.row.grantedAt + 1, grant: "x".repeat(16), seq: ++stub.seq }, tokenHash: "x".repeat(43) });
  r = await cli(["publish", "invites", file]);
  assert.equal(r.code, 0, r.out);
  assert.deepEqual(Object.entries(links(r.out)).sort(), [
    ["__proto__", first["__proto__"]],
    [emoji, first[emoji]],
  ]);
  assert.match(r.out, /- name: constructor\n\s+status: live\n/);

  // The source is gone: invites and revoke still work from the saved page entry.
  fs.renameSync(file, `${file}.moved`);
  try {
    r = await cli(["publish", "revoke", file, "constructor"]);
    assert.equal(r.code, 0, r.out);
    assert.equal(field(r.out, "status"), "revoked");
    r = await cli(["publish", "invites", file]);
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /- name: constructor\n\s+status: revoked\n/);
  } finally {
    fs.renameSync(`${file}.moved`, file);
  }

  // Every saved invite is revoked or expired: a publish without --invite warns that nobody can open the page.
  acl.get("__proto__")!.row.expiresAt = Date.now() - 1;
  acl.get(emoji)!.row.revoked = true;
  r = await cli(["publish", file]);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /Nobody can open this page yet/);
});

test("invites: the link shows only for the token the name has now, also when rows are lost or a re-grant races the pull", async () => {
  const file = path.join(WORK, "grant-id.html");
  fs.writeFileSync(file, page('root = TextContent("x")'));
  // An unlisted, auto page: the suggested commands must keep both, or they would close the open link.
  let r = await cli(["publish", file, "--invite", "Ana", "--unlisted", "--auto"]);
  assert.equal(r.code, 0, r.out);
  const ana = links(r.out).Ana;
  const id = cloudState().pages[fs.realpathSync(file)].id;
  const acl = stub.pages.get(id)!.acl;
  assert.equal(acl.get("Ana")!.row.grant, grantId(acl.get("Ana")!.tokenHash), "the row names its token by a hash prefix");

  // Ben new, but the socket drops before the rows come back: the link is still the live one.
  stub.closeBeforePull = true;
  r = await cli(["publish", file, "--invite", "Ben", "--unlisted", "--auto"]);
  assert.equal(r.code, 0, r.out);
  const ben = links(r.out).Ben;
  r = await cli(["publish", "invites", file]);
  assert.deepEqual(links(r.out), { Ana: ana, Ben: ben });

  // Another machine re-grants Ana between this run's ack and its pull: this machine's link is dead.
  stub.regrantBeforePull = "Ana";
  r = await cli(["publish", file, "--invite", "Ana", "--unlisted", "--auto"]);
  assert.equal(r.code, 0, r.out);
  r = await cli(["publish", "invites", file]);
  assert.deepEqual(links(r.out), { Ben: ben });
  // Output values are JSON-quoted when they hold quotes or backslashes (a Windows path does): decode before matching.
  const raw = /- name: Ana\n\s+status: live\n\s+note: (.*)\n/.exec(r.out)?.[1] ?? "";
  const note = raw.startsWith('"') ? (JSON.parse(raw) as string) : raw;
  const again = /^granted again from another machine, which has the link; austere-axi publish (.+) --auto --unlisted --invite Ana makes this machine's link the live one again/.exec(note);
  assert.ok(again, note);
  assert.match(again[1], /grant-id\.html"?$/);
  assert.match(field(r.out, "next") ?? "", /grant-id\.html"? --auto --unlisted --invite <name> adds one/);
});

test("a pull cut off after the page row leaves the invite count unknown: no false nobody-can-open warning", async () => {
  const file = path.join(WORK, "split-pull.html");
  fs.writeFileSync(file, page('root = TextContent("x")'));
  assert.equal((await cli(["publish", file, "--invite", "Ana"])).code, 0);
  // The page row arrives with more:true, then the socket drops before the invites.
  stub.splitPull = true;
  const r = await cli(["publish", file]);
  assert.equal(r.code, 0, r.out);
  assert.doesNotMatch(r.out, /Nobody can open/);
});

test("revoke and invites find a deleted file published through a symlinked folder", { skip: process.platform === "win32" && "symlinks need privileges" }, async () => {
  const real = fs.mkdtempSync(path.join(os.tmpdir(), "austere-publish-real-"));
  const link = path.join(WORK, `linked-${process.pid}`);
  fs.symlinkSync(real, link, "dir");
  try {
    const file = path.join(link, "plan.html");
    fs.writeFileSync(file, page('root = TextContent("x")'));
    assert.equal((await cli(["publish", file, "--invite", "Ana"])).code, 0);
    fs.rmSync(path.join(real, "plan.html"));
    let r = await cli(["publish", "invites", file]);
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /- name: Ana\n\s+status: live/);
    r = await cli(["publish", "revoke", file, "Ana"]);
    assert.equal(r.code, 0, r.out);
    assert.equal(field(r.out, "status"), "revoked");
  } finally {
    fs.rmSync(link, { force: true });
    fs.rmSync(real, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  }
});

// ── bundling ──

test("bundling: bundled packs get /rt/ tags after the runtime; relative images are inlined, unsafe ones are errors", () => {
  const png = Buffer.from("89504e470d0a1a0a", "hex");
  fs.mkdirSync(path.join(WORK, "img"), { recursive: true });
  fs.writeFileSync(path.join(WORK, "img", "shot.png"), png);
  const abs = path.join(WORK, "flow.html");
  const out = bundlePage(abs, page('root = Stack([i, p])\ni = Image("Shot", "img/shot.png")\np = Progress(40)'));
  const tags = [...out.html.matchAll(/<script src="([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(tags, [`/rt/${VERSION}/austere.js`, `/rt/${VERSION}/packs/shadcn.js`]);
  assert.ok(out.html.includes(`Image("Shot", "data:image/png;base64,${png.toString("base64")}")`));
  assert.equal(out.images, 1);
  assert.equal(out.sha256, sha256(out.html));
  assert.equal(out.title, "Plan");

  assert.throws(() => bundlePage(abs, page('root = Image("x", "../outside.png")')), /outside the page's folder/);
  assert.throws(() => bundlePage(abs, page('root = Image("x", "img/.hidden.png")')), /hidden files/);
  assert.throws(() => bundlePage(abs, page('root = Image("x", "img/none.png")')), /no such file/);

  // Path-like text that is not an Image src stays text.
  const text = 'root = Stack([t, c])\nt = FileTree(["img/shot.png", "src/missing.png"])\nc = CodeBlock("js", "Image(\\"x\\", \\"./logo.svg\\")")';
  assert.equal(bundlePage(abs, page(text)).images, 0);

  // A symlink beside the page that leads out of its folder is refused, as the local server refuses to serve it.
  if (process.platform !== "win32") {
    const secret = path.join(WORK, "..", `austere-publish-secret-${process.pid}.txt`);
    fs.writeFileSync(secret, "SECRET");
    fs.symlinkSync(secret, path.join(WORK, "img", "leak.png"));
    try {
      assert.throws(() => bundlePage(abs, page('root = Image("x", "img/leak.png")')), /outside the page's folder/);
    } finally {
      fs.rmSync(secret, { force: true });
    }
  }
});

test("bundling: installed packs are objects named by SHA-256 and tagged /pk/; missing, mismatched or stale packs are errors", () => {
  const code = "/* pack */ AustereAxi.registerPack({});\n";
  const dir = path.join(STATE, "packs", "@acme+charts@1.2.0");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "pack.js"), code);
  fs.writeFileSync(path.join(dir, "catalog.json"), JSON.stringify({ format: 1, pack: "@acme/charts", version: "1.2.0", groups: [], components: [] }));
  fs.writeFileSync(path.join(STATE, "packs.json"), JSON.stringify({ format: 1, packs: { "@acme/charts": { version: "1.2.0", integrity: "sha384-x", source: "folder" } } }));
  try {
    const meta = (spec: string) => `<meta name="austere-packs" content="${spec}">\n`;
    const out = bundlePage(path.join(WORK, "c.html"), page('root = TextContent("x")', meta("@acme/charts@1.2.0 sha384-x")));
    assert.deepEqual(out.packs, [{ sha256: sha256(code), name: "@acme/charts", version: "1.2.0", code }]);
    assert.ok(out.html.includes(`<script src="/rt/${VERSION}/austere.js"></script>\n<script src="/pk/${sha256(code)}.js"></script>`));
    assert.ok(out.html.includes(meta("@acme/charts@1.2.0 sha384-x").trim()), "the page's declaration stays");

    const x = 'root = TextContent("x")';
    assert.throws(() => bundlePage("/x.html", page(x, meta("@acme/other@1.0.0"))), /@acme\/other@1\.0\.0 is not installed/);
    assert.throws(() => bundlePage("/x.html", page(x, meta("@acme/charts@2.0.0"))), /1\.2\.0 is installed/);
    assert.throws(() => bundlePage("/x.html", page(x, meta("@acme/charts@1.2.0 sha384-other"))), /does not match the page's hash/);
  } finally {
    fs.rmSync(path.join(STATE, "packs"), { recursive: true, force: true });
    fs.rmSync(path.join(STATE, "packs.json"), { force: true });
  }
});

// ── nothing else talks to the service ──

test("poll and feedback make no request to the service when nothing is published", async () => {
  const state = tmp("austere-publish-quiet-");
  const port = await freePort();
  const file = path.join(WORK, "quiet.html");
  fs.writeFileSync(file, page('root = TextContent("x")'));
  const env = { ...BASE_ENV, AUSTERE_AXI_STATE_DIR: state, AUSTERE_AXI_PORT: String(port), AUSTERE_AXI_CLOUD_URL: CLOUD };
  const run = (...args: string[]) =>
    new Promise<{ code: number | null; out: string }>((resolve) => {
      const child = spawn(process.execPath, ["src/cli/main.ts", ...args], { env });
      let out = "";
      child.stdout.on("data", (c: Buffer) => (out += c));
      child.on("close", (code) => resolve({ code, out }));
    });
  try {
    let r = await run(file, "--no-open");
    assert.equal(r.code, 0, r.out);
    const id = (/\/s\/([\w-]+)/.exec(r.out) as RegExpExecArray)[1];
    const sent = await fetch(`http://127.0.0.1:${port}/s/${id}/send`, {
      method: "POST",
      headers: { ...ownerHeaders(state), host: `127.0.0.1:${port}`, origin: `http://127.0.0.1:${port}`, "content-type": "application/json" },
      body: JSON.stringify({ items: [{ kind: "message", text: "hi" }] }),
    });
    assert.equal(sent.status, 200);
    r = await run("poll", file);
    assert.match(r.out, /message: hi/);
    r = await run("feedback", file, "--all");
    assert.equal(r.code, 0, r.out);
    assert.equal(fs.existsSync(path.join(state, "cloud.json")), false);
    assert.deepEqual(stub.requests, []);
  } finally {
    await run("stop");
    fs.rmSync(state, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  }
});
