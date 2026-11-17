// `command` adapter: a fixed binary and arguments from <state>/adapters.json `commands` (used by RLM-365).
// It has no sessions, so it runs `new` only, with the prompt file on stdin. Set at a terminal only, like
// every adapter setting (config.ts).
import { requireMode } from "./types.ts";
import type { Adapter, BuildInput, BuiltCommand, CallerSession, ReadResultInput, RunResult } from "./types.ts";

export interface CommandSpec {
  bin: string;
  args: string[];
}

export const COMMAND_PREFIX = "command:";
const NO_SESSIONS = "a command adapter has no sessions";

export function commandAdapter(name: string, spec: CommandSpec): Adapter {
  const adapter: Adapter = {
    id: `${COMMAND_PREFIX}${name}`,
    bin: spec.bin,
    capabilities: {
      same: { unavailable: NO_SESSIONS },
      fork: { unavailable: NO_SESSIONS },
      new: true,
      model: false,
      maxTime: false,
      maxCost: false,
    },
    detect(): CallerSession | null {
      return null;
    },
    build(input: BuildInput): BuiltCommand {
      requireMode(adapter, input.mode);
      return { bin: spec.bin, args: [...spec.args], env: {}, stdin: input.promptFile };
    },
    readResult(input: ReadResultInput): RunResult {
      return input.exitCode === 0 ? {} : { error: "exit" };
    },
  };
  return adapter;
}
