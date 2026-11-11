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
import { Hub, projectOf } from "../src/cli/hub.js";
import { notesPage } from "../src/cli/hub-page.js";
import { ownerHeaders } from "./owner.js";
import { freePort } from "./port.js";

const PORT = await freePort();
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
  AUSTERE_AXI_PERSIST: "1",
  OPENUI_TELEMETRY_DISABLED: "1",
};

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

/** As the owner of STATE: other ports here are only asked for their health, which needs no key. */
function req(method, route, body, port = PORT) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const r = http.request(
      { host: "127.0.0.1", port, method, path: route, headers: { "content-type": "application/json", host: `127.0.0.1:${port}`, ...ownerHeaders(STATE) } },
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

test("feedback: what no agent has acknowledged or answered; reading it acknowledges it", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "austere-fb-"));
  const store = await SessionStore.open(dir);
  try {
    const s = store.ensure("/x/plan.html");
    const first = store.addUserBatch(s, [{ kind: "message", text: "one" }]);
    store.ack(s, first.seq);
    store.addAgentReply(s, "done");
    store.addUserBatch(s, [{ kind: "message", text: "two" }]);
    const peek = store.feedback(s, { peek: true });
    assert.deepEqual(peek.entries.map((e) => [e.items[0].text, e.status]), [["two", "open"]]);
    assert.equal(store.unread(s).length, 1, "peek leaves it unread");
    const read = store.feedback(s);
    assert.equal(read.fresh.length, 1);
    assert.equal(store.unread(s).length, 0);
    assert.deepEqual(store.feedback(s).entries.map((e) => e.status), ["received"]);
    assert.deepEqual(store.feedback(s, { all: true }).entries.map((e) => e.status), ["addressed", "received"]);
    store.addAgentReply(s, "did two");
    assert.deepEqual(store.feedback(s).entries, []);
  } finally {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("projectOf is the nearest git root, else the file's folder", () => {
  assert.equal(projectOf(FILE), PROJECT);
  assert.equal(projectOf(path.join(os.tmpdir(), "loose.html")), os.tmpdir());
});

test("hub: indexes checked and reviewed artifacts by project, hands feedback to a later session", async () => {
  let r = await cli("hub", "on");
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /status: on/);
  assert.equal(JSON.parse((await req("GET", "/api/health")).data).hub, true);

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

  // Off, and no server: the index stays and feedback still works.
  r = await cli("hub", "off");
  assert.match(r.out, /status: off/);
  await cli("stop");
  await new Promise((res) => setTimeout(res, 300));
  r = await cli("feedback", FILE, "--all");
  assert.match(r.out, /status: addressed/);
  r = await cli("hub", "status");
  assert.match(r.out, /hub: off/);
  assert.match(r.out, /artifacts: 1/);
});

test("the server idles out unless it persists; hub on/off does not restart it", async () => {
  const port = await freePort();
  const state = fs.mkdtempSync(path.join(os.tmpdir(), "austere-hub-mode-"));
  const env = { ...ENV, AUSTERE_AXI_STATE_DIR: state, AUSTERE_AXI_PORT: String(port) };
  const health = async () => JSON.parse((await req("GET", "/api/health", undefined, port)).data);
  const up = async () => (await req("GET", "/api/health", undefined, port).catch(() => null))?.status === 200;
  try {
    // Persisting (as behind a proxy): no idle exit, and hub on/off only changes the home page.
    await cliWith(env, FILE);
    const h = await health();
    assert.equal(h.persist, true);
    await cliWith(env, "hub", "on");
    assert.equal((await health()).hub, true);
    await cliWith(env, "hub", "off");
    assert.equal((await health()).hub, false);
    await new Promise((res) => setTimeout(res, 1000)); // the idle timeout here is 300 ms
    assert.equal((await health()).pid, h.pid, "still the same server");
    await cliWith(env, "stop");
    const gone = async () => {
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline && (await up())) await new Promise((res) => setTimeout(res, 100));
      return !(await up());
    };
    assert.ok(await gone());

    // Without it, an unused server exits, hub or not.
    await cliWith({ ...env, AUSTERE_AXI_PERSIST: "" }, "hub", "on");
    assert.equal((await health()).persist, false);
    await new Promise((res) => setTimeout(res, 2000)); // health checks count as use, so wait without them
    assert.equal(await up(), false, "idled out");
  } finally {
    await cliWith(env, "hub", "off");
    await cliWith(env, "stop");
    fs.rmSync(state, { recursive: true, force: true });
  }
});

async function notesHub() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "austere-notes-"));
  const hub = await Hub.open(path.join(dir, "hub.db"));
  hub.register({ id: "aaaaaaaaaaaa", file: path.join(dir, "a", "plan.html"), title: "Plan <A>" });
  hub.register({ id: "bbbbbbbbbbbb", file: path.join(dir, "b", "report.html"), title: "Report" });
  const put = (id, artifact, at, kind, target, text, status) =>
    hub.db.prepare("INSERT INTO items (id, artifact_id, entry_id, at, kind, target, text, status, data) VALUES (?, ?, ?, ?, ?, ?, ?, ?, '{}')").run(id, artifact, id, at, kind, target, text, status);
  put("n1", "aaaaaaaaaaaa", 1000, "annotation", "intro", "make it 100% shorter", "open");
  put("n2", "aaaaaaaaaaaa", 3000, "message", null, "<script>alert(1)</script>", "received");
  put("n3", "bbbbbbbbbbbb", 2000, "annotation", "table_1", "add a_b column", "addressed");
  put("n4", "bbbbbbbbbbbb", 4000, "render-error", "x", "boom", "open");
  return { hub, dir };
}

test("Hub.notes: newest first, filters by text, target, title, status and project", async () => {
  const { hub, dir } = await notesHub();
  try {
    assert.deepEqual(hub.notes().map((n) => n.id), ["n2", "n3", "n1"], "render errors are not notes");
    assert.deepEqual(hub.notes({ status: "unanswered" }).map((n) => n.id), ["n2", "n1"]);
    assert.deepEqual(hub.notes({ status: "answered" }).map((n) => n.id), ["n3"]);
    assert.deepEqual(hub.notes({ q: "table_1" }).map((n) => n.id), ["n3"], "matches target");
    assert.deepEqual(hub.notes({ q: "plan <a>" }).map((n) => n.id), ["n2", "n1"], "matches page title");
    assert.deepEqual(hub.notes({ q: "%" }).map((n) => n.id), ["n1"], "LIKE wildcards are escaped");
    assert.deepEqual(hub.notes({ q: "a_b" }).map((n) => n.id), ["n3"]);
    assert.deepEqual(hub.notes({ q: "a_c" }).map((n) => n.id), []);
    assert.deepEqual(hub.notes({ project: path.join(dir, "b") }).map((n) => n.id), ["n3"]);
    assert.equal(hub.notes({ limit: 1 }).length, 1);
  } finally {
    hub.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("notesPage escapes note text, target, title and filters", async () => {
  const { hub, dir } = await notesHub();
  try {
    const rows = hub.notes();
    rows[0].target = '"><img src=x>';
    const html = notesPage(rows, { version: "1", q: '"><b>', project: "/p/<i>", status: "all", stats: { artifacts: 2, projects: 2, unanswered: 2 } });
    assert.ok(!html.includes("<script>alert"), "note text escaped");
    assert.ok(html.includes("&lt;script&gt;alert(1)&lt;/script&gt;"));
    assert.ok(!html.includes("<img src=x>"));
    assert.ok(!html.includes("<b>"), "query escaped");
    assert.ok(html.includes("Plan &lt;A&gt;"));
    assert.ok(html.includes('href="/hub/open/aaaaaaaaaaaa"'));
  } finally {
    hub.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("hub index: an item field that is not a string does not stop later notes from being indexed", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "austere-sync-"));
  const store = await SessionStore.open(dir);
  try {
    const s = store.ensure(path.join(dir, "plan.html"));
    store.addUserBatch(s, [{ kind: "annotation", id: "bad", target: { x: 1 }, note: { y: 2 } }]);
    store.addUserBatch(s, [{ kind: "message", id: "good", text: "LATER-NOTE" }]);
    assert.deepEqual(new Hub(store.db).notes().map((n) => n.id).sort(), ["bad", "good"]);
  } finally {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
