// Team review access: a device the owner knows by name. A named link is the way in:
// the first browser to open it claims it and becomes that person's device, and the link stops
// working. The browser holds a fresh random secret in a cookie; hub.db keeps only its hash. A link
// nobody claimed expires. A device reaches one page, a project, or every page, until revoked.
//
// Invites from before (invites.json) become old-style links: reusable, no expiry, and their token
// still works as a cookie, so reviewers who joined before keep their access until the owner makes
// the link single-use or revokes it.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type * as sqlite from "node:sqlite";
import { cleanName } from "./invites.ts";
import { inTransaction } from "./projects.ts";

/** What a device or link reaches: one page (a copy's artifact id), one project (its id), or every page. */
export type ScopeKind = "page" | "project" | "all";
export interface Scope {
  kind: ScopeKind;
  /** The artifact id for `page`, the project id for `project`, null for `all`. */
  id: string | null;
}

/** How a device came in: a named link, a request the owner approved, or Tailscale. */
export type DeviceOrigin = "link" | "request" | "tailscale";

/** A row of `devices`: an unclaimed link (claimed_at null), or a device (claimed). */
export interface DeviceRow {
  id: string;
  name: string;
  origin: DeviceOrigin;
  verified_login: string | null;
  secret_hash: string | null;
  link_hash: string | null;
  /** The link's token while nobody has claimed it, so the owner can copy it again; cleared on claim and on revoke. */
  link_token: string | null;
  /** The page (artifact id) the link opens on: where it was shared from. */
  link_page: string | null;
  link_expires_at: number | null;
  /** 1: an old-style link from invites.json, which any number of browsers can open. */
  reusable: number;
  scope_kind: ScopeKind;
  scope_id: string | null;
  auto: number;
  created_at: number;
  claimed_at: number | null;
  last_seen_at: number | null;
  last_addr: string | null;
  last_host: string | null;
  user_agent: string | null;
  revoked_at: number | null;
}

/** Why a link does not let a browser in, or "ok". */
export type LinkState = "ok" | "claimed" | "expired" | "revoked";

/** Where a request came from, recorded on the device. */
export interface SeenMeta {
  addr?: string | null;
  host?: string | null;
  userAgent?: string | null;
}

export const DEVICES_SCHEMA = `
CREATE TABLE IF NOT EXISTS devices (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  origin TEXT NOT NULL,
  verified_login TEXT,
  secret_hash TEXT UNIQUE,
  link_hash TEXT UNIQUE,
  link_token TEXT,
  link_page TEXT,
  link_expires_at INTEGER,
  reusable INTEGER NOT NULL DEFAULT 0,
  scope_kind TEXT NOT NULL,
  scope_id TEXT,
  auto INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  claimed_at INTEGER,
  last_seen_at INTEGER,
  last_addr TEXT,
  last_host TEXT,
  user_agent TEXT,
  revoked_at INTEGER
);
`;

/** How long an unclaimed link works unless `--expires` says otherwise. */
export const LINK_TTL_MS = 7 * 86_400_000;
/** How often a device's last-seen fields are written at most. */
const SEEN_EVERY_MS = 60_000;

/** sha256 of a secret or link token, base64url: what hub.db keeps. Looked up by hash, so timing says nothing about a near miss. */
export function hashSecret(secret: string): string {
  return crypto.createHash("sha256").update(String(secret)).digest("base64url");
}

/** A fresh random secret or link token: 192 bits, base64url. */
export function randomToken(): string {
  return crypto.randomBytes(24).toString("base64url");
}

/** A live row: not revoked, and for an unclaimed single-use link, not expired. */
export function isLive(row: DeviceRow, now = Date.now()): boolean {
  if (row.revoked_at != null) return false;
  if (
    row.claimed_at == null &&
    !row.reusable &&
    row.link_expires_at != null &&
    row.link_expires_at <= now
  )
    return false;
  return true;
}

/** Whether `row`'s scope reaches the copy `artifactId` in project `projectId`. */
export function covers(
  row: Pick<DeviceRow, "scope_kind" | "scope_id">,
  artifactId: string,
  projectId: string | null,
): boolean {
  if (row.scope_kind === "all") return true;
  if (row.scope_kind === "project") return projectId != null && row.scope_id === projectId;
  return row.scope_id === artifactId;
}

export class DeviceStore {
  db: sqlite.DatabaseSync;
  now: () => number;

  constructor(db: sqlite.DatabaseSync, now: () => number = Date.now) {
    this.db = db;
    this.now = now;
  }

  get(id: string): DeviceRow | null {
    return (
      (this.db.prepare("SELECT * FROM devices WHERE id = ?").get(id) as unknown as
        | DeviceRow
        | undefined) ?? null
    );
  }

  /** Every row, links and devices, revoked ones too, the newest first. */
  list(): DeviceRow[] {
    return this.db
      .prepare("SELECT * FROM devices ORDER BY created_at DESC, rowid DESC")
      .all() as unknown as DeviceRow[];
  }

  /**
   * A new link for `name`, opening on `page` (an artifact id). Refused when a live row with the same
   * name already has the same scope (revoke that one first), so `share revoke <name>` stays unambiguous.
   * Returns the row and its token.
   */
  createLink({
    name,
    scope,
    page,
    auto = false,
    expiresAt,
  }: {
    name: unknown;
    scope: Scope;
    page: string;
    auto?: boolean;
    expiresAt?: number;
  }): { row: DeviceRow; token: string } {
    const clean = cleanName(name);
    const now = this.now();
    const expires = expiresAt ?? now + LINK_TTL_MS;
    if (expires <= now) throw new Error("the link would expire before anyone could open it");
    return inTransaction(this.db, () => {
      const same = (
        this.db
          .prepare("SELECT * FROM devices WHERE scope_kind = ? AND scope_id IS ?")
          .all(scope.kind, scope.id) as unknown as DeviceRow[]
      ).filter((r) => sameName(r.name, clean) && isLive(r, now));
      if (same.length)
        throw new Error(
          `"${clean}" already has access with this scope; revoke it first (share revoke "${clean}")`,
        );
      const token = randomToken();
      const id = newDeviceId();
      this.db
        .prepare(
          "INSERT INTO devices (id, name, origin, link_hash, link_token, link_page, link_expires_at, scope_kind, scope_id, auto, created_at) VALUES (?, ?, 'link', ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .run(
          id,
          clean,
          hashSecret(token),
          token,
          page,
          expires,
          scope.kind,
          scope.id,
          auto ? 1 : 0,
          now,
        );
      return { row: this.get(id) as DeviceRow, token };
    });
  }

  /** The row a link token opens, whatever its state (see linkState), or null. */
  findLink(token: unknown): DeviceRow | null {
    if (typeof token !== "string" || !token || token.length > 200) return null;
    return (
      (this.db
        .prepare("SELECT * FROM devices WHERE link_hash = ?")
        .get(hashSecret(token)) as unknown as DeviceRow | undefined) ?? null
    );
  }

  /** Whether a link row still lets a browser in. */
  linkState(row: DeviceRow): LinkState {
    if (row.revoked_at != null) return "revoked";
    if (row.reusable) return "ok";
    if (row.claimed_at != null) return "claimed";
    if (row.link_expires_at != null && row.link_expires_at <= this.now()) return "expired";
    return "ok";
  }

  /**
   * Claim a link for the browser asking: a single-use link becomes this device, once (a second claim
   * gets null); an old-style reusable link stays and a new device is made from it. Returns the device
   * and the secret for its cookie, which never equals the link token.
   */
  claim(link: DeviceRow, meta: SeenMeta = {}): { device: DeviceRow; secret: string } | null {
    const secret = randomToken();
    const now = this.now();
    return inTransaction(this.db, () => {
      if (link.reusable) {
        const fresh = this.get(link.id);
        if (!fresh || fresh.revoked_at != null || !fresh.reusable) return null;
        const id = newDeviceId();
        this.db
          .prepare(
            `INSERT INTO devices (id, name, origin, secret_hash, scope_kind, scope_id, auto, created_at, claimed_at, last_seen_at, last_addr, last_host, user_agent)
             VALUES (?, ?, 'link', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            id,
            fresh.name,
            hashSecret(secret),
            fresh.scope_kind,
            fresh.scope_id,
            fresh.auto,
            now,
            now,
            now,
            clip(meta.addr),
            clip(meta.host),
            clip(meta.userAgent),
          );
        return { device: this.get(id) as DeviceRow, secret };
      }
      const done = this.db
        .prepare(
          `UPDATE devices SET claimed_at = ?, secret_hash = ?, link_token = NULL, last_seen_at = ?, last_addr = ?, last_host = ?, user_agent = ?
           WHERE id = ? AND claimed_at IS NULL AND revoked_at IS NULL AND reusable = 0 AND (link_expires_at IS NULL OR link_expires_at > ?)`,
        )
        .run(
          now,
          hashSecret(secret),
          now,
          clip(meta.addr),
          clip(meta.host),
          clip(meta.userAgent),
          link.id,
          now,
        );
      if (Number(done.changes) !== 1) return null;
      return { device: this.get(link.id) as DeviceRow, secret };
    });
  }

  /** The live device a cookie value belongs to, or null: a claimed device, or an old-style link whose token is the cookie. */
  bySecret(secret: unknown): DeviceRow | null {
    if (typeof secret !== "string" || !secret || secret.length > 200) return null;
    const row = this.db
      .prepare("SELECT * FROM devices WHERE secret_hash = ? AND revoked_at IS NULL")
      .get(hashSecret(secret)) as unknown as DeviceRow | undefined;
    return row ?? null;
  }

  /** Record that a device was seen, at most once a minute. True: it was written now. */
  seen(row: DeviceRow, meta: SeenMeta): boolean {
    const now = this.now();
    if (row.last_seen_at != null && now - row.last_seen_at < SEEN_EVERY_MS) return false;
    row.last_seen_at = now;
    this.db
      .prepare(
        "UPDATE devices SET last_seen_at = ?, last_addr = ?, last_host = ?, user_agent = COALESCE(?, user_agent) WHERE id = ?",
      )
      .run(now, clip(meta.addr), clip(meta.host), clip(meta.userAgent), row.id);
    return true;
  }

  /** The hostname a reverse lookup found for the address a device was last seen at, while it still is that address. */
  setHost(id: string, addr: string, host: string): void {
    this.db
      .prepare(
        "UPDATE devices SET last_host = ? WHERE id = ? AND last_addr = ? AND last_host IS NULL",
      )
      .run(clip(host), id, clip(addr));
  }

  /**
   * A Tailscale login the owner lets in without a link or a request: the row is the person,
   * found again by `tailscale whois` on every visit over the tailnet listener, so it has no secret
   * and no cookie. Refused, as a link is, when a live row of that name or that login already has this scope.
   */
  allowLogin({
    login,
    name,
    scope,
    auto = false,
  }: {
    login: unknown;
    name: unknown;
    scope: Scope;
    auto?: boolean;
  }): DeviceRow {
    const who = String(login ?? "").trim();
    if (!who || who.length > 200 || /[\s\u0000-\u001f\u007f]/.test(who))
      throw new Error(
        "a Tailscale login is required, as Tailscale shows it (e.g. ana@example.com or ana@github)",
      );
    if (who === "tagged-devices")
      throw new Error("tagged devices belong to no person; let a person's login in instead");
    const clean = cleanName(name);
    const now = this.now();
    return inTransaction(this.db, () => {
      const same = (
        this.db
          .prepare("SELECT * FROM devices WHERE scope_kind = ? AND scope_id IS ?")
          .all(scope.kind, scope.id) as unknown as DeviceRow[]
      ).filter(
        (r) =>
          isLive(r, now) &&
          (sameName(r.name, clean) || (r.origin === "tailscale" && r.verified_login === who)),
      );
      if (same.length)
        throw new Error(
          `"${same[0].name}" already has access with this scope; revoke it first (share revoke "${same[0].name}")`,
        );
      const id = newDeviceId();
      this.db
        .prepare(
          "INSERT INTO devices (id, name, origin, verified_login, scope_kind, scope_id, auto, created_at, claimed_at) VALUES (?, ?, 'tailscale', ?, ?, ?, ?, ?, ?)",
        )
        .run(id, clean, who, scope.kind, scope.id, auto ? 1 : 0, now, now);
      return this.get(id) as DeviceRow;
    });
  }

  /** The live rows that let Tailscale login `login` in by itself (allowLogin), the oldest first. */
  byLogin(login: string): DeviceRow[] {
    return this.db
      .prepare(
        "SELECT * FROM devices WHERE origin = 'tailscale' AND verified_login = ? AND revoked_at IS NULL ORDER BY created_at, rowid",
      )
      .all(login) as unknown as DeviceRow[];
  }

  /**
   * The first Tailscale login seen behind a device's cookie becomes the device's: from then on the
   * cookie works over the tailnet only for that login (see server.ts identify).
   */
  bindLogin(row: DeviceRow, login: string): void {
    if (row.verified_login != null) return;
    row.verified_login = login;
    this.db
      .prepare("UPDATE devices SET verified_login = ? WHERE id = ? AND verified_login IS NULL")
      .run(login, row.id);
  }

  /** Revoke what `key` names: a row's id, or every live row with that name. Returns the rows revoked. */
  revoke(key: unknown): DeviceRow[] {
    const k = String(key ?? "").trim();
    if (!k) return [];
    const now = this.now();
    return inTransaction(this.db, () => {
      // Names compare in JS: SQLite's lower() folds ASCII only, so "Éva" and "éva" would differ there.
      const rows = (
        this.db
          .prepare("SELECT * FROM devices WHERE revoked_at IS NULL")
          .all() as unknown as DeviceRow[]
      ).filter((r) => r.id === k || (sameName(r.name, k) && isLive(r, now)));
      const stmt = this.db.prepare(
        "UPDATE devices SET revoked_at = ?, secret_hash = NULL, link_token = NULL WHERE id = ?",
      );
      for (const r of rows) stmt.run(now, r.id);
      return rows.map((r) => ({ ...r, revoked_at: now, secret_hash: null, link_token: null }));
    });
  }

  /** A new name for a live row. */
  rename(id: string, name: unknown): DeviceRow {
    const row = this.live(id);
    const clean = cleanName(name);
    this.db.prepare("UPDATE devices SET name = ? WHERE id = ?").run(clean, row.id);
    return this.get(row.id) as DeviceRow;
  }

  /** A new scope for a live row. An unclaimed link narrowed to one page opens on that page. */
  setScope(id: string, scope: Scope): DeviceRow {
    const row = this.live(id);
    const page = row.claimed_at == null && scope.kind === "page" ? scope.id : row.link_page;
    this.db
      .prepare("UPDATE devices SET scope_kind = ?, scope_id = ?, link_page = ? WHERE id = ?")
      .run(scope.kind, scope.id, page, row.id);
    return this.get(row.id) as DeviceRow;
  }

  /**
   * An old-style link made single-use: a fresh token that expires, and the old token stops working
   * as a link and as a cookie. Devices made from it before stay. Returns the row and the new token.
   */
  makeSingleUse(id: string, expiresAt?: number): { row: DeviceRow; token: string } {
    const row = this.live(id);
    if (!row.reusable) throw new Error("this link is single-use already");
    const token = randomToken();
    const expires = expiresAt ?? this.now() + LINK_TTL_MS;
    this.db
      .prepare(
        "UPDATE devices SET reusable = 0, secret_hash = NULL, link_hash = ?, link_token = ?, link_expires_at = ? WHERE id = ?",
      )
      .run(hashSecret(token), token, expires, row.id);
    return { row: this.get(row.id) as DeviceRow, token };
  }

  /** Names of the live rows with auto on that reach this copy: their notes reach the agent without the owner. */
  autoNames(artifactId: string, projectId: string | null): string[] {
    const now = this.now();
    const rows = this.db
      .prepare("SELECT * FROM devices WHERE auto = 1 AND revoked_at IS NULL ORDER BY created_at")
      .all() as unknown as DeviceRow[];
    return [
      ...new Set(
        rows.filter((r) => isLive(r, now) && covers(r, artifactId, projectId)).map((r) => r.name),
      ),
    ];
  }

  private live(id: string): DeviceRow {
    const row = this.get(id);
    if (!row || !isLive(row, this.now()))
      throw new Error(`no live link or device ${JSON.stringify(id)}`);
    return row;
  }
}

/** A device id: short, random, not derived from any secret. */
export function newDeviceId(): string {
  return "d" + crypto.randomBytes(5).toString("hex");
}

export function clip(v: string | null | undefined): string | null {
  return v ? String(v).slice(0, 300) : null;
}

/** One entry of a 0.12 invites.json. */
interface LegacyInvite {
  token: string;
  name: string;
  sessionId: string;
  auto?: boolean;
  createdAt?: number;
}

function isLegacyInvite(i: unknown): i is LegacyInvite {
  if (!i || typeof i !== "object") return false;
  const o = i as Record<string, unknown>;
  return (
    typeof o.token === "string" &&
    o.token.length >= 22 &&
    typeof o.name === "string" &&
    Boolean(o.name) &&
    typeof o.sessionId === "string" &&
    Boolean(o.sessionId)
  );
}

/**
 * Move `<dir>/invites.json` into `devices`: each invite becomes an old-style link (reusable, no
 * expiry, page scope) whose token still works as the cookie it set before. The file is renamed to
 * invites.json.imported. A row's id comes from its token, so two processes importing at once add it once.
 * Returns how many invites it imported.
 */
export function importInvites(db: sqlite.DatabaseSync, dir: string): number {
  const file = path.join(dir, "invites.json");
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    return 0; // none
  }
  let invites: LegacyInvite[] = [];
  try {
    const parsed = JSON.parse(raw) as { invites?: unknown };
    if (Array.isArray(parsed.invites)) invites = parsed.invites.filter(isLegacyInvite);
  } catch {
    // unreadable: nothing to import, and the file is moved aside like a good one
  }
  const added = inTransaction(db, () => {
    const stmt = db.prepare(
      `INSERT OR IGNORE INTO devices (id, name, origin, secret_hash, link_hash, link_token, link_page, reusable, scope_kind, scope_id, auto, created_at)
       VALUES (?, ?, 'link', ?, ?, ?, ?, 1, 'page', ?, ?, ?)`,
    );
    let n = 0;
    for (const inv of invites) {
      const h = hashSecret(inv.token);
      let name: string;
      try {
        name = cleanName(inv.name);
      } catch {
        name = String(inv.name).slice(0, 40) || "reviewer";
      }
      const r = stmt.run(
        `d${crypto.createHash("sha256").update(`austere-axi invite\0${inv.token}`).digest("hex").slice(0, 10)}`,
        name,
        h,
        h,
        inv.token,
        inv.sessionId,
        inv.sessionId,
        inv.auto ? 1 : 0,
        Number(inv.createdAt) || Date.now(),
      );
      n += Number(r.changes);
    }
    return n;
  });
  try {
    fs.renameSync(file, `${file}.imported`);
  } catch {
    // another process moved it first
  }
  return added;
}

/** Two reviewer names are the same person's when they match ignoring case, in any script. */
export function sameName(a: string, b: string): boolean {
  return a.normalize("NFC").toLowerCase() === b.normalize("NFC").toLowerCase();
}
