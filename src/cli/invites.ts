// Who may open a review page: the owner's key, its cookie and login codes, and the helpers team
// review (devices.ts) shares with them: the reviewer cookie's name, names, constant-time compares.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

/** The reviewer cookie: a device's secret (devices.ts), or an old-style invite token. */
export const COOKIE = "austere_rv";
// "render check" is the author of the notes the owner's page writes on its own (sessions.ts RENDER_CHECK_AUTHOR).
const RESERVED = new Set(["owner", "you", "agent", "me", "render check"]);

/** Equal strings, compared in constant time. */
export function safeEqual(a: string, b: string): boolean {
  const x = crypto.createHash("sha256").update(String(a)).digest();
  const y = crypto.createHash("sha256").update(String(b)).digest();
  return crypto.timingSafeEqual(x, y);
}

/** A reviewer name: one line, 1 to 40 characters, not a word the UI uses for someone else. */
export function cleanName(raw: unknown): string {
  const name = String(raw ?? "")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!name) throw new Error('a reviewer name is required: --as "<name>"');
  if (name.length > 40) throw new Error("the reviewer name is longer than 40 characters");
  if (RESERVED.has(name.toLowerCase())) throw new Error(`"${name}" is reserved; pick another name`);
  return name;
}

/** The value of cookie `name` (default: an old-style reviewer cookie) in a Cookie header, or null. */
export function tokenFromCookie(header: string | undefined, name = COOKIE): string | null {
  for (const part of String(header || "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return null;
}

/**
 * Every reviewer cookie in a Cookie header: `austere_rv_<device id>` (one per device, so a second
 * link claimed in the same browser adds a cookie instead of replacing the first), and `austere_rv`,
 * the cookie an old-style invite set.
 */
export function reviewerCookies(header: string | undefined): { name: string; value: string }[] {
  const out: { name: string; value: string }[] = [];
  for (const part of String(header || "").split(";")) {
    const i = part.indexOf("=");
    const name = i > 0 ? part.slice(0, i).trim() : "";
    if (name === COOKIE || /^austere_rv_d[0-9a-f]{10}$/.test(name)) out.push({ name, value: part.slice(i + 1).trim() });
  }
  return out;
}

export const OWNER_COOKIE = "austere_owner";

/**
 * The owner cookie's value: derived from the key, never the key itself. Browsers share 127.0.0.1
 * cookies across ports, so any local listener a page visits can read it; the derived value lets
 * that listener act as the owner in a browser, but not on /api/*, which wants the key.
 * @param key the owner key
 */
export function ownerCookie(key: string): string {
  return crypto.createHmac("sha256", key).update("austere-axi owner cookie").digest("base64url");
}

/**
 * Single-use sign-in codes: the CLI asks the server for one (with the owner key) and opens
 * `<page>?login=<code>`; the server swaps it for the owner cookie. A code works once, and only
 * for `ttlMs`, so seeing it later (on a command line, in a terminal) is no use.
 */
export class LoginCodes {
  ttlMs: number;
  now: () => number;
  /** sha256(code) -> expiry */
  codes: Map<string, number>;

  constructor(ttlMs: number, now: () => number = Date.now) {
    this.ttlMs = ttlMs;
    this.now = now;
    this.codes = new Map();
  }

  /** A fresh code. */
  issue(): string {
    const t = this.now();
    for (const [h, exp] of this.codes) if (exp <= t) this.codes.delete(h);
    const code = crypto.randomBytes(16).toString("base64url");
    this.codes.set(hashCode(code), t + this.ttlMs);
    return code;
  }

  /** Whether `code` is a live code; it is used up either way. */
  take(code: string): boolean {
    const h = hashCode(code);
    const exp = this.codes.get(h);
    this.codes.delete(h);
    return exp != null && exp > this.now();
  }
}

// Looked up by hash, so the lookup's timing says nothing about a live code.
const hashCode = (code: string): string => crypto.createHash("sha256").update(String(code)).digest("base64url");

/**
 * The owner's key: a random token in the state dir (owner.key), made on first use. The CLI sends it
 * on /api/*; a browser gets the cookie derived from it (ownerCookie), from the owner's own remote
 * link or a login code.
 * @param dir state dir
 */
export function ownerKey(dir: string): string {
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
    if ((err as NodeJS.ErrnoException | null)?.code !== "EEXIST") throw err;
    const theirs = read();
    if (theirs) return theirs;
    fs.renameSync(tmp, file); // there but unusable: replace it
    return key;
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}
