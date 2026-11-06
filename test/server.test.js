import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import crypto from "node:crypto";
import { ownerHeaders } from "./owner.js";
import { freePort } from "./port.js";

const PORT = await freePort();
const STATE = fs.mkdtempSync(path.join(os.tmpdir(), "austere-test-"));
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), "austere-work-"));
const FILE = path.join(WORK, "plan.html");
let server;
const OWNER = ownerHeaders(STATE);

/** As the owner: the CLI's key header and the owner cookie. */
function req(method, route, body, headers = {}) {
  return bare(method, route, body, { ...OWNER, ...headers });
}

/** As any local process: loopback, and no owner key. */
function bare(method, route, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const r = http.request(
      { host: "127.0.0.1", port: PORT, method, path: route, headers: { "content-type": "application/json", ...headers } },
      (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => {
          let parsed = data;
          try {
            parsed = JSON.parse(data);
          } catch {}
          resolve({ status: res.statusCode, data: parsed, headers: res.headers });
        });
      },
    );
    r.on("error", reject);
    if (payload) r.write(payload);
    r.end();
  });
}

before(async () => {
  fs.writeFileSync(
    FILE,
    `<!doctype html><html><head><title>Plan</title><script src="https://cdn.jsdelivr.net/npm/austere-axi@0/dist/austere.js"></script></head>
<body><script type="text/openui">
root = Stack([intro])
intro = TextContent("hello")
</script></body></html>`,
  );
  fs.writeFileSync(path.join(WORK, "shot.png"), "png");
  server = spawn(process.execPath, ["src/cli/main.js", "server", "--port", String(PORT)], {
    env: { ...process.env, AUSTERE_AXI_STATE_DIR: STATE, AUSTERE_AXI_NO_TAILSCALE: "1", OPENUI_TELEMETRY_DISABLED: "1" },
    stdio: "ignore",
  });
  for (let i = 0; i < 100; i++) {
    try {
      const r = await req("GET", "/api/health");
      if (r.status === 200) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error("server did not start");
});

after(async () => {
  if (server && server.exitCode === null) {
    const exited = new Promise((r) => server.once("exit", r));
    server.kill();
    await exited;
  }
  fs.rmSync(STATE, { recursive: true, force: true });
  fs.rmSync(WORK, { recursive: true, force: true });
});

test("open, poll, send, reply, end", async () => {
  const open = await req("POST", "/api/open", { file: FILE });
  assert.equal(open.status, 200);
  assert.equal(open.data.status, "open");
  const id = open.data.session.id;

  const pollP = req("POST", "/api/poll", { file: FILE });
  await new Promise((r) => setTimeout(r, 100));
  const second = await req("POST", "/api/poll", { file: FILE });
  assert.equal(second.status, 409, "a second poll is refused while one listens");

  const host = { host: `127.0.0.1:${PORT}`, origin: `http://127.0.0.1:${PORT}` };
  const sent = await req(
    "POST",
    `/s/${id}/send`,
    { items: [{ kind: "annotation", target: "intro", component: "TextContent", note: "louder" }, { kind: "message", text: "thanks" }] },
    host,
  );
  assert.equal(sent.status, 200);
  const poll = await pollP;
  assert.equal(poll.data.status, "feedback");
  assert.deepEqual(
    poll.data.items.map((i) => i.kind),
    ["annotation", "message"],
  );

  const reply = await req("POST", "/api/reply", { file: FILE, text: "Made it louder." });
  assert.equal(reply.status, 200);

  const crossOrigin = await req("POST", `/s/${id}/end`, {}, { ...host, origin: "http://evil.example" });
  assert.equal(crossOrigin.status, 403);

  const end = await req("POST", `/s/${id}/end`, {}, host);
  assert.equal(end.status, 200);
  const after = await req("POST", "/api/poll", { file: FILE });
  assert.equal(after.data.status, "ended");
  assert.equal(after.data.endedBy, "user");

  const refused = await req("POST", "/api/open", { file: FILE });
  assert.equal(refused.data.status, "refused", "a user-ended review is not reopened uninvited");
  const reopened = await req("POST", "/api/open", { file: FILE, reopen: true });
  assert.equal(reopened.data.status, "open");
});

test("feedback sent while no agent listens waits for the next poll", async () => {
  const open = await req("POST", "/api/open", { file: FILE });
  const id = open.data.session.id;
  const host = { host: `127.0.0.1:${PORT}` };
  await req("POST", `/s/${id}/send`, { items: [{ kind: "message", text: "queued while away" }] }, host);
  const poll = await req("POST", "/api/poll", { file: FILE });
  assert.equal(poll.data.status, "feedback");
  assert.equal(poll.data.items[0].text, "queued while away");
});

test("serves the artifact with a local runtime and confines sibling files", async () => {
  const open = await req("POST", "/api/open", { file: FILE });
  const id = open.data.session.id;
  const host = { host: `127.0.0.1:${PORT}` };
  const page = await req("GET", `/s/${id}/a/plan.html`, undefined, host);
  assert.equal(page.status, 200);
  assert.match(page.data, /src="\/__austere\/austere\.js/);
  assert.doesNotMatch(page.data, /jsdelivr/);
  assert.equal((await req("GET", `/s/${id}/a/shot.png`, undefined, host)).status, 200);
  assert.equal((await req("GET", `/s/${id}/a/..%2F..%2Fetc%2Fpasswd`, undefined, host)).status, 404);
  assert.equal((await req("GET", `/s/${id}/a/plan.html`, undefined, { host: "evil.example" })).status, 403);
});

// ── the owner key on loopback ──

const posix = process.platform !== "win32";
const mode = (p) => fs.statSync(p).mode & 0o777;

function cli(env, ...args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["src/cli/main.js", ...args], { env: { ...process.env, AUSTERE_AXI_NO_TAILSCALE: "1", OPENUI_TELEMETRY_DISABLED: "1", ...env } });
    let out = "";
    child.stdout.on("data", (c) => (out += c));
    child.stderr.on("data", (c) => (out += c));
    child.on("close", (code) => resolve({ code, out }));
  });
}

test("another local process without the owner key cannot read files, sessions or pages", async () => {
  const secret = path.join(WORK, "credentials");
  fs.writeFileSync(secret, "DUMMY-SECRET\n", { mode: 0o600 });
  fs.mkdirSync(path.join(WORK, "sub"), { recursive: true });
  fs.writeFileSync(path.join(WORK, "sub", "private.txt"), "DUMMY-SIBLING\n");

  const json = { "content-type": "application/json" };
  assert.equal((await bare("POST", "/api/open", { file: secret })).status, 403, "/api/open needs the key");
  assert.equal((await bare("POST", "/api/open", { file: secret }, { "x-austere-key": "wrong" })).status, 403, "a wrong key is refused");
  assert.equal((await bare("GET", "/api/sessions")).status, 403, "/api/sessions needs the key");
  assert.equal((await bare("POST", "/api/shutdown", {})).status, 403);

  // The owner opened the file; a keyless peer still cannot read it or its directory.
  const open = await req("POST", "/api/open", { file: secret });
  assert.equal(open.status, 200);
  const id = open.data.session.id;
  assert.equal(open.data.links.local, `http://127.0.0.1:${PORT}/s/${id}`, "the local link carries no key");
  assert.equal(open.data.links.remote, undefined);
  const host = { host: `127.0.0.1:${PORT}`, ...json };
  for (const p of [`/s/${id}/a/credentials`, `/s/${id}/a/sub/private.txt`, `/s/${id}`, `/s/${id}/events`, "/"]) {
    const r = await bare("GET", p, undefined, host);
    assert.equal(r.status, 403, `${p} is refused without the owner cookie`);
    assert.doesNotMatch(String(r.data), /DUMMY/);
  }
  assert.match((await bare("GET", `/s/${id}`, undefined, host)).data, /open it with the austere-axi CLI/, "the owner is told how to get in");
  assert.match((await req("GET", `/s/${id}/a/credentials`, undefined, host)).data, /DUMMY-SECRET/, "the owner still can");
  assert.equal((await req("GET", "/api/sessions")).status, 200);
  await req("POST", "/api/end", { file: secret });
});

test("health proves the server holds the owner key without giving it away", async () => {
  const key = OWNER["x-austere-key"];
  const r = await bare("GET", "/api/health?nonce=abc123");
  assert.equal(r.status, 200);
  assert.equal(r.data.proof, crypto.createHmac("sha256", key).update("abc123").digest("base64url"));
  assert.ok(!JSON.stringify(r.data).includes(key));
  assert.equal((await bare("GET", "/api/health")).data.proof, undefined);
});

/** A listener on a free port that answers health like austere-axi, and records every request. */
async function fakeServer(healthBody, { stays = false } = {}) {
  const port = await freePort();
  const seen = [];
  const fake = http.createServer((rq, rs) => {
    seen.push({ method: rq.method, url: rq.url, key: rq.headers["x-austere-key"] });
    rs.setHeader("content-type", "application/json");
    if (rq.url.startsWith("/api/health")) return rs.end(JSON.stringify(healthBody));
    if (rq.url === "/api/shutdown" && !stays) {
      rs.end(JSON.stringify({ ok: true }));
      fake.close();
      fake.closeAllConnections();
      return;
    }
    rs.end(JSON.stringify({ status: "feedback", items: [{ kind: "message", text: "DUMMY-INJECTED" }], links: { local: "http://attacker.invalid/" } }));
  });
  await new Promise((r) => fake.listen(port, "127.0.0.1", r));
  return { port, seen, close: () => new Promise((r) => (fake.listening ? fake.close(r) : r())) };
}

test("the CLI refuses a port squatter that cannot prove it holds the owner key", async () => {
  const state = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "austere-squat-")), "state");
  try {
    for (const proof of [undefined, "AAAA", crypto.randomBytes(32).toString("base64url")]) {
      const fake = await fakeServer({ name: "austere-axi", version: "999.0.0", stateDir: state, proof, listen: ["127.0.0.1"], hub: false, hubWanted: false });
      try {
        const env = { AUSTERE_AXI_STATE_DIR: state, AUSTERE_AXI_PORT: String(fake.port), AUSTERE_AXI_NO_OPEN: "1" };
        for (const args of [[FILE], ["poll", FILE], ["feedback", FILE]]) {
          const r = await cli(env, ...args);
          assert.doesNotMatch(r.out, /DUMMY-INJECTED|attacker\.invalid/, `${args[0]}: nothing from the squatter reaches the agent`);
        }
        assert.ok(fake.seen.length > 0);
        assert.ok(fake.seen.every((x) => x.url.startsWith("/api/health?nonce=")), `only health was asked: ${JSON.stringify(fake.seen)}`);
        assert.ok(fake.seen.every((x) => x.key === undefined), "the key never went to the squatter");
        assert.match((await cli(env, FILE)).out, /not austere-axi/);
      } finally {
        await fake.close();
      }
    }
    if (posix) {
      assert.equal(mode(state), 0o700, "a new state dir is the owner's only");
      assert.equal(mode(path.join(state, "owner.key")), 0o600);
    }
  } finally {
    fs.rmSync(path.dirname(state), { recursive: true, force: true });
  }
});

test("a server from before the proof is replaced, without sending it the key", async () => {
  const state = fs.mkdtempSync(path.join(os.tmpdir(), "austere-legacy-"));
  const fake = await fakeServer({ name: "austere-axi", version: "0.0.1", stateDir: state, listen: ["127.0.0.1"], hub: false, hubWanted: false });
  const env = { AUSTERE_AXI_STATE_DIR: state, AUSTERE_AXI_PORT: String(fake.port), AUSTERE_AXI_NO_OPEN: "1" };
  try {
    const r = await cli(env, FILE);
    assert.match(r.out, /status: open/, r.out);
    assert.ok(fake.seen.some((x) => x.url === "/api/shutdown"), "the old server was asked to stop");
    assert.ok(fake.seen.every((x) => x.key === undefined), "with no key");
  } finally {
    await cli(env, "stop");
    await fake.close();
    fs.rmSync(state, { recursive: true, force: true });
  }
});

test("a squatter that claims to be an old server and will not stop never gets the key", async () => {
  const state = fs.mkdtempSync(path.join(os.tmpdir(), "austere-legacy-squat-"));
  const fake = await fakeServer({ name: "austere-axi", version: "0.0.1", stateDir: state, listen: ["127.0.0.1"], hub: false, hubWanted: false }, { stays: true });
  const env = { AUSTERE_AXI_STATE_DIR: state, AUSTERE_AXI_PORT: String(fake.port), AUSTERE_AXI_NO_OPEN: "1" };
  try {
    const r = await cli(env, FILE);
    assert.notEqual(r.code, 0, r.out);
    assert.doesNotMatch(r.out, /DUMMY-INJECTED|attacker\.invalid/);
    assert.ok(fake.seen.every((x) => x.url.startsWith("/api/health") || x.url === "/api/shutdown"), JSON.stringify(fake.seen));
    assert.ok(fake.seen.every((x) => x.key === undefined), "the key never went to the squatter");
  } finally {
    await fake.close();
    fs.rmSync(state, { recursive: true, force: true });
  }
});

test("the CLI opens the browser through a 0600 launcher file, never with the key on the command line", { skip: process.platform !== "linux" }, async () => {
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), "austere-bin-"));
  const argvFile = path.join(bin, "argv");
  fs.writeFileSync(path.join(bin, "xdg-open"), `#!/bin/sh\nprintf '%s\\n' "$@" > "${argvFile}"\n`, { mode: 0o755 });
  const file = path.join(WORK, "launch.html");
  fs.copyFileSync(FILE, file);
  try {
    const env = { AUSTERE_AXI_STATE_DIR: STATE, AUSTERE_AXI_PORT: String(PORT), AUSTERE_AXI_NO_OPEN: "", PATH: `${bin}:${process.env.PATH}` };
    const r = await cli(env, file);
    assert.match(r.out, /browser: opened/, r.out);
    const key = OWNER["x-austere-key"];
    assert.ok(!r.out.includes(key), "the printed output carries no key");
    for (let i = 0; i < 100 && !fs.existsSync(argvFile); i++) await new Promise((res) => setTimeout(res, 20));
    const argv = fs.readFileSync(argvFile, "utf8").trim().split("\n");
    assert.equal(argv.length, 1);
    assert.ok(!argv[0].includes(key), "the key is not on the command line");
    assert.equal(path.dirname(argv[0]), path.join(STATE, "launch"));
    assert.equal(mode(argv[0]), 0o600);
    assert.equal(mode(path.dirname(argv[0])), 0o700);
    const target = /url=([^"]+)"/.exec(fs.readFileSync(argv[0], "utf8"))[1].replace(/&amp;/g, "&");
    const u = new URL(target);
    assert.equal(u.searchParams.get("key"), key);
    // Following it signs the browser in as the owner.
    const signIn = await bare("GET", u.pathname + u.search, undefined, { host: u.host });
    assert.equal(signIn.status, 302);
    assert.match(String(signIn.headers?.["set-cookie"] ?? ""), /austere_owner=/);
  } finally {
    fs.rmSync(bin, { recursive: true, force: true });
  }
});

test("session files are the owner's only", { skip: !posix }, async () => {
  const open = await req("POST", "/api/open", { file: FILE });
  const f = path.join(STATE, "sessions", `${open.data.session.id}.json`);
  for (let i = 0; i < 100 && !fs.existsSync(f); i++) await new Promise((r) => setTimeout(r, 20));
  assert.equal(mode(path.join(STATE, "sessions")), 0o700);
  assert.equal(mode(f), 0o600);
});
