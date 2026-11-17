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
import { shellInbox, shellPages, shellProjects } from "../src/cli/hub-api.ts";
import type { InboxResponse, PagesResponse, ProjectsResponse, SettingsResponse, ShellPage } from "../src/shared/hub-api.ts";
import { findProject, listProjects, mergeProjects } from "../src/cli/projects.ts";
import { claimLink, ownerHeaders } from "./owner.ts";
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

/** The shell's page list (GET /hub/api/pages, `view` open by default) as the owner of `state`. */
async function hubPages(port = PORT, state = STATE, view = "open"): Promise<ShellPage[]> {
  const r = await req("GET", `/hub/api/pages?view=${view}`, undefined, port, state);
  assert.equal(r.status, 200, r.data);
  return (JSON.parse(r.data) as PagesResponse).pages;
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
  const home = await req("GET", "/");
  assert.equal(home.status, 200);
  assert.match(home.data, /<title>austere-axi hub<\/title>/);
  assert.match(home.data, /\/__austere\/chrome\/shell\.js/, "the shell, a client app over /hub/api");
  let [page] = await hubPages();
  assert.equal(page.project, "shop");
  assert.equal(page.title, "Checkout plan");
  assert.equal(page.rel_path, "docs/plan.html");
  assert.equal(page.group, "quiet", "a quiet page asks for nothing");
  assert.equal(page.copies[0].listening, false);

  // Opening from the hub goes to the review.
  const id = page.open_id;
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
  [page] = await hubPages();
  assert.equal(page.unanswered, 1);
  assert.equal(page.group, "waiting_on_agent");
  assert.equal(page.taker, "nobody", "no agent listens and none is attached");

  r = await cli("feedback", FILE);
  assert.match(r.out, /status: feedback/);
  assert.match(r.out, /annotation: intro \(TextContent\)/);
  assert.match(r.out, /note: say more/);
  assert.equal((await hubPages())[0].unanswered, 1, "received is still unanswered");
  // Received, so the next poll does not repeat it.
  const poll = JSON.parse((await req("POST", "/api/poll", { file: FILE, timeoutMs: 200 })).data) as Poll;
  assert.notEqual(poll.status, "feedback");

  r = await cli("reply", FILE, "--agent-reply", "Expanded the intro");
  assert.match(r.out, /replied/);
  r = await cli("feedback", FILE);
  assert.match(r.out, /status: none/);
  [page] = await hubPages();
  assert.equal(page.addressed, 1);
  assert.equal(page.unanswered, 0);
  assert.equal(page.group, "quiet");

  // While a poll waits on the page, its copy says an agent is listening; once it ends, the page is quiet again.
  const waiting = req("POST", "/api/poll", { file: FILE, timeoutMs: 1500 });
  await new Promise((res) => setTimeout(res, 300));
  assert.equal((await hubPages())[0].copies[0].listening, true);
  await waiting;
  assert.equal((await hubPages())[0].copies[0].listening, false);

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
  const listed = async (view = "open"): Promise<string[]> => (await hubPages(port, state, view)).map((p) => path.basename(p.rel_path));
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
    assert.deepEqual(await listed(), ["gone.html"]);
    assert.deepEqual(await listed("archived"), ["keep.html"]);

    fs.rmSync(gone);
    r = await cliWith(env, "hub", "list");
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /gone\.html/);
    assert.match(r.out, /state: missing/);
    assert.equal((await hubPages(port, state)).find((p) => p.rel_path.endsWith("gone.html"))?.copies[0].missing, true);
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
    const files = async (): Promise<string[]> => (await hubPages(port, state)).map((p) => path.basename(p.copies[0].file));
    const id = (await hubPages(port, state))[0].open_id;
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
    // The Notes view links to it.
    const notes = JSON.parse((await call("GET", "/hub/api/notes")).data) as { notes: { artifact_id: string; text: string }[] };
    assert.deepEqual(notes.notes.map((n) => [n.artifact_id, n.text]), [[id, "<b>shorten</b> the intro"]], "JSON: the shell sets it as text");

    // Only the owner's own page posts here: not another site, and a copy the hub does not know is a 404.
    assert.equal((await call("POST", `/hub/archive/${id}`, {}, { origin: "https://evil.example" })).status, 403);
    assert.equal((await call("POST", "/hub/archive/000000000000", {})).status, 404);
    assert.deepEqual(await files(), ["gone.html"], "listed until archived");

    const done = await call("POST", `/hub/archive/${id}`, {});
    assert.equal(done.status, 303);
    assert.equal(done.headers.location, "/");
    assert.deepEqual(await files(), [], "archived: out of the list");
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

    const shell = shellPages(hub, {}, () => false);
    assert.deepEqual(shell.map((p) => p.rel_path), ["docs/plan.html", "docs/other.html"], "unanswered first, then by last activity");
    const row = shell[0];
    // Both copies have unanswered notes, so their order falls to last activity, which can tie within a millisecond.
    assert.deepEqual(row.copies.map((c) => [c.label, c.unanswered, c.held]).sort(), [["feat", 2, 1], ["main", 1, 0]], "a chip per copy, with its own counts");
    assert.equal(row.unanswered, 3);
    assert.equal(row.group, "needs_you", "a note held for the owner needs the owner");
    assert.equal(row.taker, "nobody");
    assert.equal(shellProjects(hub, () => false)[0].roots.join("\n"), `${main}\n${wt}`, "roots, main first");
  } finally {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  }
});

test("a page in 30 worktrees: chips with unanswered notes first, then one an agent listens on, then the newest", async () => {
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
    const listening = new Set([ids[10]]);
    const [page] = shellPages(hub, {}, (id) => listening.has(id));
    const order = page.copies.map((c) => ids.indexOf(c.id));
    assert.equal(order.length, 30, "every copy is still reachable");
    assert.deepEqual(order.slice(0, 2).sort(), [3, 5], "the copies with unanswered notes come first");
    assert.equal(order[2], 10, "then the one an agent listens on");
    assert.equal(order[3], 29, "then the newest");
    assert.equal(page.copies[3].label, branch(29), "the full label: the shell shortens it");
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
    const titleLink = (): string => shellPages(hub, {}, () => false)[0].open_id;
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
      const [page] = shellPages(hub, {}, () => false);
      assert.equal(page.open_id, sessionId(b), "the row opens the copy that stays");
      const [all] = shellPages(hub, { view: "all" }, () => false);
      assert.deepEqual(all.copies.map((c) => [c.label, c.unanswered, c.archived, c.checked]).sort(), [["feat", 1, false, false], ["fix", 0, false, true], ["main", 3, true, false]], "every copy, the archived one and the checked one marked");
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

test("shell pages: each view lists what it counts; a copy says checked, archived, missing or listening", async () => {
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
    const titles = (view: "open" | "all" | "archived", listening = new Set<string>()): string[] =>
      shellPages(hub, { view }, (id) => listening.has(id)).map((p) => `${path.basename(p.rel_path, ".html")}${p.copies.map((c) => [c.checked ? " checked" : "", c.archived ? " archived" : "", c.listening ? " listening" : ""].join("")).join("")}`);
    // Only checked pages: none open, all three under Everything.
    for (const [id, name] of [["aaaaaaaaaaaa", "lint-run"], ["bbbbbbbbbbbb", "type-run"], ["cccccccccccc", "test-run"]]) hub.register({ id, file: file(name) });
    assert.deepEqual(titles("open"), []);
    assert.deepEqual({ ...hub.viewCounts() }, { open: 0, everything: 3, archived: 0, checked: 3 });
    assert.deepEqual(titles("all").sort(), ["lint-run checked", "test-run checked", "type-run checked"]);

    // One page opened for review with an unanswered note, one archived.
    const open = store.ensure(file("plan"));
    store.addUserBatch(open, [{ kind: "message", text: "say more" }]);
    const gone = store.ensure(file("old-plan"));
    assert.ok(hub.setArchived(gone.id, Date.now()));
    assert.deepEqual(titles("open"), ["plan"]);
    assert.deepEqual(titles("archived"), ["old-plan archived"]);
    assert.deepEqual({ ...hub.viewCounts() }, { open: 1, everything: 5, archived: 1, checked: 3 });
    assert.deepEqual(titles("open", new Set([open.id])), ["plan listening"]);
    assert.deepEqual(titles("archived", new Set([gone.id])), ["old-plan archived"], "an archived copy takes no notes: nobody listens to it");
    fs.rmSync(open.file);
    assert.equal(shellPages(hub, {}, () => false)[0].copies[0].missing, true);
  } finally {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  }
});

/** A revision row as recordRevision writes it, at `at`. */
function addRevision(db: DatabaseSync, artifactId: string, rev: number, at: number): void {
  db.prepare("INSERT INTO revisions (artifact_id, rev, at, source, program, program_sha) VALUES (?, ?, ?, 'patch', '', '')").run(artifactId, rev, at);
}

test("inbox: needs you (changed since you looked, held notes, a failed run), waiting on agent (who takes them), quiet; newest activity first", async () => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "austere-inbox-")));
  fs.mkdirSync(path.join(dir, "shop", ".git"), { recursive: true });
  const store = await SessionStore.open(fs.mkdtempSync(path.join(dir, "state-")));
  try {
    const times = new Map<string, number>();
    const page = (name: string, at: number) => {
      const f = path.join(dir, "shop", `${name}.html`);
      fs.writeFileSync(f, fs.readFileSync(FILE, "utf8").replace("Checkout plan", name));
      const s = store.ensure(f);
      times.set(s.id, at);
      return s;
    };
    const t = 1_000_000_000;
    // Changed overnight: the owner saw revision 1, the agent made 2 and 3, the last one newest of all.
    const overnight = page("overnight", t);
    for (const [rev, at] of [[1, t], [2, t + 10], [3, t + 9_000]]) addRevision(store.db, overnight.id, rev, at);
    store.db.prepare("UPDATE artifacts SET last_viewed_rev = 1 WHERE id = ?").run(overnight.id);
    // Never opened in a browser: three revisions, but nothing "since you looked".
    const unseen = page("unseen", t + 50);
    for (const rev of [1, 2, 3]) addRevision(store.db, unseen.id, rev, t + 50);
    const held = page("held", t + 100);
    store.addUserBatch(held, [{ kind: "message", text: "from Ana" }], { author: "Ana", hold: true });
    const failed = page("failed", t + 200);
    const ran = page("ran-again", t + 210);
    const run = store.db.prepare("INSERT INTO runs (id, kind, artifact_id, status, reason, ended_at) VALUES (?, 'note', ?, ?, ?, ?)");
    run.run("r1", failed.id, "failed", "timeout", t + 300);
    run.run("r2", ran.id, "failed", "exit", t + 300);
    run.run("r3", ran.id, "done", null, t + 400);
    const nobody = page("nobody", t + 500);
    const listened = page("listened", t + 600);
    const attached = page("attached", t + 700);
    for (const s of [nobody, listened, attached]) {
      for (const [i, text] of ["one", "two", "three", "four"].entries()) store.addUserBatch(s, [{ kind: "message", text }], { at: t + 800 + i });
    }
    const pageId = store.db.prepare("SELECT page_id FROM artifacts WHERE id = ?").get(attached.id)?.page_id;
    store.db.prepare("INSERT INTO attach_settings (scope, scope_id, state) VALUES ('page', ?, 'on')").run(String(pageId));
    page("quiet", t + 1_000);
    // Last activity as set above: a note sent just now must not reorder the pages.
    for (const [id, at] of times) store.db.prepare("UPDATE artifacts SET updated_at = ? WHERE id = ?").run(at, id);

    const hub = new Hub(store.db);
    const inbox = shellInbox(hub, {}, (id) => id === listened.id);
    const names = (list: InboxResponse["quiet"]): string[] => list.map((p) => path.basename(p.rel_path, ".html"));
    assert.deepEqual(names(inbox.needs_you), ["overnight", "failed", "held"], "the page changed overnight first");
    assert.deepEqual(names(inbox.waiting_on_agent), ["attached", "listened", "nobody"]);
    assert.deepEqual(names(inbox.quiet), ["quiet", "ran-again", "unseen"]);
    const [top] = inbox.needs_you;
    assert.deepEqual([top.changed, top.copies[0].rev, top.copies[0].viewed_rev], [2, 3, 1]);
    assert.equal(top.activity, t + 9_000, "a revision is activity");
    assert.equal(inbox.needs_you[2].held, 1);
    assert.deepEqual(inbox.needs_you[2].notes.map((n) => [n.text, n.author, n.status]), [["from Ana", "Ana", "held"]]);
    assert.equal(inbox.held, 1);
    assert.deepEqual(inbox.failed_runs.map((r) => [r.title, r.reason]), [["failed.html", "timeout"]], "a later run that did not fail clears it");
    assert.deepEqual(inbox.waiting_on_agent.map((p) => [p.taker, p.attach, p.unanswered, p.run_active]), [["attach_on", "on", 4, false], ["listening", "off", 4, false], ["nobody", "off", 4, false]], "attach on, no run yet: the next note starts one");
    run.run("r4", attached.id, "running", null, null);
    assert.equal(shellInbox(hub, {}, () => false).waiting_on_agent.find((p) => p.taker === "attach_on")?.run_active, true, "a run is on them");
    assert.deepEqual(inbox.waiting_on_agent[0].notes.map((n) => n.text), ["four", "three", "two"], "the newest 3 notes of a page");
    assert.equal(inbox.quiet[0].taker, null);

    // The owner looks at the page: it leaves "needs you".
    store.db.prepare("UPDATE artifacts SET last_viewed_rev = 3 WHERE id = ?").run(overnight.id);
    assert.deepEqual(names(shellInbox(hub, {}, () => false).needs_you), ["failed", "held"]);
  } finally {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  }
});

test("a hub.db of 500 pages answers pages and inbox in under 100 ms", async () => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "austere-hub-500-")));
  const store = await SessionStore.open(dir);
  try {
    const db = store.db;
    const now = Date.now();
    db.exec("BEGIN");
    for (let p = 0; p < 10; p++) {
      db.prepare("INSERT INTO projects (id, name, created_at) VALUES (?, ?, ?)").run(`proj${p}`, `project ${p}`, now);
      db.prepare("INSERT INTO project_roots (root, project_id, kind, created_at) VALUES (?, ?, 'git', ?)").run(path.join(dir, `p${p}`), `proj${p}`, now);
    }
    for (let i = 0; i < 500; i++) {
      const id = i.toString(16).padStart(12, "0");
      const project = `proj${i % 10}`;
      const root = path.join(dir, `p${i % 10}`);
      db.prepare("INSERT INTO pages (id, project_id, rel_path) VALUES (?, ?, ?)").run(`g${id}`, project, `docs/page-${i}.html`);
      db.prepare("INSERT INTO artifacts (id, file, project, title, created_at, updated_at, reviewed, project_id, root, page_id, last_viewed_rev) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?)").run(
        id, path.join(root, "docs", `page-${i}.html`), root, `Page ${i}`, now, now - i * 1000, project, root, `g${id}`, i % 3 === 0 ? 1 : 0,
      );
      for (let rev = 1; rev <= 3; rev++) addRevision(db, id, rev, now - i * 1000 + rev);
      for (let n = 0; n < 2; n++) {
        db.prepare("INSERT INTO items (id, artifact_id, entry_id, at, kind, text, status, data) VALUES (?, ?, ?, ?, 'message', ?, ?, '{}')").run(`${id}-${n}`, id, `e${id}-${n}`, now - n, `note ${n}`, i % 4 === 0 ? "open" : "addressed");
      }
    }
    db.exec("COMMIT");
    const hub = new Hub(db);
    const fastest = (fn: () => unknown): number => {
      let best = Infinity;
      for (let i = 0; i < 3; i++) {
        const start = performance.now();
        fn();
        best = Math.min(best, performance.now() - start);
      }
      return best;
    };
    assert.equal(shellPages(hub, {}, () => false).length, 500);
    const inbox = shellInbox(hub, {}, () => false);
    assert.equal(inbox.needs_you.length + inbox.waiting_on_agent.length + inbox.quiet.length, 500);
    const pagesMs = fastest(() => shellPages(hub, {}, () => false));
    const inboxMs = fastest(() => shellInbox(hub, {}, () => false));
    assert.ok(pagesMs < 100, `pages took ${pagesMs.toFixed(1)} ms`);
    assert.ok(inboxMs < 100, `inbox took ${inboxMs.toFixed(1)} ms`);
  } finally {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  }
});

test("/hub/api: the owner's only (403 without the cookie, also from loopback, and with a reviewer's); no other site; shapes; archive and unarchive", async () => {
  const port = await freePort();
  const state = fs.mkdtempSync(path.join(os.tmpdir(), "austere-hub-api-"));
  // A share link needs an address to name: loopback, as for a test.
  const env = { ...ENV, AUSTERE_AXI_STATE_DIR: state, AUSTERE_AXI_PORT: String(port), AUSTERE_AXI_LINK_HOST: "127.0.0.1" };
  const work = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "austere-hub-api-work-")));
  fs.mkdirSync(path.join(work, ".git"));
  const file = path.join(work, "plan.html");
  fs.copyFileSync(FILE, file);
  const two = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "austere-hub-api-two-")));
  const call = (method: string, route: string, extra: Record<string, string> = {}, body: unknown = undefined) => req(method, route, body, port, state, extra);
  try {
    assert.equal((await cliWith(env, file)).code, 0);
    const [page] = await hubPages(port, state);
    const id = page.open_id;
    await call("POST", `/s/${id}/send`, {}, { items: [{ kind: "annotation", target: "intro", component: "TextContent", note: "say more" }] });
    const reads = ["/hub/api/projects", "/hub/api/pages", "/hub/api/pages?view=all", "/hub/api/inbox", "/hub/api/search?q=hello", `/hub/api/page/${id}`, "/hub/api/notes", "/hub/api/runs"];
    const writes = [`/hub/api/page/${id}/archive`, `/hub/api/page/${id}/unarchive`];

    // Loopback is not the owner: no cookie, no data.
    const nobody = { cookie: "", "x-austere-key": "" };
    for (const route of reads) assert.equal((await call("GET", route, nobody)).status, 403, route);
    for (const route of writes) assert.equal((await call("POST", route, nobody, {})).status, 403, route);
    assert.equal((await call("GET", "/", nobody)).status, 403, "the shell itself");
    // A reviewer's device is not the owner either.
    const shared = JSON.parse((await call("POST", "/api/share", {}, { file, name: "Ana" })).data) as { link: string };
    const ana = { cookie: await claimLink(port, shared.link), "x-austere-key": "" };
    assert.equal((await call("GET", `/s/${id}`, ana)).status, 200, "the reviewer reaches the page");
    for (const route of [...reads, "/"]) assert.equal((await call("GET", route, ana)).status, 403, route);
    for (const route of writes) assert.equal((await call("POST", route, { ...ana, origin: `http://127.0.0.1:${port}` }, {})).status, 403, route);
    // The owner's browser on another site's page: refused, GET included.
    for (const route of reads) assert.equal((await call("GET", route, { origin: "https://evil.example" })).status, 403, route);
    assert.equal((await call("POST", writes[0], { origin: "https://evil.example" }, {})).status, 403);
    assert.equal((await call("GET", "/hub/api/pages", { host: "evil.example" })).status, 403, "Host allowlist");
    assert.equal((await call("GET", "/hub/api/nothing")).status, 404);
    assert.equal((await call("POST", "/hub/api/pages", {}, {})).status, 405);

    // Shapes, as the owner.
    const json = async <T>(route: string): Promise<T> => {
      const r = await call("GET", route);
      assert.equal(r.status, 200, `${route}: ${r.data}`);
      return JSON.parse(r.data) as T;
    };
    const projects = await json<{ projects: { name: string; pages: number; unanswered: number; needs_you: number; roots: string[]; same_as: null }[] }>("/hub/api/projects");
    assert.deepEqual(projects.projects.map((p) => [p.name, p.pages, p.unanswered, p.needs_you, p.roots, p.same_as]), [[path.basename(work), 1, 1, 0, [work], null]]);
    const inbox = await json<InboxResponse>("/hub/api/inbox");
    assert.deepEqual([inbox.needs_you.length, inbox.waiting_on_agent.length, inbox.quiet.length], [0, 1, 0]);
    assert.deepEqual(inbox.waiting_on_agent[0].notes.map((n) => [n.target, n.text]), [["intro", "say more"]]);
    const search = await json<{ pages: ShellPage[]; parts: { artifact_id: string; statement: string }[] }>("/hub/api/search?q=hello");
    assert.deepEqual(search.parts.map((p) => [p.artifact_id, p.statement]), [[id, "intro"]], "a part found by its text");
    assert.deepEqual((await json<{ pages: ShellPage[] }>("/hub/api/search?q=Checkout")).pages.map((p) => p.open_id), [id], "a page found by its title");
    const summary = await json<{ id: string; title: string; rel_path: string; project: { name: string }; copies: { id: string }[]; unanswered: number; attach: string }>(`/hub/api/page/${id}`);
    assert.deepEqual([summary.id, summary.title, summary.rel_path, summary.project.name, summary.copies.map((c) => c.id), summary.unanswered, summary.attach], [id, "Checkout plan", "plan.html", path.basename(work), [id], 1, "off"]);
    assert.equal((await call("GET", "/hub/api/page/000000000000")).status, 404);
    assert.deepEqual((await json<{ runs: unknown[] }>("/hub/api/runs")).runs, []);
    assert.equal((await json<{ notes: unknown[] }>("/hub/api/notes?status=answered")).notes.length, 0);
    const open = await call("GET", `/hub/open/${id}?part=intro&attach=1`);
    assert.equal(open.headers.location, `/s/${id}#part=intro&attach=1`, "a search hit opens the page at its part");
    assert.equal((await call("GET", `/hub/open/${id}?part=${encodeURIComponent("a b<")}`)).headers.location, `/s/${id}`, "a part that is no statement name is dropped");
    const notes = await call("GET", "/notes?device=d0000000000&status=unanswered");
    assert.equal(notes.status, 302);
    assert.equal(notes.headers.location, "/?device=d0000000000&status=unanswered&view=notes", "the old Notes view's links keep their filters");

    // Archive from the shell: out of the list; Unarchive brings it back.
    const done = await call("POST", writes[0], { origin: `http://127.0.0.1:${port}` }, {});
    assert.deepEqual(JSON.parse(done.data), { ok: true, ids: [id] });
    assert.deepEqual(await hubPages(port, state), []);
    assert.deepEqual((await hubPages(port, state, "archived")).map((p) => p.open_id), [id]);
    assert.equal((await call("POST", `/s/${id}/send`, {}, { items: [{ kind: "message", text: "late" }] })).status, 409, "an archived page takes no notes");
    assert.deepEqual(JSON.parse((await call("POST", writes[1], {}, {})).data), { ok: true, ids: [id] });
    assert.deepEqual((await hubPages(port, state)).map((p) => p.open_id), [id]);
    assert.equal((await call("POST", "/hub/api/page/000000000000/archive", {}, {})).status, 404);

    // Undo reverses exactly what the action changed: a copy the owner archived before stays archived.
    const { main, wt } = shopWithWorktree(two);
    const [a, b] = [path.join(main, "docs", "plan.html"), path.join(wt, "docs", "plan.html")];
    for (const f of [a, b]) {
      fs.copyFileSync(FILE, f);
      assert.equal((await cliWith(env, f)).code, 0);
    }
    const [ida, idb] = [sessionId(a), sessionId(b)];
    assert.deepEqual(JSON.parse((await call("POST", `/hub/api/page/${ida}/archive`, {}, { ids: [ida] })).data), { ok: true, ids: [ida] }, "the copy on main, on purpose");
    const row = (await hubPages(port, state)).find((p) => p.rel_path === "docs/plan.html");
    assert.deepEqual(row?.copies.map((c) => c.id), [idb], "the row shows the copy that is open");
    const archived = JSON.parse((await call("POST", `/hub/api/page/${idb}/archive`, {}, {})).data) as { ids: string[] };
    assert.deepEqual(archived.ids, [idb], "Archive on the row: the open copy");
    assert.deepEqual(JSON.parse((await call("POST", `/hub/api/page/${idb}/unarchive`, {}, { ids: archived.ids })).data), { ok: true, ids: [idb] }, "Undo");
    assert.deepEqual((await hubPages(port, state, "archived")).find((p) => p.rel_path === "docs/plan.html")?.copies.map((c) => c.id), [ida], "main stays archived");
    // Another tab archives the row's copy (ids of another page are ignored), then the row's Archive arrives:
    // it returns no copy it did not change, so its Undo cannot open one.
    assert.deepEqual(JSON.parse((await call("POST", `/hub/api/page/${idb}/archive`, {}, { ids: [id, idb] })).data).ids, [idb], "ids of another page are ignored");
    assert.deepEqual(JSON.parse((await call("POST", `/hub/api/page/${idb}/archive`, {}, {})).data).ids, [], "nothing left open to archive");
    assert.deepEqual(JSON.parse((await call("POST", `/hub/api/page/${idb}/unarchive`, {}, { ids: [idb] })).data).ids, [idb]);
    assert.deepEqual(JSON.parse((await call("POST", `/hub/api/page/${idb}/unarchive`, {}, { ids: [idb] })).data).ids, [], "already open: unchanged");
  } finally {
    await cliWith(env, "stop");
    fs.rmSync(state, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
    fs.rmSync(work, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
    fs.rmSync(two, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  }
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
      assert.deepEqual(columns("runs"), ["id", "kind", "artifact_id", "project_id", "agent_session_id", "harness", "mode", "model", "seq_from", "seq_to", "started_at", "ended_at", "exit_code", "status", "reason", "log_file", "requeued_from", "pid", "pid_start", "bin", "trigger_id"]);
      // RLM-360: what a trigger last saw.
      assert.deepEqual(columns("trigger_state"), ["trigger_id", "last_cursor", "last_run_at"]);
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

test("/hub/api/settings (RLM-396): the owner's only; network, defaults, about; the default for notes; project commands as the CLI does them", async () => {
  const port = await freePort();
  const state = fs.mkdtempSync(path.join(os.tmpdir(), "austere-hub-settings-"));
  const env = { ...ENV, AUSTERE_AXI_STATE_DIR: state, AUSTERE_AXI_PORT: String(port), AUSTERE_AXI_LINK_HOST: "127.0.0.1" };
  const work = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "austere-hub-settings-work-")));
  const call = (method: string, route: string, extra: Record<string, string> = {}, body: unknown = undefined) => req(method, route, body, port, state, extra);
  const json = async <T>(method: string, route: string, body: unknown = undefined, extra: Record<string, string> = {}): Promise<T> => {
    const r = await call(method, route, extra, body);
    assert.equal(r.status, 200, `${method} ${route}: ${r.data}`);
    return JSON.parse(r.data) as T;
  };
  const same = { origin: `http://127.0.0.1:${port}` };
  // Two repositories, a page in each.
  const pageIn = (name: string): string => {
    fs.mkdirSync(path.join(work, name, ".git"), { recursive: true });
    const file = path.join(work, name, "plan.html");
    fs.copyFileSync(FILE, file);
    return file;
  };
  const [shopFile, cartFile] = [pageIn("shop"), pageIn("cart")];
  try {
    for (const f of [shopFile, cartFile]) assert.equal((await cliWith(env, f)).code, 0);

    // The owner's only: no cookie, a reviewer, another site.
    const writes = ["/hub/api/settings/review", "/hub/api/people/share", "/hub/api/projects/archive-missing"];
    const nobody = { cookie: "", "x-austere-key": "" };
    assert.equal((await call("GET", "/hub/api/settings", nobody)).status, 403);
    for (const route of writes) assert.equal((await call("POST", route, { ...nobody, ...same }, { auto: true })).status, 403, route);
    const shared = JSON.parse((await call("POST", "/api/share", {}, { file: shopFile, name: "Ana" })).data) as { link: string };
    const ana = { cookie: await claimLink(port, shared.link), "x-austere-key": "" };
    assert.equal((await call("GET", "/hub/api/settings", ana)).status, 403);
    for (const route of writes) assert.equal((await call("POST", route, { ...ana, ...same }, { auto: true })).status, 403, route);
    assert.equal((await call("GET", "/hub/api/settings", { origin: "https://evil.example" })).status, 403);
    for (const route of writes) assert.equal((await call("POST", route, { origin: "https://evil.example" }, { auto: true })).status, 403, route);

    // A newer CLI than the server says so in About.
    assert.equal((await call("GET", "/api/sessions", { "x-austere-cli": "99.0.0" })).status, 200);
    const s = await json<SettingsResponse>("GET", "/hub/api/settings");
    assert.deepEqual(s.network.addresses.map((a) => [a.kind, a.url]), [["this_computer", `http://127.0.0.1:${port}`]]);
    assert.deepEqual(s.network.share, { url: `http://127.0.0.1:${port}`, from: "link_host" });
    assert.equal(s.network.tailscale, null);
    assert.deepEqual(s.network.always_on, { mode: "kept_on", supervisor: null, unit: null, idle_minutes: null }, "AUSTERE_AXI_PERSIST");
    assert.deepEqual([s.review.auto, s.missing, s.gone_folders], [false, 0, []]);
    assert.deepEqual(s.about, { version: JSON.parse(fs.readFileSync("package.json", "utf8")).version, state_dir: state, newer_cli: "99.0.0" });

    // The default for a new reviewer's notes: a share or an approval that does not say takes it; one that does keeps its own.
    assert.deepEqual(await json("POST", "/hub/api/settings/review", { auto: true }, same), { ok: true, message: "New reviewers' notes go straight to the agent." });
    assert.equal((await call("POST", "/hub/api/settings/review", same, { auto: "yes" })).status, 400);
    assert.match((await cliWith(env, "share", "default")).out, /auto: a new reviewer's notes go straight to the agent/);
    assert.equal(JSON.parse((await call("POST", "/api/share", {}, { file: shopFile, name: "Bo" })).data).auto, true);
    assert.equal(JSON.parse((await call("POST", "/api/share", {}, { file: shopFile, name: "Cy", auto: false })).data).auto, false);
    const held = await cliWith(env, "share", shopFile, "--as", "Di", "--hold");
    assert.match(held.out, /mode: "hold:/, held.out);
    assert.equal((await cliWith(env, "share", "default", "hold")).code, 0);
    assert.equal((await json<SettingsResponse>("GET", "/hub/api/settings")).review.auto, false);
    assert.equal((await cliWith(env, "share", shopFile, "--as", "Ed", "--auto", "--hold")).code, 2, "--auto and --hold exclude each other");

    // New link from Settings: a page by its id.
    const shopId = sessionId(shopFile);
    const link = await json<{ name: string; auto: boolean; reaches: string; link: string }>("POST", "/hub/api/people/share", { page: shopId, name: "Fy", scope: "page" }, same);
    assert.deepEqual([link.name, link.auto, link.reaches], ["Fy", false, shopFile]);
    assert.match(link.link, new RegExp(`^http://127\\.0\\.0\\.1:${port}/s/${shopId}\\?invite=`));
    assert.equal((await call("POST", "/hub/api/people/share", same, { page: "000000000000", name: "Gu" })).status, 404);

    // Projects: rename, merge, forget a folder, archive missing pages.
    const projects = async () => (await json<ProjectsResponse>("GET", "/hub/api/projects")).projects;
    const byName = new Map((await projects()).map((p) => [p.name, p.id]));
    const shopPid = byName.get("shop") as string;
    const cartPid = byName.get("cart") as string;
    assert.deepEqual(await json("POST", `/hub/api/projects/${shopPid}/rename`, { name: "store" }, same), { ok: true, message: "Renamed shop to store." });
    assert.equal((await call("POST", `/hub/api/projects/${cartPid}/rename`, same, { name: "store" })).status, 400, "a name another project has");
    assert.deepEqual(await json("POST", `/hub/api/projects/${shopPid}/merge`, { from: cartPid }, same), { ok: true, message: "Merged cart into store." });
    assert.deepEqual((await projects()).map((p) => [p.name, p.roots.length]), [["store", 2]]);
    assert.equal((await call("POST", `/hub/api/projects/${shopPid}/forget-root`, same, { root: "/nowhere" })).status, 400);
    fs.rmSync(path.join(work, "cart"), { recursive: true });
    const s2 = await json<SettingsResponse>("GET", "/hub/api/settings");
    assert.deepEqual([s2.missing, s2.gone_folders], [1, [path.join(work, "cart")]]);
    assert.deepEqual(await json("POST", "/hub/api/projects/archive-missing", {}, same), { ok: true, message: "Archived 1 missing page." });
    const forgot = await json<{ message: string }>("POST", `/hub/api/projects/${shopPid}/forget-root`, { root: path.join(work, "cart"), drop: true }, same);
    assert.match(forgot.message, /^Forgot .*cart\. Its pages stay in store, archived; their notes are kept\.$/);
    assert.deepEqual((await projects()).map((p) => p.roots), [[path.join(work, "shop")]]);
    assert.equal((await call("POST", `/hub/api/projects/zzz/rename`, same, { name: "x" })).status, 404);
  } finally {
    await cliWith(env, "stop");
    fs.rmSync(state, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
    fs.rmSync(work, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  }
});
