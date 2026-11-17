// `feedback` for later sessions, and the hub: always on, an SQLite index of pages by project,
// one row per page with a chip per copy (worktree).
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import type { IncomingHttpHeaders } from "node:http";
import { DatabaseSync } from "node:sqlite";
import { SessionStore, sessionId } from "../src/cli/sessions.ts";
import { Hub, SCHEMA_VERSION, openDatabase, unanswered } from "../src/cli/hub.ts";
import { hubPage, notesPage } from "../src/cli/hub-page.ts";
import { findProject, listProjects, mergeProjects } from "../src/cli/projects.ts";
import { ownerHeaders } from "./owner.ts";
import { freePort } from "./port.ts";

interface Health {
  persist: boolean;
  pid: number;
}

interface Poll {
  status: string;
}

interface CliResult {
  code: number | null;
  out: string;
}

interface Res {
  status: number | undefined;
  data: string;
  headers: IncomingHttpHeaders;
}

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

function cli(...args: string[]): Promise<CliResult> {
  return cliWith(ENV, ...args);
}

function cliWith(env: NodeJS.ProcessEnv, ...args: string[]): Promise<CliResult> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["src/cli/main.ts", ...args], { env });
    let out = "";
    child.stdout.on("data", (c) => (out += c));
    child.stderr.on("data", (c) => (out += c));
    child.on("close", (code) => resolve({ code, out }));
  });
}

/** As the owner of `state` (STATE by default): other ports here are only asked for their health, which needs no key. */
function req(method: string, route: string, body?: unknown, port = PORT, state = STATE, extra: Record<string, string> = {}): Promise<Res> {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const r = http.request(
      { host: "127.0.0.1", port, method, path: route, headers: { "content-type": "application/json", host: `127.0.0.1:${port}`, ...ownerHeaders(state), ...extra } },
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
  fs.rmSync(STATE, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  fs.rmSync(WORK, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
});

test("feedback: what no agent has acknowledged or answered; reading it acknowledges it", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "austere-fb-"));
  const store = await SessionStore.open(dir);
  try {
    const s = store.ensure("/x/plan.html");
    const first = store.addUserBatch(s, [{ kind: "message", text: "one" }]);
    store.ack(s, first.seq as number);
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
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  }
});

test("hub: always on; check-only pages hidden until --all; hands feedback to a later session", async () => {
  // check registers the artifact without a review: listed only with --all.
  let r = await cli("check", FILE);
  assert.match(r.out, /status: ok/);
  r = await cli("hub", "list");
  assert.match(r.out, /pages: none/);
  r = await cli("hub", "list", "--all");
  assert.match(r.out, /Checkout plan/);
  assert.match(r.out, /state: checked/);

  // A fresh state dir, no `hub on`: / is the hub.
  r = await cli(FILE);
  assert.match(r.out, /status: registered/);
  let home = (await req("GET", "/")).data;
  assert.match(home, /austere-axi hub/);
  assert.match(home, />shop</);
  assert.match(home, /Checkout plan/);
  assert.doesNotMatch(home, /in review/, "a quiet page says nothing");

  // Opening from the hub goes to the review.
  const id = (/href="\/hub\/open\/([a-f0-9]{12})"/.exec(home) as RegExpExecArray)[1];
  const open = await req("GET", `/hub/open/${id}`);
  assert.equal(open.status, 302);
  assert.equal(open.headers.location, `/s/${id}`);
  assert.equal((await req("GET", "/hub/open/000000000000")).status, 404);
  // Another site cannot make the owner's browser post to the hub (or any page route).
  const foreign = await req("POST", `/hub/open/${id}`, {}, PORT, STATE, { origin: "https://evil.example" });
  assert.equal(foreign.status, 403);
  assert.equal((await req("POST", `/hub/open/${id}`, {})).status, 405, "the hub takes GET only");

  // The reviewer sends feedback while no agent listens; a later session reads it.
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
  const poll = JSON.parse((await req("POST", "/api/poll", { file: FILE, timeoutMs: 200 })).data) as Poll;
  assert.notEqual(poll.status, "feedback");

  r = await cli("reply", FILE, "--agent-reply", "Expanded the intro");
  assert.match(r.out, /replied/);
  r = await cli("feedback", FILE);
  assert.match(r.out, /status: none/);
  home = (await req("GET", "/")).data;
  assert.match(home, /1 answered/);
  assert.doesNotMatch(home, /unanswered/);

  // While a poll waits on the page, its row says an agent is listening; once it ends, the row is quiet again.
  const waiting = req("POST", "/api/poll", { file: FILE, timeoutMs: 1500 });
  await new Promise((res) => setTimeout(res, 300));
  assert.match((await req("GET", "/")).data, /agent listening/);
  await waiting;
  assert.doesNotMatch((await req("GET", "/")).data, /agent listening/);

  r = await cli("hub", "list");
  assert.match(r.out, /page: docs\/plan\.html/);
  assert.match(r.out, /copies:/);
  r = await cli("hub", "list", "--project", PROJECT, "checkout");
  assert.match(r.out, /Checkout plan/);
  r = await cli("hub", "list", "--project", "shop");
  assert.match(r.out, /Checkout plan/);
  r = await cli("hub", "list", "--project", "no-such-project");
  assert.equal(r.code, 1);
  assert.match(r.out, /no project no-such-project/);
  r = await cli("hub", "notes", "--project", PROJECT);
  assert.match(r.out, /text: say more/);
  assert.match(r.out, /project: shop/);
  r = await cli("hub", "list", "nothing-like-this");
  assert.match(r.out, /pages: none/);

  // No server: the index stays and feedback still works.
  await cli("stop");
  await new Promise((res) => setTimeout(res, 300));
  r = await cli("feedback", FILE, "--all");
  assert.match(r.out, /status: addressed/);
  r = await cli("hub", "list");
  assert.match(r.out, /Checkout plan/);
});

test("CLI output has no `session` key, and a page that is not registered gets one message", async () => {
  const unregistered = path.join(WORK, "never-opened.html");
  fs.copyFileSync(FILE, unregistered);
  const runs: CliResult[] = [];
  for (const args of [
    [],
    [FILE],
    ["poll", FILE, "--timeout-ms", "200"],
    ["feedback", FILE, "--all"],
    ["reply", FILE, "--agent-reply", "ok"],
    ["hub", "list"],
    ["hub", "list", "--all"],
    ["hub", "notes"],
    ["project", "list"],
    ["archive", FILE],
    ["unarchive", FILE],
  ]) {
    const r = await cli(...args);
    assert.equal(r.code, 0, `${args.join(" ")}: ${r.out}`);
    runs.push(r);
  }
  const keys = runs.flatMap((r) => Array.from(r.out.matchAll(/^[ \t-]*([A-Za-z_][\w-]*):/gm), (m) => m[1]));
  assert.ok(keys.includes("pages") && keys.includes("status"), `output keys were read: ${keys.join(" ")}`);
  // `session:` is the agent's own session line and `sessions` a command name (RLM-343); the review-session key `open_sessions` is gone.
  assert.deepEqual(keys.filter((k) => /session/i.test(k) && k !== "session" && k !== "sessions"), [], "no output key says session");

  // The path is quoted (and escaped again in YAML) when it has a backslash, as on Windows: match around it.
  const message = /this page is not registered yet: run `austere-axi [^\n]*never-opened\.html[^\n]*` first/;
  for (const args of [["poll", unregistered], ["reply", unregistered, "--agent-reply", "x"], ["login", unregistered], ["feedback", unregistered]]) {
    const r = await cli(...args);
    assert.match(r.out, message, args.join(" "));
    assert.doesNotMatch(r.out, /never been reviewed|no review|no session/i, args.join(" "));
  }
});

test("hub on|off|status exit 2 as removed, with the replacement", async () => {
  for (const sub of ["on", "off", "status"]) {
    const r = await cli("hub", sub);
    assert.equal(r.code, 2, r.out);
    assert.match(r.out, /^status: error$/m, r.out);
    assert.match(r.out, /^code: REMOVED$/m, r.out);
    assert.ok(r.out.includes(`austere-axi hub ${sub} was removed: the hub has no on/off switch; open it with \`austere-axi hub open\``), r.out);
  }
});

test("archive hides a page until unarchive; a deleted file is listed as missing", async () => {
  const port = await freePort();
  const state = fs.mkdtempSync(path.join(os.tmpdir(), "austere-hub-archive-"));
  const env = { ...ENV, AUSTERE_AXI_STATE_DIR: state, AUSTERE_AXI_PORT: String(port) };
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "austere-hub-archive-work-"));
  const keep = path.join(work, "keep.html");
  const gone = path.join(work, "gone.html");
  for (const f of [keep, gone]) fs.copyFileSync(FILE, f);
  const home = async () => (await req("GET", "/", undefined, port, state)).data;
  try {
    await cliWith(env, keep);
    await cliWith(env, gone);
    let r = await cliWith(env, "archive", keep);
    assert.match(r.out, /status: archived/);
    r = await cliWith(env, "hub", "list");
    assert.doesNotMatch(r.out, /keep\.html/);
    assert.match(r.out, /gone\.html/);
    r = await cliWith(env, "hub", "list", "--archived");
    assert.match(r.out, /keep\.html/);
    assert.match(r.out, /state: archived/);
    assert.doesNotMatch(r.out, /gone\.html/);
    assert.doesNotMatch(await home(), /keep\.html/);

    fs.rmSync(gone);
    r = await cliWith(env, "hub", "list");
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /gone\.html/);
    assert.match(r.out, /state: missing/);
    assert.match(await home(), /missing/);
    // A gone file can still be archived.
    r = await cliWith(env, "archive", gone);
    assert.match(r.out, /status: archived/);
    r = await cliWith(env, "unarchive", keep);
    assert.match(r.out, /status: unarchived/);
    r = await cliWith(env, "hub", "list");
    assert.match(r.out, /keep\.html/);
    assert.doesNotMatch(r.out, /gone\.html/);
    r = await cliWith(env, "archive", path.join(work, "never.html"));
    assert.equal(r.code, 1);
    assert.match(r.out, /not in the hub/);
  } finally {
    await cliWith(env, "stop");
    fs.rmSync(state, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
    fs.rmSync(work, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  }
});

test("a missing copy opens a page with its notes and an Archive button; archiving takes it out of the lists", async () => {
  const port = await freePort();
  const state = fs.mkdtempSync(path.join(os.tmpdir(), "austere-hub-gone-"));
  const env = { ...ENV, AUSTERE_AXI_STATE_DIR: state, AUSTERE_AXI_PORT: String(port) };
  const work = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "austere-hub-gone-work-")));
  fs.mkdirSync(path.join(work, ".git"));
  const file = path.join(work, "gone.html");
  fs.copyFileSync(FILE, file);
  const call = (method: string, route: string, body?: unknown, extra: Record<string, string> = {}) => req(method, route, body, port, state, extra);
  try {
    await cliWith(env, file);
    const home = (await call("GET", "/")).data;
    const id = (/href="\/hub\/open\/([a-f0-9]{12})"/.exec(home) as RegExpExecArray)[1];
    await call("POST", `/s/${id}/send`, { items: [{ kind: "message", text: "<b>shorten</b> the intro" }] });
    assert.equal((await call("GET", `/hub/open/${id}`)).status, 302, "a copy that is there opens the review");

    fs.rmSync(file);
    const gone = await call("GET", `/hub/open/${id}`);
    assert.equal(gone.status, 410);
    assert.match(String(gone.headers["content-type"]), /text\/html/);
    assert.ok(gone.data.includes(file), "the full path is on the page");
    assert.ok(gone.data.includes("&lt;b&gt;shorten&lt;/b&gt; the intro"), "its notes, escaped");
    assert.ok(!gone.data.includes("<b>shorten</b>"));
    assert.match(gone.data, /<form method="post" action="\/hub\/archive\/[a-f0-9]{12}"><button/);
    // The home page and the Notes view both link to it.
    assert.equal((await call("GET", "/notes")).data.includes(`/hub/open/${id}`), true);

    // Only the owner's own page posts here: not another site, and a copy the hub does not know is a 404.
    assert.equal((await call("POST", `/hub/archive/${id}`, {}, { origin: "https://evil.example" })).status, 403);
    assert.equal((await call("POST", "/hub/archive/000000000000", {})).status, 404);
    assert.match((await call("GET", "/")).data, /gone\.html/);

    const done = await call("POST", `/hub/archive/${id}`, {});
    assert.equal(done.status, 303);
    assert.equal(done.headers.location, "/");
    assert.doesNotMatch((await call("GET", "/")).data, /gone\.html/);
    const again = await call("GET", `/hub/open/${id}`);
    assert.equal(again.status, 410);
    assert.doesNotMatch(again.data, /<form/, "an archived copy has nothing left to archive");
    assert.match(again.data, /archived/i);
  } finally {
    await cliWith(env, "stop");
    fs.rmSync(state, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
    fs.rmSync(work, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  }
});

test("project feedback marks a batch whose file is gone with missing: true", async () => {
  const port = await freePort();
  const state = fs.mkdtempSync(path.join(os.tmpdir(), "austere-hub-gone-fb-"));
  const env = { ...ENV, AUSTERE_AXI_STATE_DIR: state, AUSTERE_AXI_PORT: String(port) };
  const work = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "austere-hub-gone-fb-work-")));
  fs.mkdirSync(path.join(work, ".git"));
  const keep = path.join(work, "keep.html");
  const gone = path.join(work, "gone.html");
  for (const f of [keep, gone]) fs.copyFileSync(FILE, f);
  const call = (route: string, body: unknown) => req("POST", route, body, port, state);
  try {
    for (const f of [keep, gone]) {
      await cliWith(env, f);
      const id = sessionId(f);
      await call(`/s/${id}/send`, { items: [{ kind: "message", text: `note on ${path.basename(f)}` }] });
    }
    fs.rmSync(gone);
    const r = JSON.parse((await call("/api/feedback", { project: path.basename(work), peek: true })).data) as { batches: { file: string; missing?: boolean }[] };
    const byFile = Object.fromEntries(r.batches.map((b) => [path.basename(b.file), b.missing]));
    assert.deepEqual(Object.keys(byFile).sort(), ["gone.html", "keep.html"]);
    assert.equal(byFile["gone.html"], true);
    assert.ok(!byFile["keep.html"], "a file that is there carries no marker");
  } finally {
    await cliWith(env, "stop");
    fs.rmSync(state, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
    fs.rmSync(work, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  }
});

test("the server idles out unless it persists", async () => {
  const port = await freePort();
  const state = fs.mkdtempSync(path.join(os.tmpdir(), "austere-hub-mode-"));
  const env = { ...ENV, AUSTERE_AXI_STATE_DIR: state, AUSTERE_AXI_PORT: String(port) };
  const health = async () => JSON.parse((await req("GET", "/api/health", undefined, port)).data) as Health;
  const up = async () => (await req("GET", "/api/health", undefined, port).catch(() => null))?.status === 200;
  try {
    // Persisting (as behind a proxy): no idle exit.
    await cliWith(env, FILE);
    const h = await health();
    assert.equal(h.persist, true);
    await new Promise((res) => setTimeout(res, 1000)); // the idle timeout here is 300 ms
    assert.equal((await health()).pid, h.pid, "still the same server");
    await cliWith(env, "stop");
    const gone = async () => {
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline && (await up())) await new Promise((res) => setTimeout(res, 100));
      return !(await up());
    };
    assert.ok(await gone());

    // Without it, an unused server exits; opening the hub starts one like any review.
    await cliWith({ ...env, AUSTERE_AXI_PERSIST: "" }, "hub", "open");
    assert.equal((await health()).persist, false);
    await new Promise((res) => setTimeout(res, 2000)); // health checks count as use, so wait without them
    assert.equal(await up(), false, "idled out");
  } finally {
    await cliWith(env, "stop");
    fs.rmSync(state, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  }
});

async function notesHub() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "austere-notes-"));
  const hub = await Hub.open(path.join(dir, "hub.db"));
  hub.register({ id: "aaaaaaaaaaaa", file: path.join(dir, "a", "plan.html"), title: "Plan <A>" });
  hub.register({ id: "bbbbbbbbbbbb", file: path.join(dir, "b", "report.html"), title: "Report" });
  const put = (id: string, artifact: string, at: number, kind: string, target: string | null, text: string, status: string) =>
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
    assert.deepEqual(hub.notes({ project: findProject(hub.db, path.join(dir, "b"))?.id }).map((n) => n.id), ["n3"]);
    assert.equal(hub.notes({ limit: 1 }).length, 1);
  } finally {
    hub.close();
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  }
});

test("notesPage escapes note text, target, title and filters", async () => {
  const { hub, dir } = await notesHub();
  try {
    const rows = hub.notes();
    rows[0].target = '"><img src=x>';
    const html = notesPage(rows, { version: "1", q: '"><b>', project: "/p/<i>", status: "all" });
    assert.ok(!html.includes("<script>alert"), "note text escaped");
    assert.ok(html.includes("&lt;script&gt;alert(1)&lt;/script&gt;"));
    assert.ok(!html.includes("<img src=x>"));
    assert.ok(!html.includes("<b>"), "query escaped");
    assert.ok(html.includes("Plan &lt;A&gt;"));
    assert.ok(html.includes('href="/hub/open/aaaaaaaaaaaa"'));
  } finally {
    hub.close();
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
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
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  }
});

/** A repository at `<dir>/shop` on main and its worktree `<dir>/shop-feat` on feat, as git lays them out. */
function shopWithWorktree(dir: string): { main: string; wt: string } {
  const main = path.join(dir, "shop");
  const wt = path.join(dir, "shop-feat");
  const gitdir = path.join(main, ".git", "worktrees", "shop-feat");
  fs.mkdirSync(gitdir, { recursive: true });
  fs.writeFileSync(path.join(main, ".git", "HEAD"), "ref: refs/heads/main\n");
  fs.writeFileSync(path.join(gitdir, "commondir"), "../..\n");
  fs.writeFileSync(path.join(gitdir, "HEAD"), "ref: refs/heads/feat\n");
  fs.writeFileSync(path.join(gitdir, "gitdir"), path.join(wt, ".git") + "\n");
  fs.mkdirSync(path.join(wt, "docs"), { recursive: true });
  fs.mkdirSync(path.join(main, "docs"), { recursive: true });
  fs.writeFileSync(path.join(wt, ".git"), `gitdir: ${gitdir}\n`);
  return { main, wt };
}

test("two worktrees holding docs/plan.html: one row, two chips, notes per copy, unanswered first", async () => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "austere-copies-")));
  const { main, wt } = shopWithWorktree(dir);
  const a = path.join(main, "docs", "plan.html");
  const b = path.join(wt, "docs", "plan.html");
  const other = path.join(main, "docs", "other.html");
  for (const f of [a, b, other]) fs.copyFileSync(FILE, f);
  const store = await SessionStore.open(fs.mkdtempSync(path.join(dir, "state-")));
  try {
    const sa = store.ensure(a);
    const sb = store.ensure(b);
    const so = store.ensure(other);
    store.addUserBatch(sa, [{ kind: "message", text: "only on main" }]);
    store.addUserBatch(sb, [{ kind: "annotation", target: "intro", note: "only on feat" }]);
    store.addUserBatch(sb, [{ kind: "message", text: "held for the owner" }], { author: "Ana", hold: true });
    // The page with no notes had the latest activity, and still comes after the one with unanswered notes.
    store.db.prepare("UPDATE artifacts SET updated_at = ? WHERE id = ?").run(Date.now() + 60_000, so.id);
    const hub = new Hub(store.db);
    const pages = hub.list();
    assert.equal(pages.length, 2);
    const plan = pages.find((p) => p.rel_path === "docs/plan.html");
    assert.ok(plan);
    assert.deepEqual(plan.copies.map((c) => [c.label, c.file]).sort(), [["feat", b], ["main", a]]);
    assert.equal(unanswered(plan), 3, "summed across copies, held notes included");
    assert.deepEqual(plan.copies.map((c) => [c.label, unanswered(c)]).sort(), [["feat", 2], ["main", 1]]);
    assert.deepEqual(hub.list({ limit: 1 }).map((p) => p.rel_path), ["docs/plan.html"], "the limit applies after the order");
    assert.equal(pages.find((p) => p.rel_path === "docs/other.html")?.project_id, plan.project_id, "one project");

    // Notes stay per copy.
    const notes = hub.notes();
    assert.deepEqual(notes.filter((n) => n.artifact_id === sa.id).map((n) => [n.text, n.label]), [["only on main", "main"]]);
    assert.deepEqual(notes.filter((n) => n.artifact_id === sb.id).map((n) => [n.text, n.label]).sort(), [["held for the owner", "feat"], ["only on feat", "feat"]]);
    assert.equal(hub.notes({ project: plan.project_id }).length, 3);
    assert.equal(hub.notes({ status: "unanswered" }).length, 3, "the Notes view counts held notes as unanswered too");

    const html = hubPage(pages, { version: "1", q: "", project: "", projects: hub.projects(), counts: hub.viewCounts() });
    assert.equal(html.match(/<section>/g)?.length, 1, "one section for the project");
    assert.equal(html.match(/<li>/g)?.length, 2, "one row per page");
    assert.equal(html.match(/class="chip[ "]/g)?.length, 2, "a chip per copy; none for a page with one copy");
    assert.ok(html.includes(`href="/hub/open/${sb.id}"`), "a chip opens its copy");
    assert.match(html, />feat <span>2 unanswered<\/span>/);
    assert.match(html, /<b class="open">3 unanswered<\/b>/);
    assert.ok(html.indexOf("docs/plan.html") < html.indexOf("docs/other.html"), "unanswered first, then by last activity");
    assert.doesNotMatch(html, /<h3>/, "no per-day headings");
    assert.ok(html.includes(`title="${main}\n${wt}"`), "roots in the tooltip");

    const notesHtml = notesPage(notes, { version: "1", q: "", project: "", status: "all" });
    assert.match(notesHtml, /shop · main/);
    assert.match(notesHtml, /shop · feat/);
  } finally {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  }
});

test("a page in 30 worktrees: 3 chips (unanswered first, then newest), +27 more, long branch names shortened in the middle", async () => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "austere-many-")));
  const main = path.join(dir, "shop");
  fs.mkdirSync(path.join(main, ".git"), { recursive: true });
  fs.writeFileSync(path.join(main, ".git", "HEAD"), "ref: refs/heads/main\n");
  const branch = (i: number): string => `agent/agy-gemini-3-8-flash-high/c07769ee15${String(i).padStart(2, "0")}`;
  const files: string[] = [];
  for (let i = 0; i < 30; i++) {
    const wt = path.join(dir, `wt-${i}`);
    const gitdir = path.join(main, ".git", "worktrees", `wt-${i}`);
    fs.mkdirSync(gitdir, { recursive: true });
    fs.writeFileSync(path.join(gitdir, "commondir"), "../..\n");
    fs.writeFileSync(path.join(gitdir, "gitdir"), path.join(wt, ".git") + "\n");
    fs.writeFileSync(path.join(gitdir, "HEAD"), `ref: refs/heads/${branch(i)}\n`);
    fs.mkdirSync(path.join(wt, "docs"), { recursive: true });
    fs.writeFileSync(path.join(wt, ".git"), `gitdir: ${gitdir}\n`);
    const f = path.join(wt, "docs", "plan.html");
    fs.copyFileSync(FILE, f);
    files.push(f);
  }
  const store = await SessionStore.open(fs.mkdtempSync(path.join(dir, "state-")));
  try {
    const ids = files.map((f) => store.ensure(f).id);
    // Copy i was active at minute i: 29 is the newest. Copies 3 and 5 are old but have unanswered notes.
    ids.forEach((id, i) => store.db.prepare("UPDATE artifacts SET updated_at = ? WHERE id = ?").run(1_000_000 + i * 60_000, id));
    for (const i of [3, 5]) store.addUserBatch(store.get(ids[i])!, [{ kind: "message", text: `on ${i}` }], { at: 1_000_000 + i * 60_000 });
    const hub = new Hub(store.db);
    const pages = hub.list();
    assert.equal(pages.length, 1);
    assert.equal(pages[0].copies.length, 30);
    const html = hubPage(pages, { version: "1", q: "", project: "", projects: hub.projects(), counts: hub.viewCounts() });
    const shown = html.slice(0, html.indexOf('<details class="more">'));
    const order = [...shown.matchAll(/href="\/hub\/open\/([0-9a-f]{12})" title="agent/g)].map((m) => ids.indexOf(m[1]));
    assert.equal(order.length, 3, "three chips before +n more");
    assert.deepEqual(order.slice(0, 2).sort(), [3, 5], "the copies with unanswered notes come first");
    assert.equal(order[2], 29, "then the newest");
    assert.match(html, /<summary>\+27 more<\/summary>/);
    assert.equal(html.match(/class="chip[ "]/g)?.length, 30, "every copy is still reachable");
    assert.match(html, /30 copies/);
    assert.ok(html.includes(`title="${branch(29)} · ${files[29]}"`), "the full label and file in the tooltip");
    assert.ok(!html.includes(`>${branch(29)}<`), "the long label is shortened");
    assert.match(html, />agent\/agy-gemi…\/c07769ee1529</, "shortened in the middle: start and end kept");
  } finally {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  }
});

test("a page's title opens a copy that is still there, the newest one when every copy is gone", async () => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "austere-gone-copy-")));
  const { main, wt } = shopWithWorktree(dir);
  const a = path.join(main, "docs", "plan.html");
  const b = path.join(wt, "docs", "plan.html");
  for (const f of [a, b]) fs.copyFileSync(FILE, f);
  const store = await SessionStore.open(fs.mkdtempSync(path.join(dir, "state-")));
  try {
    const sa = store.ensure(a);
    const sb = store.ensure(b);
    // The worktree's copy is the newest, then its file is deleted.
    store.addUserBatch(sb, [{ kind: "message", text: "on feat" }]);
    store.db.prepare("UPDATE artifacts SET updated_at = ? WHERE id = ?").run(Date.now() + 60_000, sb.id);
    fs.rmSync(b);
    const hub = new Hub(store.db);
    const titleLink = (): string | undefined => hubPage(hub.list(), { version: "1", q: "", project: "", projects: hub.projects(), counts: hub.viewCounts() }).match(/<li><a href="\/hub\/open\/(\w+)"/)?.[1];
    assert.equal(hub.list()[0].copies[0].id, sb.id, "the gone copy is the newest");
    assert.equal(titleLink(), sa.id);
    fs.rmSync(a);
    assert.equal(titleLink(), sb.id);
  } finally {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  }
});

test("archiving one of two copies names it, the copy that stays open and the notes that go with it; --every-copy takes both", async () => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "austere-archive-copies-")));
  const { main, wt } = shopWithWorktree(dir);
  const a = path.join(main, "docs", "plan.html");
  const b = path.join(wt, "docs", "plan.html");
  for (const f of [a, b]) fs.copyFileSync(FILE, f);
  const state = fs.mkdtempSync(path.join(dir, "state-"));
  const env = { ...ENV, AUSTERE_AXI_STATE_DIR: state, AUSTERE_AXI_PORT: String(await freePort()) };
  const store = await SessionStore.open(state);
  try {
    const sa = store.ensure(a);
    const sb = store.ensure(b);
    for (const text of ["one", "two", "three"]) store.addUserBatch(sa, [{ kind: "message", text }]);
    store.addUserBatch(sb, [{ kind: "message", text: "on feat" }]);
    const hub = new Hub(store.db);
    // A third worktree where the page was only checked, never opened for review: no list shows it.
    const fix = path.join(dir, "shop-fix");
    const fixGit = path.join(main, ".git", "worktrees", "shop-fix");
    fs.mkdirSync(fixGit, { recursive: true });
    fs.writeFileSync(path.join(fixGit, "commondir"), "../..\n");
    fs.writeFileSync(path.join(fixGit, "HEAD"), "ref: refs/heads/fix\n");
    fs.writeFileSync(path.join(fixGit, "gitdir"), path.join(fix, ".git") + "\n");
    fs.mkdirSync(path.join(fix, "docs"), { recursive: true });
    fs.writeFileSync(path.join(fix, ".git"), `gitdir: ${fixGit}\n`);
    const c = path.join(fix, "docs", "plan.html");
    fs.copyFileSync(FILE, c);
    hub.register({ id: sessionId(c), file: c });
    assert.equal(hub.list({ all: true })[0].copies.length, 3, "the checked copy is a copy of the same page");
    assert.equal(hub.archivePlan("000000000000"), null, "a copy the hub does not know");
    assert.deepEqual(hub.archivePlan(sa.id), {
      copy: "main",
      archived: [{ id: sa.id, file: a, copy: "main", unanswered: 3 }],
      others: [{ id: sb.id, file: b, copy: "feat", unanswered: 1 }],
    }, "the checked copy neither goes nor is said to stay open");
    assert.deepEqual(hub.archivePlan(sa.id, true)?.archived.map((c) => c.copy), ["main", "feat"]);
    assert.deepEqual(hub.archivePlan(sa.id, true)?.others, []);
  } finally {
    store.close();
  }
  try {
    // No server runs: the CLI writes hub.db itself, with the same plan.
    let r = await cliWith(env, "archive", a);
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /^status: archived$/m);
    assert.match(r.out, /^copy: main$/m, "names the copy it archived");
    assert.match(r.out, /^unanswered: 3$/m, "and the notes that go with it");
    assert.match(r.out, /still_open:\n\s+- file: [^\n]*shop-feat[^\n]*plan\.html"?\n\s+copy: feat\n\s+unanswered: 1\n/);
    assert.match(r.out, /Only this copy \(main\) is archived.*3 unanswered notes go with it.*leave the hub's counts.*archive [^`]+plan\.html[^`]* --every-copy` archives them too/);

    const reopened = await SessionStore.open(state);
    try {
      const hub = new Hub(reopened.db);
      const pages = hub.list();
      assert.deepEqual(pages.map((p) => p.copies.map((c) => c.label)), [["feat"]], "the row stays, with the copy that is still open");
      assert.equal(unanswered(pages[0]), 1, "the archived copy's notes leave the counts");
      const html = hubPage(pages, { version: "1", q: "", project: "", projects: hub.projects(), counts: hub.viewCounts() });
      assert.ok(html.includes(`<li><a href="/hub/open/${sessionId(b)}"`), "the row opens the copy that stays");
      assert.doesNotMatch(html, /in review/);
      const all = hubPage(hub.list({ all: true }), { version: "1", q: "", project: "", projects: hub.projects(), counts: hub.viewCounts() });
      assert.match(all, />main <span>3 unanswered · archived<\/span>/, "the archived copy's chip says so");
      assert.doesNotMatch(all, /in review/);
    } finally {
      reopened.close();
    }

    assert.match((await cliWith(env, "unarchive", a)).out, /status: unarchived/);
    r = await cliWith(env, "archive", b, "--every-copy");
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /Every copy of this page is archived/);
    assert.doesNotMatch(r.out, /still_open/);
    r = await cliWith(env, "hub", "list");
    assert.doesNotMatch(r.out, /plan\.html/, "no copy is left open");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  }
});

test("hubPage escapes project names, labels and paths", () => {
  const copy = (id: string, label: string) => ({ id, file: `/w/${label}/a.html`, root: `/w/${label}`, label, title: null, updated_at: 1, reviewed: 1, archived_at: null, missing: false, open: 0, received: 0, addressed: 0, held: 0 });
  const html = hubPage(
    [{ id: "p1", project_id: "x", project: "<img src=x>", rel_path: "<b>.html", title: '"><i>', updated_at: 1, open: 0, received: 0, addressed: 0, held: 0, copies: [copy("aaaaaaaaaaaa", "<u>"), copy("bbbbbbbbbbbb", "ok")] }],
    { version: "1", q: "", project: "", projects: [{ id: "x", name: "<img src=x>", roots: ["/w/<s>"] }], counts: { open: 1, everything: 1, archived: 0, checked: 0 } },
  );
  for (const raw of ["<img src=x>", "<b>.html", '"><i>', "<u>", "/w/<s>"]) assert.ok(!html.includes(raw), raw);
});

test("hub home: the header, the views and the empty state count the view shown", async () => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "austere-views-")));
  const { main } = shopWithWorktree(dir);
  const file = (name: string): string => {
    const f = path.join(main, "docs", `${name}.html`);
    fs.writeFileSync(f, fs.readFileSync(FILE, "utf8").replace("Checkout plan", name));
    return f;
  };
  const store = await SessionStore.open(fs.mkdtempSync(path.join(dir, "state-")));
  try {
    const hub = new Hub(store.db);
    const render = (opts: { q?: string; project?: string; view?: "default" | "all" | "archived"; listening?: Set<string> } = {}): string => {
      const { q = "", project = "", view = "default", listening } = opts;
      const pages = hub.list({ q, project, archived: view === "archived", all: view === "all" });
      return hubPage(pages, { version: "1", q, project, view, projects: hub.projects(), counts: hub.viewCounts({ q, project }), listening });
    };

    // Only checked pages: the header says 0 pages, and the body says where the pages are.
    hub.register({ id: "aaaaaaaaaaaa", file: file("lint-run") });
    let html = render();
    assert.match(html, /<span class="stats">0 pages · 0 projects<\/span>/);
    assert.match(html, /Nothing is open for review\. 1 page was checked but never opened: <a href="\/\?all=1">show them<\/a>/);
    hub.register({ id: "bbbbbbbbbbbb", file: file("type-run") });
    hub.register({ id: "cccccccccccc", file: file("test-run") });
    assert.match(render(), /3 pages were checked but never opened/);
    assert.match(render(), /<b>Open \(0\)<\/b> · <a href="\/\?all=1">Everything \(3\)<\/a> · <a href="\/\?archived=1">Archived \(0\)<\/a>/);
    html = render({ view: "all" });
    assert.match(html, /<span class="stats">3 pages · 1 project<\/span>/);
    assert.match(html, /<em>checked<\/em>/);

    // One page opened for review with an unanswered note, one archived.
    const open = store.ensure(file("plan"));
    store.addUserBatch(open, [{ kind: "message", text: "say more" }]);
    const gone = store.ensure(file("old-plan"));
    assert.ok(hub.setArchived(gone.id, Date.now()));
    html = render();
    assert.match(html, /<span class="stats">1 page · 1 project · 1 unanswered<\/span>/, "the header counts the rows below it");
    assert.match(html, /<b>Open \(1\)<\/b> · <a href="\/\?all=1">Everything \(5\)<\/a> · <a href="\/\?archived=1">Archived \(1\)<\/a>/);
    assert.doesNotMatch(html, /in review|with checked-only|1 projects|1 pages/);
    assert.doesNotMatch(html, /listening/, "a quiet page says nothing");
    html = render({ view: "all" });
    assert.match(html, /<span class="stats">5 pages · 1 project · 1 unanswered<\/span>/);
    assert.match(html, /<a href="\/">Open \(1\)<\/a> · <b>Everything \(5\)<\/b>/);
    html = render({ view: "archived" });
    assert.match(html, /<span class="stats">1 page · 1 project<\/span>/);
    assert.match(html, /<em>archived<\/em>/);

    // An agent listening shows on the row, and on the page's chip when there are several copies.
    assert.match(render({ listening: new Set([open.id]) }), /<em class="live">agent listening<\/em>/);

    // A search that only an other view matches names that view, with its count.
    html = render({ q: "old-plan" });
    assert.match(html, /Nothing matches in Open\. Also matches: <a href="\/\?q=old-plan&amp;all=1">Everything \(1\)<\/a> · <a href="\/\?q=old-plan&amp;archived=1">Archived \(1\)<\/a>\./);
    assert.match(render({ q: "no-such-page" }), /Nothing matches in Open\.<\/p>/);
    assert.match(render({ q: "no-such-page", view: "all" }), /Nothing matches\.<\/p>/);

    // Nothing archived: the Archived view says so and points back.
    assert.ok(hub.setArchived(gone.id, null));
    html = render({ view: "archived" });
    assert.match(html, /No archived pages\. See: <a href="\/">Open \(2\)<\/a>/);
  } finally {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  }
});

test("hub home: plural and singular labels; an empty hub; the notes header", () => {
  const copy = (id: string) => ({ id, file: `/w/a.html`, root: `/w`, label: "main", title: null, updated_at: 1, reviewed: 1, archived_at: null, missing: false, open: 0, received: 0, addressed: 0, held: 0 });
  const page = { id: "p1", project_id: "x", project: "shop", rel_path: "a.html", title: "A", updated_at: 1, open: 0, received: 0, addressed: 0, held: 0, copies: [copy("aaaaaaaaaaaa")] };
  const counts = { open: 1, everything: 1, archived: 0, checked: 0 };
  const home = (roots: string[]): string => hubPage([page], { version: "1", q: "", project: "", projects: [{ id: "x", name: "shop", roots }], counts });
  assert.match(home(["/w/a"]), /<small[^>]*>\/w\/a<\/small>/);
  assert.match(home(["/w/a", "/w/b"]), /\/w\/a · \+1 more folder</);
  assert.match(home(["/w/a", "/w/b", "/w/c"]), /\/w\/a · \+2 more folders</);
  assert.match(home(["/w/a"]), /1 page · 1 project</);

  assert.match(hubPage([], { version: "1", q: "", project: "", counts: { open: 0, everything: 0, archived: 0, checked: 0 } }), /No pages yet\. Open one for review/);

  const note = (status: string) => ({ id: status, artifact_id: "aaaaaaaaaaaa", at: 1, target: null, text: "t", status, author: "", device_id: null, remote: 0, title: "A", file: "/w/a.html", project: "shop", project_id: "x", root: "/w", label: "main" });
  assert.match(notesPage([note("open")], { version: "1", q: "", project: "", status: "all" }), /1 note · 1 unanswered</);
  assert.match(notesPage([note("addressed"), note("held")], { version: "1", q: "", project: "", status: "all" }), /2 notes · 1 unanswered</);
  assert.match(notesPage([note("addressed")], { version: "1", q: "", project: "", status: "answered" }), /1 note</);
  assert.doesNotMatch(notesPage([note("addressed")], { version: "1", q: "", project: "", status: "answered" }), /unanswered</);
});

test("a 0.10.4 hub.db opens: a repo and its worktree become one project with two roots", async () => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "austere-migrate-")));
  const { main, wt } = shopWithWorktree(dir);
  for (const f of [path.join(main, "docs", "plan.html"), path.join(wt, "docs", "plan.html")]) fs.copyFileSync(FILE, f);
  const file = path.join(dir, "hub.db");
  fs.copyFileSync(path.join(import.meta.dirname, "fixtures", "hub-0.10.4.db"), file);
  try {
    // The fixture names its folders /FIXTURE/...; point them at this machine's temp dir, in the old schema.
    const old = new DatabaseSync(file);
    assert.ok(!old.prepare("PRAGMA table_info(artifacts)").all().some((c) => c.name === "project_id"), "the fixture has the 0.10.4 schema");
    old.prepare("UPDATE artifacts SET file = replace(file, '/FIXTURE', ?), project = replace(project, '/FIXTURE', ?)").run(dir, dir);
    old.close();

    const db = await openDatabase(file);
    const hub = new Hub(db);
    try {
      const projects = hub.projects();
      assert.deepEqual(projects.map((p) => [p.name, p.roots]), [["shop", [main, wt]]]);
      assert.deepEqual(
        (db.prepare("SELECT kind FROM project_roots ORDER BY root").all() as { kind: string }[]).map((r) => r.kind),
        ["git", "worktree"],
      );
      const all = hub.list({ all: true });
      const plan = all.find((p) => p.rel_path === "docs/plan.html");
      assert.deepEqual(plan?.copies.map((c) => c.label).sort(), ["feat", "main"]);
      assert.ok(all.some((p) => p.rel_path === "docs/checked.html"));
      // Default list: the check-only page is hidden, and the copy closed under 0.10.4 is archived.
      assert.deepEqual(hub.list().map((p) => [p.rel_path, p.copies.map((c) => c.label)]), [["docs/plan.html", ["main"]]]);
      assert.deepEqual(hub.notes().map((n) => n.text).sort(), ["on feat", "on main"], "notes survive");
      // RLM-343: the session registry's tables are there, with the columns the design note names.
      const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('agent_sessions', 'page_sessions') ORDER BY name").all() as { name: string }[]).map((r) => r.name);
      assert.deepEqual(tables, ["agent_sessions", "page_sessions"]);
      const columns = (table: string) => (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name);
      assert.deepEqual(columns("agent_sessions"), ["id", "harness", "session_id", "session_file", "cwd", "model", "parent_id", "parent_kind", "pid", "pid_start", "first_seen", "last_seen"]);
      assert.deepEqual(columns("page_sessions"), ["artifact_id", "agent_session_id", "role", "at"]);
      // RLM-345: the attach settings and the runs, with the columns the design note names (plus `requeued_from`, `pid`, `pid_start` and `bin`, A20).
      assert.deepEqual(columns("attach_settings"), ["scope", "scope_id", "state", "mode", "session", "harness", "model"]);
      assert.deepEqual(columns("runs"), ["id", "kind", "artifact_id", "project_id", "agent_session_id", "harness", "mode", "model", "seq_from", "seq_to", "started_at", "ended_at", "exit_code", "status", "reason", "log_file", "requeued_from", "pid", "pid_start", "bin"]);
      // RLM-398: access requests and where they are on (off everywhere: no rows).
      assert.deepEqual(columns("access_requests"), ["id", "name", "page", "secret_hash", "status", "addr", "host", "user_agent", "verified_login", "ts_device", "device_id", "created_at", "decided_at"]);
      assert.deepEqual(columns("access_settings"), ["scope", "scope_id", "requests"]);
      assert.equal(db.prepare("SELECT COUNT(*) AS n FROM access_settings").get()?.n, 0);
    } finally {
      hub.close();
    }
    // A 0.10.4 CLI sharing the migrated hub.db closes the main copy: it writes closed_at only. By id:
    // the fixture's paths keep their `/` separators after the rewrite, so a joined path misses on Windows.
    const shared = new DatabaseSync(file);
    try {
      assert.equal(Number(shared.prepare("UPDATE artifacts SET closed_at = 1 WHERE id = ? AND archived_at IS NULL").run("e050da28afb0").changes), 1);
    } finally {
      shared.close();
    }
    const again = await Hub.open(file);
    try {
      assert.deepEqual(again.list(), [], "closed under 0.10.4 after the migration: archived on the next open");
      assert.deepEqual(again.list({ archived: true }).map((p) => p.copies.map((c) => c.label).sort()), [["feat", "main"]]);
    } finally {
      again.close();
    }
  } finally {
    // Windows may still hold hub.db's WAL files for a moment: a failed cleanup must not hide the test's own error.
    try {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
    } catch (err) {
      if (process.platform !== "win32") throw err;
    }
  }
});

test("a 0.10.4 page ended but not closed, with an unread note: listed, not archived, and the note reaches the next poll", async () => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "austere-migrate-ended-")));
  const { main, wt } = shopWithWorktree(dir);
  for (const f of [path.join(main, "docs", "plan.html"), path.join(wt, "docs", "plan.html")]) fs.copyFileSync(FILE, f);
  fs.copyFileSync(path.join(import.meta.dirname, "fixtures", "hub-0.10.4.db"), path.join(dir, "hub.db"));
  try {
    // In 0.10.4 terms: the feat copy's review was ended (Send & End) and never closed, and its note is unread.
    const old = new DatabaseSync(path.join(dir, "hub.db"));
    old.prepare("UPDATE artifacts SET file = replace(file, '/FIXTURE', ?), project = replace(project, '/FIXTURE', ?)").run(dir, dir);
    const feat = old.prepare("SELECT id FROM artifacts WHERE file LIKE '%shop-feat%'").get() as { id: string };
    old.prepare("UPDATE artifacts SET ended_at = 1, closed_at = NULL, acked_seq = 0 WHERE id = ?").run(feat.id);
    old.close();

    const store = await SessionStore.open(dir);
    try {
      const hub = new Hub(store.db);
      assert.deepEqual(hub.list().map((p) => p.copies.map((c) => c.label).sort()), [["feat", "main"]], "ended is not archived: both copies are listed");
      assert.ok(hub.notes({ status: "unanswered" }).some((n) => n.text === "on feat"));
      const s = store.get(feat.id);
      assert.ok(s, "the copy is a review page");
      assert.deepEqual(store.after(s, s.ackedSeq).flatMap((e) => e.items.map((it) => it.text ?? it.note)), ["on feat"], "the next poll gets the unread note");
    } finally {
      store.close();
    }
  } finally {
    try {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
    } catch (err) {
      if (process.platform !== "win32") throw err;
    }
  }
});

test("a 0.10.4 hub.db whose folders are gone: its roots are kept as git roots, and a re-key leaves the pages in their projects", async () => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "austere-migrate-gone-")));
  const file = path.join(dir, "hub.db");
  fs.copyFileSync(path.join(import.meta.dirname, "fixtures", "hub-0.10.4.db"), file);
  try {
    // The fixture's folders are pointed at this temp dir, where they were never made.
    const old = new DatabaseSync(file);
    old.prepare("UPDATE artifacts SET file = replace(file, '/FIXTURE', ?), project = replace(project, '/FIXTURE', ?)").run(dir, dir);
    old.close();
    const hub = await Hub.open(file);
    try {
      const shape = () => listProjects(hub.db).map((p) => [p.name, p.pages, p.roots.map((r) => `${path.relative(dir, r.root)} (${r.kind})`)]);
      assert.deepEqual(shape(), [["shop", 2, ["shop (git)"]], ["shop-feat", 1, ["shop-feat (git)"]]]);
      // A page in the folder above: a guessed root there takes in guessed roots below it, never these.
      fs.writeFileSync(path.join(dir, "readme.html"), "<title>r</title>");
      hub.register({ id: "dddddddddddd", file: path.join(dir, "readme.html") });
      assert.deepEqual(shape().filter((p) => p[0] !== path.basename(dir)), [["shop", 2, ["shop (git)"]], ["shop-feat", 1, ["shop-feat (git)"]]]);
      // The review's repro: a merge re-keys every page of both projects.
      mergeProjects(hub.db, "shop", "shop-feat");
      assert.deepEqual(shape().filter((p) => p[0] !== path.basename(dir)), [["shop", 2, ["shop (git)", "shop-feat (git)"]]]);
      assert.deepEqual(hub.list({ all: true }).filter((p) => p.project === "shop").map((p) => [p.rel_path, p.copies.length]).sort(), [["docs/checked.html", 1], ["docs/plan.html", 2]]);
    } finally {
      hub.close();
    }
  } finally {
    try {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
    } catch (err) {
      if (process.platform !== "win32") throw err;
    }
  }
});

test("project add and forget-root say what they did: needs --yes lists what a root would take in; forget-root names where pages went", async () => {
  const state = fs.mkdtempSync(path.join(os.tmpdir(), "austere-project-cli-state-"));
  const work = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "austere-project-cli-work-")));
  const env = { ...ENV, AUSTERE_AXI_STATE_DIR: state, AUSTERE_AXI_PORT: String(await freePort()) };
  try {
    const notes = path.join(work, "notes");
    const shop = path.join(work, "shop");
    fs.mkdirSync(path.join(shop, ".git"), { recursive: true });
    const hub = await Hub.open(path.join(state, "hub.db"));
    try {
      for (const [id, f] of [["aaaaaaaaaaaa", path.join(notes, "a", "x.html")], ["bbbbbbbbbbbb", path.join(notes, "b", "x.html")], ["cccccccccccc", path.join(shop, "x.html")]]) {
        fs.mkdirSync(path.dirname(f), { recursive: true });
        fs.writeFileSync(f, "<title>x</title>");
        hub.register({ id, file: f });
      }
    } finally {
      hub.close();
    }
    const asked = await cliWith(env, "project", "add", notes);
    assert.equal(asked.code, 1, asked.out);
    assert.match(asked.out, /status: needs --yes/);
    assert.match(asked.out, /project: a\b[\s\S]*project: b\b/, "names each project it would take in");
    assert.match(asked.out, /Nothing changed/);
    const added = await cliWith(env, "project", "add", notes, "--yes");
    assert.equal(added.code, 0, added.out);
    assert.match(added.out, /status: added[\s\S]*absorbed/);

    const forgot = await cliWith(env, "project", "forget-root", shop);
    assert.equal(forgot.code, 0, forgot.out);
    assert.match(forgot.out, /status: found again/);
    assert.match(forgot.out, /went/);
    assert.match(forgot.out, /has a \.git, so it is a root again at once/);

    const empty = await cliWith(env, "project", "rename", "notes", "");
    assert.equal(empty.code, 1, empty.out);
    assert.match(empty.out, /cannot be empty/);
  } finally {
    fs.rmSync(state, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
    fs.rmSync(work, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  }
});

test("a 0.11.0 hub.db opens: a review closed under 0.11.0 is archived once", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "austere-migrate-closed-"));
  const file = path.join(dir, "hub.db");
  try {
    // 0.11.0 already has archived_at, so the column check no longer copies closed_at.
    const db = await openDatabase(file);
    const insert = db.prepare("INSERT INTO artifacts (id, file, project, created_at, updated_at, reviewed, closed_at, archived_at) VALUES (?, ?, '', 1, 1, 1, ?, ?)");
    insert.run("closed", "/x/closed.html", 5, null);
    insert.run("both", "/x/both.html", 6, 7);
    insert.run("open", "/x/open.html", null, null);
    db.close();

    const hub = await Hub.open(file);
    try {
      const rows = hub.db.prepare("SELECT id, closed_at, archived_at FROM artifacts ORDER BY id").all();
      assert.deepEqual(
        rows.map((r) => [r.id, r.closed_at, r.archived_at]),
        [["both", null, 7], ["closed", null, 5], ["open", null, null]],
      );
    } finally {
      hub.close();
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  }
});

test("hub list on a state dir a server of another version holds: hub.db is left as it is, and the output says why", async () => {
  const state = fs.mkdtempSync(path.join(os.tmpdir(), "austere-otherversion-"));
  const file = path.join(state, "hub.db");
  const port = await freePort();
  const env = { ...ENV, AUSTERE_AXI_STATE_DIR: state, AUSTERE_AXI_PORT: String(port) };
  // This test process stands in for the holder: a live pid, a fresh lock, another version.
  const holdAs = (version: string) => fs.writeFileSync(path.join(state, "server.lock"), JSON.stringify({ pid: process.pid, port, at: Date.now(), version }));
  // A read-only reader of a WAL database may leave empty -wal/-shm files beside it, as the holder does; hub.db is what must not change.
  const snapshot = () => fs.readFileSync(file).toString("base64");
  try {
    // A 0.10.4 database: this build could only read it after migrating it.
    fs.copyFileSync(path.join(import.meta.dirname, "fixtures", "hub-0.10.4.db"), file);
    holdAs("0.0.1");
    const before = snapshot();
    const list = await cliWith(env, "hub", "list");
    assert.equal(list.code, 1, list.out);
    assert.match(list.out, new RegExp(`in use by austere-axi v0\\.0\\.1 \\(pid ${process.pid}, port ${port}\\)`));
    assert.match(list.out, /older than this build's .* after a migration/);
    const add = await cliWith(env, "project", "add", WORK);
    assert.equal(add.code, 1, add.out);
    assert.match(add.out, /in use by austere-axi v0\.0\.1/);
    assert.deepEqual(snapshot(), before, "neither command touched hub.db");

    // At this build's schema it is read as it is: recorded, or a 0.12.0 database that predates the record.
    fs.rmSync(path.join(state, "server.lock"));
    (await Hub.open(file)).close();
    for (const recorded of [true, false]) {
      if (!recorded) {
        const db = new DatabaseSync(file);
        assert.equal(db.prepare("PRAGMA user_version").get()?.user_version, SCHEMA_VERSION, "migrate() records the schema version");
        db.exec("PRAGMA user_version = 0");
        db.close();
      }
      holdAs("0.0.1");
      const current = snapshot();
      const readable = await cliWith(env, "hub", "list", "--all");
      assert.equal(readable.code, 0, readable.out);
      assert.match(readable.out, /plan\.html/);
      assert.deepEqual(snapshot(), current, "read-only");
    }
  } finally {
    try {
      fs.rmSync(state, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
    } catch (err) {
      if (process.platform !== "win32") throw err;
    }
  }
});
