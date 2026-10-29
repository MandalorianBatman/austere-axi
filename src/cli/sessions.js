// @ts-check
// One review session per artifact file (keyed by canonical path). Holds the
// conversation, feedback not yet delivered to the agent, and who is listening.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const MAX_TRANSCRIPT = 400;

export function sessionId(file) {
  return crypto.createHash("sha1").update(file).digest("hex").slice(0, 12);
}

let seq = 0;
export function newId(prefix) {
  return `${prefix}${Date.now().toString(36)}${(++seq).toString(36)}`;
}

export class SessionStore {
  /**
   * @param {string} dir
   * @param {{ onFlush?: (session) => void }} [options] onFlush runs after a session is written (the hub mirrors it)
   */
  constructor(dir, { onFlush } = {}) {
    this.onFlush = onFlush || null;
    this.dir = path.join(dir, "sessions");
    fs.mkdirSync(this.dir, { recursive: true });
    this.sessions = new Map();
    this.timers = new Map();
    for (const f of fs.readdirSync(this.dir)) {
      if (!f.endsWith(".json")) continue;
      try {
        const s = JSON.parse(fs.readFileSync(path.join(this.dir, f), "utf8"));
        if (s && s.id && s.file) this.sessions.set(s.id, hydrate(s));
      } catch {
        // ignore a corrupt session file
      }
    }
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
      s = hydrate({ id, file, createdAt: Date.now() });
      this.sessions.set(id, s);
    }
    return s;
  }

  touch(s) {
    s.updatedAt = Date.now();
    clearTimeout(this.timers.get(s.id));
    this.timers.set(
      s.id,
      setTimeout(() => this.flush(s), 150),
    );
  }

  flush(s) {
    clearTimeout(this.timers.get(s.id));
    this.timers.delete(s.id);
    const data = {
      id: s.id,
      file: s.file,
      title: s.title,
      createdAt: s.createdAt,
      updatedAt: s.updatedAt,
      status: s.status,
      endedBy: s.endedBy,
      endedAt: s.endedAt,
      pending: s.pending,
      transcript: s.transcript.slice(-MAX_TRANSCRIPT),
    };
    const file = path.join(this.dir, `${s.id}.json`);
    const tmp = `${file}.${process.pid}.tmp`;
    try {
      fs.writeFileSync(tmp, JSON.stringify(data));
      fs.renameSync(tmp, file);
    } catch {
      // best effort; state is also in memory
    }
    if (this.onFlush) {
      try {
        this.onFlush(s);
      } catch {
        // the hub index is a convenience; the session file is the record
      }
    }
  }

  flushAll() {
    for (const s of this.sessions.values()) if (this.timers.has(s.id)) this.flush(s);
  }

  // ── conversation ──

  /** Reviewer sent a batch of items. Returns the transcript entry. */
  addUserBatch(s, items, { end = false } = {}) {
    const entry = { id: newId("u"), role: "user", at: Date.now(), items, end: end || undefined, seenAt: null, doneAt: null };
    s.transcript.push(entry);
    s.pending.push(entry.id);
    this.touch(s);
    return entry;
  }

  addAgentReply(s, text) {
    const now = Date.now();
    for (const e of s.transcript) if (e.role === "user" && e.seenAt && !e.doneAt) e.doneAt = now;
    const entry = { id: newId("a"), role: "agent", at: now, text };
    s.transcript.push(entry);
    this.touch(s);
    return entry;
  }

  /**
   * Feedback no agent has acted on (`feedback <file>`): entries not yet
   * received, plus received ones with no agent reply since; `all` adds the
   * addressed ones. Unless `peek`, the not-yet-received ones become received,
   * so a later poll does not deliver them again.
   * @returns {{ entries: { id, at, items, status: "open"|"received"|"addressed" }[], fresh: object[] }}
   */
  feedback(s, { all = false, peek = false } = {}) {
    const pending = new Set(s.pending);
    const picked = s.transcript.filter((e) => e.role === "user" && (e.items || []).length && (all || pending.has(e.id) || !e.doneAt));
    const entries = picked.map((e) => ({
      id: e.id,
      at: e.at,
      items: e.items,
      status: pending.has(e.id) ? "open" : e.doneAt ? "addressed" : "received",
    }));
    const fresh = picked.filter((e) => pending.has(e.id));
    if (fresh.length && !peek) this.markDelivered(s, fresh);
    return { entries, fresh: peek ? [] : fresh };
  }

  /** Entries the agent has not received yet. */
  pendingEntries(s) {
    const ids = new Set(s.pending);
    return s.transcript.filter((e) => ids.has(e.id));
  }

  markDelivered(s, entries) {
    const now = Date.now();
    const ids = new Set(entries.map((e) => e.id));
    s.pending = s.pending.filter((id) => !ids.has(id));
    for (const e of entries) e.seenAt = e.seenAt || now;
    s.lastDeliveredAt = now;
    this.touch(s);
  }

  end(s, by) {
    s.status = "ended";
    s.endedBy = by;
    s.endedAt = Date.now();
    this.touch(s);
  }

  reopen(s) {
    s.status = "open";
    s.endedBy = null;
    s.endedAt = null;
    this.touch(s);
  }
}

function hydrate(s) {
  return {
    id: s.id,
    file: s.file,
    title: s.title || path.basename(s.file),
    createdAt: s.createdAt || Date.now(),
    updatedAt: s.updatedAt || Date.now(),
    status: s.status || "open",
    endedBy: s.endedBy || null,
    endedAt: s.endedAt || null,
    pending: Array.isArray(s.pending) ? s.pending : [],
    transcript: Array.isArray(s.transcript) ? s.transcript : [],
    // runtime-only
    revision: 0,
    lastDeliveredAt: null,
    workingSince: null,
    fileChangedAfterDelivery: false,
  };
}
