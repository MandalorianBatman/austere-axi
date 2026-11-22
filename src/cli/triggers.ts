// Activity triggers (RLM-360, Q9, A8): run a command once a project has gone quiet. The first "on
// event" facility of the core, generic: the wiki's ingest is the first user, nothing here knows it.
//
// `<state>/triggers.json` names the commands; only `trigger add` at a terminal writes it, and it is
// read only from the state dir, never from a project or a page (docs/review-loop-v2.md "Security").
// What a trigger last saw is kept in hub.db `trigger_state`, so the file stays the owner's to edit.
// A run is a row of `runs` with kind `trigger`, no page, its project and its trigger: the same log,
// limits (attach.json) and stop as a note's run (RLM-345).
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type * as sqlite from "node:sqlite";
import { findOnPath, spawnSpec } from "./adapters/index.ts";
import {
  DEFAULT_ATTACH_LIMITS,
  KILL_GRACE_MS,
  LOG_CAP,
  groupAlive,
  killTree,
  logTail,
  newRunId,
  readAttachLimits,
  runEnv,
  runsDir,
  startOf,
  withCliShim,
} from "./dispatch.ts";
import type { AttachLimits, RunReasonCode, RunRow } from "./dispatch.ts";
import { stateDir } from "./paths.ts";
import { findProject, listProjects } from "./projects.ts";

const FORMAT = 1;
const HOUR_MS = 3_600_000;
const TRIGGER_ID = /^t[a-f0-9]{6,16}$/;

/** An entry of triggers.json. */
export interface Trigger {
  id: string;
  /** A project: its name, id, or a folder inside one of its roots. */
  project: string;
  /** `quiet:<duration>`: no revision and no note in the project for that long. */
  on: string;
  /** The command: the binary, then its arguments. Run with no shell. */
  run: string[];
  /** The longest the command may run (`30m`, `2h`); attach.json's `maxMinutes` when absent. */
  maxTime?: string;
}

export function triggersFile(): string {
  return path.join(stateDir(), "triggers.json");
}

/** `90s`, `30m`, `2h` or `1d`, in ms; null when it is none of those or is zero. */
export function parseDuration(text: string): number | null {
  const m = /^(\d{1,4})([smhd])$/.exec(text.trim());
  if (!m || Number(m[1]) === 0) return null;
  return (
    Number(m[1]) * { s: 1000, m: 60_000, h: HOUR_MS, d: 86_400_000 }[m[2] as "s" | "m" | "h" | "d"]
  );
}

/** The quiet period of `quiet:<duration>`, in ms; null for any other `on`. */
export function quietMs(on: string): number | null {
  const m = /^quiet:(.+)$/.exec(on);
  return m ? parseDuration(m[1]) : null;
}

/** The triggers in triggers.json (none without the file). A malformed file throws, naming it. */
export function readTriggers(): Trigger[] {
  const file = triggersFile();
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  const bad = (why: string) => new Error(`${file} is malformed (${why}); ask the user to fix it`);
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    throw bad("not JSON");
  }
  const list =
    data && typeof data === "object" && !Array.isArray(data)
      ? (data as { triggers?: unknown }).triggers
      : undefined;
  if (!Array.isArray(list)) throw bad('no "triggers" list');
  const seen = new Set<string>();
  return list.map((e, i): Trigger => {
    const at = `triggers[${i}]`;
    if (!e || typeof e !== "object" || Array.isArray(e)) throw bad(`${at} is not an object`);
    const { id, project, on, run, maxTime } = e as Record<string, unknown>;
    if (typeof id !== "string" || !TRIGGER_ID.test(id) || seen.has(id))
      throw bad(`${at}.id must be a unique id like t0a1b2c3`);
    seen.add(id);
    if (typeof project !== "string" || !project.trim())
      throw bad(`${at}.project must be a project name, id or folder`);
    if (typeof on !== "string" || quietMs(on) === null)
      throw bad(`${at}.on must be quiet:<duration>, like quiet:2h`);
    if (!Array.isArray(run) || !run.length || !run.every((w) => typeof w === "string") || !run[0])
      throw bad(`${at}.run must be [binary, …arguments]`);
    if (maxTime !== undefined && (typeof maxTime !== "string" || parseDuration(maxTime) === null))
      throw bad(`${at}.maxTime must be a duration like 30m`);
    return {
      id,
      project,
      on,
      run: run as string[],
      ...(maxTime === undefined ? {} : { maxTime: maxTime as string }),
    };
  });
}

/** Write triggers.json: mode 0600, a temp file renamed over it. */
export function writeTriggers(list: Trigger[]): void {
  const file = triggersFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ format: FORMAT, triggers: list }, null, 2) + "\n", {
    mode: 0o600,
  });
  fs.renameSync(tmp, file);
}

export function newTriggerId(): string {
  return `t${crypto.randomBytes(4).toString("hex")}`;
}

/** What `trigger list` shows of a trigger: the entry and where it stands. */
export interface TriggerStatus {
  trigger: Trigger;
  project: string | null;
  lastRun: { id: string; status: string; at: number | null } | null;
  lastCursor: number;
}

export function triggerStatus(db: sqlite.DatabaseSync, list = readTriggers()): TriggerStatus[] {
  return list.map((trigger) => {
    let project: string | null = null;
    try {
      project = findProject(db, trigger.project)?.name ?? null;
    } catch {
      // several projects of that name: the trigger names none until it is fixed
    }
    const last = db
      .prepare(
        "SELECT id, status, started_at FROM runs WHERE trigger_id = ? ORDER BY rowid DESC LIMIT 1",
      )
      .get(trigger.id) as unknown as
      | { id: string; status: string; started_at: number | null }
      | undefined;
    const state = db
      .prepare("SELECT last_cursor FROM trigger_state WHERE trigger_id = ?")
      .get(trigger.id) as unknown as { last_cursor: number } | undefined;
    return {
      trigger,
      project,
      lastRun: last ? { id: last.id, status: last.status, at: last.started_at } : null,
      lastCursor: state?.last_cursor ?? 0,
    };
  });
}

// ── what a project did ──

/** The newest revision id of a project's pages (0 for none): the cursor `changes --since` takes. */
export function headCursor(db: sqlite.DatabaseSync, projectId: string): number {
  return Number(
    (
      db
        .prepare(
          "SELECT COALESCE(MAX(r.id), 0) AS n FROM revisions r JOIN artifacts a ON a.id = r.artifact_id WHERE a.project_id = ?",
        )
        .get(projectId) as unknown as { n: number }
    ).n,
  );
}

/**
 * When the project last did anything since the trigger last ran: a revision after its cursor, or a
 * note after its last run. Null when it did nothing: no run is due.
 */
export function lastActivity(
  db: sqlite.DatabaseSync,
  projectId: string,
  cursor: number,
  since: number,
): number | null {
  const rev = db
    .prepare(
      "SELECT MAX(r.at) AS at FROM revisions r JOIN artifacts a ON a.id = r.artifact_id WHERE a.project_id = ? AND r.id > ?",
    )
    .get(projectId, cursor) as unknown as { at: number | null };
  const note = db
    .prepare(
      "SELECT MAX(n.at) AS at FROM notes n JOIN artifacts a ON a.id = n.artifact_id WHERE a.project_id = ? AND n.at > ? AND n.state != 'discarded'",
    )
    .get(projectId, since) as unknown as { at: number | null };
  const at = Math.max(rev.at ?? 0, note.at ?? 0);
  return at > 0 ? at : null;
}

// ── the scheduler ──

/** A trigger run in progress. */
interface Running {
  row: RunRow;
  trigger: Trigger;
  child: ChildProcess;
  logFd: number;
  logged: number;
  stopped: boolean;
  timedOut: boolean;
  timer: NodeJS.Timeout;
  done: Promise<void>;
  resolve: () => void;
}

export interface SchedulerOptions {
  db: sqlite.DatabaseSync;
  /** The port this server listens on: the command's CLI talks to it. */
  port: number;
  log: (...a: unknown[]) => void;
  /** The environment runs start from (tests put fakes on PATH). */
  env?: NodeJS.ProcessEnv;
  /** The clock; tests move it. */
  now?: () => number;
  /** How often to look; 0 starts no timer (tests call `tick`). */
  pollMs?: number;
}

export class TriggerScheduler {
  private o: SchedulerOptions;
  private running = new Map<string, Running>();
  private interval: NodeJS.Timeout | undefined;
  private closed = false;
  /** Trouble already logged, so a broken triggers.json is said once, not at every look. */
  private said = new Set<string>();

  constructor(o: SchedulerOptions) {
    this.o = o;
  }

  private get db(): sqlite.DatabaseSync {
    return this.o.db;
  }

  private now(): number {
    return (this.o.now ?? Date.now)();
  }

  private limits(): AttachLimits {
    try {
      return readAttachLimits();
    } catch (err) {
      this.say("attach-config", (err as Error).message);
      return { ...DEFAULT_ATTACH_LIMITS };
    }
  }

  private say(key: string, message: string): void {
    if (this.said.has(`${key}:${message}`)) return;
    this.said.add(`${key}:${message}`);
    this.o.log("trigger", key, message);
  }

  /**
   * After a restart: a trigger run the restart interrupted (the dispatcher marked it) gives back
   * what it consumed, so the activity it was started for starts it again. Then the timer.
   */
  start(): void {
    const rows = this.db
      .prepare(
        "SELECT * FROM runs WHERE kind = 'trigger' AND status = 'interrupted' AND trigger_id IS NOT NULL ORDER BY rowid",
      )
      .all() as unknown as RunRow[];
    for (const row of rows) {
      const later = this.db
        .prepare(
          "SELECT 1 FROM runs WHERE trigger_id = ? AND rowid > (SELECT rowid FROM runs WHERE id = ?) LIMIT 1",
        )
        .get(row.trigger_id, row.id);
      if (later || row.seq_from == null) continue;
      // Notes count after the trigger's last run, and a launch moves that to its own start: give back the one before it (none: every note) so a note-only run starts again too.
      const prev = this.db
        .prepare(
          "SELECT MAX(started_at) AS at FROM runs WHERE trigger_id = ? AND id != ? AND rowid < (SELECT rowid FROM runs WHERE id = ?)",
        )
        .get(row.trigger_id, row.id, row.id) as unknown as { at: number | null };
      this.db
        .prepare("UPDATE trigger_state SET last_cursor = ?, last_run_at = ? WHERE trigger_id = ?")
        .run(row.seq_from, prev.at, row.trigger_id);
    }
    const every = this.o.pollMs ?? 15_000;
    if (every > 0) {
      this.interval = setInterval(() => this.tick(), every);
      this.interval.unref();
      setImmediate(() => this.tick());
    }
  }

  /** Look at every trigger: start the ones whose project has been quiet long enough since it last did anything. */
  tick(): void {
    if (this.closed) return;
    let list: Trigger[];
    try {
      list = readTriggers();
    } catch (err) {
      this.say("config", (err as Error).message);
      return;
    }
    for (const t of list) {
      try {
        this.consider(t);
      } catch (err) {
        this.say(t.id, `could not look at the trigger: ${(err as Error).message}`);
      }
    }
  }

  private consider(t: Trigger): void {
    // One run at a time per trigger: what comes while it runs is looked at when it ends.
    for (const r of this.running.values()) if (r.trigger.id === t.id) return;
    const quiet = quietMs(t.on) as number;
    let project;
    try {
      project = findProject(this.db, t.project);
    } catch (err) {
      return this.say(t.id, (err as Error).message);
    }
    // A project that is not there yet (no page opened in it) is waited for.
    if (!project) return;
    const now = this.now();
    let state = this.db
      .prepare("SELECT last_cursor, last_run_at FROM trigger_state WHERE trigger_id = ?")
      .get(t.id) as unknown as { last_cursor: number; last_run_at: number | null } | undefined;
    if (!state) {
      // A trigger starts from now: what happened before it was added is not its activity.
      state = { last_cursor: headCursor(this.db, project.id), last_run_at: now };
      this.db
        .prepare(
          "INSERT INTO trigger_state (trigger_id, last_cursor, last_run_at) VALUES (?, ?, ?)",
        )
        .run(t.id, state.last_cursor, state.last_run_at);
    }
    const last = lastActivity(this.db, project.id, state.last_cursor, state.last_run_at ?? 0);
    if (last === null || now - last < quiet) return;
    const limits = this.limits();
    if (this.running.size >= limits.maxConcurrent) return;
    this.launch(t, project.id, project.name, state.last_cursor, limits, now);
  }

  /** Record a run that did not start, and consume the activity it was for. */
  private refuse(
    id: string,
    t: Trigger,
    projectId: string,
    head: number,
    now: number,
    reason: RunReasonCode,
    message: string,
  ): void {
    let logFile: string | null = null;
    try {
      logFile = path.join(runsDir(), `${id}.log`);
      fs.writeFileSync(logFile, `[austere-axi] failed (${reason}): ${message}\n`, { mode: 0o600 });
    } catch {
      logFile = null;
    }
    this.db
      .prepare(
        "INSERT INTO runs (id, kind, artifact_id, project_id, trigger_id, status, reason, started_at, ended_at, log_file) VALUES (?, 'trigger', NULL, ?, ?, 'failed', ?, ?, ?, ?)",
      )
      .run(id, projectId, t.id, reason, now, now, logFile);
    this.db
      .prepare("UPDATE trigger_state SET last_cursor = ?, last_run_at = ? WHERE trigger_id = ?")
      .run(head, now, t.id);
    this.o.log("trigger-run", id, t.id, "failed", reason);
  }

  private launch(
    t: Trigger,
    projectId: string,
    projectName: string,
    cursor: number,
    limits: AttachLimits,
    now: number,
  ): void {
    const id = newRunId();
    const head = headCursor(this.db, projectId);
    const started = Number(
      (
        this.db
          .prepare("SELECT COUNT(*) AS n FROM runs WHERE trigger_id = ? AND started_at >= ?")
          .get(t.id, now - HOUR_MS) as { n: number }
      ).n,
    );
    if (started >= limits.runsPerHour) {
      return this.refuse(
        id,
        t,
        projectId,
        head,
        now,
        "rate_limit",
        `${started} runs of trigger ${t.id} started in the last hour; the limit is ${limits.runsPerHour} (runsPerHour in attach.json).`,
      );
    }
    const root = listProjects(this.db).find((p) => p.id === projectId)?.roots[0]?.root;
    if (!root || !fs.existsSync(root))
      return this.refuse(
        id,
        t,
        projectId,
        head,
        now,
        "unavailable",
        `The first folder of project ${projectName} is not there: ${root ?? "the project has no folder"}.`,
      );
    const env = runEnv(id, this.o.port, this.o.env ?? process.env);
    env.AUSTERE_AXI_PROJECT = projectName;
    env.AUSTERE_AXI_CHANGES_CURSOR = String(cursor);
    let logFile: string;
    let logFd: number;
    let childEnv: NodeJS.ProcessEnv;
    try {
      logFile = path.join(runsDir(), `${id}.log`);
      logFd = fs.openSync(logFile, "a", 0o600);
      childEnv = withCliShim(env);
    } catch (err) {
      return this.refuse(
        id,
        t,
        projectId,
        head,
        now,
        "unavailable",
        `Could not write the run's files: ${(err as Error).message}`,
      );
    }
    // Looked up in the run's own PATH, so a command that is `austere-axi` finds the shim on a machine without a global install.
    const bin = findOnPath(t.run[0], childEnv, process.platform, root);
    if (!bin) {
      fs.closeSync(logFd);
      return this.refuse(
        id,
        t,
        projectId,
        head,
        now,
        "unavailable",
        `${t.run[0]} not found (PATH, or relative to ${root}).`,
      );
    }
    const spec = spawnSpec(bin, t.run.slice(1), process.platform, childEnv);
    const row: RunRow = {
      id,
      kind: "trigger",
      artifact_id: null,
      project_id: projectId,
      agent_session_id: null,
      harness: path.basename(bin),
      mode: null,
      model: null,
      seq_from: cursor,
      seq_to: head,
      started_at: now,
      ended_at: null,
      exit_code: null,
      status: "running",
      reason: null,
      log_file: logFile,
      requeued_from: null,
      pid: null,
      pid_start: null,
      bin: path.basename(spec.file),
      trigger_id: t.id,
    };
    // `seq_from` is the cursor the trigger had before this run and `seq_to` the one it has after: an interrupted run gives the first back (start).
    this.db
      .prepare(
        "INSERT INTO runs (id, kind, artifact_id, project_id, trigger_id, harness, seq_from, seq_to, started_at, status, log_file, bin) VALUES (?, 'trigger', NULL, ?, ?, ?, ?, ?, ?, 'running', ?, ?)",
      )
      .run(id, projectId, t.id, row.harness, cursor, head, now, logFile, row.bin);
    // From now on the activity it was started for is consumed; what comes while it runs schedules exactly one more.
    this.db
      .prepare("UPDATE trigger_state SET last_cursor = ?, last_run_at = ? WHERE trigger_id = ?")
      .run(head, now, t.id);
    let child: ChildProcess;
    try {
      child = spawn(spec.file, spec.args, {
        cwd: root,
        env: childEnv,
        stdio: ["ignore", "pipe", "pipe"],
        detached: process.platform !== "win32",
        windowsHide: true,
        windowsVerbatimArguments: spec.windowsVerbatimArguments,
      });
    } catch (err) {
      fs.closeSync(logFd);
      this.db
        .prepare(
          "UPDATE runs SET status = 'failed', reason = 'unavailable', ended_at = ? WHERE id = ?",
        )
        .run(this.now(), id);
      return this.o.log("trigger-run", id, t.id, "failed", (err as Error).message);
    }
    const { promise: done, resolve } = Promise.withResolvers<void>();
    const maxMs = (t.maxTime ? parseDuration(t.maxTime) : null) ?? limits.maxMinutes * 60_000;
    const r: Running = {
      row,
      trigger: t,
      child,
      logFd,
      logged: 0,
      stopped: false,
      timedOut: false,
      timer: setTimeout(() => {
        r.timedOut = true;
        this.kill(r);
      }, maxMs),
      done,
      resolve,
    };
    this.running.set(id, r);
    const write = (chunk: Buffer) => {
      if (r.logged >= LOG_CAP) return;
      const part =
        chunk.length > LOG_CAP - r.logged ? chunk.subarray(0, LOG_CAP - r.logged) : chunk;
      try {
        fs.writeSync(r.logFd, part);
        r.logged += part.length;
        if (r.logged >= LOG_CAP) fs.writeSync(r.logFd, "\n[austere-axi] log truncated at 1 MB\n");
      } catch {
        r.logged = LOG_CAP;
      }
    };
    child.stdout?.on("data", write);
    child.stderr?.on("data", write);
    let exited = false;
    child.on("error", (err) => {
      if (exited) return;
      exited = true;
      write(Buffer.from(`[austere-axi] could not start ${bin}: ${err.message}\n`));
      this.finish(r, null, "unavailable");
    });
    child.on("exit", (code) => {
      if (exited) return;
      exited = true;
      let finished = false;
      const settle = () => {
        if (finished) return;
        finished = true;
        child.stdout?.destroy();
        child.stderr?.destroy();
        this.finish(r, code, null);
      };
      child.once("close", settle);
      setTimeout(settle, 2000).unref();
    });
    if (child.pid)
      this.db
        .prepare("UPDATE runs SET pid = ?, pid_start = ? WHERE id = ?")
        .run(child.pid, startOf(child.pid), id);
    this.o.log("trigger-run", id, t.id, "running", `project=${projectName}`, `cursor=${cursor}`);
  }

  /** SIGTERM to the command's process tree, SIGKILL after 5 s for what is left. */
  private kill(r: Running): void {
    const pid = r.child.pid;
    if (!pid) return;
    killTree(pid, "SIGTERM");
    setTimeout(() => {
      if (groupAlive(pid)) killTree(pid, "SIGKILL");
    }, KILL_GRACE_MS).unref();
  }

  private finish(r: Running, code: number | null, forced: RunReasonCode | null): void {
    clearTimeout(r.timer);
    this.running.delete(r.row.id);
    if (this.closed) {
      // close() killed it: the row stays `running`, so the next start marks it interrupted and gives its cursor back.
      try {
        fs.closeSync(r.logFd);
      } catch {
        // closed already
      }
      r.resolve();
      return;
    }
    let status: "done" | "failed" | "stopped" = "done";
    let reason: RunReasonCode | null = null;
    let message: string | undefined;
    if (r.stopped) [status, reason, message] = ["stopped", "stopped", "Stopped by the owner."];
    else if (forced) [status, reason] = ["failed", forced];
    else if (r.timedOut)
      [status, reason, message] = [
        "failed",
        "timeout",
        "The command passed its time limit and was killed.",
      ];
    else if (code !== 0)
      [status, reason, message] = [
        "failed",
        "exit",
        `The command exited with ${code ?? "a signal"}.`,
      ];
    try {
      if (message) fs.writeSync(r.logFd, `[austere-axi] ${status} (${reason}): ${message}\n`);
      fs.closeSync(r.logFd);
    } catch {
      // the log is best effort
    }
    try {
      this.db
        .prepare("UPDATE runs SET status = ?, reason = ?, exit_code = ?, ended_at = ? WHERE id = ?")
        .run(status, reason, code, this.now(), r.row.id);
      this.o.log(
        "trigger-run",
        r.row.id,
        r.trigger.id,
        status,
        reason ?? "",
        `exit=${code}`,
        ...(status === "failed" ? logTail(r.row.log_file, 3) : []),
      );
    } catch (err) {
      this.o.log("trigger-run-finish", r.row.id, (err as Error).message);
    }
    r.resolve();
    // Activity that came while it ran is looked at now, not at the next timer.
    setImmediate(() => this.tick());
  }

  /** The runs in progress. */
  get active(): number {
    return this.running.size;
  }

  /** Stop the trigger runs of a project (every project without one); resolves when their processes are gone. Returns how many. */
  async stop(projectId?: string): Promise<number> {
    const waits: Promise<void>[] = [];
    let n = 0;
    for (const r of this.running.values()) {
      if (projectId && r.row.project_id !== projectId) continue;
      r.stopped = true;
      this.kill(r);
      waits.push(r.done);
      n++;
    }
    await Promise.all(waits);
    return n;
  }

  /** Stop the timer and kill every command's tree; their rows stay `running` for the next start's recovery. */
  async close(): Promise<void> {
    this.closed = true;
    clearInterval(this.interval);
    const runs = [...this.running.values()];
    const pids: number[] = [];
    for (const r of runs) {
      clearTimeout(r.timer);
      if (r.child.pid) {
        killTree(r.child.pid, "SIGTERM");
        pids.push(r.child.pid);
      }
    }
    if (!runs.length) return;
    const wait = (ms: number) => new Promise((res) => setTimeout(res, ms));
    for (const deadline = Date.now() + 1000; pids.some(groupAlive) && Date.now() < deadline;)
      await wait(50);
    for (const pid of pids) if (groupAlive(pid)) killTree(pid, "SIGKILL");
    await Promise.race([Promise.all(runs.map((r) => r.done)), wait(500)]);
  }
}
