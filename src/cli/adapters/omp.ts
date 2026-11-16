// omp adapter. argv (docs/review-loop-v2.md, "Adapter argv (RLM-344)"):
//   same  omp -p --mode json --wait-async --resume <id> --model <m> [--max-cost c] <extra>
//   fork  omp -p --mode json --wait-async --fork <id>   --model <m> [--max-cost c] <extra>
//   new   omp -p --mode json --wait-async               --model <m> [--max-cost c] <extra>
// The prompt file goes on stdin. `--wait-async` lets a background job finish inside the run (A16);
// `--max-time` is not passed, the dispatcher's timeout is the limit (A15). The run's session id is the
// `id` on the first JSON line: a resume of a session open elsewhere continues in a new one (A14).
import path from "node:path";
import { requireMode, requireSession } from "./types.ts";
import type { Adapter, BuildInput, BuiltCommand, CallerSession, Env, ReadResultInput, RunResult } from "./types.ts";

/** omp's exit code when `--max-cost` stops the run. */
const COST_CAP_EXIT = 3;

export const omp: Adapter = {
  id: "omp",
  bin: "omp",
  capabilities: { same: true, fork: true, new: true, model: true, maxTime: false, maxCost: true },

  detect(env: Env): CallerSession | null {
    const file = env.PI_SESSION_FILE || undefined;
    const id = env.PI_SESSION_ID || (file ? idFromSessionFile(file) : undefined);
    if (!id) return null;
    return file ? { harness: "omp", sessionId: id, sessionFile: file } : { harness: "omp", sessionId: id };
  },

  build(input: BuildInput): BuiltCommand {
    requireMode(omp, input.mode);
    const args = ["-p", "--mode", "json", "--wait-async"];
    if (input.mode === "same") args.push("--resume", requireSession(omp, input));
    else if (input.mode === "fork") args.push("--fork", requireSession(omp, input));
    if (input.model) args.push("--model", input.model);
    if (input.limits?.maxCost != null) args.push("--max-cost", String(input.limits.maxCost));
    args.push(...(input.extraArgs ?? []));
    return { bin: omp.bin, args, env: {}, cwd: input.cwd, stdin: input.promptFile };
  },

  readResult(input: ReadResultInput): RunResult {
    const result: RunResult = {};
    const header = firstJsonLine(input.stdout);
    if (header && header.type === "session" && typeof header.id === "string") {
      result.sessionId = header.id;
      const parent = typeof header.continuationOf === "string" ? header.continuationOf : header.parentSession;
      if (typeof parent === "string") result.parentSessionId = parent;
    }
    if (input.exitCode === COST_CAP_EXIT) result.error = "cost_cap";
    else if (input.exitCode !== 0) result.error = "exit";
    return result;
  },
};

/** `<timestamp>_<id>.jsonl` → `<id>`. */
function idFromSessionFile(file: string): string | undefined {
  const base = path.basename(file).replace(/\.jsonl$/, "");
  const id = base.slice(base.lastIndexOf("_") + 1);
  return id || undefined;
}

function firstJsonLine(stdout: string): Record<string, unknown> | null {
  for (const line of stdout.split("\n")) {
    const text = line.trim();
    if (!text.startsWith("{")) continue;
    try {
      const value: unknown = JSON.parse(text);
      return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
    } catch {
      return null;
    }
  }
  return null;
}
