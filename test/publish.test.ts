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
import { after, before, beforeEach, test } from "node:test";
import type { AddressInfo } from "node:net";
import type { Duplex } from "node:stream";
import { WebSocketServer } from "ws";
import type { WebSocket } from "ws";
import { freePort } from "./port.ts";
import { ownerHeaders } from "./owner.ts";
import { SUBPROTOCOL, SYNC_VERSION, parseClientFrame, readProtocols } from "../src/shared/sync.ts";
import type { MutationArgs, PageRow, ServerFrame, SyncError } from "../src/shared/sync.ts";
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
  /** The next mutation is acked with this error. */
  ackError: null as SyncError | null,
  /** The next handshake is refused like this. */
  refuse: null as { status: number; code: string; message: string } | null,
  /** Close the socket right after the next ack, before the page row is pulled. */
  closeAfterAck: false,
  seq: 0,
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
      // A row type this CLI does not know is skipped, as the contract requires.
      const rows: unknown[] = [{ v: SYNC_VERSION + 1, type: "future", id: "x", seq: ++stub.seq }];
      if (p.row) rows.push(p.row);
      return send(ws, { v: SYNC_VERSION, t: "changes", rows, cursor: stub.seq });
    }
    if (f.t !== "mutation") return;
    stub.requests.push(`ws ${f.name}`);
    const ack = { v: SYNC_VERSION, t: "ack" as const, clientId: f.clientId, n: f.n };
    if (stub.ackError) {
      const error = stub.ackError;
      stub.ackError = null;
      return send(ws, { ...ack, error });
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
        stub.pages.set(id, { owner: auth, row: null, notes: 0 });
        return json(res, 201, { id, url: `${CLOUD}/p/${id}` });
      }
      if (req.method === "GET" && url === "/api/pages") {
        const pages = [...stub.pages]
          .filter(([, p]) => p.owner === auth && p.row)
          .map(([id, p]) => ({ id, title: p.row?.title, url: `${CLOUD}/p/${id}`, expiresAt: p.row?.expiresAt, notes: p.notes }));
        return json(res, 200, { pages });
      }
      json(res, 404, { error: "not found" });
    });
  });
  server.on("upgrade", (req, socket, head) => {
    const u = new URL(req.url ?? "", "http://stub");
    const m = /^\/api\/pages\/([^/]+)\/sync$/.exec(u.pathname);
    const creds = readProtocols(req.headers["sec-websocket-protocol"]);
    stub.requests.push(`WS ${u.pathname}`);
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
  stub.fail = null;
  stub.ackError = null;
  stub.refuse = null;
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
  pages: Record<string, { id: string; auto: boolean }>;
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
  assert.equal(field(r.out, "url"), `${CLOUD}/p/${id}`);
  assert.equal(first.url, CLOUD);
  assert.ok(first.token.length >= 43);
  assert.deepEqual(first.pages[abs], { id, auto: false });
  if (process.platform !== "win32") assert.equal(fs.statSync(path.join(STATE, "cloud.json")).mode & 0o777, 0o600);

  // Republish: same id, no new page, the same token on the socket.
  stub.requests.length = 0;
  r = await cli(["publish", file, "--auto"]);
  assert.equal(r.code, 0, r.out);
  assert.equal(field(r.out, "status"), "updated");
  assert.equal(field(r.out, "url"), `${CLOUD}/p/${id}`);
  assert.ok(!stub.requests.includes("POST /api/pages"));
  assert.ok(stub.requests.includes(`WS /api/pages/${id}/sync`));
  assert.equal(stub.publishes.at(-1)?.auto, true);
  assert.match(field(r.out, "next") ?? "", /--auto again/);
  assert.deepEqual(cloudState().pages[abs], { id, auto: true });

  // --new: a fresh page, and the file now maps to it.
  r = await cli(["publish", file, "--new"]);
  assert.equal(field(r.out, "status"), "published");
  const second = cloudState().pages[abs].id;
  assert.notEqual(second, id);
  assert.equal(field(r.out, "url"), `${CLOUD}/p/${second}`);

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
  assert.equal(field(r.out, "url"), `${CLOUD}/p/${id}`);
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
