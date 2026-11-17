// omp (18.13.3 observed, docs/review-loop-v2.md "Harness facts"): print mode with the prompt on
// stdin, `--mode json` so line 1 is the session header, `--wait-async` so background jobs finish
// inside the run (A16). `--max-time` is not passed (A15); exit 3 is the cost cap.
import { OK, jsonLine, lines, requireMode, requireSession, str } from "./types.ts";
import type { Adapter, BuildInput, BuiltCommand, Capabilities, RunOutput, RunResult } from "./types.ts";

const capabilities: Capabilities = { same: OK, fork: OK, new: OK, model: OK, maxCost: OK };

function build(input: BuildInput): BuiltCommand {
  requireMode("omp", capabilities, input.mode);
  const args = ["-p", "--mode", "json", "--wait-async"];
  if (input.mode === "same") args.push("--resume", requireSession("omp", input));
  else if (input.mode === "fork") args.push("--fork", requireSession("omp", input));
  if (input.model) args.push("--model", input.model);
  if (input.limits.maxCost !== undefined) args.push("--max-cost", String(input.limits.maxCost));
  args.push(...input.extraArgs);
  return { bin: "omp", args, env: {}, stdinFile: input.promptFile, cwd: input.cwd };
}

/** Line 1 of `--mode json` is `{type:"session", id, parentSession?, continuationOf?}`; a resume of an open session continues in a new id (A14). */
function readResult(out: RunOutput): RunResult {
  const result: RunResult = {};
  const head = jsonLine(lines(out.stdout)[0]);
  if (head && head.type === "session") {
    const id = str(head.id);
    const parent = str(head.parentSession);
    const continuation = str(head.continuationOf);
    if (id) result.sessionId = id;
    if (parent) result.parentSessionId = parent;
    if (continuation) result.continuationOf = continuation;
  }
  if (out.exitCode === 3) result.reason = "cost_cap";
  return result;
}

export const omp: Adapter = { id: "omp", bin: "omp", capabilities, build, readResult };
