// The data behind the hub shell: pages with their attention fields, the inbox, projects,
// search, one copy's summary, notes and runs, as `/hub/api/*` answers them (server.ts). The owner's
// only; the server checks the cookie, the Host and the Origin before any of this runs.
import fs from "node:fs";
import path from "node:path";
import type sqlite from "node:sqlite";
import { effectiveAttach, resolveSetting } from "./attach.ts";
import type { AttachSettingRow } from "./attach.ts";
import { listRuns } from "./dispatch.ts";
import { findStatements, headRev, wordsOf } from "./history.ts";
import type { FindHit } from "./history.ts";
import { unanswered } from "./hub.ts";
import type { Hub, HubPage } from "./hub.ts";
import { copyLabel, findProject } from "./projects.ts";
import type {
  CopySummary,
  FailedRun,
  InboxPage,
  InboxResponse,
  InboxRun,
  NoteSummary,
  PagesView,
  ProjectSummary,
  RunItem,
  SearchResponse,
  ShellCopy,
  ShellPage,
} from "../shared/hub-api.ts";

/** Whether an agent is polling for a copy's notes (the server's poll registry). */
export type Listening = (copyId: string) => boolean;

/** What every page of one answer needs, read once per request instead of once per page. */
interface Facts {
  heads: Map<string, { rev: number; at: number }>;
  settings: Map<string, AttachSettingRow>;
  failed: Map<string, FailedRun>;
  /** Copies whose last run is queued, waiting for its session, or running. */
  active: Set<string>;
}

function facts(db: sqlite.DatabaseSync): Facts {
  const heads = new Map<string, { rev: number; at: number }>();
  for (const r of db
    .prepare(
      "SELECT artifact_id, MAX(rev) AS rev, MAX(at) AS at FROM revisions GROUP BY artifact_id",
    )
    .all() as unknown as { artifact_id: string; rev: number; at: number }[]) {
    heads.set(r.artifact_id, { rev: r.rev, at: r.at });
  }
  const settings = new Map<string, AttachSettingRow>();
  for (const r of db
    .prepare("SELECT * FROM attach_settings")
    .all() as unknown as AttachSettingRow[])
    settings.set(`${r.scope}\0${r.scope_id}`, r);
  // The last run of each copy: failed (a later run that did not fail clears it), or still going.
  const failed = new Map<string, FailedRun>();
  const active = new Set<string>();
  const rows = db
    .prepare(
      `SELECT r.id, r.artifact_id, r.status, r.reason, r.ended_at FROM runs r
       JOIN (SELECT artifact_id, MAX(rowid) AS last FROM runs WHERE artifact_id IS NOT NULL GROUP BY artifact_id) x ON r.rowid = x.last
       WHERE r.status IN ('failed', 'queued', 'waiting_for_session', 'running')`,
    )
    .all() as unknown as {
    id: string;
    artifact_id: string;
    status: string;
    reason: string | null;
    ended_at: number | null;
  }[];
  for (const r of rows) {
    if (r.status === "failed")
      failed.set(r.artifact_id, { id: r.id, reason: r.reason, ended_at: r.ended_at });
    else active.add(r.artifact_id);
  }
  return { heads, settings, failed, active };
}

/** A Hub.list() page with its attention fields (docs/hub.md "Inbox"). */
function shellPage(p: HubPage, f: Facts, listening: Listening): ShellPage {
  let activity = p.updated_at;
  const copies: ShellCopy[] = p.copies.map((c) => {
    const head = f.heads.get(c.id);
    const rev = head?.rev ?? 0;
    if (head && head.at > activity) activity = head.at;
    const archived = c.archived_at != null;
    return {
      id: c.id,
      file: c.file,
      root: c.root,
      label: c.label,
      title: c.title,
      updated_at: c.updated_at,
      missing: c.missing,
      archived,
      checked: !c.reviewed,
      open: c.open,
      received: c.received,
      addressed: c.addressed,
      held: c.held,
      unanswered: unanswered(c),
      rev,
      viewed_rev: c.viewed_rev,
      // Never opened by the owner (an upgrade, or a page opened with no browser) is not "changed since you looked".
      changed: c.viewed_rev > 0 && rev > c.viewed_rev ? rev - c.viewed_rev : 0,
      listening: !archived && listening(c.id),
      failed_run: archived ? null : (f.failed.get(c.id) ?? null),
      run_active: !archived && f.active.has(c.id),
    };
  });
  // Rows come newest first: the title opens the newest copy whose file is there.
  const openCopy = copies.find((c) => !c.missing) ?? copies[0];
  const rank = (c: ShellCopy): number => (c.unanswered ? 2 : 0) + (c.listening ? 1 : 0);
  const chips = [...copies].sort((a, b) => rank(b) - rank(a) || b.updated_at - a.updated_at);
  const attach = resolveSetting(
    f.settings.get(`page\0${p.id}`) ?? null,
    f.settings.get(`project\0${p.project_id}`) ?? null,
  ).state;
  const changed = copies.reduce((n, c) => n + c.changed, 0);
  const failed = copies.filter((c) => c.failed_run).length;
  const pending = copies.filter((c) => c.open + c.received > 0);
  const waiting = pending.length > 0;
  const runActive = pending.some((c) => c.run_active);
  const needsYou = changed > 0 || p.held > 0 || failed > 0;
  return {
    id: p.id,
    project_id: p.project_id,
    project: p.project,
    rel_path: p.rel_path,
    title: p.title,
    updated_at: p.updated_at,
    activity,
    open_id: openCopy.id,
    copies: chips,
    unanswered: unanswered(p),
    addressed: p.addressed,
    held: p.held,
    attach,
    needs_you: needsYou,
    changed,
    failed,
    waiting_on_agent: waiting,
    taker: !waiting
      ? null
      : pending.some((c) => c.listening)
        ? "listening"
        : attach === "on"
          ? "attach_on"
          : "nobody",
    run_active: runActive,
    group: needsYou ? "needs_you" : waiting ? "waiting_on_agent" : "quiet",
  };
}

/** Pages of one view, in Hub.list()'s order (projects by newest activity; unanswered first, then by activity). */
export function shellPages(
  hub: Hub,
  {
    project = "",
    view = "open",
    q = "",
    limit = 500,
  }: { project?: string; view?: PagesView; q?: string; limit?: number },
  listening: Listening,
): ShellPage[] {
  const f = facts(hub.db);
  return hub
    .list({ q, project, archived: view === "archived", all: view === "all", limit })
    .map((p) => shellPage(p, f, listening));
}

const byActivity = (a: ShellPage, b: ShellPage): number => b.activity - a.activity;

/** The inbox: pages open for review by group, each with its newest unanswered notes; held notes and failed runs. */
export function shellInbox(
  hub: Hub,
  { project = "" }: { project?: string },
  listening: Listening,
): Omit<InboxResponse, "project"> {
  // Every page open for review: a page that needs the owner must never fall off the end of a list.
  const pages = shellPages(hub, { project, limit: Infinity }, listening);
  const pageOf = new Map<string, InboxPage>();
  const labelOf = new Map<string, string>();
  const groups: Record<"needs_you" | "waiting_on_agent" | "quiet", InboxPage[]> = {
    needs_you: [],
    waiting_on_agent: [],
    quiet: [],
  };
  for (const p of pages) {
    const row: InboxPage = { ...p, notes: [] };
    for (const c of p.copies) {
      pageOf.set(c.id, row);
      labelOf.set(c.id, c.label);
    }
    groups[p.group].push(row);
  }
  // The newest 3 unanswered notes of each copy listed (a page then keeps its newest 3): another page's many notes cannot crowd them out.
  if (pages.some((p) => p.unanswered)) {
    type NoteRow = Omit<NoteSummary, "label">;
    const rows = hub.db
      .prepare(
        `SELECT id, artifact_id, at, kind, target, text, status, author FROM (
           SELECT i.*, ROW_NUMBER() OVER (PARTITION BY i.artifact_id ORDER BY i.at DESC, i.id) AS n
           FROM items i JOIN artifacts a ON a.id = i.artifact_id
           WHERE i.kind IN ('annotation', 'message') AND i.status IN ('open', 'received', 'held')
             AND a.archived_at IS NULL AND a.reviewed = 1 AND (? = '' OR a.project_id = ?))
         WHERE n <= 3 ORDER BY at DESC, id`,
      )
      .all(project, project) as unknown as NoteRow[];
    for (const n of rows) {
      const row = pageOf.get(n.artifact_id);
      if (row && row.notes.length < 3)
        row.notes.push({ ...n, label: labelOf.get(n.artifact_id) ?? "" });
    }
  }
  const failedRuns: InboxRun[] = [];
  for (const p of pages) {
    for (const c of p.copies)
      if (c.failed_run)
        failedRuns.push({
          ...c.failed_run,
          artifact_id: c.id,
          page_id: p.id,
          title: p.title || p.rel_path,
        });
  }
  failedRuns.sort((a, b) => (b.ended_at ?? 0) - (a.ended_at ?? 0));
  return {
    needs_you: groups.needs_you.sort(byActivity),
    waiting_on_agent: groups.waiting_on_agent.sort(byActivity),
    quiet: groups.quiet.sort(byActivity),
    held: pages.reduce((n, p) => n + p.held, 0),
    failed_runs: failedRuns,
  };
}

/** Every project with its roots, and the counts of its pages open for review. */
export function shellProjects(hub: Hub, listening: Listening): ProjectSummary[] {
  const counts = new Map<string, { pages: number; unanswered: number; needs_you: number }>();
  for (const p of shellPages(hub, { limit: 100_000 }, listening)) {
    let c = counts.get(p.project_id);
    if (!c) counts.set(p.project_id, (c = { pages: 0, unanswered: 0, needs_you: 0 }));
    c.pages++;
    c.unanswered += p.unanswered;
    if (p.needs_you) c.needs_you++;
  }
  return hub.projects().map((p) => ({
    id: p.id,
    name: p.name,
    roots: p.roots,
    same_as: p.sameAs
      ? { id: p.sameAs.id, name: p.sameAs.name, merge: `austere-axi ${p.sameAs.merge}` }
      : null,
    ...(counts.get(p.id) ?? { pages: 0, unanswered: 0, needs_you: 0 }),
  }));
}

/** Pages whose title, path or project matches, and statements whose text does (the content index, `find`). */
export function shellSearch(hub: Hub, q: string, listening: Listening): SearchResponse {
  const query = q.trim();
  if (!query) return { q: query, pages: [], parts: [] };
  const pages = shellPages(hub, { q: query, limit: 12 }, listening);
  // `find` ranks a statement by its page's title too: a page listed above needs no part that only shares its title.
  const listed = new Set(pages.map((p) => p.id));
  const words = wordsOf(query);
  const keep = (h: FindHit): boolean =>
    !listed.has(h.page_id ?? h.artifact_id) ||
    words.some((w) => h.snippet.toLowerCase().includes(w) || h.statement.toLowerCase().includes(w));
  // Filter while reading: ask for more candidates until 12 are kept or there are no more.
  let kept: FindHit[] = [];
  for (let limit = 12; ; limit *= 4) {
    const { hits } = findStatements(hub.db, query, { limit });
    kept = hits.filter(keep);
    if (kept.length >= 12 || hits.length < limit || limit >= 768) break;
  }
  const parts = kept.slice(0, 12).map((h) => ({
    artifact_id: h.artifact_id,
    page_id: h.page_id,
    title: h.title,
    file: h.file,
    copy: h.copy,
    statement: h.statement,
    component: h.component,
    snippet: h.snippet,
  }));
  return { q: query, pages, parts };
}

/** One copy for the review header: its page's path and project, the page's other copies, its counts. Null when the hub does not know it. */
export function copySummary(hub: Hub, id: string): CopySummary | null {
  const a = hub.artifact(id);
  if (!a) return null;
  type CopyRow = { id: string; file: string; root: string; archived_at: number | null };
  const rows: CopyRow[] = a.page_id
    ? (hub.db
        .prepare(
          "SELECT id, file, COALESCE(root, project) AS root, archived_at FROM artifacts WHERE page_id = ? AND (reviewed = 1 OR id = ?) ORDER BY updated_at DESC, id",
        )
        .all(a.page_id, id) as unknown as CopyRow[])
    : [{ id: a.id, file: a.file, root: a.root || a.project, archived_at: a.archived_at }];
  const page = a.page_id
    ? hub.db.prepare("SELECT rel_path FROM pages WHERE id = ?").get(a.page_id)
    : undefined;
  const project = a.project_id ? findProject(hub.db, a.project_id, { folders: false }) : null;
  return {
    id: a.id,
    title: a.title,
    file: a.file,
    rel_path: typeof page?.rel_path === "string" ? page.rel_path : path.basename(a.file),
    project: project && { id: project.id, name: project.name },
    copies: rows.map((r) => ({
      id: r.id,
      label: copyLabel(r.root),
      missing: !fs.existsSync(r.file),
      archived: r.archived_at != null,
    })),
    unanswered: hub.notes({ artifact: a.id, status: "unanswered", limit: -1 }).length,
    rev: headRev(hub.db, a.id),
    viewed_rev: a.last_viewed_rev || 0,
    attach: effectiveAttach(hub.db, a.id).state,
  };
}

/** The newest 100 runs, of one project or all, with their page's title. */
export function shellRuns(hub: Hub, { project = "" }: { project?: string }): RunItem[] {
  return listRuns(hub.db, project ? { projectId: project } : null, 100).map((r) => ({
    id: r.id,
    kind: r.kind,
    status: r.status,
    reason: r.reason,
    harness: r.harness,
    mode: r.mode,
    started_at: r.started_at,
    ended_at: r.ended_at,
    artifact_id: r.artifact_id,
    title: r.artifact_id ? (hub.artifact(r.artifact_id)?.title ?? null) : null,
    file: r.file,
  }));
}

/**
 * The copies an archive or unarchive from the shell changes, of the page that holds `id`, and only those whose state
 * changes: so Undo, which sends back exactly these `ids`, never touches a copy another tab or command had already put
 * there. Without `ids`: archive takes `id` and every copy opened for review (as `archive --every-copy`), unarchive every
 * archived copy. Null when the hub does not know `id`.
 */
export function copiesToFlip(
  hub: Hub,
  id: string,
  archive: boolean,
  ids: string[] | null,
): string[] | null {
  const a = hub.artifact(id);
  if (!a) return null;
  type Row = { id: string; reviewed: number; archived_at: number | null };
  const rows: Row[] = a.page_id
    ? (hub.db
        .prepare("SELECT id, reviewed, archived_at FROM artifacts WHERE page_id = ?")
        .all(a.page_id) as unknown as Row[])
    : [{ id: a.id, reviewed: a.reviewed, archived_at: a.archived_at }];
  const asked = ids
    ? rows.filter((r) => ids.includes(r.id))
    : rows.filter((r) => !archive || r.id === a.id || r.reviewed);
  return asked.filter((r) => (r.archived_at == null) === archive).map((r) => r.id);
}
