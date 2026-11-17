// Copilot CLI adapter. argv (docs/review-loop-v2.md, "Adapter argv (RLM-344)"):
//   same  copilot --resume=<id>          --model <m|auto> --no-ask-user --output-format json [--max-ai-credits n] <extra>
//   new   copilot --session-id <minted>  --model <m|auto> --no-ask-user --output-format json [--max-ai-credits n] <extra>
// The prompt file goes on stdin, never in argv (piped stdin is the prompt when there is no -p). `<extra>`
// is the owner's grant from <state>/adapters.json (A13).
// Fork is unavailable. `--model` is always passed, because the session saves the last model and a bad one
// breaks later resumes (A15). A resume of a session open elsewhere fails with SessionInUseError, exit 1:
// the run fails with `session_in_use` and does not fall back to `new` (A14).
import { randomUUID } from "node:crypto";
import { extraArgsFor, readAdaptersConfig } from "./config.ts";
import { requireMode, requireSession } from "./types.ts";
import type { Adapter, BuildInput, BuiltCommand, CallerSession, Env, ReadResultInput, RunResult } from "./types.ts";

export const COPILOT_DEFAULT_MODEL = "auto";
export const COPILOT_FORK_UNAVAILABLE = 'Copilot CLI has no fork flag, and -p "/fork" does nothing';

export const copilot: Adapter = {
  id: "copilot",
  bin: "copilot",
  capabilities: { same: true, fork: { unavailable: COPILOT_FORK_UNAVAILABLE }, new: true, model: true, maxTime: false, maxCost: true },

  detect(env: Env): CallerSession | null {
    const id = env.COPILOT_AGENT_SESSION_ID;
    return id ? { harness: "copilot", sessionId: id } : null;
  },

  build(input: BuildInput): BuiltCommand {
    requireMode(copilot, input.mode);
    const resume = input.mode === "same" ? requireSession(copilot, input) : undefined;
    const sessionId = resume ?? randomUUID();
    const args = resume ? [`--resume=${resume}`] : ["--session-id", sessionId];
    args.push("--model", input.model || COPILOT_DEFAULT_MODEL, "--no-ask-user", "--output-format", "json");
    if (input.limits?.maxAiCredits != null) args.push("--max-ai-credits", String(input.limits.maxAiCredits));
    args.push(...extraArgsFor(readAdaptersConfig(), "copilot"));
    return { bin: copilot.bin, args, env: {}, stdin: input.promptFile, sessionId };
  },

  readResult(input: ReadResultInput): RunResult {
    const result: RunResult = {};
    const id = sessionIdFromJson(input.stdout);
    if (id) result.sessionId = id;
    if (input.exitCode !== 0) {
      result.error = /\bSessionInUseError\b/.test(`${input.stdout}\n${input.stderr ?? ""}`) ? "session_in_use" : "exit";
    }
    return result;
  },
};

/** `sessionId` on the last `result` line, else `data.sessionId` on the `session.start` line. */
function sessionIdFromJson(stdout: string): string | undefined {
  let fromStart: string | undefined;
  let fromResult: string | undefined;
  for (const line of stdout.split("\n")) {
    const text = line.trim();
    if (!text.startsWith("{")) continue;
    let event: { type?: unknown; sessionId?: unknown; data?: { sessionId?: unknown } };
    try {
      event = JSON.parse(text);
    } catch {
      continue;
    }
    if (!event || typeof event !== "object") continue;
    if (event.type === "session.start" && typeof event.data?.sessionId === "string") fromStart ??= event.data.sessionId;
    if (event.type === "result" && typeof event.sessionId === "string") fromResult = event.sessionId;
  }
  return fromResult ?? fromStart;
}
