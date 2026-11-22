// Harness adapters (RLM-344): turn (mode, session, model, prompt) into one command line per
// harness, and read the session id of the run back from its output. The argv of each harness
// is the "Adapter argv (RLM-344)" table in docs/review-loop-v2.md. An adapter only builds and
// parses: the dispatcher (RLM-345) spawns, times out and logs.

/** A harness an agent session can run in. */
export type HarnessId = "omp" | "copilot";

/** What a configured adapter is: a harness, or a fixed `command` from adapters.json. */
export type AdapterKind = HarnessId | "command";

/** How a run relates to an existing agent session: continue it, branch from it, or start fresh. */
export type AttachMode = "same" | "fork" | "new";

export const ATTACH_MODES: readonly AttachMode[] = ["same", "fork", "new"];

/** Whether an adapter can do something here, and why not when it cannot. */
export type Capability = { ok: true } | { ok: false; reason: string };

export interface Capabilities {
  same: Capability;
  fork: Capability;
  new: Capability;
  /** Choosing the model per run. */
  model: Capability;
  /** A spending cap per run (omp `--max-cost`, Copilot `--max-ai-credits`). */
  maxCost: Capability;
}

/** Per-run limits from `<state>/attach.json` (RLM-345). Each adapter passes only its own. Time is the dispatcher's timeout (A15). */
export interface Limits {
  /** omp `--max-cost`, in dollars. */
  maxCost?: number;
  /** Copilot `--max-ai-credits`. */
  maxAiCredits?: number;
}

export interface BuildInput {
  mode: AttachMode;
  /** The harness session to resume (`same`) or fork (`fork`). */
  sessionId?: string;
  model?: string;
  /** The 0600 prompt file; it goes on stdin, never in argv. */
  promptFile: string;
  cwd: string;
  limits: Limits;
  /** The owner's `--extra-args` from adapters.json, appended last (A13). */
  extraArgs: readonly string[];
  /** Mints the session id of a Copilot `new` run (default crypto.randomUUID). */
  mintId?: () => string;
}

/** A command ready to spawn: `bin args…` in `cwd`, with `stdinFile` piped on stdin and `env` added to the run's environment. */
export interface BuiltCommand {
  bin: string;
  args: string[];
  env: Record<string, string>;
  stdinFile: string;
  cwd: string;
  /** The session id chosen before the run (Copilot `new`), when the adapter picks it. */
  sessionId?: string;
}

/** What a finished run printed. */
export interface RunOutput {
  stdout: string;
  stderr: string;
  exitCode: number | null;
}

/** Why a run failed, when its output says (the `runs.reason` values an adapter can tell). */
export type RunReason = "cost_cap" | "session_in_use";

export interface RunResult {
  /** The session the run wrote to. */
  sessionId?: string;
  /** omp `parentSession`: the session it continues or forks. */
  parentSessionId?: string;
  /** omp `continuationOf`: set when a resume continued in a new session because the old one was open (A14). */
  continuationOf?: string;
  reason?: RunReason;
}

export interface Adapter {
  id: AdapterKind;
  /** The binary looked up on PATH. */
  bin: string;
  /** What it can do once its binary is found (see `capabilitiesOf` in index.ts for the live answer). */
  capabilities: Capabilities;
  /** Throws AdapterError for a mode it cannot run or a missing session id. */
  build(input: BuildInput): BuiltCommand;
  readResult(out: RunOutput): RunResult;
}

export class AdapterError extends Error {
  code: "unsupported_mode" | "missing_session";
  constructor(code: "unsupported_mode" | "missing_session", message: string) {
    super(message);
    this.name = "AdapterError";
    this.code = code;
  }
}

export const OK: Capability = { ok: true };

/** The session id build() needs for `same` and `fork`. */
export function requireSession(id: AdapterKind, input: BuildInput): string {
  if (!input.sessionId)
    throw new AdapterError("missing_session", `${id} ${input.mode} needs a session id`);
  return input.sessionId;
}

/** Throws when the capability for this mode is off, with its reason. */
export function requireMode(id: AdapterKind, caps: Capabilities, mode: AttachMode): void {
  const cap = caps[mode];
  if (!cap.ok)
    throw new AdapterError("unsupported_mode", `${id} cannot run mode ${mode}: ${cap.reason}`);
}

/** Non-empty lines of a run's stdout. */
export function lines(stdout: string): string[] {
  return stdout.split(/\r?\n/).filter((l) => l.trim() !== "");
}

/** One JSON line as an object, or null when it is not one. */
export function jsonLine(line: string | undefined): Record<string, unknown> | null {
  if (line === undefined) return null;
  try {
    const v: unknown = JSON.parse(line);
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export const str = (v: unknown): string | undefined =>
  typeof v === "string" && v !== "" ? v : undefined;
