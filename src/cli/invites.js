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
 * The owner's key: a random token in the state dir (owner.key), made on first use. Off loopback,
 * only a request with this key (as a cookie, set from the owner's own remote link) acts as the owner.
 * @param {string} dir state dir
 */
export function ownerKey(dir) {
  const file = path.join(dir, "owner.key");
  try {
    const key = fs.readFileSync(file, "utf8").trim();
    if (key.length >= 22) return key;
  } catch {
    // none yet
  }
  const key = crypto.randomBytes(24).toString("base64url");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(file, key + "\n", { mode: 0o600 });
  return key;
}
