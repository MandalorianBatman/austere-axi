// The OpenCode plugin's entry, built to dist/harness/opencode.js: OpenCode calls every
// function this module exports as a plugin, so it exports one. Link it into
// ~/.config/opencode/plugins/ (every session) or a project's .opencode/plugins/.
import { opencodeWake } from "./opencode.ts";
import type { OpenCodeClient, OpenCodeHooks } from "./opencode.ts";

export const AustereWake = async (input: { client: OpenCodeClient }): Promise<OpenCodeHooks> =>
  opencodeWake(input.client).hooks;
