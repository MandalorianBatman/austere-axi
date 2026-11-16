// Harness adapters (RLM-344): turn (mode, session, model, prompt) into a command for one harness, and read
// the run's session id back from its output. The argv per harness is in docs/review-loop-v2.md, "Adapter
// argv (RLM-344)". No adapter adds a permission-bypass flag on its own (A13); the owner's `extraArgs` from
// <state>/adapters.json are the only grant.

/** How a run reaches the agent: resume its session, fork it, or start a new one. */
export type RunMode = "same" | "fork" | "new";

/** Harnesses whose caller session the CLI can detect. `dsh` is detection only (RLM-347 is parked). */
export type HarnessId = "omp" | "copilot" | "dsh";

/** Harnesses with an adapter that can build a run. */
export type AdapterHarness = "omp" | "copilot";

/** Supported, not supported, or not usable here and why (a missing binary, a missing harness feature). */
export type Capability = boolean | { unavailable: string };

export interface Capabilities {
  same: Capability;
  fork: Capability;
  new: Capability;
  /** Takes a model choice. */
  model: Capability;
  /** Passes a wall-clock limit. None does: the dispatcher's own timeout is the limit (A15). */
  maxTime: Capability;
  /** Passes a spend cap: omp `--max-cost`, Copilot `--max-ai-credits` (A15). */
  maxCost: Capability;
}

/** Limits from <state>/attach.json (RLM-345). Each is passed only when set and the harness has the flag. */
export interface RunLimits {
  /** omp `--max-cost`, in dollars. */
  maxCost?: number;
  /** Copilot `--max-ai-credits`. */
  maxAiCredits?: number;
}

export interface BuildInput {
  mode: RunMode;
  /** The session to resume or fork; ignored for `new`. */
  sessionId?: string;
  model?: string;
  /** The 0600 prompt file. */
  promptFile: string;
  cwd: string;
  limits?: RunLimits;
  /** The owner's extra arguments for this harness (adapters.json), appended last. */
  extraArgs?: readonly string[];
}

export interface BuiltCommand {
  bin: string;
  args: string[];
  /** Variables to add to the run's environment (the dispatcher adds AUSTERE_AXI_RUN_ID itself). */
  env: Record<string, string>;
  cwd: string;
  /** Path of a file to feed on the process's stdin. */
  stdin?: string;
  /** The session id the run will use when the adapter decides it up front (Copilot `new` mints one). */
  sessionId?: string;
}

/** Why a run failed, as `runs.reason` records it. */
export type RunError = "exit" | "session_in_use" | "cost_cap";

export interface RunResult {
  /** The session the run used or created; for omp the id on the first `--mode json` line (A14). */
  sessionId?: string;
  /** The session this one continues (omp `continuationOf`) or forks (`parentSession`). */
  parentSessionId?: string;
  error?: RunError;
}

export interface ReadResultInput {
  stdout: string;
  stderr?: string;
  exitCode: number | null;
  /** The command that ran, for the session id the adapter chose up front. */
  built?: BuiltCommand;
}

/** The caller's harness session, found from the environment or the `--session <harness>:<id>` override. */
export interface CallerSession {
  harness: HarnessId;
  sessionId: string;
  sessionFile?: string;
}

export type Env = Readonly<Record<string, string | undefined>>;

export interface Adapter {
  /** `omp`, `copilot`, or `command:<name>`. */
  id: string;
  /** The binary `build` runs; `capabilitiesFor` checks it is on PATH. */
  bin: string;
  /** This harness's session when the CLI runs inside it; null when not. */
  detect(env: Env): CallerSession | null;
  /** What the harness supports, before checking the binary (see `capabilitiesFor` in index.ts). */
  capabilities: Capabilities;
  /** Throws AdapterError("unsupported") for a mode the harness lacks. */
  build(input: BuildInput): BuiltCommand;
  readResult(input: ReadResultInput): RunResult;
}

export type AdapterErrorCode = "unsupported" | "no_tty" | "bad_input" | "bad_config";

export class AdapterError extends Error {
  readonly code: AdapterErrorCode;
  constructor(code: AdapterErrorCode, message: string) {
    super(message);
    this.name = "AdapterError";
    this.code = code;
  }
}

/** The capability as a mode check: throws AdapterError("unsupported") with the reason. */
export function requireMode(adapter: { id: string; capabilities: Capabilities }, mode: RunMode): void {
  const cap = adapter.capabilities[mode];
  if (cap === true) return;
  const why = cap === false ? "not supported" : cap.unavailable;
  throw new AdapterError("unsupported", `${adapter.id} cannot run mode "${mode}": ${why}`);
}

/** The session id a mode needs; throws when it is missing. */
export function requireSession(adapter: { id: string }, input: BuildInput): string {
  if (!input.sessionId) throw new AdapterError("bad_input", `${adapter.id} mode "${input.mode}" needs a session id`);
  return input.sessionId;
}
