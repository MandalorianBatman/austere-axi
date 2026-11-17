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
import { SessionStore } from "../src/cli/sessions.ts";
import { Hub, openDatabase, unanswered } from "../src/cli/hub.ts";
import { hubPage, notesPage } from "../src/cli/hub-page.ts";
import { findProject } from "../src/cli/projects.ts";
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
  assert.match(r.out, /status: open/);
  let home = (await req("GET", "/")).data;
  assert.match(home, /austere-axi hub/);
  assert.match(home, />shop</);
  assert.match(home, /Checkout plan/);
  assert.match(home, /in review/);

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

test("hub on|off|status exit 2 with a one-line hint", async () => {
  for (const sub of ["on", "off", "status"]) {
    const r = await cli("hub", sub);
    assert.equal(r.code, 2, r.out);
    assert.match(r.out, /^error: "?the hub is always on; open it with `austere-axi hub open`"?\n$/);
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
    const html = notesPage(rows, { version: "1", q: '"><b>', project: "/p/<i>", status: "all", stats: { pages: 2, projects: 2, unanswered: 2 } });
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

    const html = hubPage(pages, { version: "1", q: "", project: "", projects: hub.projects(), stats: hub.stats() });
    assert.equal(html.match(/<section>/g)?.length, 1, "one section for the project");
    assert.equal(html.match(/<li>/g)?.length, 2, "one row per page");
    assert.equal(html.match(/class="chip[ "]/g)?.length, 2, "a chip per copy; none for a page with one copy");
    assert.ok(html.includes(`href="/hub/open/${sb.id}"`), "a chip opens its copy");
    assert.match(html, />feat <span>2 unanswered<\/span>/);
    assert.match(html, /<b class="open">3 unanswered<\/b>/);
    assert.ok(html.indexOf("docs/plan.html") < html.indexOf("docs/other.html"), "unanswered first, then by last activity");
    assert.doesNotMatch(html, /<h3>/, "no per-day headings");
    assert.ok(html.includes(`title="${main}\n${wt}"`), "roots in the tooltip");

    const notesHtml = notesPage(notes, { version: "1", q: "", project: "", status: "all", stats: hub.stats() });
    assert.match(notesHtml, /shop · main/);
    assert.match(notesHtml, /shop · feat/);
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
    const titleLink = (): string | undefined => hubPage(hub.list(), { version: "1", q: "", project: "", projects: hub.projects(), stats: hub.stats() }).match(/<li><a href="\/hub\/open\/(\w+)"/)?.[1];
    assert.equal(hub.list()[0].copies[0].id, sb.id, "the gone copy is the newest");
    assert.equal(titleLink(), sa.id);
    fs.rmSync(a);
    assert.equal(titleLink(), sb.id);
  } finally {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  }
});

test("hubPage escapes project names, labels and paths", () => {
  const copy = (id: string, label: string) => ({ id, file: `/w/${label}/a.html`, root: `/w/${label}`, label, title: null, updated_at: 1, reviewed: 1, archived_at: null, missing: false, open: 0, received: 0, addressed: 0, held: 0 });
  const html = hubPage(
    [{ id: "p1", project_id: "x", project: "<img src=x>", rel_path: "<b>.html", title: '"><i>', updated_at: 1, open: 0, received: 0, addressed: 0, held: 0, copies: [copy("aaaaaaaaaaaa", "<u>"), copy("bbbbbbbbbbbb", "ok")] }],
    { version: "1", q: "", project: "", projects: [{ id: "x", name: "<img src=x>", roots: ["/w/<s>"] }], stats: { pages: 1, projects: 1 } },
  );
  for (const raw of ["<img src=x>", "<b>.html", '"><i>', "<u>", "/w/<s>"]) assert.ok(!html.includes(raw), raw);
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

    // At this build's schema it is read as it is.
    fs.rmSync(path.join(state, "server.lock"));
    (await Hub.open(file)).close();
    holdAs("0.0.1");
    const current = snapshot();
    const readable = await cliWith(env, "hub", "list", "--all");
    assert.equal(readable.code, 0, readable.out);
    assert.match(readable.out, /plan\.html/);
    assert.deepEqual(snapshot(), current, "read-only");
  } finally {
    try {
      fs.rmSync(state, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
    } catch (err) {
      if (process.platform !== "win32") throw err;
    }
  }
});
