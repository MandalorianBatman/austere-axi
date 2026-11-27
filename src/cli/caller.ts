// Which agent session runs this CLI command: read from the harness's environment
// only, or from `--session <harness>:<id>`. No hooks and no discovery. The harness process is
// found by walking this process's parents, so the registry can tell later whether that
// session is still running (liveness: the same pid with the same start time).
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

/** The harnesses a caller can be detected from. The adapters run only some of them. */
export type CallerHarness = "omp" | "copilot" | "opencode" | "dsh";

export const CALLER_HARNESSES: readonly CallerHarness[] = ["omp", "copilot", "opencode", "dsh"];

/** The agent session a command runs in. */
export interface Caller {
  harness: CallerHarness;
  sessionId: string;
  /** omp only: the session's transcript file. */
  sessionFile?: string;
}

/** The variables each harness sets in its tool calls' environment (docs/cli.md, "Adapters"). */
const ENV: Record<CallerHarness, { id: string; file?: string }> = {
  omp: { id: "PI_SESSION_ID", file: "PI_SESSION_FILE" },
  copilot: { id: "COPILOT_AGENT_SESSION_ID" },
  // Set by our OpenCode plugin (src/harness/opencode.ts): OpenCode itself names no session there.
  opencode: { id: "OPENCODE_SESSION_ID" },
  dsh: { id: "DSH_SESSION_ID" },
};

/** A session id as harnesses mint them (UUIDs and the like): no spaces, no path separators, no `:`. */
const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

function isHarness(v: string): v is CallerHarness {
  return (CALLER_HARNESSES as readonly string[]).includes(v);
}

/** `--session <harness>:<id>`; throws with the reason when it is not that shape. */
export function parseSessionOverride(value: string): Caller {
  const at = value.indexOf(":");
  const harness = at > 0 ? value.slice(0, at) : "";
  const id = at > 0 ? value.slice(at + 1) : "";
  if (!isHarness(harness))
    throw new Error(
      `--session takes <harness>:<id> with a harness of ${CALLER_HARNESSES.join(", ")}; got "${value}"`,
    );
  if (!SESSION_ID.test(id))
    throw new Error(
      `--session ${harness}:<id>: the id must be letters, digits, '.', '_' or '-' (at most 128); got "${id}"`,
    );
  return { harness, sessionId: id };
}

/**
 * The caller: `override` (the `--session` value) when given, else the harness variables in `env`.
 * When several harnesses' variables are set (one harness started inside another inherits its
 * variables), the nearest harness among this process's parents wins, else the first in
 * CALLER_HARNESSES order. Null when nothing is set.
 */
export function detectCaller(
  env: NodeJS.ProcessEnv,
  override?: string,
  table: ProcessTable | null = systemProcessTable(),
  startPid = process.ppid,
): Caller | null {
  if (override !== undefined) return parseSessionOverride(override);
  const found: Caller[] = [];
  for (const harness of CALLER_HARNESSES) {
    const id = env[ENV[harness].id]?.trim();
    if (!id || !SESSION_ID.test(id)) continue;
    const fileVar = ENV[harness].file;
    const file = fileVar ? env[fileVar]?.trim() : undefined;
    found.push(file ? { harness, sessionId: id, sessionFile: file } : { harness, sessionId: id });
  }
  if (found.length < 2 || !table) return found[0] ?? null;
  const nearest = findHarnessProcess(
    found.map((c) => c.harness),
    table,
    startPid,
  );
  return found.find((c) => c.harness === nearest?.harness) ?? found[0];
}

// ── processes ──

/** One process as the process table shows it. */
export interface ProcInfo {
  pid: number;
  ppid: number;
  /** The executable's name (Linux: `comm`, at most 15 characters; macOS: the path `ps` prints). */
  comm: string;
  /** When it started, as the OS reports it: clock ticks since boot (Linux), `lstart` (macOS). Opaque; compared for equality. */
  start: string;
  /** Its arguments; read only when the name alone does not tell. */
  argv: () => string[];
}

/** Looks a process up by pid: null when there is none, `unreadable` when the table could not tell (a failed read, `ps` timing out). */
export interface ProcessTable {
  info(pid: number): ProcInfo | null | "unreadable";
}

/** Linux: `<root>/<pid>/stat` (comm, ppid, starttime) and `<root>/<pid>/cmdline`. */
export function procfsTable(root = "/proc"): ProcessTable {
  return {
    info(pid) {
      let stat: string;
      try {
        stat = fs.readFileSync(path.join(root, String(pid), "stat"), "utf8");
      } catch (err) {
        return (err as NodeJS.ErrnoException).code === "ENOENT" ? null : "unreadable";
      }
      // `pid (comm) state ppid …`: comm may hold spaces and parentheses, so cut at the last ')'.
      const open = stat.indexOf("(");
      const close = stat.lastIndexOf(")");
      if (open < 0 || close < open) return "unreadable";
      const fields = stat.slice(close + 2).split(" ");
      // fields[0] is field 3 (state): ppid is field 4, starttime field 22.
      const ppid = Number(fields[1]);
      const start = fields[19];
      if (!Number.isInteger(ppid) || !start) return "unreadable";
      return {
        pid,
        ppid,
        comm: stat.slice(open + 1, close),
        start,
        argv: () => {
          try {
            return fs
              .readFileSync(path.join(root, String(pid), "cmdline"), "utf8")
              .split("\0")
              .filter(Boolean);
          } catch {
            return [];
          }
        },
      };
    },
  };
}

/** Runs `ps` with these arguments and returns what it printed ("" when no process matched), or null when it fails. */
export type PsRunner = (args: string[]) => string | null;

function runPs(args: string[]): string | null {
  try {
    // lstart is printed in the locale and time zone of the environment: one fixed form, so every caller's string compares equal.
    return execFileSync("ps", args, {
      encoding: "utf8",
      env: { ...process.env, LC_ALL: "C", TZ: "UTC" },
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 2000,
      windowsHide: true,
    });
  } catch (err) {
    // `ps -p` exits 1 when no process matched; a timeout or a missing `ps` says nothing about the process.
    return err instanceof Error && "status" in err && err.status === 1 ? "" : null;
  }
}

/** macOS and the BSDs: `ps -o ppid=,lstart=,comm= -p <pid>`, and `ps -o args=` when the name alone does not tell. */
export function psTable(run: PsRunner = runPs): ProcessTable {
  return {
    info(pid) {
      const out = run(["-o", "ppid=,lstart=,comm=", "-p", String(pid)]);
      if (out === null) return "unreadable";
      if (!out.trim()) return null;
      // lstart is five words: `Mon Nov 17 04:01:42 2026`.
      const m = /^\s*(\d+)\s+(\S+\s+\S+\s+\d+\s+[\d:]+\s+\d+)\s+(.+?)\s*$/m.exec(out);
      if (!m) return "unreadable";
      return {
        pid,
        ppid: Number(m[1]),
        comm: m[3],
        start: m[2].replace(/\s+/g, " "),
        argv: () =>
          (run(["-o", "args=", "-p", String(pid)]) || "").trim().split(/\s+/).filter(Boolean),
      };
    },
  };
}

/** The process table of this OS: procfs on Linux, `ps` on macOS and the BSDs, none on Windows (liveness is unknown there). */
export function systemProcessTable(): ProcessTable | null {
  if (process.platform === "linux") return procfsTable();
  if (
    process.platform === "darwin" ||
    process.platform === "freebsd" ||
    process.platform === "openbsd"
  )
    return psTable();
  return null;
}

/** Runtimes and shells that run a harness as a script: the harness is then named in the script's path. */
const INTERPRETERS = new Set(["node", "nodejs", "bun", "deno", "sh", "bash", "dash", "zsh"]);

/**
 * Whether a process is this harness: its executable is named after it (`omp`, `copilot`, `dsh`;
 * a shebang script too, on Linux), or a runtime or shell runs a script whose path has a segment
 * of that name (Copilot CLI is `node …/@github/copilot/index.js` or `node …/bin/copilot`).
 */
export function isHarnessProcess(p: ProcInfo, harness: CallerHarness): boolean {
  // The executable's own name: macOS prints a path, a login shell a leading '-', Windows an .exe.
  const name = (p.comm.split(/[\\/]/).pop() || "").replace(/^-/, "").replace(/\.exe$/i, "");
  if (name === harness) return true;
  if (!INTERPRETERS.has(name)) return false;
  const script = p.argv()[1];
  return (
    !!script &&
    script.split(/[\\/]/).some((seg) => seg.replace(/\.(m?js|cjs|ts|sh)$/, "") === harness)
  );
}

/** A harness process found among the parents. */
export interface HarnessProcess {
  harness: CallerHarness;
  pid: number;
  start: string;
}

/** The nearest parent of `startPid` (itself included) that is one of `harnesses`; null when none is, or the walk cannot read on. */
export function findHarnessProcess(
  harnesses: readonly CallerHarness[],
  table: ProcessTable,
  startPid = process.ppid,
): HarnessProcess | null {
  const seen = new Set<number>();
  for (let pid = startPid; pid > 0 && !seen.has(pid) && seen.size < 64;) {
    seen.add(pid);
    const p = table.info(pid);
    if (!p || p === "unreadable") return null;
    const harness = harnesses.find((h) => isHarnessProcess(p, h));
    if (harness) return { harness, pid: p.pid, start: p.start };
    pid = p.ppid;
  }
  return null;
}

/** The caller's harness process, for liveness; null when it is not among this process's parents or the OS has no table. */
export function callerProcess(
  caller: Caller,
  table: ProcessTable | null = systemProcessTable(),
  startPid = process.ppid,
): HarnessProcess | null {
  return table ? findHarnessProcess([caller.harness], table, startPid) : null;
}

export type Liveness = "alive" | "exited" | "unknown";

/**
 * `alive`: that pid still runs and started when it did; `exited`: the table says it does not (or the
 * pid is another process now); `unknown`: no pid was recorded, no process table here, or the table
 * could not tell (a resume must not start on a session that may still be open).
 */
export function processLiveness(
  pid: number | null,
  start: string | null,
  table: ProcessTable | null = systemProcessTable(),
): Liveness {
  if (pid == null || !start || !table) return "unknown";
  const p = table.info(pid);
  if (p === "unreadable") return "unknown";
  return p?.start === start ? "alive" : "exited";
}
