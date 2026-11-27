// Request access: a browser nobody has given a link opens a page's address, types a
// name and asks; the owner approves, denies, or blocks it. The browser that asked holds a pending
// secret in a cookie (hub.db keeps its hash), so an approval reaches that browser only: the
// address, hostname and browser it came from are evidence for the owner, never the key.
//
// Requests are off until the owner turns them on, for one project or for every page.
import crypto from "node:crypto";
import type * as sqlite from "node:sqlite";
import { clip, hashSecret, isLive, newDeviceId, randomToken, sameName } from "./devices.ts";
import type { DeviceRow, Scope, SeenMeta } from "./devices.ts";
import { cleanName } from "./invites.ts";
import { inTransaction } from "./projects.ts";

/** Where a request stands: waiting for the owner, what the owner decided, or lapsed (nobody decided within WAITING_TTL_MS). */
export type RequestStatus = "waiting" | "approved" | "denied" | "blocked" | "lapsed";

/** A row of `access_requests`. */
export interface AccessRequestRow {
  id: string;
  name: string;
  /** The page (artifact id) the browser asked from. */
  page: string;
  /** sha256 of the pending secret in the asking browser's cookie. */
  secret_hash: string;
  status: RequestStatus;
  addr: string | null;
  /** The address's hostname, from a reverse lookup (best effort; filled in after the request is stored). */
  host: string | null;
  user_agent: string | null;
  /** The Tailscale login and device, when the request came over Tailscale. */
  verified_login: string | null;
  ts_device: string | null;
  /** The device an approval made. */
  device_id: string | null;
  created_at: number;
  decided_at: number | null;
}

export const REQUESTS_SCHEMA = `
CREATE TABLE IF NOT EXISTS access_requests (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  page TEXT NOT NULL,
  secret_hash TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL,
  addr TEXT,
  host TEXT,
  user_agent TEXT,
  verified_login TEXT,
  ts_device TEXT,
  device_id TEXT,
  created_at INTEGER NOT NULL,
  decided_at INTEGER
);
CREATE INDEX IF NOT EXISTS access_requests_addr ON access_requests(addr, created_at);
CREATE INDEX IF NOT EXISTS access_requests_status ON access_requests(status, created_at);
CREATE TABLE IF NOT EXISTS access_settings (
  scope TEXT NOT NULL,
  scope_id TEXT NOT NULL,
  requests INTEGER NOT NULL,
  PRIMARY KEY (scope, scope_id)
);
`;

/** Requests one address may send in an hour. */
export const REQUESTS_PER_ADDR_HOUR = 5;
/** Requests waiting for the owner at most; more are refused until the owner decides some. */
export const MAX_WAITING = 50;
const HOUR_MS = 3_600_000;
/** How long a request waits for the owner; then it lapses and the browser may ask again. */
export const WAITING_TTL_MS = 7 * 86_400_000;

/** A request the server refuses, with the HTTP status to answer with. */
export class RequestRefused extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

/** Where requests are on: for every page or not, and the projects that differ from that. */
export interface RequestSwitch {
  all: boolean;
  projects: { id: string; on: boolean }[];
}

/** "Chrome on macOS": the browser and system a User-Agent names, for the owner to recognise a request by. */
export function describeAgent(ua: string | null): string {
  if (!ua) return "unknown browser";
  const browser = /Edg\//.test(ua)
    ? "Edge"
    : /OPR\/|Opera/.test(ua)
      ? "Opera"
      : /Firefox\/|FxiOS/.test(ua)
        ? "Firefox"
        : /Chrome\/|CriOS/.test(ua)
          ? "Chrome"
          : /Safari\//.test(ua)
            ? "Safari"
            : "a browser";
  const system = /iPhone|iPad|iPod/.test(ua)
    ? "iOS"
    : /Android/.test(ua)
      ? "Android"
      : /Windows/.test(ua)
        ? "Windows"
        : /CrOS/.test(ua)
          ? "ChromeOS"
          : /Mac OS X|Macintosh/.test(ua)
            ? "macOS"
            : /Linux/.test(ua)
              ? "Linux"
              : "";
  return system ? `${browser} on ${system}` : browser;
}

export class RequestStore {
  db: sqlite.DatabaseSync;
  now: () => number;

  constructor(db: sqlite.DatabaseSync, now: () => number = Date.now) {
    this.db = db;
    this.now = now;
  }

  get(id: string): AccessRequestRow | null {
    return (
      (this.db.prepare("SELECT * FROM access_requests WHERE id = ?").get(id) as unknown as
        | AccessRequestRow
        | undefined) ?? null
    );
  }

  /** The request a browser's pending cookie belongs to, whatever its status, or null. */
  bySecret(secret: unknown): AccessRequestRow | null {
    if (typeof secret !== "string" || !secret || secret.length > 200) return null;
    this.lapse();
    return (
      (this.db
        .prepare("SELECT * FROM access_requests WHERE secret_hash = ?")
        .get(hashSecret(secret)) as unknown as AccessRequestRow | undefined) ?? null
    );
  }

  /** The requests with this status, the oldest first. Waiting ones past WAITING_TTL_MS lapse first. */
  list(status: RequestStatus): AccessRequestRow[] {
    this.lapse();
    return this.db
      .prepare("SELECT * FROM access_requests WHERE status = ? ORDER BY created_at, rowid")
      .all(status) as unknown as AccessRequestRow[];
  }

  /** Whether a browser may ask for a page of project `projectId` (null: a page in no project): the project's own setting, else the one for every page. */
  enabled(projectId: string | null): boolean {
    const own =
      projectId == null
        ? undefined
        : (this.db
            .prepare(
              "SELECT requests FROM access_settings WHERE scope = 'project' AND scope_id = ?",
            )
            .get(projectId) as { requests: number } | undefined);
    if (own) return own.requests === 1;
    const all = this.db
      .prepare("SELECT requests FROM access_settings WHERE scope = 'all' AND scope_id = ''")
      .get() as { requests: number } | undefined;
    return all?.requests === 1;
  }

  switches(): RequestSwitch {
    const all = this.enabled(null);
    const rows = this.db
      .prepare(
        "SELECT scope_id, requests FROM access_settings WHERE scope = 'project' ORDER BY scope_id",
      )
      .all() as { scope_id: string; requests: number }[];
    return { all, projects: rows.map((r) => ({ id: r.scope_id, on: r.requests === 1 })) };
  }

  /**
   * Turn requests on or off for every page (`projectId` null), which clears every project's own
   * setting, or for one project (an id), kept only where it differs from every page's.
   */
  setEnabled(projectId: string | null, on: boolean): void {
    inTransaction(this.db, () => {
      if (projectId == null) {
        this.db.prepare("DELETE FROM access_settings WHERE scope = 'project'").run();
        this.db
          .prepare(
            "INSERT INTO access_settings (scope, scope_id, requests) VALUES ('all', '', ?) ON CONFLICT (scope, scope_id) DO UPDATE SET requests = excluded.requests",
          )
          .run(on ? 1 : 0);
      } else if (on === this.enabled(null)) {
        this.db
          .prepare("DELETE FROM access_settings WHERE scope = 'project' AND scope_id = ?")
          .run(projectId);
      } else {
        this.db
          .prepare(
            "INSERT INTO access_settings (scope, scope_id, requests) VALUES ('project', ?, ?) ON CONFLICT (scope, scope_id) DO UPDATE SET requests = excluded.requests",
          )
          .run(projectId, on ? 1 : 0);
      }
    });
  }

  /**
   * The owner's default for a new reviewer's notes: held for the owner (false, the default) or
   * straight to the agent (true). A share or an approval that does not say takes it. Kept in access_settings
   * as the row (scope 'notes', scope_id ''), `requests` 1 for straight to the agent: no schema change.
   */
  defaultAuto(): boolean {
    const row = this.db
      .prepare("SELECT requests FROM access_settings WHERE scope = 'notes' AND scope_id = ''")
      .get() as { requests: number } | undefined;
    return row?.requests === 1;
  }

  setDefaultAuto(auto: boolean): void {
    this.db
      .prepare(
        "INSERT INTO access_settings (scope, scope_id, requests) VALUES ('notes', '', ?) ON CONFLICT (scope, scope_id) DO UPDATE SET requests = excluded.requests",
      )
      .run(auto ? 1 : 0);
  }

  /**
   * The local-network address the owner switched on in Settings → Network, or null (off, the
   * default). Kept in access_settings as the row (scope 'lan', scope_id the address): no schema change.
   */
  lanAddress(): string | null {
    const row = this.db
      .prepare("SELECT scope_id FROM access_settings WHERE scope = 'lan' AND requests = 1")
      .get() as { scope_id: string } | undefined;
    return row?.scope_id || null;
  }

  setLanAddress(address: string | null): void {
    inTransaction(this.db, () => {
      this.db.prepare("DELETE FROM access_settings WHERE scope = 'lan'").run();
      if (address)
        this.db
          .prepare("INSERT INTO access_settings (scope, scope_id, requests) VALUES ('lan', ?, 1)")
          .run(address);
    });
  }

  /** Waiting requests nobody decided within WAITING_TTL_MS lapse: they leave the queue, and their browsers may ask again. */
  private lapse(): void {
    const now = this.now();
    this.db
      .prepare(
        "UPDATE access_requests SET status = 'lapsed', decided_at = ? WHERE status = 'waiting' AND created_at <= ?",
      )
      .run(now, now - WAITING_TTL_MS);
  }

  /**
   * Store a request from the browser asking on `page`, with what the server saw: `tailscale` when
   * the request came over the tailnet listener and Tailscale named the person (their login and
   * device are kept with it). Throws RequestRefused for a bad name (400) or past the limits (429).
   * Returns the row and the pending secret for the browser's cookie.
   */
  ask({
    name,
    page,
    meta,
    tailscale = null,
  }: {
    name: unknown;
    page: string;
    meta: SeenMeta;
    tailscale?: { login: string; device: string } | null;
  }): { row: AccessRequestRow; secret: string } {
    let clean: string;
    try {
      clean = cleanName(name);
    } catch (err) {
      const msg = (err as Error).message;
      throw new RequestRefused(
        /required/.test(msg) ? "Type your name." : msg.replace(/^the reviewer name/, "The name"),
        400,
      );
    }
    const now = this.now();
    const addr = clip(meta.addr);
    return inTransaction(this.db, () => {
      this.lapse();
      const recent = this.db
        .prepare("SELECT COUNT(*) AS n FROM access_requests WHERE addr IS ? AND created_at > ?")
        .get(addr, now - HOUR_MS) as { n: number };
      if (Number(recent.n) >= REQUESTS_PER_ADDR_HOUR)
        throw new RequestRefused("Too many requests from this address. Try again in an hour.", 429);
      const waiting = this.db
        .prepare("SELECT COUNT(*) AS n FROM access_requests WHERE status = 'waiting'")
        .get() as { n: number };
      if (Number(waiting.n) >= MAX_WAITING)
        throw new RequestRefused(
          "Too many requests are waiting for the owner. Try again later.",
          429,
        );
      const secret = randomToken();
      const id = "r" + crypto.randomBytes(5).toString("hex");
      this.db
        .prepare(
          "INSERT INTO access_requests (id, name, page, secret_hash, status, addr, user_agent, verified_login, ts_device, created_at) VALUES (?, ?, ?, ?, 'waiting', ?, ?, ?, ?, ?)",
        )
        .run(
          id,
          clean,
          page,
          hashSecret(secret),
          addr,
          clip(meta.userAgent),
          tailscale?.login ?? null,
          clip(tailscale?.device) ?? null,
          now,
        );
      return { row: this.get(id) as AccessRequestRow, secret };
    });
  }

  /** The hostname a reverse lookup found for a request's address. */
  setHost(id: string, host: string): void {
    this.db
      .prepare("UPDATE access_requests SET host = ? WHERE id = ? AND host IS NULL")
      .run(clip(host), id);
  }

  /**
   * Approve a waiting request: a device named as the request (or `name`, when the owner renames it),
   * with `scope` and `auto`. Refused, as a link is, when a live link or device of that name has
   * that scope already, so a name stays one person's and `share revoke <name>` stays unambiguous.
   * The device has no secret yet: only the browser holding the request's pending secret can collect it (see collect).
   */
  approve(id: string, scope: Scope, auto: boolean, name?: unknown): DeviceRow {
    const now = this.now();
    return inTransaction(this.db, () => {
      const row = this.waiting(id);
      let clean = row.name;
      if (name !== undefined && name !== null && name !== "") {
        try {
          clean = cleanName(name);
        } catch (err) {
          throw new RequestRefused((err as Error).message, 400);
        }
      }
      const same = (
        this.db
          .prepare("SELECT * FROM devices WHERE scope_kind = ? AND scope_id IS ?")
          .all(scope.kind, scope.id) as unknown as DeviceRow[]
      ).filter((r) => sameName(r.name, clean) && isLive(r, now));
      if (same.length)
        throw new RequestRefused(
          `"${clean}" already has access with this scope: approve under another name (--as), revoke that one first, or deny this request`,
          409,
        );
      const deviceId = newDeviceId();
      this.db
        .prepare(
          `INSERT INTO devices (id, name, origin, verified_login, scope_kind, scope_id, auto, created_at, claimed_at, last_addr, last_host, user_agent)
           VALUES (?, ?, 'request', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          deviceId,
          clean,
          row.verified_login,
          scope.kind,
          scope.id,
          auto ? 1 : 0,
          now,
          now,
          row.addr,
          row.host,
          row.user_agent,
        );
      this.db
        .prepare(
          "UPDATE access_requests SET status = 'approved', device_id = ?, decided_at = ? WHERE id = ?",
        )
        .run(deviceId, now, id);
      return this.db
        .prepare("SELECT * FROM devices WHERE id = ?")
        .get(deviceId) as unknown as DeviceRow;
    });
  }

  /** Deny a waiting request (the browser may ask again), or block it (that browser may not). */
  decide(id: string, status: "denied" | "blocked"): AccessRequestRow {
    return inTransaction(this.db, () => {
      this.waiting(id);
      this.db
        .prepare("UPDATE access_requests SET status = ?, decided_at = ? WHERE id = ?")
        .run(status, this.now(), id);
      return this.get(id) as AccessRequestRow;
    });
  }

  /**
   * The approved device for the browser holding `secret`, once: it gets a fresh device secret for
   * its cookie. Null when this secret has no approval, the device was revoked, or it was collected already.
   */
  collect(secret: unknown): { device: DeviceRow; secret: string } | null {
    const req = this.bySecret(secret);
    if (!req || req.status !== "approved" || !req.device_id) return null;
    const fresh = randomToken();
    const done = this.db
      .prepare(
        "UPDATE devices SET secret_hash = ?, last_seen_at = ? WHERE id = ? AND secret_hash IS NULL AND revoked_at IS NULL",
      )
      .run(hashSecret(fresh), this.now(), req.device_id);
    if (Number(done.changes) !== 1) return null;
    return {
      device: this.db
        .prepare("SELECT * FROM devices WHERE id = ?")
        .get(req.device_id) as unknown as DeviceRow,
      secret: fresh,
    };
  }

  private waiting(id: string): AccessRequestRow {
    this.lapse();
    const row = this.get(id);
    if (!row) throw new RequestRefused(`no request ${JSON.stringify(id)}`, 404);
    if (row.status !== "waiting")
      throw new RequestRefused(`this request was ${row.status} already`, 409);
    return row;
  }
}
