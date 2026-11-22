// `cloud login|logout|whoami` and `clone` (RLM-414) against a stub of austere-cloud and WorkOS in one
// HTTP server: the device flow and its error codes, cloud.json (0600) and refresh-token rotation,
// claiming the machine's owner token, publish over the account's access token, and clone.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { after, before, beforeEach, test } from "node:test";
import zlib from "node:zlib";
import type { AddressInfo } from "node:net";
import { WebSocketServer } from "ws";
import { VERSION } from "../src/cli/paths.ts";
import { SUBPROTOCOL, SYNC_VERSION, parseClientFrame, readProtocols } from "../src/shared/sync.ts";
import type { PageRow } from "../src/shared/sync.ts";
import { cloudOn } from "./owner.ts";

const tmp = (p: string) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const ROOT = tmp("austere-account-");
let STATE = "";
const WORK = path.join(ROOT, "work");
fs.mkdirSync(WORK);

const RUNTIME_TAG = '<script src="https://cdn.jsdelivr.net/npm/austere-axi@0/dist/austere.js"></script>';
const PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>Plan</title>\n${RUNTIME_TAG}</head>\n<body><script type="text/openui">\nroot = Stack([intro])\nintro = TextContent("hello")\n</script></body></html>\n`;

const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64url");
/** An access token: the CLI only reads `exp` (the service verifies it), so the signature is a placeholder. */
const jwt = (sub: string, expIn = 300) => `${b64({ alg: "RS256", kid: "k" })}.${b64({ sub, exp: Math.floor(Date.now() / 1000) + expIn, n: crypto.randomUUID() })}.sig`;

const stub = {
  requests: [] as string[],
  /** What the next device-code polls answer, in order; then success. */
  polls: [] as string[],
  /** Access tokens the service accepts, and refresh tokens WorkOS accepts (each once). */
  access: new Map<string, string>(),
  refresh: new Map<string, string>(),
  /** The access token lifetime the next tokens get (s). */
  expIn: 300,
  owners: new Set<string>(),
  /** Owner token -> account that claimed it. */
  claimed: new Map<string, string>(),
  /** Page id -> owner (an owner token or "user:<id>"), its row and html. */
  pages: new Map<string, { owner: string; row: PageRow | null; html: string }>(),
  objects: new Map<string, string>(),
  wsAuth: [] as string[],
};

const USER = { object: "user", id: "user_ana", email: "ana@example.com", first_name: "Ana", last_name: "Lima" };
let BASE = "";
let server: http.Server;
const wss = new WebSocketServer({ noServer: true, handleProtocols: (p) => (p.has(SUBPROTOCOL) ? SUBPROTOCOL : false) });

function tokens() {
  const at = jwt(USER.id, stub.expIn);
  const rt = `rt_${crypto.randomUUID()}`;
  stub.access.set(at, USER.id);
  stub.refresh.set(rt, USER.id);
  return { user: USER, access_token: at, refresh_token: rt };
}

/** Who a bearer credential is: "user:<id>" for an access token, the owner token itself, or null. */
function who(auth: string | undefined): string | null {
  const t = /^Bearer (\S+)$/.exec(auth ?? "")?.[1] ?? "";
  if (stub.access.has(t)) return `user:${stub.access.get(t)}`;
  return stub.owners.has(t) ? t : null;
}

/** Whether `owner` (as `who` names it) owns a page created by `pageOwner`. */
const owns = (owner: string, pageOwner: string) => owner === pageOwner || (owner.startsWith("user:") && stub.claimed.get(pageOwner) === owner.slice(5));

before(async () => {
  server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const url = req.url ?? "";
      const raw = Buffer.concat(chunks);
      const body = (req.headers["content-encoding"] === "gzip" ? zlib.gunzipSync(raw) : raw).toString("utf8");
      const json = (status: number, v: unknown) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(v));
      };
      stub.requests.push(`${req.method} ${url.split("?")[0]}`);
      // ── WorkOS ──
      if (url === "/user_management/authorize/device") {
        const form = new URLSearchParams(body);
        assert.equal(form.get("client_id"), "client_test");
        assert.equal(form.has("client_secret"), false, "a public client sends no secret");
        return json(200, { device_code: "dev_1", user_code: "ABCD-EFGH", verification_uri: `${BASE}/device`, verification_uri_complete: `${BASE}/device?user_code=ABCD-EFGH`, expires_in: 300, interval: 5 });
      }
      if (url === "/user_management/authenticate") {
        const form = new URLSearchParams(body);
        assert.equal(form.has("client_secret"), false, "a public client sends no secret");
        if (form.get("grant_type") === "urn:ietf:params:oauth:grant-type:device_code") {
          const next = stub.polls.shift();
          if (next) return json(400, { error: next });
          return json(200, tokens());
        }
        if (form.get("grant_type") === "refresh_token") {
          const rt = form.get("refresh_token") ?? "";
          if (!stub.refresh.delete(rt)) return json(400, { error: "invalid_grant" });
          return json(200, tokens());
        }
      }
      // ── the service ──
      if (url === "/auth/config") return json(200, { clientId: "client_test", apiBase: BASE });
      if (req.method === "POST" && url === "/api/owners") {
        const token = crypto.randomBytes(32).toString("base64url");
        stub.owners.add(token);
        return json(201, { token });
      }
      const me = who(req.headers.authorization);
      if (!me) return json(401, { error: "invalid token" });
      if (url === "/api/me") return json(200, { user: me.startsWith("user:") ? { id: USER.id, email: USER.email, name: "Ana Lima" } : null, pages: [...stub.pages.values()].filter((p) => owns(me, p.owner)).length });
      if (url === "/api/owners/claim") {
        const { token } = JSON.parse(body) as { token: string };
        if (!me.startsWith("user:")) return json(403, { error: "needs an account" });
        if (!stub.owners.has(token)) return json(404, { error: "unknown owner token" });
        stub.claimed.set(token, me.slice(5));
        return json(200, { pages: [...stub.pages.values()].filter((p) => p.owner === token).length });
      }
      const obj = /^\/api\/objects\/([0-9a-f]{64})$/.exec(url);
      if (req.method === "PUT" && obj) {
        stub.objects.set(obj[1], body);
        res.writeHead(204);
        return res.end();
      }
      if (req.method === "POST" && url === "/api/pages") {
        const id = crypto.randomBytes(16).toString("base64url");
        stub.pages.set(id, { owner: me, row: null, html: "" });
        return json(201, { id, url: `${BASE}/p/${id}` });
      }
      if (req.method === "GET" && url === "/api/pages") {
        const pages = [...stub.pages].filter(([, p]) => owns(me, p.owner) && p.row).map(([id, p]) => ({ id, title: p.row!.title, url: `${BASE}/p/${id}`, expiresAt: p.row!.expiresAt, notes: 0 }));
        return json(200, { pages });
      }
      const html = /^\/api\/pages\/([^/]+)\/html$/.exec(url);
      if (html) {
        const p = stub.pages.get(html[1]);
        if (!p || !owns(me, p.owner) || !p.row) return json(404, { error: "page not found" });
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        return res.end(p.html);
      }
      json(404, { error: "not found" });
    });
  });
  server.on("upgrade", (req, socket, head) => {
    const m = /^\/api\/pages\/([^/?]+)\/sync/.exec(req.url ?? "");
    const creds = readProtocols(req.headers["sec-websocket-protocol"]);
    const me = req.headers.authorization ? who(req.headers.authorization) : creds.owner && stub.owners.has(creds.owner) ? creds.owner : null;
    stub.wsAuth.push(req.headers.authorization ? "bearer" : creds.owner ? "subprotocol" : "none");
    const p = m ? stub.pages.get(m[1]) : undefined;
    if (!me || !p || !owns(me, p.owner)) {
      socket.end("HTTP/1.1 403 Forbidden\r\ncontent-length: 0\r\nconnection: close\r\n\r\n");
      return;
    }
    const id = m![1];
    wss.handleUpgrade(req, socket, head, (ws) => {
      ws.on("message", (data) => {
        const parsed = parseClientFrame(data.toString());
        if (!parsed.ok) return;
        const f = parsed.value;
        if (f.t === "pull") return ws.send(JSON.stringify({ v: SYNC_VERSION, t: "changes", rows: p.row ? [p.row] : [], cursor: 1 }));
        if (f.t === "mutation" && f.name === "publish") {
          const args = f.args as PageRow & { html: string };
          p.html = stub.objects.get(args.html) ?? "";
          const now = Date.now();
          p.row = { v: SYNC_VERSION, type: "page", id, seq: 1, ...(f.args as object), publishedAt: now, expiresAt: now + 86400000, deleted: false } as PageRow;
        }
        if (f.t === "mutation") ws.send(JSON.stringify({ v: SYNC_VERSION, t: "ack", clientId: f.clientId, n: f.n }));
      });
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(() => {
  wss.close();
  server.close();
  fs.rmSync(ROOT, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
});

beforeEach(() => {
  STATE = fs.mkdtempSync(path.join(ROOT, "state-"));
  cloudOn(STATE);
  stub.requests.length = 0;
  stub.polls.length = 0;
  stub.wsAuth.length = 0;
  stub.expIn = 300;
});

function cli(args: string[], env: Record<string, string> = {}): Promise<{ code: number | null; out: string; err: string }> {
  const { promise, resolve } = Promise.withResolvers<{ code: number | null; out: string; err: string }>();
  const child = spawn(process.execPath, ["src/cli/main.ts", ...args], {
    cwd: path.resolve(import.meta.dirname, ".."),
    env: {
      ...process.env,
      AUSTERE_AXI_NO_TAILSCALE: "1",
      AUSTERE_AXI_NO_OPEN: "1",
      OPENUI_TELEMETRY_DISABLED: "1",
      AUSTERE_AXI_STATE_DIR: STATE,
      AUSTERE_AXI_CLOUD_URL: BASE,
      AUSTERE_AXI_DEVICE_POLL_MS: "10",
      ...env,
    },
  });
  let out = "";
  let err = "";
  child.stdout.on("data", (c: Buffer) => (out += c));
  child.stderr.on("data", (c: Buffer) => (err += c));
  child.on("close", (code) => resolve({ code, out, err }));
  return promise;
}

const field = (out: string, name: string) => {
  const v = new RegExp(`^${name}: (.*)$`, "m").exec(out)?.[1];
  return v?.startsWith('"') ? (JSON.parse(v) as string) : v;
};
const cloudJson = () => JSON.parse(fs.readFileSync(path.join(STATE, "cloud.json"), "utf8"));

test("cloud login on a clean machine: device code, approve, tokens in cloud.json (0600); whoami prints the email", async () => {
  stub.polls.push("authorization_pending", "slow_down", "authorization_pending");
  const r = await cli(["cloud", "login"]);
  assert.equal(r.code, 0, r.out + r.err);
  assert.match(r.err, new RegExp(`Sign in at ${BASE}/device\\?user_code=ABCD-EFGH \\(code ABCD-EFGH, works for 5 minutes\\)`), "the full link with the code is shown");
  assert.match(r.err, new RegExp(`Or open ${BASE}/device and enter the code ABCD-EFGH\\.`), "the bare link is the fallback");
  assert.match(r.err, /AUSTERE_AXI_NO_OPEN is set: no browser was started\./);
  assert.equal(field(r.out, "status"), "signed in");
  assert.equal(field(r.out, "email"), "ana@example.com");
  assert.equal(field(r.out, "claimed"), undefined, "nothing to claim on a clean machine");
  assert.equal(stub.requests.filter((x) => x === "POST /user_management/authenticate").length, 4);
  assert.ok(!stub.requests.includes("POST /api/owners"), "no anonymous owner token is made");

  const st = cloudJson();
  assert.equal(st.account.user.email, "ana@example.com");
  assert.equal(st.account.clientId, "client_test");
  assert.equal(st.token, "");
  if (process.platform !== "win32") assert.equal(fs.statSync(path.join(STATE, "cloud.json")).mode & 0o777, 0o600);

  const w = await cli(["cloud", "whoami"]);
  assert.equal(w.code, 0, w.out);
  assert.equal(field(w.out, "email"), "ana@example.com");
  assert.equal(field(w.out, "pages"), "0");
});

test("cloud login that opens the browser still prints the sign-in link for another device", { skip: process.platform === "win32" }, async () => {
  // A stand-in for the platform's opener that records the url it was given.
  const bin = fs.mkdtempSync(path.join(STATE, "bin-"));
  const mark = path.join(bin, "launched");
  for (const name of ["xdg-open", "open"]) fs.writeFileSync(path.join(bin, name), `#!/bin/sh\necho "$1" > "${mark}"\n`, { mode: 0o755 });
  const r = await cli(["cloud", "login"], { AUSTERE_AXI_NO_OPEN: "", PATH: `${bin}${path.delimiter}${process.env.PATH}` });
  assert.equal(r.code, 0, r.out + r.err);
  assert.match(r.err, new RegExp(`Sign in at ${BASE}/device\\?user_code=ABCD-EFGH `));
  assert.match(r.err, /Opened your browser\. Check that the page shows the code ABCD-EFGH\./);
  for (let i = 0; i < 40 && !fs.existsSync(mark); i++) await new Promise((res) => setTimeout(res, 50));
  assert.equal(fs.readFileSync(mark, "utf8").trim(), `${BASE}/device?user_code=ABCD-EFGH`, "the browser opened the full link");
});

test("device flow refusals: access_denied and expired_token are errors, nothing is stored", async () => {
  for (const code of ["access_denied", "expired_token"]) {
    stub.polls.push(code);
    const r = await cli(["cloud", "login"]);
    assert.equal(r.code, 1, r.out);
    assert.match(field(r.out, "error") ?? "", code === "access_denied" ? /denied/ : /expired/);
    assert.equal(fs.existsSync(path.join(STATE, "cloud.json")), false);
  }
});

test("first login claims the machine's anonymous owner token: pages published before are the account's", async () => {
  const file = path.join(WORK, "before.html");
  fs.writeFileSync(file, PAGE);
  const p = await cli(["publish", file]);
  assert.equal(p.code, 0, p.out);
  assert.deepEqual(stub.wsAuth, ["subprotocol"]);
  const r = await cli(["cloud", "login"]);
  assert.equal(r.code, 0, r.out);
  assert.match(field(r.out, "claimed") ?? "", /^1 page /);
  const list = await cli(["clone"]);
  assert.match(list.out, /title: Plan/);
});

test("the access token is refreshed before it expires; the refresh token rotates; invalid_grant signs out", async () => {
  stub.expIn = 30; // inside the refresh margin: every use refreshes
  assert.equal((await cli(["cloud", "login"])).code, 0);
  const rt1 = cloudJson().account.refreshToken;
  assert.equal((await cli(["cloud", "whoami"])).code, 0);
  const rt2 = cloudJson().account.refreshToken;
  assert.notEqual(rt2, rt1, "a refresh stores the new refresh token");
  assert.equal(stub.refresh.has(rt1), false, "the old one is spent");

  // Another process spent it (or the session ended): the next refresh gets invalid_grant.
  stub.refresh.delete(rt2);
  const r = await cli(["cloud", "whoami"]);
  assert.equal(r.code, 1);
  assert.match(field(r.out, "error") ?? "", /cloud login/);
  assert.equal(cloudJson().account, null, "the dead tokens are dropped");
  assert.equal(field((await cli(["cloud", "whoami"])).out, "status"), "not signed in");
});

test("publish while logged in uses the access token everywhere, the socket's Authorization header included", async () => {
  assert.equal((await cli(["cloud", "login"])).code, 0);
  const file = path.join(WORK, "acct.html");
  fs.writeFileSync(file, PAGE);
  const r = await cli(["publish", file]);
  assert.equal(r.code, 0, r.out);
  assert.ok(!stub.requests.includes("POST /api/owners"), "no owner token is made");
  assert.deepEqual(stub.wsAuth, ["bearer"]);
});

test("clone lists the account's pages and writes one down as a local, attached file", async () => {
  assert.equal((await cli(["cloud", "login"])).code, 0);
  const src = path.join(WORK, "elsewhere.html");
  fs.writeFileSync(src, PAGE);
  assert.equal((await cli(["publish", src])).code, 0);
  const id = cloudJson().pages[fs.realpathSync(src)].id as string;

  // Another machine with the same account: a fresh state dir.
  const first = STATE;
  STATE = fs.mkdtempSync(path.join(ROOT, "state-"));
  cloudOn(STATE);
  fs.writeFileSync(path.join(STATE, "cloud.json"), JSON.stringify({ ...JSON.parse(fs.readFileSync(path.join(first, "cloud.json"), "utf8")), pages: {} }), { mode: 0o600 });
  const list = await cli(["clone"]);
  assert.match(list.out, new RegExp(`id: ${id}`));

  const dest = path.join(WORK, "here", "plan.html");
  const r = await cli(["clone", id, dest]);
  assert.equal(r.code, 0, r.out);
  assert.equal(field(r.out, "status"), "cloned");
  const html = fs.readFileSync(dest, "utf8");
  assert.ok(html.includes(RUNTIME_TAG), "the runtime comes from the CDN again");
  assert.ok(html.includes('intro = TextContent("hello")'), "the program is the published one");
  assert.ok(!html.includes(`/rt/${VERSION}/`), "no hosted runtime path is left");
  const entry = cloudJson().pages[fs.realpathSync(dest)];
  assert.equal(entry.id, id);

  assert.equal((await cli(["clone", id, path.join(WORK, "again.html")])).code, 1, "a page attached to a file is not cloned twice");
  assert.equal((await cli(["clone", "x".repeat(22), dest])).code, 1, "an existing file is not overwritten");

  // The clone republishes to the same link.
  const p = await cli(["publish", dest]);
  assert.equal(p.code, 0, p.out);
  assert.equal(field(p.out, "status"), "updated");
  assert.equal(field(p.out, "id"), id);
});

test("logout forgets the account and keeps the pages map; whoami then says so", async () => {
  assert.equal((await cli(["cloud", "login"])).code, 0);
  const r = await cli(["cloud", "logout"]);
  assert.equal(field(r.out, "status"), "signed out");
  assert.equal(cloudJson().account, null);
  assert.equal(field((await cli(["cloud", "logout"])).out, "status"), "not signed in");
  assert.equal((await cli(["cloud", "nope"])).code, 2);
});
