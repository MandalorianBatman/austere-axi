// The dispatcher (RLM-345): with attach on, a note the owner sent or released starts the
// attached harness headless, so the agent reads the notes, patches the page and replies with the
// normal CLI. Runs are rows in hub.db `runs`; each has a 0600 prompt file piped on stdin and a
// 0600 log in `<state>/runs/`. Limits come from `<state>/attach.json`, read only from the state
// dir (docs/review-loop-v2.md "Security"). The adapters build the command line; this module
// decides when a run starts, spawns it, times it out, kills its process tree and judges it.
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type * as sqlite from "node:sqlite";
import { adapterFor, capabilitiesOf, findOnPath, spawnSpec } from "./adapters/index.ts";
import { extraArgsFor, isHarness, readAdapters } from "./adapters/config.ts";
import { AdapterError } from "./adapters/types.ts";
import type { Adapter, AttachMode, BuiltCommand, Limits } from "./adapters/types.ts";
import { linkPage, liveness, recordContinuation } from "./agent-sessions.ts";
import type { AgentSessionRow } from "./agent-sessions.ts";
import { runPrompt } from "./agent-prompt.ts";
import { effectiveAttach, newestContinuation, resolveTarget } from "./attach.ts";
import type { RunTarget } from "./attach.ts";
import { systemProcessTable } from "./caller.ts";
import { stateDir } from "./paths.ts";
import { childEnv } from "./service.ts";
import { RENDER_CHECK_AUTHOR } from "./sessions.ts";
import type { QueuedEntry, Session, SessionStore, TranscriptEntry } from "./sessions.ts";

export type RunStatus = "queued" | "waiting_for_session" | "running" | "done" | "failed" | "stopped" | "interrupted";

/**
 * Why a run failed or ended without running (`runs.reason`): the note's list (exit, timeout,
 * no_reply, session_in_use, cost_cap, stopped) plus the dispatcher's refusals (A17–A20).
 */
export type RunReasonCode =
  | "exit"
  | "timeout"
  | "no_reply"
  | "session_in_use"
  | "cost_cap"
  | "stopped"
  | "session_unknown"
  | "unsupported"
  | "unavailable"
  | "rate_limit"
  | "auto_conflict"
  | "config"
  | "listener"
  | "answered"
  | "attach_off";

/** A row of `runs`. */
export interface RunRow {
  id: string;
  kind: "note" | "trigger";
  artifact_id: string | null;
  project_id: string | null;
  agent_session_id: string | null;
  harness: string | null;
  mode: AttachMode | null;
  model: string | null;
  seq_from: number | null;
  seq_to: number | null;
  started_at: number | null;
  ended_at: number | null;
  exit_code: number | null;
  status: RunStatus;
  reason: RunReasonCode | null;
  log_file: string | null;
  requeued_from: string | null;
}

/** What the owner's review page hears about a run (SSE `run`). */
export interface RunSummary {
  id: string;
  status: RunStatus;
  reason: RunReasonCode | null;
  mode: AttachMode | null;
  harness: string | null;
  model: string | null;
  started_at: number | null;
  ended_at: number | null;
  seq_from: number | null;
  seq_to: number | null;
}

export interface RunEvent {
  run: RunSummary;
  /** Why it was refused or failed, in words. */
  message?: string;
  /** The last lines of the log, when it failed. */
  tail?: string[];
}

// ── limits ──

/** `<state>/attach.json`. */
export interface AttachLimits {
  /** Wall clock per run; the process tree is killed after it (A15). */
  maxMinutes: number;
  /** Runs started per page in any hour. */
  runsPerHour: number;
  /** Runs at once on this machine. */
  maxConcurrent: number;
  /** How long after the owner's last note a run starts. */
  debounceMs: number;
  /** How often a run waiting for its session looks again. */
  recheckMs: number;
  /** omp `--max-cost`, in dollars. */
  maxCost?: number;
  /** Copilot `--max-ai-credits`. */
  maxAiCredits?: number;
}

export const DEFAULT_ATTACH_LIMITS: Readonly<AttachLimits> = Object.freeze({ maxMinutes: 15, runsPerHour: 12, maxConcurrent: 2, debounceMs: 5000, recheckMs: 30_000 });

/** The largest value each limit takes: the timers stay within setTimeout's 2^31-1 ms. */
const MAX_ATTACH_LIMITS: Readonly<Record<keyof AttachLimits, number>> = Object.freeze({
  maxMinutes: 24 * 60,
  runsPerHour: 1000,
  maxConcurrent: 16,
  debounceMs: 3_600_000,
  recheckMs: 3_600_000,
  maxCost: Number.MAX_VALUE,
  maxAiCredits: Number.MAX_VALUE,
});

export function attachFile(): string {
  return path.join(stateDir(), "attach.json");
}

/** The limits in attach.json over the defaults; the defaults when there is no file. A malformed file throws, naming it. */
export function readAttachLimits(): AttachLimits {
  const file = attachFile();
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { ...DEFAULT_ATTACH_LIMITS };
    throw err;
  }
  const bad = (why: string) => new Error(`${file} is malformed (${why}); ask the user to fix it`);
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    throw bad("not JSON");
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) throw bad("not an object");
  const out: AttachLimits = { ...DEFAULT_ATTACH_LIMITS };
  for (const [key, value] of Object.entries(data)) {
    if (!Object.hasOwn(MAX_ATTACH_LIMITS, key)) throw bad(`unknown key ${JSON.stringify(key)}`);
    if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) throw bad(`${key} must be a number above 0`);
    if ((key === "runsPerHour" || key === "maxConcurrent") && !Number.isInteger(value)) throw bad(`${key} must be a whole number`);
    const max = MAX_ATTACH_LIMITS[key as keyof AttachLimits];
    if (value > max) throw bad(`${key} must be at most ${max}`);
    out[key as keyof AttachLimits] = value;
  }
  return out;
}

// ── reading runs ──

export function runsDir(): string {
  const dir = path.join(stateDir(), "runs");
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

export function summary(row: RunRow): RunSummary {
  const { id, status, reason, mode, harness, model, started_at, ended_at, seq_from, seq_to } = row;
  return { id, status, reason, mode, harness, model, started_at, ended_at, seq_from, seq_to };
}

/** A run as `run list` shows it: with its copy's file. */
export type ListedRun = RunRow & { file: string | null };

/** The runs of one copy, of every copy in a project, or all of them; the newest first. */
export function listRuns(db: sqlite.DatabaseSync, where: { artifactId: string } | { projectId: string } | null, limit = 50): ListedRun[] {
  const filter = !where ? "" : "artifactId" in where ? "WHERE r.artifact_id = ?" : "WHERE r.project_id = ?";
  const args = !where ? [] : "artifactId" in where ? [where.artifactId] : [where.projectId];
  return db.prepare(`SELECT r.*, a.file AS file FROM runs r LEFT JOIN artifacts a ON a.id = r.artifact_id ${filter} ORDER BY r.rowid DESC LIMIT ?`).all(...args, limit) as unknown as ListedRun[];
}

export function getRun(db: sqlite.DatabaseSync, id: string): RunRow | null {
  return (db.prepare("SELECT * FROM runs WHERE id = ?").get(id) as unknown as RunRow | undefined) ?? null;
}

/** The text of a run's log; null when it has none (yet, or swept after 30 days). */
export function readRunLog(row: RunRow): string | null {
  if (!row.log_file) return null;
  try {
    return fs.readFileSync(row.log_file, "utf8");
  } catch {
    return null;
  }
}

/** The last `n` lines of a log file. */
export function logTail(file: string | null, n = 20): string[] {
  if (!file) return [];
  try {
    const fd = fs.openSync(file, "r");
    try {
      const size = fs.fstatSync(fd).size;
      const len = Math.min(size, 64 * 1024);
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, size - len);
      return buf.toString("utf8").split(/\r?\n/).filter((l) => l !== "").slice(-n);
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return [];
  }
}

// ── processes ──

const LOG_CAP = 1024 * 1024;
const OUTPUT_KEEP = 64 * 1024;
const KILL_GRACE_MS = 5000;
const LOG_DAYS = 30;
const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;
const PID_CHECK_MS = 1000;

/**
 * The caller-detection variables of the harness the server was started from (caller.ts): a run
 * is its own session and must not report the server's. Plus the service manager's markers.
 */
const INHERITED_SESSION_VARS = ["PI_SESSION_ID", "PI_SESSION_FILE", "COPILOT_AGENT_SESSION_ID", "DSH_SESSION_ID"];

/** The environment of a run: the server's, without the markers above, with `AUSTERE_AXI_RUN_ID` and the state dir and port of this server (never the owner key). */
export function runEnv(runId: string, port: number, base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env = childEnv(base);
  for (const name of INHERITED_SESSION_VARS) delete env[name];
  env.AUSTERE_AXI_RUN_ID = runId;
  env.AUSTERE_AXI_STATE_DIR = stateDir();
  env.AUSTERE_AXI_PORT = String(port);
  return env;
}

/** Kill a run's whole process tree: its process group (POSIX, the run is spawned detached), `taskkill /T` on Windows. */
function killTree(pid: number, signal: NodeJS.Signals): void {
  if (process.platform === "win32") {
    spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true }).on("error", () => {});
    return;
  }
  try {
    process.kill(-pid, signal);
  } catch {
    // the group is gone
  }
}

function groupAlive(pid: number): boolean {
  if (process.platform === "win32") return false;
  try {
    process.kill(-pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** A run in progress. */
interface Running {
  row: RunRow;
  s: Session;
  child: ChildProcess;
  adapter: Adapter;
  built: BuiltCommand;
  /** The session the run resumed or forked, when there was one. */
  from: AgentSessionRow | null;
  promptFile: string;
  logFd: number;
  logged: number;
  head: string;
  tail: string;
  stderr: string;
  stopped: boolean;
  timedOut: boolean;
  timer: NodeJS.Timeout;
  done: Promise<void>;
  resolve: () => void;
}

const deliverable = (e: TranscriptEntry): e is QueuedEntry => e.role === "user" && e.seq != null && !e.held && !e.discarded;

/**
 * Why the open notes keep a run from starting (A17), or null: a reviewer's note that has a seq
 * the owner never gave it (no `releasedAt`), as an `--auto` invite, since revoked, gave it. Notes
 * from a hosted page are the hosted page's to release (a hosted `--auto` page is refused as a
 * whole), and the page's own render check is not a reviewer.
 */
export function unreleasedNotes(open: readonly QueuedEntry[]): string | null {
  const notes = open.filter((e) => e.author && e.author !== RENDER_CHECK_AUTHOR && !e.releasedAt && !e.remote);
  if (!notes.length) return null;
  const names = [...new Set(notes.map((e) => e.author))].join(", ");
  const [these, them] = notes.length === 1 ? ["A note", "it"] : [`${notes.length} notes`, "them"];
  return `${these} from ${names} reached the inbox without the owner releasing ${them} (an --auto invite, since revoked), and a run reads only notes the owner sent or released, so it does not start (Q3). Answer or discard ${them} on the review page; to have the agent act on one, send it yourself.`;
}

export interface DispatcherOptions {
  db: sqlite.DatabaseSync;
  store: SessionStore;
  /** The port this server listens on: a run's CLI talks to it. */
  port: number;
  log: (...a: unknown[]) => void;
  /** Whether a poll (the page's own or its project's) holds the page. */
  listening: (s: Session) => boolean;
  /** Why the page takes notes no owner sent (Q3, A17), or null. */
  autoConflict: (s: Session) => string | null;
  /** Tell the owner's review pages of the copy (SSE `run`). */
  emit: (artifactId: string, event: RunEvent) => void;
  /** The environment runs start from (tests put fake harnesses on PATH). */
  env?: NodeJS.ProcessEnv;
}

export class Dispatcher {
  private o: DispatcherOptions;
  private running = new Map<string, Running>();
  /** Copy id → when its debounce ends. */
  private readyAt = new Map<string, number>();
  private timers = new Map<string, NodeJS.Timeout>();
  private intervals: NodeJS.Timeout[] = [];
  private closed = false;
  /** Waiting runs whose wait the owner has heard of: one "Waiting for…" each, not one per recheck. */
  private announced = new Set<string>();

  constructor(o: DispatcherOptions) {
    this.o = o;
  }

  private get db(): sqlite.DatabaseSync {
    return this.o.db;
  }

  private limits(): AttachLimits {
    try {
      return readAttachLimits();
    } catch (err) {
      this.o.log("attach-config", (err as Error).message);
      return { ...DEFAULT_ATTACH_LIMITS };
    }
  }

  /**
   * After a restart: a run that was running or waiting is `interrupted`, and queued once more
   * unless it was itself a requeue. Old logs and stray prompt files go. Then the timers start.
   */
  start(): void {
    const now = Date.now();
    const stale = this.db.prepare("SELECT * FROM runs WHERE status IN ('running', 'waiting_for_session')").all() as unknown as RunRow[];
    for (const row of stale) {
      this.db.prepare("UPDATE runs SET status = 'interrupted', ended_at = ? WHERE id = ?").run(now, row.id);
      if (row.requeued_from || !row.artifact_id) continue;
      this.db
        .prepare("INSERT INTO runs (id, kind, artifact_id, project_id, seq_from, seq_to, status, requeued_from) VALUES (?, ?, ?, ?, ?, ?, 'queued', ?)")
        .run(newRunId(), row.kind, row.artifact_id, row.project_id, row.seq_from, row.seq_to, row.id);
    }
    if (stale.length) this.o.log("runs-interrupted", stale.map((r) => r.id).join(","));
    this.sweep(true);
    const { recheckMs } = this.limits();
    this.intervals.push(
      setInterval(() => this.recheck(false), Math.min(PID_CHECK_MS, recheckMs)),
      setInterval(() => this.recheck(true), recheckMs),
      setInterval(() => this.sweep(false), DAY_MS),
    );
    for (const t of this.intervals) t.unref();
    setImmediate(() => this.pump());
  }

  /**
   * Stop the timers and kill every run's process tree. Their rows stay `running`: the next start
   * marks them interrupted and queues them again (finish leaves a closed dispatcher's rows alone).
   */
  close(): void {
    this.closed = true;
    for (const t of this.intervals) clearInterval(t);
    for (const t of this.timers.values()) clearTimeout(t);
    for (const r of this.running.values()) {
      clearTimeout(r.timer);
      if (r.child.pid) killTree(r.child.pid, "SIGTERM");
    }
  }

  /** Logs older than 30 days go; at start, prompt files a crash left behind go too. */
  private sweep(atStart: boolean): void {
    let dir: string;
    try {
      dir = runsDir();
    } catch {
      return;
    }
    const cutoff = Date.now() - LOG_DAYS * DAY_MS;
    for (const name of fs.readdirSync(dir)) {
      const file = path.join(dir, name);
      try {
        if ((atStart && name.endsWith(".prompt")) || fs.statSync(file).mtimeMs < cutoff) fs.unlinkSync(file);
      } catch {
        // gone already
      }
    }
  }

  // ── triggers ──

  /**
   * A note on `s` got a seq because the owner sent or released it, and no poll held the page
   * (the server reads that before the poll is answered). With attach on, a run is queued (one
   * per copy; a note while one runs queues the next), and starts after the debounce.
   */
  noteSeq(s: Session): void {
    if (this.closed || effectiveAttach(this.db, s.id).state !== "on") return;
    const seq = Math.max(0, ...s.transcript.filter(deliverable).map((e) => e.seq));
    const pending = this.db.prepare("SELECT * FROM runs WHERE artifact_id = ? AND status IN ('queued', 'waiting_for_session') ORDER BY rowid LIMIT 1").get(s.id) as unknown as RunRow | undefined;
    if (pending) this.db.prepare("UPDATE runs SET seq_to = MAX(COALESCE(seq_to, 0), ?) WHERE id = ?").run(seq, pending.id);
    else {
      this.db.prepare("INSERT INTO runs (id, kind, artifact_id, project_id, seq_from, seq_to, status) VALUES (?, 'note', ?, ?, ?, ?, 'queued')").run(newRunId(), s.id, this.o.store.projectIdOf(s), seq, seq);
    }
    const { debounceMs } = this.limits();
    this.readyAt.set(s.id, Date.now() + debounceMs);
    clearTimeout(this.timers.get(s.id));
    const t = setTimeout(() => {
      this.timers.delete(s.id);
      this.pump();
    }, debounceMs);
    t.unref();
    this.timers.set(s.id, t);
  }

  /** A poll arrived for `s`: it gets the notes, so a run that has not started is not needed. */
  pollArrived(s: Session): void {
    const rows = this.db.prepare("SELECT * FROM runs WHERE artifact_id = ? AND status IN ('queued', 'waiting_for_session')").all(s.id) as unknown as RunRow[];
    for (const row of rows) this.end(row, "stopped", "listener", "An agent started polling the page: the notes go to it.");
  }

  /** The owner stops the page's runs: a running one is killed with its process tree, queued and waiting ones end. Resolves when no child is left. */
  async stop(artifactId: string): Promise<number> {
    const rows = this.db.prepare("SELECT * FROM runs WHERE artifact_id = ? AND status IN ('queued', 'waiting_for_session', 'running')").all(artifactId) as unknown as RunRow[];
    const waits: Promise<void>[] = [];
    for (const row of rows) {
      const r = this.running.get(row.id);
      if (r) {
        r.stopped = true;
        this.kill(r);
        waits.push(r.done);
      } else this.end(row, "stopped", "stopped", "Stopped by the owner.");
    }
    await Promise.all(waits);
    return rows.length;
  }

  /**
   * The owner retries the page's last run when it failed: its notes are queued once more, with no
   * debounce. Retry is the owner's act only; a failed run is never retried on its own. Returns the
   * new run, or why there is nothing to retry.
   */
  retry(artifactId: string): { run: RunRow } | { error: string } {
    if (this.closed) return { error: "the server is stopping" };
    if (effectiveAttach(this.db, artifactId).state !== "on") return { error: "attach is off for this page: turn it on first" };
    const last = this.db.prepare("SELECT * FROM runs WHERE artifact_id = ? ORDER BY rowid DESC LIMIT 1").get(artifactId) as unknown as RunRow | undefined;
    if (!last || last.status !== "failed") return { error: last ? `the last run is ${last.status}, not failed` : "this page has no run yet" };
    const id = newRunId();
    this.db.prepare("INSERT INTO runs (id, kind, artifact_id, project_id, seq_from, seq_to, status) VALUES (?, 'note', ?, ?, ?, ?, 'queued')").run(id, artifactId, last.project_id, last.seq_from, last.seq_to);
    this.readyAt.delete(artifactId);
    this.emit(id, { message: `Retrying run ${last.id}.` });
    setImmediate(() => this.pump());
    return { run: getRun(this.db, id) as RunRow };
  }

  // ── scheduling ──

  /** End a run that is not running now, with its reason in its log and in the event. */
  private end(row: RunRow, status: RunStatus, reason: RunReasonCode, message: string): void {
    let logFile = row.log_file;
    try {
      logFile ??= path.join(runsDir(), `${row.id}.log`);
      fs.appendFileSync(logFile, `[austere-axi] ${status} (${reason}): ${message}\n`, { mode: 0o600 });
    } catch {
      logFile = row.log_file;
    }
    this.announced.delete(row.id);
    this.db.prepare("UPDATE runs SET status = ?, reason = ?, ended_at = ?, log_file = ? WHERE id = ?").run(status, reason, Date.now(), logFile, row.id);
    this.emit(row.id, { message });
    this.o.log("run", row.id, status, reason);
  }

  private emit(id: string, extra: Omit<RunEvent, "run"> = {}): void {
    const row = getRun(this.db, id);
    if (row?.artifact_id) this.o.emit(row.artifact_id, { run: summary(row), ...extra });
  }

  /** This dispatcher's run that is using `session` now: one started on it, or one resuming its harness session id. */
  private holderOf(session: AgentSessionRow): Running | null {
    for (const r of this.running.values()) {
      if (r.row.agent_session_id === session.id || (r.adapter.id === session.harness && r.built.sessionId === session.session_id)) return r;
    }
    return null;
  }

  /** Waiting runs look again: now and then their session (exited, or this dispatcher's run on it ended → run), and every `recheckMs` everything. */
  private recheck(full: boolean): void {
    if (this.closed) return;
    const rows = this.db.prepare("SELECT * FROM runs WHERE status = 'waiting_for_session'").all() as unknown as RunRow[];
    let changed = full;
    for (const row of rows) {
      const s = row.artifact_id ? this.o.store.get(row.artifact_id) : null;
      const session = row.agent_session_id ? sessionRow(this.db, row.agent_session_id) : null;
      if (!full && s && session && (this.holderOf(session) || liveness(session) === "alive") && !this.o.listening(s)) continue;
      // Back to the queue; pump decides again (and waits again if the session still runs).
      this.db.prepare("UPDATE runs SET status = 'queued' WHERE id = ?").run(row.id);
      changed = true;
    }
    if (changed) this.pump();
  }

  /** Start what can start: every queued run whose debounce is over, one per copy, up to maxConcurrent. */
  private pump(): void {
    if (this.closed) return;
    const limits = this.limits();
    const now = Date.now();
    const queued = this.db.prepare("SELECT * FROM runs WHERE status = 'queued' AND kind = 'note' ORDER BY rowid").all() as unknown as RunRow[];
    const busy = this.db.prepare("SELECT 1 FROM runs WHERE artifact_id = ? AND status IN ('running', 'waiting_for_session') LIMIT 1");
    for (const row of queued) {
      const artifactId = row.artifact_id as string;
      if ((this.readyAt.get(artifactId) ?? 0) > now || busy.get(artifactId)) continue;
      const s = this.o.store.get(artifactId);
      if (!s) {
        this.db.prepare("DELETE FROM runs WHERE id = ?").run(row.id);
        continue;
      }
      const setting = effectiveAttach(this.db, s.id);
      if (setting.state !== "on") {
        this.end(row, "stopped", "attach_off", "Attach was turned off before the run started.");
        continue;
      }
      if (this.o.listening(s)) {
        this.end(row, "stopped", "listener", "An agent is polling the page: the notes go to it.");
        continue;
      }
      const openNotes = s.transcript.filter((e): e is QueuedEntry => deliverable(e) && !e.doneAt);
      if (!openNotes.length) {
        this.end(row, "stopped", "answered", "Every note on the page is answered already.");
        continue;
      }
      const conflict = this.o.autoConflict(s);
      if (conflict) {
        this.end(row, "failed", "auto_conflict", `${conflict}; a run reads only notes the owner sent or released, so it does not start (Q3). Run \`austere-axi attach off\` for the page, or publish or share it without --auto.`);
        continue;
      }
      const unreleased = unreleasedNotes(openNotes);
      if (unreleased) {
        this.end(row, "failed", "auto_conflict", unreleased);
        continue;
      }
      const open = openNotes.map((e) => e.seq);
      const started = Number((this.db.prepare("SELECT COUNT(*) AS n FROM runs WHERE artifact_id = ? AND started_at >= ?").get(artifactId, now - HOUR_MS) as { n: number }).n);
      if (started >= limits.runsPerHour) {
        this.end(row, "failed", "rate_limit", `${started} runs started on this page in the last hour; the limit is ${limits.runsPerHour} (runsPerHour in ${attachFile()}). The notes wait in the inbox.`);
        continue;
      }
      const target = resolveTarget(this.db, s.id, setting);
      if (target.mode === "same" && target.session) {
        // Busy when this dispatcher runs on it (another page, the same author session), else when its own process still runs.
        const holder = this.holderOf(target.session);
        const live = holder ? "alive" : liveness(target.session);
        if (live === "unknown") {
          this.end(row, "failed", "session_unknown", `Cannot tell whether ${target.session.harness} session ${target.session.session_id} is still open (no harness process was recorded for it), and resuming an open session is unsafe. Choose fork, or new, for this page.`);
          continue;
        }
        if (live === "alive") {
          this.db.prepare("UPDATE runs SET status = 'waiting_for_session', agent_session_id = ?, harness = ?, mode = ?, model = ? WHERE id = ?").run(target.session.id, target.harness, target.mode, setting.model, row.id);
          if (!this.announced.has(row.id)) {
            this.announced.add(row.id);
            const why = holder ? `run ${holder.row.id} is using it` : "it is still running";
            this.emit(row.id, { message: `Waiting for ${target.harness} session ${target.session.session_id} to be free: ${why}.` });
          }
          continue;
        }
      }
      if (this.running.size >= limits.maxConcurrent) continue;
      try {
        this.launch(row, s, target, setting.model, Math.min(...open), Math.max(...open));
      } catch (err) {
        // launch ends its run itself on every failure it knows; this keeps the server up, and no row stuck, on one it does not.
        this.o.log("run-launch", row.id, (err as Error).message);
        const current = getRun(this.db, row.id);
        if (current && !this.running.has(row.id) && (current.status === "queued" || current.status === "running")) this.end(current, "failed", "unavailable", `Could not start the run: ${(err as Error).message}`);
      }
    }
  }

  /** The session the first `new` run on this copy made with this harness, followed through continuations (A18). */
  private dispatcherSession(artifactId: string, harness: string): AgentSessionRow | null {
    const prior = this.db.prepare("SELECT agent_session_id FROM runs WHERE artifact_id = ? AND mode = 'new' AND harness = ? AND agent_session_id IS NOT NULL ORDER BY started_at DESC, rowid DESC LIMIT 1").get(artifactId, harness) as
      | { agent_session_id: string }
      | undefined;
    const row = prior ? sessionRow(this.db, prior.agent_session_id) : null;
    return row ? newestContinuation(this.db, row) : null;
  }

  private launch(row: RunRow, s: Session, target: RunTarget, model: string | null, seqFrom: number, seqTo: number): void {
    const fail = (reason: RunReasonCode, message: string) => {
      this.db.prepare("UPDATE runs SET harness = ?, mode = ?, model = ?, agent_session_id = ?, seq_from = ?, seq_to = ? WHERE id = ?").run(target.harness, target.mode, model, target.session?.id ?? null, seqFrom, seqTo, row.id);
      this.end(row, "failed", reason, message);
    };
    let adapter: Adapter | null;
    try {
      adapter = adapterFor(target.harness, readAdapters());
    } catch (err) {
      return fail("config", (err as Error).message);
    }
    if (!adapter) return fail("unavailable", `No adapter named ${target.harness}: a harness (omp, copilot) or a command set with \`austere-axi adapter set\`.`);
    let fileLimits: AttachLimits;
    try {
      fileLimits = readAttachLimits();
    } catch (err) {
      return fail("config", (err as Error).message);
    }
    const env = runEnv(row.id, this.o.port, this.o.env ?? process.env);
    const bin = findOnPath(adapter.bin, env);
    if (!bin) return fail("unavailable", `${adapter.bin} not found on PATH.`);
    const cap = capabilitiesOf(adapter, env)[target.mode];
    if (!cap.ok) return fail("unsupported", `${target.harness} cannot run mode ${target.mode}: ${cap.reason}.`);

    // A `new` run resumes the session the dispatcher's first `new` run on this page made (A18).
    let from = target.session;
    let buildMode = target.mode;
    if (target.mode === "new" && adapter.id !== "command") {
      from = this.dispatcherSession(s.id, target.harness);
      if (from) buildMode = "same";
    }
    // The run's files: a failure here (a full disk, a runs dir it cannot write) fails the run, not the server.
    let promptFile: string;
    let logFile: string;
    const discardPrompt = () => {
      try {
        fs.rmSync(promptFile, { force: true });
      } catch {
        // the next start sweeps it
      }
    };
    try {
      const dir = runsDir();
      promptFile = path.join(dir, `${row.id}.prompt`);
      logFile = path.join(dir, `${row.id}.log`);
      fs.writeFileSync(promptFile, runPrompt({ file: s.file, cursor: seqTo }), { mode: 0o600 });
    } catch (err) {
      return fail("unavailable", `Could not write the run's prompt file: ${(err as Error).message}`);
    }
    const art = this.db.prepare("SELECT root FROM artifacts WHERE id = ?").get(s.id) as { root: string | null } | undefined;
    const cwd = art?.root && fs.existsSync(art.root) ? art.root : path.dirname(s.file);
    const runLimits: Limits = {};
    if (fileLimits.maxCost !== undefined) runLimits.maxCost = fileLimits.maxCost;
    if (fileLimits.maxAiCredits !== undefined) runLimits.maxAiCredits = fileLimits.maxAiCredits;
    let built: BuiltCommand;
    try {
      built = adapter.build({
        mode: buildMode,
        sessionId: from?.session_id,
        model: model ?? undefined,
        promptFile,
        cwd,
        limits: runLimits,
        extraArgs: isHarness(adapter.id) ? extraArgsFor(adapter.id, readAdapters()) : [],
      });
    } catch (err) {
      discardPrompt();
      return fail(err instanceof AdapterError && err.code === "missing_session" ? "unavailable" : "unsupported", (err as Error).message);
    }

    let logFd: number | undefined;
    let promptFd: number;
    try {
      logFd = fs.openSync(logFile, "a", 0o600);
      promptFd = fs.openSync(promptFile, "r");
    } catch (err) {
      if (logFd !== undefined) fs.closeSync(logFd);
      discardPrompt();
      return fail("unavailable", `Could not open the run's files: ${(err as Error).message}`);
    }
    this.announced.delete(row.id);
    this.db
      .prepare("UPDATE runs SET status = 'running', started_at = ?, harness = ?, mode = ?, model = ?, agent_session_id = ?, seq_from = ?, seq_to = ?, log_file = ?, reason = NULL WHERE id = ?")
      .run(Date.now(), target.harness, target.mode, model, from?.id ?? null, seqFrom, seqTo, logFile, row.id);
    // A .cmd shim on Windows runs through cmd.exe (spawnSpec); the prompt stays on stdin either way.
    const spec = spawnSpec(bin, built.args, process.platform, env);
    let child: ChildProcess;
    try {
      child = spawn(spec.file, spec.args, {
        cwd: built.cwd,
        env: { ...env, ...built.env },
        stdio: [promptFd, "pipe", "pipe"],
        detached: process.platform !== "win32",
        windowsHide: true,
        windowsVerbatimArguments: spec.windowsVerbatimArguments,
      });
    } catch (err) {
      fs.closeSync(logFd);
      discardPrompt();
      return this.end({ ...row, log_file: logFile }, "failed", "unavailable", `Could not start ${bin}: ${(err as Error).message}`);
    } finally {
      fs.closeSync(promptFd);
    }
    const { promise: done, resolve } = Promise.withResolvers<void>();
    const r: Running = {
      row: getRun(this.db, row.id) as RunRow,
      s,
      child,
      adapter,
      built,
      from,
      promptFile,
      logFd,
      logged: 0,
      head: "",
      tail: "",
      stderr: "",
      stopped: false,
      timedOut: false,
      timer: setTimeout(() => {
        r.timedOut = true;
        this.kill(r);
      }, fileLimits.maxMinutes * 60_000),
      done,
      resolve,
    };
    this.running.set(row.id, r);
    this.o.log("run", row.id, "running", target.harness, buildMode, `seq=${seqFrom}..${seqTo}`);
    this.emit(row.id);
    const write = (chunk: Buffer) => {
      if (r.logged >= LOG_CAP) return;
      const room = LOG_CAP - r.logged;
      const part = chunk.length > room ? chunk.subarray(0, room) : chunk;
      try {
        fs.writeSync(r.logFd, part);
        r.logged += part.length;
        if (r.logged >= LOG_CAP) fs.writeSync(r.logFd, "\n[austere-axi] log truncated at 1 MB\n");
      } catch {
        r.logged = LOG_CAP;
      }
    };
    child.stdout?.on("data", (chunk: Buffer) => {
      write(chunk);
      const text = chunk.toString("utf8");
      if (r.head.length < OUTPUT_KEEP) r.head += text.slice(0, OUTPUT_KEEP - r.head.length);
      r.tail = (r.tail + text).slice(-OUTPUT_KEEP);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      write(chunk);
      r.stderr = (r.stderr + chunk.toString("utf8")).slice(-OUTPUT_KEEP);
    });
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
      // Output still in the pipes comes before the verdict; a background job that keeps them open does not hold it up.
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
  }

  /** SIGTERM to the run's process tree, SIGKILL after 5 s for what is left. */
  private kill(r: Running): void {
    const pid = r.child.pid;
    if (!pid) return;
    killTree(pid, "SIGTERM");
    setTimeout(() => {
      if (groupAlive(pid)) killTree(pid, "SIGKILL");
    }, KILL_GRACE_MS).unref();
  }

  /** Judge a finished run, record the session it wrote to, and start what waits. */
  private finish(r: Running, code: number | null, forced: RunReasonCode | null): void {
    clearTimeout(r.timer);
    this.running.delete(r.row.id);
    try {
      fs.rmSync(r.promptFile, { force: true });
    } catch {
      // the next start sweeps it
    }
    if (this.closed) {
      // close() killed it: the row stays `running`, so the next start marks it interrupted and
      // queues it again; a server that is stopping does not judge it (nor overwrite a newer server's row).
      try {
        fs.closeSync(r.logFd);
      } catch {
        // closed already
      }
      r.resolve();
      return;
    }
    const stdout = r.head.length + r.tail.length <= OUTPUT_KEEP || r.tail.startsWith(r.head) ? r.tail : `${r.head}\n${r.tail}`;
    const result = r.adapter.readResult({ stdout, stderr: r.stderr, exitCode: code, command: r.built });
    const agentSessionId = this.recordSession(r, result.sessionId ?? r.built.sessionId);
    const { row, s } = r;
    let status: RunStatus = "done";
    let reason: RunReasonCode | null = null;
    let message: string | undefined;
    if (r.stopped) [status, reason, message] = ["stopped", "stopped", "Stopped by the owner."];
    else if (forced) [status, reason] = ["failed", forced];
    else if (r.timedOut) [status, reason, message] = ["failed", "timeout", `The run passed its time limit and was killed.`];
    else if (result.reason) [status, reason] = ["failed", result.reason];
    else if (code !== 0) [status, reason, message] = ["failed", "exit", `The harness exited with ${code ?? "a signal"}.`];
    else {
      const from = row.seq_from ?? 0;
      const to = row.seq_to ?? 0;
      const missing = s.transcript.filter((e): e is QueuedEntry => deliverable(e) && e.seq >= from && e.seq <= to && !e.doneAt);
      if (missing.length) [status, reason, message] = ["failed", "no_reply", "The harness exited without replying to the notes (a harness that denies writes still exits 0; see `austere-axi adapter list`)."];
    }
    try {
      if (message) fs.writeSync(r.logFd, `[austere-axi] ${status} (${reason}): ${message}\n`);
      fs.closeSync(r.logFd);
    } catch {
      // the log is best effort
    }
    this.db.prepare("UPDATE runs SET status = ?, reason = ?, exit_code = ?, ended_at = ?, agent_session_id = COALESCE(?, agent_session_id) WHERE id = ?").run(status, reason, code, Date.now(), agentSessionId, row.id);
    this.o.log("run", row.id, status, reason ?? "", `exit=${code}`);
    this.emit(row.id, status === "done" ? {} : { message, tail: logTail(row.log_file) });
    r.resolve();
    this.pump();
  }

  /**
   * The session a run wrote to, recorded in the registry and linked to the copy as `editor`: a
   * new session the dispatcher made (A18), or one that continues or forks the requested one (A14).
   * Returns its `agent_sessions.id`, or null when the run named none.
   */
  private recordSession(r: Running, sessionId: string | undefined): string | null {
    if (!sessionId || !isHarness(r.adapter.id)) return null;
    try {
      if (r.from) {
        if (r.from.session_id === sessionId) return r.from.id;
        const next = recordContinuation(this.db, r.from.id, sessionId, r.row.mode === "fork" ? "fork" : "continuation");
        linkPage(this.db, r.s.id, next.id, "editor");
        return next.id;
      }
      const now = Date.now();
      const start = r.child.pid ? (systemProcessTable()?.info(r.child.pid)?.start ?? null) : null;
      const row = this.db
        .prepare(
          `INSERT INTO agent_sessions (id, harness, session_id, cwd, model, pid, pid_start, first_seen, last_seen) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(harness, session_id) DO UPDATE SET last_seen = MAX(agent_sessions.last_seen, excluded.last_seen)
           RETURNING id`,
        )
        .get(crypto.randomBytes(6).toString("hex"), r.adapter.id, sessionId, r.built.cwd, r.row.model, start ? (r.child.pid ?? null) : null, start, now, now) as { id: string };
      linkPage(this.db, r.s.id, row.id, "editor");
      return row.id;
    } catch (err) {
      this.o.log("run-session", r.row.id, (err as Error).message);
      return null;
    }
  }
}

function sessionRow(db: sqlite.DatabaseSync, id: string): AgentSessionRow | null {
  return (db.prepare("SELECT * FROM agent_sessions WHERE id = ?").get(id) as unknown as AgentSessionRow | undefined) ?? null;
}

function newRunId(): string {
  return `r${crypto.randomBytes(6).toString("hex")}`;
}
