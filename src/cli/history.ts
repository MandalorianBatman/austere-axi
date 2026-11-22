// History and the content index (RLM-349 to RLM-351, RLM-353): every version of a page, whole,
// tied to the notes that caused it; every statement of every copy as plain text, with full-text
// search. hub.db is the only store: nothing is written into the project. The tables are made in
// migrate() (hub.ts); the Hub and the server both call these with their connection.
import crypto from "node:crypto";
import fs from "node:fs";
import type * as sqlite from "node:sqlite";
import { mergeStatements } from "@openuidev/lang-core";
import { readArtifact, replaceProgram } from "./artifact.ts";
import { parseArtifact } from "./check.ts";
import { openHubDirect } from "./hub.ts";
import { copyLabel, inTransaction } from "./projects.ts";
import { shortId } from "./agent-sessions.ts";
import type { CallerReport } from "./agent-sessions.ts";
import { programText, statementText } from "../shared/text.ts";
import { closureOf, splitStatements, statementMap } from "../shared/statements.ts";

/** What made a revision: `patch` (the CLI), `file` (an edit the server saw), `open` (a difference found when the page was opened or checked), `restore`. */
export type RevisionSource = "patch" | "file" | "open" | "restore";

/** A row of `revisions`. */
export interface RevisionRow {
  id: number;
  artifact_id: string;
  rev: number;
  at: number;
  source: RevisionSource;
  program: string;
  program_sha: string;
  run_id: string | null;
  agent_session_id: string | null;
  seq_from: number | null;
  seq_to: number | null;
}

/** What a call knows about the change it records. */
export interface RevisionContext {
  source: RevisionSource;
  at?: number;
  /** The agent run it happened in (`AUSTERE_AXI_RUN_ID`); its note range is then the cause. */
  runId?: string | null;
  /** `agent_sessions.id` of the harness session that ran the command. */
  agentSessionId?: string | null;
}

export function programSha(program: string): string {
  return crypto.createHash("sha256").update(program).digest("hex");
}

/** The newest revision of a copy (its program included), or null before the first. */
export function headRevision(db: sqlite.DatabaseSync, artifactId: string): RevisionRow | null {
  return (
    (db
      .prepare("SELECT * FROM revisions WHERE artifact_id = ? ORDER BY rev DESC LIMIT 1")
      .get(artifactId) as unknown as RevisionRow | undefined) ?? null
  );
}

/** The newest `rev` of every copy: what a session's in-memory revision counter starts from. */
export function headRevisions(db: sqlite.DatabaseSync): Map<string, number> {
  const rows = db
    .prepare("SELECT artifact_id, MAX(rev) AS rev FROM revisions GROUP BY artifact_id")
    .all() as unknown as { artifact_id: string; rev: number }[];
  return new Map(rows.map((r) => [r.artifact_id, r.rev]));
}

export function revisionAt(
  db: sqlite.DatabaseSync,
  artifactId: string,
  rev: number,
): RevisionRow | null {
  return (
    (db
      .prepare("SELECT * FROM revisions WHERE artifact_id = ? AND rev = ?")
      .get(artifactId, rev) as unknown as RevisionRow | undefined) ?? null
  );
}

/** Whether the full-text index can be used on this connection: its table exists and SQLite has FTS5. Checked once per connection. */
const ftsChecked = new WeakMap<sqlite.DatabaseSync, boolean>();
export function hasFts(db: sqlite.DatabaseSync): boolean {
  let ok = ftsChecked.get(db);
  if (ok === undefined) {
    try {
      db.prepare("SELECT rowid FROM statements_fts LIMIT 0").all();
      ok = true;
    } catch {
      ok = false;
    }
    ftsChecked.set(db, ok);
  }
  return ok;
}

/**
 * The notes an agent change answers, as a range of note seqs. In a run, the run's own range;
 * else the notes of this copy that were delivered and not answered yet (what `markWorking`
 * marks, but read again for each change, so a second patch for the same notes has the cause too).
 */
function causeOf(
  db: sqlite.DatabaseSync,
  artifactId: string,
  runId: string | null,
): { from: number; to: number } | null {
  if (runId) {
    const run = db
      .prepare("SELECT seq_from, seq_to FROM runs WHERE id = ?")
      .get(runId) as unknown as { seq_from: number | null; seq_to: number | null } | undefined;
    if (run?.seq_from != null && run.seq_to != null) return { from: run.seq_from, to: run.seq_to };
  }
  const r = db
    .prepare(
      "SELECT MIN(seq) AS lo, MAX(seq) AS hi FROM notes WHERE artifact_id = ? AND seq IS NOT NULL AND state != 'discarded' AND seen_at IS NOT NULL AND done_at IS NULL",
    )
    .get(artifactId) as unknown as { lo: number | null; hi: number | null };
  return r.lo == null || r.hi == null ? null : { from: r.lo, to: r.hi };
}

/**
 * Record `html`'s program as the copy's next revision, and put its statements in the index.
 * Nothing happens (null) when the program is the head's: a patch that changes nothing, the
 * server seeing a patch the CLI already recorded. The page must be in `artifacts` already.
 */
export function recordRevision(
  db: sqlite.DatabaseSync,
  artifactId: string,
  html: string,
  ctx: RevisionContext,
): RevisionRow | null {
  const art = readArtifact(html);
  if (art.program == null) return null;
  const program = art.program;
  const sha = programSha(program);
  if (headRevision(db, artifactId)?.program_sha === sha) return null;
  // Parsing is the slow part: do it before the write lock is taken.
  const parsed = parseArtifact(html);
  const texts = programText(program, parsed?.root ?? null, parsed?.spec);
  const sources = statementMap(program);
  return inTransaction(db, () => {
    // Another process may have recorded it since: the head is read again under the lock.
    const head = headRevision(db, artifactId);
    if (head?.program_sha === sha) return null;
    const runId =
      ctx.runId ??
      (
        db
          .prepare(
            "SELECT id FROM runs WHERE artifact_id = ? AND status = 'running' ORDER BY started_at DESC LIMIT 1",
          )
          .get(artifactId) as unknown as { id: string } | undefined
      )?.id ??
      null;
    // An agent's change answers notes. A restore is the owner's act, and what `open` finds is a hand edit or a baseline.
    const cause =
      ctx.source === "patch" || ctx.source === "file" ? causeOf(db, artifactId, runId) : null;
    const rev = (head?.rev ?? 0) + 1;
    const at = ctx.at ?? Date.now();
    const info = db
      .prepare(
        "INSERT INTO revisions (artifact_id, rev, at, source, program, program_sha, run_id, agent_session_id, seq_from, seq_to) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        artifactId,
        rev,
        at,
        ctx.source,
        program,
        sha,
        runId,
        ctx.agentSessionId ?? null,
        cause?.from ?? null,
        cause?.to ?? null,
      );
    writeIndex(
      db,
      artifactId,
      art.title,
      rev,
      texts.map((t) => ({ ...t, source: sources.get(t.name)?.text ?? "" })),
    );
    return {
      id: Number(info.lastInsertRowid),
      artifact_id: artifactId,
      rev,
      at,
      source: ctx.source,
      program,
      program_sha: sha,
      run_id: runId,
      agent_session_id: ctx.agentSessionId ?? null,
      seq_from: cause?.from ?? null,
      seq_to: cause?.to ?? null,
    };
  });
}

/** Replace a copy's rows in `statements` and `statements_fts` with the head revision's. */
function writeIndex(
  db: sqlite.DatabaseSync,
  artifactId: string,
  title: string,
  rev: number,
  rows: { name: string; component: string; text: string; source: string }[],
): void {
  const fts = hasFts(db);
  if (fts)
    db.prepare(
      "DELETE FROM statements_fts WHERE rowid IN (SELECT id FROM statements WHERE artifact_id = ?)",
    ).run(artifactId);
  db.prepare("DELETE FROM statements WHERE artifact_id = ?").run(artifactId);
  const insert = db.prepare(
    "INSERT INTO statements (artifact_id, name, component, text, source, rev) VALUES (?, ?, ?, ?, ?, ?)",
  );
  const index = fts
    ? db.prepare(
        "INSERT INTO statements_fts (rowid, title, name, component, text) VALUES (?, ?, ?, ?, ?)",
      )
    : null;
  for (const r of rows) {
    const info = insert.run(artifactId, r.name, r.component, r.text, r.source, rev);
    index?.run(info.lastInsertRowid, title, r.name, r.component, r.text);
  }
  // A statement that is gone has no origin to show.
  db.prepare(
    "DELETE FROM statement_origins WHERE artifact_id = ? AND name NOT IN (SELECT value FROM json_each(?))",
  ).run(artifactId, JSON.stringify(rows.map((r) => r.name)));
}

/**
 * Record a revision from a CLI command that works on hub.db without the server: `patch` (`after`
 * runs in the same open, for what only that command knows), `check`, `restore`. The page must be
 * registered. Never fails the command: history is a convenience, and a state dir another version
 * holds is left as it is.
 */
export async function recordWithHub(
  artifactId: string,
  html: string,
  source: RevisionSource,
  caller: CallerReport | null,
  after?: (db: sqlite.DatabaseSync, rev: RevisionRow | null) => void,
): Promise<RevisionRow | null> {
  try {
    const hub = await openHubDirect({ write: true });
    try {
      const agent = caller
        ? (hub.db
            .prepare("SELECT id FROM agent_sessions WHERE harness = ? AND session_id = ?")
            .get(caller.harness, caller.sessionId) as unknown as { id: string } | undefined)
        : undefined;
      const rev = recordRevision(hub.db, artifactId, html, {
        source,
        runId: process.env.AUSTERE_AXI_RUN_ID || null,
        agentSessionId: agent?.id ?? null,
      });
      after?.(hub.db, rev);
      return rev;
    } finally {
      hub.close();
    }
  } catch {
    return null;
  }
}

/**
 * The page as it is, kept as a revision before something replaces it, and told whether that worked. Null only when the hub
 * could not be written, which is when the caller must not go on; a program the hub already holds is a success.
 */
export async function keepPage(file: string, id: string, html: string): Promise<boolean> {
  try {
    const hub = await openHubDirect({ write: true });
    try {
      hub.register({ id, file, title: readArtifact(html).title, cwd: process.cwd() });
      recordRevision(hub.db, id, html, { source: "open" });
      return true;
    } finally {
      hub.close();
    }
  } catch {
    return false;
  }
}

/**
 * Rebuild the index (`hub reindex`): every copy whose file is still there is read again, its
 * program becomes a revision when it differs from the head, and its statements are indexed again.
 * Copies whose file is gone lose their index rows (their revisions stay).
 */
export function reindex(db: sqlite.DatabaseSync): {
  copies: number;
  statements: number;
  missing: number;
} {
  const copies = db.prepare("SELECT id, file FROM artifacts").all() as unknown as {
    id: string;
    file: string;
  }[];
  inTransaction(db, () => {
    if (hasFts(db)) db.exec("DELETE FROM statements_fts");
    db.exec("DELETE FROM statements");
  });
  let done = 0;
  let missing = 0;
  for (const c of copies) {
    let html: string;
    try {
      html = fs.readFileSync(c.file, "utf8");
    } catch {
      missing++;
      continue;
    }
    const art = readArtifact(html);
    if (art.program == null) continue;
    // Empty index: the head's program is indexed even when it is the file's own.
    const head = headRevision(db, c.id);
    if (head && head.program_sha === programSha(art.program)) {
      const parsed = parseArtifact(html);
      const sources = statementMap(art.program);
      const texts = programText(art.program, parsed?.root ?? null, parsed?.spec);
      // Another process may have recorded a newer revision since: its index is not replaced by this snapshot.
      inTransaction(db, () => {
        if (headRevision(db, c.id)?.rev === head.rev)
          writeIndex(
            db,
            c.id,
            art.title,
            head.rev,
            texts.map((t) => ({ ...t, source: sources.get(t.name)?.text ?? "" })),
          );
      });
    } else {
      recordRevision(db, c.id, html, { source: "open" });
    }
    done++;
  }
  const statements = Number(
    (db.prepare("SELECT COUNT(*) AS n FROM statements").get() as unknown as { n: number }).n,
  );
  return { copies: done, statements, missing };
}

// ── reading history ──

/** A note that caused a revision. */
export interface CauseNote {
  seq: number;
  at: number;
  author: string;
  target: string | null;
  text: string;
}

/** The notes of a copy in a seq range: annotations, messages and form answers, oldest first. */
export function causeNotes(
  db: sqlite.DatabaseSync,
  artifactId: string,
  from: number | null,
  to: number | null,
): CauseNote[] {
  if (from == null || to == null) return [];
  const rows = db
    .prepare(
      `SELECT n.seq, n.at, i.author, i.target, i.text, i.kind
       FROM notes n JOIN items i ON i.entry_id = n.id
       WHERE n.artifact_id = ? AND n.seq BETWEEN ? AND ? AND i.kind IN ('annotation', 'message', 'action') AND i.status != 'discarded'
       ORDER BY n.seq, i.at, i.id`,
    )
    .all(artifactId, from, to) as unknown as {
    seq: number;
    at: number;
    author: string;
    target: string | null;
    text: string | null;
  }[];
  return rows.map((r) => ({
    seq: r.seq,
    at: r.at,
    author: r.author || "owner",
    target: r.target,
    text: r.text ?? "",
  }));
}

/** A statement with its whitespace collapsed outside string literals: a value's own spaces are part of it. */
function squash(text: string): string {
  let out = "";
  let quote = "";
  let space = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    // A comment (outside a string) is not part of the statement, and a quote in it opens nothing.
    if (!quote && (c === "#" || (c === "/" && text[i + 1] === "/"))) {
      while (i + 1 < text.length && text[i + 1] !== "\n") i++;
      space = true;
      continue;
    }
    if (quote) {
      out += c;
      if (c === "\\") out += text[++i] ?? "";
      else if (c === quote) quote = "";
    } else if (/\s/.test(c)) space = true;
    else {
      if (space && out) out += " ";
      space = false;
      out += c;
      if (c === '"' || c === "'") quote = c;
    }
  }
  return out;
}

/** What a revision changed against the one before it (none before it: every statement is new). */
export function diffStatements(
  prev: string | null,
  next: string,
): { changed: string[]; removed: string[] } {
  const before = statementMap(prev);
  const after = statementMap(next);
  const changed: string[] = [];
  for (const [id, s] of after) {
    const b = before.get(id);
    if (!b || squash(b.text) !== squash(s.text)) changed.push(id);
  }
  return { changed, removed: [...before.keys()].filter((id) => !after.has(id)) };
}

/** A revision as `history` lists it. */
export interface RevisionSummary {
  id: number;
  rev: number;
  at: number;
  source: RevisionSource;
  /** Statements new or different against the revision before (for the first revision, all of them). */
  changed: string[];
  removed: string[];
  /** The first revision: how many statements the page began with. */
  created?: number;
  cause: CauseNote[];
  run_id: string | null;
  agent_session_id: string | null;
}

/**
 * The revisions of a copy, newest first: what each changed and the notes behind it.
 * `statement`: only those that changed it. `since`: only after that `rev`. `limit`: the newest n.
 */
export function revisionLog(
  db: sqlite.DatabaseSync,
  artifactId: string,
  {
    statement,
    since = 0,
    limit = 200,
  }: { statement?: string; since?: number; limit?: number } = {},
): RevisionSummary[] {
  // Without a statement, only the newest `limit` revisions (and the one before them, to diff against) are read. A statement's
  // history needs every revision, to know which ones changed it.
  const rows = statement
    ? (db
        .prepare("SELECT * FROM revisions WHERE artifact_id = ? ORDER BY rev")
        .all(artifactId) as unknown as RevisionRow[])
    : (
        db
          .prepare(
            "SELECT * FROM revisions WHERE artifact_id = ? AND rev >= ? ORDER BY rev DESC LIMIT ?",
          )
          .all(artifactId, since, limit + 1) as unknown as RevisionRow[]
      ).reverse();
  const kept: { row: RevisionRow; changed: string[]; removed: string[] }[] = [];
  let prev: string | null = null;
  rows.forEach((r, i) => {
    // The first row of a window is only what the next one is compared with, unless it is the page's first revision.
    const context = !statement && i === 0 && (rows.length > limit || r.rev <= since) && r.rev > 1;
    if (!context) {
      const { changed, removed } = diffStatements(prev, r.program);
      if (
        r.rev > since &&
        (!statement || changed.includes(statement) || removed.includes(statement))
      )
        kept.push({ row: r, changed, removed });
    }
    prev = r.program;
  });
  return kept
    .reverse()
    .slice(0, limit)
    .map(({ row: r, changed, removed }) => ({
      id: r.id,
      rev: r.rev,
      at: r.at,
      source: r.source,
      changed,
      removed,
      ...(r.rev === 1 ? { created: changed.length } : {}),
      cause: causeNotes(db, artifactId, r.seq_from, r.seq_to),
      run_id: r.run_id,
      agent_session_id: r.agent_session_id,
    }));
}

/** Plain text of every statement of a stored program, parsed with the page's packs (those of `html`, the current file, when it is still there). */
export function textsOfProgram(program: string, html: string | null): Map<string, string> {
  const parsed = html == null ? null : parseArtifact(replaceProgram(html, program));
  const rows = programText(program, parsed?.root ?? null, parsed?.spec);
  return new Map(rows.map((t) => [t.name, t.text]));
}

/** The reply an agent gave after a revision, before the next one; null when it gave none. */
function replyAfter(
  db: sqlite.DatabaseSync,
  artifactId: string,
  from: number,
  until: number,
): string | null {
  const r = db
    .prepare(
      "SELECT text FROM replies WHERE artifact_id = ? AND at >= ? AND at < ? ORDER BY at LIMIT 1",
    )
    .get(artifactId, from, until) as unknown as { text: string } | undefined;
  return r?.text ?? null;
}

/** One revision as `changes` reports it. */
export interface ChangeEntry {
  id: number;
  file: string;
  copy: string;
  title: string | null;
  rev: number;
  at: number;
  source: RevisionSource;
  statements: { name: string; before: string | null; after: string | null }[];
  /** The page's first revision: how many statements it began with (no before and after for each of them). */
  created?: number;
  cause: CauseNote[];
  reply: string | null;
}

/**
 * The revisions after the global revision id `cursor`, oldest first, up to `limit`.
 * `artifactId`: one copy; `projectId`: every copy of a project; neither: all. `next` is the cursor to ask with next time.
 */
export function changesSince(
  db: sqlite.DatabaseSync,
  {
    cursor = 0,
    artifactId,
    projectId,
    limit = 20,
  }: { cursor?: number; artifactId?: string; projectId?: string; limit?: number } = {},
): { changes: ChangeEntry[]; next: number } {
  const rows = db
    .prepare(
      `SELECT r.* FROM revisions r JOIN artifacts a ON a.id = r.artifact_id
       WHERE r.id > ? AND (? = '' OR r.artifact_id = ?) AND (? = '' OR a.project_id = ?)
       ORDER BY r.id LIMIT ?`,
    )
    .all(
      cursor,
      artifactId ?? "",
      artifactId ?? "",
      projectId ?? "",
      projectId ?? "",
      limit,
    ) as unknown as RevisionRow[];
  const changes: ChangeEntry[] = [];
  const cache = new Map<string, Map<string, string>>();
  for (const r of rows) {
    const art = db
      .prepare("SELECT file, title, root, project FROM artifacts WHERE id = ?")
      .get(r.artifact_id) as unknown as
      | { file: string; title: string | null; root: string | null; project: string }
      | undefined;
    if (!art) continue;
    let html: string | null = null;
    try {
      html = fs.readFileSync(art.file, "utf8");
    } catch {
      // gone: its components from a pack read as their source text
    }
    const prior = r.rev > 1 ? revisionAt(db, r.artifact_id, r.rev - 1) : null;
    const textsFor = (rev: RevisionRow | null): Map<string, string> => {
      if (!rev) return new Map();
      const key = `${rev.artifact_id}:${rev.rev}`;
      let t = cache.get(key);
      if (!t) cache.set(key, (t = textsOfProgram(rev.program, html)));
      return t;
    };
    const { changed, removed } = diffStatements(prior?.program ?? null, r.program);
    const after = textsFor(r);
    const before = textsFor(prior);
    const next = db
      .prepare("SELECT at FROM revisions WHERE artifact_id = ? AND rev = ?")
      .get(r.artifact_id, r.rev + 1) as unknown as { at: number } | undefined;
    changes.push({
      id: r.id,
      file: art.file,
      copy: copyLabel(art.root || art.project),
      title: art.title,
      rev: r.rev,
      at: r.at,
      source: r.source,
      statements:
        r.rev === 1
          ? []
          : [...changed, ...removed].map((name) => ({
              name,
              before: before.get(name) ?? null,
              after: removed.includes(name) ? null : (after.get(name) ?? null),
            })),
      ...(r.rev === 1 ? { created: changed.length } : {}),
      cause: causeNotes(db, r.artifact_id, r.seq_from, r.seq_to),
      reply:
        r.source === "patch" || r.source === "file"
          ? replyAfter(db, r.artifact_id, r.at, next?.at ?? Number.MAX_SAFE_INTEGER)
          : null,
    });
  }
  return { changes, next: rows.length ? rows[rows.length - 1].id : cursor };
}

/** A decision: a form the reviewer submitted or a button they pressed (`action`), or a batch sent with Send & finish (`final`). */
export interface DecisionEntry {
  seq: number;
  at: number;
  kind: "action" | "final";
  file: string;
  copy: string;
  title: string | null;
  statement: string | null;
  author: string;
  message: string;
  form?: unknown;
}

/** Decisions after the note seq `cursor`, oldest first. `next` is the cursor to ask with next time. */
export function decisionsSince(
  db: sqlite.DatabaseSync,
  {
    cursor = 0,
    artifactId,
    projectId,
    limit = 50,
  }: { cursor?: number; artifactId?: string; projectId?: string; limit?: number } = {},
): { decisions: DecisionEntry[]; next: number } {
  const rows = db
    .prepare(
      `SELECT n.seq, n.at, n.author, n.ends, n.id AS note_id, a.file, a.title, a.root, a.project
       FROM notes n JOIN artifacts a ON a.id = n.artifact_id
       WHERE n.seq > ? AND n.seq IS NOT NULL AND n.state != 'discarded' AND (? = '' OR n.artifact_id = ?) AND (? = '' OR a.project_id = ?)
         AND (n.ends = 1 OR EXISTS (SELECT 1 FROM items i WHERE i.entry_id = n.id AND i.kind = 'action'))
       ORDER BY n.seq LIMIT ?`,
    )
    .all(
      cursor,
      artifactId ?? "",
      artifactId ?? "",
      projectId ?? "",
      projectId ?? "",
      limit,
    ) as unknown as {
    seq: number;
    at: number;
    author: string;
    ends: number;
    note_id: string;
    file: string;
    title: string | null;
    root: string | null;
    project: string;
  }[];
  const out: DecisionEntry[] = [];
  for (const n of rows) {
    const base = {
      seq: n.seq,
      at: n.at,
      file: n.file,
      copy: copyLabel(n.root || n.project),
      title: n.title,
      author: n.author || "owner",
    };
    const actions = db
      .prepare("SELECT data FROM items WHERE entry_id = ? AND kind = 'action' ORDER BY at, id")
      .all(n.note_id) as unknown as { data: string }[];
    for (const a of actions) {
      let item: { message?: unknown; form?: unknown; context?: unknown } = {};
      try {
        item = JSON.parse(a.data);
      } catch {
        // an item that is not JSON has no form to show
      }
      out.push({
        ...base,
        kind: "action",
        statement: null,
        message: String(item.message ?? ""),
        form: item.form,
      });
    }
    if (n.ends) {
      const last = db
        .prepare(
          "SELECT target, text FROM items WHERE entry_id = ? AND kind IN ('annotation', 'message') ORDER BY at DESC, id DESC LIMIT 1",
        )
        .get(n.note_id) as unknown as { target: string | null; text: string | null } | undefined;
      out.push({
        ...base,
        kind: "final",
        statement: last?.target ?? null,
        message: last?.text ?? "",
      });
    }
  }
  return { decisions: out, next: rows.length ? rows[rows.length - 1].seq : cursor };
}

// ── find ──

/** A hit of `find`. */
export interface FindHit {
  artifact_id: string;
  page_id: string | null;
  title: string | null;
  file: string;
  copy: string;
  statement: string;
  component: string;
  snippet: string;
  updated_at: number;
  archived: boolean;
  missing: boolean;
}

const WORD = /[\p{L}\p{N}_]+/gu;

/** The words of a search: letters and digits, lowercased. */
export function wordsOf(text: string): string[] {
  return (text.toLowerCase().match(WORD) ?? []).slice(0, 12);
}

/** About 90 characters of `text` around the first of the words it holds. */
export function snippetOf(text: string, ws: string[]): string {
  const flat = text.replace(/\s+/g, " ").trim();
  const lower = flat.toLowerCase();
  const at = Math.max(
    0,
    Math.min(...ws.map((w) => lower.indexOf(w)).filter((i) => i >= 0), flat.length),
  );
  const from = Math.max(0, at - 30);
  const cut = flat.slice(from, from + 90);
  return `${from > 0 ? "…" : ""}${cut}${from + 90 < flat.length ? "…" : ""}`;
}

/**
 * Search the statements of every copy. Full-text (FTS5, every word a prefix, best match first;
 * if no page has all the words, any of them); `LIKE` where FTS5 is missing. A page in several
 * worktrees is one hit (the best copy). Archived pages and copies whose file is gone are left out unless `all`.
 */
export function findStatements(
  db: sqlite.DatabaseSync,
  query: string,
  {
    projectId = "",
    component = "",
    limit = 8,
    all = false,
  }: { projectId?: string; component?: string; limit?: number; all?: boolean } = {},
): { hits: FindHit[]; fts: boolean } {
  const ws = wordsOf(query);
  if (!ws.length) return { hits: [], fts: hasFts(db) };
  const filter = `AND (? = '' OR a.project_id = ?) AND (? = '' OR s.component = ?) AND (? = 1 OR a.archived_at IS NULL)`;
  const args = [projectId, projectId, component, component, all ? 1 : 0];
  let fts = hasFts(db);
  /** Candidate statements, best first: at most `fetch` of them. */
  const candidates = (fetch: number): FindRow[] => {
    let rows: FindRow[] = [];
    if (fts) {
      try {
        for (const joiner of [" AND ", " OR "]) {
          const match = ws.map((w) => `"${w.replace(/"/g, '""')}"*`).join(joiner);
          rows = db
            .prepare(
              `SELECT s.artifact_id, s.name, s.component, s.text, a.title, a.file, a.page_id, a.root, a.project, a.updated_at, a.archived_at
               FROM statements_fts f JOIN statements s ON s.id = f.rowid JOIN artifacts a ON a.id = s.artifact_id
               WHERE statements_fts MATCH ? ${filter}
               ORDER BY bm25(statements_fts, 3.0, 2.0, 0.5, 1.0), a.updated_at DESC LIMIT ?`,
            )
            .all(match, ...args, fetch) as unknown as FindRow[];
          if (rows.length || ws.length === 1) break;
        }
        return rows;
      } catch {
        fts = false;
      }
    }
    const like = (w: string): string => `%${w.replace(/[%_\\]/g, (c) => `\\${c}`)}%`;
    const sql = (joiner: string): string =>
      ws
        .map(
          () =>
            "(s.text LIKE ? ESCAPE '\\' OR s.name LIKE ? ESCAPE '\\' OR a.title LIKE ? ESCAPE '\\')",
        )
        .join(joiner);
    for (const joiner of [" AND ", " OR "]) {
      rows = db
        .prepare(
          `SELECT s.artifact_id, s.name, s.component, s.text, a.title, a.file, a.page_id, a.root, a.project, a.updated_at, a.archived_at
           FROM statements s JOIN artifacts a ON a.id = s.artifact_id
           WHERE (${sql(joiner)}) ${filter} ORDER BY a.updated_at DESC LIMIT ?`,
        )
        .all(
          ...ws.flatMap((w) => [like(w), like(w), like(w)]),
          ...args,
          fetch,
        ) as unknown as FindRow[];
      if (rows.length || ws.length === 1) break;
    }
    return rows;
  };
  /** The hits among `rows`: one per page and statement, at most 3 a page (one page must not fill the list), and no copy whose file is gone unless `all`. */
  const pick = (rows: FindRow[]): FindHit[] => {
    const seen = new Set<string>();
    const perPage = new Map<string, number>();
    const hits: FindHit[] = [];
    for (const r of rows) {
      const missing = !fs.existsSync(r.file);
      // A copy that is gone must not hide the same statement in a copy that is there.
      if (missing && !all) continue;
      const page = r.page_id ?? r.artifact_id;
      const key = `${page}\0${r.name}`;
      if (seen.has(key) || (perPage.get(page) ?? 0) >= 3) continue;
      seen.add(key);
      perPage.set(page, (perPage.get(page) ?? 0) + 1);
      hits.push({
        artifact_id: r.artifact_id,
        page_id: r.page_id,
        title: r.title,
        file: r.file,
        copy: copyLabel(r.root || r.project),
        statement: r.name,
        component: r.component,
        snippet: snippetOf(r.text || r.name, ws),
        updated_at: r.updated_at,
        archived: r.archived_at != null,
        missing,
      });
      if (hits.length >= limit) break;
    }
    return hits;
  };
  // The limit is for the hits, not the candidates: ask for more until enough survive the filters, or none are left.
  let fetch = limit * 6 + 20;
  for (;;) {
    const rows = candidates(fetch);
    const hits = pick(rows);
    if (hits.length >= limit || rows.length < fetch || fetch >= 20_000) return { hits, fts };
    fetch *= 4;
  }
}

interface FindRow {
  artifact_id: string;
  name: string;
  component: string;
  text: string;
  title: string | null;
  file: string;
  page_id: string | null;
  root: string | null;
  project: string;
  updated_at: number;
  archived_at: number | null;
}

/** How long ago, as one short word: 5m, 3h, 2d. */
export function ageOf(at: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - at) / 1000));
  if (s < 90) return `${s}s`;
  if (s < 5400) return `${Math.round(s / 60)}m`;
  if (s < 129600) return `${Math.round(s / 3600)}h`;
  return `${Math.round(s / 86400)}d`;
}

// ── similar pages (RLM-353) ──

const GENERIC = new Set([
  "the",
  "and",
  "for",
  "with",
  "from",
  "into",
  "page",
  "plan",
  "review",
  "doc",
  "docs",
  "report",
  "notes",
  "summary",
  "draft",
  "new",
  "old",
]);

/** The meaningful words of a heading: lowercase, plural s removed, no filler. */
function headingWords(text: string): Set<string> {
  return new Set(
    wordsOf(text)
      .filter((w) => w.length >= 3 && !GENERIC.has(w))
      .map((w) => (w.length > 3 && w.endsWith("s") ? w.slice(0, -1) : w)),
  );
}

/** Two headings say the same thing: they share two words, or every word of the shorter one. */
function sameHeading(a: Set<string>, b: Set<string>): boolean {
  if (!a.size || !b.size) return false;
  let shared = 0;
  for (const w of a) if (b.has(w)) shared++;
  return shared >= 2 || shared === Math.min(a.size, b.size);
}

/** A page `open` says is like the one just opened. */
export interface SimilarPage {
  title: string | null;
  file: string;
  updated_at: number;
}

/**
 * Pages of the same project, not archived, with a title or a card heading like this page's: at most 3, newest first.
 * `headings` are the new page's title and the first lines of its `CardHeader` statements.
 */
export function similarPages(
  db: sqlite.DatabaseSync,
  {
    artifactId,
    projectId,
    headings,
  }: { artifactId: string; projectId: string | null; headings: string[] },
): SimilarPage[] {
  const mine = headings.map(headingWords).filter((s) => s.size);
  if (!mine.length || !projectId) return [];
  const mePage =
    (
      db.prepare("SELECT page_id FROM artifacts WHERE id = ?").get(artifactId) as unknown as
        | { page_id: string | null }
        | undefined
    )?.page_id ?? null;
  const rows = db
    .prepare(
      "SELECT id, file, title, page_id, updated_at FROM artifacts WHERE project_id = ? AND id != ? AND archived_at IS NULL ORDER BY updated_at DESC",
    )
    .all(projectId, artifactId) as unknown as {
    id: string;
    file: string;
    title: string | null;
    page_id: string | null;
    updated_at: number;
  }[];
  const out: SimilarPage[] = [];
  const pages = new Set<string>();
  for (const r of rows) {
    if (
      (mePage && r.page_id === mePage) ||
      (r.page_id && pages.has(r.page_id)) ||
      !fs.existsSync(r.file)
    )
      continue;
    const theirs = [
      r.title ?? "",
      ...(
        db
          .prepare("SELECT text FROM statements WHERE artifact_id = ? AND component = 'CardHeader'")
          .all(r.id) as unknown as { text: string }[]
      ).map((h) => h.text.split("\n")[0]),
    ].map(headingWords);
    if (mine.some((a) => theirs.some((b) => sameHeading(a, b)))) {
      out.push({ title: r.title, file: r.file, updated_at: r.updated_at });
      if (r.page_id) pages.add(r.page_id);
      if (out.length === 3) break;
    }
  }
  return out;
}

/** The text of one statement of a stored program, for `show --rev`: the same projection as the index. */
export function statementTextOf(program: string, name: string, html: string | null): string | null {
  if (!statementMap(program).has(name)) return null;
  const parsed = html == null ? null : parseArtifact(replaceProgram(html, program));
  const source =
    splitStatements(program)
      .filter((s) => s.id === name)
      .pop()?.text ?? "";
  return statementText(parsed?.root ?? null, name, source, parsed?.spec).text;
}

// ── the review page's history (RLM-352) ──

/** The newest `rev` of a copy, 0 before the first. */
export function headRev(db: sqlite.DatabaseSync, artifactId: string): number {
  return Number(
    (
      db
        .prepare("SELECT MAX(rev) AS rev FROM revisions WHERE artifact_id = ?")
        .get(artifactId) as unknown as { rev: number | null }
    ).rev ?? 0,
  );
}

/** The newest revision the owner had the page open on. */
export function viewedRev(db: sqlite.DatabaseSync, artifactId: string): number {
  return Number(
    (
      db
        .prepare("SELECT last_viewed_rev AS v FROM artifacts WHERE id = ?")
        .get(artifactId) as unknown as { v: number } | undefined
    )?.v ?? 0,
  );
}

/** The owner had the page open on revision `rev`; it never goes back. */
export function setViewedRev(db: sqlite.DatabaseSync, artifactId: string, rev: number): void {
  db.prepare("UPDATE artifacts SET last_viewed_rev = MAX(last_viewed_rev, ?) WHERE id = ?").run(
    rev,
    artifactId,
  );
}

/** A statement's earlier texts: each revision that changed it, newest first, with the note behind it. `text` is null where the revision deleted it. */
export interface StatementVersion {
  rev: number;
  at: number;
  source: RevisionSource;
  text: string | null;
  cause: CauseNote[];
}

export function statementVersions(
  db: sqlite.DatabaseSync,
  artifactId: string,
  name: string,
  html: string | null,
  limit = 12,
): StatementVersion[] {
  const out: StatementVersion[] = [];
  for (const r of revisionLog(db, artifactId, { statement: name })) {
    if (out.length >= limit) break;
    const rev = revisionAt(db, artifactId, r.rev);
    if (!rev) continue;
    out.push({
      rev: r.rev,
      at: r.at,
      source: r.source,
      text: r.removed.includes(name) ? null : statementTextOf(rev.program, name, html),
      cause: r.cause,
    });
  }
  return out;
}

/**
 * The program that puts `old` back: whole (no `names`), or the named statements merged by the patch path
 * together with what they need that the page has lost since. Null when the page already reads so. Throws
 * when a named statement would be dropped again because nothing on the page refers to it (restore its parent too).
 */
export function restoredProgram(current: string, old: string, names: string[]): string | null {
  const then = statementMap(old);
  const merged = names.length
    ? mergeStatements(
        current.trim(),
        closureOf(then, names)
          .filter((n) => names.includes(n) || !statementMap(current).has(n))
          .map((n) => (then.get(n) as { text: string }).text)
          .join("\n"),
        "root",
      )
    : old.trim();
  const dropped = names.filter((n) => !statementMap(merged).has(n));
  if (dropped.length)
    throw new Error(
      `${dropped.join(", ")} would be dropped again: nothing on the page refers to ${dropped.length > 1 ? "them" : "it"} now. Restore the statement that held ${dropped.length > 1 ? "them" : "it"} too`,
    );
  return merged.trim() === current.trim() ? null : merged;
}

/** The harness session behind a revision as `omp 1a2b3c`; undefined when none was known. */
export function agentLabel(db: sqlite.DatabaseSync, id: string | null): string | undefined {
  if (!id) return undefined;
  const r = db
    .prepare("SELECT harness, session_id FROM agent_sessions WHERE id = ?")
    .get(id) as unknown as { harness: string; session_id: string } | undefined;
  return r ? `${r.harness} ${shortId(r.session_id)}` : undefined;
}
