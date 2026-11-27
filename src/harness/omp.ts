// The omp / Pi extension for push delivery: the wake client (client.ts) on omp's
// extension API. Load with `omp -e`, or link into `~/.omp/agent/extensions/`.
//
// omp 18.22: `sendUserMessage(text, { deliverAs: "followUp" })` queues the message and does not
// start a turn when the session is idle, so the turn starts with no `deliverAs`, and only when idle.
import { WakeClient } from "./client.ts";

/** What this extension uses of omp's (and Pi's) `ExtensionContext`. */
export interface HostContext {
  isIdle(): boolean;
  hasPendingMessages(): boolean;
  sessionManager: { getSessionId(): string };
}

/** What this extension uses of omp's (and Pi's) `ExtensionAPI`. */
export interface HostApi {
  on(event: string, handler: (event: unknown, ctx: HostContext) => unknown): void;
  sendUserMessage(text: string): unknown;
}

/** The wake client on an omp session; `ctx` is the latest context omp handed an event. `env` is for tests. */
export function ompWake(
  pi: HostApi,
  env: NodeJS.ProcessEnv = process.env,
): { client: WakeClient; context(ctx: HostContext): void } {
  let ctx: HostContext | null = null;
  const client = new WakeClient(
    {
      // omp and Pi both set PI_SESSION_ID (caller.ts).
      harness: "omp",
      sessionId: () => ctx?.sessionManager.getSessionId() ?? "",
      idle: () => Boolean(ctx && ctx.isIdle() && !ctx.hasPendingMessages()),
      send: (prompt) => pi.sendUserMessage(prompt),
    },
    env,
  );
  return { client, context: (c) => (ctx = c) };
}

export default function austereWake(pi: HostApi): void {
  const { client, context } = ompWake(pi);
  pi.on("session_start", (_e, ctx) => {
    context(ctx);
    return client.check();
  });
  // `/new`, `/resume`: another session id; its role is checked afresh.
  pi.on("session_switch", (_e, ctx) => {
    client.stop();
    context(ctx);
    return client.check();
  });
  pi.on("tool_result", (e) => {
    const t = (e ?? {}) as { toolName?: unknown; input?: unknown };
    client.toolRan(t.toolName, t.input);
  });
  pi.on("agent_end", (_e, ctx) => {
    context(ctx);
    client.turnEnd();
  });
  pi.on("session_shutdown", () => client.stop());
}
