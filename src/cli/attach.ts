// The owner's attach setting, data side (RLM-345; RLM-346 adds the CLI, routes and UI on top):
// which pages an agent is attached to, which session a run resumes (Q11), and the rule that
// attach and unattended input exclude each other (Q3, A17). Rows are in hub.db `attach_settings`:
// scope `page` (scope_id = `pages.id`, so every copy of a page shares it, A19) or `project`
// (scope_id = `projects.id`). Nothing here spawns a process.
import type * as sqlite from "node:sqlite";
import { liveness, shortId } from "./agent-sessions.ts";
import type { AgentSessionRow } from "./agent-sessions.ts";
import { ADAPTERS, adapterFor, findOnPath } from "./adapters/index.ts";
import { HARNESSES, grantCommand, hasWriteGrant, isHarness } from "./adapters/config.ts";
import type { AdaptersConfig } from "./adapters/config.ts";
import { ATTACH_MODES } from "./adapters/types.ts";
import type { Adapter, AdapterKind, AttachMode, Capabilities } from "./adapters/types.ts";
import { readCloud } from "./cloud.ts";
import { DeviceStore } from "./devices.ts";
import { inTransaction } from "./projects.ts";

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

export const isAttachMode = (v: unknown): v is AttachMode => (ATTACH_MODES as readonly unknown[]).includes(v);

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
  return resolveSetting(readSetting(db, "page", ids.page), ids.project ? readSetting(db, "project", ids.project) : null);
}

/** The page row, unless absent or `inherit` → the project row, unless absent or `inherit` → off. */
export function resolveSetting(page: AttachSettingRow | null, project: AttachSettingRow | null): EffectiveAttach {
  const chosen = page && page.state !== "inherit" ? page : project && project.state !== "inherit" ? project : null;
  if (!chosen) return { state: "off", source: "default", mode: "same", session: "author", harness: project?.harness || DEFAULT_HARNESS, model: null };
  return {
    state: chosen.state === "on" ? "on" : "off",
    source: chosen.scope,
    mode: isAttachMode(chosen.mode) ? chosen.mode : "same",
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

/** Whether a hosted page releases notes at once, given its id and cloud.json's copy of the flag. */
export type LiveAuto = (pageId: string, fallback: boolean) => boolean;

/**
 * Why this copy takes notes no owner sent or released (Q3, A17), or null: it is published with
 * `--auto`, or shared with an `--auto` invite. Attach refuses to run on such a page, and
 * `attach on` refuses while this says something. The server passes `liveAuto` (the page row its
 * last pull cached: --auto may have been turned on on another machine since this one published).
 * Either source saying auto is enough: a cached row that says not auto never overrides
 * cloud.json's auto, since it may predate this machine's own `publish --auto`.
 */
export function autoConflict(db: sqlite.DatabaseSync, file: string, artifactId: string, liveAuto: LiveAuto = (_, fallback) => fallback): string | null {
  const entry = readCloud().pages[file];
  if (entry && (entry.auto || liveAuto(entry.id, entry.auto))) return `${file} is published with --auto: reviewers' notes reach the agent without the owner`;
  const projectId = (db.prepare("SELECT project_id FROM artifacts WHERE id = ?").get(artifactId)?.project_id as string | null | undefined) ?? null;
  const auto = new DeviceStore(db).autoNames(artifactId, projectId);
  if (auto.length) return `${file} is shared with --auto (${auto.join(", ")}): those reviewers' notes reach the agent without the owner`;
  return null;
}

// ── the owner's changes and the status report (RLM-346) ──

/** What `attach on|off`, or the popover, sets besides the state; an absent field keeps the row's value. */
export interface AttachFields {
  mode?: AttachMode;
  /** `author`, or an `agent_sessions.id` (resolve the owner's words with `resolveSessionValue` first). */
  session?: string;
  harness?: string;
  /** "" or null clears it (the harness's own default). */
  model?: string | null;
}

/** Write a row of `attach_settings`, keeping the fields not given. Returns the row as stored. */
export function writeSetting(db: sqlite.DatabaseSync, scope: AttachScope, scopeId: string, state: AttachState, fields: AttachFields = {}): AttachSettingRow {
  const old = readSetting(db, scope, scopeId);
  const row: AttachSettingRow = {
    scope,
    scope_id: scopeId,
    state,
    mode: fields.mode ?? old?.mode ?? null,
    session: fields.session ?? old?.session ?? null,
    harness: fields.harness ?? old?.harness ?? null,
    model: fields.model === undefined ? (old?.model ?? null) : fields.model || null,
  };
  db.prepare("INSERT OR REPLACE INTO attach_settings (scope, scope_id, state, mode, session, harness, model) VALUES (?, ?, ?, ?, ?, ?, ?)").run(
    row.scope,
    row.scope_id,
    row.state,
    row.mode,
    row.session,
    row.harness,
    row.model,
  );
  return row;
}

/**
 * The `agent_sessions.id` the owner means by `value`: that id, a harness session id, or its short
 * id (the six characters `sessions list` shows); `author` stays `author`. Throws when it names no
 * session, or several.
 */
export function resolveSessionValue(db: sqlite.DatabaseSync, value: string): string {
  if (value === "author") return value;
  const rows = db.prepare("SELECT * FROM agent_sessions").all() as unknown as AgentSessionRow[];
  const exact = rows.filter((r) => r.id === value || r.session_id === value);
  const hits = exact.length ? exact : rows.filter((r) => shortId(r.session_id) === value);
  if (hits.length === 1) return hits[0].id;
  if (hits.length > 1) throw new Error(`session ${value} names ${hits.length} sessions (${hits.map((r) => `${r.harness} ${r.session_id}`).join(", ")}); give its full id`);
  throw new Error(`no agent session ${value}: author, or a session \`austere-axi sessions list\` shows (its short id or full id)`);
}

/**
 * Why `harness` can never run `mode`, or null: no adapter of that name, or a mode the adapter does
 * not have (Copilot fork). A binary missing from PATH is not a reason: it may be installed later
 * (`attachReport` warns).
 */
export function unsupported(harness: string, mode: AttachMode, cfg: AdaptersConfig): string | null {
  const adapter = adapterFor(harness, cfg);
  if (!adapter) return `no adapter named ${harness}: a harness (omp, copilot) or a command set with \`austere-axi adapter set <name> --command\``;
  const cap = adapter.capabilities[mode];
  return cap.ok ? null : `${harness} cannot run mode ${mode}: ${cap.reason}`;
}

/** Why the setting cannot be turned on for this copy, or null: its harness, or the session it resolves to, cannot run its mode. */
export function settingProblem(db: sqlite.DatabaseSync, artifactId: string | null, setting: Pick<EffectiveAttach, "mode" | "session" | "harness">, cfg: AdaptersConfig): string | null {
  const own = unsupported(setting.harness, setting.mode, cfg);
  if (own) return own;
  if (!artifactId) {
    const row = setting.session === "author" ? null : sessionRow(db, setting.session);
    return row && row.harness !== setting.harness ? unsupported(row.harness, setting.mode, cfg) : null;
  }
  const target = resolveTarget(db, artifactId, setting);
  return target.harness !== setting.harness ? unsupported(target.harness, target.mode, cfg) : null;
}

/** What each mode, the model and the cost cap of one adapter can do here, for the attach popover. */
export interface HarnessInfo {
  kind: AdapterKind;
  /** Whether its binary is on PATH. */
  found: boolean;
  /** A mode the adapter never has is off with its reason; one it has is on, found or not. */
  capabilities: Capabilities;
  writeGrant: boolean;
  /** The terminal command that grants it, when it has none. */
  grantCommand?: string;
}

export function harnessInfo(adapter: Adapter, cfg: AdaptersConfig, env: NodeJS.ProcessEnv = process.env): HarnessInfo {
  const grant = hasWriteGrant(adapter.id, cfg);
  const info: HarnessInfo = { kind: adapter.id, found: findOnPath(adapter.bin, env) !== null, capabilities: adapter.capabilities, writeGrant: grant };
  if (!grant && isHarness(adapter.id)) info.grantCommand = grantCommand(adapter.id);
  return info;
}

/** Every adapter a page can name: the harnesses, then the owner's command adapters. */
export function harnessInfos(cfg: AdaptersConfig, env: NodeJS.ProcessEnv = process.env): Record<string, HarnessInfo> {
  const out: Record<string, HarnessInfo> = {};
  for (const h of HARNESSES) out[h] = harnessInfo(ADAPTERS[h], cfg, env);
  for (const name of Object.keys(cfg.commands)) out[name] = harnessInfo(adapterFor(name, cfg) as Adapter, cfg, env);
  return out;
}

/** A copy's attach state as `attach status` and the popover show it. */
export interface AttachReport {
  effective: EffectiveAttach;
  page: AttachSettingRow | null;
  project: { id: string; name: string; setting: AttachSettingRow | null } | null;
  /** Where a run would go now: its mode and harness, and the session it resumes or forks (null: a new one). */
  target: RunTarget;
  /** What would go wrong, in words: no write grant (A13), an unsupported or missing harness, an auto page (Q3). */
  warnings: string[];
  /** Why the page takes notes no owner sent (Q3, A17), or null. */
  auto: string | null;
}

/** The report for one copy. `file` and `liveAuto` feed the auto check (with the devices in `db`); `cfg` and `env` the adapter checks. */
export function attachReport(
  db: sqlite.DatabaseSync,
  artifactId: string,
  file: string,
  cfg: AdaptersConfig,
  env: NodeJS.ProcessEnv = process.env,
  liveAuto?: LiveAuto,
): AttachReport {
  const ids = scopeIds(db, artifactId);
  const effective = effectiveAttach(db, artifactId);
  const projectRow = ids.project ? (db.prepare("SELECT id, name FROM projects WHERE id = ?").get(ids.project) as { id: string; name: string } | undefined) : undefined;
  const target = resolveTarget(db, artifactId, effective);
  const auto = autoConflict(db, file, artifactId, liveAuto);
  const warnings = adapterWarnings(target, cfg, env);
  if (target.mode === "same" && target.session && liveness(target.session) === "unknown") {
    warnings.push(`cannot tell whether ${target.session.harness} session ${shortId(target.session.session_id)} is still open (no harness process was recorded for it), so a same run fails with session_unknown: choose fork or new`);
  }
  if (auto && effective.state === "on") warnings.push(`${auto}; runs refuse to start on it (Q3): attach off, or publish or share it without --auto`);
  return {
    effective,
    page: readSetting(db, "page", ids.page),
    project: projectRow ? { ...projectRow, setting: readSetting(db, "project", projectRow.id) } : null,
    target,
    warnings,
    auto,
  };
}

/** What would stop a run of `target` on this machine, or let it run without the right to patch (A13). */
export function adapterWarnings(target: Pick<RunTarget, "mode" | "harness">, cfg: AdaptersConfig, env: NodeJS.ProcessEnv = process.env): string[] {
  const adapter = adapterFor(target.harness, cfg);
  if (!adapter) return [`no adapter named ${target.harness}: runs fail (unavailable). Use omp, copilot, or a command set with \`austere-axi adapter set <name> --command\``];
  const warnings: string[] = [];
  const cap = adapter.capabilities[target.mode];
  if (!cap.ok) warnings.push(`${target.harness} cannot run mode ${target.mode}: ${cap.reason}. Choose another mode`);
  if (!findOnPath(adapter.bin, env)) warnings.push(`${adapter.bin} not found on PATH: runs fail (unavailable) until it is installed`);
  if (!hasWriteGrant(adapter.id, cfg) && isHarness(adapter.id)) {
    warnings.push(
      `${adapter.id} has no write grant: its runs cannot patch the page (${adapter.id} denies writing commands without one and still exits 0, so the run fails with no_reply). The user grants it once, at a terminal: \`${grantCommand(adapter.id)}\``,
    );
  }
  return warnings;
}

/** Why the owner's change was refused: the page is auto (Q3, A17), or the harness cannot run the mode. */
export class AttachRefused extends Error {
  code: "auto_conflict" | "unsupported";
  constructor(code: "auto_conflict" | "unsupported", message: string) {
    super(message);
    this.name = "AttachRefused";
    this.code = code;
  }
}

/** Which row an owner's change writes: a copy's page row (A19), or a project's row. */
export type AttachWhere = { page: { artifactId: string; file: string } } | { projectId: string };

/**
 * The owner's change (Q4: `attach on|off|inherit` at a terminal, or the review page's popover).
 * Refused, with nothing written, when a copy the change leaves on is auto (Q3, A17): whether its
 * page turned on, went back to a project default that is on, or its project's default turned on.
 * Also when the harness, or the session it resumes, cannot run the mode: for the setting itself,
 * and for each copy it leaves on (each resolves its own author, A19). Returns the row as stored.
 */
export function changeSetting(db: sqlite.DatabaseSync, where: AttachWhere, state: AttachState, fields: AttachFields, cfg: AdaptersConfig, liveAuto?: LiveAuto): AttachSettingRow {
  return inTransaction(db, () => {
    const page = "page" in where ? where.page : null;
    const ids = page ? scopeIds(db, page.artifactId) : { page: null, project: (where as { projectId: string }).projectId };
    const row = ids.page !== null ? writeSetting(db, "page", ids.page, state, fields) : writeSetting(db, "project", ids.project as string, state, fields);
    // The copies this row decides for, as the change leaves them on: every copy of the page (A19), or every copy in the project.
    const on: { id: string; file: string }[] = [];
    if (state !== "off") {
      const copies = (
        ids.page !== null ? db.prepare("SELECT id, file FROM artifacts WHERE page_id = ? OR id = ?").all(ids.page, page?.artifactId ?? null) : db.prepare("SELECT id, file FROM artifacts WHERE project_id = ?").all(ids.project)
      ) as { id: string; file: string }[];
      if (page && !copies.some((c) => c.id === page.artifactId)) copies.push({ id: page.artifactId, file: page.file });
      on.push(...copies.filter((c) => effectiveAttach(db, c.id).state === "on"));
      for (const c of on) {
        const conflict = autoConflict(db, c.file, c.id, liveAuto);
        if (!conflict) continue;
        // Throwing rolls the row back.
        const kept = page && state === "on" ? "attach stays off" : "the setting stays as it was";
        throw new AttachRefused("auto_conflict", `${conflict}. Attach and --auto exclude each other (Q3), so ${kept}: publish or share the page without --auto first${page ? "" : ", or turn attach off for that page"}.`);
      }
    }
    if (state === "on") {
      const project = ids.page !== null && ids.project ? readSetting(db, "project", ids.project) : null;
      const problem = settingProblem(db, page?.artifactId ?? null, resolveSetting(ids.page !== null ? row : null, ids.page !== null ? project : row), cfg);
      if (problem) throw new AttachRefused("unsupported", problem);
    }
    // Each copy runs its own target: a project's `author` is one copy's Copilot session and another's omp one.
    for (const c of on) {
      const problem = settingProblem(db, c.id, effectiveAttach(db, c.id), cfg);
      if (problem) throw new AttachRefused("unsupported", `${c.file}: ${problem}`);
    }
    return row;
  });
}
