// A `command` adapter (RLM-365 uses it): a fixed binary and arguments the owner set in
// adapters.json at a terminal, the prompt on stdin. It has no session to resume or fork, so
// it runs `new` only, and its output carries no session id.
import { OK, requireMode } from "./types.ts";
import type { Adapter, BuildInput, BuiltCommand, Capabilities, RunResult } from "./types.ts";
import type { CommandSpec } from "./config.ts";

const NO_SESSION: Capabilities["same"] = { ok: false, reason: "a command adapter has no session to resume or fork; it runs new only" };

export function commandAdapter(name: string, spec: CommandSpec): Adapter {
  const capabilities: Capabilities = {
    same: NO_SESSION,
    fork: NO_SESSION,
    new: OK,
    model: { ok: false, reason: `command ${name} has fixed arguments` },
    maxCost: { ok: false, reason: `command ${name} has fixed arguments` },
  };
  return {
    id: "command",
    bin: spec.bin,
    capabilities,
    /** The fixed argv; model, limits and extra arguments do not apply. */
    build(input: BuildInput): BuiltCommand {
      requireMode("command", capabilities, input.mode);
      return { bin: spec.bin, args: [...spec.args], env: {}, stdinFile: input.promptFile, cwd: input.cwd };
    },
    readResult: (): RunResult => ({}),
  };
}
