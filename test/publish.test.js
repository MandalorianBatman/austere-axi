// `publish` against a stub of the austere-cloud owner API: create, republish to
// the same link, --new, list, rm, the bundling rules, and the state file. Plus
// the guard that no other command contacts the service.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { after, before, beforeEach, test } from "node:test";
import { freePort } from "./port.js";
import { ownerHeaders } from "./owner.js";

const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const STATE = tmp("austere-publish-state-");
const WORK = tmp("austere-publish-work-");
process.env.AUSTERE_AXI_STATE_DIR = STATE;
const { bundlePage } = await import("../src/cli/cloud.js");
const { VERSION } = await import("../src/cli/paths.js");

const BASE_ENV = { ...process.env, AUSTERE_AXI_NO_TAILSCALE: "1", AUSTERE_AXI_NO_OPEN: "1", OPENUI_TELEMETRY_DISABLED: "1" };
const RUNTIME_TAG = '<script src="https://cdn.jsdelivr.net/npm/austere-axi@0/dist/austere.js"></script>';
const page = (program, head = "") =>
  `<!doctype html><html><head><meta charset="utf-8"><title>Plan</title>\n${head}${RUNTIME_TAG}</head>\n<body><script type="text/openui">\n${program}\n</script></body></html>\n`;

// ── stub service: the owner routes of austere-cloud (src/api.ts), in memory ──

const stub = { requests: [], owners: new Set(), pages: new Map(), fail: null };
let CLOUD = "";
let server;

const json = (res, status, body) => {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
};

before(async () => {
  server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      let raw = Buffer.concat(chunks);
      if (req.headers["content-encoding"] === "gzip") raw = zlib.gunzipSync(raw);
      const body = raw.length ? JSON.parse(raw.toString("utf8")) : undefined;
      const auth = /^Bearer (\S+)$/.exec(req.headers.authorization || "")?.[1];
      stub.requests.push({ method: req.method, url: req.url, body, auth, encoding: req.headers["content-encoding"] });
      if (stub.fail) return json(res, stub.fail.status, { error: stub.fail.error });
      if (req.method === "POST" && req.url === "/api/owners") {
        const token = crypto.randomBytes(32).toString("base64url");
        stub.owners.add(token);
        return json(res, 201, { token });
      }
      if (!stub.owners.has(auth)) return json(res, 401, { error: "invalid token" });
      const expiresAt = Date.UTC(2030, 0, 1);
      const view = (id) => ({ id, url: `${CLOUD}/p/${id}`, expiresAt });
      if (req.method === "POST" && req.url === "/api/pages") {
        const id = crypto.randomBytes(16).toString("base64url");
        stub.pages.set(id, { owner: auth, body, notes: 0 });
        return json(res, 201, view(id));
      }
      if (req.method === "GET" && req.url === "/api/pages") {
        const pages = [...stub.pages].filter(([, p]) => p.owner === auth).map(([id, p]) => ({ ...view(id), title: p.body.title, notes: p.notes }));
        return json(res, 200, { pages });
      }
      const one = /^\/api\/pages\/([^/]+)$/.exec(req.url);
      const p = one && stub.pages.get(one[1]);
      if (!p || p.owner !== auth) return json(res, 404, { error: "page not found" });
      if (req.method === "PUT") {
        p.body = body;
        return json(res, 200, view(one[1]));
      }
      if (req.method === "DELETE") {
        stub.pages.delete(one[1]);
        res.writeHead(204);
        return res.end();
      }
      json(res, 405, { error: "method not allowed" });
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  CLOUD = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  server.close();
  fs.rmSync(STATE, { recursive: true, force: true });
  fs.rmSync(WORK, { recursive: true, force: true });
});

beforeEach(() => {
  stub.requests.length = 0;
  stub.fail = null;
});

function cli(args, env = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["src/cli/main.js", ...args], {
      env: { ...BASE_ENV, AUSTERE_AXI_STATE_DIR: STATE, AUSTERE_AXI_CLOUD_URL: CLOUD, ...env },
    });
    let out = "";
    child.stdout.on("data", (c) => (out += c));
    child.stderr.on("data", (c) => (out += c));
    child.on("close", (code) => resolve({ code, out }));
  });
}

const cloudState = () => JSON.parse(fs.readFileSync(path.join(STATE, "cloud.json"), "utf8"));
const field = (out, name) => new RegExp(`^${name}: (.*)$`, "m").exec(out)?.[1];

// ── the command ──

test("publish creates an owner and a page, republish updates the same link, --new makes another", async () => {
  const file = path.join(WORK, "plan.html");
  fs.writeFileSync(file, page('root = Stack([intro])\nintro = TextContent("hello")'));
  const abs = fs.realpathSync(file);

  let r = await cli(["publish", file]);
  assert.equal(r.code, 0, r.out);
  assert.equal(field(r.out, "status"), "published");
  assert.match(field(r.out, "mode"), /^"?hold/);
  assert.deepEqual(stub.requests.map((q) => `${q.method} ${q.url}`), ["POST /api/owners", "POST /api/pages"]);
  const create = stub.requests[1];
  assert.equal(create.encoding, "gzip");
  assert.equal(create.body.cliVersion, VERSION);
  assert.equal(create.body.title, "Plan");
  assert.equal(create.body.auto, false);
  assert.equal(create.body.html, fs.readFileSync(file, "utf8").replace(RUNTIME_TAG, `<script src="/rt/${VERSION}/austere.js"></script>`), "only the runtime tag changes");

  const first = cloudState();
  const url = field(r.out, "url");
  assert.equal(url, `${CLOUD}/p/${first.pages[abs].id}`);
  assert.equal(first.url, CLOUD);
  assert.ok(first.token.length >= 43);
  assert.deepEqual(first.pages[abs], { id: first.pages[abs].id, auto: false, cursor: 0 });
  if (process.platform !== "win32") assert.equal(fs.statSync(path.join(STATE, "cloud.json")).mode & 0o777, 0o600);

  // Republish: PUT on the same id, the same token, the saved cursor kept.
  fs.writeFileSync(path.join(STATE, "cloud.json"), JSON.stringify({ ...first, pages: { [abs]: { ...first.pages[abs], cursor: 7 } } }));
  stub.requests.length = 0;
  r = await cli(["publish", file, "--auto"]);
  assert.equal(r.code, 0, r.out);
  assert.equal(field(r.out, "status"), "updated");
  assert.equal(field(r.out, "url"), url);
  assert.deepEqual(stub.requests.map((q) => `${q.method} ${q.url}`), [`PUT /api/pages/${first.pages[abs].id}`]);
  assert.equal(stub.requests[0].auth, first.token);
  assert.equal(stub.requests[0].body.auto, true);
  assert.deepEqual(cloudState().pages[abs], { id: first.pages[abs].id, auto: true, cursor: 7 });

  // --new: a fresh link, and the file now maps to it.
  stub.requests.length = 0;
  r = await cli(["publish", file, "--new"]);
  assert.equal(field(r.out, "status"), "published");
  assert.notEqual(field(r.out, "url"), url);
  assert.deepEqual(stub.requests.map((q) => `${q.method} ${q.url}`), ["POST /api/pages"]);
  assert.deepEqual(cloudState().pages[abs], { id: field(r.out, "url").split("/p/")[1], auto: false, cursor: 0 });

  // list: both pages, the current one mapped back to the file.
  r = await cli(["publish", "list"]);
  assert.equal(r.code, 0, r.out);
  assert.equal(r.out.match(/^ {2}- id: /gm).length, 2);
  assert.ok(r.out.includes(`file: ${abs}`));

  // rm by id (the orphaned first page), then by file.
  r = await cli(["publish", "rm", first.pages[abs].id]);
  assert.equal(r.code, 0, r.out);
  assert.equal(field(r.out, "status"), "removed");
  r = await cli(["publish", "rm", file]);
  assert.equal(r.code, 0, r.out);
  assert.equal(field(r.out, "file"), abs);
  assert.deepEqual(cloudState().pages, {});
  assert.equal(stub.pages.size, 0);
  r = await cli(["publish", "list"]);
  assert.match(r.out, /pages: none/);
});

test("a page gone from the service: republish says so and points at --new; rm drops the local record", async () => {
  const file = path.join(WORK, "gone.html");
  fs.writeFileSync(file, page('root = TextContent("x")'));
  assert.equal((await cli(["publish", file])).code, 0);
  stub.pages.clear(); // expired
  let r = await cli(["publish", file]);
  assert.equal(r.code, 1);
  assert.match(r.out, /gone from .*publish --new/);
  r = await cli(["publish", "rm", file]);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /already gone/);
  assert.equal(cloudState().pages[fs.realpathSync(file)], undefined);
});

test("service errors print the service's message", async () => {
  const file = path.join(WORK, "big.html");
  fs.writeFileSync(file, page('root = TextContent("x")'));
  for (const [status, error] of [
    [413, "upload is 2000000 bytes; the limit is 1048576 bytes after gzip"],
    [429, "rate limit: 20 per day; try again later"],
  ]) {
    stub.fail = { status, error };
    const r = await cli(["publish", file]);
    assert.equal(r.code, 1);
    assert.ok(r.out.includes(error), r.out);
    assert.match(r.out, new RegExp(`http: ${status}`));
  }
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
    fs.rmSync(state, { recursive: true, force: true });
  }
});

// ── bundling ──

test("bundling: Mermaid and bundled packs get /rt/ tags after the runtime; relative images are inlined", () => {
  const png = Buffer.from("89504e470d0a1a0a", "hex");
  fs.mkdirSync(path.join(WORK, "img"), { recursive: true });
  fs.writeFileSync(path.join(WORK, "img", "shot.png"), png);
  const abs = path.join(WORK, "flow.html");
  const program = 'root = Stack([f, i, m])\nf = Mermaid("flowchart LR\\n  a --> b")\ni = Image("Shot", "img/shot.png")\nm = MarkDownRenderer("![x](img/shot.png) and https://x.test/a.png")\np = Progress(40)';
  const out = bundlePage(abs, page(program));
  const tags = [...out.html.matchAll(/<script src="([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(tags, [`/rt/${VERSION}/mermaid.min.js`, `/rt/${VERSION}/austere.js`, `/rt/${VERSION}/packs/mermaid.js`, `/rt/${VERSION}/packs/shadcn.js`]);
  const data = `data:image/png;base64,${png.toString("base64")}`;
  assert.equal(out.html.split(data).length - 1, 2, "both references inlined");
  assert.ok(out.html.includes("https://x.test/a.png"), "absolute URLs stay");
  assert.equal(out.images, 1);
  assert.equal(out.title, "Plan");

  assert.throws(() => bundlePage(abs, page('root = Image("x", "../outside.png")')), /outside the page's folder/);
  assert.throws(() => bundlePage(abs, page('root = Image("x", "img/.hidden.png")')), /dotfile/);
  assert.throws(() => bundlePage(abs, page('root = Image("x", "img/none.png")')), /not found/);

  // Path-like text that is not an image reference stays text.
  const text = 'root = Stack([t, c])\nt = FileTree(["img/shot.png", "src/missing.png"])\nc = CodeBlock("js", "import logo from \'./logo.svg\'")';
  assert.equal(bundlePage(abs, page(text)).images, 0);

  // A symlink beside the page that leads out of its folder is refused, as the local server refuses to serve it.
  if (process.platform !== "win32") {
    fs.writeFileSync(path.join(WORK, "..", "austere-publish-secret.txt"), "SECRET");
    fs.symlinkSync(path.join(WORK, "..", "austere-publish-secret.txt"), path.join(WORK, "img", "leak.png"));
    try {
      assert.throws(() => bundlePage(abs, page('root = Image("x", "img/leak.png")')), /outside the page's folder/);
    } finally {
      fs.rmSync(path.join(WORK, "..", "austere-publish-secret.txt"), { force: true });
    }
  }
});

test("bundling: installed packs upload by SHA-256 as /pk/ blobs; missing or mismatched packs are errors", () => {
  const code = "/* pack */ AustereAxi.registerPack({});\n";
  const dir = path.join(STATE, "packs", "@acme+charts@1.2.0");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "pack.js"), code);
  fs.writeFileSync(path.join(dir, "catalog.json"), JSON.stringify({ format: 1, pack: "@acme/charts", version: "1.2.0", components: [] }));
  fs.writeFileSync(path.join(STATE, "packs.json"), JSON.stringify({ format: 1, packs: { "@acme/charts": { version: "1.2.0", integrity: "sha384-x", source: "folder" } } }));
  try {
    const sha = crypto.createHash("sha256").update(code).digest("hex");
    const out = bundlePage(path.join(WORK, "c.html"), page('root = TextContent("x")', '<meta name="austere-packs" content="@acme/charts@1.2.0 sha384-x">\n'));
    assert.deepEqual(out.packs, [{ sha256: sha, name: "@acme/charts", version: "1.2.0", code }]);
    assert.ok(out.html.includes(`<script src="/rt/${VERSION}/austere.js"></script>\n<script src="/pk/${sha}.js"></script>`));
    assert.ok(out.html.includes('<meta name="austere-packs" content="@acme/charts@1.2.0 sha384-x">'), "the page's declaration stays");

    const head = (spec) => `<meta name="austere-packs" content="${spec}">\n`;
    assert.throws(() => bundlePage("/x.html", page("root = TextContent(\"x\")", head("@acme/other@1.0.0"))), /@acme\/other@1\.0\.0 is not installed/);
    assert.throws(() => bundlePage("/x.html", page("root = TextContent(\"x\")", head("@acme/charts@2.0.0"))), /1\.2\.0 is installed/);
    assert.throws(() => bundlePage("/x.html", page("root = TextContent(\"x\")", head("@acme/charts@1.2.0 sha384-other"))), /does not match the page's hash/);
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
  const run = (...args) =>
    new Promise((resolve) => {
      const child = spawn(process.execPath, ["src/cli/main.js", ...args], { env });
      let out = "";
      child.stdout.on("data", (c) => (out += c));
      child.on("close", (code) => resolve({ code, out }));
    });
  try {
    let r = await run(file, "--no-open");
    assert.equal(r.code, 0, r.out);
    const id = /\/s\/([\w-]+)/.exec(r.out)[1];
    const sent = await fetch(`http://127.0.0.1:${port}/s/${id}/send`, {
      method: "POST",
      headers: { ...ownerHeaders(state), origin: `http://127.0.0.1:${port}`, "content-type": "application/json" },
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
    fs.rmSync(state, { recursive: true, force: true });
  }
});
