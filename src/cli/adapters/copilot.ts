// Copilot CLI (1.0.112 observed, docs/cli.md "Adapters"): the prompt on stdin
// (no `-p`), `--output-format json` so the last line carries the session id, `--no-ask-user` so a
// run never blocks, and always `--model` (default `auto`): the session saves the model and a bad
// one breaks later resumes (A15). There is no fork. A resume of a session open in another process
// fails with SessionInUseError, exit 1 (A14).
import crypto from "node:crypto";
import { OK, jsonLine, lines, requireMode, requireSession, str } from "./types.ts";
import type {
  Adapter,
  BuildInput,
  BuiltCommand,
  Capabilities,
  RunOutput,
  RunResult,
} from "./types.ts";

export const COPILOT_NO_FORK =
  "Copilot CLI has no fork: no flag, and /fork does nothing in print mode";

const capabilities: Capabilities = {
  same: OK,
  fork: { ok: false, reason: COPILOT_NO_FORK },
  new: OK,
  model: OK,
  maxCost: OK,
};

function build(input: BuildInput): BuiltCommand {
  requireMode("copilot", capabilities, input.mode);
  const args: string[] = [];
  let sessionId: string | undefined;
  if (input.mode === "same") args.push(`--resume=${requireSession("copilot", input)}`);
  else {
    sessionId = (input.mintId ?? crypto.randomUUID)();
    args.push("--session-id", sessionId);
  }
  args.push("--model", input.model || "auto", "--no-ask-user", "--output-format", "json");
  if (input.limits.maxAiCredits !== undefined)
    args.push("--max-ai-credits", String(input.limits.maxAiCredits));
  args.push(...input.extraArgs);
  const built: BuiltCommand = {
    bin: "copilot",
    args,
    env: {},
    stdinFile: input.promptFile,
    cwd: input.cwd,
  };
  if (sessionId) built.sessionId = sessionId;
  return built;
}

/**
 * The last `{type:"result", sessionId}` line, else line 1 `session.start` `data.sessionId`. The id
 * we minted counts only once the output names it: a run that failed before Copilot made the
 * session has none, and `--resume` of that UUID would fail every later run (A18).
 */
function readResult(out: RunOutput): RunResult {
  const result: RunResult = {};
  const all = lines(out.stdout);
  let id: string | undefined;
  for (let i = all.length - 1; i >= 0 && !id; i--) {
    const l = jsonLine(all[i]);
    if (l && l.type === "result") id = str(l.sessionId);
  }
  if (!id) {
    const head = jsonLine(all[0]);
    const data = head && head.type === "session.start" ? head.data : undefined;
    if (data && typeof data === "object") id = str((data as Record<string, unknown>).sessionId);
  }
  if (id) result.sessionId = id;
  if (out.exitCode === 1 && `${out.stderr}\n${out.stdout}`.includes("SessionInUseError"))
    result.reason = "session_in_use";
  return result;
}

export const copilot: Adapter = { id: "copilot", bin: "copilot", capabilities, build, readResult };
