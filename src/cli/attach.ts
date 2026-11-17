// The owner's attach setting, data side (RLM-345; RLM-346 adds the CLI, routes and UI on top):
// which pages an agent is attached to, which session a run resumes (Q11), and the rule that
// attach and unattended input exclude each other (Q3, A17). Rows are in hub.db `attach_settings`:
// scope `page` (scope_id = `pages.id`, so every copy of a page shares it, A19) or `project`
// (scope_id = `projects.id`). Nothing here spawns a process.
import type * as sqlite from "node:sqlite";
import type { AgentSessionRow } from "./agent-sessions.ts";
import { ATTACH_MODES } from "./adapters/types.ts";
import type { AttachMode } from "./adapters/types.ts";
import { readCloud } from "./cloud.ts";
import type { Invite } from "./invites.ts";

export type AttachState = "inherit" | "off" | "on";
export type AttachScope = "page" | "project";

/** A row of `attach_settings`. */
export interface AttachSettingRow {
  scope: AttachScope;
  scope_id: string;
  state: AttachState;
  mode: AttachMode | null;
  /** `author` (Q11) or an `agent_sessions.id`. */
  session: string | null;
  /** A harness (`omp`, `copilot`) or a `command` adapter's name. */
  harness: string | null;
  model: string | null;
}

/** The setting that applies to one copy: its page row, unless `inherit`, then its project row, then off. */
export interface EffectiveAttach {
  state: "on" | "off";
  source: "page" | "project" | "default";
  mode: AttachMode;
  session: string;
  harness: string;
  model: string | null;
}

/** The harness of a `new` run when neither the page nor the project names one (Q11). */
export const DEFAULT_HARNESS = "omp";

const isMode = (v: unknown): v is AttachMode => (ATTACH_MODES as readonly unknown[]).includes(v);

/** The ids a copy's settings are stored under: its page (`pages.id`, else the copy's own id) and its project. */
export function scopeIds(db: sqlite.DatabaseSync, artifactId: string): { page: string; project: string | null } {
  const row = db.prepare("SELECT page_id, project_id FROM artifacts WHERE id = ?").get(artifactId) as { page_id: string | null; project_id: string | null } | undefined;
  return { page: row?.page_id || artifactId, project: row?.project_id ?? null };
}

export function readSetting(db: sqlite.DatabaseSync, scope: AttachScope, scopeId: string): AttachSettingRow | null {
  const row = db.prepare("SELECT * FROM attach_settings WHERE scope = ? AND scope_id = ?").get(scope, scopeId) as unknown as AttachSettingRow | undefined;
  return row ?? null;
}

/** The effective attach setting of a copy (docs/review-loop-v2.md "Data model > Attach"). */
export function effectiveAttach(db: sqlite.DatabaseSync, artifactId: string): EffectiveAttach {
  const ids = scopeIds(db, artifactId);
  const page = readSetting(db, "page", ids.page);
  const project = ids.project ? readSetting(db, "project", ids.project) : null;
  const chosen = page && page.state !== "inherit" ? page : project && project.state !== "inherit" ? project : null;
  if (!chosen) return { state: "off", source: "default", mode: "same", session: "author", harness: project?.harness || DEFAULT_HARNESS, model: null };
  return {
    state: chosen.state === "on" ? "on" : "off",
    source: chosen.scope,
    mode: isMode(chosen.mode) ? chosen.mode : "same",
    session: chosen.session || "author",
    // A page row without a harness takes the project's default (Q11), then omp.
    harness: chosen.harness || project?.harness || DEFAULT_HARNESS,
    model: chosen.model || null,
  };
}

/** Where a run goes: the mode it runs in, the harness, and the session it resumes or forks (null for `new`). */
export interface RunTarget {
  mode: AttachMode;
  harness: string;
  session: AgentSessionRow | null;
}

function sessionRow(db: sqlite.DatabaseSync, id: string): AgentSessionRow | null {
  return (db.prepare("SELECT * FROM agent_sessions WHERE id = ?").get(id) as unknown as AgentSessionRow | undefined) ?? null;
}

/** The newest session that continues `row` through `continuation` edges (A14), never a fork; `row` itself when none does. */
export function newestContinuation(db: sqlite.DatabaseSync, row: AgentSessionRow): AgentSessionRow {
  const next = db.prepare("SELECT * FROM agent_sessions WHERE parent_id = ? AND parent_kind = 'continuation' ORDER BY first_seen DESC, rowid DESC LIMIT 1");
  const seen = new Set([row.id]);
  let cur = row;
  for (;;) {
    const child = next.get(cur.id) as unknown as AgentSessionRow | undefined;
    if (!child || seen.has(child.id)) return cur;
    seen.add(child.id);
    cur = child;
  }
}

/** The session that wrote the copy first (its `author`), or null. */
export function authorOf(db: sqlite.DatabaseSync, artifactId: string): AgentSessionRow | null {
  const link = db.prepare("SELECT agent_session_id FROM page_sessions WHERE artifact_id = ? AND role = 'author' ORDER BY at LIMIT 1").get(artifactId) as { agent_session_id: string } | undefined;
  return link ? sessionRow(db, link.agent_session_id) : null;
}

/**
 * The run a setting asks for on this copy (Q11). `author`: the copy's author session, followed
 * through continuation edges to the newest. An explicit `agent_sessions.id` is taken as it is.
 * No session found → `new` with the setting's harness. `new` never looks for a session here (the
 * dispatcher resumes the session its own first `new` run made, A18).
 */
export function resolveTarget(db: sqlite.DatabaseSync, artifactId: string, setting: Pick<EffectiveAttach, "mode" | "session" | "harness">): RunTarget {
  if (setting.mode === "new") return { mode: "new", harness: setting.harness, session: null };
  const author = setting.session === "author";
  const base = author ? authorOf(db, artifactId) : sessionRow(db, setting.session);
  if (!base) return { mode: "new", harness: setting.harness, session: null };
  const session = author ? newestContinuation(db, base) : base;
  return { mode: setting.mode, harness: session.harness, session };
}

/**
 * Why this copy takes notes no owner sent or released (Q3, A17), or null: it is published with
 * `--auto` (cloud.json), or shared with an `--auto` invite. Attach refuses to run on such a page,
 * and `attach on` refuses while this says something.
 */
export function autoConflict(file: string, artifactId: string, invites: readonly Invite[]): string | null {
  if (readCloud().pages[file]?.auto) return `${file} is published with --auto: reviewers' notes reach the agent without the owner`;
  const auto = invites.filter((i) => i.sessionId === artifactId && i.auto).map((i) => i.name);
  if (auto.length) return `${file} is shared with --auto (${auto.join(", ")}): those reviewers' notes reach the agent without the owner`;
  return null;
}
