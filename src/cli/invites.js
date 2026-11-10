// @ts-check
// Invite links for team review. An invite is a random token tied to one page and
// a reviewer name. The token in the link becomes a cookie; a request that carries
// a valid token acts as that reviewer. Stored in the state dir (invites.json).
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const COOKIE = "austere_rv";
const RESERVED = new Set(["owner", "you", "agent", "me"]);

/**
 * @typedef {{ token: string, name: string, sessionId: string, file: string, auto: boolean, createdAt: number }} Invite
 */

/** Equal strings, compared in constant time. */
export function safeEqual(a, b) {
  const x = crypto.createHash("sha256").update(String(a)).digest();
  const y = crypto.createHash("sha256").update(String(b)).digest();
  return crypto.timingSafeEqual(x, y);
}

/** A reviewer name: one line, 1 to 40 characters, not a word the UI uses for someone else. */
export function cleanName(raw) {
  const name = String(raw ?? "")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!name) throw new Error('a reviewer name is required: --as "<name>"');
  if (name.length > 40) throw new Error("the reviewer name is longer than 40 characters");
  if (RESERVED.has(name.toLowerCase())) throw new Error(`"${name}" is reserved; pick another name`);
  return name;
}

/** The value of cookie `name` (default: the invite cookie) in a Cookie header, or null. */
export function tokenFromCookie(header, name = COOKIE) {
  for (const part of String(header || "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return null;
}

/** The short id `share list` shows; `share revoke` takes it. */
export function inviteId(inv) {
  return inv.token.slice(0, 8);
}

export class InviteStore {
  /** @param {string} dir state dir */
  constructor(dir) {
    this.file = path.join(dir, "invites.json");
    /** @type {Invite[]} */
    this.invites = [];
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, "utf8"));
      if (Array.isArray(raw.invites)) {
        this.invites = raw.invites.filter((i) => i && typeof i.token === "string" && i.token.length >= 22 && i.name && i.sessionId);
      }
    } catch {
      // none yet, or unreadable: start empty
    }
  }

  save() {
    const tmp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ invites: this.invites }, null, 2) + "\n", { mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }

  /** @returns {Invite} */
  add({ name, sessionId, file, auto = false }) {
    const clean = cleanName(name);
    if (this.invites.some((i) => i.sessionId === sessionId && i.name.toLowerCase() === clean.toLowerCase())) {
      throw new Error(`this page is already shared with "${clean}"; revoke that invite first (share revoke "${clean}")`);
    }
    /** @type {Invite} */
    const inv = { token: crypto.randomBytes(24).toString("base64url"), name: clean, sessionId, file, auto: Boolean(auto), createdAt: Date.now() };
    this.invites.push(inv);
    this.save();
    return inv;
  }

  /** The invite for a token, or null. Compares every token, so timing does not show a near miss. */
  find(token) {
    if (typeof token !== "string" || !token) return null;
    let hit = null;
    for (const inv of this.invites) if (safeEqual(inv.token, token) && !hit) hit = inv;
    return hit;
  }

  list() {
    return [...this.invites];
  }

  /** Remove the invites a key names: a full token, its short id, or a reviewer name. Returns what was removed. */
  revoke(key) {
    const k = String(key || "").trim();
    if (!k) return [];
    const gone = this.invites.filter((i) => safeEqual(i.token, k) || (k.length === 8 && inviteId(i) === k) || i.name.toLowerCase() === k.toLowerCase());
    if (gone.length) {
      this.invites = this.invites.filter((i) => !gone.includes(i));
      this.save();
    }
    return gone;
  }
}

export const OWNER_COOKIE = "austere_owner";

/**
 * The owner cookie's value: derived from the key, never the key itself. Browsers share 127.0.0.1
 * cookies across ports, so any local listener a page visits can read it; the derived value lets
 * that listener act as the owner in a browser, but not on /api/*, which wants the key.
 * @param {string} key the owner key
 */
export function ownerCookie(key) {
  return crypto.createHmac("sha256", key).update("austere-axi owner cookie").digest("base64url");
}

/**
 * Single-use sign-in codes: the CLI asks the server for one (with the owner key) and opens
 * `<page>?login=<code>`; the server swaps it for the owner cookie. A code works once, and only
 * for `ttlMs`, so seeing it later (on a command line, in a terminal) is no use.
 */
export class LoginCodes {
  /** @param {number} ttlMs @param {() => number} [now] */
  constructor(ttlMs, now = Date.now) {
    this.ttlMs = ttlMs;
    this.now = now;
    /** @type {Map<string, number>} sha256(code) -> expiry */
    this.codes = new Map();
  }

  /** A fresh code. */
  issue() {
    const t = this.now();
    for (const [h, exp] of this.codes) if (exp <= t) this.codes.delete(h);
    const code = crypto.randomBytes(16).toString("base64url");
    this.codes.set(hashCode(code), t + this.ttlMs);
    return code;
  }

  /** Whether `code` is a live code; it is used up either way. */
  take(code) {
    const h = hashCode(code);
    const exp = this.codes.get(h);
    this.codes.delete(h);
    return exp != null && exp > this.now();
  }
}

// Looked up by hash, so the lookup's timing says nothing about a live code.
const hashCode = (code) => crypto.createHash("sha256").update(String(code)).digest("base64url");

/**
 * The owner's key: a random token in the state dir (owner.key), made on first use. The CLI sends it
 * on /api/*; a browser gets the cookie derived from it (ownerCookie), from the owner's own remote
 * link or a login code.
 * @param {string} dir state dir
 */
export function ownerKey(dir) {
  const file = path.join(dir, "owner.key");
  const read = () => {
    try {
      const key = fs.readFileSync(file, "utf8").trim();
      return key.length >= 22 ? key : null;
    } catch {
      return null; // none yet
    }
  };
  const have = read();
  if (have) return have;
  const key = crypto.randomBytes(24).toString("base64url");
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, key + "\n", { mode: 0o600 });
  try {
    // link() never replaces a file: the CLI and the server it starts end up with the same key.
    fs.linkSync(tmp, file);
    return key;
  } catch (err) {
    if (err?.code !== "EEXIST") throw err;
    const theirs = read();
    if (theirs) return theirs;
    fs.renameSync(tmp, file); // there but unusable: replace it
    return key;
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}
