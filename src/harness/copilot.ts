// The Copilot CLI extension for push delivery: the wake client (client.ts) on Copilot's
// extension SDK (`@github/copilot-sdk/extension`, CLI 1.0.112, experimental). `copilot-extension.ts`
// joins the session; this file is the part that does not need the SDK, so tests drive it.
//
// Copilot 1.0.112, observed: the extension joins the foreground session before its first prompt;
// `session.sessionId` is the `COPILOT_AGENT_SESSION_ID` its shell commands see; `session.send()`
// while idle starts a turn at once. Extensions load in interactive and `-p` sessions, not in `--acp`.
import { WakeClient } from "./client.ts";

/** A Copilot session event, as much of it as this extension reads (generated/session-events.d.ts). */
export interface CopilotEvent {
  type: string;
  /** A sub-agent's events carry its id; the foreground agent's and the session's do not. */
  agentId?: string;
  data?: unknown;
}

/** What this extension uses of the SDK's `CopilotSession`. */
export interface CopilotSession {
  readonly sessionId: string;
  on(handler: (event: CopilotEvent) => void): unknown;
  send(options: { prompt: string; source?: string }): Promise<string>;
}

/**
 * The wake client on a joined Copilot session. Busy from the foreground's `user.message` or
 * `assistant.turn_start` until `session.idle`, which Copilot sends only once nothing runs, attached
 * shells and sub-agents included. `env` is for tests.
 */
export function copilotWake(
  session: CopilotSession,
  env: NodeJS.ProcessEnv = process.env,
): WakeClient {
  // The extension joins before the session's first prompt.
  let busy = false;
  const client = new WakeClient(
    {
      harness: "copilot",
      sessionId: () => session.sessionId,
      idle: () => !busy,
      // An automation turn: it sets the session's task as a user message does, without the owner's authority.
      send: (prompt) => session.send({ prompt, source: "automation-austere-axi" }),
    },
    env,
  );
  session.on((e) => {
    if (e.type === "session.idle") {
      busy = false;
      client.turnEnd();
      return;
    }
    if (e.type === "session.shutdown") return client.stop();
    if (e.agentId) return;
    if (e.type === "user.message" || e.type === "assistant.turn_start") busy = true;
    else if (e.type === "tool.execution_start") {
      const d = (e.data ?? {}) as { toolName?: unknown; arguments?: unknown };
      client.toolRan(d.toolName, d.arguments);
    }
  });
  void client.check();
  return client;
}
