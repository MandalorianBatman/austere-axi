// The agent session registry (RLM-343): which harness session wrote, edited or listened to a
// page. A CLI command reports its caller (caller.ts); the server, or the CLI itself when it
// works on hub.db directly, records it here. Session ids stay on this machine: nothing in
// these tables goes into `publish`, `export`, hosted sync or a printed link.
import crypto from "node:crypto";
import type * as sqlite from "node:sqlite";
import { parseSessionOverride, processLiveness } from "./caller.ts";
import type { Caller, CallerHarness, HarnessProcess, Liveness, ProcessTable } from "./caller.ts";
import { Hub } from "./hub.ts";
import { inTransaction } from "./projects.ts";

/** A session's part in a page: `author` opened or patched it first, `editor` opened or patched it later, `listener` polled, replied or read its feedback. */
export type PageRole = "author" | "editor" | "listener";

/** The CLI commands that register their caller. */
export type SessionAction = "open" | "patch" | "poll" | "reply" | "feedback";

/** How one session came from another (A14): `continuation` (omp resumed it in a new session) or `fork`. */
export type ParentKind = "continuation" | "fork";

/** A row of `agent_sessions`. */
export interface AgentSessionRow {
  id: string;
  harness: CallerHarness;
  session_id: string;
  session_file: string | null;
  cwd: string | null;
  model: string | null;
  parent_id: string | null;
  parent_kind: ParentKind | null;
  pid: number | null;
  pid_start: string | null;
  first_seen: number;
  last_seen: number;
}

/** What a CLI command reports about its caller, in the `session` field of its API body. */
export interface CallerReport extends Caller {
  cwd?: string;
  /** The harness process found among the CLI's parents, for liveness. */
  pid?: number;
  pidStart?: string;
}

export function callerReport(caller: Caller, proc: HarnessProcess | null, cwd: string): CallerReport {
  return proc ? { ...caller, cwd, pid: proc.pid, pidStart: proc.start } : { ...caller, cwd };
}

/** The `session` field of an API body: null when absent; throws with the reason when malformed. */
export function parseCallerReport(v: unknown): CallerReport | null {
  if (v === undefined || v === null) return null;
  if (typeof v !== "object" || Array.isArray(v)) throw new Error("session must be an object");
  const o = v as Record<string, unknown>;
  const caller = parseSessionOverride(`${String(o.harness)}:${String(o.sessionId)}`);
  const text = (key: string, max: number): string | undefined => {
    const s = o[key];
    if (s === undefined) return undefined;
    if (typeof s !== "string" || !s || s.length > max) throw new Error(`session.${key} must be a string of at most ${max} characters`);
    return s;
  };
  const sessionFile = text("sessionFile", 4096);
  const cwd = text("cwd", 4096);
  const pidStart = text("pidStart", 64);
  let pid: number | undefined;
  if (o.pid !== undefined) {
    if (typeof o.pid !== "number" || !Number.isInteger(o.pid) || o.pid <= 0) throw new Error("session.pid must be a positive integer");
    pid = o.pid;
  }
  if ((pid === undefined) !== (pidStart === undefined)) throw new Error("session.pid and session.pidStart go together");
  return { ...caller, sessionFile, cwd, pid, pidStart };
}

/**
 * Six characters of a session id: what output shows. The tail, not the head: omp ids are time-ordered
 * (UUIDv7-like), so sessions started close together share their first characters.
 */
export function shortId(sessionId: string): string {
  return sessionId.replace(/-/g, "").slice(-6);
}

/** Link a session to a page in a role; the same link again only moves its time. */
export function linkPage(db: sqlite.DatabaseSync, artifactId: string, agentSessionId: string, role: PageRole, at = Date.now()): void {
  db.prepare(
    `INSERT INTO page_sessions (artifact_id, agent_session_id, role, at) VALUES (?, ?, ?, ?)
     ON CONFLICT(artifact_id, agent_session_id, role) DO UPDATE SET at = MAX(page_sessions.at, excluded.at)`,
  ).run(artifactId, agentSessionId, role, at);
}

/**
 * Record the caller of a CLI command and link it to the pages it worked on: `open` and `patch`
 * make it the page's author when the page has none (or it is the author), else an editor;
 * `poll`, `reply` and `feedback` make it a listener. A known session keeps its first-seen time
 * and the last harness process seen for it.
 */
export function registerSession(db: sqlite.DatabaseSync, report: CallerReport, { artifactIds, action, at = Date.now() }: { artifactIds: string[]; action: SessionAction; at?: number }): AgentSessionRow {
  return inTransaction(db, () => {
    const row = db
      .prepare(
        `INSERT INTO agent_sessions (id, harness, session_id, session_file, cwd, pid, pid_start, first_seen, last_seen)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(harness, session_id) DO UPDATE SET
           session_file = COALESCE(excluded.session_file, agent_sessions.session_file),
           cwd = COALESCE(excluded.cwd, agent_sessions.cwd),
           pid = COALESCE(excluded.pid, agent_sessions.pid),
           pid_start = CASE WHEN excluded.pid IS NULL THEN agent_sessions.pid_start ELSE excluded.pid_start END,
           last_seen = MAX(agent_sessions.last_seen, excluded.last_seen)
         RETURNING *`,
      )
      .get(crypto.randomBytes(6).toString("hex"), report.harness, report.sessionId, report.sessionFile ?? null, report.cwd ?? null, report.pid ?? null, report.pidStart ?? null, at, at) as unknown as AgentSessionRow;
    const writes = action === "open" || action === "patch";
    const authorOf = db.prepare("SELECT agent_session_id FROM page_sessions WHERE artifact_id = ? AND role = 'author' ORDER BY at LIMIT 1");
    for (const artifactId of artifactIds) {
      let role: PageRole = "listener";
      if (writes) {
        const author = authorOf.get(artifactId) as { agent_session_id: string } | undefined;
        role = !author || author.agent_session_id === row.id ? "author" : "editor";
      }
      linkPage(db, artifactId, row.id, role, at);
    }
    return row;
  });
}

/**
 * A new session that continues or forks `fromId` (A14): its harness, folder and model are the
 * parent's. Returns the new row (or the existing one, which keeps its first parent). The caller
 * links it to its pages with `linkPage`.
 */
export function recordContinuation(db: sqlite.DatabaseSync, fromId: string, sessionId: string, kind: ParentKind, at = Date.now()): AgentSessionRow {
  return inTransaction(db, () => {
    const parent = db.prepare("SELECT * FROM agent_sessions WHERE id = ?").get(fromId) as unknown as AgentSessionRow | undefined;
    if (!parent) throw new Error(`no agent session ${fromId}`);
    return db
      .prepare(
        `INSERT INTO agent_sessions (id, harness, session_id, cwd, model, parent_id, parent_kind, first_seen, last_seen)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(harness, session_id) DO UPDATE SET
           parent_id = COALESCE(agent_sessions.parent_id, excluded.parent_id),
           parent_kind = COALESCE(agent_sessions.parent_kind, excluded.parent_kind),
           last_seen = MAX(agent_sessions.last_seen, excluded.last_seen)
         RETURNING *`,
      )
      .get(crypto.randomBytes(6).toString("hex"), parent.harness, sessionId, parent.cwd, parent.model, fromId, kind, at, at) as unknown as AgentSessionRow;
  });
}

/** One session on one page, for `sessions list`. */
export interface PageSession {
  session: AgentSessionRow;
  artifactId: string;
  file: string;
  /** Its roles on the page, author first. */
  roles: PageRole[];
  /** The last time it worked on the page. */
  at: number;
}

const ROLES: PageRole[] = ["author", "editor", "listener"];

/** The sessions of one copy (`artifactId`) or of every copy in a project (`projectId`), the most recent first. */
export function listSessions(db: sqlite.DatabaseSync, where: { artifactId: string } | { projectId: string }): PageSession[] {
  const byPage = "artifactId" in where;
  const rows = db
    .prepare(
      `SELECT s.*, p.artifact_id AS page_artifact, a.file AS page_file, group_concat(p.role) AS page_roles, MAX(p.at) AS page_at
       FROM page_sessions p
       JOIN agent_sessions s ON s.id = p.agent_session_id
       JOIN artifacts a ON a.id = p.artifact_id
       WHERE ${byPage ? "p.artifact_id" : "a.project_id"} = ?
       GROUP BY p.artifact_id, s.id
       ORDER BY page_at DESC, s.id`,
    )
    .all(byPage ? where.artifactId : where.projectId) as unknown as (AgentSessionRow & { page_artifact: string; page_file: string; page_roles: string; page_at: number })[];
  return rows.map(({ page_artifact, page_file, page_roles, page_at, ...session }) => {
    const roles = new Set(page_roles.split(","));
    return { session, artifactId: page_artifact, file: page_file, roles: ROLES.filter((r) => roles.has(r)), at: page_at };
  });
}

/** Whether the session's harness process still runs: `alive`, `exited`, or `unknown` (no process was found at registration, or no process table here). */
export function liveness(row: Pick<AgentSessionRow, "pid" | "pid_start">, table?: ProcessTable | null): Liveness {
  return processLiveness(row.pid, row.pid_start, table);
}

/** Record a caller straight in hub.db, for a command that runs without the server. Never fails the command: false when it could not. */
export async function registerWithHubDb(report: CallerReport, artifactIds: string[], action: SessionAction): Promise<boolean> {
  try {
    const hub = await Hub.open();
    try {
      registerSession(hub.db, report, { artifactIds, action });
      return true;
    } finally {
      hub.close();
    }
  } catch {
    return false;
  }
}
