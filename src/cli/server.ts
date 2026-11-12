// Local review server. One per machine (per port), shared by every session.
//   /api/*        control routes for the CLI (loopback only)
//   /s/:id        review page (chrome) for a session
//   /s/:id/a/...  the artifact and its sibling assets, runtime tag pointed here
//   /s/:id/events server-sent events for the chrome
//   /__austere/*  runtime, mermaid, bundled packs, chrome assets
//   /__austere/installed-packs/<name@version>/pack.js  packs from `components add`
import { resolveSibling } from "./assets.ts";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { readArtifact, rewriteRuntime, escapeHtml } from "./artifact.ts";
import { exportHtml } from "./export.ts";
import { allowedHosts, detectTailscale, hostOnly, isLoopback, linkUrl } from "./net.ts";
import type { Tailnet } from "./net.ts";
import { ASSET_DIR, VERSION, msEnv, stateDir } from "./paths.ts";
import { SessionStore, newId } from "./sessions.ts";
import type { FeedbackEntry, NoteItem, Session, TranscriptEntry, UserEntry } from "./sessions.ts";
import { lockStateDir } from "./lock.ts";
import { installedPackFile, pagePacks, readLock } from "./packs.ts";
import { Hub, hubEnabled } from "./hub.ts";
import { COOKIE, InviteStore, LoginCodes, OWNER_COOKIE, inviteId, ownerCookie, ownerKey, safeEqual, tokenFromCookie } from "./invites.ts";
import type { Invite } from "./invites.ts";
import { reviewerItem } from "./items.ts";
import { hubPage, notesPage } from "./hub-page.ts";
import { splitSpec } from "../shared/packs-meta.ts";
import crypto from "node:crypto";

// ── what the control routes answer (client.ts request() reads these) ──

/** /api/health. A server from before the health proof sends no `proof`. */
export interface HealthInfo {
  name: string;
  version: string;
  pid: number;
  port: number;
  stateDir: string;
  proof?: string;
  listen: string[];
  tailnet?: Tailnet;
  remote?: string;
  hub: boolean;
  persist: boolean;
}

/** Whether an agent listens on a session, works on its notes, or neither. */
export type Presence = "listening" | "working" | "idle";

/** The owner's links to a page. `remote` carries the owner key. */
export interface SessionLinks {
  local: string;
  remote?: string;
}

/** A session as the control routes and the chrome see it. */
export interface PublicSession {
  id: string;
  file: string;
  title: string;
  status: Session["status"];
  endedBy: string | null;
  closed: boolean;
  unread: number;
}

/** One session in /api/sessions. */
export interface SessionListing extends PublicSession {
  presence: Presence;
  browsers: number;
  pending: number;
  held: number;
  links: SessionLinks;
}

/** /api/sessions. */
export interface SessionsResponse {
  sessions: SessionListing[];
}

/** /api/open. */
export type OpenResponse =
  | { status: "refused"; session: PublicSession; links: SessionLinks }
  | { status: "open"; session: PublicSession; links: SessionLinks; browsers: number; pending: number; held: number };

/** /api/poll, and how a listening poll ends. */
export interface PollResponse {
  status: "feedback" | "ended" | "timeout" | "replaced" | "browser_disconnected" | "interrupted" | "listener_active";
  /** feedback: the notes' items, and the cursor that acknowledges them */
  items?: NoteItem[];
  cursor?: number;
  ended?: true;
  endedBy?: string | null;
  closed?: true;
  /** interrupted: why the server stopped */
  reason?: string;
  /** listener_active: the `owner` the listening poll gave */
  owner?: unknown;
  error?: string;
}

/** /api/feedback. */
export interface FeedbackResponse {
  session: PublicSession;
  entries: FeedbackEntry[];
}

/** /api/share. */
export interface ShareResponse {
  id: string;
  name: string;
  auto: boolean;
  link: string;
  file: string;
}

/** One invite in /api/share/list; `link` only when asked for. */
export interface InviteSummary {
  id: string;
  name: string;
  file: string;
  auto: boolean;
  createdAt: number;
  link?: string;
}

/** /api/share/list. */
export interface ShareListResponse {
  invites: InviteSummary[];
}

/** /api/share/revoke. */
export interface RevokeResponse {
  revoked: { id: string; name: string; file: string }[];
}

/** /api/login. */
export interface LoginResponse {
  code: string;
  ttlMs: number;
}

/** Who is asking for a page: the owner, or a team reviewer with a valid invite. */
type OwnerViewer = { role: "owner"; name: string };
type ReviewerViewer = { role: "reviewer"; name: string; auto: boolean; token: string };
type Viewer = OwnerViewer | ReviewerViewer;

/** A browser's event stream. `stalledSince`: when its socket backed up. */
interface SseClient {
  res: http.ServerResponse;
  viewer: Viewer;
  stalledSince?: number;
}

/** An agent's poll waiting for notes. */
interface Poll {
  res: http.ServerResponse;
  owner: unknown;
  startedAt: number;
  done: boolean;
  from: number;
}

/** A watched artifact file and what it held last. */
interface Watcher {
  html: string | null;
  program: string | null;
  shell: string | null;
  timer: ReturnType<typeof setTimeout> | undefined;
}

/** A parsed JSON request body. */
type RequestBody = Record<string, unknown>;

/** An error that carries the HTTP status to answer with. */
type HttpError = Error & { status?: number };

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".htm": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".txt": "text/plain; charset=utf-8",
  ".md": "text/plain; charset=utf-8",
  ".csv": "text/plain; charset=utf-8",
  ".pdf": "application/pdf",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
};

const SHORT_GRACE_MS = 10_000;
/** Whether AUSTERE_AXI_PERSIST asks the server to stay up with no one using it. */
export function persistEnv() {
  return /^(1|true|yes)$/i.test(process.env.AUSTERE_AXI_PERSIST || "");
}

/** How long a login code from `austere-axi login` (or the CLI opening a browser) works. */
const LOGIN_TTL_MS = 60_000;
const OWNER: OwnerViewer = Object.freeze({ role: "owner", name: "" });
const REVIEWER_KINDS = new Set<unknown>(["annotation", "message"]);
// Render failures the owner's page reports on its own; they reach the agent as notes from this author.
const RENDER_CHECK_AUTHOR = "Render check";
const MAX_RENDER_ERRORS = 20;
// Transcript entries a page gets at once; it asks for older ones as the reader scrolls back.
const PAGE = 200;
// A stalled event stream is dropped once more than SSE_MAX_BUFFER stays queued for it for SSE_STALL_MS, or at once past
// SSE_HARD_MAX; reviewers get a few streams each.
const SSE_MAX_BUFFER = 1 << 20;
const SSE_STALL_MS = 5_000;
const SSE_HARD_MAX = 32 << 20;
const SSE_MAX_PER_REVIEWER = 4;
const MAX_HELD_PER_REVIEWER = 200;
const SSE_MAX_PER_SESSION = 16;

export async function runServer({
  port,
  verbose = false,
  alsoListen = [],
  persist = false,
}: {
  port: number;
  verbose?: boolean;
  alsoListen?: string[];
  persist?: boolean;
}): Promise<{ port: number; shutdown: (reason: string) => void }> {
  const log = (...a: unknown[]): void => {
    const line = `${new Date().toISOString()} ${a.join(" ")}`;
    if (verbose) process.stderr.write(line + "\n");
    try {
      fs.appendFileSync(path.join(stateDir(), "server.log"), line + "\n", { mode: 0o600 });
    } catch {
      // ignore
    }
  };

  // Notes commit to hub.db before any request that adds them is answered. The lock names
  // the port, so a later process can tell this server from an unrelated one with its pid.
  const releaseLock = await lockStateDir(stateDir(), { port, wait: 3000 });
  process.on("exit", releaseLock);
  let store: SessionStore;
  try {
    store = await SessionStore.open(stateDir());
  } catch (err) {
    releaseLock();
    throw err;
  }
  // The owner's pages over the same database, shown while `hub on`.
  const hub = new Hub(store.db);
  const invites = new InviteStore(stateDir());
  const ownerToken = ownerKey(stateDir());
  const ownerCookieValue = ownerCookie(ownerToken);
  const logins = new LoginCodes(LOGIN_TTL_MS);
  const clients = new Map<string, Set<SseClient>>(); // id -> Set<{res, viewer}>
  const polls = new Map<string, Poll>(); // id -> poll
  const watchers = new Map<string, Watcher>(); // id -> { html, program, shell }
  const listeners = new Map<string, http.Server>(); // host -> http.Server
  const graceTimers = new Map<string, ReturnType<typeof setTimeout>>(); // id -> timeout
  const byeAt = new Map<string, number>(); // id -> ms of last explicit tab close
  const browserSeen = new Set<string>();
  // Render errors already sent per session, for one revision; a repeat or a second tab adds nothing.
  const renderReported = new Map<string, { revision: number; keys: Set<string> }>();
  let tailnet: Tailnet | null = null;
  const linkBase = linkUrl(); // throws on a bad AUSTERE_AXI_LINK_URL: better to stop here than print wrong links
  let lastActivity = Date.now();
  const longGraceMs = msEnv("AUSTERE_AXI_DISCONNECT_GRACE_MS", 5 * 60_000);
  const idleMs = persist || persistEnv() ? 0 : msEnv("AUSTERE_AXI_IDLE_TIMEOUT_MS", 30 * 60_000);

  const activity = () => {
    lastActivity = Date.now();
  };

  // ── helpers ──

  function hostsAllowed(): Set<string> {
    const extra: (string | null)[] = [];
    if (tailnet) extra.push(tailnet.ip, tailnet.dnsName);
    if (linkBase) extra.push(linkBase.host);
    for (const h of listeners.keys()) extra.push(h);
    return allowedHosts(extra);
  }

  /** The host a teammate or phone reaches this server at, or null when only loopback listens. */
  function remoteHost(): string | null {
    const linkHost = process.env.AUSTERE_AXI_LINK_HOST;
    if (linkHost) return linkHost;
    if (tailnet && listeners.has(tailnet.ip)) return tailnet.dnsName || tailnet.ip;
    const explicit = process.env.AUSTERE_AXI_HOST;
    if (explicit && !/^(0\.0\.0\.0|::|\*)$/.test(explicit) && listeners.has(explicit)) return explicit;
    return null;
  }

  /** Where a teammate or phone reaches this server, without a trailing slash, or null when only loopback listens. */
  function remoteBase(): string | null {
    if (linkBase) return linkBase.base;
    const host = remoteHost();
    return host ? `http://${host}:${port}` : null;
  }

  /** The page's address for a remote reviewer, without any key, or null. */
  function remoteUrl(id: string): string | null {
    const base = remoteBase();
    return base ? `${base}/s/${id}` : null;
  }

  /**
   * The owner's links. The remote one carries the owner key, which the server swaps for a cookie. The
   * local one does not: the CLI opens it with a single-use login code (client.ts loginUrl).
   */
  function links(id: string): SessionLinks {
    const out: SessionLinks = { local: `http://127.0.0.1:${port}/s/${id}` };
    const remote = remoteUrl(id);
    if (remote) out.remote = `${remote}?key=${ownerToken}`;
    return out;
  }

  /** The link a teammate opens: the page plus the token, which the server swaps for a cookie. */
  function inviteLink(inv: Invite): string {
    return `${remoteUrl(inv.sessionId)}?invite=${inv.token}`;
  }

  /**
   * Only a request with the owner cookie is the owner, on loopback too: another OS user on this
   * machine can reach 127.0.0.1 but cannot read owner.key (mode 0600). The cookie holds a value
   * derived from the key, not the key (see ownerCookie).
   */
  function isOwner(req: http.IncomingMessage): boolean {
    const value = tokenFromCookie(req.headers.cookie, OWNER_COOKIE);
    return value != null && safeEqual(value, ownerCookieValue);
  }

  /** The 403 text for a request that is not the owner. On loopback it is most likely the owner in a browser without the cookie yet. */
  function notOwner(req: http.IncomingMessage, text = "Only the owner can open this. Ask the owner for a link to the page.") {
    if (!isLoopback(req.socket.remoteAddress)) return text;
    return `${text}\nIf this is your page, sign this browser in: run \`austere-axi login\` (or \`austere-axi login <file>\`) and open the single-use link it prints.`;
  }

  /** Redirect to `url` without the sign-in parameter, setting the owner cookie. */
  function signIn(res: http.ServerResponse, url: URL, param: string): void {
    url.searchParams.delete(param);
    res.writeHead(302, {
      location: url.pathname + url.search,
      "set-cookie": `${OWNER_COOKIE}=${ownerCookieValue}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000`,
      "cache-control": "no-store",
    });
    res.end();
  }

  // ── who is asking ──

  /**
   * A team reviewer (a valid invite cookie for this session), else the owner (the owner key cookie, set
   * from a link the CLI opened or the owner's own remote link), else nobody. A cookie that matches no
   * invite is refused, never treated as the owner, so revoking cuts access.
   */
  function identify(req: http.IncomingMessage, s: Session): Viewer | null {
    const token = tokenFromCookie(req.headers.cookie);
    if (token == null) return isOwner(req) ? OWNER : null;
    const inv = invites.find(token);
    if (!inv || inv.sessionId !== s.id) return null;
    return { role: "reviewer", name: inv.name, auto: inv.auto, token: inv.token };
  }

  /** Held and discarded notes belong to the owner and to the author. */
  function canSee(e: TranscriptEntry, viewer: Viewer): boolean {
    if (viewer.role === "owner") return true;
    if (e.role === "user" && (e.held || e.discarded)) return e.author === viewer.name;
    return true;
  }

  function send(res: http.ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
    const isText = typeof body === "string" || Buffer.isBuffer(body);
    const payload = isText ? body : JSON.stringify(body);
    res.writeHead(status, {
      "content-type": isText ? headers["content-type"] || "text/plain; charset=utf-8" : "application/json; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      ...headers,
    });
    res.end(payload);
  }

  async function readBody(req: http.IncomingMessage, limit = 2 * 1024 * 1024): Promise<RequestBody> {
    let size = 0;
    const chunks: Buffer[] = [];
    for await (const c of req as AsyncIterable<Buffer>) {
      size += c.length;
      if (size > limit) throw Object.assign(new Error("payload too large"), { status: 413 });
      chunks.push(c);
    }
    const raw = Buffer.concat(chunks).toString("utf8");
    if (!raw) return {};
    try {
      return JSON.parse(raw) as RequestBody;
    } catch {
      throw Object.assign(new Error("invalid JSON"), { status: 400 });
    }
  }

  function presence(s: Session): Presence {
    if (polls.has(s.id)) return "listening";
    if (s.workingSince) return "working";
    return "idle";
  }

  function publicSession(s: Session): PublicSession {
    return { id: s.id, file: s.file, title: s.title, status: s.status, endedBy: s.endedBy, closed: Boolean(s.closedAt), unread: store.unread(s).length };
  }

  /**
   * Write to an event stream, and drop the client once its socket stays backed up instead of buffering for it.
   * A backlog over SSE_MAX_BUFFER is forgiven for SSE_STALL_MS (one large event, and the small ones right after it,
   * must not cut off a viewer that is reading); past SSE_HARD_MAX the client is dropped at once.
   */
  function sseWrite(set: Set<SseClient>, c: SseClient, msg: string): void {
    const queued = c.res.writableLength;
    if (queued > SSE_HARD_MAX || (queued > SSE_MAX_BUFFER && c.stalledSince && Date.now() - c.stalledSince > SSE_STALL_MS)) {
      set.delete(c);
      c.res.destroy();
      return;
    }
    if (!c.res.write(msg) && !c.stalledSince && c.res.writableLength > SSE_MAX_BUFFER) {
      c.stalledSince = Date.now();
      c.res.once("drain", () => (c.stalledSince = 0));
    }
  }

  function broadcast(id: string, event: string, data: unknown): void {
    const set = clients.get(id);
    if (!set) return;
    const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const c of Array.from(set)) sseWrite(set, c, msg);
  }

  function broadcastPresence(s: Session): void {
    broadcast(s.id, "presence", { presence: presence(s), status: s.status, endedBy: s.endedBy, closed: Boolean(s.closedAt), unread: store.unread(s).length });
  }

  function broadcastTranscript(s: Session, entries: TranscriptEntry[]): void {
    const set = clients.get(s.id);
    if (!set) return;
    for (const c of Array.from(set)) {
      const visible = entries.filter((e) => canSee(e, c.viewer));
      if (visible.length) sseWrite(set, c, `event: transcript\ndata: ${JSON.stringify({ entries: visible })}\n\n`);
    }
  }

  /** Close the event streams of revoked invites. */
  function dropReviewers(tokens: Set<string>): void {
    for (const set of clients.values()) {
      for (const c of Array.from(set)) {
        if (c.viewer.role !== "reviewer" || !tokens.has(c.viewer.token)) continue;
        c.res.write(`event: server\ndata: ${JSON.stringify({ state: "revoked" })}\n\n`);
        c.res.end();
        set.delete(c);
      }
    }
  }

  // ── file watching ──

  function readFileSafe(file: string): string | null {
    try {
      return fs.readFileSync(file, "utf8");
    } catch {
      return null;
    }
  }

  function watch(s: Session): void {
    if (watchers.has(s.id)) return;
    const html = readFileSafe(s.file);
    const art = html == null ? null : readArtifact(html);
    const w: Watcher = { html, program: art?.program ?? null, shell: art?.shell ?? null, timer: undefined };
    watchers.set(s.id, w);
    if (art?.title) s.title = art.title;
    fs.watchFile(s.file, { interval: 300 }, () => {
      clearTimeout(w.timer);
      w.timer = setTimeout(() => onFileChange(s, w), 120);
    });
  }

  function unwatch(id: string): void {
    const s = store.get(id);
    if (s) fs.unwatchFile(s.file);
    watchers.delete(id);
  }

  function onFileChange(s: Session, w: Watcher): void {
    const html = readFileSafe(s.file);
    if (html == null || html === w.html) return;
    const art = readArtifact(html);
    const shellChanged = art.shell !== w.shell;
    w.html = html;
    w.program = art.program;
    w.shell = art.shell;
    s.revision += 1;
    if (art.title) s.title = art.title;
    log("change", s.id, `rev=${s.revision}`, shellChanged ? "shell" : "program");
    // Receipts: work started on delivered-but-unanswered feedback.
    const touched = s.transcript.filter((e): e is UserEntry => e.role === "user" && Boolean(e.seenAt) && !e.doneAt && !e.workAt);
    if (touched.length) {
      store.markWorking(s, touched);
      broadcastTranscript(s, touched);
    }
    broadcast(s.id, "changed", {
      revision: s.revision,
      program: art.program,
      shellChanged,
      title: art.title,
      thirdPartyPacks: thirdPartyPacks(html),
    });
  }

  /** Packs on this page not published by austere-axi: the chrome warns that their code runs in it. */
  function thirdPartyPacks(html: string | null | undefined): string[] {
    return html ? pagePacks(html).thirdParty.map((p) => `${p.name}@${p.version}`) : [];
  }

  // ── polling ──

  /** Answer `poll` with every note after its read point. The notes stay unread until the agent acknowledges them. */
  function deliver(s: Session, poll: Poll): void {
    const entries = store.after(s, poll.from);
    const items: NoteItem[] = [];
    let end = false;
    for (const e of entries) {
      for (const it of e.items || []) items.push(e.author ? { ...it, author: e.author } : it);
      if (e.end) end = true;
    }
    // Ended only if it still is: a reviewer's end batch, the reviewer's end, or the owner's close. A replay to an agent that ended is not final.
    const ended = s.status === "ended" && (s.endedBy === "user" || Boolean(s.closedAt) || end);
    const body: PollResponse = {
      status: "feedback",
      items,
      cursor: entries[entries.length - 1].seq,
      ended: ended || undefined,
      endedBy: ended ? s.endedBy || "user" : undefined,
    };
    finishPoll(s, poll, body, () => {
      store.markDelivered(s, entries);
      s.workingSince = Date.now();
      broadcastTranscript(s, entries);
      broadcastPresence(s);
    });
  }

  /** A listening poll gets new notes at once. */
  function wake(s: Session): void {
    const poll = polls.get(s.id);
    if (poll && !poll.done && store.after(s, poll.from).length) deliver(s, poll);
  }

  /** The `cursor` or `after` of a poll or reply: a whole number, or null when absent. */
  function seqParam(v: unknown): number | null {
    if (v == null || v === "") return null;
    const n = Number(v);
    if (!Number.isInteger(n) || n < 0) throw Object.assign(new Error("cursor and after are whole numbers from a poll"), { status: 400 });
    return n;
  }

  /**
   * The agent acknowledges what it got: up to `cursor`, or, when it replies without one,
   * up to what the last poll handed it. A bare poll acknowledges nothing, so an agent
   * that lost an answer gets it again.
   */
  function acknowledge(s: Session, body: RequestBody, replying: boolean): UserEntry[] {
    const cursor = seqParam(body.cursor);
    if (cursor != null) return store.ack(s, cursor);
    return replying ? store.ack(s, s.deliveredSeq) : [];
  }

  /** The owner locks the review: the composer closes and a listening poll ends. */
  function closeReview(s: Session): void {
    store.closeReview(s);
    s.workingSince = null;
    const poll = polls.get(s.id);
    if (poll && !poll.done) finishPoll(s, poll, { status: "ended", endedBy: s.endedBy, closed: true });
    broadcast(s.id, "ended", { by: s.endedBy, closed: true });
    broadcastPresence(s);
  }

  function finishPoll(s: Session, poll: Poll, body: PollResponse, onDelivered?: () => void): void {
    if (poll.done) return;
    poll.done = true;
    clearTimeout(graceTimers.get(s.id));
    graceTimers.delete(s.id);
    if (polls.get(s.id) === poll) polls.delete(s.id);
    poll.res.on("finish", () => onDelivered?.());
    send(poll.res, 200, body);
    broadcastPresence(s);
  }

  function clientCount(id: string): number {
    return clients.get(id)?.size || 0;
  }

  function armGrace(s: Session): void {
    clearTimeout(graceTimers.get(s.id));
    graceTimers.delete(s.id);
    const poll = polls.get(s.id);
    if (!poll || clientCount(s.id) > 0 || !browserSeen.has(s.id)) return;
    const closedOnPurpose = Date.now() - (byeAt.get(s.id) || 0) < 5_000;
    const ms = closedOnPurpose ? Math.min(SHORT_GRACE_MS, longGraceMs || SHORT_GRACE_MS) : longGraceMs;
    if (!ms) return;
    graceTimers.set(
      s.id,
      setTimeout(() => {
        if (clientCount(s.id) === 0 && polls.get(s.id) === poll) {
          log("poll", s.id, "browser_disconnected");
          finishPoll(s, poll, { status: "browser_disconnected" });
        }
      }, ms),
    );
  }

  // ── routes ──

  async function handleApi(req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<void> {
    if (!isLoopback(req.socket.remoteAddress)) return send(res, 403, { error: "control routes are loopback-only" });
    // The CLI sends no Origin; a browser always does on POST. Any web page could
    // otherwise reach these routes on localhost.
    if (req.headers.origin || req.headers["sec-fetch-site"]) return send(res, 403, { error: "control routes are for the CLI" });
    const route = url.pathname.slice(5);
    // Loopback is not a person: every other OS user on this machine can reach it. The CLI proves it
    // is the owner with the key from owner.key (mode 0600). Health stays open so a CLI can find and
    // check the server; it answers the CLI's nonce with an HMAC under the key instead of the key.
    if (route !== "health") {
      const key = req.headers["x-austere-key"];
      if (typeof key !== "string" || !safeEqual(key, ownerToken)) return send(res, 403, { error: "owner key required" });
    }
    activity();
    if (route === "health") {
      const nonce = url.searchParams.get("nonce");
      return send(res, 200, {
        name: "austere-axi",
        version: VERSION,
        pid: process.pid,
        port,
        stateDir: stateDir(),
        // Bound to the port this server listens on: a listener elsewhere cannot relay it as its own.
        proof: nonce ? crypto.createHmac("sha256", ownerToken).update(`${port}:${nonce}`).digest("base64url") : undefined,
        listen: Array.from(listeners.keys()),
        tailnet: tailnet || undefined,
        remote: remoteBase() || undefined,
        hub: hubEnabled(),
        persist: idleMs === 0,
      } satisfies HealthInfo);
    }
    if (route === "sessions") {
      return send(res, 200, {
        sessions: store.list().map((s) => ({
          ...publicSession(s),
          presence: presence(s),
          browsers: clientCount(s.id),
          pending: store.unread(s).length,
          closed: Boolean(s.closedAt),
          held: store.heldEntries(s).length,
          links: links(s.id),
        })),
      } satisfies SessionsResponse);
    }
    if (route === "shutdown" && req.method === "POST") {
      send(res, 200, { ok: true });
      setTimeout(() => shutdown("requested"), 50);
      return;
    }
    if (route === "login" && req.method === "POST") return send(res, 200, { code: logins.issue(), ttlMs: LOGIN_TTL_MS } satisfies LoginResponse);
    if (route === "share/list") {
      const withLinks = url.searchParams.get("links") === "1";
      return send(res, 200, {
        invites: invites.list().map((i) => ({
          id: inviteId(i),
          name: i.name,
          file: i.file,
          auto: i.auto,
          createdAt: i.createdAt,
          link: withLinks ? inviteLink(i) : undefined,
        })),
      } satisfies ShareListResponse);
    }
    if (req.method !== "POST") return send(res, 405, { error: "POST expected" });
    const body = await readBody(req);
    if (route === "share/revoke") {
      const gone = invites.revoke(String(body.key || ""));
      if (!gone.length) return send(res, 404, { error: "no invite matches that name or id" });
      dropReviewers(new Set(gone.map((i) => i.token)));
      log("share-revoke", gone.map((i) => `${i.name}(${inviteId(i)})`).join(","));
      return send(res, 200, { revoked: gone.map((i) => ({ id: inviteId(i), name: i.name, file: i.file })) } satisfies RevokeResponse);
    }
    const file = typeof body.file === "string" ? body.file : "";
    if (!file) return send(res, 400, { error: "file is required" });

    if (route === "share") {
      if (!fs.existsSync(file)) return send(res, 404, { error: `no such file: ${file}` });
      await ensureTailnetListener();
      if (!remoteBase()) {
        return send(res, 409, {
          error: "no tailnet address: Tailscale is not running here and neither AUSTERE_AXI_HOST nor AUSTERE_AXI_LINK_URL is set, so a teammate could not open the link",
        });
      }
      let inv: Invite;
      try {
        const s = store.ensure(file);
        inv = invites.add({ name: body.name, sessionId: s.id, file: s.file, auto: !!body.auto });
        watch(s);
        store.touch(s);
      } catch (err) {
        return send(res, 400, { error: String((err as Error).message || err) });
      }
      log("share", inv.name, inviteId(inv), inv.auto ? "auto" : "hold");
      return send(res, 200, { id: inviteId(inv), name: inv.name, auto: inv.auto, link: inviteLink(inv), file: inv.file } satisfies ShareResponse);
    }

    if (route === "open") {
      if (!fs.existsSync(file)) return send(res, 404, { error: `no such file: ${file}` });
      await ensureTailnetListener();
      const s = store.ensure(file);
      if (s.closedAt && !body.reopen) {
        return send(res, 200, { status: "refused", session: publicSession(s), links: links(s.id) } satisfies OpenResponse);
      }
      if (s.status === "ended") {
        if (s.endedBy === "user" && !body.reopen) {
          return send(res, 200, { status: "refused", session: publicSession(s), links: links(s.id) } satisfies OpenResponse);
        }
        store.reopen(s);
        broadcastPresence(s);
      }
      watch(s);
      store.touch(s);
      return send(res, 200, {
        status: "open",
        session: publicSession(s),
        links: links(s.id),
        browsers: clientCount(s.id),
        pending: store.unread(s).length,
        held: store.heldEntries(s).length,
      } satisfies OpenResponse);
    }

    const s = store.byFile(file);
    if (!s) return send(res, 404, { error: "no session for this file; open it first" });

    if (route === "reply") {
      const text = String(body.text || "").trim();
      if (!text) return send(res, 400, { error: "reply text is empty" });
      const acked = acknowledge(s, body, true);
      const entry = store.addAgentReply(s, text);
      s.workingSince = null;
      broadcastTranscript(s, [...acked, entry, ...s.transcript.filter((e) => e.role === "user" && e.doneAt === entry.at && !acked.includes(e))]);
      broadcastPresence(s);
      return send(res, 200, { ok: true });
    }

    if (route === "feedback") {
      // A later agent session catching up: what no agent has acted on yet.
      // Unless peeking, pending entries count as received, so a poll does not repeat them.
      const { entries, fresh } = store.feedback(s, { all: !!body.all, peek: !!body.peek });
      if (fresh.length) {
        broadcastTranscript(s, fresh);
        broadcastPresence(s);
      }
      return send(res, 200, { session: publicSession(s), entries } satisfies FeedbackResponse);
    }

    if (route === "end") {
      store.end(s, "agent");
      s.workingSince = null;
      const poll = polls.get(s.id);
      if (poll) finishPoll(s, poll, { status: "ended", endedBy: "agent" });
      broadcast(s.id, "ended", { by: "agent" });
      broadcastPresence(s);
      return send(res, 200, { ok: true });
    }

    if (route === "close") {
      closeReview(s);
      return send(res, 200, { ok: true });
    }

    if (route === "reopen") {
      store.reopen(s);
      broadcastPresence(s);
      return send(res, 200, { ok: true, session: publicSession(s) });
    }

    if (route === "poll") {
      const after = seqParam(body.after);
      const acked = acknowledge(s, body, !!body.agentReply);
      if (body.agentReply) {
        const entry = store.addAgentReply(s, String(body.agentReply).trim());
        broadcastTranscript(s, [...acked, entry, ...s.transcript.filter((e) => e.role === "user" && e.doneAt === entry.at && !acked.includes(e))]);
      } else if (acked.length) broadcastTranscript(s, acked);
      s.workingSince = null;
      const existing = polls.get(s.id);
      if (existing && !existing.done) {
        if (!body.takeover) {
          return send(res, 409, {
            status: "listener_active",
            owner: existing.owner,
            error: "another poll is already listening on this session; pass --takeover to replace it",
          } satisfies PollResponse);
        }
        finishPoll(s, existing, { status: "replaced" });
      }
      const poll: Poll = { res, owner: body.owner || null, startedAt: Date.now(), done: false, from: after ?? s.ackedSeq };
      const fresh = store.after(s, poll.from);
      // An unread note reopens an ended review (ending means the agent stopped, not that the reviewer is done):
      // one sent before the end but never acknowledged, or held and released after it. A batch sent with end
      // stays final, so only notes after the last one count; --after replays of acknowledged notes do not.
      const unread = fresh.filter((e) => e.seq > s.ackedSeq);
      const lastEnd = unread.reduce((n, e) => (e.end ? e.seq : n), 0);
      if (s.status === "ended" && !s.closedAt && unread.some((e) => !e.end && e.seq > lastEnd)) {
        store.reopen(s);
        log("reopen", s.id, "unread notes");
      }
      if (fresh.length) return deliver(s, poll);
      if (s.status === "ended") return send(res, 200, { status: "ended", endedBy: s.endedBy, closed: Boolean(s.closedAt) || undefined } satisfies PollResponse);
      polls.set(s.id, poll);
      res.on("close", () => {
        if (!poll.done) {
          poll.done = true;
          if (polls.get(s.id) === poll) polls.delete(s.id);
          clearTimeout(graceTimers.get(s.id));
          broadcastPresence(s);
        }
      });
      const timeoutMs = Number(body.timeoutMs);
      if (timeoutMs > 0) {
        setTimeout(() => {
          if (!poll.done) finishPoll(s, poll, { status: "timeout" });
        }, timeoutMs);
      }
      broadcastPresence(s);
      armGrace(s);
      return;
    }
    return send(res, 404, { error: `unknown route ${route}` });
  }

  function checkOrigin(req: http.IncomingMessage): boolean {
    const origin = req.headers.origin;
    if (!origin) return true;
    try {
      const o = new URL(origin);
      return o.host.toLowerCase() === String(req.headers.host || "").toLowerCase();
    } catch {
      return false;
    }
  }

  /** An installed pack's script, only at the version in the lockfile and only if its hash still matches. */
  function serveInstalledPack(res: http.ServerResponse, rel: string, url: URL): void {
    const m = /^installed-packs\/([^/]+)\/pack\.js$/.exec(rel);
    if (!m) return send(res, 404, "not found");
    let spec: { name: string; version: string };
    try {
      spec = splitSpec(decodeURIComponent(m[1]));
    } catch {
      return send(res, 400, "bad pack name");
    }
    const file = installedPackFile(spec.name, spec.version);
    if (!file) return send(res, 404, `pack ${spec.name}@${spec.version} is not installed (austere-axi components add ${spec.name}@${spec.version})`);
    fs.readFile(file, (err, buf) => {
      if (err) return send(res, 404, "not found");
      const actual = `sha384-${crypto.createHash("sha384").update(buf).digest("base64")}`;
      const locked = readLock().packs[spec.name]?.integrity;
      const wanted = url.searchParams.get("integrity");
      if (locked && locked !== actual) {
        log("pack-integrity", spec.name, spec.version, "file changed since install");
        return send(res, 409, `pack ${spec.name}@${spec.version} changed on disk since it was installed; add it again`);
      }
      if (wanted && wanted !== actual) {
        log("pack-integrity", spec.name, spec.version, "page pins another build");
        return send(res, 409, `the page pins another build of ${spec.name}@${spec.version}; \`austere-axi check --fix <file>\` updates it`);
      }
      res.writeHead(200, {
        "content-type": MIME[".js"],
        "content-length": buf.length,
        "cache-control": "no-cache",
        "x-content-type-options": "nosniff",
      });
      res.end(buf);
    });
  }

  function serveAsset(res: http.ServerResponse, rel: string, url: URL): void {
    if (rel.startsWith("installed-packs/")) return serveInstalledPack(res, rel, url);
    const clean = path.normalize(rel).replace(/^(\.\.[/\\])+/, "");
    const file = path.join(ASSET_DIR, clean);
    if (!file.startsWith(ASSET_DIR + path.sep)) return send(res, 404, "not found");
    fs.stat(file, (err, st) => {
      if (err || !st.isFile()) return send(res, 404, "not found");
      streamFile(res, file, {
        "content-type": MIME[path.extname(file)] || "application/octet-stream",
        "content-length": st.size,
        "cache-control": "no-cache",
        "x-content-type-options": "nosniff",
      });
    });
  }

  // Artifact responses carry their own sandbox, so the page and anything it
  // loads get an opaque origin even when opened top-level (a popup, a pasted
  // link) and never run with the owner's authority on this origin. Popups may
  // drop that sandbox so external links work from a page opened on its own:
  // in the review frame they still inherit the iframe's flags, and a popup on
  // an artifact URL gets this header again.
  const ARTIFACT_CSP = "sandbox allow-scripts allow-popups allow-popups-to-escape-sandbox allow-forms";
  /**
   * Stream a file as a 200. Headers go out only once the file has opened, so an open failure
   * (EACCES) is a 404 and a later read failure drops the connection. Without the error
   * listener either one would be an unhandled 'error' event and exit the server.
   */
  function streamFile(res: http.ServerResponse, file: string, headers: http.OutgoingHttpHeaders): void {
    const rs = fs.createReadStream(file);
    rs.once("open", () => {
      res.writeHead(200, headers);
      rs.pipe(res);
    });
    rs.once("error", (e) => {
      log("error", "file stream", String(e?.message || e));
      if (!res.headersSent) send(res, 404, "not found");
      else res.destroy();
    });
    res.once("close", () => rs.destroy());
  }

  /**
   * The artifact frame is sandboxed without `allow-same-origin`, so its opaque origin sends no
   * cookie on subresource requests: a relative `Image` src never reaches the cookie check. Instead
   * the frame's own URL carries a token, `/s/:id/a/<token>/<file>`, and relative URLs inherit it.
   * One token per viewer, derived from the owner key: a revoked invite stops working, and the token
   * opens only what `serveArtifact` serves anyway.
   */
  function assetToken(s: Session, viewer: Viewer): string {
    const who = viewer.role === "owner" ? "owner" : `invite:${viewer.token}`;
    return crypto.createHmac("sha256", ownerToken).update(`austere-axi asset\0${s.id}\0${who}`).digest("base64url");
  }

  /** Does `token` belong to the owner or to a live invite for this page? */
  function assetTokenValid(s: Session, token: string): boolean {
    let ok = safeEqual(token, assetToken(s, OWNER));
    for (const inv of invites.list()) {
      if (inv.sessionId === s.id && safeEqual(token, assetToken(s, { role: "reviewer", name: inv.name, auto: inv.auto, token: inv.token }))) ok = true;
    }
    return ok;
  }

  function serveArtifact(req: http.IncomingMessage, res: http.ServerResponse, s: Session, rest: string): void {
    const dir = path.dirname(s.file);
    const base = path.basename(s.file);
    if (rest === base || rest === "") {
      const html = readFileSafe(s.file);
      if (html == null) return send(res, 404, "artifact file is missing");
      const out = rewriteRuntime(html, `<script src="/__austere/austere.js?v=${VERSION}"></script>`);
      return send(res, 200, out, { "content-type": "text/html; charset=utf-8", "content-security-policy": ARTIFACT_CSP });
    }
    let decoded: string;
    try {
      decoded = decodeURIComponent(rest);
    } catch {
      return send(res, 400, "bad path");
    }
    const sib = resolveSibling(dir, decoded);
    if (!sib.ok) return send(res, 404, "not found");
    streamFile(res, sib.file, {
      "content-type": MIME[path.extname(sib.file).toLowerCase()] || "application/octet-stream",
      "content-length": sib.size,
      "cache-control": "no-cache",
      "x-content-type-options": "nosniff",
      "content-security-policy": ARTIFACT_CSP,
    });
  }

  function chromePage(s: Session, viewer: Viewer): string {
    const boot = {
      id: s.id,
      title: s.title,
      file: viewer.role === "owner" ? s.file : "",
      viewer: { role: viewer.role, name: viewer.name, auto: viewer.role === "reviewer" ? viewer.auto : undefined },
      name: path.basename(s.file),
      artifactUrl: `/s/${s.id}/a/${assetToken(s, viewer)}/${encodeURIComponent(path.basename(s.file))}`,
      version: VERSION,
    };
    return `<!doctype html>
<html lang="en" data-theme="dark">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="color-scheme" content="dark">
<title>${escapeHtml(s.title)} · austere</title>
<link rel="stylesheet" href="/__austere/chrome/chrome.css?v=${VERSION}">
<script>window.__AUSTERE__=${JSON.stringify(boot).replace(/</g, "\\u003c")}</script>
<script src="/__austere/chrome/chrome.js?v=${VERSION}" defer></script>
</head>
<body></body>
</html>`;
  }

  function hubHome(url: URL): string {
    const q = (url.searchParams.get("q") || "").slice(0, 200);
    const project = (url.searchParams.get("project") || "").slice(0, 1000);
    return hubPage(hub.list({ q, project }), { version: VERSION, q, project, stats: hub.stats() });
  }

  function hubNotes(url: URL): string {
    const q = (url.searchParams.get("q") || "").slice(0, 200);
    const project = (url.searchParams.get("project") || "").slice(0, 1000);
    const st = url.searchParams.get("status");
    const status = st === "unanswered" || st === "answered" ? st : "all";
    const author = (url.searchParams.get("author") || "").slice(0, 80);
    const rows = hub.notes({ q, project, author, status: status === "all" ? "" : status });
    return notesPage(rows, { version: VERSION, q, project, status, author, authors: hub.authors(), stats: hub.stats() });
  }

  /** Open an indexed artifact for review (it may never have had a session) and go to it. */
  function hubOpen(res: http.ServerResponse, id: string): void {
    const a = /^[a-f0-9]{12}$/.test(id) ? hub.artifact(id) : null;
    if (!a) return send(res, 404, "not in the hub");
    if (!fs.existsSync(a.file)) return send(res, 410, `${a.file} no longer exists`);
    const existed = store.byFile(a.file);
    const s = store.ensure(a.file);
    if (!existed) store.touch(s);
    res.writeHead(302, { location: `/s/${s.id}` });
    res.end();
  }

  function homePage(): string {
    const rows = store
      .list()
      .map(
        (s) =>
          `<li><a href="/s/${s.id}">${escapeHtml(s.title)}</a><span>${escapeHtml(s.file)}</span><em>${s.status === "ended" ? "ended" : presence(s)}</em></li>`,
      )
      .join("");
    return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>austere-axi</title>
<style>body{margin:0;background:#0b0b0d;color:#e8e8ec;font:14px/1.5 ui-sans-serif,system-ui,sans-serif}main{max-width:760px;margin:0 auto;padding:40px 20px}h1{font-size:18px;font-weight:600}ul{list-style:none;padding:0}li{display:grid;gap:2px;padding:12px 0;border-bottom:1px solid #222}a{color:#a9c1ff;text-decoration:none;font-weight:600}span{color:#8a8a94;font-size:12px;overflow-wrap:anywhere}em{color:#8a8a94;font-style:normal;font-size:12px}</style></head>
<body><main><h1>austere-axi <small style="color:#777;font-weight:400">${VERSION}</small></h1><ul>${rows || "<li>No sessions yet.</li>"}</ul></main></body></html>`;
  }

  async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<http.ServerResponse | void> {
    const url = new URL(String(req.url), "http://x");
    const host = hostOnly(req.headers.host);
    if (!hostsAllowed().has(host) && process.env.AUSTERE_AXI_ALLOWED_HOSTS !== "*") {
      return send(res, 403, "host not allowed");
    }
    if (url.pathname.startsWith("/api/")) return handleApi(req, res, url);
    if (url.pathname.startsWith("/__austere/")) return serveAsset(res, url.pathname.slice("/__austere/".length), url);
    // The owner's remote link: trade the key for the owner cookie, then drop it from the URL.
    const key = url.searchParams.get("key");
    if (key != null) {
      if (!safeEqual(key, ownerToken)) return send(res, 403, "This link is not valid.");
      return signIn(res, url, "key");
    }
    // A link from the CLI: trade the single-use login code for the owner cookie, the same way.
    const login = url.searchParams.get("login");
    if (login != null) {
      if (!logins.take(login)) return send(res, 403, "This sign-in link was used already or has expired. Run `austere-axi login` for a new one.");
      return signIn(res, url, "login");
    }
    // The hub lists every page and every note: the owner's only.
    const ownerOnly = url.pathname === "/" || url.pathname === "/notes" || url.pathname.startsWith("/hub/");
    if (ownerOnly && !isOwner(req)) return send(res, 403, notOwner(req));
    if (url.pathname === "/") {
      return send(res, 200, hubEnabled() ? hubHome(url) : homePage(), { "content-type": "text/html; charset=utf-8" });
    }
    if (hubEnabled() && url.pathname === "/notes") return send(res, 200, hubNotes(url), { "content-type": "text/html; charset=utf-8" });
    if (hubEnabled() && url.pathname.startsWith("/hub/open/")) return hubOpen(res, url.pathname.slice("/hub/open/".length));
    if (url.pathname === "/favicon.ico") return send(res, 204, "");

    const m = /^\/s\/([a-f0-9]{12})(\/.*)?$/.exec(url.pathname);
    if (!m) return send(res, 404, "not found");
    const s = store.get(m[1]);
    if (!s) return send(res, 404, "no such session");
    const sub = m[2] || "";
    activity();

    // An invite link: ask before trading the token for a cookie, so a cross-site navigation cannot
    // switch a browser (e.g. the owner's) into a reviewer identity.
    const invite = url.searchParams.get("invite");
    if (invite != null && (sub === "" || sub === "/") && req.method === "GET") {
      const inv = invites.find(invite);
      if (!inv || inv.sessionId !== s.id) return send(res, 403, "This invite link is not valid. It may have been revoked; ask for a new one.");
      return send(
        res,
        200,
        `<!doctype html><meta charset="utf-8"><title>Join review</title><form method="post" action="/s/${s.id}/join"><input type="hidden" name="invite" value="${escapeHtml(inv.token)}"><button>Continue as ${escapeHtml(inv.name)}</button></form>`,
        // "same-origin", not "no-referrer": Chrome and Firefox send `Origin: null` on a form POST under no-referrer, which the join check would refuse.
        { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "referrer-policy": "same-origin", "x-frame-options": "DENY" },
      );
    }
    if (sub === "/join" && req.method === "POST") {
      // Require a same-origin browser POST: Origin must be present and equal Host (checkOrigin alone allows a missing Origin).
      if (!req.headers.origin || !checkOrigin(req)) return send(res, 403, { error: "cross-origin request refused" });
      // The form posts application/x-www-form-urlencoded; readBody() only parses JSON, so read the small body here.
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const c of req as AsyncIterable<Buffer>) {
        size += c.length;
        if (size > 4096) return send(res, 413, "payload too large");
        chunks.push(c);
      }
      const raw = Buffer.concat(chunks).toString("utf8");
      const inv = invites.find(new URLSearchParams(raw).get("invite") || "");
      if (!inv || inv.sessionId !== s.id) return send(res, 403, "This invite link is not valid. It may have been revoked; ask for a new one.");
      res.writeHead(303, {
        location: `/s/${s.id}`,
        "set-cookie": `${COOKIE}=${inv.token}; Path=/s/${s.id}; HttpOnly; SameSite=Lax; Max-Age=2592000`,
        "cache-control": "no-store",
      });
      return res.end();
    }

    // The artifact frame's subresources carry no cookie (see assetToken); the token in the path is their credential.
    const tokened = /^\/a\/([A-Za-z0-9_-]{43})\/(.*)$/.exec(sub);
    if (tokened && (req.method === "GET" || req.method === "HEAD") && assetTokenValid(s, tokened[1])) {
      return serveArtifact(req, res, s, tokened[2]);
    }

    const who = identify(req, s);
    if (!who) {
      if (tokenFromCookie(req.headers.cookie) == null) return send(res, 403, notOwner(req, "Ask the owner for a link to this page."));
      return send(res, 403, "This invite is no longer valid. Ask for a new link.", {
        "set-cookie": `${COOKIE}=; Path=/s/${s.id}; HttpOnly; SameSite=Lax; Max-Age=0`,
      });
    }
    // Reviewers read the page and the conversation and add notes. Everything else is the owner's.
    const reviewer = who.role === "reviewer";
    if (reviewer && !(sub === "" || sub === "/" || sub.startsWith("/a/") || sub === "/events" || sub === "/transcript" || sub === "/send" || sub === "/bye")) {
      return send(res, 403, { error: "reviewers can only read the page and add notes" });
    }

    if (sub === "" || sub === "/") {
      watch(s);
      return send(res, 200, chromePage(s, who), { "content-type": "text/html; charset=utf-8" });
    }
    if (sub.startsWith("/a/")) return serveArtifact(req, res, s, sub.slice(3));

    // Older entries, a page at a time, before the entry `before`.
    if (sub === "/transcript") {
      const visible = s.transcript.filter((e) => !e.discarded && canSee(e, who));
      const before = url.searchParams.get("before");
      const end = before == null ? visible.length : Math.max(0, visible.findIndex((e) => e.id === before));
      return send(res, 200, { entries: visible.slice(Math.max(0, end - PAGE), end), more: end > PAGE });
    }

    if (sub === "/events") {
      if (reviewer) {
        const open = Array.from(clients.get(s.id) || []).filter((c): c is SseClient & { viewer: ReviewerViewer } => c.viewer.role === "reviewer");
        if (open.length >= SSE_MAX_PER_SESSION || open.filter((c) => c.viewer.token === who.token).length >= SSE_MAX_PER_REVIEWER) {
          return send(res, 429, { error: "too many event streams" });
        }
      }
      watch(s);
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-store",
        connection: "keep-alive",
        "x-accel-buffering": "no",
      });
      res.write("retry: 2000\n\n");
      const w = watchers.get(s.id);
      const visible = s.transcript.filter((e) => !e.discarded && canSee(e, who));
      const snapshot = {
        session: reviewer ? { ...publicSession(s), file: "" } : publicSession(s),
        presence: presence(s),
        transcript: visible.slice(-PAGE),
        more: visible.length > PAGE,
        revision: s.revision,
        program: w?.program ?? null,
        thirdPartyPacks: thirdPartyPacks(w?.html),
        version: VERSION,
        links: reviewer ? null : links(s.id),
      };
      res.write(`event: snapshot\ndata: ${JSON.stringify(snapshot)}\n\n`);
      const client: SseClient = { res, viewer: who };
      let set = clients.get(s.id);
      if (!set) clients.set(s.id, (set = new Set()));
      set.add(client);
      browserSeen.add(s.id);
      clearTimeout(graceTimers.get(s.id));
      graceTimers.delete(s.id);
      const hb = setInterval(() => res.write(": hb\n\n"), 20_000);
      res.on("close", () => {
        clearInterval(hb);
        clients.get(s.id)?.delete(client);
        armGrace(s);
      });
      return;
    }

    if (req.method === "POST" && !checkOrigin(req)) return send(res, 403, { error: "cross-origin request refused" });

    if (sub === "/send" && req.method === "POST") {
      const body = await readBody(req, 4 * 1024 * 1024);
      const end = !reviewer && !!body.end;
      let items: NoteItem[] = Array.isArray(body.items) ? body.items.filter((x: unknown) => x && typeof x === "object").slice(0, reviewer ? 50 : 200) : [];
      if (reviewer) items = items.filter((x) => REVIEWER_KINDS.has(x.kind)).map(reviewerItem);
      if (s.closedAt) return send(res, 409, { error: "the owner closed this review" });
      if (!items.length && !end) return send(res, 400, { error: "nothing to send" });
      // The server decides who wrote a note. A reviewer's own item id could overwrite another note in the hub.
      for (const it of items) {
        delete it.author;
        it.id = reviewer || !it.id ? newId("i") : it.id;
      }
      const hold = reviewer && !who.auto;
      if (hold && items.length && store.heldEntries(s).filter((e) => e.author === who.name).length >= MAX_HELD_PER_REVIEWER) return send(res, 429, { error: "too many notes awaiting the owner; wait for them to be released" });
      let entry: UserEntry | null = null;
      if (items.length) entry = store.addUserBatch(s, items, { end, author: who.name, hold });
      if (end) {
        store.end(s, "user");
        broadcast(s.id, "ended", { by: "user" });
      }
      if (entry) broadcastTranscript(s, [entry]);
      if (end) {
        const poll = polls.get(s.id);
        if (poll && !poll.done && !store.after(s, poll.from).length) finishPoll(s, poll, { status: "ended", endedBy: "user" });
      }
      wake(s);
      broadcastPresence(s);
      return send(res, 200, { ok: true, entry });
    }
    if (sub === "/render-errors" && req.method === "POST") {
      const body = await readBody(req);
      // A report for an older revision describes a program the agent has already replaced.
      if (s.closedAt || body.revision !== s.revision) return send(res, 200, { ok: true, count: 0, stale: true });
      // Third-party pack code runs in the frame and could forge errors; those wait for the owner's "Queue fix".
      if (thirdPartyPacks(watchers.get(s.id)?.html).length) return send(res, 409, { error: "this page uses third-party packs; queue render errors by hand" });
      let seen = renderReported.get(s.id);
      if (!seen || seen.revision !== s.revision) renderReported.set(s.id, (seen = { revision: s.revision, keys: new Set() }));
      const items = [];
      for (const e of Array.isArray(body.errors) ? body.errors.slice(0, MAX_RENDER_ERRORS) : []) {
        if (!e || typeof e !== "object" || typeof e.message !== "string" || !e.message) continue;
        const statement = typeof e.statement === "string" ? e.statement.slice(0, 200) : "";
        const message = e.message.slice(0, 1000);
        const key = `${statement}\n${message}`;
        if (seen.keys.has(key)) continue;
        seen.keys.add(key);
        items.push({ kind: "render-error", statement: statement || undefined, target: statement || undefined, message, note: "Reported when the page rendered." });
      }
      if (!items.length) return send(res, 200, { ok: true, count: 0 });
      const entry = store.addUserBatch(s, items, { author: RENDER_CHECK_AUTHOR });
      broadcastTranscript(s, [entry]);
      wake(s);
      broadcastPresence(s);
      return send(res, 200, { ok: true, count: items.length });
    }
    if ((sub === "/release" || sub === "/discard") && req.method === "POST") {
      const body = await readBody(req);
      const ids: string[] | null = Array.isArray(body.ids) ? body.ids.map(String) : sub === "/discard" && body.all ? null : [];
      const done = sub === "/release" ? store.release(s, ids) : store.discard(s, ids);
      if (done.length) broadcastTranscript(s, done);
      if (sub === "/release") wake(s);
      broadcastPresence(s);
      return send(res, 200, { ok: true, count: done.length });
    }
    if (sub === "/end" && req.method === "POST") {
      if (s.status !== "ended") {
        store.end(s, "user");
        broadcast(s.id, "ended", { by: "user" });
        const poll = polls.get(s.id);
        if (poll && !poll.done && !store.after(s, poll.from).length) finishPoll(s, poll, { status: "ended", endedBy: "user" });
        wake(s);
        broadcastPresence(s);
      }
      return send(res, 200, { ok: true });
    }
    if (sub === "/close" && req.method === "POST") {
      if (!s.closedAt) closeReview(s);
      return send(res, 200, { ok: true });
    }
    if (sub === "/reopen" && req.method === "POST") {
      if (s.closedAt || s.status === "ended") {
        store.reopen(s);
        broadcastPresence(s);
      }
      return send(res, 200, { ok: true });
    }
    if (sub === "/bye" && req.method === "POST") {
      byeAt.set(s.id, Date.now());
      return send(res, 204, "");
    }
    if (sub === "/export") {
      const html = readFileSafe(s.file);
      if (html == null) return send(res, 404, "artifact file is missing");
      try {
        const out = exportHtml(html, path.dirname(s.file));
        const name = path.basename(s.file).replace(/\.html?$/i, "") + ".export.html";
        return send(res, 200, out.html, {
          "content-type": "text/html; charset=utf-8",
          "content-disposition": `attachment; filename="${name.replace(/"/g, "")}"`,
          "content-security-policy": ARTIFACT_CSP,
        });
      } catch (err) {
        return send(res, 500, String((err as Error).message || err));
      }
    }
    return send(res, 404, "not found");
  }

  // ── listening ──

  function listen(host: string): Promise<boolean> {
    return new Promise((resolve) => {
      if (listeners.has(host)) return resolve(true);
      const server = http.createServer((req, res) => {
        handle(req, res).catch((err: HttpError) => {
          log("error", req.method, String(req.url).split("?")[0].replace(/\/a\/[\w-]{43}\//, "/a/…/"), String(err?.stack || err));
          if (!res.headersSent) send(res, err.status || 500, { error: err.status ? String(err.message) : "internal error" });
          else res.end();
        });
      });
      server.keepAliveTimeout = 65_000;
      server.requestTimeout = 0;
      server.headersTimeout = 60_000;
      server.once("error", (err) => {
        log("listen-failed", host, (err as NodeJS.ErrnoException).code || err.message);
        resolve(false);
      });
      server.listen(port, host, () => {
        listeners.set(host, server);
        log("listening", `${host}:${port}`);
        resolve(true);
      });
    });
  }

  async function ensureTailnetListener(): Promise<void> {
    const explicit = process.env.AUSTERE_AXI_HOST;
    if (explicit && !/^(0\.0\.0\.0|::|\*)$/.test(explicit)) {
      await listen(explicit);
      return;
    }
    tailnet = await detectTailscale();
    if (tailnet && !listeners.has(tailnet.ip)) await listen(tailnet.ip);
  }

  const ok = await listen("127.0.0.1");
  if (!ok) {
    store.close();
    releaseLock();
    throw new Error(`could not listen on 127.0.0.1:${port} (is another server using it? set AUSTERE_AXI_PORT)`);
  }
  for (const h of alsoListen) await listen(h);
  await ensureTailnetListener();

  let stopping = false;
  function shutdown(reason: string): void {
    if (stopping) return;
    stopping = true;
    log("shutdown", reason);
    for (const [id, set] of clients) {
      for (const c of set) {
        c.res.write(`event: server\ndata: ${JSON.stringify({ state: "stopped", reason })}\n\n`);
        c.res.end();
      }
      clients.delete(id);
    }
    for (const [id, poll] of polls) {
      const s = store.get(id);
      if (s && !poll.done) finishPoll(s, poll, { status: "interrupted", reason });
    }
    for (const id of watchers.keys()) unwatch(id);
    for (const server of listeners.values()) server.close();
    // Everything is already on disk; let a replacement server take the state dir at once.
    releaseLock();
    setTimeout(() => {
      store.close();
      process.exit(0);
    }, 100).unref();
  }

  if (idleMs > 0) {
    setInterval(() => {
      const busy = polls.size > 0 || Array.from(clients.values()).some((set) => set.size > 0);
      if (busy) activity();
      else if (Date.now() - lastActivity > idleMs) shutdown("idle");
    }, Math.min(60_000, idleMs)).unref();
  }
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  log("started", `v${VERSION}`, `pid=${process.pid}`);
  return { port, shutdown };
}
