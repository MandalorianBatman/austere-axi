// History (RLM-349): every version of a page is kept whole in hub.db, tied to the notes that
// caused it, and can be put back. The CLI runs against a real server for the cases that need one
// (a watched file, a note delivered to a poll, a run).
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { Hub, SCHEMA_VERSION, openDatabase } from "../src/cli/hub.ts";
import { recordRevision, revisionLog } from "../src/cli/history.ts";
import { sessionId } from "../src/cli/sessions.ts";
import { ownerHeaders } from "./owner.ts";
import { freePort } from "./port.ts";

interface CliResult {
  code: number | null;
  out: string;
}

const PORT = await freePort();
const STATE = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "austere-history-state-")));
const WORK = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "austere-history-work-")));
const ENV: NodeJS.ProcessEnv = {
  ...process.env,
  AUSTERE_AXI_STATE_DIR: STATE,
  AUSTERE_AXI_PORT: String(PORT),
  AUSTERE_AXI_NO_TAILSCALE: "1",
  AUSTERE_AXI_NO_OPEN: "1",
  AUSTERE_AXI_PERSIST: "1",
  OPENUI_TELEMETRY_DISABLED: "1",
};
// This test may run inside a harness: its session must not become a page's author.
for (const name of ["PI_SESSION_ID", "PI_SESSION_FILE", "COPILOT_AGENT_SESSION_ID", "DSH_SESSION_ID", "AUSTERE_AXI_RUN_ID"]) delete ENV[name];

function cliWith(env: NodeJS.ProcessEnv, args: string[], input = ""): Promise<CliResult> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["src/cli/main.ts", ...args], { env });
    let out = "";
    child.stdout.on("data", (c) => (out += c));
    child.stderr.on("data", (c) => (out += c));
    child.stdin.end(input);
    child.on("close", (code) => resolve({ code, out }));
  });
}
const cli = (...args: string[]) => cliWith(ENV, args);
const patch = (file: string, statements: string, env: NodeJS.ProcessEnv = ENV) => cliWith(env, ["patch", file], statements);

function page(name: string, program: string): string {
  const file = path.join(WORK, `${name}.html`);
  fs.writeFileSync(file, html(program));
  return file;
}
const html = (program: string) => `<!doctype html><html><head><title>Plan</title><script src="https://cdn.jsdelivr.net/npm/austere-axi@0/dist/austere.js"></script></head>
<body><script type="text/openui">
${program}
</script></body></html>
`;
const PROGRAM = `root = Stack([intro, more])
intro = TextContent("hello")
more = TextContent("unchanged")`;

interface Rev {
  rev: number;
  source: string;
  program: string;
  run_id: string | null;
  seq_from: number | null;
  seq_to: number | null;
}

/** The revisions of a page as hub.db has them, read with a connection of its own. */
function revisions(file: string): Rev[] {
  const db = new DatabaseSync(path.join(STATE, "hub.db"), { readOnly: true });
  try {
    return db.prepare("SELECT rev, source, program, run_id, seq_from, seq_to FROM revisions WHERE artifact_id = ? ORDER BY rev").all(sessionId(file)) as unknown as Rev[];
  } finally {
    db.close();
  }
}

/** Waits for a condition the server will make true (a watched file is read within about half a second). */
async function until<T>(read: () => T | undefined | false | Promise<T | undefined | false>, what: string): Promise<T> {
  const deadline = Date.now() + 10_000;
  for (;;) {
    const v = await read();
    if (v) return v;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

function req(method: string, route: string, body?: unknown): Promise<{ status: number | undefined; data: string }> {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: "127.0.0.1", port: PORT, method, path: route, headers: { "content-type": "application/json", host: `127.0.0.1:${PORT}`, ...ownerHeaders(STATE) } }, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => resolve({ status: res.statusCode, data }));
    });
    r.on("error", reject);
    if (body !== undefined) r.write(JSON.stringify(body));
    r.end();
  });
}

before(() => {
  fs.mkdirSync(path.join(WORK, ".git"), { recursive: true });
});

after(async () => {
  await cli("stop");
  fs.rmSync(STATE, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  fs.rmSync(WORK, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
});

test("a patch makes a revision with the names it changed; the same content makes none", async () => {
  const file = page("patched", PROGRAM);
  assert.equal((await cli(file)).code, 0);
  assert.deepEqual(revisions(file).map((r) => [r.rev, r.source]), [[1, "open"]], "the first open records revision 1");

  const first = await patch(file, 'intro = TextContent("hello, again")');
  assert.equal(first.code, 0, first.out);
  const rows = revisions(file);
  assert.deepEqual(rows.map((r) => [r.rev, r.source]), [[1, "open"], [2, "patch"]]);
  assert.match(rows[1].program, /hello, again/);
  assert.match(rows[0].program, /intro = TextContent\("hello"\)/, "each revision holds the whole program as it was");

  assert.equal((await patch(file, 'intro = TextContent("hello, again")')).code, 0);
  assert.equal(revisions(file).length, 2, "identical content: no revision");

  const log = await cli("history", file);
  assert.match(log.out, /rev: 2\n\s+at: [^\n]+\n\s+source: patch\n\s+changed: \[intro\]/);
  assert.match(log.out, /rev: 1\n[\s\S]*created: 3 statements/);
  const only = await cli("history", file, "--statement", "more");
  assert.doesNotMatch(only.out, /rev: 2/, "--statement keeps the revisions that changed it");
  assert.match(only.out, /rev: 1/);
  assert.doesNotMatch((await cli("history", file, "--since", "1")).out, /rev: 1\n/);
});

test("a direct edit while the page is watched is a revision of source file", async () => {
  const file = page("watched", PROGRAM);
  assert.equal((await cli(file)).code, 0);
  fs.writeFileSync(file, html(PROGRAM.replace('"unchanged"', '"edited by hand"')));
  const rows = await until(() => {
    const r = revisions(file);
    return r.length === 2 && r;
  }, "the server to see the edit");
  assert.equal(rows[1].source, "file");
  assert.match(rows[1].program, /edited by hand/);
});

test("an edit made while no server ran becomes a revision on the next open", async () => {
  const file = page("offline", PROGRAM);
  assert.equal((await cli(file)).code, 0);
  assert.equal((await cli("stop")).code, 0);
  // `stop` answers before the server has quite gone; its watcher would still record an edit made now as its own.
  await until(async () => (await fetch(`http://127.0.0.1:${PORT}/api/health`).then(() => false, () => true)) || undefined, "the server to be gone");
  fs.writeFileSync(file, html(PROGRAM.replace('"hello"', '"edited while stopped"')));
  assert.equal(revisions(file).length, 1);
  assert.equal((await cli(file)).code, 0);
  const rows = revisions(file);
  assert.deepEqual(rows.map((r) => [r.rev, r.source]), [[1, "open"], [2, "open"]]);
  assert.match(rows[1].program, /edited while stopped/);
});

test("the revision names the notes it answers; a run's revision names the run and its notes", async () => {
  const file = page("caused", PROGRAM);
  const opened = await cli(file);
  assert.equal(opened.code, 0);
  const id = sessionId(file);
  const sent = await req("POST", `/s/${id}/send`, { items: [{ kind: "message", text: "make the greeting warmer" }] });
  assert.equal(sent.status, 200, sent.data);
  const polled = await cli("poll", file, "--timeout-ms", "5000");
  assert.match(polled.out, /make the greeting warmer/);
  assert.equal((await patch(file, 'intro = TextContent("hello, friend")')).code, 0);
  const note = revisions(file)[1];
  assert.ok(note.seq_from != null && note.seq_from === note.seq_to, "the delivered note is the cause");
  assert.equal(note.run_id, null);
  const log = await cli("history", file);
  assert.match(log.out, /cause: "?owner: make the greeting warmer/);
  assert.equal((await cli("reply", file, "--agent-reply", "warmer")).code, 0);

  // A dispatched run: its id comes in the environment, its note range from its row.
  const db = new DatabaseSync(path.join(STATE, "hub.db"));
  try {
    db.prepare("INSERT INTO runs (id, kind, artifact_id, seq_from, seq_to, status) VALUES ('r00000000run', 'attach', ?, 11, 12, 'running')").run(id);
  } finally {
    db.close();
  }
  assert.equal((await patch(file, 'more = TextContent("run edit")', { ...ENV, AUSTERE_AXI_RUN_ID: "r00000000run" })).code, 0);
  const last = revisions(file).at(-1) as Rev;
  assert.deepEqual([last.run_id, last.seq_from, last.seq_to], ["r00000000run", 11, 12]);
});

test("restore --rev 1 makes a new revision equal to revision 1, and check passes", async () => {
  const file = page("restored", PROGRAM);
  await cli(file);
  await patch(file, 'intro = TextContent("one")');
  await patch(file, 'intro = TextContent("two")\nmore = TextContent("also two")');
  const before = revisions(file);
  assert.equal(before.length, 3);

  const part = await cli("restore", file, "--rev", "1", "intro");
  assert.equal(part.code, 0, part.out);
  assert.match(fs.readFileSync(file, "utf8"), /intro = TextContent\("hello"\)/);
  assert.match(fs.readFileSync(file, "utf8"), /also two/, "only the named part went back");
  assert.equal(revisions(file).at(-1)?.source, "restore");

  const whole = await cli("restore", file, "--rev", "1");
  assert.equal(whole.code, 0, whole.out);
  const rows = revisions(file);
  assert.equal(rows.length, 5);
  assert.equal(rows[4].program, rows[0].program, "the new revision equals revision 1");
  assert.equal((await cli("check", file)).code, 0);
  assert.equal((await cli("restore", file, "--rev", "1")).out.includes("status: unchanged"), true, "already so: nothing is recorded");
  assert.equal(revisions(file).length, 5);
  const bad = await cli("restore", file, "--rev", "9");
  assert.equal(bad.code, 1);
  assert.match(bad.out, /has no revision 9 \(revisions 1 to 5\)/);
  const nameless = await cli("restore", file, "--rev", "1", "nope");
  assert.match(nameless.out, /revision 1 has no statement nope; it has: root, intro, more/);
});

test("restoring a statement nothing on the page refers to now says so instead of doing nothing", async () => {
  const file = page("orphan", PROGRAM);
  await cli(file);
  assert.equal((await patch(file, "root = Stack([intro])")).code, 0, "`more` is dropped: nothing refers to it");
  const r = await cli("restore", file, "--rev", "1", "more");
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /more would be dropped again: nothing on the page refers to it now/);
  assert.doesNotMatch(fs.readFileSync(file, "utf8"), /more =/);
  // With its parent, it comes back.
  assert.equal((await cli("restore", file, "--rev", "1", "root", "more")).code, 0);
  assert.match(fs.readFileSync(file, "utf8"), /more = TextContent\("unchanged"\)/);
});

test("show reads an earlier revision", async () => {
  const file = page("shown", PROGRAM);
  await cli(file);
  await patch(file, 'intro = TextContent("changed")');
  const old = await cli("show", file, "intro", "--rev", "1");
  assert.match(old.out, /rev: 1\nsource: \|\n\s+intro = TextContent\("hello"\)/);
  const now = await cli("show", file, "intro");
  assert.match(now.out, /source: \|\n\s+intro = TextContent\("changed"\)/);
});

test("500 revisions of a 4 KB page: every one is kept whole and history reads them", async () => {
  const db = await openDatabase(":memory:");
  try {
    const hub = new Hub(db);
    const file = path.join(WORK, "big.html");
    fs.writeFileSync(file, html(PROGRAM));
    hub.register({ id: sessionId(file), file, title: "Plan" });
    const filler = (n: number) => `Row ${n}: ${"lorem ipsum dolor sit amet ".repeat(8)}`;
    const program = (n: number) => `root = Stack([${Array.from({ length: 8 }, (_, i) => `s${i}`).join(", ")}])\n${Array.from({ length: 8 }, (_, i) => `s${i} = TextContent(${JSON.stringify(i === n % 8 ? filler(n) : filler(0))})`).join("\n")}`;
    assert.ok(program(0).length > 1500, "a page of a few KB");
    for (let n = 1; n <= 500; n++) assert.equal(recordRevision(db, sessionId(file), html(program(n)), { source: "patch" })?.rev, n);
    const log = revisionLog(db, sessionId(file), { limit: 500 });
    assert.equal(log.length, 500);
    const window = revisionLog(db, sessionId(file), { limit: 20 });
    assert.deepEqual(window.map((r) => r.rev), Array.from({ length: 20 }, (_, i) => 500 - i), "the newest 20");
    assert.deepEqual(window[19].changed.sort(), [`s${481 % 8}`, `s${480 % 8}`].sort(), "the oldest of the window is still compared with the revision before it");
    assert.deepEqual(revisionLog(db, sessionId(file), { since: 497 }).map((r) => r.rev), [500, 499, 498]);
    assert.deepEqual(revisionLog(db, sessionId(file), { statement: "s1", limit: 3 }).map((r) => r.rev), [498, 497, 490], "s1 is set at 497 and set back at 498");
    assert.deepEqual(log[0].changed.sort(), [`s${500 % 8}`, `s${499 % 8}`].sort(), "each revision names what it changed against the one before");
    assert.equal((db.prepare("SELECT COUNT(*) AS n FROM revisions").get() as { n: number }).n, 500);
    assert.equal((db.prepare("SELECT COUNT(*) AS n FROM statements").get() as { n: number }).n, 9, "the index holds the head only");
  } finally {
    db.close();
  }
});

test("a 0.10.4 hub.db opens with the history tables; the first open then creates revision 1", async () => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "austere-history-migrate-")));
  const state = path.join(dir, "state");
  fs.mkdirSync(state);
  fs.copyFileSync(path.join(import.meta.dirname, "fixtures", "hub-0.10.4.db"), path.join(state, "hub.db"));
  const port = await freePort();
  const env = { ...ENV, AUSTERE_AXI_STATE_DIR: state, AUSTERE_AXI_PORT: String(port) };
  const columns = (db: DatabaseSync, table: string) => (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name);
  try {
    const old = new DatabaseSync(path.join(state, "hub.db"));
    assert.deepEqual(columns(old, "revisions"), [], "the fixture predates history");
    const before = Number((old.prepare("SELECT COUNT(*) AS n FROM notes").get() as { n: number }).n);
    old.close();

    const file = path.join(dir, "plan.html");
    fs.writeFileSync(file, html(PROGRAM));
    const opened = await cliWith(env, [file]);
    assert.equal(opened.code, 0, opened.out);
    const db = new DatabaseSync(path.join(state, "hub.db"), { readOnly: true });
    try {
      assert.equal(db.prepare("PRAGMA user_version").get()?.user_version, SCHEMA_VERSION);
      assert.deepEqual(columns(db, "revisions"), ["id", "artifact_id", "rev", "at", "source", "program", "program_sha", "run_id", "agent_session_id", "seq_from", "seq_to"]);
      assert.deepEqual(columns(db, "statements"), ["id", "artifact_id", "name", "component", "text", "source", "rev"]);
      assert.deepEqual(columns(db, "statement_origins"), ["artifact_id", "name", "src_artifact_id", "src_name", "src_rev"]);
      assert.equal(Number((db.prepare("SELECT COUNT(*) AS n FROM notes").get() as { n: number }).n), before, "the 0.10.4 notes are still there");
      const rows = db.prepare("SELECT rev, source FROM revisions WHERE artifact_id = ?").all(sessionId(file)) as { rev: number; source: string }[];
      assert.deepEqual(rows.map((r) => [r.rev, r.source]), [[1, "open"]]);
      assert.ok(Number((db.prepare("SELECT COUNT(*) AS n FROM statements WHERE artifact_id = ?").get(sessionId(file)) as { n: number }).n) === 3);
    } finally {
      db.close();
    }
  } finally {
    await cliWith(env, ["stop"]);
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  }
});
