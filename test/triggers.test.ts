// Activity triggers (RLM-360): a command the owner named at a terminal runs once a project has gone
// quiet. The scheduler is driven with a fake clock and a fake command; one test runs the real
// server end to end. `triggers.json` is read from the state dir only.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { Hub, SCHEMA_VERSION, openDatabase } from "../src/cli/hub.ts";
import { recordRevision } from "../src/cli/history.ts";
import { TriggerScheduler, readTriggers, writeTriggers } from "../src/cli/triggers.ts";
import type { Trigger } from "../src/cli/triggers.ts";
import { sessionId } from "../src/cli/sessions.ts";
import { freePort } from "./port.ts";

const ROOT = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "austere-triggers-")));
const STATE = path.join(ROOT, "state");
const PROJECT = path.join(ROOT, "shop");
const FILE = path.join(PROJECT, "plan.html");
const OUT = path.join(ROOT, "out.log");
const GATE = path.join(ROOT, "gate");
fs.mkdirSync(STATE);
fs.mkdirSync(path.join(PROJECT, ".git"), { recursive: true });
process.env.AUSTERE_AXI_STATE_DIR = STATE;
for (const name of [
  "PI_SESSION_ID",
  "PI_SESSION_FILE",
  "COPILOT_AGENT_SESSION_ID",
  "DSH_SESSION_ID",
  "AUSTERE_AXI_RUN_ID",
])
  delete process.env[name];

/** A fake command: it records its project, cursor and folder, then either ends or waits for the gate file. */
const FAKE = path.join(ROOT, "fake.mjs");
fs.writeFileSync(
  FAKE,
  `import fs from "node:fs";
fs.appendFileSync(${JSON.stringify(OUT)}, [process.env.AUSTERE_AXI_PROJECT, process.env.AUSTERE_AXI_CHANGES_CURSOR, process.cwd(), process.env.AUSTERE_AXI_RUN_ID ? "run" : "norun", process.env.AUSTERE_AXI_OWNER_KEY ? "KEY" : "nokey"].join("|") + "\\n");
const mode = process.argv[2] || "ok";
if (mode === "wait") while (!fs.existsSync(${JSON.stringify(GATE)})) await new Promise((r) => setTimeout(r, 25));
if (mode === "fail") process.exit(3);
if (mode === "hang") setInterval(() => {}, 1000);
`,
);

const html = (
  program: string,
) => `<!doctype html><html><head><title>Plan</title><script src="https://cdn.jsdelivr.net/npm/austere-axi@0/dist/austere.js"></script></head>
<body><script type="text/openui">
${program}
</script></body></html>
`;
const program = (text: string) =>
  `root = Stack([intro])\nintro = TextContent(${JSON.stringify(text)})`;

let clock = 1_000_000_000_000;
const db: DatabaseSync = await openDatabase(path.join(STATE, "hub.db"));
const hub = new Hub(db);
const id = sessionId(FILE);
const scheduler = new TriggerScheduler({
  db,
  port: 1,
  log: (...a) => {
    if (process.env.TRG_DEBUG) console.log("LOG", ...a);
  },
  pollMs: 0,
  now: () => clock,
});
const TRIGGER: Trigger = {
  id: "t0a1b2c3d",
  project: PROJECT,
  on: "quiet:10m",
  run: [process.execPath, FAKE],
};

const lines = (): string[] =>
  fs.existsSync(OUT) ? fs.readFileSync(OUT, "utf8").split("\n").filter(Boolean) : [];
const runs = () =>
  db
    .prepare(
      "SELECT id, kind, artifact_id, project_id, trigger_id, status, reason, seq_from, seq_to, exit_code FROM runs WHERE kind = 'trigger' ORDER BY rowid",
    )
    .all() as unknown as {
    id: string;
    kind: string;
    artifact_id: string | null;
    project_id: string;
    trigger_id: string;
    status: string;
    reason: string | null;
    seq_from: number;
    seq_to: number;
    exit_code: number | null;
  }[];
const patch = (text: string) =>
  recordRevision(db, id, html(program(text)), { source: "patch", at: clock });
const minutes = (n: number) => (clock += n * 60_000);

async function settled(what: string, ok: () => boolean) {
  const deadline = Date.now() + 10_000;
  while (!ok()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

before(() => {
  fs.mkdirSync(PROJECT, { recursive: true });
  fs.writeFileSync(FILE, html(program("first")));
  hub.register({ id, file: FILE, title: "Plan", at: clock });
  patch("first");
});

after(async () => {
  await scheduler.close();
  db.close();
  fs.rmSync(ROOT, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
});

test("a trigger fires once after the quiet period, with the project, the cursor and the first folder; not again without new activity", async () => {
  writeTriggers([TRIGGER]);
  scheduler.tick();
  assert.deepEqual(
    lines(),
    [],
    "a trigger starts from now: what happened before it was added is not its activity",
  );

  minutes(1);
  patch("second");
  minutes(5);
  scheduler.tick();
  assert.deepEqual(lines(), [], "not quiet for 10 minutes yet");
  minutes(6);
  scheduler.tick();
  await settled("the command to run", () => lines().length === 1 && runs()[0]?.status === "done");
  const [project, cursor, cwd, run, key] = lines()[0].split("|");
  assert.equal(project, path.basename(PROJECT));
  assert.equal(cursor, "1", "the cursor the trigger had seen: the first revision");
  assert.equal(cwd, PROJECT, "the project's first folder");
  assert.equal(run, "run");
  assert.equal(key, "nokey", "never the owner key");

  const [row] = runs();
  assert.deepEqual(
    [row.kind, row.artifact_id, row.trigger_id, row.status, row.exit_code],
    ["trigger", null, TRIGGER.id, "done", 0],
    "a run with no page",
  );
  assert.deepEqual([row.seq_from, row.seq_to], [1, 2], "the cursor before and after");

  minutes(60);
  scheduler.tick();
  scheduler.tick();
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(lines().length, 1, "no activity since its last run, no run");
});

test("activity during a run schedules exactly one more run", async () => {
  const slow: Trigger = { ...TRIGGER, run: [process.execPath, FAKE, "wait"] };
  writeTriggers([slow]);
  minutes(1);
  patch("third");
  minutes(11);
  const before = lines().length;
  scheduler.tick();
  await settled("the slow command to start", () => lines().length === before + 1);
  assert.equal(runs().at(-1)?.status, "running");

  // While it runs: more activity, and ticks that must not start a second copy.
  minutes(1);
  patch("fourth");
  minutes(20);
  scheduler.tick();
  scheduler.tick();
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(lines().length, before + 1, "one run at a time per trigger");

  fs.writeFileSync(GATE, "go");
  await settled("the first run to end and the next to start", () => lines().length === before + 2);
  await settled("the second run to end", () => runs().at(-1)?.status === "done");
  assert.deepEqual(
    runs()
      .slice(-2)
      .map((r) => r.status),
    ["done", "done"],
  );
  assert.equal(
    lines().at(-1)?.split("|")[1],
    "3",
    "the second run's cursor is where the first one's ended",
  );
  await new Promise((r) => setTimeout(r, 200));
  scheduler.tick();
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(lines().length, before + 2, "and then no more");
  fs.rmSync(GATE);
});

test("a command that fails is a failed run; one that outlives its maxTime is killed; run stop ends a running one", async () => {
  writeTriggers([{ ...TRIGGER, run: [process.execPath, FAKE, "fail"] }]);
  minutes(1);
  patch("fifth");
  minutes(11);
  scheduler.tick();
  await settled("the failing run", () => runs().at(-1)?.status === "failed");
  assert.deepEqual([runs().at(-1)?.reason, runs().at(-1)?.exit_code], ["exit", 3]);

  writeTriggers([{ ...TRIGGER, run: [process.execPath, FAKE, "hang"], maxTime: "1s" }]);
  minutes(1);
  patch("sixth");
  minutes(11);
  scheduler.tick();
  await settled(
    "the timeout",
    () => runs().at(-1)?.status === "failed" && runs().at(-1)?.reason === "timeout",
  );

  writeTriggers([{ ...TRIGGER, run: [process.execPath, FAKE, "hang"] }]);
  minutes(1);
  patch("seventh");
  minutes(11);
  scheduler.tick();
  await settled("the run to start", () => runs().at(-1)?.status === "running");
  const projectId = runs().at(-1)?.project_id as string;
  assert.equal(await scheduler.stop(projectId), 1);
  assert.deepEqual([runs().at(-1)?.status, runs().at(-1)?.reason], ["stopped", "stopped"]);
});

test("a triggers.json inside a project is ignored; a malformed one in the state dir is said, not run", async () => {
  const outside: Trigger = { ...TRIGGER, id: "tbad00001", run: [process.execPath, FAKE] };
  fs.writeFileSync(
    path.join(PROJECT, "triggers.json"),
    JSON.stringify({ format: 1, triggers: [outside] }),
  );
  writeTriggers([]);
  const before = runs().length;
  minutes(1);
  patch("eighth");
  minutes(60);
  scheduler.tick();
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(runs().length, before, "the project's file started nothing");
  fs.rmSync(path.join(PROJECT, "triggers.json"));

  fs.writeFileSync(path.join(STATE, "triggers.json"), "{ not json");
  assert.throws(() => readTriggers(), /triggers\.json is malformed \(not JSON\)/);
  scheduler.tick();
  fs.writeFileSync(
    path.join(STATE, "triggers.json"),
    JSON.stringify({
      format: 1,
      triggers: [{ id: "t1", project: "p", on: "quiet:2h", run: ["x"] }],
    }),
  );
  assert.throws(() => readTriggers(), /id must be a unique id/);
  fs.writeFileSync(
    path.join(STATE, "triggers.json"),
    JSON.stringify({
      format: 1,
      triggers: [{ id: "t0a1b2c3d", project: "p", on: "every:2h", run: ["x"] }],
    }),
  );
  assert.throws(() => readTriggers(), /on must be quiet:<duration>/);
  fs.rmSync(path.join(STATE, "triggers.json"));
});

test("a run a restart interrupted gives its cursor back, so the activity it was for runs again", async () => {
  writeTriggers([{ ...TRIGGER, id: "tabcdef01" }]);
  scheduler.tick(); // starts from now
  minutes(1);
  patch("ninth");
  const head = Number((db.prepare("SELECT MAX(id) AS n FROM revisions").get() as { n: number }).n);
  // What a crashed server left: a running run that consumed the activity.
  db.prepare(
    "INSERT INTO runs (id, kind, artifact_id, project_id, trigger_id, status, started_at, seq_from, seq_to) VALUES ('rrestart00001', 'trigger', NULL, (SELECT project_id FROM artifacts WHERE id = ?), 'tabcdef01', 'running', ?, ?, ?)",
  ).run(id, clock, head - 1, head);
  db.prepare(
    "UPDATE trigger_state SET last_cursor = ?, last_run_at = ? WHERE trigger_id = 'tabcdef01'",
  ).run(head, clock);
  // The dispatcher marks it interrupted at start; the scheduler then gives the cursor back.
  db.prepare("UPDATE runs SET status = 'interrupted', ended_at = ? WHERE id = 'rrestart00001'").run(
    clock,
  );
  scheduler.start();
  assert.equal(
    (
      db.prepare("SELECT last_cursor FROM trigger_state WHERE trigger_id = 'tabcdef01'").get() as {
        last_cursor: number;
      }
    ).last_cursor,
    head - 1,
  );
  const before = lines().length;
  minutes(11);
  scheduler.tick();
  await settled("the run again", () => lines().length === before + 1);
  assert.equal(lines().at(-1)?.split("|")[1], String(head - 1));
});

test("a restart gives back a note-only run's note, so a note that started a run starts it again", async () => {
  const t: Trigger = { ...TRIGGER, id: "t0a0b0c01" };
  writeTriggers([t]);
  scheduler.tick(); // starts from now
  minutes(1);
  db.prepare(
    "INSERT INTO notes (id, artifact_id, state, items, at) VALUES ('n-restart-1', ?, 'queued', '[]', ?)",
  ).run(id, clock);
  minutes(11);
  const before = lines().length;
  scheduler.tick();
  await settled(
    "the note's run",
    () => lines().length === before + 1 && runs().at(-1)?.status === "done",
  );
  const [row] = runs().slice(-1);
  assert.equal(row.seq_from, row.seq_to, "no revision: the note alone started it");
  db.prepare("UPDATE runs SET status = 'interrupted', ended_at = ? WHERE id = ?").run(
    clock,
    row.id,
  );
  scheduler.start();
  minutes(11);
  scheduler.tick();
  await settled("the note's run again", () => lines().length === before + 2);
});

test("a command that is austere-axi itself is found on a machine with none installed", async () => {
  const empty = path.join(ROOT, "empty-path");
  fs.mkdirSync(empty);
  const bare = new TriggerScheduler({
    db,
    port: 1,
    log: () => {},
    pollMs: 0,
    now: () => clock,
    env: { ...process.env, PATH: empty },
  });
  try {
    writeTriggers([{ ...TRIGGER, id: "t0a0b0c02", run: ["austere-axi", "--help"] }]);
    bare.tick(); // starts from now
    minutes(1);
    patch("shim");
    minutes(11);
    bare.tick();
    await settled("the shim's run", () =>
      runs().some((r) => r.trigger_id === "t0a0b0c02" && r.status !== "running"),
    );
    const r = runs().find((x) => x.trigger_id === "t0a0b0c02");
    assert.notEqual(
      r?.reason,
      "unavailable",
      "the shim is on the run's PATH before the command is looked up",
    );
    assert.equal(r?.status, "done");
  } finally {
    await bare.close();
  }
});

function cli(
  args: string[],
  env: NodeJS.ProcessEnv = {},
): Promise<{ code: number | null; out: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.resolve("src/cli/main.ts"), ...args], {
      env: { ...process.env, ...env },
    });
    let out = "";
    child.stdout.on("data", (c) => (out += c));
    child.stderr.on("data", (c) => (out += c));
    child.stdin.end();
    child.on("close", (code) => resolve({ code, out }));
  });
}

test("trigger add and remove need a terminal: without one they exit 2 and write nothing; list works anywhere", async () => {
  const state = path.join(ROOT, "cli-state");
  fs.mkdirSync(state);
  const env = {
    AUSTERE_AXI_STATE_DIR: state,
    AUSTERE_AXI_PORT: String(await freePort()),
    AUSTERE_AXI_NO_OPEN: "1",
  };
  const add = await cli(
    ["trigger", "add", "--project", PROJECT, "--on", "quiet:2h", "--", "austere-wiki", "ingest"],
    env,
  );
  assert.equal(add.code, 2, add.out);
  assert.match(add.out, /trigger add needs the user at a terminal and changes nothing here/);
  assert.match(
    add.out,
    /austere-axi trigger add --project \S+ --on quiet:2h -- austere-wiki ingest/,
    "the command for the user to run",
  );
  assert.equal(fs.existsSync(path.join(state, "triggers.json")), false, "nothing was written");

  for (const bad of [
    ["--on", "quiet:2h"],
    ["--project", PROJECT, "--on", "daily", "--", "x"],
    ["--project", PROJECT, "--on", "quiet:2h", "--max-time", "soon", "--", "x"],
  ]) {
    const r = await cli(["trigger", "add", ...bad], env);
    assert.equal(r.code, 2, `${bad.join(" ")}: ${r.out}`);
  }

  fs.writeFileSync(
    path.join(state, "triggers.json"),
    JSON.stringify({
      format: 1,
      triggers: [
        {
          id: "tfeed0001",
          project: PROJECT,
          on: "quiet:2h",
          run: ["austere-wiki", "ingest", "--project", "shop"],
        },
      ],
    }),
  );
  const rm = await cli(["trigger", "remove", "tfeed0001"], env);
  assert.equal(rm.code, 2, rm.out);
  assert.equal(readTriggersAt(state).length, 1, "still there");
  assert.equal((await cli(["trigger", "remove", "tnone"], env)).code, 1);

  const none = await cli(["trigger", "list"], {
    ...env,
    AUSTERE_AXI_STATE_DIR: path.join(ROOT, "empty-state"),
  });
  assert.equal(none.code, 0, none.out);
  assert.match(none.out, /triggers: none/);
  const list = await cli(["trigger", "list"], env);
  assert.equal(list.code, 0, list.out);
  assert.match(list.out, /id: tfeed0001/);
  assert.match(list.out, /run: [^\n]*austere-wiki ingest --project shop/);
  assert.match(list.out, /last_run: none/);
});

function readTriggersAt(state: string): unknown[] {
  return (
    JSON.parse(fs.readFileSync(path.join(state, "triggers.json"), "utf8")) as {
      triggers: unknown[];
    }
  ).triggers;
}

test("the server runs a trigger end to end: a patch, the quiet period, one run; run list and run log show it", async () => {
  const state = path.join(ROOT, "e2e-state");
  const work = path.join(ROOT, "e2e-work");
  fs.mkdirSync(path.join(work, ".git"), { recursive: true });
  fs.mkdirSync(state);
  const port = await freePort();
  const mark = path.join(ROOT, "e2e-mark");
  const file = path.join(work, "page.html");
  fs.writeFileSync(file, html(program("hello")));
  fs.writeFileSync(
    path.join(state, "triggers.json"),
    JSON.stringify({
      format: 1,
      triggers: [
        {
          id: "te2e00001",
          project: work,
          on: "quiet:1s",
          run: [
            process.execPath,
            "-e",
            `require("fs").appendFileSync(${JSON.stringify(mark)}, process.env.AUSTERE_AXI_PROJECT + ":" + process.env.AUSTERE_AXI_CHANGES_CURSOR + "\\n"); console.log("ingest ran")`,
          ],
        },
      ],
    }),
  );
  const env = {
    AUSTERE_AXI_STATE_DIR: state,
    AUSTERE_AXI_PORT: String(port),
    AUSTERE_AXI_NO_OPEN: "1",
    AUSTERE_AXI_NO_TAILSCALE: "1",
    AUSTERE_AXI_TRIGGER_POLL_MS: "100",
    AUSTERE_AXI_IDLE_TIMEOUT_MS: "300",
    OPENUI_TELEMETRY_DISABLED: "1",
  };
  try {
    assert.equal((await cli([file], env)).code, 0);
    // The first open is a revision after the trigger was set: but a trigger starts from now, and the server has just started it.
    await new Promise((r) => setTimeout(r, 1500));
    const first = fs.existsSync(mark) ? fs.readFileSync(mark, "utf8").trim().split("\n").length : 0;
    assert.equal(first <= 1, true);
    const patched = await new Promise<{ code: number | null }>((resolve) => {
      const child = spawn(process.execPath, [path.resolve("src/cli/main.ts"), "patch", file], {
        env: { ...process.env, ...env },
      });
      child.stdin.end('intro = TextContent("changed")');
      child.on("close", (code) => resolve({ code }));
    });
    assert.equal(patched.code, 0);
    await settled(
      "the trigger to run after the patch",
      () => fs.existsSync(mark) && fs.readFileSync(mark, "utf8").trim().split("\n").length > first,
    );
    await new Promise((r) => setTimeout(r, 2500));
    const total = fs.readFileSync(mark, "utf8").trim().split("\n");
    assert.equal(
      total.length,
      first + 1,
      "once, though the server idled in between (a trigger keeps it up)",
    );
    assert.match(total.at(-1) as string, new RegExp(`^${path.basename(work)}:\\d+$`));

    const list = await cli(["run", "list", "--project", work], env);
    assert.match(list.out, /trigger: te2e00001/);
    assert.match(list.out, /status: done/);
    const id = /id: (r[a-f0-9]{12})/.exec(list.out)?.[1] as string;
    assert.match((await cli(["run", "log", id], env)).out, /ingest ran/);
    const triggers = await cli(["trigger", "list"], env);
    assert.match(triggers.out, /last_run: done, r[a-f0-9]{12}/);
  } finally {
    await cli(["stop"], env);
  }
});

test("a 0.10.4 hub.db opens with the trigger tables, and a trigger run can be recorded in it", async () => {
  const dir = path.join(ROOT, "migrate");
  fs.mkdirSync(dir);
  fs.copyFileSync(
    path.join(import.meta.dirname, "fixtures", "hub-0.10.4.db"),
    path.join(dir, "hub.db"),
  );
  const columns = (d: DatabaseSync, table: string) =>
    (d.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name);
  const old = new DatabaseSync(path.join(dir, "hub.db"));
  assert.deepEqual(columns(old, "trigger_state"), [], "the fixture predates triggers");
  old.close();
  const opened = await openDatabase(path.join(dir, "hub.db"));
  try {
    assert.equal(opened.prepare("PRAGMA user_version").get()?.user_version, SCHEMA_VERSION);
    assert.ok(SCHEMA_VERSION >= 6);
    assert.deepEqual(columns(opened, "trigger_state"), [
      "trigger_id",
      "last_cursor",
      "last_run_at",
    ]);
    assert.ok(columns(opened, "runs").includes("trigger_id"));
    opened
      .prepare(
        "INSERT INTO runs (id, kind, artifact_id, project_id, trigger_id, status) VALUES ('rmigrated0001', 'trigger', NULL, 'p', 't0a1b2c3d', 'done')",
      )
      .run();
    assert.equal(
      (
        opened.prepare("SELECT COUNT(*) AS n FROM runs WHERE kind = 'trigger'").get() as {
          n: number;
        }
      ).n,
      1,
    );
  } finally {
    opened.close();
  }
});
