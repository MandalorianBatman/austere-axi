// @ts-check
// hub.db (SQLite, node:sqlite): the record of every review session (its notes,
// replies and the agent's cursor; see sessions.js), plus an index of every
// artifact reviewed or checked on this machine, by project (git root) and date.
// The hub (`austere-axi hub on`) is the owner's view of it: the home page lists
// every artifact, /notes every note.
import fs from "node:fs";
import path from "node:path";
import { stateDir } from "./paths.js";

export function hubConfigFile() {
  return path.join(stateDir(), "hub.json");
}

export function hubEnabled() {
  try {
    return JSON.parse(fs.readFileSync(hubConfigFile(), "utf8")).enabled === true;
  } catch {
    return false;
  }
}

export function setHubEnabled(enabled) {
  fs.writeFileSync(hubConfigFile(), JSON.stringify({ enabled, changedAt: new Date().toISOString() }) + "\n");
}

export function hubDbFile() {
  return path.join(stateDir(), "hub.db");
}

let DatabaseSync = null;
async function loadSqlite() {
  if (DatabaseSync) return DatabaseSync;
  // node:sqlite prints an ExperimentalWarning on load; the hub is not the place to show it.
  const emit = process.emitWarning;
  process.emitWarning = function (warning, ...rest) {
    if (/sqlite/i.test(String(warning && warning.message ? warning.message : warning))) return;
    return emit.call(process, warning, ...rest);
  };
  try {
    ({ DatabaseSync } = await import("node:sqlite"));
  } finally {
    process.emitWarning = emit;
  }
  return DatabaseSync;
}

/** The project an artifact belongs to: the nearest folder with a .git, else its own folder. */
export function projectOf(file) {
  let dir = path.dirname(file);
  for (;;) {
    if (fs.existsSync(path.join(dir, ".git"))) return dir;
    const up = path.dirname(dir);
    if (up === dir) return path.dirname(file);
    dir = up;
  }
}

/** Open hub.db with the schema in place. */
export async function openDatabase(file = hubDbFile()) {
  const Database = await loadSqlite();
  const db = new Database(file);
  migrate(db);
  return db;
}

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA busy_timeout = 3000;
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

function migrate(db) {
  db.exec(SCHEMA);
  const has = (table, column) => db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === column);
  // Indexes made before team review have no author column.
  if (!has("items", "author")) db.exec("ALTER TABLE items ADD COLUMN author TEXT NOT NULL DEFAULT ''");
  // Before sessions moved into the database, artifacts had no review state of their own.
  if (!has("artifacts", "ended_at")) db.exec("ALTER TABLE artifacts ADD COLUMN ended_at INTEGER");
  if (!has("artifacts", "closed_at")) db.exec("ALTER TABLE artifacts ADD COLUMN closed_at INTEGER");
  if (!has("artifacts", "acked_seq")) db.exec("ALTER TABLE artifacts ADD COLUMN acked_seq INTEGER NOT NULL DEFAULT 0");
  db.exec(NOTES);
}

/** The text the hub shows and searches for one item of a note. */
export function itemText(it) {
  if (it.kind === "annotation") return it.note || it.selection || it.excerpt || "";
  if (it.kind === "action") return it.message || "";
  if (it.kind === "render-error") return it.message || "";
  return it.text ?? it.note ?? "";
}

export class Hub {
  static async open(file = hubDbFile()) {
    return new Hub(await openDatabase(file));
  }

  /** @param {any} db an open hub.db (openDatabase) */
  constructor(db) {
    this.db = db;
    this.q = {
      upsertArtifact: db.prepare(`
        INSERT INTO artifacts (id, file, project, title, created_at, updated_at, reviewed, status, ended_by)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          title = COALESCE(excluded.title, artifacts.title),
          updated_at = MAX(artifacts.updated_at, excluded.updated_at),
          reviewed = MAX(artifacts.reviewed, excluded.reviewed),
          status = COALESCE(excluded.status, artifacts.status),
          ended_by = CASE WHEN excluded.status IS NULL THEN artifacts.ended_by ELSE excluded.ended_by END`),
      artifact: db.prepare(`SELECT * FROM artifacts WHERE id = ?`),
    };
  }

  close() {
    this.db.close();
  }

  /** An artifact `check` or `patch` saw (not necessarily reviewed). */
  register({ id, file, title, at = Date.now() }) {
    this.q.upsertArtifact.run(id, file, projectOf(file), title || null, at, at, 0, null, null);
  }

  artifact(id) {
    return this.q.artifact.get(id) || null;
  }

  /** Artifacts, newest activity first, with feedback counts. `q` filters on title, file and project. */
  list({ q = "", project = "", limit = 500 } = {}) {
    const like = `%${q.replace(/[%_\\]/g, (c) => `\\${c}`)}%`;
    return this.db
      .prepare(
        `SELECT a.*,
           SUM(CASE WHEN i.status = 'open' THEN 1 ELSE 0 END) AS open,
           SUM(CASE WHEN i.status = 'received' THEN 1 ELSE 0 END) AS received,
           SUM(CASE WHEN i.status = 'addressed' THEN 1 ELSE 0 END) AS addressed,
           SUM(CASE WHEN i.status = 'held' THEN 1 ELSE 0 END) AS held
         FROM artifacts a LEFT JOIN items i ON i.artifact_id = a.id
         WHERE (? = '' OR a.title LIKE ? ESCAPE '\\' OR a.file LIKE ? ESCAPE '\\' OR a.project LIKE ? ESCAPE '\\')
           AND (? = '' OR a.project = ?)
         GROUP BY a.id ORDER BY a.updated_at DESC LIMIT ?`,
      )
      .all(q, like, like, like, project, project, limit)
      .map((r) => ({ ...r, open: r.open || 0, received: r.received || 0, addressed: r.addressed || 0, held: r.held || 0 }));
  }

  /**
   * Notes (annotations and messages) across all pages, newest first.
   * `q` matches note text, target and page title. `status`: "unanswered" (held, open and received), "answered", or "" for all.
   * `author`: a reviewer's name, "owner" for the owner's own notes, or "" for everyone. Discarded notes are left out.
   * @param {{ q?: string, status?: string, project?: string, author?: string, limit?: number }} [o]
   */
  notes({ q = "", status = "", project = "", author = "", limit = 200 } = {}) {
    const anyAuthor = author === "" ? "all" : "one";
    const who = author === "owner" ? "" : author;
    const like = `%${q.replace(/[%_\\]/g, (c) => `\\${c}`)}%`;
    return this.db
      .prepare(
        `SELECT i.id, i.artifact_id, i.at, i.kind, i.target, i.text, i.status, i.author,
                a.title, a.file, a.project
         FROM items i JOIN artifacts a ON a.id = i.artifact_id
         WHERE i.kind IN ('annotation', 'message') AND i.status != 'discarded'
           AND (? = 'all' OR i.author = ?)
           AND (? = '' OR i.text LIKE ? ESCAPE '\\' OR i.target LIKE ? ESCAPE '\\' OR a.title LIKE ? ESCAPE '\\')
           AND (? = '' OR a.project = ?)
           AND (? = '' OR (? = 'unanswered' AND i.status != 'addressed') OR (? = 'answered' AND i.status = 'addressed'))
         ORDER BY i.at DESC, i.id LIMIT ?`,
      )
      .all(anyAuthor, who, q, like, like, like, project, project, status, status, status, limit);
  }

  /** Reviewer names with notes in the index (the owner's own notes are not listed). */
  authors() {
    return this.db
      .prepare(`SELECT DISTINCT author FROM items WHERE author != '' AND status != 'discarded' ORDER BY author COLLATE NOCASE`)
      .all()
      .map((r) => String(r.author));
  }

  stats() {
    return this.db
      .prepare(
        `SELECT (SELECT COUNT(*) FROM artifacts) AS artifacts, (SELECT COUNT(DISTINCT project) FROM artifacts) AS projects,
                (SELECT COUNT(*) FROM items WHERE status IN ('open', 'received', 'held')) AS unanswered`,
      )
      .get();
  }
}

/** Register an artifact with the hub from a CLI command, if the hub is on. Never fails the command. */
export async function registerWithHub(file, title, id) {
  if (!hubEnabled()) return;
  try {
    const hub = await Hub.open();
    try {
      hub.register({ id, file, title });
    } finally {
      hub.close();
    }
  } catch {
    // the index is a convenience
  }
}
