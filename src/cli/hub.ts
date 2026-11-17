// hub.db (SQLite, node:sqlite): the record of every review session (its notes,
// replies and the agent's cursor; see sessions.ts), plus an index of every
// artifact reviewed or checked on this machine, by project and page (projects.ts).
// The hub is the owner's view of it, always on: the home page lists every page by
// project, /notes every note.
import fs from "node:fs";
import path from "node:path";
import type * as sqlite from "node:sqlite";
import { stateDirHolder } from "./lock.ts";
import { VERSION, stateDir } from "./paths.ts";
import { backfillProjects, copyLabel, inTransaction, resolveProject } from "./projects.ts";
import type { NoteItem } from "./sessions.ts";

/** A row of `artifacts`: every artifact reviewed or checked on this machine (a copy of a page), and its review state. */
export interface ArtifactRow {
  id: string;
  file: string;
  /** The folder it was first filed under (before projects: its git root or folder). */
  project: string;
  project_id: string | null;
  page_id: string | null;
  root: string | null;
  title: string | null;
  created_at: number;
  updated_at: number;
  reviewed: number;
  status: string | null;
  ended_by: string | null;
  ended_at: number | null;
  closed_at: number | null;
  archived_at: number | null;
  acked_seq: number;
}

/** Notes no agent has answered: open, received, or held for the owner (as Hub.notes "unanswered" and Hub.stats count them). */
export function unanswered(c: HubCounts): number {
  return c.open + c.received + c.held;
}

/** How many items of a note stand where. */
export interface HubCounts {
  open: number;
  received: number;
  addressed: number;
  held: number;
}

/** One copy of a page: the file in one root, with its own notes. */
export interface HubCopy extends HubCounts {
  id: string;
  file: string;
  root: string;
  /** The root's branch (or short detached sha), else the root folder's name. */
  label: string;
  title: string | null;
  updated_at: number;
  reviewed: number;
  archived_at: number | null;
  /** The file is gone; its notes are kept. */
  missing: boolean;
}

/** Hub.list(): a page (one path in a project) with its copies, counts summed across them. */
export interface HubPage extends HubCounts {
  id: string;
  project_id: string;
  project: string;
  rel_path: string;
  title: string | null;
  updated_at: number;
  copies: HubCopy[];
}

/** Hub.projects(): a project and its root folders. */
export interface HubProject {
  id: string;
  name: string;
  roots: string[];
}

/** Hub.notes(): one item of a note, with its page and copy. */
export interface HubNoteRow {
  id: string;
  artifact_id: string;
  at: number;
  kind: string;
  target: string | null;
  text: string | null;
  status: string;
  author: string;
  /** 1 when the note came from a hosted page. */
  remote: number;
  title: string | null;
  file: string;
  /** The project's name. */
  project: string;
  project_id: string | null;
  root: string | null;
  /** The copy's label (copyLabel of its root). */
  label: string;
}

/** Hub.viewCounts(): how many pages each view of Hub.list() shows for one search and project. */
export interface HubViewCounts {
  /** The default view: reviewed, not archived. */
  open: number;
  /** Every page. */
  everything: number;
  archived: number;
  /** Pages with a copy that was only checked (never opened for review) and is not archived. */
  checked: number;
}

export function hubDbFile(): string {
  return path.join(stateDir(), "hub.db");
}

let DatabaseSync: typeof sqlite.DatabaseSync | null = null;
async function loadSqlite(): Promise<typeof sqlite.DatabaseSync> {
  if (DatabaseSync) return DatabaseSync;
  // node:sqlite prints an ExperimentalWarning on load; the hub is not the place to show it.
  const emit = process.emitWarning as (this: NodeJS.Process, warning: string | Error, ...rest: unknown[]) => void;
  process.emitWarning = function (warning: string | Error, ...rest: unknown[]) {
    if (/sqlite/i.test(String(typeof warning !== "string" && warning && warning.message ? warning.message : warning))) return;
    return emit.call(process, warning, ...rest);
  };
  try {
    ({ DatabaseSync } = await import("node:sqlite"));
  } finally {
    process.emitWarning = emit as typeof process.emitWarning;
  }
  return DatabaseSync;
}

/**
 * hub.db's schema version, kept in `PRAGMA user_version`. Raise it with every change to migrate():
 * a build whose schema is newer than a database's must not read it without migrating it.
 * 1 is the schema of 0.12.0, the first build that records it.
 */
export const SCHEMA_VERSION = 1;

/** The schema version `db` is at. Before builds recorded it (0), a database 0.12.0 migrated already has version 1's last columns. */
function schemaVersion(db: sqlite.DatabaseSync): number {
  const recorded = Number(db.prepare("PRAGMA user_version").get()?.user_version ?? 0);
  if (recorded) return recorded;
  const has = (table: string, column: string): boolean => db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === column);
  return has("artifacts", "archived_at") && has("project_roots", "prefix") ? 1 : 0;
}

/** Open hub.db with the schema in place; `readOnly`: as it is, refused when it is older than this build's schema. */
export async function openDatabase(file = hubDbFile(), { readOnly = false }: { readOnly?: boolean } = {}): Promise<sqlite.DatabaseSync> {
  const Database = await loadSqlite();
  if (readOnly) {
    const db = new Database(file, { readOnly: true });
    const version = schemaVersion(db);
    if (version < SCHEMA_VERSION) {
      db.close();
      throw new Error(`its schema (version ${version}) is older than this build's (${SCHEMA_VERSION}) and can only be read after a migration`);
    }
    return db;
  }
  // Every note is in here: create it as the owner's only (SQLite gives its WAL the same mode).
  if (file !== ":memory:") fs.closeSync(fs.openSync(file, "a", 0o600));
  const db = new Database(file);
  migrate(db);
  return db;
}

/**
 * Open hub.db for a command that reads or writes it without the server. A server or command of
 * another version that holds the state dir owns its schema: this build neither migrates nor writes
 * it then. A reader opens it read-only (refused when its schema is older); a writer is refused.
 * The error says why (callers name the file).
 */
export async function openHubDirect({ write }: { write: boolean }): Promise<Hub> {
  const holder = await stateDirHolder(stateDir());
  if (!holder || holder.version === VERSION) return Hub.open();
  const who = `austere-axi ${holder.version ? `v${holder.version}` : "of an older version"} (pid ${holder.pid}${holder.port ? `, port ${holder.port}` : ""})`;
  const leave = `this is v${VERSION}, so it leaves the file as it is`;
  const fix = "Stop that one first, or run this command with that version";
  if (write) throw new Error(`it is in use by ${who}; ${leave}. ${fix}`);
  try {
    return new Hub(await openDatabase(hubDbFile(), { readOnly: true }));
  } catch (err) {
    throw new Error(`it is in use by ${who}; ${leave}, and ${err instanceof Error ? err.message : String(err)}. ${fix}`);
  }
}

// journal_mode cannot change inside a transaction: set before migrate() opens one.
const PRAGMAS = `
PRAGMA journal_mode = WAL;
PRAGMA busy_timeout = 3000;
`;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS artifacts (
  id TEXT PRIMARY KEY,
  file TEXT NOT NULL UNIQUE,
  project TEXT NOT NULL,
  title TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  reviewed INTEGER NOT NULL DEFAULT 0,
  status TEXT,
  ended_by TEXT
);
CREATE INDEX IF NOT EXISTS artifacts_project ON artifacts(project, updated_at);
CREATE TABLE IF NOT EXISTS items (
  id TEXT PRIMARY KEY,
  artifact_id TEXT NOT NULL,
  entry_id TEXT NOT NULL,
  at INTEGER NOT NULL,
  kind TEXT NOT NULL,
  target TEXT,
  text TEXT,
  status TEXT NOT NULL,
  data TEXT NOT NULL,
  author TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS items_artifact ON items(artifact_id, at);
CREATE TABLE IF NOT EXISTS replies (
  id TEXT PRIMARY KEY,
  artifact_id TEXT NOT NULL,
  at INTEGER NOT NULL,
  text TEXT NOT NULL
);
`;

// Notes: one row per batch the reviewer sends. `seq` orders what reaches the agent and is
// NULL while a note is held (or after it is discarded); `acked_seq` on the artifact is how
// far the agent has acknowledged. `items` above indexes each piece of a note for the hub.
const NOTES = `
CREATE TABLE IF NOT EXISTS notes (
  id TEXT PRIMARY KEY,
  artifact_id TEXT NOT NULL,
  seq INTEGER UNIQUE,
  state TEXT NOT NULL,
  author TEXT NOT NULL DEFAULT '',
  items TEXT NOT NULL,
  ends INTEGER NOT NULL DEFAULT 0,
  at INTEGER NOT NULL,
  released_at INTEGER,
  seen_at INTEGER,
  work_at INTEGER,
  done_at INTEGER
);
CREATE INDEX IF NOT EXISTS notes_artifact ON notes(artifact_id, at);
`;

// Hosted pages (cloud.json, peer.ts). cloud_rows and cloud_pages are a cache of what the page
// objects hold, dropped and pulled again from 0 when the sync version they were filled under
// changes. cloud_meta holds that version, the outgoing queue's clientId and its next n;
// cloud_queue the mutations not yet acknowledged. notes.remote_id ties a note to its row.
const CLOUD = `
CREATE TABLE IF NOT EXISTS cloud_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS cloud_pages (page_id TEXT PRIMARY KEY, cursor INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS cloud_rows (
  page_id TEXT NOT NULL,
  type TEXT NOT NULL,
  id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  body TEXT NOT NULL,
  PRIMARY KEY (page_id, type, id)
);
CREATE TABLE IF NOT EXISTS cloud_queue (
  n INTEGER PRIMARY KEY,
  page_id TEXT NOT NULL,
  file TEXT NOT NULL,
  name TEXT NOT NULL,
  args TEXT NOT NULL,
  at INTEGER NOT NULL
);
`;

// Projects (projects.ts): a project is a name and its root folders; a page is a path inside a
// root, the same in every root of its project. An artifact is one copy of a page: its id stays
// sha1(absolute path) (URLs, notes and cloud.json key on it); page_id groups the copies.
const PROJECTS = `
CREATE TABLE IF NOT EXISTS projects (id TEXT PRIMARY KEY, name TEXT NOT NULL, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS project_roots (root TEXT PRIMARY KEY, project_id TEXT NOT NULL, kind TEXT NOT NULL, prefix TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS project_roots_project ON project_roots(project_id);
CREATE TABLE IF NOT EXISTS pages (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, rel_path TEXT NOT NULL, UNIQUE (project_id, rel_path));
`;

/** Bring hub.db to the current schema in one transaction; a second run changes nothing. */
function migrate(db: sqlite.DatabaseSync): void {
  db.exec(PRAGMAS);
  inTransaction(db, () => {
    db.exec(SCHEMA);
    const has = (table: string, column: string): boolean => db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === column);
    // Indexes made before team review have no author column.
    if (!has("items", "author")) db.exec("ALTER TABLE items ADD COLUMN author TEXT NOT NULL DEFAULT ''");
    // Before sessions moved into the database, artifacts had no review state of their own.
    if (!has("artifacts", "ended_at")) db.exec("ALTER TABLE artifacts ADD COLUMN ended_at INTEGER");
    if (!has("artifacts", "closed_at")) db.exec("ALTER TABLE artifacts ADD COLUMN closed_at INTEGER");
    if (!has("artifacts", "acked_seq")) db.exec("ALTER TABLE artifacts ADD COLUMN acked_seq INTEGER NOT NULL DEFAULT 0");
    db.exec(NOTES);
    // Notes from before hosted pages have no remote row.
    if (!has("notes", "remote_id")) db.exec("ALTER TABLE notes ADD COLUMN remote_id TEXT");
    db.exec("CREATE UNIQUE INDEX IF NOT EXISTS notes_remote ON notes(remote_id)");
    db.exec(CLOUD);
    db.exec(PROJECTS);
    if (!has("project_roots", "prefix")) db.exec("ALTER TABLE project_roots ADD COLUMN prefix TEXT NOT NULL DEFAULT ''");
    if (!has("artifacts", "project_id")) db.exec("ALTER TABLE artifacts ADD COLUMN project_id TEXT");
    if (!has("artifacts", "page_id")) db.exec("ALTER TABLE artifacts ADD COLUMN page_id TEXT");
    if (!has("artifacts", "root")) db.exec("ALTER TABLE artifacts ADD COLUMN root TEXT");
    if (!has("artifacts", "archived_at")) db.exec("ALTER TABLE artifacts ADD COLUMN archived_at INTEGER");
    // Archive replaces close: a review the owner closed is put away. On every open, not only when the
    // column is added: 0.11.0 added `archived_at` without copying `closed_at`, and a 0.10.4 CLI sharing
    // this hub.db can still close one.
    db.exec("UPDATE artifacts SET archived_at = COALESCE(archived_at, closed_at), closed_at = NULL WHERE closed_at IS NOT NULL");
    db.exec("CREATE INDEX IF NOT EXISTS artifacts_page ON artifacts(page_id)");
    db.exec("CREATE INDEX IF NOT EXISTS artifacts_project_id ON artifacts(project_id, updated_at)");
    backfillProjects(db);
    // Recorded from now on; a newer build's database keeps its number: the steps above are all this build adds.
    if (Number(db.prepare("PRAGMA user_version").get()?.user_version ?? 0) < SCHEMA_VERSION) db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
  });
}

/** A bindable SQLite text value from untrusted item data: strings pass, other shapes become JSON, empty is null. */
export function bindText(v: unknown): string | null {
  return v == null || v === "" ? null : typeof v === "string" ? v : JSON.stringify(v);
}

/** The text the hub shows and searches for one item of a note. */
export function itemText(it: NoteItem): unknown {
  if (it.kind === "annotation") return it.note || it.selection || it.excerpt || "";
  if (it.kind === "action") return it.message || "";
  if (it.kind === "render-error") return it.message || "";
  return it.text ?? it.note ?? "";
}

/** The `q` and `project` filter of Hub.list() and Hub.viewCounts(); its seven parameters come from `filterArgs`. */
const FILTER = `(? = '' OR a.title LIKE ? ESCAPE '\\' OR a.file LIKE ? ESCAPE '\\' OR p.name LIKE ? ESCAPE '\\' OR g.rel_path LIKE ? ESCAPE '\\') AND (? = '' OR a.project_id = ?)`;

function filterArgs(q: string, project: string): string[] {
  const like = `%${q.replace(/[%_\\]/g, (c) => `\\${c}`)}%`;
  return [q, like, like, like, like, project, project];
}

export class Hub {
  db: sqlite.DatabaseSync;
  q: { upsertArtifact: sqlite.StatementSync; artifact: sqlite.StatementSync };

  static async open(file = hubDbFile()): Promise<Hub> {
    return new Hub(await openDatabase(file));
  }

  /** @param db an open hub.db (openDatabase) */
  constructor(db: sqlite.DatabaseSync) {
    this.db = db;
    this.q = {
      upsertArtifact: db.prepare(`
        INSERT INTO artifacts (id, file, project, title, created_at, updated_at, reviewed, project_id, root, page_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          title = COALESCE(excluded.title, artifacts.title),
          updated_at = MAX(artifacts.updated_at, excluded.updated_at),
          reviewed = MAX(artifacts.reviewed, excluded.reviewed),
          project_id = COALESCE(artifacts.project_id, excluded.project_id),
          root = COALESCE(artifacts.root, excluded.root),
          page_id = COALESCE(artifacts.page_id, excluded.page_id)`),
      artifact: db.prepare(`SELECT * FROM artifacts WHERE id = ?`),
    };
  }

  close(): void {
    this.db.close();
  }

  /** An artifact `check` or `patch` saw (not necessarily reviewed); `cwd`: the folder the CLI ran in. */
  register({ id, file, title, at = Date.now(), cwd }: { id: string; file: string; title?: string | null; at?: number; cwd?: string }): void {
    // One transaction: a merge or forget-root in another process cannot prune the page between the two.
    inTransaction(this.db, () => {
      const loc = resolveProject(this.db, file, cwd);
      this.q.upsertArtifact.run(id, file, loc.root, title || null, at, at, 0, loc.projectId, loc.root, loc.pageId);
    });
  }

  artifact(id: string): ArtifactRow | null {
    return (this.q.artifact.get(id) as ArtifactRow | undefined) || null;
  }

  /** Archive a copy (`at`), or bring it back (null). False when it is not in the hub. */
  setArchived(id: string, at: number | null): boolean {
    return Number(this.db.prepare("UPDATE artifacts SET archived_at = ? WHERE id = ?").run(at, id).changes) > 0;
  }

  /**
   * Pages grouped by project (the project with the newest activity first); inside a project, pages
   * with unanswered notes first, then by last activity. Each has its copies and their counts summed.
   * `q` filters on title, file, path inside the root and project name; `project` is a project id.
   * By default a copy that was only checked (never opened for review) or is archived is left out,
   * and a page with no copy left is too; `archived` lists archived copies instead, `all` every copy.
   * A copy whose file is gone is listed, marked `missing`.
   */
  list({ q = "", project = "", archived = false, all = false, limit = 500 }: { q?: string; project?: string; archived?: boolean; all?: boolean; limit?: number } = {}): HubPage[] {
    const view = all ? "all" : archived ? "archived" : "default";
    const rows = this.db
      .prepare(
        `SELECT a.*, COALESCE(p.name, a.project) AS project_name, g.rel_path,
           SUM(CASE WHEN i.status = 'open' THEN 1 ELSE 0 END) AS open,
           SUM(CASE WHEN i.status = 'received' THEN 1 ELSE 0 END) AS received,
           SUM(CASE WHEN i.status = 'addressed' THEN 1 ELSE 0 END) AS addressed,
           SUM(CASE WHEN i.status = 'held' THEN 1 ELSE 0 END) AS held
         FROM artifacts a LEFT JOIN projects p ON p.id = a.project_id LEFT JOIN pages g ON g.id = a.page_id
           LEFT JOIN items i ON i.artifact_id = a.id
         WHERE ${FILTER}
           AND (? = 'all' OR (? = 'archived' AND a.archived_at IS NOT NULL) OR (? = 'default' AND a.archived_at IS NULL AND a.reviewed = 1))
         GROUP BY a.id ORDER BY a.updated_at DESC`,
      )
      .all(...filterArgs(q, project), view, view, view) as unknown as (ArtifactRow & { project_name: string; rel_path: string | null } & Record<keyof HubCounts, number | null>)[];
    const labels = new Map<string, string>();
    const pages = new Map<string, HubPage>();
    for (const r of rows) {
      const root = r.root || r.project;
      let label = labels.get(root);
      if (label === undefined) labels.set(root, (label = copyLabel(root)));
      const copy: HubCopy = {
        id: r.id,
        file: r.file,
        root,
        label,
        title: r.title,
        updated_at: r.updated_at,
        reviewed: r.reviewed,
        archived_at: r.archived_at,
        missing: !fs.existsSync(r.file),
        open: r.open || 0,
        received: r.received || 0,
        addressed: r.addressed || 0,
        held: r.held || 0,
      };
      const key = r.page_id || r.id;
      let page = pages.get(key);
      if (!page) {
        // Rows come newest first: the first copy seen gives the page its title and last activity.
        page = { id: key, project_id: r.project_id || r.project, project: r.project_name, rel_path: r.rel_path ?? path.basename(r.file), title: r.title, updated_at: r.updated_at, open: 0, received: 0, addressed: 0, held: 0, copies: [] };
        pages.set(key, page);
      }
      page.copies.push(copy);
      page.open += copy.open;
      page.received += copy.received;
      page.addressed += copy.addressed;
      page.held += copy.held;
    }
    // Projects by their newest activity (rows come newest first), then the order inside a project.
    const rank = new Map<string, number>();
    for (const p of pages.values()) if (!rank.has(p.project_id)) rank.set(p.project_id, rank.size);
    return [...pages.values()]
      .sort((a, b) => (rank.get(a.project_id) ?? 0) - (rank.get(b.project_id) ?? 0) || Number(unanswered(b) > 0) - Number(unanswered(a) > 0) || b.updated_at - a.updated_at)
      .slice(0, limit);
  }

  /** Every project and its root folders. */
  projects(): HubProject[] {
    const roots = this.db.prepare("SELECT root, project_id FROM project_roots ORDER BY root").all() as unknown as { root: string; project_id: string }[];
    return (this.db.prepare("SELECT id, name FROM projects ORDER BY name COLLATE NOCASE").all() as unknown as { id: string; name: string }[]).map((p) => ({
      ...p,
      roots: roots.filter((r) => r.project_id === p.id).map((r) => r.root),
    }));
  }

  /**
   * Notes (annotations and messages) across all pages, newest first.
   * `q` matches note text, target and page title. `status`: "unanswered" (held, open and received), "answered", or "" for all.
   * `project`: a project id. `author`: a reviewer's name, "owner" for the owner's own notes, or "" for everyone. Discarded notes are left out.
   * `limit` is the most rows returned; -1 returns all.
   */
  notes({ q = "", status = "", project = "", author = "", limit = 200 }: { q?: string; status?: string; project?: string; author?: string; limit?: number } = {}): HubNoteRow[] {
    const anyAuthor = author === "" ? "all" : "one";
    const who = author === "owner" ? "" : author;
    const like = `%${q.replace(/[%_\\]/g, (c) => `\\${c}`)}%`;
    const rows = this.db
      .prepare(
        `SELECT i.id, i.artifact_id, i.at, i.kind, i.target, i.text, i.status, i.author,
                n.remote_id IS NOT NULL AS remote, a.title, a.file, COALESCE(p.name, a.project) AS project, a.project_id, COALESCE(a.root, a.project) AS root
         FROM items i JOIN artifacts a ON a.id = i.artifact_id LEFT JOIN notes n ON n.id = i.entry_id LEFT JOIN projects p ON p.id = a.project_id
         WHERE i.kind IN ('annotation', 'message') AND i.status != 'discarded'
           AND (? = 'all' OR i.author = ?)
           AND (? = '' OR i.text LIKE ? ESCAPE '\\' OR i.target LIKE ? ESCAPE '\\' OR a.title LIKE ? ESCAPE '\\')
           AND (? = '' OR a.project_id = ?)
           AND (? = '' OR (? = 'unanswered' AND i.status != 'addressed') OR (? = 'answered' AND i.status = 'addressed'))
         ORDER BY i.at DESC, i.id LIMIT ?`,
      )
      .all(anyAuthor, who, q, like, like, like, project, project, status, status, status, limit) as unknown as Omit<HubNoteRow, "label">[];
    const labels = new Map<string, string>();
    return rows.map((r) => {
      const root = r.root || "";
      let label = labels.get(root);
      if (label === undefined) labels.set(root, (label = root ? copyLabel(root) : ""));
      return { ...r, label };
    });
  }

  /** Reviewer names with notes in the index (the owner's own notes are not listed). */
  authors(): string[] {
    return this.db
      .prepare(`SELECT DISTINCT author FROM items WHERE author != '' AND status != 'discarded' ORDER BY author COLLATE NOCASE`)
      .all()
      .map((r) => String(r.author));
  }

  /** Pages in each view of `list` for this search and project (the counts the views are labelled with). */
  viewCounts({ q = "", project = "" }: { q?: string; project?: string } = {}): HubViewCounts {
    const page = "COALESCE(a.page_id, a.id)";
    const live = "a.archived_at IS NULL";
    return this.db
      .prepare(
        `SELECT COUNT(DISTINCT CASE WHEN ${live} AND a.reviewed = 1 THEN ${page} END) AS open,
                COUNT(DISTINCT ${page}) AS everything,
                COUNT(DISTINCT CASE WHEN a.archived_at IS NOT NULL THEN ${page} END) AS archived,
                COUNT(DISTINCT CASE WHEN ${live} AND a.reviewed = 0 THEN ${page} END) AS checked
         FROM artifacts a LEFT JOIN projects p ON p.id = a.project_id LEFT JOIN pages g ON g.id = a.page_id
         WHERE ${FILTER}`,
      )
      .get(...filterArgs(q, project)) as unknown as HubViewCounts;
  }
}

/**
 * Whether work is going on: a run is active, or an agent is attached to a page somewhere.
 * The idle exit waits while this is true (RLM-340). The tables come with the dispatcher and
 * the attach settings (RLM-345, RLM-346); before they exist there is no run and no attach,
 * so the answer is false.
 */
export function hasActiveWork(db: sqlite.DatabaseSync): boolean {
  const table = (name: string): boolean => db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`).get(name) != null;
  try {
    if (table("runs") && db.prepare(`SELECT 1 FROM runs WHERE status IN ('queued', 'waiting_for_session', 'running') LIMIT 1`).get()) return true;
    if (table("attach_settings") && db.prepare(`SELECT 1 FROM attach_settings WHERE state = 'on' LIMIT 1`).get()) return true;
  } catch {
    // The table is there but not shaped as expected: treat it as no work.
  }
  return false;
}

/**
 * Whether work is going on, read with a connection of its own. The server's own connection can
 * hold a read snapshot that predates a row another process wrote, so a fresh one is what sees
 * the truth. False when the database is not there yet.
 */
export async function activeWorkNow(file = hubDbFile()): Promise<boolean> {
  const Database = await loadSqlite();
  let db: sqlite.DatabaseSync | null = null;
  try {
    db = new Database(file, { readOnly: true });
    return hasActiveWork(db);
  } catch {
    return false;
  } finally {
    try {
      db?.close();
    } catch {
      // already closed
    }
  }
}

/** Register an artifact with the hub from a CLI command. Never fails the command; skipped while another version holds the state dir. */
export async function registerWithHub(file: string, title: string | null | undefined, id: string): Promise<void> {
  try {
    const hub = await openHubDirect({ write: true });
    try {
      hub.register({ id, file, title, cwd: process.cwd() });
    } finally {
      hub.close();
    }
  } catch {
    // the index is a convenience
  }
}

