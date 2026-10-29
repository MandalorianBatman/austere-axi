// `feedback` for later sessions, and the hub: the persistent server with an
// SQLite index of artifacts by project and date.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { SessionStore } from "../src/cli/sessions.js";
import { hubUnsupported, projectOf } from "../src/cli/hub.js";

const PORT = 48000 + Math.floor(Math.random() * 1000);
const STATE = fs.mkdtempSync(path.join(os.tmpdir(), "austere-hub-state-"));
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), "austere-hub-work-"));
const PROJECT = path.join(WORK, "shop");
const FILE = path.join(PROJECT, "docs", "plan.html");
const ENV = {
  ...process.env,
  AUSTERE_AXI_STATE_DIR: STATE,
  AUSTERE_AXI_PORT: String(PORT),
  AUSTERE_AXI_NO_TAILSCALE: "1",
  AUSTERE_AXI_NO_OPEN: "1",
  AUSTERE_AXI_IDLE_TIMEOUT_MS: "300",
  OPENUI_TELEMETRY_DISABLED: "1",
};
const skip = hubUnsupported();

function cli(...args) {
  return cliWith(ENV, ...args);
}

function cliWith(env, ...args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["src/cli/main.js", ...args], { env });
    let out = "";
    child.stdout.on("data", (c) => (out += c));
    child.stderr.on("data", (c) => (out += c));
    child.on("close", (code) => resolve({ code, out }));
  });
}

function req(method, route, body, port = PORT) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const r = http.request(
      { host: "127.0.0.1", port, method, path: route, headers: { "content-type": "application/json", host: `127.0.0.1:${port}` } },
      (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => resolve({ status: res.statusCode, data, headers: res.headers }));
      },
    );
    r.on("error", reject);
    if (payload) r.write(payload);
    r.end();
  });
}

before(() => {
  fs.mkdirSync(path.join(PROJECT, ".git"), { recursive: true });
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  fs.writeFileSync(
    FILE,
    `<!doctype html><html><head><title>Checkout plan</title><script src="https://cdn.jsdelivr.net/npm/austere-axi@0/dist/austere.js"></script></head>
<body><script type="text/openui">
root = Stack([intro])
intro = TextContent("hello")
</script></body></html>`,
  );
});

after(async () => {
  await cli("stop");
  fs.rmSync(STATE, { recursive: true, force: true });
  fs.rmSync(WORK, { recursive: true, force: true });
});

test("feedback: what no agent has answered; reading it counts as received", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "austere-fb-"));
  try {
    const store = new SessionStore(dir);
    const s = store.ensure("/x/plan.html");
    const first = store.addUserBatch(s, [{ kind: "message", text: "one" }]);
    store.markDelivered(s, [first]);
    store.addAgentReply(s, "done");
    store.addUserBatch(s, [{ kind: "message", text: "two" }]);
    const peek = store.feedback(s, { peek: true });
    assert.deepEqual(peek.entries.map((e) => [e.items[0].text, e.status]), [["two", "open"]]);
    assert.equal(s.pending.length, 1, "peek leaves it pending");
    const read = store.feedback(s);
    assert.equal(read.fresh.length, 1);
    assert.equal(s.pending.length, 0);
    assert.deepEqual(store.feedback(s).entries.map((e) => e.status), ["received"]);
    assert.deepEqual(store.feedback(s, { all: true }).entries.map((e) => e.status), ["addressed", "received"]);
    store.addAgentReply(s, "did two");
    assert.deepEqual(store.feedback(s).entries, []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("projectOf is the nearest git root, else the file's folder", () => {
  assert.equal(projectOf(FILE), PROJECT);
  assert.equal(projectOf(path.join(os.tmpdir(), "loose.html")), os.tmpdir());
});

test("hub: stays up, indexes checked and reviewed artifacts by project, hands feedback to a later session", { skip: skip || false }, async () => {
  let r = await cli("hub", "on");
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /status: on/);

  // No idle shutdown in hub mode (the idle timeout here is 300 ms).
  await new Promise((res) => setTimeout(res, 1200));
  const health = JSON.parse((await req("GET", "/api/health")).data);
  assert.equal(health.hub, true);

  // check registers the artifact without a review.
  r = await cli("check", FILE);
  assert.match(r.out, /status: ok/);
  let home = (await req("GET", "/")).data;
  assert.match(home, /austere-axi hub/);
  assert.match(home, />shop</);
  assert.match(home, /Checkout plan/);
  assert.match(home, /checked/);

  // Opening from the hub starts a session.
  const id = /href="\/hub\/open\/([a-f0-9]{12})"/.exec(home)[1];
  const open = await req("GET", `/hub/open/${id}`);
  assert.equal(open.status, 302);
  assert.equal(open.headers.location, `/s/${id}`);
  assert.equal((await req("GET", "/hub/open/000000000000")).status, 404);

  // The reviewer sends feedback while no agent listens; a later session reads it.
  r = await cli(FILE);
  assert.match(r.out, /status: open/);
  await req("POST", `/s/${id}/send`, { items: [{ kind: "annotation", target: "intro", component: "TextContent", note: "say more" }] });
  home = (await req("GET", "/")).data;
  assert.match(home, /1 unanswered/);

  r = await cli("feedback", FILE);
  assert.match(r.out, /status: feedback/);
  assert.match(r.out, /annotation: intro \(TextContent\)/);
  assert.match(r.out, /note: say more/);
  home = (await req("GET", "/")).data;
  assert.match(home, /1 unanswered/);
  // Received, so the next poll does not repeat it.
  const poll = JSON.parse((await req("POST", "/api/poll", { file: FILE, timeoutMs: 200 })).data);
  assert.notEqual(poll.status, "feedback");

  r = await cli("reply", FILE, "--agent-reply", "Expanded the intro");
  assert.match(r.out, /replied/);
  r = await cli("feedback", FILE);
  assert.match(r.out, /status: none/);
  home = (await req("GET", "/")).data;
  assert.match(home, /1 answered/);
  assert.doesNotMatch(home, /unanswered/);

  r = await cli("hub", "list");
  assert.match(r.out, /plan\.html/);
  r = await cli("hub", "list", "--project", PROJECT, "checkout");
  assert.match(r.out, /Checkout plan/);
  r = await cli("hub", "list", "nothing-like-this");
  assert.match(r.out, /artifacts: none/);

  // Off: the server goes; the index stays and feedback still works without a server.
  r = await cli("hub", "off");
  assert.match(r.out, /status: off/);
  await new Promise((res) => setTimeout(res, 300));
  r = await cli("feedback", FILE, "--all");
  assert.match(r.out, /status: addressed/);
  r = await cli("hub", "status");
  assert.match(r.out, /hub: off/);
  assert.match(r.out, /artifacts: 1/);
});

test("hub on/off switches the server's mode; a hub whose index will not open does not restart it on every command", { skip: skip || false }, async () => {
  const port = PORT + 1000;
  const state = fs.mkdtempSync(path.join(os.tmpdir(), "austere-hub-mode-"));
  const env = { ...ENV, AUSTERE_AXI_STATE_DIR: state, AUSTERE_AXI_PORT: String(port) };
  const health = async () => JSON.parse((await req("GET", "/api/health", undefined, port)).data);
  try {
    // An index that cannot be opened: the server runs without the hub, and stays up.
    fs.mkdirSync(path.join(state, "hub.db"));
    let r = await cliWith(env, "hub", "on");
    assert.match(r.out, /status: on/);
    let h = await health();
    assert.equal(h.hub, false);
    assert.equal(h.hubWanted, true);
    const pid = h.pid;
    await cliWith(env, FILE);
    await cliWith(env, "reply", FILE, "--agent-reply", "x");
    assert.equal((await health()).pid, pid, "no restart per command");
    assert.match((await cliWith(env, "hub", "status")).out, /hub could not start/);

    // Off, then a plain command: an ordinary server.
    await cliWith(env, "hub", "off");
    fs.rmSync(path.join(state, "hub.db"), { recursive: true });
    await cliWith(env, FILE);
    h = await health();
    assert.equal(h.hub, false);
    assert.equal(h.hubWanted, false);
    // On again: the CLI replaces it with a hub.
    await cliWith(env, "hub", "on");
    h = await health();
    assert.equal(h.hub, true);
    assert.notEqual(h.pid, pid);
  } finally {
    await cliWith(env, "hub", "off");
    await cliWith(env, "stop");
    fs.rmSync(state, { recursive: true, force: true });
  }
});
