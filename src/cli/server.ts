// Local review server. One per machine (per port), shared by every session.
//   /api/*        control routes for the CLI (loopback only)
//   /s/:id        review page (chrome) for a session
//   /s/:id/a/...  the artifact and its sibling assets, runtime tag pointed here
//   /s/:id/events server-sent events for the chrome
//   /__austere/*  runtime, bundled packs, chrome assets
//   /__austere/installed-packs/<name@version>/pack.js  packs from `components add`
import { spawn } from "node:child_process";
import { resolveSibling } from "./assets.ts";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { readArtifact, replaceProgram, rewriteRuntime, escapeHtml } from "./artifact.ts";
import { agentPrompt } from "./agent-prompt.ts";
import { cloudUrl, readCloud } from "./cloud.ts";
import { exportHtml } from "./export.ts";
import { addressSettings, allowedHosts, detectTailscale, hostOnly, isLoopback, lanAddresses, linkUrl, whoIs } from "./net.ts";
import type { AddressSettings, Tailnet, TailscalePerson } from "./net.ts";
import { ASSET_DIR, VERSION, canonicalFile, msEnv, stateDir, versionGt } from "./paths.ts";
import { RENDER_CHECK_AUTHOR, SessionStore, newId, sessionId } from "./sessions.ts";
import type { FeedbackEntry, NoteItem, QueuedEntry, Session, TranscriptEntry, UserEntry } from "./sessions.ts";
import { lockStateDir } from "./lock.ts";
import { listSessions, liveness, parseCallerReport, registerSession, shortId } from "./agent-sessions.ts";
import type { CallerReport, SessionAction } from "./agent-sessions.ts";
import type { Liveness } from "./caller.ts";
import { detectUnit } from "./service.ts";
import type { ServerUnit, Supervisor } from "./service.ts";
import { installedPackFile, pagePacks, readLock } from "./packs.ts";
import { Hub, activeWorkNow } from "./hub.ts";
import { statementMap } from "../shared/statements.ts";
import type { ArchivePlan } from "./hub.ts";
import { agentLabel, headRev, recordRevision, restoredProgram, revisionAt, revisionLog, setViewedRev, similarPages, statementVersions, viewedRev } from "./history.ts";
import type { RevisionRow } from "./history.ts";
import { Dispatcher, getRun, listRuns, logTail, summary } from "./dispatch.ts";
import { TriggerScheduler, readTriggers } from "./triggers.ts";
import type { RunEvent, RunSummary } from "./dispatch.ts";
import { AttachRefused, attachReport, authorOf, autoConflict, changeSetting, effectiveAttach, harnessInfos, isAttachMode, resolveSessionValue, scopeIds } from "./attach.ts";
import type { AttachFields, AttachSettingRow, AttachState, AttachWhere, EffectiveAttach, HarnessInfo, LiveAuto } from "./attach.ts";
import { adapterFor, findOnPath, spawnSpec } from "./adapters/index.ts";
import { readAdapters } from "./adapters/config.ts";
import type { AdaptersConfig } from "./adapters/config.ts";
import type { AttachMode } from "./adapters/types.ts";
import { copyLabel, findProject, findRoot, forgetRoot, listProjects, mergeProjects, renameProject } from "./projects.ts";
import type { ProjectRow } from "./projects.ts";
import { COOKIE, LoginCodes, OWNER_COOKIE, cleanName, ownerCookie, ownerKey, reviewerCookies, safeEqual, tokenFromCookie } from "./invites.ts";
import { DeviceStore, covers, isLive } from "./devices.ts";
import type { DeviceOrigin, DeviceRow, Scope, ScopeKind, SeenMeta } from "./devices.ts";
import { RequestRefused, RequestStore, describeAgent } from "./requests.ts";
import type { AccessRequestRow, RequestStatus } from "./requests.ts";
import dns from "node:dns";
import { reviewerItem } from "./items.ts";
import { missingPage } from "./hub-page.ts";
import { copiesToFlip, copySummary, shellInbox, shellPages, shellProjects, shellRuns, shellSearch } from "./hub-api.ts";
import type { ArchiveResult, CopySummary, InboxResponse, LocalNetwork, NotesResponse, PagesResponse, PagesView, ProjectActionResult, ProjectsResponse, HubRunsResponse, SearchResponse, SettingsResponse } from "../shared/hub-api.ts";
import { splitSpec } from "../shared/packs-meta.ts";
import { Peer } from "./peer.ts";
import { parseClientFrame } from "../shared/sync.ts";
import type { ServerPresence } from "../shared/sync.ts";
import crypto from "node:crypto";
import zlib from "node:zlib";

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
  /** The local-network address Settings switched on (RLM-399): a CLI that replaces this server leaves it out of --also-listen, as the new one reads the setting itself. */
  lan?: string;
  tailnet?: Tailnet;
  remote?: string;
  persist: boolean;
  /** The service manager that runs this server (`server install`); a CLI never replaces it. */
  supervised?: Supervisor;
  /** The unit that runs it (a systemd unit, a launchd label), for the hint that restarts it. Missing before 0.12. */
  unit?: string;
  /** The address variables it runs with, kept by a CLI that replaces it. Missing before 0.12. */
  addresses?: AddressSettings;
}

/** Whether an agent listens on a session, works on its notes, took them and has gone quiet for STALE_WORKING_MS, or none of these. */
export type Presence = "listening" | "working" | "stale" | "idle";

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
  /** The owner archived the page: the composer is locked. */
  archived: boolean;
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
export interface OpenResponse {
  session: PublicSession;
  links: SessionLinks;
  browsers: number;
  pending: number;
  held: number;
  /** The page's project: `ref` names it for `--project` (its name, or its id when another project has that name); `here`: the folder the CLI ran in (`cwd`) is in the page's checkout (root), so a bare poll there covers it. */
  project?: { name: string; ref: string; here: boolean };
  /** A first open: up to 3 pages of the project that read like this one, newest first. */
  similar?: { title: string | null; file: string; updatedAt: number }[];
}

/**
 * /api/poll, and how a listening poll ends. `replaced`: a newer poll of the same scope (this page, this checkout or the whole project) took over. `interrupted`: the server stopped.
 * `moved`: a shared poll's project (or, for a checkout's poll, its root) is gone, its pages taken into another one (a guessed folder above them, `project merge`).
 * `archived`: the page is archived and nothing is left to deliver, so a poll on it would wait for nothing.
 */
export interface PollResponse {
  status: "feedback" | "timeout" | "replaced" | "interrupted" | "moved" | "archived";
  /** feedback: the notes' items, and the cursor that acknowledges them */
  items?: NoteItem[];
  /** feedback: the highest seq in the answer (a project poll's cursor covers every page). */
  cursor?: number;
  /** feedback: the reviewer pressed Done or Send & finish on the newest batch; the agent stops listening after applying it */
  final?: true;
  /** A project poll's answer: the project, and one batch per page with notes. `items` and `final` are then per batch. */
  project?: string;
  batches?: PollBatch[];
  /** interrupted: why the server stopped */
  reason?: string;
  error?: string;
}

/** The notes of one page in a project poll's answer. `copy` is the label of the page's root (its branch, else its folder). */
export interface PollBatch {
  file: string;
  copy: string;
  items: NoteItem[];
  final?: true;
}

/** /api/feedback. */
export interface FeedbackResponse {
  session: PublicSession;
  entries: FeedbackEntry[];
}

/** /api/feedback for a project: the pages that have notes. */
export interface ProjectFeedbackResponse {
  project: string;
  /** `missing`: the file is gone; its notes are still here. */
  batches: { file: string; copy: string; archived: boolean; missing?: boolean; entries: FeedbackEntry[] }[];
}

/** /api/archive with `missing`: the copies put away, with the notes no agent had answered on each. */
export interface ArchiveMissingResponse {
  ok: boolean;
  copies: { id: string; file: string; unanswered: number }[];
}

/** /api/archive with a file, and `/s/:id/archive`: the copies archived and the copies of the page that stay open. */
export interface ArchiveResponse extends ArchivePlan {
  ok: true;
}

/** /api/share and the review page's Share: the new link. */
export interface ShareResponse {
  id: string;
  name: string;
  auto: boolean;
  scope: ScopeKind;
  /** What the scope reaches, in words: the page's file, the project's name, or "every page". */
  reaches: string;
  link: string;
  file: string;
  expiresAt: number;
}

/** One link (nobody has claimed it yet) or device in /api/share/list and /hub/api/people. */
export interface AccessSummary {
  id: string;
  name: string;
  /** How it came in: a link, an approved request, or Tailscale. */
  origin: DeviceOrigin;
  scope: ScopeKind;
  /** The page's artifact id, or the project's id; null for every page. */
  scopeId: string | null;
  reaches: string;
  auto: boolean;
  createdAt: number;
  /** An old-style link from invites.json: any number of browsers can open it, and it does not expire. */
  reusable: boolean;
  /** Links only: when the link stops working if nobody claims it (null: an old-style link). */
  expiresAt: number | null;
  /** Devices only. */
  claimedAt: number | null;
  lastSeenAt: number | null;
  lastAddr: string | null;
  lastHost: string | null;
  userAgent: string | null;
  /** The Tailscale login this device or person is: given by the owner (origin tailscale), or the first one Tailscale named behind its cookie. Null: never seen over Tailscale. */
  verifiedLogin: string | null;
  /** Links only, when asked for (`?links=1`, and always in /hub/api/people). */
  link?: string;
}

/** /api/share/list and GET /hub/api/people: links nobody has claimed yet, and devices. Revoked and expired ones are left out. */
export interface ShareListResponse {
  links: AccessSummary[];
  devices: AccessSummary[];
}

/** /api/share/revoke and POST /hub/api/people/<id>/revoke. */
export interface RevokeResponse {
  revoked: { id: string; name: string; kind: "link" | "device" }[];
}

/** One access request in /api/share/requests and GET /hub/api/people/requests (RLM-398). */
export interface AccessRequestSummary {
  id: string;
  /** The name the browser typed. */
  name: string;
  status: RequestStatus;
  /** The page it asked from (artifact id), its file, and its project; null when the page is gone from the hub. */
  page: string;
  file: string | null;
  project: { id: string; name: string } | null;
  /** What the server saw: the address, its hostname (reverse lookup, best effort), the User-Agent and, in words, its browser and system. */
  addr: string | null;
  host: string | null;
  userAgent: string | null;
  browser: string;
  /** The Tailscale login and device when it came over Tailscale (RLM-399); null until then. */
  verifiedLogin: string | null;
  tailscaleDevice: string | null;
  createdAt: number;
  decidedAt: number | null;
}

/** Where browsers may ask for access: every page or not, and the projects whose own setting differs (it wins). Off everywhere by default. */
export interface RequestSwitchResponse {
  all: boolean;
  projects: { id: string; name: string; on: boolean }[];
}

/** /api/share/requests and GET /hub/api/people/requests: requests waiting for the owner (the oldest first), blocked ones, and the switch. */
export interface AccessRequestsResponse {
  waiting: AccessRequestSummary[];
  blocked: AccessRequestSummary[];
  switch: RequestSwitchResponse;
}

/** Approve, deny or block: the request as it is now and, for an approval, the device it made. */
export interface RequestDecisionResponse {
  request: AccessRequestSummary;
  device?: AccessSummary;
}

/** /api/login. */
export interface LoginResponse {
  code: string;
  ttlMs: number;
}

/** /api/run/stop and /s/:id/run/stop: how many runs of the page ended (RLM-345). */
export interface RunStopResponse {
  ok: true;
  stopped: number;
}

/** GET /s/:id/runs (RLM-346): the page's runs, the newest first. */
export interface RunsResponse {
  runs: RunSummary[];
}

/** GET /s/:id/run/:runId/log: the last lines of a run's log. */
export interface RunLogResponse {
  run: RunSummary;
  tail: string[];
}

/** GET /s/:id/attach (RLM-346): what the owner's attach popover shows. */
export interface AttachInfo {
  effective: EffectiveAttach;
  /** The page's own row (shared by every copy, A19), and the project's. */
  page: AttachSettingRow | null;
  project: { id: string; name: string; setting: AttachSettingRow | null } | null;
  /** Where a run would go now; `session` is the short id of the session it resumes or forks, null for a new one. */
  target: { mode: AttachMode; harness: string; session: string | null };
  /** The page's author session, which `author` resolves to (Q11). */
  author: { id: string; harness: string; short: string } | null;
  /** The agent sessions registered for this copy (RLM-343). */
  sessions: { id: string; harness: string; short: string; roles: string[]; lastSeen: number; liveness: Liveness }[];
  /** Every adapter by name; omp's model list when `omp models` answered in time. */
  harnesses: Record<string, HarnessInfo & { models?: string[] }>;
  run: RunSummary | null;
  /** The size of the session file a same or fork run resends, when known. */
  sessionFileSize: number | null;
  warnings: string[];
  auto: string | null;
}

/** How many lines of a run's log "View log" shows. */
const LOG_TAIL_LINES = 200;

/** The chat model selectors in `omp models --json` output (`{ models: [{ selector, kind }] }`), or null. */
function modelSelectors(json: string): string[] | null {
  let data: unknown;
  try {
    data = JSON.parse(json);
  } catch {
    return null;
  }
  if (!data || typeof data !== "object" || !("models" in data) || !Array.isArray(data.models)) return null;
  const names: string[] = [];
  for (const m of data.models as unknown[]) {
    if (!m || typeof m !== "object" || !("selector" in m) || typeof m.selector !== "string" || m.selector.length > 200) continue;
    if ("kind" in m && m.kind !== "chat") continue;
    names.push(m.selector);
    if (names.length >= 500) break;
  }
  return names.length ? names : null;
}

/** Who is asking for a page: the owner, or a team reviewer on a live device whose scope reaches the page. */
type OwnerViewer = { role: "owner"; name: string };
/** `credential` is the device's current `secret_hash`: the frame's asset token is bound to it, so a replaced secret kills old tokens. */
type ReviewerViewer = { role: "reviewer"; name: string; auto: boolean; deviceId: string; credential: string };
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
  startedAt: number;
  done: boolean;
  /** A page poll's read point. */
  from: number;
  /** A shared poll: the project it listens for and, for a checkout's poll, that root (none: every root of the project); `--after` (null: each page's own cursor). */
  project?: string;
  root?: string;
  after?: number | null;
  /** A shared poll's refresh of its pages' hosted connections (membership can change under it: `project merge`). */
  refresh?: ReturnType<typeof setInterval>;
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

/** Whether AUSTERE_AXI_PERSIST asks the server to stay up with no one using it. */
export function persistEnv() {
  return /^(1|true|yes)$/i.test(process.env.AUSTERE_AXI_PERSIST || "");
}

/** How long a login code from `austere-axi login` (or the CLI opening a browser) works. */
const LOGIN_TTL_MS = 60_000;
// A device's cookie lasts as long as browsers allow (400 days); the owner ends it by revoking the device.
const DEVICE_COOKIE_MAX_AGE = 400 * 86_400;
const LINK_INVALID = "This link is not valid. It may have been revoked; ask for a new one.";
const LINK_USED = "This link was already used on another device. Each link opens on one device only; ask the owner for a new one.";
const LINK_EXPIRED = "This link expired before anyone opened it. Ask the owner for a new one.";
/** Why the owner cannot sign in on the local-network listener (P7). */
const LAN_NO_OWNER = "The owner does not sign in over the local network: its traffic is not encrypted. Use this computer, Tailscale or HTTPS.";
// A browser that asked for access (RLM-398) holds its request's pending secret here until the owner decides.
const REQUEST_COOKIE = "austere_rq";
const REQUEST_COOKIE_MAX_AGE = 30 * 86_400;
// How often the waiting page asks whether the owner has decided.
const REQUEST_POLL_MS = 2000;
const OWNER: OwnerViewer = Object.freeze({ role: "owner", name: "" });
const REVIEWER_KINDS = new Set<unknown>(["annotation", "message"]);
// Render failures the owner's page reports on its own reach the agent as notes from RENDER_CHECK_AUTHOR.
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
// How often a waiting project poll re-reads which pages it covers, to keep their hosted connections right.
const PROJECT_REFRESH_MS = 30_000;
// How long a page poll's unacknowledged batch keeps its page out of the project poll. An agent that never acknowledges loses the page after this.
const PAGE_HOLD_MS = 10 * 60_000;
/**
 * How long an agent that took a page's notes may go without a sign of life (a reply, a poll, a change to the
 * file) before the page says `stale`: "took your notes N min ago, no reply yet". As long as the page hold, so a
 * stale page is also one the project poll may take back. AUSTERE_AXI_STALE_WORKING_MS overrides it (tests).
 */
export const STALE_WORKING_MS = 10 * 60_000;
// The longest delay setTimeout takes: a larger one fires after 1 ms and warns. A longer wait is armed in several steps.
const MAX_TIMER_MS = 2 ** 31 - 1;

/** Whether triggers.json names a trigger: the server stays up to run it. A file that cannot be read counts as none. */
function triggersConfigured(): boolean {
  try {
    return readTriggers().length > 0;
  } catch {
    return false;
  }
}

export async function runServer({
  port,
  verbose = false,
  alsoListen = [],
  persist = false,
  unit,
}: {
  port: number;
  verbose?: boolean;
  alsoListen?: string[];
  persist?: boolean;
  /** The unit that runs this server; null: none does. Read from the system when it is not given. */
  unit?: ServerUnit | null;
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
  // the port, so a later process can tell this server from an unrelated one with its pid,
  // and the unit, so `server install` can tell a server it started from one it did not.
  // Who runs this server: a systemd or launchd unit, when one does. A supervised server is the
  // unit's, so a CLI never replaces it (RLM-311).
  const runBy: ServerUnit | null = unit === undefined ? detectUnit() : unit;
  const supervisorName: Supervisor | null = runBy?.supervisor ?? null;
  const releaseLock = await lockStateDir(stateDir(), { port, wait: 3000, unit: runBy });
  process.on("exit", releaseLock);
  let store: SessionStore;
  try {
    store = await SessionStore.open(stateDir());
  } catch (err) {
    releaseLock();
    throw err;
  }
  // The owner's pages over the same database: the hub, at `/`.
  const hub = new Hub(store.db);
  const devices = new DeviceStore(store.db);
  const requests = new RequestStore(store.db);
  const ownerToken = ownerKey(stateDir());
  const ownerCookieValue = ownerCookie(ownerToken);
  const logins = new LoginCodes(LOGIN_TTL_MS);
  const clients = new Map<string, Set<SseClient>>(); // id -> Set<{res, viewer}>
  const polls = new Map<string, Poll>(); // page id -> its poll
  const rootPolls = new Map<string, Poll>(); // root folder -> its checkout's poll
  const projectPolls = new Map<string, Poll>(); // project id -> its poll over every root
  const watchers = new Map<string, Watcher>(); // id -> { html, program, shell }
  const listeners = new Map<string, http.Server>(); // host -> http.Server
  // Hosted pages in cloud.json: their notes come in, the owner's Send/Discard and the agent's replies go out.
  const peer = new Peer({
    store,
    log,
    listening: (s) => Boolean(listener(s)),
    changed: (s, entries) => {
      broadcastTranscript(s, entries);
      // A hosted note that arrived released (or was released on another machine) is the owner's (RLM-345).
      wakeOrRun(s, entries.some((e) => e.role === "user" && e.seq != null && !e.held && !e.discarded && !e.doneAt));
      broadcastPresence(s);
    },
    viewing: (s) => Array.from(clients.get(s.id) || []).some((c) => c.viewer.role === "owner"),
    relay: (s, frame) => {
      for (const c of Array.from(clients.get(s.id) || [])) if (c.viewer.role === "owner") sseWrite(clients.get(s.id) as Set<SseClient>, c, viewerEvent(frame));
    },
  });
  const liveAuto: LiveAuto = (pageId, fallback) => peer.liveAuto(pageId, fallback);
  // Attached agents (RLM-345): a note the owner sent or released starts a run when no poll holds the page.
  const dispatcher = new Dispatcher({
    db: store.db,
    store,
    port,
    log,
    listening: (s) => Boolean(listener(s)),
    // The page row the last pull cached counts too: --auto may have been turned on elsewhere since; either saying auto refuses.
    autoConflict: (s) => autoConflict(store.db, s.file, s.id, liveAuto),
    emit: (id, event) => broadcastOwners(id, "run", event),
  });
  // Activity triggers (RLM-360): a command the owner named at a terminal runs once a project has gone quiet.
  const triggers = new TriggerScheduler({ db: store.db, port, log, pollMs: msEnv("AUSTERE_AXI_TRIGGER_POLL_MS", 15_000) });
  // Render errors already sent per session, for one revision; a repeat or a second tab adds nothing.
  const renderReported = new Map<string, { revision: number; keys: Set<string> }>();
  let tailnet: Tailnet | null = null;
  const linkBase = linkUrl(); // throws on a bad AUSTERE_AXI_LINK_URL: better to stop here than print wrong links
  let lastActivity = Date.now();
  /** The newest CLI version that called this server, when it is newer than the server (Settings → About). */
  let newestCli: string | null = null;
  // A supervised server is always on: its supervisor decides when it stops.
  const idleMs = persist || persistEnv() || supervisorName ? 0 : msEnv("AUSTERE_AXI_IDLE_TIMEOUT_MS", 30 * 60_000);
  const pageHoldMs = msEnv("AUSTERE_AXI_PAGE_HOLD_MS", PAGE_HOLD_MS);
  const staleWorkingMs = msEnv("AUSTERE_AXI_STALE_WORKING_MS", STALE_WORKING_MS);
  // Per page: the timer that tells its open review pages when a quiet agent turns stale.
  const staleTimers = new Map<string, NodeJS.Timeout>();
  /**
   * The local-network address Settings → Network switched on, while the server listens there (RLM-399).
   * That listener serves reviewers only: no owner sign-in, cookie or link works on it (P7).
   */
  let lanHost: string | null = null;
  /** The address each accepted connection's listener is bound to: the listener a request came in on, never what the request says. */
  const boundHost = new WeakMap<net.Socket, string>();

  const activity = () => {
    lastActivity = Date.now();
  };

  /**
   * The listener a request came in on: this computer (loopback), the tailnet address, the local
   * network one Settings switched on, or one added at a terminal (`AUSTERE_AXI_HOST`, `--also-listen`).
   * A socket of no known listener counts as the local network, the strictest.
   */
  function via(req: http.IncomingMessage): "loopback" | "tailnet" | "lan" | "added" {
    const host = boundHost.get(req.socket);
    if (host === undefined || host === lanHost) return "lan";
    if (host === tailnetBound) return "tailnet";
    return host === "127.0.0.1" ? "loopback" : "added";
  }

  /** `http://host:port` for a listener's address. */
  function hostUrl(host: string): string {
    return `http://${host.includes(":") ? `[${host}]` : host}:${port}`;
  }

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
    // Never the local-network listener: the owner's remote link must not point there (P7).
    if (explicit && !/^(0\.0\.0\.0|::|\*)$/.test(explicit) && explicit !== lanHost && listeners.has(explicit)) return explicit;
    return null;
  }

  /** Where the owner's phone reaches this server, without a trailing slash, or null when only loopback listens. Never the local-network listener. */
  function remoteBase(): string | null {
    if (linkBase) return linkBase.base;
    const host = remoteHost();
    return host ? `http://${host}:${port}` : null;
  }

  /** Where a teammate reaches this server: as the owner's phone does, else the local-network address Settings switched on. Null: only loopback listens. */
  function reviewerBase(): string | null {
    return remoteBase() ?? (lanHost ? hostUrl(lanHost) : null);
  }

  /**
   * The owner's links. The remote one carries the owner key, which the server swaps for a cookie; it
   * never points at the local-network listener (remoteBase). The local one does not: the CLI opens it
   * with a single-use login code (client.ts loginUrl).
   */
  function links(id: string): SessionLinks {
    const out: SessionLinks = { local: `http://127.0.0.1:${port}/s/${id}` };
    const base = remoteBase();
    if (base) out.remote = `${base}/s/${id}?key=${ownerToken}`;
    return out;
  }

  /** The link a teammate opens: the page plus the link token, which the server swaps for a device secret. Null when only loopback listens. */
  function shareLink(sessionId: string, token: string): string | null {
    const base = reviewerBase();
    return base ? `${base}/s/${sessionId}?invite=${token}` : null;
  }

  /** What a row's scope reaches, in words. */
  function reachesText(row: Pick<DeviceRow, "scope_kind" | "scope_id">): string {
    if (row.scope_kind === "all") return "every page";
    if (row.scope_kind === "project") return `project ${(row.scope_id && findProject(hub.db, row.scope_id, { folders: false })?.name) || row.scope_id}`;
    return (row.scope_id && hub.artifact(row.scope_id)?.file) || String(row.scope_id);
  }

  function accessSummary(row: DeviceRow, withLink: boolean): AccessSummary {
    const landing = withLink && row.claimed_at == null ? row.link_page : null;
    return {
      id: row.id,
      name: row.name,
      origin: row.origin,
      scope: row.scope_kind,
      scopeId: row.scope_id,
      reaches: reachesText(row),
      auto: Boolean(row.auto),
      createdAt: row.created_at,
      reusable: Boolean(row.reusable),
      expiresAt: row.claimed_at == null ? row.link_expires_at : null,
      claimedAt: row.claimed_at,
      lastSeenAt: row.last_seen_at,
      lastAddr: row.last_addr,
      lastHost: row.last_host,
      userAgent: row.user_agent,
      verifiedLogin: row.verified_login,
      link: landing && row.link_token ? (shareLink(landing, row.link_token) ?? undefined) : undefined,
    };
  }

  /** Live links nobody has claimed (old-style links among them), and live devices. */
  function accessList(withLinks: boolean): ShareListResponse {
    const live = devices.list().filter((r) => isLive(r));
    return {
      links: live.filter((r) => r.claimed_at == null).map((r) => accessSummary(r, withLinks)),
      devices: live.filter((r) => r.claimed_at != null).map((r) => accessSummary(r, false)),
    };
  }

  /**
   * The scope a share or a scope change asks for, from `scope` ("page", "project" or "all") and, for
   * a project, the project the page `s` is in (`project`, when given, must name that one). A string is the error.
   */
  function scopeFor(s: Session, body: RequestBody): Scope | string {
    const kind = body.scope ?? "page";
    if (kind === "page") return { kind, id: s.id };
    if (kind === "all") return { kind, id: null };
    if (kind !== "project") return "scope must be page, project or all";
    const pid = store.projectIdOf(s);
    if (!pid) return `${s.file} is in no project, so it cannot be shared by project`;
    if (typeof body.project === "string" && body.project) {
      let named: ProjectRow | null = null;
      try {
        named = findProject(hub.db, body.project, { folders: path.isAbsolute(body.project) });
      } catch (err) {
        return (err as Error).message;
      }
      if (!named) return `no project ${body.project}`;
      if (named.id !== pid) return `${s.file} is not in project ${named.name}`;
    }
    return { kind, id: pid };
  }

  /**
   * Whether a new link or approval sends its notes straight to the agent: `asked` when the owner said
   * (true or false), else the owner's default (Settings → Review defaults). Auto and attach exclude each
   * other (Q3): asked for, that is the error; from the default, the notes are held instead.
   */
  function shareAuto(asked: unknown, scope: Scope): boolean | string {
    const explicit = typeof asked === "boolean";
    const auto = explicit ? asked : requests.defaultAuto();
    if (!auto) return false;
    const refused = autoAttachConflict(scope);
    return !refused ? true : explicit ? refused : false;
  }

  /** A new link for the page `s`, from the CLI or the review page's Share. An HTTP error, or the link. */
  async function createShare(s: Session, body: RequestBody): Promise<{ status: number; error: string } | ShareResponse> {
    await ensureTailnetListener();
    if (!reviewerBase()) {
      return { status: 409, error: "no address a teammate can reach: Tailscale is not running here, the local network is off (Settings → Network), and neither AUSTERE_AXI_HOST nor AUSTERE_AXI_LINK_URL is set, so a teammate could not open the link" };
    }
    const scope = scopeFor(s, body);
    if (typeof scope === "string") return { status: 400, error: scope };
    const auto = shareAuto(body.auto, scope);
    if (typeof auto === "string") return { status: 409, error: auto };
    let expiresAt: number | undefined;
    if (body.expiresAt !== undefined && body.expiresAt !== null) {
      if (typeof body.expiresAt !== "number" || !Number.isFinite(body.expiresAt) || body.expiresAt <= Date.now()) return { status: 400, error: "expiresAt must be a time in the future (epoch ms)" };
      expiresAt = body.expiresAt;
    }
    let made: { row: DeviceRow; token: string };
    try {
      made = devices.createLink({ name: body.name, scope, page: s.id, auto, expiresAt });
    } catch (err) {
      return { status: 400, error: String((err as Error).message || err) };
    }
    watch(s);
    rescanSharedPolls();
    store.touch(s);
    log("share", made.row.name, made.row.id, made.row.scope_kind, made.row.auto ? "auto" : "hold");
    const { row } = made;
    return { id: row.id, name: row.name, auto: Boolean(row.auto), scope: row.scope_kind, reaches: reachesText(row), link: shareLink(s.id, made.token) as string, file: s.file, expiresAt: row.link_expires_at as number };
  }

  /**
   * Let a Tailscale login in without a link or a request (P5's option): `{ login, name?, scope?, project?, auto? }`.
   * The scope is relative to page `s` when there is one, as for a share; else `all`, or a `project` by id or
   * name (from the CLI, a folder inside one of its roots). The name defaults to the login.
   */
  function allowTailscale(s: Session | null, body: RequestBody): { status: number; error: string } | AccessSummary {
    let scope: Scope | string;
    if (s) scope = scopeFor(s, body);
    else if (body.scope === "all") scope = { kind: "all", id: null };
    else if (body.scope === "project" && typeof body.project === "string" && body.project) {
      let found: ProjectRow | null;
      try {
        found = findProject(hub.db, body.project, { folders: path.isAbsolute(body.project) });
      } catch (err) {
        return { status: 400, error: (err as Error).message };
      }
      if (!found) return { status: 404, error: `no project ${body.project}` };
      scope = { kind: "project", id: found.id };
    } else return { status: 400, error: "say what the login reaches: a page (its file), a project, or every page (scope all)" };
    if (typeof scope === "string") return { status: 400, error: scope };
    const auto = shareAuto(body.auto, scope);
    if (typeof auto === "string") return { status: 409, error: auto };
    const login = typeof body.login === "string" ? body.login.trim() : "";
    let row: DeviceRow;
    try {
      row = devices.allowLogin({ login, name: typeof body.name === "string" && body.name.trim() ? body.name : login.slice(0, 40), scope, auto });
    } catch (err) {
      return { status: 400, error: String((err as Error).message || err) };
    }
    if (s) watch(s);
    rescanSharedPolls();
    log("share-tailscale", row.name, row.id, row.scope_kind, row.auto ? "auto" : "hold");
    return accessSummary(row, false);
  }

  /** Revoke what `key` names (an id, or a name) and cut its open pages off. */
  function revokeAccess(key: unknown): RevokeResponse {
    const gone = devices.revoke(key);
    for (const r of gone) cutOff(r.id, null);
    if (gone.length) log("share-revoke", gone.map((r) => `${r.name}(${r.id})`).join(","));
    return { revoked: gone.map((r) => ({ id: r.id, name: r.name, kind: r.claimed_at == null ? "link" : "device" })) };
  }

  // ── access requests (RLM-398) ──

  function requestSummary(r: AccessRequestRow): AccessRequestSummary {
    const art = hub.artifact(r.page);
    const project = art?.project_id ? findProject(hub.db, art.project_id, { folders: false }) : null;
    return {
      id: r.id,
      name: r.name,
      status: r.status,
      page: r.page,
      file: art?.file ?? null,
      project: project ? { id: project.id, name: project.name } : null,
      addr: r.addr,
      host: r.host,
      userAgent: r.user_agent,
      browser: describeAgent(r.user_agent),
      verifiedLogin: r.verified_login,
      tailscaleDevice: r.ts_device,
      createdAt: r.created_at,
      decidedAt: r.decided_at,
    };
  }

  function requestSwitch(): RequestSwitchResponse {
    const on = requests.switches();
    return { all: on.all, projects: on.projects.map((p) => ({ ...p, name: findProject(hub.db, p.id, { folders: false })?.name ?? p.id })) };
  }

  function requestsList(): AccessRequestsResponse {
    return { waiting: requests.list("waiting").map(requestSummary), blocked: requests.list("blocked").map(requestSummary), switch: requestSwitch() };
  }

  /** Turn requests on or off: `{ on, project? }`, a project by id or name (or, from the CLI, a folder inside one of its roots); none: every page. */
  function changeRequestSwitch(body: RequestBody): { status: number; error: string } | RequestSwitchResponse {
    if (typeof body.on !== "boolean") return { status: 400, error: "on must be true or false" };
    let projectId: string | null = null;
    if (body.project !== undefined && body.project !== null) {
      if (typeof body.project !== "string" || !body.project) return { status: 400, error: "project must be a project's id or name" };
      let found: ProjectRow | null;
      try {
        found = findProject(hub.db, body.project, { folders: path.isAbsolute(body.project) });
      } catch (err) {
        return { status: 400, error: (err as Error).message };
      }
      if (!found) return { status: 404, error: `no project ${body.project}` };
      projectId = found.id;
    }
    requests.setEnabled(projectId, body.on);
    log("share-requests", projectId ?? "all", body.on ? "on" : "off");
    return requestSwitch();
  }

  /**
   * Approve (`{ scope?, project?, auto?, name? }`, scope relative to the page the request came from, as
   * for a share), deny, or block a waiting request.
   */
  function decideRequest(id: unknown, action: string, body: RequestBody): { status: number; error: string } | RequestDecisionResponse {
    const row = typeof id === "string" ? requests.get(id) : null;
    if (!row) return { status: 404, error: "no request with that id" };
    try {
      if (action === "approve") {
        const s = store.get(row.page);
        let scope: Scope | string;
        if (body.scope === "all") scope = { kind: "all", id: null };
        else if (!s) return { status: 409, error: "the page this request came from is gone; approve it for every page (scope all), or deny it" };
        else scope = scopeFor(s, body);
        if (typeof scope === "string") return { status: 400, error: scope };
        const auto = shareAuto(body.auto, scope);
        if (typeof auto === "string") return { status: 409, error: auto };
        const device = requests.approve(row.id, scope, auto, body.name);
        if (s) {
          watch(s);
          rescanSharedPolls();
        }
        log("share-approve", row.id, device.name, device.id, device.scope_kind, device.auto ? "auto" : "hold");
        return { request: requestSummary(requests.get(row.id) as AccessRequestRow), device: accessSummary(device, false) };
      }
      const decided = requests.decide(row.id, action === "block" ? "blocked" : "denied");
      log(`share-${action}`, row.id, row.name);
      return { request: requestSummary(decided) };
    } catch (err) {
      if (err instanceof RequestRefused) return { status: err.status, error: err.message };
      throw err;
    }
  }

  /** The pending request cookie, and the one that clears it. */
  function requestCookie(req: http.IncomingMessage, secret: string | null): string {
    return secret == null
      ? `${REQUEST_COOKIE}=; Path=/s/; HttpOnly; SameSite=Lax; Max-Age=0`
      : `${REQUEST_COOKIE}=${secret}; Path=/s/; HttpOnly; SameSite=Lax; Max-Age=${REQUEST_COOKIE_MAX_AGE}${overHttps(req) ? "; Secure" : ""}`;
  }

  /** The device cookie for an approved request, when this browser is the one that asked; clears the pending cookie. Null: nothing to collect. */
  function collectApproval(req: http.IncomingMessage): string[] | null {
    const pending = tokenFromCookie(req.headers.cookie, REQUEST_COOKIE);
    if (!pending) return null;
    const got = requests.collect(pending);
    if (!got) return null;
    log("share-request-joined", got.device.name, got.device.id);
    return [`${COOKIE}_${got.device.id}=${got.secret}; Path=/s/; HttpOnly; SameSite=Lax; Max-Age=${DEVICE_COOKIE_MAX_AGE}${overHttps(req) ? "; Secure" : ""}`, requestCookie(req, null)];
  }

  /** This browser's request, as the browser may know it: waiting, denied, blocked, or none (no request, or one it cannot use: collected, lapsed). */
  function requestStateOf(req: http.IncomingMessage): "none" | "waiting" | "denied" | "blocked" {
    const mine = requests.bySecret(tokenFromCookie(req.headers.cookie, REQUEST_COOKIE));
    return mine?.status === "waiting" || mine?.status === "denied" || mine?.status === "blocked" ? mine.status : "none";
  }

  /**
   * The page an unknown browser sees where requests are on. It names neither the page's title nor
   * its file, and holds nothing of its content: only the form, or where the browser's request stands.
   * Over the tailnet listener, Tailscale names the person: the form then asks under that name.
   */
  function requestPage(req: http.IncomingMessage, s: Session, person: TailscalePerson | null, error = ""): string {
    const state = requestStateOf(req);
    const head = `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex"><title>Ask for access</title><style>body{font:16px/1.5 system-ui,sans-serif;max-width:28rem;margin:12vh auto;padding:0 1rem;color:#222}input{font:inherit;padding:.4rem .5rem;width:100%;box-sizing:border-box;margin:.25rem 0 .75rem}button{font:inherit;padding:.4rem 1rem}.err{color:#b00020}.muted{color:#666}</style>`;
    if (state === "blocked") return `${head}<h1>No access</h1><p>The owner has blocked this browser from asking for access.</p>`;
    if (state === "waiting") {
      return `${head}<h1>Waiting for the owner</h1><p>Your request was sent. This page opens by itself once the owner lets you in.</p><p class="muted">Keep this tab open, or come back to this address later.</p><script>setInterval(function(){fetch(${JSON.stringify(`/s/${s.id}/request`)},{cache:"no-store",credentials:"same-origin"}).then(function(r){return r.ok?r.json():null}).then(function(j){if(!j||j.state!=="waiting")location.reload()},function(){})},${REQUEST_POLL_MS})</script>`;
    }
    const denied = state === "denied" ? `<p class="err">The owner declined your last request. You can ask again.</p>` : "";
    const err = error ? `<p class="err">${escapeHtml(error)}</p>` : "";
    const local = isLoopback(clientAddr(req)) ? `<p class="muted">If this is your page, sign this browser in instead: run <code>austere-axi login</code> and open the link it prints.</p>` : "";
    if (person) {
      const device = person.device ? ` on <strong>${escapeHtml(person.device)}</strong>` : "";
      return `${head}<h1>Ask the owner for access</h1>${denied}${err}<p>Tailscale says you are <strong>${escapeHtml(person.name)}</strong> (${escapeHtml(person.login)})${device}.</p><form method="post" action="/s/${s.id}/request"><button>Ask as ${escapeHtml(personName(person))}</button></form><p class="muted">The owner sees your Tailscale login and device, your address and your browser, and lets this browser in.</p>`;
    }
    return `${head}<h1>Ask the owner for access</h1>${denied}${err}<form method="post" action="/s/${s.id}/request"><label>Your name<input name="name" maxlength="40" autocomplete="name" required autofocus></label><button>Send</button></form><p class="muted">The owner sees your name, your address and your browser, and lets this browser in.</p>${local}`;
  }

  /** A reviewer name from what Tailscale says: the display name, else the login, cut to a name's 40 characters. */
  function personName(person: TailscalePerson): string {
    for (const raw of [person.name, person.login]) {
      try {
        return cleanName(raw.slice(0, 40));
      } catch {
        // reserved ("owner") or empty: try the next
      }
    }
    return "Tailscale user";
  }

  /** Headers for a page of the request flow: not framed, and a form POST keeps its Origin (see the join page). */
  const REQUEST_PAGE_HEADERS = { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "referrer-policy": "same-origin", "x-frame-options": "DENY" };

  /**
   * The hostname of address `addr`, handed to `save` once it resolves both ways: a reverse lookup
   * alone is whatever the address's owner put in its PTR record. Best effort, never waited for.
   */
  function lookUpHost(addr: string | null, save: (name: string) => void): void {
    if (!addr) return;
    const ip = addr.replace(/^::ffff:/, "");
    dns.promises
      .reverse(ip)
      .then(async (names) => {
        for (const name of names.slice(0, 3)) {
          const back = await dns.promises.lookup(name, { all: true }).catch(() => []);
          if (back.some((a) => a.address.replace(/^::ffff:/, "") === ip)) return save(name);
        }
      })
      // No name, a slow resolver, or a database closed by shutdown in the meantime: no hostname is kept.
      .catch(() => {});
  }

  /**
   * The request flow for a browser with no reviewer cookie, where requests are on for the page:
   * GET the page (the form, or where its request stands), GET /request (the waiting page's poll),
   * POST /request (send). `person`: who Tailscale says asks, over the tailnet listener only; the
   * request then takes their name and keeps their login and device. False: requests are off here,
   * so the caller answers as without them.
   */
  async function requestRoute(req: http.IncomingMessage, res: http.ServerResponse, s: Session, sub: string, person: TailscalePerson | null): Promise<boolean> {
    if (!requests.enabled(store.projectIdOf(s))) return false;
    if (sub === "/request" && req.method === "GET") {
      send(res, 200, { state: requestStateOf(req) });
      return true;
    }
    if (sub !== "/request") {
      send(res, 403, requestPage(req, s, person), REQUEST_PAGE_HEADERS);
      return true;
    }
    // A same-origin browser POST: Origin present and equal to Host, as for /join.
    if (!req.headers.origin || !checkOrigin(req)) {
      send(res, 403, { error: "cross-origin request refused" });
      return true;
    }
    const pre = requests.bySecret(tokenFromCookie(req.headers.cookie, REQUEST_COOKIE));
    if (pre?.status === "blocked") {
      send(res, 403, requestPage(req, s, person), REQUEST_PAGE_HEADERS);
      return true;
    }
    if (pre?.status === "approved" || pre?.status === "waiting") {
      res.writeHead(303, { location: `/s/${s.id}`, "cache-control": "no-store" });
      res.end();
      return true;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const c of req as AsyncIterable<Buffer>) {
      size += c.length;
      if (size > 4096) {
        send(res, 413, "payload too large");
        return true;
      }
      chunks.push(c);
    }
    // The body can take its time: check the page, the switch and this browser's standing again now.
    if (!store.get(s.id) || !requests.enabled(store.projectIdOf(s))) return false;
    const mine = requests.bySecret(tokenFromCookie(req.headers.cookie, REQUEST_COOKIE));
    if (mine?.status === "blocked" || mine?.status === "waiting" || mine?.status === "approved") {
      // Blocked: the page says so. Waiting: one request per browser. Approved: collect it on the GET.
      res.writeHead(303, { location: `/s/${s.id}`, "cache-control": "no-store" });
      res.end();
      return true;
    }
    const name = person ? personName(person) : new URLSearchParams(Buffer.concat(chunks).toString("utf8")).get("name");
    let made: { row: AccessRequestRow; secret: string };
    try {
      made = requests.ask({ name, page: s.id, meta: seenMeta(req), tailscale: person });
    } catch (err) {
      if (!(err instanceof RequestRefused)) throw err;
      send(res, err.status, requestPage(req, s, person, err.message), REQUEST_PAGE_HEADERS);
      return true;
    }
    const { id } = made.row;
    lookUpHost(made.row.addr, (host) => requests.setHost(id, host));
    log("share-request", made.row.id, made.row.name, made.row.addr ?? "");
    res.writeHead(303, { location: `/s/${s.id}`, "set-cookie": requestCookie(req, made.secret), "cache-control": "no-store" });
    res.end();
    return true;
  }

  /**
   * The address a request came from: the socket's, or, when a reverse proxy on this machine
   * forwarded it, the address that proxy saw (the last `X-Forwarded-For` entry). A remote peer's
   * own header is never trusted.
   */
  function clientAddr(req: http.IncomingMessage): string | undefined {
    const socket = req.socket.remoteAddress;
    if (!isLoopback(socket)) return socket;
    const forwarded = String(req.headers["x-forwarded-for"] || "").split(",").pop()?.trim() ?? "";
    return net.isIP(forwarded) ? forwarded : socket;
  }

  /**
   * Where a request came from, for a device's last-seen fields and an access request: the address and
   * the User-Agent. The hostname is the Tailscale device's name when Tailscale named the person, else
   * left for a reverse lookup (lookUpHost); the Host header names this server, not the browser.
   */
  function seenMeta(req: http.IncomingMessage, person: TailscalePerson | null = null): SeenMeta {
    const ua = req.headers["user-agent"];
    return { addr: clientAddr(req) ?? null, host: person?.device || null, userAgent: typeof ua === "string" ? ua : null };
  }

  /** Whether the browser reached this server over HTTPS: a proxy says so, or the link URL is https and this is its host. */
  function overHttps(req: http.IncomingMessage): boolean {
    if (String(req.headers["x-forwarded-proto"] || "").split(",")[0].trim() === "https") return true;
    return Boolean(linkBase && linkBase.base.startsWith("https:") && hostOnly(req.headers.host) === hostOnly(linkBase.host));
  }

  /**
   * Only a request with the owner cookie is the owner, on loopback too: another OS user on this
   * machine can reach 127.0.0.1 but cannot read owner.key (mode 0600). The cookie holds a value
   * derived from the key, not the key (see ownerCookie). Never on the local-network listener (P7).
   */
  function isOwner(req: http.IncomingMessage): boolean {
    if (via(req) === "lan") return false;
    const value = tokenFromCookie(req.headers.cookie, OWNER_COOKIE);
    return value != null && safeEqual(value, ownerCookieValue);
  }

  /** The 403 text for a request that is not the owner. On loopback it is most likely the owner in a browser without the cookie yet. */
  function notOwner(req: http.IncomingMessage, text = "Only the owner can open this. Ask the owner for a link to the page.") {
    if (via(req) === "lan") return `${text}\n${LAN_NO_OWNER}`;
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

  /**
   * An --auto link or device gives a reviewer's notes a seq without the owner: never while an agent
   * is attached to a page it reaches (Q3, A17). Why `scope` cannot be auto now, or "".
   */
  function autoAttachConflict(scope: Scope): string {
    const attached = (store.db.prepare("SELECT id, file, project_id FROM artifacts").all() as { id: string; file: string; project_id: string | null }[]).find(
      (a) => covers({ scope_kind: scope.kind, scope_id: scope.id }, a.id, a.project_id) && effectiveAttach(store.db, a.id).state === "on",
    );
    return attached ? `attach is on for ${attached.file}: an --auto link would let a reviewer's notes start the attached agent without you. Run \`austere-axi attach off ${attached.file}\` first, or share without --auto.` : "";
  }

  // ── who is asking ──

  /** The live devices behind the reviewer cookies a request carries (an old-style link's token counts as its cookie). */
  function cookieDevices(req: http.IncomingMessage): DeviceRow[] {
    const out: DeviceRow[] = [];
    for (const { value: v } of reviewerCookies(req.headers.cookie)) {
      const row = devices.bySecret(v);
      if (row && !out.some((r) => r.id === row.id)) out.push(row);
    }
    return out;
  }

  /**
   * Who `tailscale whois` says is behind a request, over the tailnet listener only, asked with the
   * socket's own remote address: never a header (`X-Forwarded-For`, `Tailscale-User-*`), which
   * anyone can send. A connection from this machine's own tailnet address is this computer, not a
   * person on the tailnet. Null: another listener, Tailscale off or failing, or a tagged device.
   */
  function tailnetPerson(req: http.IncomingMessage): Promise<TailscalePerson | null> {
    if (via(req) !== "tailnet") return Promise.resolve(null);
    const addr = String(req.socket.remoteAddress || "").replace(/^::ffff:/, "");
    return addr && addr !== tailnetBound ? whoIs(addr) : Promise.resolve(null);
  }

  /** What a row proves a reviewer with: its secret's hash, or for a Tailscale login the owner let in, that login. */
  function credentialOf(row: DeviceRow): string | null {
    if (row.secret_hash) return row.secret_hash;
    return row.origin === "tailscale" && row.verified_login ? `tailscale\0${row.verified_login}` : null;
  }

  /** Record that `row` was seen now, and look up the address's hostname when Tailscale did not name the device. */
  function seenDevice(row: DeviceRow, req: http.IncomingMessage, person: TailscalePerson | null): void {
    const meta = seenMeta(req, person);
    const addr = meta.addr;
    if (devices.seen(row, meta) && !meta.host && addr) lookUpHost(addr, (host) => devices.setHost(row.id, addr, host));
  }

  /**
   * Who is asking, in this order (RLM-399): the owner (the owner key cookie, on any listener but the
   * local network's, with no reviewer cookie); a person Tailscale names (`person`) whose login the owner
   * let in for this page; a device the owner approved (a reviewer cookie of a live device whose scope
   * reaches this page; over the tailnet, only for the login first seen behind it); else nobody. A
   * request with a reviewer cookie is never the owner, so revoking cuts access.
   */
  function identify(req: http.IncomingMessage, s: Session, person: TailscalePerson | null): Viewer | null {
    const cookies = reviewerCookies(req.headers.cookie).length > 0;
    if (!cookies && isOwner(req)) return OWNER;
    const pid = store.projectIdOf(s);
    const allowed = person ? devices.byLogin(person.login).find((r) => covers(r, s.id, pid)) : undefined;
    const row = allowed ?? (cookies ? cookieDevices(req).find((r) => covers(r, s.id, pid) && (!person || r.verified_login == null || r.verified_login === person.login)) : undefined);
    if (!row) return null;
    // An old-style link's token is many browsers' cookie: it belongs to no one login.
    if (person && !row.reusable) devices.bindLogin(row, person.login);
    seenDevice(row, req, person);
    return { role: "reviewer", name: row.name, auto: Boolean(row.auto), deviceId: row.id, credential: credentialOf(row) as string };
  }

  /** A note this reviewer wrote: by device, or by name for a note from before devices. */
  function wroteIt(e: UserEntry, viewer: ReviewerViewer): boolean {
    return e.deviceId ? e.deviceId === viewer.deviceId : e.author === viewer.name;
  }

  /** Held and discarded notes belong to the owner and to the author. */
  function canSee(e: TranscriptEntry, viewer: Viewer): boolean {
    if (viewer.role === "owner") return true;
    if (e.role === "user" && (e.held || e.discarded)) return wroteIt(e, viewer);
    return true;
  }

  function send(res: http.ServerResponse, status: number, body: unknown, headers: http.OutgoingHttpHeaders = {}): void {
    const isText = typeof body === "string" || Buffer.isBuffer(body);
    const payload = isText ? body : JSON.stringify(body);
    res.writeHead(status, {
      "content-type": isText ? String(headers["content-type"] || "text/plain; charset=utf-8") : "application/json; charset=utf-8",
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

  /** The poll that gets this page's notes: its own, else its checkout's, else its project's. */
  function listener(s: Session): Poll | undefined {
    const own = polls.get(s.id);
    if (own && !own.done) return own;
    return sharedListener(s);
  }

  /** The shared poll a page without a poll of its own falls to: its root's (this checkout), else its project's, unless an unacknowledged batch holds it (`held`). */
  function sharedListener(s: Session): Poll | undefined {
    const root = store.rootOf(s);
    const byRoot = root ? rootPolls.get(root) : undefined;
    if (byRoot && !byRoot.done) return held(s, byRoot) ? undefined : byRoot;
    const pid = store.projectIdOf(s);
    const byProject = pid ? projectPolls.get(pid) : undefined;
    return byProject && !byProject.done && !held(s, byProject) ? byProject : undefined;
  }

  /**
   * A batch its agent has not acknowledged yet keeps the page with the scope that took it, for up to `pageHoldMs`:
   * a page poll's batch keeps it from every shared poll, a checkout poll's batch from the project poll.
   */
  function held(s: Session, shared: Poll): boolean {
    const hold = s.pageHold;
    if (!hold || s.ackedSeq >= hold.seq || Date.now() - hold.at >= pageHoldMs) return false;
    return !(shared.root && hold.root);
  }

  function presence(s: Session): Presence {
    if (listener(s)) return "listening";
    if (!s.workingSince) return "idle";
    return staleWorkingMs && Date.now() - (s.agentAt ?? s.workingSince) >= staleWorkingMs - 10 ? "stale" : "working";
  }

  /** Presence as the review page gets it: `since`, while an agent has the notes, is when it took them; `now` lets the page read it against its own clock. */
  function presenceInfo(s: Session): { presence: Presence; since?: number; now: number } {
    const p = presence(s);
    return { presence: p, since: p === "working" || p === "stale" ? (s.workingSince ?? undefined) : undefined, now: Date.now() };
  }

  /** The agent working on `s` showed a sign of life: the page reads `working` again, and turns `stale` (told to its open pages) after staleWorkingMs more of silence. */
  function agentActive(s: Session): void {
    s.agentAt = Date.now();
    clearTimeout(staleTimers.get(s.id));
    if (!staleWorkingMs) return;
    const schedule = () => {
      const remaining = staleWorkingMs - (Date.now() - (s.agentAt ?? s.workingSince ?? 0));
      if (remaining > 10) {
        const timer = setTimeout(schedule, Math.min(remaining, MAX_TIMER_MS));
        timer.unref();
        staleTimers.set(s.id, timer);
        return;
      }
      staleTimers.delete(s.id);
      broadcastPresence(s);
    };
    const timer = setTimeout(schedule, Math.min(staleWorkingMs, MAX_TIMER_MS));
    timer.unref();
    staleTimers.set(s.id, timer);
  }

  function publicSession(s: Session): PublicSession {
    return { id: s.id, file: s.file, title: s.title, archived: Boolean(s.archivedAt), unread: store.unread(s).length };
  }

  /** The page's project, with `ref` naming it for `--project`: its name, or its id when another project has that name. */
  function projectOfPage(s: Session): { id: string; name: string; ref: string } | undefined {
    const pid = store.projectIdOf(s);
    const p = pid ? findProject(hub.db, pid, { folders: false }) : null;
    if (!p) return undefined;
    let ref = p.id;
    try {
      if (findProject(hub.db, p.name, { folders: false })?.id === p.id) ref = p.name;
    } catch {
      // another project has the name: the id
    }
    return { id: p.id, name: p.name, ref };
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

  /** An event for the owner's review pages of a copy only, never a reviewer's. */
  function broadcastOwners(id: string, event: "run" | "attach", data: RunEvent | Record<string, never>): void {
    const set = clients.get(id);
    if (!set) return;
    const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const c of Array.from(set)) if (c.viewer.role === "owner") sseWrite(set, c, msg);
  }

  /** `omp models` for the popover's model list (ompModels). */
  let modelCache: { at: number; models: string[] | null; pending: Promise<string[] | null> | null } = { at: 0, models: null, pending: null };

  /** What the owner's attach popover shows for a copy (RLM-346). A malformed adapters.json is a warning here, not an error. */
  async function attachInfo(s: Session): Promise<AttachInfo> {
    let cfg: AdaptersConfig = { extraArgs: {}, commands: {} };
    let configError: string | null = null;
    try {
      cfg = readAdapters();
    } catch (err) {
      configError = (err as Error).message;
    }
    const report = attachReport(store.db, s.id, s.file, cfg, process.env, liveAuto);
    const harnesses: AttachInfo["harnesses"] = harnessInfos(cfg);
    if (harnesses.omp?.found) {
      const models = await ompModels();
      if (models) harnesses.omp.models = models;
    }
    const author = authorOf(store.db, s.id);
    const session = report.target.session;
    let sessionFileSize: number | null = null;
    if (session?.session_file && report.target.mode !== "new") {
      try {
        sessionFileSize = fs.statSync(session.session_file).size;
      } catch {
        // gone, or not readable here
      }
    }
    const last = listRuns(store.db, { artifactId: s.id }, 1)[0];
    return {
      effective: report.effective,
      page: report.page,
      project: report.project,
      target: { mode: report.target.mode, harness: report.target.harness, session: session ? shortId(session.session_id) : null },
      author: author ? { id: author.id, harness: author.harness, short: shortId(author.session_id) } : null,
      sessions: listSessions(store.db, { artifactId: s.id }).map((p) => ({
        id: p.session.id,
        harness: p.session.harness,
        short: shortId(p.session.session_id),
        roles: p.roles,
        lastSeen: p.session.last_seen,
        liveness: liveness(p.session),
      })),
      harnesses,
      run: last ? summary(last) : null,
      sessionFileSize,
      warnings: configError ? [configError, ...report.warnings] : report.warnings,
      auto: report.auto,
    };
  }

  /**
   * omp's model selectors from `omp models --json`, cached for ten minutes. A request waits at most
   * a second: a slow answer fills the cache for the next one. Null when omp gave none.
   */
  function ompModels(): Promise<string[] | null> {
    const cache = modelCache;
    if (cache.pending) {
      const waited = Promise.withResolvers<string[] | null>();
      setTimeout(() => waited.resolve(cache.models), 1000).unref();
      return Promise.race([cache.pending, waited.promise]);
    }
    if (cache.at && Date.now() - cache.at < 10 * 60_000) return Promise.resolve(cache.models);
    const bin = findOnPath("omp");
    if (!bin) return Promise.resolve(null);
    const listed = Promise.withResolvers<string[] | null>();
    // A .cmd shim on Windows goes through cmd.exe; spawn can still throw at once (EINVAL, EACCES): no models then.
    try {
      const spec = spawnSpec(bin, ["models", "--json"]);
      const child = spawn(spec.file, spec.args, { stdio: ["ignore", "pipe", "ignore"], windowsHide: true, windowsVerbatimArguments: spec.windowsVerbatimArguments, timeout: 15_000 });
      let out = "";
      child.stdout.on("data", (c: Buffer) => {
        if (out.length < 4 * 1024 * 1024) out += c.toString("utf8");
      });
      child.on("error", () => listed.resolve(null));
      child.on("close", () => listed.resolve(modelSelectors(out)));
    } catch (err) {
      log("omp-models", (err as Error).message);
      listed.resolve(null);
    }
    cache.pending = listed.promise.then((models) => {
      modelCache = { at: Date.now(), models, pending: null };
      return models;
    });
    return ompModels();
  }

  /** The body of POST /s/:id/attach, or why it is malformed. */
  function parseAttachChange(body: Record<string, unknown>): { state: AttachState; fields: AttachFields } | string {
    const state = body.state;
    if (state !== "on" && state !== "off" && state !== "inherit") return "state must be on, off or inherit";
    const fields: AttachFields = {};
    if (body.mode !== undefined && body.mode !== null) {
      if (!isAttachMode(body.mode)) return "mode must be same, fork or new";
      fields.mode = body.mode;
    }
    for (const key of ["session", "harness"] as const) {
      const v = body[key];
      if (v === undefined || v === null) continue;
      if (typeof v !== "string" || !v || v.length > 200) return `${key} must be a non-empty string`;
      fields[key] = v;
    }
    if (body.model !== undefined) {
      const m = body.model;
      if (m !== null && (typeof m !== "string" || m.length > 200 || /[\s\0-\x1f]/.test(m))) return "model must be a name without spaces, or empty";
      fields.model = m || null;
    }
    return { state, fields };
  }

  /**
   * The owner's attach change, from the review page's popover or the CLI: the row written, and the
   * owner tabs of every copy it decides for told to look again. An HTTP error, or null when done.
   */
  function changeAttach(where: AttachWhere, body: RequestBody): { status: number; error: string; code?: string } | null {
    const change = parseAttachChange(body);
    if (typeof change === "string") return { status: 400, error: change };
    let cfg: AdaptersConfig;
    try {
      cfg = readAdapters();
      if (change.fields.harness !== undefined && !adapterFor(change.fields.harness, cfg)) return { status: 400, error: `no adapter named ${change.fields.harness}` };
      if (change.fields.session !== undefined) change.fields.session = resolveSessionValue(store.db, change.fields.session);
    } catch (err) {
      return { status: 400, error: (err as Error).message };
    }
    try {
      changeSetting(store.db, where, change.state, change.fields, cfg, liveAuto);
    } catch (err) {
      if (err instanceof AttachRefused) return { status: 409, error: err.message, code: err.code };
      throw err;
    }
    // A page row decides for every copy of the page (A19), a project row for every copy in the project.
    const copies = (
      "page" in where
        ? store.db.prepare("SELECT id FROM artifacts WHERE page_id = ? OR id = ?").all(scopeIds(store.db, where.page.artifactId).page, where.page.artifactId)
        : store.db.prepare("SELECT id FROM artifacts WHERE project_id = ?").all(where.projectId)
    ) as { id: string }[];
    for (const c of copies) broadcastOwners(c.id, "attach", {});
    log("attach", "page" in where ? where.page.artifactId : `project:${where.projectId}`, change.state);
    return null;
  }

  function broadcastPresence(s: Session): void {
    broadcast(s.id, "presence", { ...presenceInfo(s), archived: Boolean(s.archivedAt), unread: store.unread(s).length });
  }

  /** A hosted viewer's presence frame for the owner's review page, unchanged. */
  function viewerEvent(frame: ServerPresence): string {
    return `event: viewer\ndata: ${JSON.stringify(frame)}\n\n`;
  }

  function broadcastTranscript(s: Session, entries: TranscriptEntry[]): void {
    const set = clients.get(s.id);
    if (!set) return;
    for (const c of Array.from(set)) {
      const visible = entries.filter((e) => canSee(e, c.viewer));
      if (visible.length) sseWrite(set, c, `event: transcript\ndata: ${JSON.stringify({ entries: visible })}\n\n`);
    }
  }

  /**
   * Close the event streams of a device: every one when it is revoked (`row` null), else the ones on
   * pages its scope no longer reaches. Its open pages show why.
   */
  function cutOff(deviceId: string, row: DeviceRow | null): void {
    for (const [id, set] of clients) {
      const s = store.get(id);
      for (const c of Array.from(set)) {
        if (c.viewer.role !== "reviewer" || c.viewer.deviceId !== deviceId) continue;
        if (row && s && covers(row, s.id, store.projectIdOf(s))) continue;
        c.res.write(`event: server\ndata: ${JSON.stringify({ state: "revoked" })}\n\n`);
        c.res.end();
        set.delete(c);
      }
    }
  }

  /** After pages change project (merge, forget-root): every open reviewer stream is checked against its device's scope again. */
  function recheckScopes(): void {
    const ids = new Set<string>();
    for (const set of clients.values()) for (const c of set) if (c.viewer.role === "reviewer" && c.viewer.deviceId) ids.add(c.viewer.deviceId);
    for (const id of ids) {
      const row = devices.get(id);
      cutOff(id, row && row.revoked_at == null ? row : null);
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
    // An edit made while no server watched this file becomes a revision now.
    if (html != null) {
      const rev = recordHistory(s, html, "open");
      if (rev) s.revision = Math.max(s.revision, rev.rev);
    }
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

  /** Pages of the same project with a title or card heading like this page's (`open` lists them; it never blocks). */
  function similarTo(s: Session): OpenResponse["similar"] {
    try {
      const headings = [s.title, ...(store.db.prepare("SELECT text FROM statements WHERE artifact_id = ? AND component = 'CardHeader'").all(s.id) as unknown as { text: string }[]).map((h) => h.text.split("\n")[0])];
      const found = similarPages(store.db, { artifactId: s.id, projectId: store.projectIdOf(s), headings });
      return found.length ? found.map((f) => ({ title: f.title, file: f.file, updatedAt: f.updated_at })) : undefined;
    } catch {
      return undefined;
    }
  }

  /** Record the file's program as the page's next revision, if it differs from the head. Never fails the page: history is a convenience. */
  function recordHistory(s: Session, html: string, source: "open" | "file" | "restore"): RevisionRow | null {
    try {
      return recordRevision(store.db, s.id, html, { source });
    } catch (err) {
      log("history", s.id, "not recorded:", String((err as Error).message || err));
      return null;
    }
  }

  function onFileChange(s: Session, w: Watcher): void {
    const html = readFileSafe(s.file);
    if (html == null || html === w.html) return;
    const art = readArtifact(html);
    const shellChanged = art.shell !== w.shell;
    w.html = html;
    w.program = art.program;
    w.shell = art.shell;
    // A program change is a revision of its own (a patch from the CLI recorded it already: then there is nothing new to record).
    const recorded = recordHistory(s, html, "file");
    s.revision = Math.max(s.revision + 1, recorded?.rev ?? 0);
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
    // An agent that has the notes and changes the page is working on them, not gone.
    if (s.workingSince) {
      agentActive(s);
      broadcastPresence(s);
    }
  }

  /** Packs on this page not published by austere-axi: the chrome warns that their code runs in it. */
  function thirdPartyPacks(html: string | null | undefined): string[] {
    return html ? pagePacks(html).thirdParty.map((p) => `${p.name}@${p.version}`) : [];
  }

  // ── polling ──

  /** Answer `poll` with every note after its read point. The notes stay unread until the agent acknowledges them. */
  function deliver(s: Session, poll: Poll): void {
    const entries = store.after(s, poll.from);
    // A page always takes notes: final only tells the agent the newest batch was sent with Done or Send & finish, so it stops listening after applying it. A later plain note in the same answer means the reviewer carries on.
    const final = Boolean(entries[entries.length - 1].end);
    const body: PollResponse = { status: "feedback", items: itemsOf(entries), cursor: entries[entries.length - 1].seq, final: final || undefined };
    finishPoll(s, poll, body, () => {
      store.markDelivered(s, entries);
      s.workingSince = Date.now();
      agentActive(s);
      const cursor = body.cursor as number;
      if (!s.pageHold || s.pageHold.seq <= cursor) {
        s.pageHold = { seq: cursor, at: s.workingSince };
      }
      broadcastTranscript(s, entries);
      broadcastPresence(s);
    });
  }

  /** The items of these notes as a poll hands them over: a teammate's carry `author`, a hosted page's `remote`. */
  function itemsOf(entries: UserEntry[]): NoteItem[] {
    const items: NoteItem[] = [];
    for (const e of entries) {
      for (const it of e.items || []) items.push(e.author ? { ...it, author: e.author, ...(e.remote ? { remote: true } : {}) } : it);
    }
    return items;
  }

  /** The label of a page's copy: its root's branch, else its folder's name. */
  function copyOf(s: Session): string {
    const root = hub.artifact(s.id)?.root;
    return root ? copyLabel(root) : path.basename(path.dirname(s.file));
  }

  /**
   * The pages a shared poll listens for, by precedence page, then root, then project: a root poll gets its
   * checkout's pages without a poll of their own; a project poll gets the project's pages that neither a page
   * poll nor their checkout's poll holds, nor an unacknowledged batch of either (`held`). Read each time, so a page registered later counts.
   */
  function covered(poll: Poll): Session[] {
    const pages = poll.root ? store.inRoot(poll.root) : store.inProject(poll.project as string);
    return pages.filter((s) => {
      const own = polls.get(s.id);
      if ((own && !own.done) || held(s, poll)) return false;
      if (poll.root) return true;
      const root = store.rootOf(s);
      const byRoot = root ? rootPolls.get(root) : undefined;
      return !(byRoot && !byRoot.done);
    });
  }

  /** What a shared poll would hand over now: each covered page's notes after its own cursor (or after `--after`), the page with the oldest note first, so the agent reads them in the order they were sent. */
  function projectBatches(poll: Poll): { s: Session; entries: QueuedEntry[] }[] {
    return covered(poll)
      .map((s) => ({ s, entries: store.after(s, poll.after ?? s.ackedSeq) }))
      .filter((b) => b.entries.length)
      .sort((a, b) => a.entries[0].seq - b.entries[0].seq);
  }

  function deliverProject(poll: Poll, batches: { s: Session; entries: QueuedEntry[] }[]): void {
    const body: PollResponse = {
      status: "feedback",
      project: poll.project,
      cursor: Math.max(...batches.flatMap((b) => b.entries.map((e) => e.seq))),
      batches: batches.map(({ s, entries }) => ({ file: s.file, copy: copyOf(s), items: itemsOf(entries), final: entries[entries.length - 1].end ? (true as const) : undefined })),
    };
    finishProjectPoll(poll, body, () => {
      for (const { s, entries } of batches) {
        store.markDelivered(s, entries);
        s.workingSince = Date.now();
        // A checkout's batch keeps its page from the project poll until acknowledged, as a page poll's does.
        if (poll.root && (!s.pageHold || s.pageHold.seq <= (body.cursor as number))) s.pageHold = { seq: body.cursor as number, at: s.workingSince, root: true };
        agentActive(s);
        broadcastTranscript(s, entries);
        broadcastPresence(s);
      }
    });
  }

  /** A listening poll gets new notes at once: the page's own, else its checkout's, else its project's. */
  function wake(s: Session): void {
    const own = polls.get(s.id);
    if (own && !own.done) {
      if (store.after(s, own.from).length) deliver(s, own);
      return;
    }
    const shared = sharedListener(s);
    if (!shared) return;
    const batches = projectBatches(shared);
    if (batches.length) deliverProject(shared, batches);
  }

  /**
   * New notes on `s`: a listening poll gets them, else, when the owner sent or released them
   * (`ownersNote`), the attached agent's run is queued (RLM-345). Who listens is read before the
   * wake, which ends the poll it answers.
   */
  function wakeOrRun(s: Session, ownersNote: boolean): void {
    const held = Boolean(listener(s));
    wake(s);
    if (ownersNote && !held) dispatcher.noteSeq(s);
  }

  /** The `cursor` or `after` of a poll or reply: a whole number, or null when absent. */
  function seqParam(v: unknown): number | null {
    if (v == null || v === "") return null;
    const n = Number(v);
    if (!Number.isInteger(n) || n < 0) throw Object.assign(new Error("cursor and after are whole numbers from a poll"), { status: 400 });
    return n;
  }

  /**
   * The agent acknowledges what it got: up to `cursor`, or, when it replies without one, up to the last note a poll handed it.
   * Either way it stops at a note no poll handed over (an `--after` replay skips some), so that note comes back.
   * A bare poll acknowledges nothing, so an agent that lost an answer gets it again.
   */
  function acknowledge(s: Session, body: RequestBody, replying: boolean): UserEntry[] {
    const cursor = seqParam(body.cursor);
    if (cursor != null) return store.ackDelivered(s, cursor);
    return replying ? store.ackDelivered(s, s.deliveredSeq) : [];
  }

  /**
   * The owner puts a copy away, or brings it back: the composer locks or opens. A poll waiting on the copy is told
   * `archived` at once, as a poll started on it later is: no note can reach it. False when the hub does not know the copy.
   */
  function setArchived(id: string, at: number | null): boolean {
    if (!hub.setArchived(id, at)) return false;
    archivedInMemory(id, at);
    return true;
  }

  /** hub.db has the copy `id` archived at `at` (null: open): its open review pages lock or unlock, and its poll ends. */
  function archivedInMemory(id: string, at: number | null): void {
    const s = store.get(id);
    if (!s) return;
    s.archivedAt = at;
    const waiting = polls.get(id);
    if (at && waiting && !waiting.done) finishPoll(s, waiting, { status: "archived" });
    broadcastPresence(s);
  }

  /** Archive the copy `id`, or with `every` each copy of its page: see Hub.archivePlan. Null when the hub does not know it. */
  function archiveCopies(id: string, every: boolean): ArchiveResponse | null {
    const plan = hub.archivePlan(id, every);
    if (!plan) return null;
    const at = Date.now();
    for (const c of plan.archived) setArchived(c.id, at);
    return { ok: true, ...plan };
  }

  function finishPoll(s: Session, poll: Poll, body: PollResponse, onDelivered?: () => void): void {
    if (poll.done) return;
    poll.done = true;
    if (polls.get(s.id) === poll) polls.delete(s.id);
    peer.unwatch(s);
    poll.res.on("finish", () => onDelivered?.());
    send(poll.res, 200, body);
    broadcastPresence(s);
  }

  /** A shared poll has ended (answered, replaced, timed out or its client left): its pages stop being covered by it. */
  function retireProjectPoll(poll: Poll): void {
    poll.done = true;
    clearInterval(poll.refresh);
    const [scope, key] = poll.root ? [rootPolls, poll.root] : [projectPolls, poll.project as string];
    if (scope.get(key) === poll) scope.delete(key);
    refreshWatch(poll.project as string);
  }

  function finishProjectPoll(poll: Poll, body: PollResponse, onDelivered?: () => void): void {
    if (poll.done) return;
    retireProjectPoll(poll);
    poll.res.on("finish", () => onDelivered?.());
    send(poll.res, 200, body);
    for (const s of store.inProject(poll.project as string)) broadcastPresence(s);
  }

  /**
   * Keep each page's hosted connection as the listeners say: open while a poll (its own or its project's) covers the page,
   * closed once none does. Peer derives "wanted" from the same registry, so this only has to run when coverage may have changed.
   */
  function refreshWatch(projectId: string): void {
    for (const s of store.inProject(projectId)) {
      if (listener(s)) peer.watch(s);
      else peer.unwatch(s);
    }
  }

  function clientCount(id: string): number {
    return clients.get(id)?.size || 0;
  }

  /**
   * Coverage of a waiting shared poll may have changed (a page registered, or `project merge` in another process):
   * fix the hosted connections, then hand over notes a newly covered page already holds, as no insert will wake for them.
   */
  function rescanProjectPoll(poll: Poll): void {
    if (poll.done) return;
    // Its pages went to another project or root, which this poll does not listen to: end it so the agent polls that one.
    const gone = poll.root
      ? !hub.db.prepare("SELECT 1 FROM project_roots WHERE root = ?").get(poll.root)
      : !hub.db.prepare("SELECT 1 FROM projects WHERE id = ?").get(poll.project as string);
    if (gone) return finishProjectPoll(poll, { status: "moved" });
    refreshWatch(poll.project as string);
    const batches = projectBatches(poll);
    if (batches.length) deliverProject(poll, batches);
  }

  /**
   * A page registered while its checkout's or its project's poll listens is covered by it from now on: a published
   * page's hosted socket opens too, and closes with the poll. Registering it may have taken other pages in (a guessed
   * folder above them): every shared poll looks again, and one whose project or root is gone ends as moved.
   */
  function rescanSharedPolls(): void {
    for (const poll of [...rootPolls.values(), ...projectPolls.values()]) rescanProjectPoll(poll);
  }

  /**
   * `poll` and `feedback` over many pages (`project`: an id or a name; the CLI resolves a folder to one). With `root`
   * (one of the project's root folders) they cover that checkout only; without, every root of the project.
   * A shared poll gets its pages without a poll of their own (see `covered`), including pages registered after
   * it started. `cursor` acknowledges the notes up to that seq on those pages. The newest poll of the same scope wins.
   */
  async function projectRoute(route: "poll" | "feedback", body: RequestBody, res: http.ServerResponse, caller: CallerReport | null): Promise<void> {
    let project: ProjectRow | null;
    try {
      project = findProject(hub.db, String(body.project), { folders: false });
    } catch (err) {
      return send(res, 400, { error: String((err as Error).message) });
    }
    if (!project) return send(res, 404, { error: `no project ${String(body.project)}` });
    const root = typeof body.root === "string" && body.root ? body.root : undefined;
    if (root && !hub.db.prepare("SELECT 1 FROM project_roots WHERE root = ? AND project_id = ?").get(root, project.id)) {
      return send(res, 404, { error: `${root} is not a root of project ${project.name}` });
    }
    noteCaller(caller, (root ? store.inRoot(root) : store.inProject(project.id)).map((s) => s.id), route);

    if (route === "feedback") {
      const batches: ProjectFeedbackResponse["batches"] = [];
      const pages = root ? store.inRoot(root) : store.inProject(project.id);
      await Promise.all(pages.map((s) => peer.pull(s.file))); // together, so slow hosted pages wait once, not each
      for (const s of pages) {
        const { entries, fresh } = store.feedback(s, { all: !!body.all, peek: !!body.peek });
        if (fresh.length) {
          broadcastTranscript(s, fresh);
          broadcastPresence(s);
        }
        if (entries.length) batches.push({ file: s.file, copy: copyOf(s), archived: Boolean(s.archivedAt), missing: !fs.existsSync(s.file) || undefined, entries });
      }
      return send(res, 200, { project: project.name, batches } satisfies ProjectFeedbackResponse);
    }

    if (body.agentReply) return send(res, 400, { error: "a reply belongs to one page: use `reply <file> --agent-reply ...`" });
    const projectId = project.id;
    const poll: Poll = { res, startedAt: Date.now(), done: false, from: 0, project: projectId, root, after: seqParam(body.after) };
    const cursor = seqParam(body.cursor);
    const mine = covered(poll);
    if (cursor != null) {
      for (const s of mine) {
        const acked = store.ackDelivered(s, cursor);
        if (acked.length) broadcastTranscript(s, acked);
      }
    }
    for (const s of mine) {
      s.workingSince = null;
      dispatcher.pollArrived(s);
    }
    const [scope, key] = root ? [rootPolls, root] : [projectPolls, projectId];
    const existing = scope.get(key);
    if (existing && !existing.done) finishProjectPoll(existing, { status: "replaced" });
    const batches = projectBatches(poll);
    if (batches.length) return deliverProject(poll, batches);
    scope.set(key, poll);
    refreshWatch(projectId);
    // Pages can join the project without this server hearing of it (`project merge` in another process): look again now and then.
    poll.refresh = setInterval(() => rescanProjectPoll(poll), msEnv("AUSTERE_AXI_PROJECT_REFRESH_MS", PROJECT_REFRESH_MS) || PROJECT_REFRESH_MS);
    res.on("close", () => {
      if (poll.done) return;
      retireProjectPoll(poll);
      for (const s of store.inProject(projectId)) broadcastPresence(s);
    });
    const timeoutMs = Number(body.timeoutMs);
    if (timeoutMs > 0) {
      setTimeout(() => {
        if (!poll.done) finishProjectPoll(poll, { status: "timeout" });
      }, timeoutMs);
    }
    for (const s of mine) broadcastPresence(s);
  }

  /** Record the agent session a CLI command runs in and link it to the pages it works on (RLM-343). Never fails the request. */
  function noteCaller(caller: CallerReport | null, artifactIds: string[], action: SessionAction): void {
    if (!caller) return;
    try {
      registerSession(store.db, caller, { artifactIds, action });
    } catch (err) {
      log("session-register", String((err as Error).message));
    }
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
      // Settings → About says when a newer CLI talks to this server (the owner updated austere-axi but not the running server).
      const cli = req.headers["x-austere-cli"];
      if (typeof cli === "string" && /^\d+\.\d+\.\d+[\w.+-]{0,40}$/.test(cli) && versionGt(cli, newestCli ?? VERSION)) newestCli = cli;
    }
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
        lan: lanHost ?? undefined,
        tailnet: tailnet || undefined,
        remote: remoteBase() || undefined,
        persist: idleMs === 0,
        supervised: supervisorName ?? undefined,
        unit: runBy?.unit,
        addresses: addressSettings(),
      } satisfies HealthInfo);
    }
    // A health probe is not a user: a CLI that only checks, or a locked-out unit that probes
    // every few seconds, must not keep an idle server up.
    activity();
    if (route === "sessions") {
      return send(res, 200, {
        sessions: store.list().map((s) => ({
          ...publicSession(s),
          presence: presence(s),
          browsers: clientCount(s.id),
          pending: store.unread(s).length,
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
    if (route === "share/list") return send(res, 200, accessList(url.searchParams.get("links") === "1") satisfies ShareListResponse);
    if (route === "share/requests" && req.method === "GET") return send(res, 200, requestsList() satisfies AccessRequestsResponse);
    // `share default [hold|auto]`: the owner's default for a new reviewer's notes, as Settings → Review defaults sets it.
    if (route === "share/default" && req.method === "GET") return send(res, 200, { auto: requests.defaultAuto() });
    // `server lan`: the local-network switch of Settings → Network (RLM-399).
    if (route === "settings/lan" && req.method === "GET") return send(res, 200, settingsView().network.lan satisfies LocalNetwork);
    if (req.method !== "POST") return send(res, 405, { error: "POST expected" });
    const body = await readBody(req);
    // The agent session the command runs in (RLM-343); recorded once the route knows its pages.
    let caller: CallerReport | null;
    try {
      caller = parseCallerReport(body.session);
    } catch (err) {
      return send(res, 400, { error: String((err as Error).message) });
    }
    if (route === "share/default") {
      if (typeof body.auto !== "boolean") return send(res, 400, { error: "auto must be true or false" });
      requests.setDefaultAuto(body.auto);
      log("settings-review", body.auto ? "auto" : "hold");
      return send(res, 200, { auto: body.auto });
    }
    if (route === "share/revoke") {
      const done = revokeAccess(body.key);
      if (!done.revoked.length) return send(res, 404, { error: "no link or device matches that name or id" });
      return send(res, 200, done satisfies RevokeResponse);
    }
    if (route === "settings/lan") {
      const lan = body.lan;
      if (lan !== null && typeof lan !== "string") return send(res, 400, { error: "lan must be one of this computer's local-network addresses, or null" });
      const failed = await setLan(lan || null);
      if (failed) return send(res, 400, { error: failed });
      return send(res, 200, settingsView().network.lan satisfies LocalNetwork);
    }
    // `share tailscale <login> [file] [--project <p> | --all]`: let a Tailscale login in without a link (RLM-399).
    if (route === "share/tailscale") {
      let s: Session | null = null;
      if (typeof body.file === "string" && body.file) {
        const file = canonicalFile(body.file);
        if (!fs.existsSync(file)) return send(res, 404, { error: `no such file: ${file}` });
        try {
          s = store.ensure(file, typeof body.cwd === "string" && path.isAbsolute(body.cwd) ? body.cwd : undefined);
        } catch (err) {
          return send(res, 400, { error: String((err as Error).message || err) });
        }
      }
      const made = allowTailscale(s, body);
      return "error" in made ? send(res, made.status, { error: made.error }) : send(res, 200, made satisfies AccessSummary);
    }
    // Access requests (RLM-398): `share requests on|off [--project]`, `share approve|deny|block <id>`.
    if (route === "share/requests" || route === "share/approve" || route === "share/deny" || route === "share/block") {
      const done = route === "share/requests" ? changeRequestSwitch(body) : decideRequest(body.id, route.slice("share/".length), body);
      return "error" in done ? send(res, done.status, { error: done.error }) : send(res, 200, done);
    }
    // `attach on|off|inherit` at a terminal while this server runs: written here, so open owner tabs hear it.
    if (route === "attach") {
      let where: AttachWhere;
      if (typeof body.project === "string" && body.project && !body.file) {
        if (!store.db.prepare("SELECT 1 FROM projects WHERE id = ?").get(body.project)) return send(res, 404, { error: `no such project: ${body.project}` });
        where = { projectId: body.project };
      } else {
        const file = typeof body.file === "string" && body.file ? canonicalFile(body.file) : "";
        if (!file) return send(res, 400, { error: "file or project is required" });
        if (!fs.existsSync(file)) return send(res, 404, { error: `no such file: ${file}` });
        const s = store.ensure(file);
        where = { page: { artifactId: s.id, file: s.file } };
      }
      const change = body.change && typeof body.change === "object" ? (body.change as RequestBody) : {};
      const failed = changeAttach(where, change);
      if (failed) return send(res, failed.status, { error: failed.error, code: failed.code });
      return send(res, 200, { ok: true });
    }
    // A whole project: `poll` and `feedback` with no file.
    if ((route === "poll" || route === "feedback") && typeof body.project === "string" && body.project && !body.file) return projectRoute(route, body, res, caller);
    // Put away every copy whose file is gone (`archive --missing`): the CLI names a project by id, or none for all.
    if (route === "archive" && body.missing) {
      const copies = hub.missingCopies(typeof body.project === "string" ? body.project : "");
      const at = Date.now();
      for (const c of copies) setArchived(c.id, at);
      return send(res, 200, { ok: true, copies } satisfies ArchiveMissingResponse);
    }
    // A project's trigger runs (RLM-360): no page.
    if (route === "run/stop" && typeof body.project === "string") {
      let projectId: string | undefined;
      try {
        projectId = findProject(store.db, body.project)?.id;
      } catch (err) {
        return send(res, 400, { error: String((err as Error).message || err) });
      }
      if (!projectId) return send(res, 404, { error: `no project ${body.project}` });
      return send(res, 200, { ok: true, stopped: await triggers.stop(projectId) } satisfies RunStopResponse);
    }
    // One key per file however the caller spelled the path (symlinks, relative parts), so `open` and `archive` meet on the same session id.
    const file = typeof body.file === "string" && body.file ? canonicalFile(body.file) : "";
    if (!file) return send(res, 400, { error: "file is required" });
    // The folder the CLI ran in: a page without a project may take it as its root.
    const cwd = typeof body.cwd === "string" && path.isAbsolute(body.cwd) ? body.cwd : undefined;

    if (route === "share") {
      if (!fs.existsSync(file)) return send(res, 404, { error: `no such file: ${file}` });
      let s: Session;
      try {
        s = store.ensure(file, cwd);
      } catch (err) {
        return send(res, 400, { error: String((err as Error).message || err) });
      }
      const made = await createShare(s, body);
      if ("error" in made) return send(res, made.status, { error: made.error });
      return send(res, 200, made satisfies ShareResponse);
    }

    if (route === "open") {
      if (!fs.existsSync(file)) return send(res, 404, { error: `no such file: ${file}` });
      await ensureTailnetListener();
      // The first open of a page the hub has not had under review: say which pages of the project read alike.
      const firstOpen = !store.get(sessionId(file));
      const s = store.ensure(file, cwd);
      watch(s);
      rescanSharedPolls();
      store.touch(s);
      noteCaller(caller, [s.id], "open");
      const p = projectOfPage(s);
      // A bare poll from `cwd` covers its checkout only: the page's root must be that one.
      const project: OpenResponse["project"] = p && { name: p.name, ref: p.ref, here: cwd !== undefined && findRoot(hub.db, cwd) === store.rootOf(s) };
      return send(res, 200, {
        session: publicSession(s),
        links: links(s.id),
        browsers: clientCount(s.id),
        pending: store.unread(s).length,
        held: store.heldEntries(s).length,
        project,
        similar: firstOpen ? similarTo(s) : undefined,
      } satisfies OpenResponse);
    }

    if (route === "archive") {
      const done = archiveCopies(sessionId(file), !!body.every);
      return done ? send(res, 200, done) : send(res, 404, { error: "not in the hub" });
    }
    if (route === "unarchive") {
      if (!setArchived(sessionId(file), null)) return send(res, 404, { error: "not in the hub" });
      return send(res, 200, { ok: true });
    }

    if (route === "run/stop") {
      const s = store.byFile(file);
      const stopped = s ? await dispatcher.stop(s.id) : 0;
      return send(res, 200, { ok: true, stopped } satisfies RunStopResponse);
    }

    // A published page's notes may be waiting on the service: catch up first (for a file never opened here too).
    if (route === "feedback") await peer.pull(file);
    const s = store.byFile(file);
    const pageRoute = route === "reply" || route === "feedback" || route === "poll" ? route : null;
    if (pageRoute) noteCaller(caller, s ? [s.id] : [], pageRoute);
    if (!s) return send(res, 404, { error: "this page is not registered yet: run `austere-axi <file>` first" });

    if (route === "reply") {
      const text = String(body.text || "").trim();
      if (!text) return send(res, 400, { error: "reply text is empty" });
      const acked = acknowledge(s, body, true);
      // The reply and its addReply for a published file's hosted page commit together; when the page cannot take it yet, the reply stands here and the agent is told.
      let pushed: Promise<string | undefined> = Promise.resolve(undefined);
      const entry = store.tx(() => {
        const e = store.addAgentReply(s, text);
        pushed = peer.reply(s, text, { wait: true });
        return e;
      });
      s.workingSince = null;
      broadcastTranscript(s, [...acked, entry, ...s.transcript.filter((e) => e.role === "user" && e.doneAt === entry.at && !acked.includes(e))]);
      broadcastPresence(s);
      const warning = await pushed;
      return send(res, 200, { ok: true, warning });
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

    if (route === "poll") {
      const after = seqParam(body.after);
      dispatcher.pollArrived(s);
      const acked = acknowledge(s, body, !!body.agentReply);
      if (body.agentReply) {
        const entry = store.tx(() => {
          const e = store.addAgentReply(s, String(body.agentReply).trim());
          void peer.reply(s, e.text);
          return e;
        });
        broadcastTranscript(s, [...acked, entry, ...s.transcript.filter((e) => e.role === "user" && e.doneAt === entry.at && !acked.includes(e))]);
      } else if (acked.length) broadcastTranscript(s, acked);
      s.workingSince = null;
      // The newest listener wins: the older poll is told to stop.
      const existing = polls.get(s.id);
      if (existing && !existing.done) finishPoll(s, existing, { status: "replaced" });
      const poll: Poll = { res, startedAt: Date.now(), done: false, from: after ?? s.ackedSeq };
      if (store.after(s, poll.from).length) return deliver(s, poll);
      // Nothing waits and the page takes no notes: say so now rather than wait for nothing.
      if (s.archivedAt) return send(res, 200, { status: "archived" } satisfies PollResponse);
      polls.set(s.id, poll);
      peer.watch(s);
      res.on("close", () => {
        if (!poll.done) {
          poll.done = true;
          if (polls.get(s.id) === poll) polls.delete(s.id);
          peer.unwatch(s);
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

  // The runtime is 3 MB and compresses to a quarter: gzip once per build (kept
  // here, keyed by size and mtime) and answer a repeat request with 304, so a frame reload
  // after each revision does not fetch it again.
  const gzipped = new Map<string, { key: string; body: Promise<Buffer> }>();
  const COMPRESSIBLE = new Set([".js", ".css", ".json", ".md", ".svg"]);
  function gzipOf(file: string, key: string): Promise<Buffer> {
    const hit = gzipped.get(file);
    if (hit && hit.key === key) return hit.body;
    const body = fs.promises.readFile(file).then((buf) => new Promise<Buffer>((resolve, reject) => zlib.gzip(buf, { level: 9 }, (e, out) => (e ? reject(e) : resolve(out)))));
    body.catch(() => gzipped.delete(file));
    gzipped.set(file, { key, body });
    return body;
  }

  function serveAsset(req: http.IncomingMessage, res: http.ServerResponse, rel: string, url: URL): void {
    if (rel.startsWith("installed-packs/")) return serveInstalledPack(res, rel, url);
    const clean = path.normalize(rel).replace(/^(\.\.[/\\])+/, "");
    const file = path.join(ASSET_DIR, clean);
    if (!file.startsWith(ASSET_DIR + path.sep)) return send(res, 404, "not found");
    fs.stat(file, (err, st) => {
      if (err || !st.isFile()) return send(res, 404, "not found");
      const key = `${st.size.toString(36)}-${Math.floor(st.mtimeMs).toString(36)}`;
      const gzip = COMPRESSIBLE.has(path.extname(file)) && st.size > 1024 && /\bgzip\b/.test(String(req.headers["accept-encoding"] || ""));
      const etag = `"${key}${gzip ? "-gz" : ""}"`;
      const headers: http.OutgoingHttpHeaders = {
        "content-type": MIME[path.extname(file)] || "application/octet-stream",
        "cache-control": "no-cache",
        etag,
        vary: "accept-encoding",
        "x-content-type-options": "nosniff",
      };
      if (req.headers["if-none-match"] === etag) {
        res.writeHead(304, headers);
        return res.end();
      }
      if (!gzip) return streamFile(res, file, { ...headers, "content-length": st.size });
      gzipOf(file, key).then(
        (body) => {
          res.writeHead(200, { ...headers, "content-encoding": "gzip", "content-length": body.length });
          res.end(body);
        },
        () => send(res, 404, "not found"),
      );
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
   * One token per viewer, derived from the owner key and, for a device, its current secret's hash:
   * revoking, making single-use, or a later claim that replaces the secret all kill older tokens. The
   * token opens only what `serveArtifact` serves anyway.
   */
  function assetToken(s: Session, viewer: Viewer): string {
    const who = viewer.role === "owner" ? "owner" : `device:${viewer.deviceId}\0${viewer.credential}`;
    return crypto.createHmac("sha256", ownerToken).update(`austere-axi asset\0${s.id}\0${who}`).digest("base64url");
  }

  /** Does `token` belong to the owner or to a live device whose scope reaches this page? */
  function assetTokenValid(s: Session, token: string): boolean {
    let ok = safeEqual(token, assetToken(s, OWNER));
    const pid = store.projectIdOf(s);
    for (const row of devices.list()) {
      const credential = credentialOf(row);
      if (credential == null || !isLive(row) || !covers(row, s.id, pid)) continue;
      if (safeEqual(token, assetToken(s, { role: "reviewer", name: row.name, auto: Boolean(row.auto), deviceId: row.id, credential }))) ok = true;
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

  /** A `?project=` value (a project name, id, or folder inside a root) as a project id; one that matches nothing filters to nothing. */
  function projectParam(url: URL): { ref: string; id: string; name: string } {
    const ref = (url.searchParams.get("project") || "").slice(0, 1000);
    if (!ref) return { ref, id: "", name: "" };
    let p: ProjectRow | null = null;
    try {
      p = findProject(store.db, ref, { folders: path.isAbsolute(ref) });
    } catch {
      // an ambiguous name: no match
    }
    return p ? { ref, id: p.id, name: p.name } : { ref, id: "\0none", name: ref };
  }

  /** The `project` field of an answer: null for every project; `id` empty when `?project=` matched nothing. */
  function projectField(p: { ref: string; id: string; name: string }): { id: string; name: string; ref: string } | null {
    return p.ref ? { id: p.id === "\0none" ? "" : p.id, name: p.name, ref: p.ref } : null;
  }

  /** The hub (RLM-357): a client app over /hub/api, built like the review chrome (src/chrome/shell.ts). */
  function hubShell(): string {
    const boot = { version: VERSION, home: os.homedir(), sep: path.sep };
    return `<!doctype html>
<html lang="en" data-theme="dark">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="color-scheme" content="dark">
<title>austere-axi hub</title>
<link rel="stylesheet" href="/__austere/chrome/shell.css?v=${VERSION}">
<script>window.__AUSTERE_HUB__=${JSON.stringify(boot).replace(/</g, "\\u003c")}</script>
<script src="/__austere/chrome/shell.js?v=${VERSION}" defer></script>
</head>
<body><noscript>The hub needs JavaScript. <code>austere-axi hub list</code> and <code>austere-axi hub notes</code> show the same pages and notes.</noscript></body>
</html>`;
  }

  /** Whether an agent polls for a copy's notes, for the shell's attention fields. */
  function copyListening(id: string): boolean {
    const s = store.get(id);
    return Boolean(s && listener(s));
  }

  /**
   * The hub shell's data (RLM-356), the owner's only: GET /hub/api/projects, /pages?project=&view=open|all|archived,
   * /inbox?project=, /search?q=, /page/<copy id>, /notes?q=&status=&project=&author=&device=, /runs?project=;
   * POST /hub/api/page/<copy id>/archive (every open copy of the page) and /unarchive (every archived copy); with `{ids}`, exactly those copies of the page (Undo).
   */
  async function hubApi(req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<void> {
    // Every page and note: never for another site, GET included.
    if (!checkOrigin(req)) return send(res, 403, { error: "cross-origin request refused" });
    const route = url.pathname.slice("/hub/api/".length);
    const flip = /^page\/([a-f0-9]{12})\/(archive|unarchive)$/.exec(route);
    if (flip) {
      if (req.method !== "POST") return send(res, 405, { error: "POST expected" });
      const body = await readBody(req, 16 * 1024);
      const asked = Array.isArray(body.ids) ? body.ids.filter((x): x is string => typeof x === "string") : null;
      const archive = flip[2] === "archive";
      const ids = copiesToFlip(hub, flip[1], archive, asked);
      if (!ids) return send(res, 404, { error: "not in the hub" });
      const at = archive ? Date.now() : null;
      for (const id of ids) setArchived(id, at);
      return send(res, 200, { ok: true, ids } satisfies ArchiveResult);
    }
    if (route === "settings" || route.startsWith("settings/") || route.startsWith("projects/")) return hubSettings(req, res, route);
    if (req.method !== "GET" && req.method !== "HEAD") return send(res, 405, { error: "GET expected" });
    const project = projectParam(url);
    if (route === "projects") return send(res, 200, { projects: shellProjects(hub, copyListening) } satisfies ProjectsResponse);
    if (route === "pages") {
      const v = url.searchParams.get("view");
      const view: PagesView = v === "all" || v === "archived" ? v : "open";
      const pages = shellPages(hub, { project: project.id, view }, copyListening);
      return send(res, 200, { view, project: projectField(project), pages, counts: hub.viewCounts({ project: project.id }) } satisfies PagesResponse);
    }
    if (route === "inbox") return send(res, 200, { project: projectField(project), ...shellInbox(hub, { project: project.id }, copyListening) } satisfies InboxResponse);
    if (route === "search") return send(res, 200, shellSearch(hub, (url.searchParams.get("q") || "").slice(0, 200), copyListening) satisfies SearchResponse);
    const page = /^page\/([a-f0-9]{12})$/.exec(route);
    if (page) {
      const summary = copySummary(hub, page[1]);
      return summary ? send(res, 200, summary satisfies CopySummary) : send(res, 404, { error: "not in the hub" });
    }
    if (route === "notes") {
      const st = url.searchParams.get("status");
      // One person's notes by device (People links here), where two reviewers may share a name.
      const deviceId = (url.searchParams.get("device") || "").slice(0, 40);
      const rows = hub.notes({
        q: (url.searchParams.get("q") || "").slice(0, 200),
        project: project.id,
        author: (url.searchParams.get("author") || "").slice(0, 80),
        device: deviceId,
        status: st === "unanswered" || st === "answered" ? st : "",
      });
      const notes = rows.map((n) => ({ ...n, remote: Boolean(n.remote) }));
      const device = deviceId ? { id: deviceId, name: devices.get(deviceId)?.name ?? deviceId } : null;
      return send(res, 200, { notes, authors: hub.authors(), device, project: projectField(project) } satisfies NotesResponse);
    }
    if (route === "runs") return send(res, 200, { runs: shellRuns(hub, { project: project.id }), project: projectField(project) } satisfies HubRunsResponse);
    return send(res, 404, { error: "not found" });
  }

  /** Where the address teammates get comes from: the same order as reviewerBase(). Null: only this computer listens. */
  function shareAddress(): SettingsResponse["network"]["share"] {
    if (linkBase) return { url: linkBase.base, from: "link_url" };
    const host = remoteHost();
    if (!host) return lanHost ? { url: hostUrl(lanHost), from: "lan" } : null;
    const from = process.env.AUSTERE_AXI_LINK_HOST ? "link_host" : tailnet && listeners.has(tailnet.ip) ? "tailscale" : "host";
    return { url: `http://${host}:${port}`, from };
  }

  function settingsView(): SettingsResponse {
    const addresses = Array.from(listeners.keys()).map((host) => ({
      kind: host === "127.0.0.1" ? ("this_computer" as const) : host === tailnetBound ? ("tailscale" as const) : host === lanHost ? ("local_network" as const) : ("added" as const),
      host,
      url: hostUrl(host),
    }));
    const lanChosen = requests.lanAddress();
    // Who has which page open now: one entry per person per page, the owner's tabs as one.
    const viewing: SettingsResponse["review"]["viewing"] = [];
    for (const [id, set] of clients) {
      const seen = new Map<string, { name: string; role: "owner" | "reviewer" }>();
      for (const c of set) seen.set(c.viewer.role === "owner" ? "owner" : `r:${c.viewer.deviceId}`, { name: c.viewer.name, role: c.viewer.role });
      const a = seen.size ? hub.artifact(id) : null;
      if (a) viewing.push({ id, title: a.title || path.basename(a.file), file: a.file, viewers: [...seen.values()] });
    }
    return {
      network: {
        port,
        addresses,
        share: shareAddress(),
        tailscale: tailnet ? { ip: tailnet.ip, dns_name: tailnet.dnsName } : null,
        tailscale_names: tailnetBound != null,
        lan: { address: lanChosen, listening: lanChosen != null && lanHost === lanChosen, url: lanHost === lanChosen && lanHost ? hostUrl(lanHost) : null, choices: lanAddresses() },
        always_on: {
          mode: runBy ? "service" : idleMs === 0 ? "kept_on" : "idles",
          supervisor: supervisorName,
          unit: runBy?.unit ?? null,
          idle_minutes: idleMs ? Math.max(1, Math.round(idleMs / 60_000)) : null,
        },
      },
      review: { auto: requests.defaultAuto(), viewing },
      missing: hub.missingCopies().length,
      gone_folders: listProjects(hub.db).flatMap((p) => p.roots.filter((r) => !fs.existsSync(r.root)).map((r) => r.root)),
      about: { version: VERSION, state_dir: stateDir(), newer_cli: newestCli },
    };
  }

  /**
   * Settings (RLM-396), the owner's only: GET /hub/api/settings; POST /hub/api/settings/review {auto}; the
   * project commands of RLM-333 and RLM-389 (`project rename|merge|forget-root`, `archive --missing`), each as
   * the CLI does it: POST /hub/api/projects/<id>/rename {name}, /merge {from}, /forget-root {root, drop?}, and
   * POST /hub/api/projects/archive-missing {project?}. People is /hub/api/people (hubPeople).
   */
  async function hubSettings(req: http.IncomingMessage, res: http.ServerResponse, route: string): Promise<void> {
    if (route === "settings") {
      if (req.method !== "GET" && req.method !== "HEAD") return send(res, 405, { error: "GET expected" });
      // A Tailscale that came up or moved since the last check shows now, not in a minute.
      if (!fixedHost) await recheckTailnet();
      return send(res, 200, settingsView() satisfies SettingsResponse);
    }
    if (req.method !== "POST") return send(res, 405, { error: "POST expected" });
    const body = await readBody(req, 16 * 1024);
    const done = (message: string) => send(res, 200, { ok: true, message } satisfies ProjectActionResult);
    if (route === "settings/review") {
      if (typeof body.auto !== "boolean") return send(res, 400, { error: "auto must be true or false" });
      requests.setDefaultAuto(body.auto);
      log("settings-review", body.auto ? "auto" : "hold");
      return done(body.auto ? "New reviewers' notes go straight to the agent." : "New reviewers' notes wait for you.");
    }
    // The local network (P6): `{ lan: "<address>" }` listens there, `{ lan: null }` stops. `server lan` at a terminal does the same.
    if (route === "settings/network") {
      const lan = body.lan;
      if (lan !== null && typeof lan !== "string") return send(res, 400, { error: "lan must be one of this computer's local-network addresses, or null" });
      const failed = await setLan(lan || null);
      if (failed) return send(res, 400, { error: failed });
      return done(lan ? `Listening on the local network at ${hostUrl(lan)}: reviewers only, unencrypted.` : "Not listening on the local network.");
    }
    if (route === "projects/archive-missing") {
      const project = typeof body.project === "string" ? body.project : "";
      const copies = hub.missingCopies(project);
      const at = Date.now();
      for (const c of copies) setArchived(c.id, at);
      const waiting = copies.reduce((n, c) => n + c.unanswered, 0);
      return done(copies.length ? `Archived ${copies.length} missing ${copies.length === 1 ? "page" : "pages"}${waiting ? `, with ${waiting} unanswered ${waiting === 1 ? "note" : "notes"} (kept)` : ""}.` : "No page opened for review has a missing file.");
    }
    const m = /^projects\/([^/]{1,80})\/(rename|merge|forget-root)$/.exec(route);
    if (!m) return send(res, 404, { error: "not found" });
    const [, id, action] = m;
    const p = hub.db.prepare("SELECT id, name FROM projects WHERE id = ?").get(id) as { id: string; name: string } | undefined;
    if (!p) return send(res, 404, { error: "no such project" });
    try {
      if (action === "rename") {
        if (typeof body.name !== "string") return send(res, 400, { error: "name is required" });
        const renamed = renameProject(hub.db, p.id, body.name);
        log("project-rename", p.id, renamed.name);
        return done(`Renamed ${p.name} to ${renamed.name}.`);
      }
      if (action === "merge") {
        const from = typeof body.from === "string" ? (hub.db.prepare("SELECT id, name FROM projects WHERE id = ?").get(body.from) as { id: string; name: string } | undefined) : undefined;
        if (!from) return send(res, 400, { error: "from must be another project's id" });
        mergeProjects(hub.db, p.id, from.id);
        // Pages changed project: a reviewer scoped to the old project loses them now, not on the next request.
        recheckScopes();
        log("project-merge", p.id, from.id);
        return done(`Merged ${from.name} into ${p.name}.`);
      }
      // forget-root: only a root of this project, as the page lists them.
      const root = typeof body.root === "string" ? body.root : "";
      if (!listProjects(hub.db).find((x) => x.id === p.id)?.roots.some((r) => r.root === root)) return send(res, 400, { error: `not a root of ${p.name}` });
      const r = forgetRoot(hub.db, root, { drop: body.drop === true });
      recheckScopes();
      const at = Date.now();
      for (const file of r.archived) archivedInMemory(sessionId(file), at);
      log("project-forget-root", p.id, root, r.status);
      if (r.status === "dropped") return done(`Forgot ${root}. Its pages stay in ${r.project}, archived; their notes are kept.`);
      if (r.again) return done(`${root} is a folder of ${r.again.project} again at once: it has a .git, or pages right in it and no project folder above.`);
      return done(`Forgot ${root}.${r.went.length ? ` Its pages moved to the projects their folders belong to.` : ""}`);
    } catch (err) {
      return send(res, 400, { error: String((err as Error).message || err) });
    }
  }

  /**
   * Open an indexed artifact for review (it may never have had a session) and go to it. A copy whose file is gone gets its notes and an Archive button.
   * `?part=<statement>` opens the page outlining that part (a search hit); `?attach=1` opens its agent popover (the inbox's "Turn agent on").
   */
  function hubOpen(res: http.ServerResponse, id: string, url: URL): void {
    const a = /^[a-f0-9]{12}$/.test(id) ? hub.artifact(id) : null;
    if (!a) return send(res, 404, "not in the hub");
    if (!fs.existsSync(a.file)) {
      const project = (a.project_id ? findProject(hub.db, a.project_id, { folders: false })?.name : null) ?? a.project;
      const page = missingPage(a, { version: VERSION, project, label: a.root ? copyLabel(a.root) : "", notes: hub.notes({ artifact: a.id, limit: 500 }) });
      return send(res, 410, page, { "content-type": "text/html; charset=utf-8" });
    }
    const existed = store.byFile(a.file);
    const s = store.ensure(a.file);
    if (!existed) store.touch(s);
    const fragment = new URLSearchParams();
    const part = url.searchParams.get("part") || "";
    if (/^[A-Za-z_][\w$-]{0,199}$/.test(part)) fragment.set("part", part);
    if (url.searchParams.get("attach") === "1") fragment.set("attach", "1");
    res.writeHead(302, { location: `/s/${s.id}${fragment.size ? `#${fragment}` : ""}` });
    res.end();
  }

  /** The Archive button of a missing copy's page: put it away and go back to the home page. */
  function hubArchive(res: http.ServerResponse, id: string): void {
    const a = /^[a-f0-9]{12}$/.test(id) ? hub.artifact(id) : null;
    if (!a) return send(res, 404, "not in the hub");
    setArchived(a.id, Date.now());
    res.writeHead(303, { location: "/" });
    res.end();
  }

  /** Why a share link does not open page `s`, or "" when it does. */
  function linkRefusal(link: DeviceRow | null, s: Session): string {
    if (!link || !covers(link, s.id, store.projectIdOf(s))) return LINK_INVALID;
    const state = devices.linkState(link);
    return state === "claimed" ? LINK_USED : state === "expired" ? LINK_EXPIRED : state === "revoked" ? LINK_INVALID : "";
  }

  /**
   * People (RLM-397), for the hub's Settings → People (RLM-396): GET /hub/api/people lists the links
   * nobody has claimed and the devices; POST /hub/api/people/<id>/rename {name}, /scope {scope, page
   * or project}, /revoke, and /single-use (an old-style link gets a fresh single-use token).
   * Requests (RLM-398), for People → Waiting and the hub header's count: GET /hub/api/people/requests;
   * POST /hub/api/people/requests/switch {on, project?}; POST /hub/api/people/requests/<id>/approve
   * {scope?, project?, auto?, name?}, /deny, /block. Settings → People → New link: POST /hub/api/people/share
   * {page (a copy's id), name, scope?, project?, auto?} (auto left out: the owner's default). Settings →
   * Network → Names from Tailscale (RLM-399): POST /hub/api/people/tailscale {login, name?, scope (all or
   * project), project?, auto?} lets a Tailscale login in without a link. The owner's only.
   */
  async function hubPeople(req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<void> {
    // It holds the links: never for another site, GET included.
    if (!checkOrigin(req)) return send(res, 403, { error: "cross-origin request refused" });
    if (url.pathname === "/hub/api/people/requests") {
      if (req.method !== "GET" && req.method !== "HEAD") return send(res, 405, { error: "GET expected" });
      return send(res, 200, requestsList() satisfies AccessRequestsResponse);
    }
    const asked = /^\/hub\/api\/people\/requests\/(?:switch|(r[0-9a-f]{10})\/(approve|deny|block))$/.exec(url.pathname);
    if (asked) {
      if (req.method !== "POST") return send(res, 405, { error: "POST expected" });
      const body = await readBody(req, 16 * 1024);
      const done = asked[1] ? decideRequest(asked[1], asked[2], body) : changeRequestSwitch(body);
      return "error" in done ? send(res, done.status, { error: done.error }) : send(res, 200, done);
    }
    if (url.pathname === "/hub/api/people/share") {
      if (req.method !== "POST") return send(res, 405, { error: "POST expected" });
      const body = await readBody(req, 16 * 1024);
      const a = typeof body.page === "string" && /^[a-f0-9]{12}$/.test(body.page) ? hub.artifact(body.page) : null;
      if (!a) return send(res, 404, { error: "not in the hub" });
      if (!fs.existsSync(a.file)) return send(res, 409, { error: `the file is gone: ${a.file}` });
      const made = await createShare(store.ensure(a.file), body);
      return "error" in made ? send(res, made.status, { error: made.error }) : send(res, 200, made satisfies ShareResponse);
    }
    if (url.pathname === "/hub/api/people/tailscale") {
      if (req.method !== "POST") return send(res, 405, { error: "POST expected" });
      const made = allowTailscale(null, await readBody(req, 16 * 1024));
      return "error" in made ? send(res, made.status, { error: made.error }) : send(res, 200, made satisfies AccessSummary);
    }
    if (url.pathname === "/hub/api/people") {
      if (req.method !== "GET" && req.method !== "HEAD") return send(res, 405, { error: "GET expected" });
      return send(res, 200, accessList(true) satisfies ShareListResponse);
    }
    const m = /^\/hub\/api\/people\/(d[0-9a-f]{10})\/(rename|scope|revoke|single-use)$/.exec(url.pathname);
    if (!m) return send(res, 404, { error: "not found" });
    if (req.method !== "POST") return send(res, 405, { error: "POST expected" });
    const [, id, action] = m;
    const body = await readBody(req, 16 * 1024);
    const row = devices.get(id);
    if (!row || !isLive(row)) return send(res, 404, { error: "no live link or device with that id" });
    if (action === "revoke") return send(res, 200, revokeAccess(id) satisfies RevokeResponse);
    try {
      if (action === "rename") {
        const renamed = devices.rename(id, body.name);
        log("share-rename", id);
        return send(res, 200, accessSummary(renamed, true));
      }
      if (action === "scope") {
        let scope: Scope;
        if (body.scope === "all") scope = { kind: "all", id: null };
        else if (body.scope === "page" && typeof body.page === "string" && hub.artifact(body.page)) scope = { kind: "page", id: body.page };
        else if (body.scope === "project" && typeof body.project === "string" && findProject(hub.db, body.project, { folders: false })?.id === body.project) scope = { kind: "project", id: body.project };
        else return send(res, 400, { error: "scope is all, page with `page` (a page's id), or project with `project` (a project's id)" });
        // An unclaimed link opens on its page: a project that does not hold that page would leave a link that opens nowhere.
        if (row.claimed_at == null && scope.kind === "project" && row.link_page && hub.artifact(row.link_page)?.project_id !== scope.id) {
          return send(res, 400, { error: "this link opens on a page outside that project; revoke it and share a page of that project" });
        }
        const refused = row.auto ? autoAttachConflict(scope) : "";
        if (refused) return send(res, 409, { error: refused });
        const changed = devices.setScope(id, scope);
        // Every row: an old-style link's token is a live cookie too (claimed_at stays null); cutOff keeps the pages still covered.
        cutOff(id, changed);
        log("share-scope", id, scope.kind);
        return send(res, 200, accessSummary(changed, true));
      }
      const fresh = devices.makeSingleUse(id, typeof body.expiresAt === "number" && body.expiresAt > Date.now() ? body.expiresAt : undefined);
      // The old token was a cookie too: its open pages stop now, as on revoke.
      cutOff(id, null);
      log("share-single-use", id);
      return send(res, 200, accessSummary(fresh.row, true));
    } catch (err) {
      return send(res, 400, { error: String((err as Error).message || err) });
    }
  }

  async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<http.ServerResponse | void> {
    const url = new URL(String(req.url), "http://x");
    const host = hostOnly(req.headers.host);
    if (!hostsAllowed().has(host) && process.env.AUSTERE_AXI_ALLOWED_HOSTS !== "*") {
      return send(res, 403, "host not allowed");
    }
    // The local-network listener serves reviewers only (P7): no control route, no hub, and no owner
    // sign-in, link or cookie. An owner cookie sent there is refused and cleared.
    if (via(req) === "lan") {
      const ownerCookieSent = tokenFromCookie(req.headers.cookie, OWNER_COOKIE) != null;
      const ownerPath = url.pathname.startsWith("/api/") || url.pathname === "/" || url.pathname === "/notes" || url.pathname.startsWith("/hub/");
      if (ownerPath || ownerCookieSent || url.searchParams.has("key") || url.searchParams.has("login")) {
        return send(res, 403, LAN_NO_OWNER, ownerCookieSent ? { "set-cookie": `${OWNER_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0` } : {});
      }
    }
    if (url.pathname.startsWith("/api/")) return handleApi(req, res, url);
    if (url.pathname.startsWith("/__austere/")) return serveAsset(req, res, url.pathname.slice("/__austere/".length), url);
    // A browser POST from another site never reaches a page route, the hub's included.
    if (req.method === "POST" && !checkOrigin(req)) return send(res, 403, { error: "cross-origin request refused" });
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
    // The hub shows pages and opens reviews by link. It takes a POST for the Archive button of a missing copy, for People (/hub/api/people), and for the shell's archive (/hub/api/page/<id>/archive).
    const archiveId = req.method === "POST" && ownerOnly && url.pathname.startsWith("/hub/archive/") ? url.pathname.slice("/hub/archive/".length) : null;
    const people = ownerOnly && (url.pathname === "/hub/api/people" || url.pathname.startsWith("/hub/api/people/"));
    const api = ownerOnly && !people && url.pathname.startsWith("/hub/api/");
    if (ownerOnly && archiveId === null && !people && !api && req.method !== "GET" && req.method !== "HEAD") return send(res, 405, "method not allowed", { allow: "GET, HEAD" });
    // Owner browsing the hub keeps the server up.
    if (ownerOnly) activity();
    if (url.pathname === "/") return send(res, 200, hubShell(), { "content-type": "text/html; charset=utf-8" });
    // The Notes view moved into the shell; its old links (People's per-device link among them) keep their filters.
    if (url.pathname === "/notes") {
      url.searchParams.set("view", "notes");
      res.writeHead(302, { location: `/?${url.searchParams}` });
      return res.end();
    }
    if (archiveId !== null) return hubArchive(res, archiveId);
    if (url.pathname.startsWith("/hub/open/")) return hubOpen(res, url.pathname.slice("/hub/open/".length), url);
    if (api) return hubApi(req, res, url);
    if (people) return hubPeople(req, res, url);
    if (url.pathname === "/favicon.ico") return send(res, 204, "");

    const m = /^\/s\/([a-f0-9]{12})(\/.*)?$/.exec(url.pathname);
    if (!m) return send(res, 404, "not found");
    const s = store.get(m[1]);
    if (!s) return send(res, 404, "no such page");
    const sub = m[2] || "";
    activity();

    // A share link: ask before trading the link for a device, so a cross-site navigation cannot
    // switch a browser (e.g. the owner's) into a reviewer identity, or use up the link.
    const invite = url.searchParams.get("invite");
    if (invite != null && (sub === "" || sub === "/") && req.method === "GET") {
      const link = devices.findLink(invite);
      const refused = linkRefusal(link, s);
      if (refused || !link) return send(res, 403, refused);
      const once = link.reusable ? "" : "<p>This link works on one device only: the browser that continues becomes yours, and the link stops working.</p>";
      // The owner testing their own link would turn this browser into the reviewer on every page the link reaches.
      const owner = isOwner(req) ? `<p><strong>This browser is signed in as the page's owner.</strong> Continuing makes it ${escapeHtml(link.name)}'s device: the pages this link reaches then open as ${escapeHtml(link.name)} here. Send the link to ${escapeHtml(link.name)} instead.</p>` : "";
      return send(
        res,
        200,
        `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Join review</title><form method="post" action="/s/${s.id}/join"><input type="hidden" name="invite" value="${escapeHtml(invite)}">${owner}${once}<button>Continue as ${escapeHtml(link.name)}</button></form>`,
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
      const link = devices.findLink(new URLSearchParams(Buffer.concat(chunks).toString("utf8")).get("invite") || "");
      const refused = linkRefusal(link, s);
      if (refused || !link) return send(res, 403, refused);
      // Claimed once: a second browser racing the first gets null here. The cookie is a fresh secret, never the link token.
      const person = await tailnetPerson(req);
      const claimed = devices.claim(link, seenMeta(req, person));
      if (!claimed) return send(res, 403, LINK_USED);
      // Opened over the tailnet: the device is that login's from now on (identify). Else its address may have a hostname.
      const { device } = claimed;
      if (person) devices.bindLogin(device, person.login);
      else if (device.last_addr) lookUpHost(device.last_addr, (name) => devices.setHost(device.id, device.last_addr as string, name));
      log("share-claim", claimed.device.name, claimed.device.id);
      res.writeHead(303, {
        location: `/s/${s.id}`,
        // One cookie per device, so a second link claimed in this browser adds a device instead of replacing the first.
        "set-cookie": `${COOKIE}_${claimed.device.id}=${claimed.secret}; Path=/s/; HttpOnly; SameSite=Lax; Max-Age=${DEVICE_COOKIE_MAX_AGE}${overHttps(req) ? "; Secure" : ""}`,
        "cache-control": "no-store",
      });
      return res.end();
    }

    // The artifact frame's subresources carry no cookie (see assetToken); the token in the path is their credential.
    const tokened = /^\/a\/([A-Za-z0-9_-]{43})\/(.*)$/.exec(sub);
    if (tokened && (req.method === "GET" || req.method === "HEAD") && assetTokenValid(s, tokened[1])) {
      return serveArtifact(req, res, s, tokened[2]);
    }

    const asking = ((sub === "" || sub === "/") && req.method === "GET") || (sub === "/request" && (req.method === "GET" || req.method === "POST"));
    // A browser whose request the owner approved: its pending secret is traded for the device's cookie, once.
    if (asking && req.method === "GET") {
      const joined = collectApproval(req);
      if (joined) {
        if (sub === "/request") return send(res, 200, { state: "approved" }, { "set-cookie": joined });
        res.writeHead(303, { location: `/s/${s.id}`, "set-cookie": joined, "cache-control": "no-store" });
        return res.end();
      }
    }

    const person = await tailnetPerson(req);
    const who = identify(req, s, person);
    if (!who) {
      const presented = reviewerCookies(req.headers.cookie);
      // An unknown browser may ask for access where the owner turned requests on (RLM-398).
      if (!presented.length && asking && (await requestRoute(req, res, s, sub, person))) return;
      if (!presented.length) return send(res, 403, notOwner(req, "Ask the owner for a link to this page."));
      // A live device whose scope does not reach this page keeps its cookie: it still opens the pages it does reach.
      if (cookieDevices(req).length) return send(res, 403, "This page is not shared with you. Ask the owner for access to it.");
      return send(res, 403, "This device no longer has access. Ask the owner for a new link.", {
        // A device's cookie lives on /s/; an old-style invite's on its page.
        "set-cookie": presented.flatMap(({ name }) => [`${name}=; Path=/s/; HttpOnly; SameSite=Lax; Max-Age=0`, ...(name === COOKIE ? [`${name}=; Path=/s/${s.id}; HttpOnly; SameSite=Lax; Max-Age=0`] : [])]),
      });
    }
    // Reviewers read the page and the conversation and add notes. Everything else is the owner's.
    const reviewer = who.role === "reviewer";
    if (reviewer && !(sub === "" || sub === "/" || sub.startsWith("/a/") || sub === "/events" || sub === "/transcript" || sub === "/send")) {
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
        if (open.length >= SSE_MAX_PER_SESSION || open.filter((c) => c.viewer.deviceId === who.deviceId).length >= SSE_MAX_PER_REVIEWER) {
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
        ...presenceInfo(s),
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
      // The owner sees who is on the hosted page (Q17): the roster so far, then each change.
      if (!reviewer) {
        for (const hello of peer.roster(s)) res.write(viewerEvent(hello));
        peer.watch(s);
      }
      const hb = setInterval(() => res.write(": hb\n\n"), 20_000);
      res.on("close", () => {
        clearInterval(hb);
        clients.get(s.id)?.delete(client);
        if (!reviewer) peer.unwatch(s);
      });
      return;
    }

    if (sub === "/send" && req.method === "POST") {
      const body = await readBody(req, 4 * 1024 * 1024);
      const end = !reviewer && !!body.end;
      let items: NoteItem[] = Array.isArray(body.items) ? body.items.filter((x: unknown) => x && typeof x === "object").slice(0, reviewer ? 50 : 200) : [];
      if (reviewer) items = items.filter((x) => REVIEWER_KINDS.has(x.kind)).map(reviewerItem);
      if (s.archivedAt) return send(res, 409, { error: "this page is archived; unarchive it to add notes" });
      // The owner's Done: an empty final batch only tells the agent there are no more notes.
      if (!items.length && !end) return send(res, 400, { error: "nothing to send" });
      // The server decides who wrote a note. A reviewer's own item id could overwrite another note in the hub.
      for (const it of items) {
        delete it.author;
        it.id = reviewer || !it.id ? newId("i") : it.id;
      }
      const hold = reviewer && !who.auto;
      if (hold && store.heldEntries(s).filter((e) => wroteIt(e, who)).length >= MAX_HELD_PER_REVIEWER) return send(res, 429, { error: "too many notes awaiting the owner; wait for them to be released" });
      const entry = store.addUserBatch(s, items, { end, author: who.name, deviceId: reviewer ? who.deviceId : "", hold });
      broadcastTranscript(s, [entry]);
      wakeOrRun(s, !reviewer);
      broadcastPresence(s);
      return send(res, 200, { ok: true, entry });
    }
    if (sub === "/render-errors" && req.method === "POST") {
      const body = await readBody(req);
      // A report for an older revision describes a program the agent has already replaced.
      if (s.archivedAt || body.revision !== s.revision) return send(res, 200, { ok: true, count: 0, stale: true });
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
      // Notes from a hosted page: the page hears it too, so the owner's other machines follow. The change and its mutation commit together.
      const done = store.tx(() => {
        const d = sub === "/release" ? store.release(s, ids) : store.discard(s, ids);
        peer.settled(d, sub === "/release" ? "releaseNote" : "discardNote", s);
        return d;
      });
      if (done.length) broadcastTranscript(s, done);
      if (sub === "/release") wakeOrRun(s, done.length > 0);
      broadcastPresence(s);
      return send(res, 200, { ok: true, count: done.length });
    }
    // The menu's Archive asks first what it would do (GET: it names other copies, so not for another site), then archives
    // this copy or, with `every`, each copy of the page.
    if (sub === "/archive" && (req.method === "GET" || req.method === "POST")) {
      if (!checkOrigin(req)) return send(res, 403, { error: "cross-origin request refused" });
      let done: ArchiveResponse | null;
      if (req.method === "GET") {
        const plan = hub.archivePlan(s.id);
        done = plan && { ok: true, ...plan };
      } else done = archiveCopies(s.id, !!(await readBody(req)).every);
      return done ? send(res, 200, done) : send(res, 404, { error: "not in the hub" });
    }
    if (sub === "/unarchive" && req.method === "POST") {
      if (!setArchived(s.id, null)) return send(res, 404, { error: "not in the hub" });
      return send(res, 200, { ok: true });
    }
    // History (RLM-352): the owner's only, as reviewers are refused above. GET lists a page's revisions, or with `statement` one
    // statement's earlier texts; both name the owner's notes, so a foreign Origin is refused.
    if (sub === "/history" && req.method === "GET") {
      if (!checkOrigin(req)) return send(res, 403, { error: "cross-origin request refused" });
      const statement = url.searchParams.get("statement");
      const html = readFileSafe(s.file);
      if (statement) return send(res, 200, { statement, versions: statementVersions(store.db, s.id, statement.slice(0, 200), html) });
      const revisions = revisionLog(store.db, s.id, { limit: 100 }).map((r) => ({
        rev: r.rev,
        at: r.at,
        source: r.source,
        changed: r.changed,
        removed: r.removed,
        created: r.created,
        cause: r.cause.map((n) => ({ author: n.author, target: n.target, text: n.text.slice(0, 300) })),
        by: agentLabel(store.db, r.agent_session_id),
      }));
      return send(res, 200, { head: headRev(store.db, s.id), viewed: viewedRev(store.db, s.id), revisions });
    }
    if (sub === "/viewed" && req.method === "POST") {
      if (!checkOrigin(req)) return send(res, 403, { error: "cross-origin request refused" });
      const rev = Number((await readBody(req, 1024)).rev);
      if (!Number.isInteger(rev) || rev < 0) return send(res, 400, { error: "rev must be a whole number" });
      setViewedRev(store.db, s.id, Math.min(rev, headRev(store.db, s.id)));
      return send(res, 200, { ok: true, viewed: viewedRev(store.db, s.id) });
    }
    if (sub === "/restore" && req.method === "POST") {
      if (!checkOrigin(req)) return send(res, 403, { error: "cross-origin request refused" });
      if (s.archivedAt) return send(res, 409, { error: "this page is archived; unarchive it to change it" });
      const body = await readBody(req, 16 * 1024);
      const rev = Number(body.rev);
      const names: string[] = Array.isArray(body.statements) ? body.statements.map(String).slice(0, 50) : [];
      const old = Number.isInteger(rev) ? revisionAt(store.db, s.id, rev) : null;
      if (!old) return send(res, 404, { error: `this page has no revision ${body.rev}` });
      const missing = names.filter((n) => !statementMap(old.program).has(n));
      if (missing.length) return send(res, 404, { error: `revision ${rev} has no statement ${missing.join(", ")}` });
      const html = readFileSafe(s.file);
      const current = html == null ? null : readArtifact(html).program;
      if (html == null || current == null) return send(res, 409, { error: "the page's file cannot be read" });
      // The same patch path as `austere-axi restore`; the file watcher then tells every open page.
      let merged: string | null;
      try {
        merged = restoredProgram(current, old.program, names);
      } catch (err) {
        return send(res, 409, { error: String((err as Error).message || err) });
      }
      if (merged === null) return send(res, 200, { ok: true, unchanged: true });
      const next = replaceProgram(html, merged);
      // Recorded before the write, as the CLI does: the watcher then finds nothing left to record as its own.
      const done = recordHistory(s, next, "restore");
      fs.writeFileSync(s.file, next);
      return send(res, 200, { ok: true, rev: done?.rev ?? headRev(store.db, s.id) });
    }
    // The menu's Share (RLM-397): a named link for this page, its project, or every page. The owner's only, as reviewers are refused above.
    if (sub === "/share" && req.method === "POST") {
      const made = await createShare(s, await readBody(req, 16 * 1024));
      if ("error" in made) return send(res, made.status, { error: made.error });
      return send(res, 200, made satisfies ShareResponse);
    }
    // What the Share dialog offers: the page's project, when it has one, and the owner's default for notes (Settings).
    if (sub === "/share" && req.method === "GET") {
      if (!checkOrigin(req)) return send(res, 403, { error: "cross-origin request refused" });
      const p = projectOfPage(s);
      return send(res, 200, { project: p ? { id: p.id, name: p.name } : null, remote: Boolean(reviewerBase()), auto: requests.defaultAuto() });
    }
    // The attach popover and the run panel (RLM-346): the owner's only, as reviewers are refused above.
    // A GET from a foreign Origin is refused too: it lists the page's agent sessions.
    if ((sub === "/attach" || sub === "/runs" || sub.startsWith("/run/")) && !checkOrigin(req)) return send(res, 403, { error: "cross-origin request refused" });
    if (sub === "/run/stop" && req.method === "POST") {
      const stopped = await dispatcher.stop(s.id);
      return send(res, 200, { ok: true, stopped } satisfies RunStopResponse);
    }
    if (sub === "/run/retry" && req.method === "POST") {
      // Retry is the owner's act: a failed run is never retried on its own.
      const r = dispatcher.retry(s.id);
      if ("error" in r) return send(res, 409, { error: r.error });
      return send(res, 200, { ok: true, run: summary(r.run) });
    }
    const logRoute = /^\/run\/(r[a-f0-9]{12})\/log$/.exec(sub);
    if (logRoute && req.method === "GET") {
      const row = getRun(store.db, logRoute[1]);
      if (!row || row.artifact_id !== s.id) return send(res, 404, { error: "no such run on this page" });
      return send(res, 200, { run: summary(row), tail: logTail(row.log_file, LOG_TAIL_LINES) } satisfies RunLogResponse);
    }
    if (sub === "/runs" && req.method === "GET") {
      const limit = Math.min(50, Math.max(1, Number(url.searchParams.get("limit")) || 20));
      return send(res, 200, { runs: listRuns(store.db, { artifactId: s.id }, limit).map(summary) } satisfies RunsResponse);
    }
    if (sub === "/attach" && req.method === "GET") return send(res, 200, await attachInfo(s));
    if (sub === "/attach" && req.method === "POST") {
      const failed = changeAttach({ page: { artifactId: s.id, file: s.file } }, await readBody(req, 4096));
      if (failed) return send(res, failed.status, { error: failed.error, code: failed.code });
      return send(res, 200, await attachInfo(s));
    }
    if (sub === "/presence" && req.method === "POST") {
      // The owner's own status and focus for the hosted page's viewers; nothing happens when the file is not published.
      const parsed = parseClientFrame(await readBody(req, 4096));
      if (!parsed.ok || parsed.value.t === "mutation" || parsed.value.t === "pull") return send(res, 400, { error: "a presence frame is expected" });
      peer.presenceFrom(s, parsed.value);
      return send(res, 204, "");
    }
    if (sub === "/agent-prompt" && req.method === "GET") {
      // The owner's only (reviewers are refused above). cloud.json is read again: `publish` may have run since the page opened.
      const state = readCloud();
      const entry = state.token ? state.pages[s.file] : undefined;
      const hosted = entry ? { url: `${state.url || cloudUrl()}/p/${entry.id}`, auto: peer.liveAuto(entry.id, entry.auto) } : undefined;
      const p = projectOfPage(s);
      // An agent already polls this project (a second project poll would replace it) or this page's checkout (it would keep
      // the page from a project poll): the prompt names the page poll, which takes only this page.
      const shared = p ? projectPolls.get(p.id) : undefined;
      const project = p && !(shared && !shared.done) && !sharedListener(s) ? { name: p.name, ref: p.ref } : undefined;
      return send(res, 200, agentPrompt({ file: s.file, hosted, project }));
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
      // Which listener accepted a connection decides what it may do (via): the owner never on the local network's, whois only on the tailnet's.
      server.on("connection", (socket: net.Socket) => boundHost.set(socket, host));
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

  /** AUSTERE_AXI_HOST, when it names one address: the server listens there instead of on the tailnet. */
  const fixedHost = process.env.AUSTERE_AXI_HOST && !/^(0\.0\.0\.0|::|\*)$/.test(process.env.AUSTERE_AXI_HOST) ? process.env.AUSTERE_AXI_HOST : null;
  /** The tailnet address the server listens on, kept apart from `tailnet` (what Tailscale said last), so a move always lets go of it. */
  let tailnetBound: string | null = null;
  let stopping = false;

  async function ensureTailnetListener(): Promise<void> {
    if (fixedHost) {
      await listen(fixedHost);
      return;
    }
    await followTailnet(await detectTailscale(), false);
  }

  /** Whether a connection to `host` on this port is accepted, within 2 s. */
  function accepts(host: string): Promise<boolean> {
    const { promise, resolve } = Promise.withResolvers<boolean>();
    const socket = net.connect({ host, port, timeout: 2000 });
    socket.once("connect", () => resolve(true));
    socket.once("timeout", () => resolve(false));
    socket.once("error", () => resolve(false));
    return promise.finally(() => socket.destroy());
  }

  /**
   * Listen on the address Tailscale has now (`now`), and let go of one it no longer has. `probe`
   * also listens again when the listener there no longer accepts (Tailscale restarted under it).
   * While Tailscale does not answer, the listeners stay: its address comes back with it.
   */
  async function followTailnet(now: Tailnet | null, probe: boolean): Promise<void> {
    if (!now || stopping) return;
    tailnet = now;
    if (tailnetBound && tailnetBound !== now.ip) {
      if (!alsoListen.includes(tailnetBound)) {
        listeners.get(tailnetBound)?.close();
        listeners.delete(tailnetBound);
        log("tailnet", `left ${tailnetBound}`);
      }
      tailnetBound = null;
    }
    const current = listeners.get(now.ip);
    if (probe && current && !(await accepts(now.ip))) {
      current.close();
      listeners.delete(now.ip);
      log("tailnet", `${now.ip} stopped accepting; listening again`);
    }
    if (!listeners.has(now.ip) && !stopping) await listen(now.ip);
    if (listeners.has(now.ip)) tailnetBound = now.ip;
  }

  /** Ask Tailscale again: it may have come up after the server (a service started at boot), restarted under it, or moved. */
  async function recheckTailnet(): Promise<void> {
    await followTailnet(await detectTailscale({ fresh: true }), true);
  }

  /**
   * Settings → Network → Local network (P6): listen on `address`, one of this machine's local-network
   * addresses (lanAddresses), or stop (null). The choice is kept in hub.db, so a later server listens
   * there too. The error in words, or "".
   */
  async function setLan(address: string | null): Promise<string> {
    if (address !== null && !lanAddresses().some((a) => a.address === address)) return `${address} is not an address of this computer on a local network`;
    if (lanHost && lanHost !== address) leaveLan(lanHost);
    if (address && lanHost !== address) {
      const failed = await joinLan(address);
      if (failed) return failed;
    }
    requests.setLanAddress(address);
    log("settings-lan", address ?? "off");
    return "";
  }

  /** Listen on the local-network address. It counts as the local network's before the first connection can arrive. */
  async function joinLan(address: string): Promise<string> {
    lanHost = address;
    if (await listen(address)) return "";
    lanHost = null;
    return `could not listen on ${address}:${port}`;
  }

  /**
   * Stop listening on the local network. An address also given at a terminal (`--also-listen`,
   * `AUSTERE_AXI_HOST`) keeps its listener; either way, every connection made there ends now.
   */
  function leaveLan(address: string): void {
    lanHost = null;
    const server = listeners.get(address);
    if (!alsoListen.includes(address) && address !== fixedHost) {
      server?.close();
      listeners.delete(address);
    }
    server?.closeAllConnections();
    log("lan", `left ${address}`);
  }

  const ok = await listen("127.0.0.1");
  if (!ok) {
    store.close();
    releaseLock();
    throw new Error(`could not listen on 127.0.0.1:${port} (is another server using it? set AUSTERE_AXI_PORT)`);
  }
  // The local network, when Settings switched it on: unless this computer no longer has that address
  // (another network, a new lease). The setting stays; Settings says the server is not listening there.
  const savedLan = requests.lanAddress();
  if (savedLan && lanAddresses().some((a) => a.address === savedLan)) await joinLan(savedLan);
  else if (savedLan) log("lan", `${savedLan} is not an address of this computer now`);
  for (const h of alsoListen) await listen(h);
  await ensureTailnetListener();
  const tailnetCheckMs = msEnv("AUSTERE_AXI_TAILNET_CHECK_MS", 60_000);
  if (!fixedHost && tailnetCheckMs > 0) {
    let checking = false;
    setInterval(() => {
      if (checking) return;
      checking = true;
      void recheckTailnet().finally(() => {
        checking = false;
      });
    }, Math.min(tailnetCheckMs, MAX_TIMER_MS)).unref();
  }

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
    for (const poll of [...rootPolls.values(), ...projectPolls.values()]) finishProjectPoll(poll, { status: "interrupted", reason });
    for (const id of watchers.keys()) unwatch(id);
    peer.close();
    for (const server of listeners.values()) server.close();
    // The runs' process trees go first (dispatcher.close waits for them): until then a harness could
    // still write the page, so the lock stays. Everything else is on disk; then a replacement server can take the state dir.
    void Promise.all([dispatcher.close(), triggers.close()]).finally(() => {
      releaseLock();
      setTimeout(() => {
        store.close();
        process.exit(0);
      }, 100).unref();
    });
  }

  if (idleMs > 0) {
    let checking = false;
    setInterval(() => {
      // A run or an attach is written by another process, so the check reads the database with
      // a connection of its own; the server's own connection may hold an older snapshot.
      if (checking) return;
      checking = true;
      void activeWorkNow()
        .then((working) => {
          // A trigger is waiting for its project to go quiet: the server stays to run it.
          const busy = polls.size > 0 || rootPolls.size > 0 || projectPolls.size > 0 || Array.from(clients.values()).some((set) => set.size > 0) || working || triggersConfigured();
          if (busy) activity();
          else if (Date.now() - lastActivity > idleMs) shutdown("idle");
        })
        .finally(() => {
          checking = false;
        });
    }, Math.min(60_000, idleMs)).unref();
  }
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  log("started", `v${VERSION}`, `pid=${process.pid}`);
  dispatcher.start();
  // After the dispatcher, which marks the runs a restart interrupted: the scheduler gives back what they consumed.
  triggers.start();
  peer.start();
  return { port, shutdown };
}
