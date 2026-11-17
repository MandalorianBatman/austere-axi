// The dispatcher (RLM-345): with attach on, a note the owner sends or releases starts the
// attached harness headless. A fake `omp` and `copilot` on the server's PATH stand in for the
// harnesses: they read the prompt on stdin, print what the real ones print, and drive the real
// CLI (feedback, patch, reply), or fail as a marker file tells them to.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import type { ChildProcess } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { autoConflict } from "../src/cli/attach.ts";
import { systemProcessTable } from "../src/cli/caller.ts";
import { Dispatcher, readAttachLimits, unreleasedNotes } from "../src/cli/dispatch.ts";
import { RENDER_CHECK_AUTHOR, SessionStore } from "../src/cli/sessions.ts";
import type { QueuedEntry } from "../src/cli/sessions.ts";
import { ownerKey } from "../src/cli/invites.ts";
import { ownerHeaders } from "./owner.ts";
import { freePort } from "./port.ts";
import { VERSION } from "../src/cli/paths.ts";

const skip = process.platform === "win32" && "the fake harnesses are POSIX shell scripts, and runs are killed by process group";

interface Res {
  status: number | undefined;
  data: string;
}

interface RunRow {
  id: string;
  status: string;
  reason: string | null;
  mode: string | null;
  harness: string | null;
  agent_session_id: string | null;
  seq_from: number | null;
  seq_to: number | null;
  log_file: string | null;
  started_at: number | null;
  ended_at: number | null;
}

/** What a fake harness recorded about its run. */
interface Recorded {
  harness: string;
  args: string[];
  env: Record<string, string>;
  prompt: string;
  cwd: string;
}

const PORT = await freePort();
const STATE = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "austere-dispatch-state-")));
const WORK = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "austere-dispatch-work-")));
const BIN = path.join(WORK, "bin");
const CTL = path.join(WORK, "ctl");
const PROJECT = path.join(WORK, "shop");
const CLI = path.resolve("src/cli/main.ts");
process.env.AUSTERE_AXI_STATE_DIR = STATE;

// The test may itself run inside a harness: its session must not become a page's author.
const BASE_ENV: NodeJS.ProcessEnv = { ...process.env };
for (const name of ["PI_SESSION_ID", "PI_SESSION_FILE", "COPILOT_AGENT_SESSION_ID", "DSH_SESSION_ID"]) delete BASE_ENV[name];
const ENV: NodeJS.ProcessEnv = {
  ...BASE_ENV,
  AUSTERE_AXI_STATE_DIR: STATE,
  AUSTERE_AXI_PORT: String(PORT),
  AUSTERE_AXI_NO_TAILSCALE: "1",
  AUSTERE_AXI_NO_OPEN: "1",
  AUSTERE_AXI_CLOUD_URL: "http://127.0.0.1:9",
  OPENUI_TELEMETRY_DISABLED: "1",
};

const FAKE = `import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
const harness = path.basename(path.dirname(process.argv[1]));
const args = process.argv.slice(2);
const prompt = fs.readFileSync(0, "utf8");
const file = /^Page file: (.+)$/m.exec(prompt)[1];
const cursor = /--cursor (\\d+)/.exec(prompt)[1];
const ctl = process.env.FAKE_CTL;
const run = process.env.AUSTERE_AXI_RUN_ID;
const name = path.basename(file, ".html");
let mode = "ok";
try { mode = fs.readFileSync(path.join(ctl, name + ".mode"), "utf8").trim(); } catch {}
fs.writeFileSync(path.join(ctl, run + ".json"), JSON.stringify({ harness, args, env: process.env, prompt, cwd: process.cwd() }));
const flag = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined; };
let id;
if (harness === "omp") {
  id = flag("--resume") ?? crypto.randomUUID();
  console.log(JSON.stringify({ type: "session", id }));
} else id = flag("--session-id") ?? args.find((a) => a.startsWith("--resume="))?.slice(9);
const cli = (input, ...a) => {
  const r = spawnSync(process.execPath, [process.env.FAKE_CLI, ...a], { input, encoding: "utf8" });
  process.stdout.write(r.stdout + r.stderr);
};
if (mode === "exit1") { console.error("boom: failing on purpose"); process.exit(1); }
if (mode === "sleep") {
  const g = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  fs.writeFileSync(path.join(ctl, run + ".grandchild"), String(g.pid));
  setInterval(() => {}, 1000);
} else {
  cli("", "feedback", file);
  if (fs.existsSync(path.join(ctl, name + ".hold"))) {
    fs.writeFileSync(path.join(ctl, run + ".fed"), "");
    while (!fs.existsSync(path.join(ctl, name + ".go"))) await new Promise((r) => setTimeout(r, 50));
  }
  if (mode !== "noreply") {
    cli('intro = TextContent("patched by ' + run + '")\\n', "patch", file);
    cli("", "reply", file, "--cursor", cursor, "--agent-reply", "Patched it.");
  }
  if (harness === "copilot") console.log(JSON.stringify({ type: "result", sessionId: id, exitCode: 0 }));
}
`;

let server: ChildProcess | null = null;

function post(route: string, body: unknown, headers: Record<string, string>): Promise<Res> {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const r = http.request({ host: "127.0.0.1", port: PORT, method: "POST", path: route, headers: { "content-type": "application/json", host: `127.0.0.1:${PORT}`, ...headers } }, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => resolve({ status: res.statusCode, data }));
    });
    r.on("error", reject);
    r.end(payload);
  });
}

const owner = (route: string, body: unknown = {}) => post(route, body, ownerHeaders(STATE));

function cli(...args: string[]): Promise<{ code: number | null; out: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], { env: ENV });
    let out = "";
    child.stdout.on("data", (c) => (out += c));
    child.stderr.on("data", (c) => (out += c));
    child.on("close", (code) => resolve({ code, out }));
  });
}

function db(): DatabaseSync {
  return new DatabaseSync(path.join(STATE, "hub.db"));
}

function query<T>(sql: string, ...args: (string | number | null)[]): T[] {
  const d = db();
  try {
    return d.prepare(sql).all(...args) as unknown as T[];
  } finally {
    d.close();
  }
}

function exec(sql: string, ...args: (string | number | null)[]): void {
  const d = db();
  try {
    d.prepare(sql).run(...args);
  } finally {
    d.close();
  }
}

const runsOf = (id: string) => query<RunRow>("SELECT * FROM runs WHERE artifact_id = ? ORDER BY rowid", id);
// Real time: the server under test runs in its own process with its own clock (debounce, recheck, time limit), so waits are real and short.
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function until<T>(what: string, fn: () => T | null | undefined | false, ms = 15_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(50);
  }
}

/** The run of the page once it is in one of `statuses`. */
const runIn = (id: string, ...statuses: string[]) => until(`a run ${statuses.join("/")}`, () => runsOf(id).find((r) => statuses.includes(r.status)));

function attachLimits(extra: Record<string, number> = {}): void {
  fs.writeFileSync(path.join(STATE, "attach.json"), JSON.stringify({ debounceMs: 200, recheckMs: 200, maxMinutes: 1, ...extra }));
}

/** A page in the project, opened for review; its copy id. */
async function page(name: string): Promise<{ file: string; id: string }> {
  const file = path.join(PROJECT, `${name}.html`);
  fs.writeFileSync(
    file,
    `<!doctype html><html><head><title>${name}</title><script src="https://cdn.jsdelivr.net/npm/austere-axi@0/dist/austere.js"></script></head>
<body><script type="text/openui">
root = Stack([intro])
intro = TextContent("hello")
</script></body></html>`,
  );
  const r = await owner("/api/open", { file });
  assert.equal(r.status, 200, r.data);
  return { file, id: (JSON.parse(r.data) as { session: { id: string } }).session.id };
}

/** Attach on for the page: the page row `attach on` and the Agent pill write (keyed by `pages.id`, A19). */
function attach(id: string, fields: { state?: string; mode?: string; session?: string; harness?: string } = {}): void {
  const [{ page_id }] = query<{ page_id: string }>("SELECT page_id FROM artifacts WHERE id = ?", id);
  exec(
    "INSERT OR REPLACE INTO attach_settings (scope, scope_id, state, mode, session, harness, model) VALUES ('page', ?, ?, ?, ?, ?, NULL)",
    page_id,
    fields.state ?? "on",
    fields.mode ?? null,
    fields.session ?? null,
    fields.harness ?? null,
  );
}

const say = (id: string, text: string) => owner(`/s/${id}/send`, { items: [{ kind: "message", text }] });
const fakeMode = (name: string, mode: string) => fs.writeFileSync(path.join(CTL, `${name}.mode`), mode);
const recorded = (runId: string) => JSON.parse(fs.readFileSync(path.join(CTL, `${runId}.json`), "utf8")) as Recorded;
const notesDone = (id: string) => query<{ seq: number; done_at: number | null }>("SELECT seq, done_at FROM notes WHERE artifact_id = ? AND seq IS NOT NULL ORDER BY seq", id);

function gone(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return false;
  } catch {
    return true;
  }
}

/** The `run` events the owner's review page of `id` hears. */
function runEvents(id: string): { events: { run: RunRow; tail?: string[]; message?: string }[]; close: () => void } {
  const events: { run: RunRow; tail?: string[]; message?: string }[] = [];
  const req = http.get({ host: "127.0.0.1", port: PORT, path: `/s/${id}/events`, headers: { host: `127.0.0.1:${PORT}`, cookie: ownerHeaders(STATE).cookie } }, (res) => {
    let buf = "";
    res.on("data", (c) => {
      buf += c;
      let i;
      while ((i = buf.indexOf("\n\n")) >= 0) {
        const block = buf.slice(0, i);
        buf = buf.slice(i + 2);
        const m = /^event: run\ndata: (.*)$/m.exec(block);
        if (m) events.push(JSON.parse(m[1]));
      }
    });
  });
  req.on("error", () => {});
  return { events, close: () => req.destroy() };
}

async function startServer(): Promise<void> {
  server = spawn(process.execPath, [CLI, "server", "--port", String(PORT)], {
    env: { ...ENV, PATH: `${BIN}${path.delimiter}${process.env.PATH}`, FAKE_CTL: CTL, FAKE_CLI: CLI, AUSTERE_AXI_HOST: "127.0.0.1" },
    stdio: "ignore",
  });
  for (let i = 0; i < 100; i++) {
    try {
      const r = await owner("/api/health");
      if (r.status === 405 || r.status === 200) return;
    } catch {}
    await sleep(50);
  }
  throw new Error("server did not start");
}

before(async () => {
  if (skip) return;
  fs.mkdirSync(path.join(PROJECT, ".git"), { recursive: true });
  fs.mkdirSync(CTL);
  for (const harness of ["omp", "copilot"]) {
    const script = path.join(WORK, "fakes", harness, "fake.mjs");
    fs.mkdirSync(path.dirname(script), { recursive: true });
    fs.writeFileSync(script, FAKE);
    fs.mkdirSync(BIN, { recursive: true });
    fs.writeFileSync(path.join(BIN, harness), `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`, { mode: 0o755 });
  }
  attachLimits();
  await startServer();
});

after(async () => {
  if (server && server.exitCode === null) {
    const child = server;
    const exited = new Promise((r) => child.once("exit", r));
    child.kill();
    await exited;
  }
  fs.rmSync(STATE, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  fs.rmSync(WORK, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
});

test("an owner's note starts exactly one run: the agent patches the page and replies; the owner key goes nowhere", { skip }, async () => {
  const { file, id } = await page("alpha");
  attach(id);
  assert.equal((await say(id, "make it shorter")).status, 200);
  const run = await runIn(id, "done", "failed");
  assert.equal(run.status, "done", `reason ${run.reason}`);
  await sleep(400);
  assert.equal(runsOf(id).length, 1);
  assert.match(fs.readFileSync(file, "utf8"), new RegExp(`patched by ${run.id}`));
  assert.ok(notesDone(id).every((n) => n.done_at !== null), "the note is answered");
  // No author yet: a `new` run with omp, which the dispatcher registers as the page's editor (A18).
  assert.equal(run.mode, "new");
  assert.equal(run.harness, "omp");
  assert.ok(run.agent_session_id);
  assert.equal(query("SELECT 1 FROM page_sessions WHERE artifact_id = ? AND agent_session_id = ? AND role = 'editor'", id, run.agent_session_id).length, 1);

  const rec = recorded(run.id);
  assert.equal(rec.env.AUSTERE_AXI_RUN_ID, run.id);
  assert.equal(rec.cwd, PROJECT, "the run works in the copy's root");
  assert.ok(!rec.args.join(" ").includes("Page file"), "no prompt text in argv");
  assert.match(rec.prompt, /austere-axi feedback/);
  assert.match(rec.prompt, /Do not open, screenshot or inspect the page/);
  assert.doesNotMatch(rec.prompt, /make it shorter/, "no note text in the prompt");
  const key = ownerKey(STATE);
  const log = fs.readFileSync(run.log_file as string, "utf8");
  assert.equal((fs.statSync(run.log_file as string).mode & 0o777).toString(8), "600");
  for (const [what, text] of [["log", log], ["argv", rec.args.join("\n")], ["environment", JSON.stringify(rec.env)], ["prompt", rec.prompt]]) {
    assert.ok(!text.includes(key), `the owner key is in the run's ${what}`);
  }
  assert.equal(fs.existsSync(path.join(STATE, "runs", `${run.id}.prompt`)), false, "the prompt file is gone");
  // `austere-axi` on the run's PATH is this server's CLI, not whatever is installed globally.
  const shimDir = rec.env.PATH.split(path.delimiter)[0];
  assert.equal(shimDir, path.join(STATE, "runs", "bin"));
  const version = spawnSync(path.join(shimDir, "austere-axi"), ["--version"], { encoding: "utf8" });
  assert.equal(version.stdout.trim(), VERSION, version.stderr);

  const list = await cli("run", "list", file);
  assert.match(list.out, new RegExp(`id: ${run.id}`));
  assert.match(list.out, /status: done/);
  const shown = await cli("run", "log", run.id);
  assert.match(shown.out, /"type":"session"/);

  // The next note resumes the session the first run made (A18).
  await say(id, "and bolder");
  const second = await until("a second run", () => runsOf(id).find((r) => r.id !== run.id && (r.status === "done" || r.status === "failed")));
  assert.equal(second.status, "done", `reason ${second.reason}`);
  const args = recorded(second.id).args;
  assert.equal(second.mode, "new");
  assert.equal(args[args.indexOf("--resume") + 1], (JSON.parse(log.split("\n")[0]) as { id: string }).id);
});

test("a reviewer's held note starts nothing; released by the owner, it does", { skip }, async () => {
  const { file, id } = await page("bravo");
  attach(id);
  const shared = await owner("/api/share", { file, name: "Ana" });
  assert.equal(shared.status, 200, shared.data);
  const token = new URL((JSON.parse(shared.data) as { link: string }).link).searchParams.get("invite") as string;
  const sent = await post(`/s/${id}/send`, { items: [{ kind: "message", text: "please fix" }] }, { cookie: `austere_rv=${token}` });
  assert.equal(sent.status, 200, sent.data);
  await sleep(700);
  assert.equal(runsOf(id).length, 0, "a held note started a run");
  const entry = (JSON.parse(sent.data) as { entry: { id: string } }).entry;
  assert.equal((await owner(`/s/${id}/release`, { ids: [entry.id] })).status, 200);
  const run = await runIn(id, "done", "failed");
  assert.equal(run.status, "done", `reason ${run.reason}`);
});

test("attach and unattended input exclude each other: publish --auto and share --auto (Q3, A17)", { skip }, async () => {
  const { file, id } = await page("charlie");
  // Published with --auto: the attach-on check says why, and a run refuses to start.
  fs.writeFileSync(path.join(STATE, "cloud.json"), JSON.stringify({ url: "http://127.0.0.1:9", token: "t", pages: { [file]: { id: "p1", auto: true, unlisted: false, presence: true, invites: {} } } }));
  assert.match(String(autoConflict(file, id, [])), /published with --auto/);
  attach(id);
  await say(id, "go");
  const refused = await runIn(id, "failed");
  assert.equal(refused.reason, "auto_conflict");
  fs.rmSync(path.join(STATE, "cloud.json"));
  // Attach on: publish --auto and share --auto refuse, naming attach off.
  const pub = await cli("publish", file, "--auto");
  assert.equal(pub.code, 1, pub.out);
  assert.match(pub.out, /attach is on.*attach off/s);
  const share = await cli("share", file, "--as", "Bo", "--auto");
  assert.equal(share.code, 1, share.out);
  assert.match(share.out, /attach is on.*attach off/s);
  // Shared with --auto while attach was off: the check says so, and a run refuses.
  attach(id, { state: "off" });
  const shared = await owner("/api/share", { file, name: "Cy", auto: true });
  assert.equal(shared.status, 200, shared.data);
  assert.match(String(autoConflict(file, id, [{ token: "x".repeat(32), name: "Cy", sessionId: id, file, auto: true, createdAt: 0 }])), /shared with --auto \(Cy\)/);
  attach(id);
  await say(id, "again");
  await until("a second refusal", () => runsOf(id).filter((r) => r.reason === "auto_conflict").length === 2);
  await owner("/api/share/revoke", { key: "Cy" });
});

test("the server reads the hosted page's live auto flag: --auto turned on elsewhere refuses a run cloud.json would allow", { skip }, async () => {
  const { file, id } = await page("quebec");
  // This machine published without --auto; the page row the last pull cached says auto.
  fs.writeFileSync(path.join(STATE, "cloud.json"), JSON.stringify({ url: "http://127.0.0.1:9", token: "t", pages: { [file]: { id: "pq", auto: false, unlisted: false, presence: true, invites: {} } } }));
  exec("INSERT INTO cloud_rows (page_id, type, id, seq, body) VALUES ('pq', 'page', 'pq', 1, ?)", JSON.stringify({ type: "page", id: "pq", auto: true }));
  try {
    assert.equal(autoConflict(file, id, []), null, "cloud.json alone says not auto");
    assert.match(String(autoConflict(file, id, [], () => true)), /published with --auto/);
    attach(id);
    await say(id, "go");
    const refused = await runIn(id, "failed", "done");
    assert.equal(refused.reason, "auto_conflict");
  } finally {
    fs.rmSync(path.join(STATE, "cloud.json"));
    exec("DELETE FROM cloud_rows WHERE page_id = 'pq'");
  }
});

test("a note an --auto invite delivered keeps runs off after the invite is revoked, until the owner answers or discards it (A17)", { skip }, async () => {
  const { file, id } = await page("romeo");
  const shared = await owner("/api/share", { file, name: "Dee", auto: true });
  assert.equal(shared.status, 200, shared.data);
  const token = new URL((JSON.parse(shared.data) as { link: string }).link).searchParams.get("invite") as string;
  const sent = await post(`/s/${id}/send`, { items: [{ kind: "message", text: "rewrite everything" }] }, { cookie: `austere_rv=${token}` });
  assert.equal(sent.status, 200, sent.data);
  assert.equal((await owner("/api/share/revoke", { key: "Dee" })).status, 200);
  attach(id);
  await say(id, "fix the title");
  const refused = await runIn(id, "failed", "done");
  assert.equal(refused.reason, "auto_conflict");
  assert.match(fs.readFileSync(refused.log_file as string, "utf8"), /A note from Dee reached the inbox without the owner releasing it/);
});

test("unreleasedNotes names reviewers' notes with a seq the owner never gave; not the owner's, released, hosted or render-check notes", () => {
  const note = (extra: Partial<QueuedEntry>): QueuedEntry => ({ id: "u", role: "user", at: 0, items: [], seenAt: null, doneAt: null, seq: 1, ...extra });
  const rendered = { kind: "render-error", message: "boom" };
  assert.equal(unreleasedNotes([note({}), note({ author: "Ana", releasedAt: 5 }), note({ author: "Bo", remote: true }), note({ author: RENDER_CHECK_AUTHOR, items: [rendered] })]), null);
  assert.match(String(unreleasedNotes([note({}), note({ author: "Ana" }), note({ author: "Ana" }), note({ author: "Bo" })])), /^3 notes from Ana, Bo reached the inbox/);
  // A reviewer an invite named "Render check" before the name was reserved: its notes are a reviewer's (their items say so).
  assert.match(String(unreleasedNotes([note({ author: RENDER_CHECK_AUTHOR, items: [{ kind: "message", text: "hi" }] })])), /^A note from Render check/);
});

test("attach.json limits are capped: a timer past setTimeout's range, or an absurd count, is refused", { skip }, () => {
  try {
    for (const [key, value] of [["maxMinutes", 24 * 60 + 1], ["debounceMs", 3_600_001], ["recheckMs", 2 ** 31], ["runsPerHour", 1001], ["maxConcurrent", 17]] as const) {
      fs.writeFileSync(path.join(STATE, "attach.json"), JSON.stringify({ [key]: value }));
      assert.throws(() => readAttachLimits(), new RegExp(`${key} must be at most`));
    }
    fs.writeFileSync(path.join(STATE, "attach.json"), JSON.stringify({ maxMinutes: 24 * 60, maxConcurrent: 16, recheckMs: 3_600_000 }));
    assert.equal(readAttachLimits().maxConcurrent, 16);
  } finally {
    attachLimits();
  }
});

test("notes within the debounce make one run; a note during a run makes a second run after it", { skip }, async () => {
  const { id } = await page("delta");
  fs.writeFileSync(path.join(CTL, "delta.hold"), "");
  attach(id);
  // A debounce the three sends always fit in, however slow the machine.
  attachLimits({ debounceMs: 1500 });
  try {
    for (const t of ["one", "two", "three"]) await say(id, t);
  } finally {
    attachLimits();
  }
  const first = await runIn(id, "running");
  await until("the first run read its feedback", () => fs.existsSync(path.join(CTL, `${first.id}.fed`)));
  await say(id, "four");
  await sleep(400);
  fs.writeFileSync(path.join(CTL, "delta.go"), "");
  const runs = await until("two finished runs", () => {
    const rs = runsOf(id);
    return rs.length === 2 && rs.every((r) => r.status === "done" || r.status === "failed") && rs;
  });
  const seqs = notesDone(id).map((n) => n.seq);
  assert.deepEqual(
    runs.map((r) => [r.status, r.seq_from, r.seq_to]),
    [
      ["done", seqs[0], seqs[2]],
      ["done", seqs[3], seqs[3]],
    ],
  );
});

test("a harness that exits 1 fails the run: the note stays unanswered and the owner hears the log tail", { skip }, async () => {
  const { id } = await page("echo");
  fakeMode("echo", "exit1");
  attach(id);
  const sse = runEvents(id);
  await sleep(200);
  await say(id, "fix");
  const run = await runIn(id, "failed");
  assert.equal(run.reason, "exit");
  assert.ok(notesDone(id).every((n) => n.done_at === null));
  const ev = await until("the failed run event", () => sse.events.find((e) => e.run.status === "failed"));
  assert.ok(ev.tail?.some((l) => l.includes("boom: failing on purpose")), JSON.stringify(ev));
  assert.ok(sse.events.some((e) => e.run.status === "running"), "the start was announced");
  sse.close();
});

test("a harness that exits 0 without replying fails with no_reply", { skip }, async () => {
  const { id } = await page("foxtrot");
  fakeMode("foxtrot", "noreply");
  attach(id);
  await say(id, "fix");
  const run = await runIn(id, "failed", "done");
  assert.equal(run.reason, "no_reply");
});

test("past the time limit the run's whole process tree is killed; stop does the same", { skip }, async () => {
  attachLimits({ maxMinutes: 0.03 });
  try {
    const { id } = await page("golf");
    fakeMode("golf", "sleep");
    attach(id);
    await say(id, "fix");
    const running = await runIn(id, "running");
    const grandchild = Number(await until("the grandchild", () => fs.existsSync(path.join(CTL, `${running.id}.grandchild`)) && fs.readFileSync(path.join(CTL, `${running.id}.grandchild`), "utf8")));
    const run = await runIn(id, "failed");
    assert.equal(run.reason, "timeout");
    assert.ok(notesDone(id).every((n) => n.done_at === null));
    await until("the grandchild to die", () => gone(grandchild), 8000);
  } finally {
    attachLimits();
  }
  const { id } = await page("hotel");
  fakeMode("hotel", "sleep");
  attach(id);
  await say(id, "fix");
  const running = await runIn(id, "running");
  const grandchild = Number(await until("the grandchild", () => fs.existsSync(path.join(CTL, `${running.id}.grandchild`)) && fs.readFileSync(path.join(CTL, `${running.id}.grandchild`), "utf8")));
  const stopped = await owner(`/s/${id}/run/stop`);
  assert.equal(stopped.status, 200, stopped.data);
  assert.equal((JSON.parse(stopped.data) as { stopped: number }).stopped, 1);
  const run = await runIn(id, "stopped");
  assert.equal(run.reason, "stopped");
  await until("the grandchild to die", () => gone(grandchild), 8000);
});

test("mode same waits while the session's process runs, then runs when it exits", { skip }, async () => {
  const { id } = await page("india");
  const table = systemProcessTable();
  assert.ok(table);
  const live = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { stdio: "ignore" });
  const start = await until("the process's start time", () => {
    const p = table.info(live.pid as number);
    return p && p !== "unreadable" ? p.start : undefined;
  });
  const now = Date.now();
  exec("INSERT INTO agent_sessions (id, harness, session_id, pid, pid_start, first_seen, last_seen) VALUES ('as-live', 'omp', 'sess-live', ?, ?, ?, ?)", live.pid as number, start, now, now);
  exec("INSERT INTO page_sessions (artifact_id, agent_session_id, role, at) VALUES (?, 'as-live', 'author', ?)", id, now);
  attach(id, { mode: "same", session: "author" });
  await say(id, "fix");
  const waiting = await runIn(id, "waiting_for_session");
  assert.equal(waiting.agent_session_id, "as-live");
  await sleep(500);
  assert.equal(runsOf(id)[0].status, "waiting_for_session");
  live.kill();
  const run = await runIn(id, "done", "failed");
  assert.equal(run.status, "done", `reason ${run.reason}`);
  const args = recorded(run.id).args;
  assert.equal(args[args.indexOf("--resume") + 1], "sess-live");
});

test("two pages on one author session in mode same: the second waits for the first page's run, announced once, then runs", { skip }, async () => {
  const a = await page("oscar");
  const b = await page("papa");
  const table = systemProcessTable();
  assert.ok(table);
  // The author's own process has exited: only the dispatcher's runs can hold the session.
  const dead = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { stdio: "ignore" });
  const start = await until("the process's start time", () => {
    const p = table.info(dead.pid as number);
    return p && p !== "unreadable" ? p.start : undefined;
  });
  const exited = once(dead, "exit");
  dead.kill();
  await exited;
  const now = Date.now();
  exec("INSERT INTO agent_sessions (id, harness, session_id, pid, pid_start, first_seen, last_seen) VALUES ('as-shared', 'omp', 'sess-shared', ?, ?, ?, ?)", dead.pid as number, start, now, now);
  for (const p of [a, b]) {
    exec("INSERT INTO page_sessions (artifact_id, agent_session_id, role, at) VALUES (?, 'as-shared', 'author', ?)", p.id, now);
    attach(p.id, { mode: "same", session: "author" });
  }
  fs.writeFileSync(path.join(CTL, "oscar.hold"), "");
  const sse = runEvents(b.id);
  await sleep(200);
  await say(a.id, "fix");
  const first = await runIn(a.id, "running");
  await until("the first run read its feedback", () => fs.existsSync(path.join(CTL, `${first.id}.fed`)));
  await say(b.id, "fix");
  const waiting = await runIn(b.id, "waiting_for_session");
  assert.equal(waiting.agent_session_id, "as-shared");
  // Several rechecks (recheckMs 200) pass; the run neither starts nor is announced again.
  await sleep(1500);
  assert.equal(runsOf(b.id)[0].started_at, null, "the second run started on a session in use");
  fs.writeFileSync(path.join(CTL, "oscar.go"), "");
  const second = await runIn(b.id, "done", "failed");
  assert.equal(second.status, "done", `reason ${second.reason}`);
  const firstDone = runsOf(a.id)[0];
  assert.equal(firstDone.status, "done", `reason ${firstDone.reason}`);
  assert.ok((second.started_at as number) >= (firstDone.ended_at as number), "the runs overlapped");
  const args = recorded(second.id).args;
  assert.equal(args[args.indexOf("--resume") + 1], "sess-shared");
  const waits = sse.events.filter((e) => /^Waiting for/.test(e.message ?? ""));
  assert.equal(waits.length, 1, JSON.stringify(waits));
  assert.match(String(waits[0].message), new RegExp(`run ${first.id} is using it`));
  sse.close();
});

test("mode same with a session of unknown liveness, and Copilot fork, are refused with the reason", { skip }, async () => {
  const { id } = await page("juliet");
  const now = Date.now();
  exec("INSERT INTO agent_sessions (id, harness, session_id, first_seen, last_seen) VALUES ('as-unknown', 'omp', 'sess-unknown', ?, ?)", now, now);
  exec("INSERT INTO page_sessions (artifact_id, agent_session_id, role, at) VALUES (?, 'as-unknown', 'author', ?)", id, now);
  attach(id, { mode: "same" });
  await say(id, "fix");
  assert.equal((await runIn(id, "failed")).reason, "session_unknown");

  const k = await page("kilo");
  exec("INSERT INTO agent_sessions (id, harness, session_id, first_seen, last_seen) VALUES ('as-copilot', 'copilot', 'sess-copilot', ?, ?)", now, now);
  exec("INSERT INTO page_sessions (artifact_id, agent_session_id, role, at) VALUES (?, 'as-copilot', 'author', ?)", k.id, now);
  attach(k.id, { mode: "fork" });
  await say(k.id, "fix");
  const run = await runIn(k.id, "failed");
  assert.equal(run.reason, "unsupported");
  assert.match(fs.readFileSync(run.log_file as string, "utf8"), /no fork/);
});

test("the 13th run in an hour is refused with the reason", { skip }, async () => {
  const { id } = await page("lima");
  const now = Date.now();
  for (let i = 0; i < 12; i++) exec("INSERT INTO runs (id, kind, artifact_id, status, started_at, ended_at) VALUES (?, 'note', ?, 'done', ?, ?)", `seed-${i}`, id, now - i * 60_000, now - i * 60_000);
  attach(id);
  await say(id, "fix");
  const run = await until("the refusal", () => runsOf(id).find((r) => r.reason === "rate_limit"));
  assert.equal(run.status, "failed");
  const shown = await cli("run", "log", run.id);
  assert.match(shown.out, /12 runs started on this page in the last hour; the limit is 12/);
});

test("with a listener on the page the note goes to its poll and no run starts", { skip }, async () => {
  const { file, id } = await page("mike");
  attach(id);
  const poll = owner("/api/poll", { file, timeoutMs: 5000 });
  await sleep(300);
  await say(id, "fix");
  const answer = await poll;
  assert.match(answer.data, /"status":"feedback"/);
  await sleep(600);
  assert.equal(runsOf(id).length, 0);
});

test("after a restart a running or waiting run is interrupted and queued once more; a requeued one is not; a crashed server's orphan is killed first", { skip }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "austere-dispatch-restart-"));
  const store = await SessionStore.open(dir);
  const table = systemProcessTable();
  assert.ok(table);
  // The harness of a run whose server crashed: still running in its own process group.
  const orphan = spawn(process.execPath, ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"], { stdio: "ignore", detached: true });
  const exited = once(orphan, "exit");
  try {
    const start = await until("the orphan's start time", () => {
      const p = table.info(orphan.pid as number);
      return p && p !== "unreadable" ? p.start : undefined;
    });
    const s = store.ensure(path.join(PROJECT, "november.html"));
    const add = store.db.prepare("INSERT INTO runs (id, kind, artifact_id, seq_from, seq_to, status, started_at, requeued_from, pid, pid_start) VALUES (?, 'note', ?, 1, 2, ?, 1, ?, ?, ?)");
    add.run("r-running", s.id, "running", null, orphan.pid as number, start);
    add.run("r-waiting", s.id, "waiting_for_session", null, null, null);
    add.run("r-again", s.id, "running", "r-before", null, null);
    // A recorded pid that is another process now (its start differs) is left alone.
    add.run("r-reused", s.id, "running", "r-before", process.pid, "not-my-start");
    const dispatcher = new Dispatcher({ db: store.db, store, port: PORT, log: () => {}, listening: () => false, autoConflict: () => null, emit: () => {} });
    dispatcher.start();
    await dispatcher.close();
    await exited;
    const rows = store.db.prepare("SELECT id, status, requeued_from, seq_from, seq_to FROM runs ORDER BY rowid").all() as unknown as { id: string; status: string; requeued_from: string | null; seq_from: number; seq_to: number }[];
    assert.deepEqual(rows.slice(0, 4).map((r) => [r.id, r.status]), [
      ["r-running", "interrupted"],
      ["r-waiting", "interrupted"],
      ["r-again", "interrupted"],
      ["r-reused", "interrupted"],
    ]);
    assert.deepEqual(rows.slice(4).map((r) => [r.status, r.requeued_from, r.seq_from, r.seq_to]), [
      ["queued", "r-running", 1, 2],
      ["queued", "r-waiting", 1, 2],
    ]);
  } finally {
    if (orphan.exitCode === null && orphan.signalCode === null) orphan.kill("SIGKILL");
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a run whose files cannot be written fails with unavailable; the server stays up", { skip: skip || (process.getuid?.() === 0 && "root writes anywhere") }, async () => {
  const { id } = await page("sierra");
  attach(id);
  const runs = path.join(STATE, "runs");
  fs.mkdirSync(runs, { recursive: true });
  fs.chmodSync(runs, 0o500);
  try {
    await say(id, "fix");
    const run = await runIn(id, "failed", "done", "running");
    assert.equal(run.status, "failed");
    assert.equal(run.reason, "unavailable");
  } finally {
    fs.chmodSync(runs, 0o700);
  }
  // The server answers: the failed write did not take it down.
  assert.ok((await owner("/api/health")).status);
  await say(id, "again");
  const next = await until("a second run", () => runsOf(id).find((r) => r.status === "done"));
  assert.equal(next.reason, null);
});

test("a server that stops leaves its running run's row running; the next server interrupts and requeues it", { skip }, async () => {
  const { id } = await page("tango");
  fakeMode("tango", "sleep");
  attach(id);
  await say(id, "fix");
  const running = await runIn(id, "running");
  await until("the harness started", () => fs.existsSync(path.join(CTL, `${running.id}.grandchild`)));
  const child = server as ChildProcess;
  const exited = once(child, "exit");
  child.kill("SIGTERM");
  await exited;
  await sleep(300);
  assert.equal(runsOf(id)[0].status, "running", "the stopping server judged the run it killed");
  fakeMode("tango", "ok");
  await startServer();
  const rows = await until("the requeued run done", () => {
    const rs = runsOf(id);
    return rs.length === 2 && rs[1].status === "done" && rs;
  });
  assert.equal(rows[0].status, "interrupted");
  assert.equal(query<{ requeued_from: string }>("SELECT requeued_from FROM runs WHERE id = ?", rows[1].id)[0].requeued_from, running.id);
});
