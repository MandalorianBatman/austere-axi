// @ts-check
// Review sessions, one per artifact file (keyed by canonical path), and their
// conversation. hub.db is the record: every change commits before the caller
// answers, so a note the server accepted survives a crash. The server keeps a
// copy in memory for its hot paths; only one server writes a state dir.
//
// Delivery is at least once. A queued note has a `seq` (one counter for the
// whole database); a session's `ackedSeq` is how far the agent has
// acknowledged. A poll returns the notes after it with a cursor, and the agent
// acknowledges by sending the cursor back (or by replying), so feedback lost on
// the way to the agent is delivered again.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { itemText, openDatabase, projectOf } from "./hub.js";

export function sessionId(file) {
  return crypto.createHash("sha1").update(file).digest("hex").slice(0, 12);
}

let counter = 0;
export function newId(prefix) {
  return `${prefix}${Date.now().toString(36)}${(++counter).toString(36)}`;
}

/**
 * Where a note stands: held (waiting for the owner), discarded, open (not yet
 * acknowledged by an agent), received, addressed (replied to).
 */
export function noteStatus(e, ackedSeq) {
  if (e.discarded) return "discarded";
  if (e.held) return "held";
  if (e.seq > ackedSeq) return "open";
  if (e.doneAt) return "addressed";
  return "received";
}

const deliverable = (e) => e.role === "user" && e.seq != null && !e.held && !e.discarded;

export class SessionStore {
  /** Open the store in a state dir: hub.db, after importing any session files from before it. */
  static async open(dir) {
    return new SessionStore(await openDatabase(path.join(dir, "hub.db")), dir);
  }

  /**
   * @param {any} db hub.db, opened with openDatabase
   * @param {string} dir the state dir
   */
  constructor(db, dir) {
    this.db = db;
    this.sessions = new Map();
    this.q = {
      ensure: db.prepare(`
        INSERT INTO artifacts (id, file, project, title, created_at, updated_at, reviewed, status)
        VALUES (?, ?, ?, ?, ?, ?, 1, 'open')
        ON CONFLICT(id) DO UPDATE SET reviewed = 1, status = COALESCE(artifacts.status, 'open')`),
      session: db.prepare(`SELECT * FROM artifacts WHERE id = ?`),
      sessions: db.prepare(`SELECT * FROM artifacts WHERE reviewed = 1`),
      save: db.prepare(`
        UPDATE artifacts SET title = ?, updated_at = ?, status = ?, ended_by = ?, ended_at = ?, closed_at = ?, acked_seq = ?
        WHERE id = ?`),
      notes: db.prepare(`SELECT * FROM notes ORDER BY at, rowid`),
      note: db.prepare(`SELECT 1 FROM notes WHERE id = ?`),
      hasNotes: db.prepare(`SELECT 1 FROM notes WHERE artifact_id = ? LIMIT 1`),
      saveNote: db.prepare(`
        INSERT INTO notes (id, artifact_id, seq, state, author, items, ends, at, released_at, seen_at, work_at, done_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET seq = excluded.seq, state = excluded.state, released_at = excluded.released_at,
          seen_at = excluded.seen_at, work_at = excluded.work_at, done_at = excluded.done_at`),
      maxSeq: db.prepare(`SELECT COALESCE(MAX(seq), 0) AS n FROM notes`),
      replies: db.prepare(`SELECT * FROM replies ORDER BY at, rowid`),
      saveReply: db.prepare(`INSERT INTO replies (id, artifact_id, at, text) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO NOTHING`),
      indexItem: db.prepare(`
        INSERT INTO items (id, artifact_id, entry_id, at, kind, target, text, status, data, author)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET status = excluded.status, text = excluded.text, data = excluded.data, author = excluded.author`),
      itemStatus: db.prepare(`UPDATE items SET status = ? WHERE entry_id = ?`),
    };
    this.importSessionFiles(path.join(dir, "sessions"));
    this.load();
  }

  close() {
    this.db.close();
  }

  /** Run `fn` in one transaction: all of it is on disk, or none of it. */
  tx(fn) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const out = fn();
      this.db.exec("COMMIT");
      return out;
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  load() {
    for (const row of this.q.sessions.all()) this.sessions.set(row.id, hydrate(row));
    for (const row of this.q.notes.all()) {
      const s = this.sessions.get(row.artifact_id);
      if (s) s.transcript.push(noteEntry(row));
    }
    for (const row of this.q.replies.all()) {
      const s = this.sessions.get(row.artifact_id);
      if (s) s.transcript.push({ id: row.id, role: "agent", at: row.at, text: row.text });
    }
    for (const s of this.sessions.values()) s.transcript.sort((a, b) => a.at - b.at);
  }

  get(id) {
    return this.sessions.get(id) || null;
  }

  byFile(file) {
    return this.get(sessionId(file));
  }

  list() {
    return Array.from(this.sessions.values()).sort((a, b) => b.updatedAt - a.updatedAt);
  }

  ensure(file) {
    const id = sessionId(file);
    let s = this.sessions.get(id);
    if (!s) {
      const now = Date.now();
      this.q.ensure.run(id, file, projectOf(file), path.basename(file), now, now);
      s = hydrate(this.q.session.get(id));
      this.sessions.set(id, s);
    }
    return s;
  }

  /** Write the session row (title, status, cursor) after changing it in memory. */
  saveSession(s) {
    this.q.save.run(s.title, s.updatedAt, s.status, s.endedBy, s.endedAt, s.closedAt, s.ackedSeq, s.id);
  }

  touch(s) {
    s.updatedAt = Date.now();
    this.saveSession(s);
  }

  saveNote(s, e) {
    const state = e.discarded ? "discarded" : e.held ? "held" : "queued";
    this.q.saveNote.run(e.id, s.id, e.seq ?? null, state, e.author || "", JSON.stringify(e.items || []), e.end ? 1 : 0, e.at, e.releasedAt ?? null, e.seenAt ?? null, e.workAt ?? null, e.doneAt ?? null);
  }

  /** Index each item of a note for the hub, with where the note stands. */
  indexNote(s, e) {
    const status = noteStatus(e, s.ackedSeq);
    (e.items || []).forEach((it, i) => {
      this.q.indexItem.run(it.id || `${e.id}.${i}`, s.id, e.id, e.at, it.kind || "message", it.target || it.statement || null, itemText(it), status, JSON.stringify(it), e.author || "");
    });
  }

  /** Save changed notes (and run `also` in the same transaction), then put the changes in memory. `changes` pairs each note with its new fields. */
  updateNotes(s, changes, also = null) {
    if (!changes.length && !also) return;
    this.tx(() => {
      also?.();
      for (const [e, patch] of changes) {
        const next = { ...e, ...patch };
        this.saveNote(s, next);
        this.q.itemStatus.run(noteStatus(next, s.ackedSeq), e.id);
      }
    });
    for (const [e, patch] of changes) Object.assign(e, patch);
  }

  nextSeq() {
    return Number(this.q.maxSeq.get().n) + 1;
  }

  // ── conversation ──

  /**
   * Reviewer sent a batch of items. Returns the transcript entry, already on disk.
   * `author` is a team reviewer's name (empty: the owner). `hold` keeps it from the
   * agent until the owner releases it.
   */
  addUserBatch(s, items, { end = false, author = "", hold = false } = {}) {
    /** @type {Record<string, any>} */
    const entry = { id: newId("u"), role: "user", at: Date.now(), items, end: end || undefined, seenAt: null, doneAt: null, seq: null };
    if (author) entry.author = author;
    if (hold) entry.held = true;
    this.tx(() => {
      if (!hold) entry.seq = this.nextSeq();
      this.saveNote(s, entry);
      this.indexNote(s, entry);
      s.updatedAt = entry.at;
      this.saveSession(s);
    });
    s.transcript.push(entry);
    return entry;
  }

  /** Held entries, oldest first. */
  heldEntries(s) {
    return s.transcript.filter((e) => e.role === "user" && e.held);
  }

  /**
   * The owner sends held notes on to the agent (`ids` omitted: all of them). A released
   * note gets the next seq, so it reaches the agent even if the cursor has moved past
   * the time it was written. Returns the entries released.
   */
  release(s, ids) {
    const want = ids ? new Set(ids) : null;
    const out = this.heldEntries(s).filter((e) => !want || want.has(e.id));
    if (!out.length) return out;
    const now = Date.now();
    this.tx(() => {
      for (const e of out) {
        const next = { ...e, held: false, seq: this.nextSeq(), releasedAt: now };
        this.saveNote(s, next);
        this.q.itemStatus.run(noteStatus(next, s.ackedSeq), e.id);
        Object.assign(e, { seq: next.seq, releasedAt: now });
      }
    });
    for (const e of out) e.held = false;
    return out;
  }

  /** The owner drops held notes. They stay on record, marked discarded, and never reach the agent. */
  discard(s, ids) {
    const want = ids ? new Set(ids) : null;
    const out = this.heldEntries(s).filter((e) => !want || want.has(e.id));
    this.updateNotes(s, out.map((e) => [e, { held: false, discarded: true }]));
    return out;
  }

  /** The agent replied: every note it has acknowledged and not answered counts as addressed. */
  addAgentReply(s, text) {
    const now = Date.now();
    const entry = { id: newId("a"), role: "agent", at: now, text };
    const done = s.transcript.filter((e) => deliverable(e) && e.seq <= s.ackedSeq && !e.doneAt);
    this.updateNotes(s, done.map((e) => [e, { doneAt: now }]), () => {
      this.q.saveReply.run(entry.id, s.id, entry.at, text);
      s.updatedAt = now;
      this.saveSession(s);
    });
    s.transcript.push(entry);
    return entry;
  }

  /** Notes after `from` (a seq) that can go to the agent, oldest first. */
  after(s, from) {
    return s.transcript.filter((e) => deliverable(e) && e.seq > from).sort((a, b) => a.seq - b.seq);
  }

  /** Notes the agent has not acknowledged. */
  unread(s) {
    return this.after(s, s.ackedSeq);
  }

  /** A poll answer with these notes went out. They stay unread until the agent acknowledges them. */
  markDelivered(s, entries) {
    const now = Date.now();
    this.updateNotes(s, entries.filter((e) => !e.seenAt).map((e) => [e, { seenAt: now }]));
    s.lastDeliveredAt = now;
    s.deliveredSeq = Math.max(s.deliveredSeq, ...entries.map((e) => e.seq));
  }

  /**
   * The agent acknowledges every note up to `cursor`. A cursor past the last note in the
   * database is cut back, so it cannot acknowledge notes not yet written. Returns the
   * notes it acknowledged.
   */
  ack(s, cursor) {
    const target = Math.min(Math.floor(Number(cursor)), this.nextSeq() - 1);
    if (!(target > s.ackedSeq)) return [];
    const acked = s.transcript.filter((e) => deliverable(e) && e.seq > s.ackedSeq && e.seq <= target);
    const now = Date.now();
    const before = s.ackedSeq;
    s.ackedSeq = target;
    try {
      this.tx(() => {
        this.saveSession(s);
        for (const e of acked) {
          const next = e.seenAt ? e : { ...e, seenAt: now };
          this.saveNote(s, next);
          this.q.itemStatus.run(noteStatus(next, target), e.id);
        }
      });
    } catch (err) {
      s.ackedSeq = before;
      throw err;
    }
    for (const e of acked) e.seenAt = e.seenAt || now;
    s.deliveredSeq = Math.max(s.deliveredSeq, target);
    return acked;
  }

  /**
   * Feedback no agent has acted on (`feedback <file>`): notes not yet acknowledged,
   * plus acknowledged ones with no agent reply since; `all` adds the addressed ones.
   * Unless `peek`, reading acknowledges them, so a later poll does not deliver them again.
   * @returns {{ entries: { id: string, at: number, author?: string, items: any[], status: string }[], fresh: any[] }}
   */
  feedback(s, { all = false, peek = false } = {}) {
    const picked = s.transcript.filter((e) => deliverable(e) && (e.items || []).length && (all || e.seq > s.ackedSeq || !e.doneAt));
    const entries = picked.map((e) => ({
      id: e.id,
      at: e.at,
      author: e.author || undefined,
      items: e.items,
      status: noteStatus(e, s.ackedSeq),
    }));
    const fresh = picked.filter((e) => e.seq > s.ackedSeq);
    if (fresh.length && !peek) this.ack(s, Math.max(...fresh.map((e) => e.seq)));
    return { entries, fresh: peek ? [] : fresh };
  }

  /** The agent started on delivered notes (the file changed after it got them). */
  markWorking(s, entries) {
    const now = Date.now();
    this.updateNotes(s, entries.map((e) => [e, { workAt: now }]));
  }

  /** The agent stopped (or the reviewer ended it). Notes are still accepted; the next poll that finds new ones reopens it. */
  end(s, by) {
    Object.assign(s, { status: "ended", endedBy: by, endedAt: Date.now() });
    this.touch(s);
  }

  /** The owner locks the review: no more notes until it is reopened. */
  closeReview(s) {
    const now = Date.now();
    if (s.status !== "ended") Object.assign(s, { status: "ended", endedBy: "user", endedAt: now });
    s.closedAt = now;
    this.touch(s);
  }

  reopen(s) {
    Object.assign(s, { status: "open", endedBy: null, endedAt: null, closedAt: null });
    this.touch(s);
  }

  // ── session files from before the database ──

  /**
   * Import `sessions/*.json` (written by versions before notes moved into hub.db) in one
   * transaction, then rename each to `.imported`. Notes already in the database are
   * skipped, so an import cut short is safe to run again.
   */
  importSessionFiles(dir) {
    let names;
    try {
      names = fs.readdirSync(dir).filter((f) => f.endsWith(".json"));
    } catch {
      return;
    }
    const files = [];
    for (const name of names) {
      try {
        const d = JSON.parse(fs.readFileSync(path.join(dir, name), "utf8"));
        if (d && d.id && d.file) files.push({ name, d });
      } catch {
        // a corrupt session file stays where it is
      }
    }
    if (!files.length) return;
    this.tx(() => {
      for (const { d } of files) this.importSession(d);
    });
    for (const { name } of files) {
      try {
        fs.renameSync(path.join(dir, name), path.join(dir, `${name}.imported`));
      } catch {
        // imported again next time, which skips what is already in
      }
    }
  }

  importSession(d) {
    const now = Date.now();
    // Notes on record mean an earlier import (whose rename failed) or a server has used this
    // session since: its status in the database is newer than the file's.
    const known = !!this.q.hasNotes.get(d.id);
    this.q.ensure.run(d.id, d.file, projectOf(d.file), d.title || path.basename(d.file), d.createdAt || now, d.updatedAt || now);
    const s = hydrate(this.q.session.get(d.id));
    if (!known) {
      Object.assign(s, {
        title: d.title || s.title,
        updatedAt: Math.max(s.updatedAt, d.updatedAt || 0),
        status: d.status || "open",
        endedBy: d.endedBy || null,
        endedAt: d.endedAt || null,
      });
    }
    const transcript = Array.isArray(d.transcript) ? d.transcript : [];
    const pending = new Set(Array.isArray(d.pending) ? d.pending : []);
    const users = transcript.filter((e) => e && e.role === "user" && e.id && !this.q.note.get(e.id));
    const open = (e) => !e.held && !e.discarded;
    // Delivered notes first, so they sit at or below the cursor; then the ones still pending, in order.
    const delivered = users.filter((e) => open(e) && !pending.has(e.id));
    const waiting = [...pending].map((id) => users.find((e) => e.id === id)).filter((e) => e && open(e));
    const rest = users.filter((e) => !open(e));
    const save = (e, seq) => {
      const entry = { ...e, items: Array.isArray(e.items) ? e.items : [], seq };
      this.saveNote(s, entry);
      return entry;
    };
    const saved = [];
    for (const e of delivered) saved.push(save(e, this.nextSeq()));
    if (delivered.length) s.ackedSeq = Math.max(s.ackedSeq, saved[saved.length - 1].seq);
    for (const e of waiting) saved.push(save(e, this.nextSeq()));
    for (const e of rest) saved.push(save(e, null));
    for (const e of saved) this.indexNote(s, e);
    for (const e of transcript) {
      if (e && e.role === "agent" && e.id) this.q.saveReply.run(e.id, s.id, e.at || now, String(e.text || ""));
    }
    this.saveSession(s);
  }
}

function noteEntry(row) {
  /** @type {Record<string, any>} */
  const e = {
    id: row.id,
    role: "user",
    at: row.at,
    items: JSON.parse(row.items),
    seenAt: row.seen_at ?? null,
    doneAt: row.done_at ?? null,
    seq: row.seq ?? null,
  };
  if (row.ends) e.end = true;
  if (row.author) e.author = row.author;
  if (row.work_at != null) e.workAt = row.work_at;
  if (row.released_at != null) e.releasedAt = row.released_at;
  if (row.state === "held") e.held = true;
  if (row.state === "discarded") {
    e.held = false;
    e.discarded = true;
  }
  return e;
}

function hydrate(row) {
  return {
    id: row.id,
    file: row.file,
    title: row.title || path.basename(row.file),
    createdAt: row.created_at || Date.now(),
    updatedAt: row.updated_at || Date.now(),
    status: row.status === "ended" ? "ended" : "open",
    endedBy: row.ended_by || null,
    endedAt: row.ended_at || null,
    closedAt: row.closed_at || null,
    ackedSeq: Number(row.acked_seq || 0),
    /** @type {Record<string, any>[]} */
    transcript: [],
    // runtime-only
    deliveredSeq: Number(row.acked_seq || 0),
    revision: 0,
    lastDeliveredAt: null,
    workingSince: null,
  };
}
