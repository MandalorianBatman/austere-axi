// The agent session registry (RLM-343): caller detection from the harness's environment and
// `--session`, the harness process found among the CLI's parents (liveness), the author /
// editor / listener roles in hub.db, and `sessions list`.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { detectCaller, findHarnessProcess, isHarnessProcess, parseSessionOverride, procfsTable, processLiveness, psTable } from "../src/cli/caller.ts";
import type { ProcInfo, ProcessTable } from "../src/cli/caller.ts";
import { linkPage, listSessions, liveness, parseCallerReport, recordContinuation, registerSession } from "../src/cli/agent-sessions.ts";
import { openDatabase } from "../src/cli/hub.ts";
import { freePort } from "./port.ts";

const MAIN = path.resolve("src/cli/main.ts");
const PORT = await freePort();
const STATE = fs.mkdtempSync(path.join(os.tmpdir(), "austere-agent-sessions-state-"));
const WORK = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "austere-agent-sessions-work-")));
const PROJECT = path.join(WORK, "shop");
const FILE = path.join(PROJECT, "plan.html");
const OTHER = path.join(PROJECT, "other.html");

/** This test's environment: no harness variables of its own (the test may itself run inside a harness). */
const BASE: NodeJS.ProcessEnv = {
  ...process.env,
  AUSTERE_AXI_STATE_DIR: STATE,
  AUSTERE_AXI_PORT: String(PORT),
  AUSTERE_AXI_NO_TAILSCALE: "1",
  AUSTERE_AXI_NO_OPEN: "1",
  AUSTERE_AXI_PERSIST: "1",
  OPENUI_TELEMETRY_DISABLED: "1",
};
for (const v of ["PI_SESSION_ID", "PI_SESSION_FILE", "COPILOT_AGENT_SESSION_ID", "DSH_SESSION_ID"]) delete BASE[v];

const OMP = "0a1b2c3d-1111-4222-8333-444455556666";
const COPILOT = "c0b1a2d3-2222-4333-8444-555566667777";
const DSH = "d5h00001-aaaa";

function cli(env: NodeJS.ProcessEnv, args: string[], stdin = ""): Promise<{ code: number | null; out: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [MAIN, ...args], { env: { ...BASE, ...env } });
    let out = "";
    child.stdout.on("data", (c: Buffer) => (out += c));
    child.on("close", (code) => resolve({ code, out }));
    child.stdin.end(stdin);
  });
}

const page = (text: string) =>
  `<!doctype html><html><head><title>Plan</title><script src="https://cdn.jsdelivr.net/npm/austere-axi@0/dist/austere.js"></script></head>\n<body><script type="text/openui">\nroot = Stack([intro])\nintro = TextContent("${text}")\n</script></body></html>\n`;

before(() => {
  fs.mkdirSync(path.join(PROJECT, ".git"), { recursive: true });
  fs.writeFileSync(FILE, page("hello"));
  fs.writeFileSync(OTHER, page("other"));
});

after(async () => {
  await cli({}, ["stop"]);
  fs.rmSync(STATE, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  fs.rmSync(WORK, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
});

/** A process table from a list, for walks and liveness without real processes. */
function fakeTable(procs: Omit<ProcInfo, "argv">[], argv: Record<number, string[]> = {}): ProcessTable {
  return { info: (pid) => {
    const p = procs.find((x) => x.pid === pid);
    return p ? { ...p, argv: () => argv[pid] ?? [] } : null;
  } };
}

// ── detection ──

test("each harness is detected from its own variables; none set is not detected", () => {
  const none = fakeTable([]);
  assert.deepEqual(detectCaller({ PI_SESSION_ID: OMP, PI_SESSION_FILE: "/s/x.jsonl" }, undefined, none), { harness: "omp", sessionId: OMP, sessionFile: "/s/x.jsonl" });
  assert.deepEqual(detectCaller({ PI_SESSION_ID: OMP }, undefined, none), { harness: "omp", sessionId: OMP });
  assert.deepEqual(detectCaller({ COPILOT_AGENT_SESSION_ID: COPILOT }, undefined, none), { harness: "copilot", sessionId: COPILOT });
  assert.deepEqual(detectCaller({ DSH_SESSION_ID: DSH }, undefined, none), { harness: "dsh", sessionId: DSH });
  assert.equal(detectCaller({}, undefined, none), null);
  assert.equal(detectCaller({ PI_SESSION_ID: "" }, undefined, none), null, "an empty variable is not a session");
  assert.equal(detectCaller({ PI_SESSION_ID: "a b/c" }, undefined, none), null, "nor is one that is not an id");
});

test("--session overrides the environment; a malformed one is refused", () => {
  assert.deepEqual(detectCaller({ PI_SESSION_ID: OMP }, `copilot:${COPILOT}`, null), { harness: "copilot", sessionId: COPILOT });
  assert.deepEqual(parseSessionOverride("dsh:abc.1_2-3"), { harness: "dsh", sessionId: "abc.1_2-3" });
  for (const bad of ["omp", "omp:", ":abc", "claude:abc", "omp:a b", "omp:a/b", "omp:a:b", `omp:${"x".repeat(129)}`]) {
    assert.throws(() => parseSessionOverride(bad), /--session/, bad);
  }
});

test("with several harnesses' variables set, the nearest harness among the parents wins", () => {
  // copilot (pid 30) was started from a shell of omp (pid 10): its shell inherits PI_SESSION_ID too.
  const table = fakeTable(
    [
      { pid: 50, ppid: 40, comm: "bash", start: "500" },
      { pid: 40, ppid: 30, comm: "bash", start: "400" },
      { pid: 30, ppid: 20, comm: "node", start: "300" },
      { pid: 20, ppid: 10, comm: "bash", start: "200" },
      { pid: 10, ppid: 1, comm: "omp", start: "100" },
    ],
    { 30: ["node", "/usr/lib/node_modules/@github/copilot/index.js", "--resume"], 40: ["bash", "-c", "omp"] },
  );
  const env = { PI_SESSION_ID: OMP, COPILOT_AGENT_SESSION_ID: COPILOT };
  assert.equal(detectCaller(env, undefined, table, 50)?.harness, "copilot");
  assert.equal(detectCaller(env, undefined, table, 20)?.harness, "omp");
  assert.equal(detectCaller(env, undefined, null, 50)?.harness, "omp", "no process table: the first in order");
  assert.deepEqual(findHarnessProcess(["omp"], table, 50), { harness: "omp", pid: 10, start: "100" });
});

test("harness processes: by executable name, or a runtime or shell running a script of that name", () => {
  const p = (comm: string, argv: string[] = []): ProcInfo => ({ pid: 2, ppid: 1, comm, start: "1", argv: () => argv });
  assert.ok(isHarnessProcess(p("omp"), "omp"));
  assert.ok(isHarnessProcess(p("/usr/local/bin/omp"), "omp"), "macOS ps prints the path");
  assert.ok(isHarnessProcess(p("dsh"), "dsh"));
  assert.ok(isHarnessProcess(p("copilot"), "copilot"));
  assert.ok(isHarnessProcess(p("node", ["node", "/home/u/.npm/_npx/1/node_modules/@github/copilot/npm-loader.js"]), "copilot"));
  assert.ok(isHarnessProcess(p("node", ["/usr/bin/node", "/usr/local/bin/copilot", "-p"]), "copilot"));
  assert.ok(isHarnessProcess(p("sh", ["/bin/sh", "/tmp/x/omp"]), "omp"), "a shebang script under ps");
  assert.ok(!isHarnessProcess(p("node", ["node", "/srv/app/server.js", "copilot"]), "copilot"), "only the script's path counts, not its arguments");
  assert.ok(!isHarnessProcess(p("vim", ["vim", "/tmp/omp"]), "omp"), "a program that is not a runtime or shell");
  assert.ok(!isHarnessProcess(p("omp"), "copilot"));
});

test("procfs: comm, ppid and start time from stat (comm may hold spaces and parentheses), argv from cmdline", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "austere-procfs-"));
  try {
    const proc = (pid: number, comm: string, ppid: number, start: number, argv: string[]) => {
      fs.mkdirSync(path.join(root, String(pid)));
      // Fields 3..22: state, ppid, 16 others, then starttime.
      const rest = ["S", ppid, ...Array.from({ length: 17 }, (_, i) => i), start, 0, 0].join(" ");
      fs.writeFileSync(path.join(root, String(pid), "stat"), `${pid} (${comm}) ${rest}`);
      fs.writeFileSync(path.join(root, String(pid), "cmdline"), argv.join("\0") + "\0");
    };
    proc(300, "a (b) c", 200, 9999, ["x"]);
    proc(200, "node", 100, 8888, ["node", "/opt/copilot/index.js"]);
    proc(100, "omp", 1, 7777, ["omp"]);
    const table = procfsTable(root);
    const p = table.info(300);
    assert.equal(p?.comm, "a (b) c");
    assert.equal(p?.ppid, 200);
    assert.equal(p?.start, "9999");
    assert.deepEqual(table.info(200)?.argv(), ["node", "/opt/copilot/index.js"]);
    assert.equal(table.info(4242), null);
    assert.deepEqual(findHarnessProcess(["copilot"], table, 300), { harness: "copilot", pid: 200, start: "8888" });
    assert.deepEqual(findHarnessProcess(["omp"], table, 300), { harness: "omp", pid: 100, start: "7777" });
    assert.equal(findHarnessProcess(["dsh"], table, 300), null);
    assert.equal(processLiveness(100, "7777", table), "alive");
    assert.equal(processLiveness(100, "7776", table), "exited", "the pid was reused by a later process");
    assert.equal(processLiveness(4242, "1", table), "exited");
    assert.equal(processLiveness(null, null, table), "unknown");
    assert.equal(processLiveness(100, "7777", null), "unknown", "no process table (Windows)");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("ps (macOS): ppid, lstart and comm in one call, args only when needed", () => {
  const calls: string[][] = [];
  const table = psTable((args) => {
    calls.push(args);
    if (args[1] === "args=") return "/usr/local/bin/node /usr/local/lib/node_modules/@github/copilot/index.js --resume=x\n";
    return args.at(-1) === "77" ? "   12 Mon Nov 17 04:01:42 2026     /usr/local/bin/node\n" : "";
  });
  const p = table.info(77);
  assert.deepEqual([p?.ppid, p?.start, p?.comm], [12, "Mon Nov 17 04:01:42 2026", "/usr/local/bin/node"]);
  assert.equal(calls.length, 1);
  assert.ok(p && isHarnessProcess(p, "copilot"));
  assert.equal(calls.length, 2);
  assert.equal(table.info(78), null);
});

// ── the registry ──

test("roles: the first session to open or patch a copy is its author, later ones editors; poll, reply and feedback listen", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "austere-registry-"));
  const db = await openDatabase(path.join(dir, "hub.db"));
  try {
    const add = db.prepare("INSERT INTO artifacts (id, file, project, created_at, updated_at, project_id) VALUES (?, ?, '', 1, 1, ?)");
    add.run("aaaaaaaaaaaa", "/w/a.html", "p1");
    add.run("bbbbbbbbbbbb", "/w/b.html", "p1");
    add.run("cccccccccccc", "/x/c.html", "p2");
    const a = { harness: "omp" as const, sessionId: OMP, cwd: "/w", pid: 10, pidStart: "100" };
    const b = { harness: "copilot" as const, sessionId: COPILOT };
    const ra = registerSession(db, a, { artifactIds: ["aaaaaaaaaaaa"], action: "poll", at: 1000 });
    assert.equal(ra.first_seen, 1000);
    registerSession(db, a, { artifactIds: ["aaaaaaaaaaaa"], action: "open", at: 2000 });
    registerSession(db, b, { artifactIds: ["aaaaaaaaaaaa"], action: "patch", at: 3000 });
    registerSession(db, a, { artifactIds: ["aaaaaaaaaaaa"], action: "patch", at: 4000 });
    registerSession(db, b, { artifactIds: ["aaaaaaaaaaaa", "bbbbbbbbbbbb"], action: "reply", at: 5000 });
    registerSession(db, b, { artifactIds: ["bbbbbbbbbbbb"], action: "open", at: 6000 });
    registerSession(db, b, { artifactIds: ["bbbbbbbbbbbb"], action: "feedback", at: 7000 });
    // A later registration without a process keeps the last one seen.
    const again = registerSession(db, { harness: "omp", sessionId: OMP }, { artifactIds: [], action: "feedback", at: 8000 });
    assert.deepEqual([again.id, again.pid, again.pid_start, again.cwd, again.first_seen, again.last_seen], [ra.id, 10, "100", "/w", 1000, 8000]);
    assert.equal((db.prepare("SELECT count(*) AS n FROM agent_sessions").get() as { n: number }).n, 2);

    const rows = db.prepare("SELECT artifact_id, s.harness, role, at FROM page_sessions JOIN agent_sessions s ON s.id = agent_session_id ORDER BY artifact_id, at").all();
    assert.deepEqual(
      rows.map((r) => [r.artifact_id, r.harness, r.role, r.at]),
      [
        ["aaaaaaaaaaaa", "omp", "author", 4000],
        ["aaaaaaaaaaaa", "copilot", "editor", 3000],
        ["aaaaaaaaaaaa", "omp", "listener", 1000],
        ["aaaaaaaaaaaa", "copilot", "listener", 5000],
        ["bbbbbbbbbbbb", "copilot", "author", 6000],
        ["bbbbbbbbbbbb", "copilot", "listener", 7000],
      ].sort((x, y) => String(x[0]).localeCompare(String(y[0])) || Number(x[3]) - Number(y[3])),
      "one row per page, session and role: a repeat moves its time",
    );

    const page = listSessions(db, { artifactId: "aaaaaaaaaaaa" });
    assert.deepEqual(page.map((s) => [s.session.harness, s.roles, s.at]), [["copilot", ["editor", "listener"], 5000], ["omp", ["author", "listener"], 4000]]);
    const project = listSessions(db, { projectId: "p1" });
    assert.deepEqual(project.map((s) => [s.file, s.session.harness]), [["/w/b.html", "copilot"], ["/w/a.html", "copilot"], ["/w/a.html", "omp"]]);
    assert.deepEqual(listSessions(db, { projectId: "p2" }), []);

    const omp = page.find((s) => s.session.harness === "omp")!.session;
    const live = fakeTable([{ pid: 10, ppid: 1, comm: "omp", start: "100" }]);
    assert.equal(liveness(omp, live), "alive");
    assert.equal(liveness(omp, fakeTable([{ pid: 10, ppid: 1, comm: "omp", start: "101" }])), "exited");
    assert.equal(liveness(page.find((s) => s.session.harness === "copilot")!.session, live), "unknown");

    // A14: omp continued the session in a new one; the dispatcher links it as an editor.
    const next = recordContinuation(db, ra.id, "0a1b2c3d-9999-4222-8333-444455556666", "continuation", 9000);
    assert.deepEqual([next.harness, next.parent_id, next.parent_kind, next.cwd], ["omp", ra.id, "continuation", "/w"]);
    linkPage(db, "aaaaaaaaaaaa", next.id, "editor", 9000);
    assert.equal(listSessions(db, { artifactId: "aaaaaaaaaaaa" })[0].session.id, next.id);
    assert.throws(() => recordContinuation(db, "nope", "x", "fork"), /no agent session nope/);
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  }
});

test("the server checks the session it is sent", () => {
  assert.equal(parseCallerReport(undefined), null);
  assert.deepEqual(parseCallerReport({ harness: "omp", sessionId: OMP, cwd: "/w", pid: 5, pidStart: "9" }), { harness: "omp", sessionId: OMP, sessionFile: undefined, cwd: "/w", pid: 5, pidStart: "9" });
  for (const bad of ["omp", [], { harness: "x", sessionId: "a" }, { harness: "omp", sessionId: "a b" }, { harness: "omp", sessionId: "a", pid: -1, pidStart: "1" }, { harness: "omp", sessionId: "a", pid: 3 }, { harness: "omp", sessionId: "a", cwd: 7 }]) {
    assert.throws(() => parseCallerReport(bad), Error, JSON.stringify(bad));
  }
});

// ── through the CLI ──

/** The `session:` line's value; output is YAML, so a value with `: ` in it is quoted. */
const line = (out: string) => {
  const v = /^session: (.*)$/m.exec(out)?.[1];
  return v?.startsWith('"') ? (JSON.parse(v) as string) : v;
};

test("open, patch, poll, reply and feedback print the session line and register the caller; sessions list shows them", async () => {
  const omp = { PI_SESSION_ID: OMP, PI_SESSION_FILE: `/sessions/${OMP}.jsonl` };
  const copilot = { COPILOT_AGENT_SESSION_ID: COPILOT };

  let r = await cli(omp, ["open", FILE]);
  assert.equal(r.code, 0, r.out);
  assert.equal(line(r.out), "omp 556666 registered");
  assert.ok(!r.out.includes(OMP), "only the short id is printed");

  r = await cli(copilot, ["patch", FILE], 'intro = TextContent("patched")\n');
  assert.equal(r.code, 0, r.out);
  assert.equal(line(r.out), "copilot 667777 registered");

  r = await cli(omp, ["poll", FILE, "--timeout-ms", "50"]);
  assert.equal(line(r.out), "omp 556666 registered", r.out);
  r = await cli(copilot, ["reply", FILE, "--agent-reply", "done"]);
  assert.equal(line(r.out), "copilot 667777 registered", r.out);
  r = await cli({ DSH_SESSION_ID: DSH }, ["feedback", FILE, "--all"]);
  assert.equal(line(r.out), "dsh 01aaaa registered", r.out);
  r = await cli({}, ["feedback", FILE]);
  assert.equal(line(r.out), "not detected (attach: new only)", r.out);
  // A page opened with no session: the project poll below listens to it too.
  assert.equal((await cli({}, ["open", OTHER])).code, 0);
  r = await cli({}, ["poll", "--project", PROJECT, "--timeout-ms", "50", "--session", "dsh:project-listener"]);
  assert.equal(line(r.out), "dsh stener registered", r.out);
  r = await cli({}, ["open", OTHER, "--session", "omp:bad id"]);
  assert.equal(r.code, 2, r.out);
  assert.match(r.out, /code: USAGE/);

  const db = new DatabaseSync(path.join(STATE, "hub.db"), { readOnly: true });
  try {
    const rows = db.prepare("SELECT a.file, s.harness, s.session_id, s.session_file, p.role FROM page_sessions p JOIN agent_sessions s ON s.id = p.agent_session_id JOIN artifacts a ON a.id = p.artifact_id ORDER BY a.file, s.harness, p.role").all();
    assert.deepEqual(
      rows.map((x) => [path.basename(String(x.file)), x.harness, x.session_id, x.role]),
      [
        ["other.html", "dsh", "project-listener", "listener"],
        ["plan.html", "copilot", COPILOT, "editor"],
        ["plan.html", "copilot", COPILOT, "listener"],
        ["plan.html", "dsh", DSH, "listener"],
        ["plan.html", "dsh", "project-listener", "listener"],
        ["plan.html", "omp", OMP, "author"],
        ["plan.html", "omp", OMP, "listener"],
      ],
    );
    assert.equal(rows.find((x) => x.harness === "omp")?.session_file, `/sessions/${OMP}.jsonl`);
  } finally {
    db.close();
  }

  r = await cli({}, ["sessions", "list", FILE]);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /harness: omp\n\s+id: "556666"\n\s+role: author, listener\n\s+last_seen: \d{4}-\d\d-\d\d \d\d:\d\d\n\s+liveness: (alive|exited|unknown)/);
  assert.match(r.out, /harness: copilot\n\s+id: "667777"\n\s+role: editor, listener\n/);
  assert.ok(!r.out.includes(OMP) && !r.out.includes(COPILOT), "only short ids");
  r = await cli({}, ["sessions", "list", "--project", PROJECT]);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /project: shop/);
  assert.match(r.out, /file: "?.*other\.html"?\n\s+harness: dsh\n\s+id: stener\n\s+role: listener/);
  r = await cli({}, ["sessions", "list", path.join(PROJECT, "never.html")]);
  assert.match(r.out, /sessions: none/);
  r = await cli({}, ["sessions", "frob"]);
  assert.equal(r.code, 2, r.out);
});

test("a harness process named omp runs the CLI: its pid is recorded, alive while it runs, exited once killed", { skip: process.platform === "win32" && "no process table on Windows" }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "austere-fake-omp-"));
  const script = path.join(dir, "omp");
  const sid = "fa4e0001-5555-4222-8333-4444555fa4e0";
  fs.writeFileSync(script, `#!/bin/sh\n"$NODE" "$MAIN" patch "$FILE" <<'EOF'\nintro = TextContent("from omp")\nEOF\necho fake-omp-ready\nsleep 60\n`, { mode: 0o755 });
  const child = spawn(script, [], { env: { ...BASE, NODE: process.execPath, MAIN, FILE: OTHER, PI_SESSION_ID: sid }, detached: true });
  try {
    const out = await new Promise<string>((resolve) => {
      let text = "";
      child.stdout.on("data", (c: Buffer) => {
        text += c;
        if (text.includes("fake-omp-ready")) resolve(text);
      });
      child.on("close", () => resolve(text));
    });
    assert.equal(line(out), "omp 5fa4e0 registered", out);
    const db = new DatabaseSync(path.join(STATE, "hub.db"), { readOnly: true });
    let row: { pid: number | null; pid_start: string | null };
    try {
      row = db.prepare("SELECT pid, pid_start FROM agent_sessions WHERE harness = 'omp' AND session_id = ?").get(sid) as { pid: number | null; pid_start: string | null };
    } finally {
      db.close();
    }
    assert.equal(row.pid, child.pid, "the fake omp is the recorded harness process");
    assert.equal(liveness(row), "alive");
    assert.match((await cli({}, ["sessions", "list", OTHER])).out, /id: 5fa4e0\n(.*\n){2}\s+liveness: alive/);

    const closed = new Promise((resolve) => child.on("exit", resolve));
    process.kill(-(child.pid as number), "SIGKILL");
    await closed;
    assert.equal(liveness(row), "exited");
    assert.match((await cli({}, ["sessions", "list", OTHER])).out, /id: 5fa4e0\n(.*\n){2}\s+liveness: exited/);
  } finally {
    try {
      process.kill(-(child.pid as number), "SIGKILL");
    } catch {
      // already gone
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
