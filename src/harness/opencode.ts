// The OpenCode plugin for push delivery (RLM-451): the wake client (client.ts) on OpenCode's plugin
// API. `opencode-plugin.ts` is the entry OpenCode loads; this file holds the logic, so tests drive it.
//
// OpenCode 1.19.5, observed: one OpenCode process (the TUI's or `opencode serve`'s server) runs
// many sessions, and its plugins see every session's events. OpenCode sets no session variable in
// the bash tool's environment, so the plugin names it there (`shell.env`): `OPENCODE_SESSION_ID`,
// the session's root (a subagent's bash names the session that started it). That is all the
// plugin does in a session the server knows no page for, beside the one check (client.ts).
// `session.promptAsync` on an idle session starts a turn and returns at once; `session.prompt`
// would wait for the turn to end, past the server's claim.
import { WakeClient } from "./client.ts";

/** A bus event, as much of it as this plugin reads (`Event` in `@opencode-ai/sdk`). */
export interface OpenCodeEvent {
  type: string;
  properties?: unknown;
}

/** What this plugin uses of the SDK client OpenCode hands its plugins. */
export interface OpenCodeClient {
  session: {
    promptAsync(options: {
      path: { id: string };
      body: { parts: { type: "text"; text: string }[] };
    }): Promise<{ error?: unknown }>;
  };
}

/** The hooks this plugin registers (`Hooks` in `@opencode-ai/plugin`). */
export interface OpenCodeHooks {
  event(input: { event: OpenCodeEvent }): Promise<void>;
  "shell.env"(
    input: { cwd: string; sessionID?: string },
    output: { env: Record<string, string> },
  ): Promise<void>;
  "tool.execute.after"(
    input: { tool: string; sessionID: string; args?: unknown },
    output: unknown,
  ): Promise<void>;
}

/** The variable the plugin sets in the bash tool's environment, which caller.ts reads. */
export const SESSION_VAR = "OPENCODE_SESSION_ID";

interface Watched {
  busy: boolean;
  client: WakeClient;
}

/** The plugin's hooks, and the wake clients it runs (one per root session it has seen). `env` is for tests. */
export function opencodeWake(
  oc: OpenCodeClient,
  env: NodeJS.ProcessEnv = process.env,
): { hooks: OpenCodeHooks; sessions: Map<string, Watched> } {
  const sessions = new Map<string, Watched>();
  /** A subagent's session and the session that started it, from `session.created`/`session.updated`. */
  const parents = new Map<string, string>();

  const root = (id: string): string => {
    const seen = new Set<string>();
    while (parents.has(id) && !seen.has(id)) {
      seen.add(id);
      id = parents.get(id)!;
    }
    return id;
  };

  /** The root session's client; the first event of a session in this process is its one check. */
  const watch = (id: string): Watched => {
    let w = sessions.get(id);
    if (w) return w;
    const state: Watched = {
      busy: false,
      client: new WakeClient(
        {
          harness: "opencode",
          sessionId: () => id,
          idle: () => !state.busy,
          send: async (text) => {
            // Busy from now: the session's own `session.status` events take over.
            state.busy = true;
            const r = await oc.session
              .promptAsync({ path: { id }, body: { parts: [{ type: "text", text }] } })
              .catch((err: unknown) => ({ error: err }));
            if (r?.error) {
              state.busy = false;
              throw new Error("promptAsync refused the wake");
            }
          },
        },
        env,
      ),
    };
    sessions.set(id, (w = state));
    void state.client.check();
    return state;
  };

  const hooks: OpenCodeHooks = {
    async event({ event }) {
      const p = (event.properties ?? {}) as {
        sessionID?: unknown;
        status?: { type?: unknown };
        info?: { id?: unknown; parentID?: unknown };
      };
      if (event.type === "session.created" || event.type === "session.updated") {
        const { id, parentID } = p.info ?? {};
        if (typeof id === "string" && typeof parentID === "string" && id !== parentID)
          parents.set(id, parentID);
        return;
      }
      if (event.type === "session.deleted") {
        const id = p.info?.id;
        if (typeof id !== "string") return;
        sessions.get(id)?.client.stop();
        sessions.delete(id);
        parents.delete(id);
        return;
      }
      const id = typeof p.sessionID === "string" ? p.sessionID : "";
      // A subagent's turn is not its root's: the root is in a turn of its own while it runs.
      if (!id || parents.has(id)) return;
      if (event.type === "session.status") {
        const w = watch(id);
        const busy = p.status?.type !== "idle";
        if (w.busy && !busy) {
          w.busy = false;
          w.client.turnEnd();
        } else w.busy = busy;
      } else if (event.type === "session.idle") {
        const w = watch(id);
        const was = w.busy;
        w.busy = false;
        if (was) w.client.turnEnd();
      }
    },
    async "shell.env"(input, output) {
      if (input.sessionID) output.env[SESSION_VAR] = root(input.sessionID);
    },
    async "tool.execute.after"(input) {
      sessions.get(root(input.sessionID))?.client.toolRan(input.tool, input.args);
    },
  };
  return { hooks, sessions };
}
