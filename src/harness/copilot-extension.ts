// The Copilot CLI extension's entry (RLM-452), built to dist/harness/copilot/extension.mjs: Copilot
// loads `<name>/extension.mjs` from ~/.copilot/extensions/ and resolves the SDK itself.
import { joinSession } from "@github/copilot-sdk/extension";
import { copilotWake } from "./copilot.ts";

copilotWake(await joinSession());
