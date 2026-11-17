// Review chrome: artifact frame + conversation panel. Plain DOM, no framework.

// The local server inlines the boot object as window.__AUSTERE__. The hosted
// service's CSP forbids inline scripts, so it ships the same object as JSON in
// <script type="application/json" id="austere-boot">.

import "./zod-jitless.ts";
import { LIMITS, SYNC_VERSION, mutation, parseServerFrame, syncProtocols } from "../shared/sync.ts";
import type { AckFrame, AddNoteArgs, ClientPresence, Mutation, NoteAnnotation, NoteItem, PageRow, ReceivedChanges, ReceivedFrame } from "../shared/sync.ts";
import { Presence } from "./presence.ts";
import { openSyncSocket } from "./sync-socket.ts";
import type { SyncClose, SyncSocket } from "./sync-socket.ts";
import { LOADER_TAG, packedTag } from "../shared/standalone.ts";

type Mode = "annotate" | "explore";

/** The boot object the server hands the page. */
interface Boot {
  id: string;
  title: string;
  name: string;
  file: string;
  version?: string;
  artifactUrl?: string;
  hosted?: { base?: string; report?: string; publishedAt?: number } | null;
  viewer?: { role: string; name: string; auto?: boolean };
}

/** A queued note. Items come from the frame (untrusted), localStorage or the server. */
interface QueueItem {
  kind: string;
  qid?: string;
  target?: string;
  component?: string;
  note?: string;
  text?: string;
  selection?: string;
  excerpt?: string;
  message?: string;
  statement?: string;
  detail?: { part?: unknown; row?: unknown; column?: unknown; [key: string]: unknown };
  form?: Record<string, unknown>;
  path?: unknown;
}

/** A transcript entry: an agent reply or a batch of notes. */
interface Entry {
  id: string;
  role: string;
  at: number;
  text?: string;
  author?: string;
  items?: QueueItem[];
  held?: boolean;
  end?: boolean;
  seenAt?: number;
  workAt?: number;
  doneAt?: number;
  discarded?: boolean;
  /** Hosted: a note still waiting for its ack. */
  pending?: boolean;
}

/** A parser or render error the frame reports. */
interface RenderIssue {
  statementId?: string;
  message: string;
  severity?: string;
}

/** Messages the frame posts over the review bridge. Frame code is untrusted. */
type FrameMessage = { austere: 1 } & (
  | { type: "hello" }
  | { type: "ready"; title?: string }
  | { type: "annotate" | "action"; item: unknown }
  | { type: "errors"; errors?: RenderIssue[] }
  | { type: "runtime-error"; error?: RenderIssue }
  | { type: "state"; state: unknown }
  | { type: "scroll"; y?: number }
  | { type: "changes"; ids?: unknown }
  | { type: "toggle-mode" }
  | { type: "focus"; id?: unknown }
  | { type: "writing"; on?: unknown }
  | { type: "open-url"; url: unknown }
);

/** Messages the chrome posts to the frame. */
type ChromeMessage =
  | { type: "init"; mode: Mode; state: unknown; scrollY: number }
  | { type: "reveal"; id: string | undefined }
  | { type: "mode"; mode: Mode }
  | { type: "highlight"; ids: string[]; scroll: boolean }
  | { type: "presence"; marks: { statement: string; name: string; colour: string }[] }
  | { type: "source"; program: string };

interface SessionInfo {
  archived?: boolean;
  unread?: number;
}

/** A copy of the page in `/archive`'s answer (ArchiveCopy in src/cli/hub.ts). */
interface ArchiveCopy {
  file: string;
  copy: string;
  unanswered: number;
}

/** `/archive`: this copy's label, the copies archiving takes and the copies that stay open (ArchivePlan in src/cli/hub.ts). */
interface ArchivePlan {
  copy: string;
  archived: ArchiveCopy[];
  others: ArchiveCopy[];
}

interface SnapshotEvent {
  transcript?: Entry[];
  presence: string;
  session: SessionInfo;
  more?: boolean;
  links: { remote?: string } | null;
  version?: string;
  thirdPartyPacks?: string[];
  program: string;
  revision: number;
}

interface PresenceEvent extends SessionInfo {
  presence: string;
}

interface ChangedEvent {
  program: string;
  revision: number;
  shellChanged?: boolean;
  thirdPartyPacks?: string[];
}

/** A run of the attached agent, as the server sums it up (RunSummary in src/cli/dispatch.ts). */
interface RunSummary {
  id: string;
  status: "queued" | "waiting_for_session" | "running" | "done" | "failed" | "stopped" | "interrupted";
  reason: string | null;
  mode: string | null;
  harness: string | null;
  model: string | null;
  started_at: number | null;
  ended_at: number | null;
}

/** The owner's `run` event. */
interface RunEvent {
  run: RunSummary;
  message?: string;
  tail?: string[];
}

/** A run's start or end in the Conversation panel. */
interface RunMark {
  id: string;
  at: number;
  text: string;
  tone: "start" | "done" | "failed" | "stopped";
}

type AttachModeId = "same" | "fork" | "new";
type Capability = { ok: true } | { ok: false; reason: string };

/** A row of attach_settings. */
interface AttachRow {
  state: "on" | "off" | "inherit";
  mode: AttachModeId | null;
  session: string | null;
  harness: string | null;
  model: string | null;
}

/** GET /s/:id/attach (AttachInfo in src/cli/server.ts). */
interface AttachInfo {
  effective: { state: "on" | "off"; source: "page" | "project" | "default"; mode: AttachModeId; session: string; harness: string; model: string | null };
  page: AttachRow | null;
  project: { name: string; setting: AttachRow | null } | null;
  target: { mode: AttachModeId; harness: string; session: string | null };
  author: { id: string; harness: string; short: string } | null;
  sessions: { id: string; harness: string; short: string; roles: string[]; lastSeen: number; liveness: string }[];
  harnesses: Record<string, { found: boolean; capabilities: Record<AttachModeId | "model", Capability>; writeGrant: boolean; grantCommand?: string; models?: string[] }>;
  run: RunSummary | null;
  sessionFileSize: number | null;
  warnings: string[];
  auto: string | null;
}

/** What the popover changes: the state, or one field of the page's own row. */
interface AttachChange {
  state?: AttachRow["state"];
  mode?: AttachModeId;
  session?: string;
  harness?: string;
  model?: string | null;
}

interface ItemOptions {
  queued?: boolean;
  held?: boolean;
}

type AttrValue = string | boolean | null | undefined | ((e: Event) => unknown);
type Child = Node | string | number | null | undefined | false;

const BOOT: Boot = (window as Window & { __AUSTERE__?: Boot }).__AUSTERE__ ?? JSON.parse(document.getElementById("austere-boot")?.textContent || "{}");
const SID = BOOT.id;
// Hosted mode (austere-cloud, docs/hosted-share-links.md): a reviewer page that syncs over the
// page's WebSocket instead of the local event stream and has no owner controls.
const HOSTED = BOOT.hosted || null;
const BASE = BOOT.hosted?.base ?? `/s/${SID}`;
const VIEWER = BOOT.viewer || { role: "owner", name: "" };
const OWNER = !HOSTED && VIEWER.role === "owner";
const NAME_MAX = LIMITS.nameChars;
const LS = {
  get<T>(key: string, fallback: T): T {
    try {
      const v = localStorage.getItem(key);
      return v == null ? fallback : JSON.parse(v);
    } catch {
      return fallback;
    }
  },
  set(key: string, value: unknown) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch {
      // storage full or blocked; state stays in memory
    }
  },
  remove(key: string) {
    try {
      localStorage.removeItem(key);
    } catch {
      // blocked storage
    }
  },
};
const SS = {
  get<T = unknown>(key: string): T | null {
    try {
      return JSON.parse(sessionStorage.getItem(key) || "null");
    } catch {
      return null;
    }
  },
  /** False when the write failed (blocked storage, quota). */
  set(key: string, value: unknown): boolean {
    try {
      sessionStorage.setItem(key, JSON.stringify(value));
      return true;
    } catch {
      return false;
    }
  },
};

// Hosted pages are invite-only by default (Q16). An invite link carries its token in the fragment,
// `#i=<token>`, which never reaches the server: keep it for this page and take it out of the address
// bar. Same-origin calls send it as X-Austere-Invite, the socket as a subprotocol.
const INVITE_KEY = `austere:invite:${SID}`;
const TOKEN = /^[A-Za-z0-9_-]{16,256}$/;
let invite: string | null = null;
if (HOSTED) {
  const fromLink = new URLSearchParams(location.hash.slice(1)).get("i");
  if (fromLink !== null) history.replaceState(null, "", location.pathname + location.search);
  if (fromLink !== null && TOKEN.test(fromLink)) {
    // The link's token is used as given; storing it only lets a reload without the fragment reuse it.
    invite = fromLink;
    LS.set(INVITE_KEY, fromLink);
  } else {
    const stored = LS.get<unknown>(INVITE_KEY, null);
    invite = typeof stored === "string" && TOKEN.test(stored) ? stored : null;
  }
  // Another invite link opened in this tab changes only the fragment, so the page does not load
  // again by itself: reload, keeping the fragment, so the intake above takes it (and strips it).
  window.addEventListener("hashchange", () => {
    if (new URLSearchParams(location.hash.slice(1)).has("i")) location.reload();
  });
}
// Hosted: the invite's name from the asset-token answer; null on an unlisted page without a valid
// invite (the reviewer names themself once, with the prompt); undefined until the service answers.
let inviteName: string | null | undefined;
// The local server names invited reviewers; a hosted reviewer is named once the service answers.
let viewerName: string = HOSTED ? "" : VIEWER.name;

// Hosted: notes go out as `addNote` mutations over the page's socket. A note stays in the outbox
// (sessionStorage) until its ack and is re-sent after a reconnect or a reload, under its own key.
interface OutboxEntry {
  m: Mutation<"addNote">;
  at: number;
  /** Who sent it (`sender()`): a note is only ever re-sent by that same reviewer. */
  as: string;
  /** Epoch ms before which it must not be sent again (a `rate_limited` answer's `retryAfter`). */
  retryAt?: number;
}
// New notes are numbered under a clientId made for this page load and kept only in memory, with a
// counter from 1. Nothing about it is read back from storage, so a duplicated tab (which copies
// sessionStorage) or a failed write can never number two different notes with the same (clientId, n).
let CLIENT = "";
if (HOSTED) {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  CLIENT = btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
const OUTBOX_KEY = `austere:outbox:${SID}`;
const savedOutbox = SS.get<unknown>(OUTBOX_KEY);
// Saved notes keep the (clientId, n) they were numbered with by an earlier load: re-sent under their
// own key, they are applied once (also when a duplicated tab re-sends the same ones). They are kept
// for every reviewer this tab has been, but sent and shown only for the current one (`mine`).
const outbox: OutboxEntry[] = Array.isArray(savedOutbox)
  ? (savedOutbox as OutboxEntry[]).filter(
      (o) =>
        o?.m?.name === "addNote" &&
        typeof o.as === "string" &&
        typeof o.m.clientId === "string" &&
        /^[A-Za-z0-9_-]{8,64}$/.test(o.m.clientId) &&
        Number.isInteger(o.m.n) &&
        o.m.n > 0 &&
        (o.retryAt === undefined || typeof o.retryAt === "number"),
    )
  : [];
/**
 * The reviewer this page sends as: the invite's name (the service names the note by it), or the
 * open link (the note carries its own self-declared name). Known once the asset token is traded.
 */
function sender(): string {
  return inviteName ? `invite:${inviteName}` : "open";
}
/** The outbox notes of the reviewer this page is now: another reviewer's notes are never sent under this one's socket. */
function mine(): OutboxEntry[] {
  const as = sender();
  return outbox.filter((o) => o.as === as);
}
let clientN = 0;
// The outbox could not be saved: a reload before the acks would lose those notes, so the composer says so.
let outboxUnsaved = false;
// A note is waiting out a `rate_limited` answer: the composer says when it goes again.
let rateLimited: string | null = null;
/** The one pending timed re-send per waiting note. */
const retryTimers = new Map<OutboxEntry, number>();
let sync: SyncSocket | null = null;
// Hosted: why nothing more can be sent (the page is gone, or the invite no longer works).
let lockout: string | null = null;

const state: {
  mode: Mode;
  queue: QueueItem[];
  transcript: Entry[];
  presence: string;
  archived: boolean;
  unread: number;
  more: boolean;
  program: string | null;
  revision: number;
  // The revision the current render errors belong to, and whether the agent got them.
  errorsRevision: number;
  renderReport: "sent" | "failed" | null;
  // The page uses third-party packs: their code could forge errors, so none are sent on their own.
  thirdParty: boolean;
  frameReady: boolean;
  scrollY: number;
  parserErrors: RenderIssue[];
  runtimeErrors: RenderIssue[];
  changes: string[];
  highlight: boolean;
  sheetOpen: boolean;
  sending: boolean;
  connected: boolean;
  editing: string | null | undefined;
  links: { remote?: string } | null;
} = {
  mode: LS.get<Mode>("austere:mode", "annotate"),
  queue: LS.get<QueueItem[]>(`austere:queue:${SID}`, []),
  transcript: [],
  presence: "idle",
  archived: false,
  unread: 0,
  more: false,
  program: null,
  revision: 0,
  errorsRevision: 0,
  renderReport: null,
  thirdParty: false,
  frameReady: false,
  scrollY: 0,
  parserErrors: [],
  runtimeErrors: [],
  changes: [],
  highlight: false,
  sheetOpen: SS.get(`austere:sheet:${SID}`) === true,
  sending: false,
  connected: false,
  editing: null,
  links: null,
};
/** The owner's Conversation entries for runs (RLM-346), by `<run id>:start|end`: from the `run` events and `/runs`, never stored. */
const runMarks = new Map<string, RunMark>();

// ── markup ──

// Elements of the markup below: the queries are of known elements (a cast at the boundary).
const $ = <E extends Element = HTMLElement>(sel: string, root: ParentNode = document): E => root.querySelector(sel) as E;
function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, AttrValue> = {}, ...children: (Child | Child[])[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === "class") el.className = String(v);
    else if (k.startsWith("on")) {
      if (typeof v === "function") el.addEventListener(k.slice(2), v);
    } else if (k === "text") el.textContent = String(v);
    else if (k === "html") el.innerHTML = String(v);
    else el.setAttribute(k, v === true ? "" : String(v));
  }
  for (const c of children.flat()) if (c != null && c !== false) el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  return el;
}

document.body.innerHTML = `
<div class="app">
  <header class="bar">
    <div class="bar-title"><span class="title"></span><span class="file"></span></div>
    <div class="bar-mid">
      <div class="seg" role="group" aria-label="Mode">
        <button type="button" data-mode="annotate" title="Click anything to comment on it (⌘/Ctrl+I)">Annotate</button>
        <button type="button" data-mode="explore" title="Use the page normally (⌘/Ctrl+I)">Explore</button>
      </div>
      <button type="button" class="changes" aria-pressed="false" hidden></button>
    </div>
    <div class="bar-right">
      <span class="viewers" role="group" aria-label="On this page" hidden></span>
      <div class="attach">
        <button type="button" class="attach-pill" aria-haspopup="dialog" aria-expanded="false" title="Attach an agent to this page"><span class="attach-dot"></span><span class="attach-label">Agent: <span class="attach-detail">Off</span><span class="attach-short">Off</span></span></button>
        <span class="run-state" hidden></span>
        <div class="attach-pop" role="dialog" aria-label="Agent on this page" hidden></div>
      </div>
      <span class="presence"></span>
      <div class="menu">
        <button type="button" class="icon-btn menu-btn" aria-label="More">⋯</button>
        <div class="menu-pop" hidden>
          <button type="button" data-cmd="copy-path">Copy file path</button>
          <button type="button" data-cmd="copy-link"${HOSTED ? " hidden" : ""}>${HOSTED ? "Copy page link" : "Copy review link"}</button>
          <button type="button" data-cmd="copy-agent-prompt" title="A prompt that tells your agent to poll this page for feedback">Copy agent prompt</button>
          ${HOSTED ? '<div class="menu-note" data-share-note hidden>Only the owner can share this page. To invite someone, they run<code>austere-axi publish &lt;file&gt; --invite "Name"</code>which prints a link for that person.</div>' : ""}
          <button type="button" data-cmd="reload">Reload artifact</button>
          ${HOSTED ? '<button type="button" data-cmd="export">Download standalone HTML</button>' : `<a data-cmd="export" href="${BASE}/export">Download standalone HTML</a>`}
          <button type="button" data-cmd="archive">Archive page</button>
          <button type="button" data-cmd="unarchive">Unarchive page</button>
        </div>
      </div>
    </div>
  </header>
  <div class="banner" hidden></div>
  <div class="notice" hidden></div>
  <div class="main">
    <section class="stage">
      <iframe class="frame" title="Artifact" sandbox="allow-scripts allow-popups allow-forms"></iframe>
    </section>
    <div class="scrim"></div>
    <aside class="panel" aria-label="Conversation">
      <div class="panel-head">
        <span>Conversation</span>
        <button type="button" class="icon-btn sheet-close" aria-label="Close">⌄</button>
      </div>
      <div class="log"></div>
      <form class="composer">
        <textarea rows="2" placeholder="Message the agent…"></textarea>
        <div class="composer-row">
          <span class="composer-hint">Enter sends · Shift+Enter newline</span>
          <span class="composer-actions">
            <button type="button" class="btn ghost send-end">Send &amp; End</button>
            <button type="submit" class="btn primary send">Send</button>
          </span>
        </div>
        <div class="composer-error" hidden></div>
      </form>
    </aside>
  </div>
  <button type="button" class="dock"></button>
</div>`;

// Hosted viewers keep the download and, on an unlisted page, the page link; the rest is the local owner's.
// RLM-265 (#29) made OWNER false for every hosted viewer, and this list then took export and copy-link
// from all of them (RLM-322).
if (!OWNER) {
  const ownerOnly = ['[data-cmd="copy-path"]', '[data-cmd="copy-agent-prompt"]', '[data-cmd="archive"]', '[data-cmd="unarchive"]', ".send-end", ".attach"];
  if (!HOSTED) ownerOnly.push('[data-cmd="copy-link"]', '[data-cmd="export"]');
  for (const sel of ownerOnly) $(sel)?.remove();
}

function renderViewer() {
  if (OWNER) return;
  $(".file").textContent = viewerName ? `reviewing as ${viewerName}` : "";
  const hint = HOSTED || VIEWER.auto ? "Enter sends" : "the owner sends your notes on · Enter sends";
  $(".composer-hint").textContent = viewerName ? `Posting as ${viewerName} · ${hint}` : hint;
}

// Hosted: the name prompt shown before the first send, and the footer.
const nameForm = HOSTED
  ? h(
      "form",
      { class: "name-ask", hidden: true },
      h("label", { for: "austere-name", text: "Your name, shown with your notes" }),
      h(
        "div",
        { class: "name-row" },
        h("input", { id: "austere-name", maxlength: String(NAME_MAX), autocomplete: "name", placeholder: "Name" }),
        h("button", { type: "submit", class: "btn primary", text: "Continue" }),
      ),
    )
  : null;
if (nameForm) {
  $(".composer").before(nameForm);
  nameForm.addEventListener("submit", (e) => {
    e.preventDefault();
    const input = $<HTMLInputElement>("input", nameForm);
    const name = input.value.trim().slice(0, NAME_MAX);
    if (!name) return input.focus();
    viewerName = name;
    LS.set("austere:name", name);
    nameForm.hidden = true;
    renderViewer();
    presence.rename();
    sendAll(false);
  });
}

const reportForm: HTMLFormElement | null = HOSTED?.report
  ? h(
      "form",
      { class: "report-box", hidden: true },
      h("label", { for: "austere-report", text: "What is wrong with this page?" }),
      h("textarea", { id: "austere-report", rows: "3", maxlength: "1000" }),
      h(
        "div",
        { class: "report-row" },
        h("span", { class: "report-status" }),
        h("button", { type: "button", class: "btn tiny ghost", text: "Cancel", onclick: () => {
          if (reportForm) reportForm.hidden = true;
        } }),
        h("button", { type: "submit", class: "btn tiny primary", text: "Send report" }),
      ),
    )
  : null;
if (HOSTED) {
  const foot = h(
    "footer",
    { class: "hosted-foot" },
    h("a", { href: "https://github.com/MandalorianBatman/austere-axi", target: "_blank", rel: "noopener noreferrer", text: "Made with austere-axi" }),
  );
  if (reportForm) {
    foot.append(
      h("span", { "aria-hidden": "true", text: "·" }),
      h("button", {
        type: "button",
        class: "link-btn report-open",
        text: "Report",
        onclick: () => {
          reportForm.hidden = false;
          $(".report-status", reportForm).textContent = "";
          $("textarea", reportForm).focus();
        },
      }),
    );
    $(".panel").append(reportForm);
    reportForm.addEventListener("submit", async (e) => {
      e.preventDefault();
      const reason = $<HTMLTextAreaElement>("textarea", reportForm).value.trim();
      const status = $(".report-status", reportForm);
      if (!reason) return $("textarea", reportForm).focus();
      status.textContent = "Sending…";
      try {
        const headers: Record<string, string> = { "content-type": "application/json", ...(invite ? { "X-Austere-Invite": invite } : {}) };
        const r = await fetch(HOSTED.report as string, { method: "POST", headers, body: JSON.stringify({ reason }) });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        $<HTMLTextAreaElement>("textarea", reportForm).value = "";
        reportForm.hidden = true;
        $(".report-open", foot).replaceWith(h("span", { class: "report-done", text: "Reported. Thank you." }));
      } catch (err) {
        status.textContent = `Not sent: ${(err as Error).message}`;
      }
    });
  }
  $(".panel").append(foot);
}

const frame = $<HTMLIFrameElement>(".frame");
const log = $(".log");
const textarea = $<HTMLTextAreaElement>(".composer textarea");
const banner = $(".banner");

$(".title").textContent = BOOT.title;
if (OWNER) $(".file").textContent = BOOT.name;
renderViewer();

// Presence (Q17): chips for the others on the page and their last click in the frame. The
// transport calls connect/handle/disconnect: the page socket when hosted, the server's relay locally.
const presence = new Presence({
  chips: $(".viewers"),
  showFocus: (marks) => post({ type: "presence", marks }),
  reveal: (id) => post({ type: "reveal", id }),
  name: () => viewerName || undefined,
});
textarea.addEventListener("focus", () => presence.setWriting("composer", true));
textarea.addEventListener("blur", () => presence.setWriting("composer", false));
window.addEventListener("pagehide", () => presence.leave());

$(".file").title = BOOT.file || "";
document.title = `${BOOT.title} · austere`;

// ── tiny markdown for agent replies ──

function esc(s: unknown): string {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" } as Record<string, string>)[c]);
}
function inline(s: string): string {
  return esc(s)
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>")
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
}
function markdown(src: unknown): string {
  const lines = String(src).replace(/\r\n/g, "\n").split("\n");
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (/^```/.test(line)) {
      const buf: string[] = [];
      i++;
      while (i < lines.length && !/^```/.test(lines[i])) buf.push(lines[i++]);
      i++;
      out.push(`<pre><code>${esc(buf.join("\n"))}</code></pre>`);
      continue;
    }
    if (/^\s*([-*]|\d+\.)\s+/.test(line)) {
      const ordered = /^\s*\d+\./.test(line);
      const buf: string[] = [];
      while (i < lines.length && /^\s*([-*]|\d+\.)\s+/.test(lines[i])) buf.push(lines[i++].replace(/^\s*([-*]|\d+\.)\s+/, ""));
      out.push(`<${ordered ? "ol" : "ul"}>${buf.map((b) => `<li>${inline(b)}</li>`).join("")}</${ordered ? "ol" : "ul"}>`);
      continue;
    }
    if (/^#{1,6}\s+/.test(line)) {
      out.push(`<p><strong>${inline(line.replace(/^#+\s+/, ""))}</strong></p>`);
      i++;
      continue;
    }
    if (!line.trim()) {
      i++;
      continue;
    }
    const buf: string[] = [];
    while (i < lines.length && lines[i].trim() && !/^```|^\s*([-*]|\d+\.)\s+|^#{1,6}\s/.test(lines[i])) buf.push(lines[i++]);
    out.push(`<p>${buf.map(inline).join("<br>")}</p>`);
  }
  return out.join("");
}

// ── frame bridge ──

function post(msg: ChromeMessage) {
  frame.contentWindow?.postMessage({ austere: 1, ...msg }, "*");
}

function loadFrame() {
  state.frameReady = false;
  // Hosted: the frame's URL carries a short-lived asset token, traded again on every load.
  if (HOSTED) void loadHostedFrame();
  else frame.src = `${BOOT.artifactUrl ?? `${BASE}/a/`}?r=${Date.now()}`;
}

window.addEventListener("message", (e) => {
  if (e.source !== frame.contentWindow) return;
  const d = e.data as FrameMessage | null | undefined;
  if (!d || d.austere !== 1) return;
  switch (d.type) {
    case "hello":
      post({
        type: "init",
        mode: state.archived ? "explore" : state.mode,
        state: SS.get(`austere:form:${SID}`),
        scrollY: state.scrollY,
      });
      break;
    case "ready":
      state.frameReady = true;
      if (d.title) {
        $(".title").textContent = d.title;
        document.title = `${d.title} · austere`;
      }
      // A reloaded frame starts unmarked; it handles "highlight" from the start.
      if (state.highlight) postHighlight(false);
      presence.redraw();
      // The old frame's note box is gone, whether or not its blur arrived.
      presence.setWriting("note", false);
      break;
    case "annotate":
      addToQueue(d.item);
      break;
    case "focus":
      // The statement this viewer clicked is its focus for the others.
      if (typeof d.id === "string") presence.setFocus(d.id);
      break;
    case "writing":
      presence.setWriting("note", d.on === true);
      break;
    case "action":
      addToQueue(d.item);
      pulseDock();
      break;
    case "errors":
      state.parserErrors = (d.errors || []).filter((x) => x.severity !== "warning");
      state.errorsRevision = state.revision;
      renderLog();
      reportRenderErrors();
      break;
    case "runtime-error":
      const error = d.error;
      if (error && !state.runtimeErrors.some((x) => x.statementId === error.statementId && x.message === error.message)) {
        state.runtimeErrors.push(error);
        state.errorsRevision = state.revision;
        renderLog();
        reportRenderErrors();
      }
      break;
    case "state":
      SS.set(`austere:form:${SID}`, d.state);
      break;
    case "scroll":
      state.scrollY = d.y || 0;
      break;
    case "changes":
      // Frame code is untrusted: keep string ids only.
      state.changes = Array.isArray(d.ids) ? d.ids.filter((id): id is string => typeof id === "string").slice(0, 50) : [];
      renderChanges();
      if (state.highlight) postHighlight(false);
      break;
    case "toggle-mode":
      setMode(state.mode === "annotate" ? "explore" : "annotate");
      break;
    case "open-url":
      openExternal(d.url);
      break;
  }
});

// Popups from the frame keep its sandbox, so external links are opened here
// instead. Never this origin: artifact code must not get a window on it.
function openExternal(url: unknown) {
  let u: URL;
  try {
    u = new URL(String(url));
  } catch {
    return;
  }
  if (!/^(https?|mailto):$/.test(u.protocol) || u.origin === location.origin) return;
  window.open(u.href, "_blank", "noopener");
}

// ── queue ──

function saveQueue() {
  LS.set(`austere:queue:${SID}`, state.queue);
}

function addToQueue(raw: unknown) {
  if (state.archived || !raw || typeof raw !== "object" || typeof (raw as { kind?: unknown }).kind !== "string") return;
  // Frame code is untrusted: the item is rendered here and saved to localStorage, so its text fields must be strings.
  const fields = raw as Record<string, unknown>;
  for (const k of ["target", "component", "note", "text", "selection", "excerpt", "message", "statement"]) if (k in fields) fields[k] = str(fields[k]);
  const item = raw as QueueItem;
  item.qid = `q${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  state.queue.push(item);
  saveQueue();
  renderLog(true);
  renderDock();
}

// The owner's page sends render failures to the agent on its own, so the agent never has to look
// at the page to learn it is broken. Each report carries the revision its errors came from; the
// server drops repeats and reports for an older revision. If the post fails, "Queue fix" stays.
let renderReportTimer: ReturnType<typeof setTimeout> | undefined;
function reportRenderErrors() {
  // Third-party pack code runs in the frame and could forge errors: the owner queues those by hand.
  if (!OWNER || state.archived || state.thirdParty) return;
  clearTimeout(renderReportTimer);
  renderReportTimer = setTimeout(async () => {
    const errors = [...state.parserErrors, ...state.runtimeErrors].map((e) => ({ statement: str(e.statementId), message: str(e.message) }));
    if (!errors.length) return;
    const reply = await fetch(`${BASE}/render-errors`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ revision: state.errorsRevision, errors }),
    }).then(
      async (r) => (r.ok ? ((await r.json()) as { stale?: boolean }) : null),
      () => null,
    );
    // A stale report (an older revision) reached no one; the new render reports its own errors.
    state.renderReport = reply && !reply.stale ? "sent" : reply ? null : "failed";
    renderLog();
  }, 500);
}

function removeFromQueue(qid: string | undefined) {
  state.queue = state.queue.filter((q) => q.qid !== qid);
  saveQueue();
  renderLog();
  renderDock();
}

function anchorLabel(item: QueueItem): { icon: string; text: string | undefined; sub: string | undefined } {
  if (item.kind === "annotation") return { icon: "✎", text: item.target, sub: item.component };
  if (item.kind === "action") return { icon: "↗", text: item.message, sub: "button" };
  if (item.kind === "render-error") return { icon: "!", text: item.statement || "page", sub: "render issue" };
  return { icon: "", text: "", sub: "" };
}

function flatForm(obj: object | null | undefined, prefix = ""): string[] {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(obj || {})) {
    if (v && typeof v === "object" && !Array.isArray(v)) parts.push(...flatForm(v, ""));
    else parts.push(`${prefix}${k}: ${Array.isArray(v) ? v.join(", ") : v}`);
  }
  return parts;
}

const str = (v: unknown): string => (typeof v === "string" ? v : v == null ? "" : String(v));

function itemQuote(item: QueueItem): unknown {
  if (item.selection) return item.selection;
  if (item.detail?.part) return item.excerpt ? `${item.detail.part}  ${item.excerpt}` : item.detail.part;
  if (item.detail?.column) {
    const where = [item.detail.row && `row ${item.detail.row}`, `column ${item.detail.column}`].filter(Boolean).join(", ");
    return item.excerpt ? `${item.excerpt}  (${where})` : where;
  }
  if (item.kind === "action" && item.form) return flatForm(item.form).join(" · ");
  if (item.kind === "render-error") return item.message;
  return item.excerpt || "";
}

/** One bad item shows a marker instead of aborting the whole panel render. */
function itemBody(item: QueueItem, opts: ItemOptions = {}): HTMLElement {
  try {
    return renderItem(item, opts);
  } catch {
    return h("div", { class: "item" }, h("div", { class: "note", text: "This note could not be displayed." }));
  }
}

function renderItem(item: QueueItem, { queued, held }: ItemOptions = {}): HTMLElement {
  const a = anchorLabel(item);
  const wrap = h("div", { class: `item kind-${item.kind}` });
  if (a.text) {
    const anchor = h(
      "button",
      {
        type: "button",
        class: "anchor",
        title: item.kind === "annotation" ? "Show in the page" : "",
        onclick: () => {
          if (item.kind === "annotation" || item.kind === "render-error") {
            post({ type: "reveal", id: item.target || item.statement });
            if (isNarrow()) setSheet(false);
          }
        },
      },
      h("span", { class: "anchor-icon", text: a.icon }),
      h("span", { class: "anchor-text", text: a.text }),
      a.sub ? h("span", { class: "anchor-sub", text: a.sub }) : null,
    );
    wrap.append(anchor);
  }
  // What the agent receives on release: within the path above the leaf, the whole detail, the whole quote.
  if (held && item.kind === "annotation") {
    const within = (Array.isArray(item.path) ? item.path : []).slice(0, -1).filter((p) => typeof p === "string" && p !== "root");
    if (within.length) wrap.append(h("div", { class: "anchor-sub", text: `within ${within.join(" > ")}` }));
    if (item.detail && typeof item.detail === "object") wrap.append(h("div", { class: "anchor-sub", text: flatForm(item.detail).join(" · ") }));
  }
  const quote = str(itemQuote(item));
  if (quote) wrap.append(h("blockquote", { text: held || quote.length <= 260 ? quote : quote.slice(0, 259) + "…" }));
  const noteText = item.kind === "message" ? item.text : item.note;
  if (queued && state.editing === item.qid) {
    const ta = h("textarea", { class: "edit", rows: "2" });
    ta.value = noteText || "";
    const save = () => {
      const v = ta.value.trim();
      if (item.kind === "message") {
        if (!v) return removeFromQueue(item.qid);
        item.text = v;
      } else item.note = v;
      state.editing = null;
      saveQueue();
      renderLog();
    };
    ta.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        save();
      } else if (e.key === "Escape") {
        state.editing = null;
        renderLog();
      }
    });
    ta.addEventListener("blur", save);
    wrap.append(ta);
    setTimeout(() => ta.focus(), 0);
  } else if (noteText) {
    wrap.append(h("div", { class: "note", text: noteText }));
  }
  return wrap;
}

function fmtTime(ms: number | undefined): string {
  if (!ms) return "";
  return new Date(ms).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

/** "You" for the viewer's own notes, otherwise the author's name; the owner's notes read "Owner" to a reviewer. */
function whoLabel(entry: Entry): string {
  if (OWNER) return entry.author || "You";
  return entry.author === viewerName ? "You" : entry.author || "Owner";
}

async function heldAction(kind: string, ids?: string[]) {
  try {
    await fetch(`${BASE}/${kind}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(ids ? { ids } : { all: true }) });
  } catch {
    composerError("Could not reach the server. Try again.");
  }
}

function receipt(entry: Entry): HTMLElement | null {
  // Hosted notes have no delivery receipts: the owner's agent sees them after a sync.
  if (HOSTED) {
    if (entry.pending) return h("div", { class: "receipt" }, h("em", { text: "Sending…" }));
    return entry.author === viewerName ? h("div", { class: "receipt" }, h("em", { text: "Sent to the page owner" })) : null;
  }
  if (entry.held) {
    const row = h("div", { class: "receipt held" }, h("span", { class: "held-label", text: OWNER ? "Held · not sent to the agent" : "Waiting for the owner to send it on" }));
    if (OWNER) {
      row.append(
        h("button", { type: "button", class: "btn tiny primary", text: "Send", onclick: () => heldAction("release", [entry.id]) }),
        h("button", { type: "button", class: "btn tiny ghost", text: "Discard", onclick: () => heldAction("discard", [entry.id]) }),
      );
    }
    return row;
  }
  const steps: [string, number | undefined][] = [
    ["Seen", entry.seenAt],
    ["Working", entry.workAt],
    ["Done", entry.doneAt],
  ];
  const row = h("div", { class: "receipt" });
  for (const [label, at] of steps) {
    row.append(h("span", { class: at ? "on" : "", title: at ? `${label} ${fmtTime(at)}` : `Not ${label.toLowerCase()} yet`, text: label }));
  }
  if (!entry.seenAt) {
    row.append(
      h("em", {
        text: state.presence === "listening" ? "" : state.unread ? `waiting for the agent (${state.unread} unread)` : "waiting for the agent",
      }),
    );
  }
  return row;
}

let lastLogCount = 0;
function renderLog(scrollToEnd = false) {
  const atBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 40;
  log.textContent = "";
  const issues = [...state.parserErrors, ...state.runtimeErrors];
  if (issues.length) {
    const sent = OWNER && state.renderReport === "sent";
    const head = `Render issues (${issues.length})${sent ? " · sent to the agent" : ""}`;
    const box = h("div", { class: "issues" }, h("div", { class: "issues-head", text: head }));
    for (const err of issues.slice(0, 8)) {
      box.append(
        h(
          "div",
          { class: "issue" },
          h("div", { class: "issue-text" }, err.statementId ? h("code", { text: err.statementId }) : null, " ", err.message),
          // Once the owner's page has sent it to the agent (reportRenderErrors), there is nothing to queue.
          state.archived || sent
            ? null
            : h("button", {
                type: "button",
                class: "btn tiny",
                text: "Queue fix",
                onclick: () =>
                  addToQueue({ kind: "render-error", statement: err.statementId, target: err.statementId, message: err.message, note: "Fix this render error." }),
              }),
        ),
      );
    }
    log.append(box);
  }
  if (state.more) {
    log.append(h("button", { type: "button", class: "btn tiny ghost load-earlier", text: "Load earlier messages", onclick: loadEarlier }));
  }
  // Hosted: notes waiting for their ack follow the conversation.
  const pending = mine().map((o): Entry => ({ id: `out:${o.m.clientId}:${o.m.n}`, role: "user", author: viewerName, items: o.m.args.items, at: o.at, pending: true }));
  const entries = pending.length ? [...state.transcript, ...pending] : state.transcript;
  if (!entries.length && !state.queue.length) {
    log.append(
      h(
        "div",
        { class: "empty" },
        h("p", { html: "<strong>Point at anything to comment on it.</strong>" }),
        h("p", {
          text: `In Annotate mode, click a section, table cell, diagram node or diff line, or select text. Notes queue here; Send delivers them to the ${HOSTED ? "page owner" : "agent"}.`,
        }),
      ),
    );
  }
  // The owner's run marks (RLM-346) sit among the entries by time; with older entries not loaded yet, older marks wait too.
  const since = state.more ? (entries[0]?.at ?? 0) : 0;
  const marks = OWNER ? [...runMarks.values()].filter((m) => m.at >= since) : [];
  const rows: (Entry | RunMark)[] = marks.length ? [...entries, ...marks].sort((a, b) => a.at - b.at) : entries;
  for (const entry of rows) {
    if ("tone" in entry) {
      log.append(h("div", { class: `run-mark ${entry.tone}` }, h("span", { text: entry.text }), h("time", { text: fmtTime(entry.at) })));
    } else if (entry.role === "agent") {
      log.append(
        h(
          "div",
          { class: "msg agent" },
          h("div", { class: "who", text: `Agent · ${fmtTime(entry.at)}` }),
          h("div", { class: "md", html: markdown(entry.text) }),
        ),
      );
    } else {
      const bubble = h("div", { class: `msg user${entry.held ? " held" : ""}` }, h("div", { class: "who", text: `${whoLabel(entry)} · ${fmtTime(entry.at)}${entry.end ? " · Send & End" : ""}` }));
      for (const it of entry.items || []) bubble.append(itemBody(it, { held: !!entry.held }));
      const r = receipt(entry);
      if (r) bubble.append(r);
      log.append(bubble);
    }
  }
  const heldCount = OWNER ? state.transcript.filter((e) => e.held).length : 0;
  if (heldCount) {
    log.append(
      h(
        "div",
        { class: "held-bar" },
        h("span", { text: `${heldCount} held from teammates` }),
        h("button", { type: "button", class: "btn tiny primary", text: "Send all", onclick: () => heldAction("release", state.transcript.filter((e) => e.held).map((e) => e.id)) }),
        h("button", { type: "button", class: "btn tiny ghost", text: "Discard all", onclick: () => heldAction("discard") }),
      ),
    );
  }
  if (state.queue.length) {
    const q = h("div", { class: "queued" }, h("div", { class: "queued-head", text: `Queued · ${state.queue.length}` }));
    for (const item of state.queue) {
      const el = itemBody(item, { queued: true });
      el.classList.add("q");
      el.append(
        h(
          "div",
          { class: "q-actions" },
          h("button", {
            type: "button",
            class: "btn tiny ghost",
            text: "Edit",
            onclick: () => {
              state.editing = item.qid;
              renderLog();
            },
          }),
          h("button", { type: "button", class: "btn tiny ghost", text: "Remove", onclick: () => removeFromQueue(item.qid) }),
        ),
      );
      q.append(el);
    }
    log.append(q);
  }
  if (state.archived) {
    log.append(
      h("div", {
        class: "archived-note",
        text: OWNER ? "This page is archived. Unarchive it from the ⋯ menu to add notes." : "The owner archived this page. Ask them to reopen it if you have more notes.",
      }),
    );
  }
  const count = rows.length + state.queue.length;
  if (scrollToEnd || atBottom || count !== lastLogCount) log.scrollTop = log.scrollHeight;
  lastLogCount = count;
  renderComposer();
}

// ── composer / sending ──

function renderComposer() {
  const archived = state.archived;
  const n = state.queue.length;
  textarea.disabled = archived || !!lockout || state.sending;
  // Hosted: nothing goes out until the service has said who this reviewer is.
  $<HTMLButtonElement>(".send").disabled = archived || !!lockout || state.sending || (!!HOSTED && inviteName === undefined);
  if ($(".send-end")) $<HTMLButtonElement>(".send-end").disabled = archived || state.sending || (!n && !textarea.value.trim());
  $(".send").textContent = state.sending ? "Sending…" : n ? `Send ${n}` : "Send";
  textarea.placeholder = archived ? "Page archived" : n ? "Add a message (optional)…" : "Message the agent…";
}

function composerError(text: string) {
  const el = $(".composer-error");
  el.textContent = text || "";
  el.hidden = !text;
}

async function sendAll(end = false) {
  if (state.sending || state.archived) return;
  const text = textarea.value.trim();
  const items: QueueItem[] = state.queue.map(({ qid, ...rest }) => rest);
  if (text) items.push({ kind: "message", text });
  if (!items.length) {
    textarea.focus();
    return;
  }
  if (end && !OWNER) return;
  if (HOSTED) return sendHosted(items);
  state.sending = true;
  composerError("");
  renderComposer();
  try {
    const r = await fetch(`${BASE}/send`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ items, end }),
    });
    const data: { error?: string; entry?: Entry } = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
    state.queue = [];
    saveQueue();
    textarea.value = "";
    const entry = data.entry;
    if (entry && !state.transcript.some((e) => e.id === entry.id)) state.transcript.push(entry);
  } catch (err) {
    composerError(`Not sent: ${(err as Error).message}. Your notes are still queued.`);
  } finally {
    state.sending = false;
    renderLog(true);
    renderDock();
  }
}

/**
 * The service takes messages and annotations only (NoteItem): a button press goes as a message,
 * a render issue as an annotation on its statement. Fields the frame gave as anything but strings are dropped.
 */
function toNoteItem(item: QueueItem): NoteItem {
  if (item.kind === "message") return { kind: "message", text: str(item.text) };
  if (item.kind === "action") return { kind: "message", text: [str(item.message), item.form ? flatForm(item.form).join(" · ") : ""].filter(Boolean).join(" · ") };
  const out: NoteAnnotation = { kind: "annotation" };
  const target = item.kind === "render-error" ? item.statement : item.target;
  if (typeof target === "string" && target) out.target = target;
  for (const k of ["component", "selection", "excerpt", "note"] as const) {
    const v = item[k];
    if (typeof v === "string" && v) out[k] = v;
  }
  if (item.kind === "render-error" && typeof item.message === "string") out.excerpt = item.message;
  if (Array.isArray(item.path)) out.path = item.path.filter((p): p is string => typeof p === "string");
  const d = item.detail;
  if (d && typeof d === "object") {
    const detail: NonNullable<NoteAnnotation["detail"]> = {};
    for (const k of ["part", "row", "column"] as const) if (typeof d[k] === "string") detail[k] = d[k];
    if (Number.isInteger(d.rowIndex)) detail.rowIndex = d.rowIndex as number;
    if (Object.keys(detail).length) out.detail = detail;
  }
  return out;
}

/** Hosted: queues the batch as one `addNote` and sends it if the socket is open; the ack settles it. */
const UNSAVED_WARNING = "This browser could not keep a copy of your note: keep this tab open until it shows “Sent to the page owner”.";

/** The composer's outbox notice: a rate-limit wait and the unsaved-copy warning, each while it holds. */
function showOutboxNotice() {
  composerError([rateLimited, outboxUnsaved ? UNSAVED_WARNING : ""].filter(Boolean).join(" "));
}

/**
 * Sends an outbox note now, or, while it waits out `retryAfter`, once its deadline passes. One
 * timer per note: a reconnect or a second refusal never schedules an earlier or a second send.
 */
function sendWhenDue(entry: OutboxEntry) {
  const wait = (entry.retryAt ?? 0) - Date.now();
  if (wait <= 0) {
    delete entry.retryAt;
    sync?.send(entry.m);
    return;
  }
  if (retryTimers.has(entry)) return;
  retryTimers.set(
    entry,
    window.setTimeout(() => {
      retryTimers.delete(entry);
      if (outbox.includes(entry) && entry.as === sender()) sendWhenDue(entry);
    }, wait),
  );
}

function sendHosted(queued: QueueItem[]) {
  if (lockout || inviteName === undefined) return;
  // Only an unlisted page without an invite takes a self-declared name; an invite names its reviewer.
  if (inviteName === null && !viewerName && nameForm) {
    nameForm.hidden = false;
    $("input", nameForm).focus();
    return;
  }
  const items = queued.map(toNoteItem);
  const bytes = new TextEncoder().encode(JSON.stringify(items)).length;
  if (bytes > LIMITS.noteItemsBytes) {
    composerError(`Too long to send: ${bytes} bytes, the limit is ${LIMITS.noteItemsBytes}. Shorten or remove a note.`);
    return;
  }
  const args: AddNoteArgs = inviteName === null ? { items, name: viewerName } : { items };
  const m = mutation("addNote", args, { clientId: CLIENT, n: ++clientN });
  outbox.push({ m, at: Date.now(), as: sender() });
  outboxUnsaved = !SS.set(OUTBOX_KEY, outbox);
  sync?.send(m);
  state.queue = [];
  saveQueue();
  textarea.value = "";
  showOutboxNotice();
  renderLog(true);
  renderDock();
}

$(".composer").addEventListener("submit", (e) => {
  e.preventDefault();
  sendAll(false);
});
$(".send-end")?.addEventListener("click", () => sendAll(true));
textarea.addEventListener("input", renderComposer);
textarea.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    sendAll(false);
  }
});

// ── mode, presence, changes ──

function setMode(mode: string | undefined) {
  state.mode = mode === "explore" ? "explore" : "annotate";
  LS.set("austere:mode", state.mode);
  // Explore uses the page alone: the conversation panel (and, on narrow screens, its sheet and dock) steps aside.
  // A hidden log has no layout, so it could not follow new messages: show the latest when it returns.
  const html = document.documentElement;
  const wasExploring = html.classList.contains("exploring");
  html.classList.toggle("exploring", state.mode === "explore");
  if (wasExploring && state.mode === "annotate") log.scrollTop = log.scrollHeight;
  // An archived page takes no notes: the frame is in Explore, and the switch says so.
  const shown: Mode = state.archived ? "explore" : state.mode;
  for (const b of document.querySelectorAll<HTMLButtonElement>(".seg button")) {
    b.classList.toggle("on", b.dataset.mode === shown);
    b.disabled = state.archived && b.dataset.mode === "annotate";
    if (b.dataset.mode === "annotate") b.title = state.archived ? "The page is archived: it takes no notes" : "Click anything to comment on it (⌘/Ctrl+I)";
  }
  post({ type: "mode", mode: shown });
}
for (const b of document.querySelectorAll<HTMLButtonElement>(".seg button")) b.addEventListener("click", () => setMode(b.dataset.mode));
document.addEventListener("keydown", (e) => {
  if ((e.metaKey || e.ctrlKey) && (e.key === "i" || e.key === "I")) {
    e.preventDefault();
    setMode(state.mode === "annotate" ? "explore" : "annotate");
  }
});

function renderPresence() {
  const el = $(".presence");
  let label: string;
  let cls: string;
  if (state.archived) [label, cls] = ["Page archived", "ended"];
  else if (lockout) [label, cls] = [lockout, "ended"];
  else if (!state.connected) [label, cls] = ["Reconnecting…", "off"];
  else if (HOSTED) [label, cls] = ["Shared page", "hosted"];
  else if (state.presence === "listening") [label, cls] = ["Agent listening", "listening"];
  else if (state.presence === "working") [label, cls] = ["Agent working", "working"];
  else [label, cls] = ["Agent not listening", "idle"];
  if (cls === "idle" && state.unread) label += ` · ${state.unread} waiting`;
  // With an agent attached, "not listening" says nothing: the Agent pill tells what runs.
  el.className = `presence ${cls}${cls === "idle" && attach.info?.effective.state === "on" ? " attached" : ""}`;
  el.textContent = label;
  el.title =
    cls === "idle"
      ? "Your notes are kept and reach the agent the next time it polls."
      : cls === "working"
        ? "The agent has your last batch."
        : cls === "hosted"
          ? "Notes go to the page owner. Replies show up here as they are posted."
          : "";
  if (OWNER) {
    $('[data-cmd="archive"]').hidden = state.archived;
    $('[data-cmd="unarchive"]').hidden = !state.archived;
  }
  renderDock();
}

function renderChanges() {
  const btn = $(".changes");
  btn.setAttribute("aria-pressed", String(state.highlight));
  // While on, the button stays so it can be switched off, even after a turn that changed nothing.
  if (!state.changes.length && !state.highlight) {
    btn.hidden = true;
    return;
  }
  btn.hidden = false;
  btn.textContent = `${state.changes.length} changed`;
  btn.title = state.changes.length
    ? `${state.highlight ? "Hide" : "Highlight"} what the last turn changed: ${state.changes.join(", ")}`
    : "The last turn changed nothing on the page. Click to stop highlighting.";
}
// On: the last turn's changes stay marked, and each new turn's replace them, until switched off.
function postHighlight(scroll: boolean) {
  post({ type: "highlight", ids: state.highlight ? state.changes : [], scroll });
}
$(".changes").addEventListener("click", () => {
  state.highlight = !state.highlight;
  renderChanges();
  postHighlight(state.highlight);
});

// ── menu ──

const menuPop = $(".menu-pop");

/**
 * The agent prompt, fetched when the menu opens (the file may have been published since the page
 * opened) so a click can copy it at once: Firefox allows a legacy copy only inside the click itself.
 */
let agentPrompt: Promise<string> | null = null;
let agentPromptText: string | null = null;
function loadAgentPrompt(): Promise<string> {
  agentPromptText = null;
  const p = fetch(`${BASE}/agent-prompt`).then((r) => {
    if (!r.ok) throw new Error(String(r.status));
    return r.text();
  });
  agentPrompt = p;
  p.then(
    (t) => {
      if (agentPrompt === p) agentPromptText = t;
    },
    () => {},
  );
  return p;
}

$(".menu-btn").addEventListener("click", (e) => {
  e.stopPropagation();
  menuPop.hidden = !menuPop.hidden;
  if (attachPop) closeAttach();
  if (!menuPop.hidden && OWNER) void loadAgentPrompt();
});
document.addEventListener("click", () => (menuPop.hidden = true));

/** A short confirmation in the banner that goes away by itself. */
function flash(text: string) {
  showBanner(text);
  setTimeout(() => {
    if (banner.textContent === text) showBanner("");
  }, 4000);
}

/** Copies through a hidden textarea. Works where `navigator.clipboard` does not exist, but only while a click is being handled. */
function copyLegacy(text: string): boolean {
  const ta = document.createElement("textarea");
  ta.value = text;
  ta.setAttribute("readonly", "");
  ta.style.cssText = "position:fixed;top:0;left:0;opacity:0;pointer-events:none";
  document.body.append(ta);
  ta.select();
  let ok = false;
  try {
    ok = document.execCommand("copy");
  } catch {
    // refused
  }
  ta.remove();
  return ok;
}

/**
 * Copies `text` and says so. `navigator.clipboard` is there only in a secure context (https or
 * localhost), and the review page is often opened at an http tailnet address, where it is undefined:
 * the legacy copy covers that. When nothing can copy, the text is shown to copy by hand.
 */
async function copyText(text: string, what: string): Promise<void> {
  let ok = false;
  if (navigator.clipboard?.writeText) {
    ok = await navigator.clipboard.writeText(text).then(
      () => true,
      () => false,
    );
  }
  if (!ok) ok = copyLegacy(text);
  if (ok) return flash(`${what} copied.`);
  window.prompt(`Your browser blocked copying. Copy ${what.toLowerCase()} from here:`, text);
}

async function copyAgentPrompt() {
  let text = agentPromptText;
  if (text == null) {
    try {
      text = await (agentPrompt ?? loadAgentPrompt());
    } catch {
      return showBanner("Could not get the agent prompt from austere-axi. Check that it is still running.");
    }
  }
  await copyText(text, "Agent prompt");
}

menuPop.addEventListener("click", async (e) => {
  const cmd = e.target instanceof Element ? e.target.closest<HTMLElement>("[data-cmd]")?.dataset.cmd : undefined;
  // The share note stays open so its command can be selected.
  if (!cmd) return e.stopPropagation();
  if (cmd === "copy-path") await copyText(BOOT.file, "File path");
  // Hosted, the URL without its fragment: the invite token is already out of the address bar.
  if (cmd === "copy-link") await copyText(HOSTED ? location.origin + location.pathname : state.links?.remote || location.href, HOSTED ? "Page link" : "Review link");
  if (cmd === "copy-agent-prompt") await copyAgentPrompt();
  if (cmd === "reload") loadFrame();
  if (cmd === "export" && HOSTED) {
    // The menu stays open on "Preparing download…" until the file is saved or the banner says why not.
    e.stopPropagation();
    await downloadStandalone();
    menuPop.hidden = true;
  }
  if (cmd === "archive") await archivePage();
  if (cmd === "unarchive") await unarchivePage();
});

/** The server's reason for a failed request, else its status. */
async function failure(r: Response): Promise<string> {
  const d = (await r.json().catch(() => ({}))) as { error?: string };
  return d.error || `error ${r.status}`;
}

const UNREACHABLE = "Could not reach austere-axi. Check that it is still running.";

/** Shows why archive or unarchive failed; the next attempt that works takes it away, and leaves any other banner alone. */
let archiveError = "";
function showArchiveError(text: string) {
  archiveError = text;
  showBanner(text);
}
function clearArchiveError() {
  if (archiveError && banner.textContent === archiveError) showBanner("");
  archiveError = "";
}

/**
 * Asks before archiving: which copy goes, the unanswered notes that go with it, and the copies of the page
 * (its other worktrees) that stay open. Resolves to null (cancel), false (this copy) or true (every copy).
 */
function askArchive(plan: ArchivePlan): Promise<boolean | null> {
  const several = plan.others.length > 0;
  const waiting = plan.archived[0]?.unanswered ?? 0;
  const { promise, resolve } = Promise.withResolvers<boolean | null>();
  const dialog = h("dialog", { class: "confirm", "aria-labelledby": "confirm-title" });
  const answer = (v: boolean | null) => {
    dialog.close();
    dialog.remove();
    resolve(v);
  };
  dialog.addEventListener("cancel", (e) => {
    e.preventDefault();
    answer(null);
  });
  const parts = [
    h("h2", { id: "confirm-title", text: several ? `Archive this copy (${plan.copy})?` : "Archive this page?" }),
    h("p", { text: several ? "This copy leaves the hub's lists and no one can add notes to it until you unarchive it." : "It leaves the hub's lists and no one can add notes until you unarchive it." }),
    waiting ? h("p", { text: waiting === 1 ? "1 unanswered note goes with it: it is kept, but leaves the hub's counts." : `${waiting} unanswered notes go with it: they are kept, but leave the hub's counts.` }) : null,
    several ? h("p", { text: plan.others.length === 1 ? "This copy stays open:" : "These copies stay open:" }) : null,
    several ? h("ul", {}, plan.others.map((c) => h("li", { title: c.file, text: c.unanswered ? `${c.copy} · ${c.unanswered} unanswered note${c.unanswered === 1 ? "" : "s"}` : c.copy }))) : null,
    h(
      "div",
      { class: "confirm-actions" },
      h("button", { type: "button", class: "btn ghost", text: "Cancel", onclick: () => answer(null) }),
      several ? h("button", { type: "button", class: "btn", "data-archive": "every", text: "Archive every copy", onclick: () => answer(true) }) : null,
      h("button", { type: "button", class: "btn primary", "data-archive": "this", text: several ? "Archive this copy" : "Archive page", onclick: () => answer(false) }),
    ),
  ];
  dialog.append(...parts.filter((el) => el !== null));
  document.body.append(dialog);
  dialog.showModal();
  return promise;
}

async function archivePage() {
  const r = await fetch(`${BASE}/archive`).catch(() => null);
  if (!r) return showArchiveError(UNREACHABLE);
  if (!r.ok) return showArchiveError(`Could not archive this page: ${await failure(r)}`);
  const every = await askArchive((await r.json()) as ArchivePlan);
  if (every === null) return;
  const done = await fetch(`${BASE}/archive`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ every }) }).catch(() => null);
  if (!done) return showArchiveError(UNREACHABLE);
  if (!done.ok) return showArchiveError(`Could not archive this page: ${await failure(done)}`);
  clearArchiveError();
}

async function unarchivePage() {
  const r = await fetch(`${BASE}/unarchive`, { method: "POST" }).catch(() => null);
  if (!r) return showArchiveError(UNREACHABLE);
  if (!r.ok) return showArchiveError(`Could not unarchive this page: ${await failure(r)}`);
  clearArchiveError();
}

// ── attach: the Agent pill (RLM-346; the owner's only, never on a reviewer's or a hosted page) ──

const MODES: { id: AttachModeId; label: string; hint: string }[] = [
  { id: "same", label: "Same session", hint: "Each run continues the session" },
  { id: "fork", label: "Fork", hint: "Each run branches from the session" },
  { id: "new", label: "New session", hint: "The first run starts a session; later runs continue it" },
];
/** `runs.reason` in words, for a run event without a message. */
const RUN_REASONS: Record<string, string> = {
  exit: "the harness exited with an error",
  timeout: "it ran past its time limit",
  no_reply: "it exited without replying (does the harness have the write grant?)",
  session_in_use: "the session is open in another process",
  cost_cap: "it reached its cost cap",
  session_unknown: "cannot tell whether the session is still open; choose fork or new",
  unsupported: "the harness cannot run this mode",
  unavailable: "the harness is not available",
  rate_limit: "too many runs on this page in the last hour",
  auto_conflict: "the page takes notes without you (--auto)",
  config: "a settings file is malformed",
};

const attachPill = OWNER ? $<HTMLButtonElement>(".attach-pill") : null;
const attachPop = OWNER ? $(".attach-pop") : null;
const runStateEl = OWNER ? $(".run-state") : null;
/**
 * The Agent pill's state. Each settings load or save takes the next `infoGen`; an answer shows only
 * when it left after the one shown (`infoShown`), so an older load cannot put back an older setting.
 * A run event moves `runGen` on: an answer that left before it keeps the event's run (a `running`
 * event that beat a slow `/attach` keeps its Stop).
 */
const attach: { info: AttachInfo | null; run: RunSummary | null; message: string; log: string[] | null; busy: boolean; error: string; infoGen: number; infoShown: number; runGen: number } = {
  info: null,
  run: null,
  message: "",
  log: null,
  busy: false,
  error: "",
  infoGen: 0,
  infoShown: 0,
  runGen: 0,
};

/** Show a settings answer from request `gen`, sent while the run events stood at `runGen`, unless a later request's answer shows already. */
function applyAttach(info: AttachInfo, gen: number, runGen: number): void {
  if (gen < attach.infoShown) return;
  attach.infoShown = gen;
  attach.info = info;
  if (runGen === attach.runGen) attach.run = info.run;
}

let elapsedTimer = 0;

function clock(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

function bytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function ago(ms: number): string {
  const min = Math.round((Date.now() - ms) / 60_000);
  if (min < 1) return "just now";
  if (min < 60) return `${min} min ago`;
  if (min < 48 * 60) return `${Math.round(min / 60)} h ago`;
  return `${Math.round(min / 1440)} d ago`;
}

/** A run's start and end as Conversation entries. A run that never started shows only when it failed (it was refused). */
function addRunMarks(run: RunSummary, message?: string) {
  const what = [run.harness, run.mode, run.model].filter(Boolean).join(" · ");
  if (run.started_at) runMarks.set(`${run.id}:start`, { id: run.id, at: run.started_at, text: `Agent run started${what ? ` · ${what}` : ""}`, tone: "start" });
  if (!run.ended_at || (!run.started_at && run.status !== "failed")) return;
  const took = run.started_at ? ` after ${clock(run.ended_at - run.started_at)}` : "";
  const why = message || RUN_REASONS[run.reason ?? ""] || run.reason || "";
  const end: Pick<RunMark, "text" | "tone"> =
    run.status === "done"
      ? { text: `Agent run finished${took}`, tone: "done" }
      : run.status === "failed"
        ? { text: `Agent run ${run.started_at ? "failed" : "did not start"}${why ? `: ${why}` : ""}`, tone: "failed" }
        : run.status === "stopped"
          ? { text: `Agent run stopped${took}`, tone: "stopped" }
          : { text: "Agent run interrupted: the server restarted", tone: "stopped" };
  runMarks.set(`${run.id}:end`, { id: run.id, at: run.ended_at, ...end });
}

async function loadAttach() {
  const gen = ++attach.infoGen;
  const runGen = attach.runGen;
  try {
    const r = await fetch(`${BASE}/attach`);
    if (!r.ok) return;
    applyAttach((await r.json()) as AttachInfo, gen, runGen);
  } catch {
    return; // the pill keeps what it showed
  }
  renderAttach();
}

/** The page's recent runs as Conversation entries, once per connection. */
async function loadRunMarks() {
  try {
    const r = await fetch(`${BASE}/runs?limit=20`);
    if (!r.ok) return;
    for (const run of ((await r.json()) as { runs: RunSummary[] }).runs) addRunMarks(run);
  } catch {
    return;
  }
  renderLog();
}

function renderAttach() {
  if (!attachPill) return;
  const info = attach.info;
  const on = info?.effective.state === "on";
  const detail = on && info ? [info.target.harness, info.effective.mode, info.effective.model].filter(Boolean).join(" · ") : "Off";
  $(".attach-detail").textContent = detail;
  $(".attach-short").textContent = on ? "On" : "Off";
  attachPill.classList.toggle("on", on);
  attachPill.title = on ? `Agent attached: ${detail}. A note you send starts it.` : "Attach an agent to this page";
  renderPresence();
  renderRunState();
  if (attachPop && !attachPop.hidden) renderAttachPop();
}

/** Stop, View log and Retry for the run's state. */
function runButtons(run: RunSummary): HTMLElement[] {
  if (run.status === "running" || run.status === "queued" || run.status === "waiting_for_session") {
    return [h("button", { type: "button", class: "btn tiny ghost run-stop", text: "Stop", onclick: () => runAction("stop") })];
  }
  if (run.status === "failed") {
    return [
      h("button", { type: "button", class: "btn tiny ghost run-log", text: "View log", onclick: () => openLog() }),
      h("button", { type: "button", class: "btn tiny run-retry", text: "Retry", onclick: () => runAction("retry") }),
    ];
  }
  return [];
}

/** The run's state in words; the elapsed time of a running one ticks in `.run-elapsed`. */
function runLabel(run: RunSummary): Child[] {
  switch (run.status) {
    case "queued":
      return ["Run queued"];
    case "waiting_for_session":
      return ["Waiting for session"];
    case "running":
      return ["Running ", h("span", { class: "run-elapsed", text: clock(Date.now() - (run.started_at ?? Date.now())) })];
    case "failed":
      return ["Run failed"];
    case "done":
      return ["Last run done"];
    case "stopped":
      return ["Last run stopped"];
    default:
      return ["Last run interrupted"];
  }
}

const ACTIVE = new Set<RunSummary["status"]>(["queued", "waiting_for_session", "running", "failed"]);

function renderRunState() {
  if (!runStateEl) return;
  const run = attach.run;
  runStateEl.textContent = "";
  const show = !!run && ACTIVE.has(run.status);
  runStateEl.hidden = !show;
  runStateEl.className = `run-state${run ? ` ${run.status}` : ""}`;
  attachPill?.setAttribute("data-run", show && run ? run.status : "");
  if (run && show) {
    runStateEl.title = run.status === "failed" ? attach.message || RUN_REASONS[run.reason ?? ""] || "" : run.status === "waiting_for_session" ? attach.message : "";
    runStateEl.append(h("span", { class: "run-label" }, ...runLabel(run)), ...runButtons(run));
  }
  clearInterval(elapsedTimer);
  if (run?.status === "running") {
    elapsedTimer = window.setInterval(() => {
      for (const el of document.querySelectorAll(".run-elapsed")) el.textContent = clock(Date.now() - (run.started_at ?? Date.now()));
    }, 1000);
  }
  renderAttachRun();
}

async function runAction(kind: "stop" | "retry") {
  const r = await fetch(`${BASE}/run/${kind}`, { method: "POST" }).catch(() => null);
  if (!r) return flash("Could not reach austere-axi. Check that it is still running.");
  if (!r.ok) {
    const d = (await r.json().catch(() => ({}))) as { error?: string };
    flash(d.error ? `${kind === "stop" ? "Stop" : "Retry"}: ${d.error}` : `${kind} failed (${r.status})`);
  }
}

async function openLog() {
  const run = attach.run;
  if (!run || !attachPop) return;
  openAttach();
  let log: string[];
  try {
    const r = await fetch(`${BASE}/run/${run.id}/log`);
    log = r.ok ? ((await r.json()) as { tail: string[] }).tail : [`Could not read the log (${r.status}).`];
  } catch {
    log = ["Could not reach austere-axi."];
  }
  // A retry may have started another run meanwhile: this log is not its.
  if (attach.run?.id !== run.id) return;
  attach.log = log;
  renderAttachRun();
  attachPop.querySelector(".attach-log")?.scrollIntoView({ block: "nearest" });
}

function openAttach() {
  if (!attachPop || !attachPill) return;
  menuPop.hidden = true;
  if (attachPop.hidden) {
    attachPop.hidden = false;
    attachPill.setAttribute("aria-expanded", "true");
    renderAttachPop();
    void loadAttach();
  }
}

function closeAttach() {
  if (!attachPop || attachPop.hidden) return;
  attachPop.hidden = true;
  attachPill?.setAttribute("aria-expanded", "false");
  attach.log = null;
  attach.error = "";
}

/** Write the page's own row; from "Use project default", the page takes the fields it showed. */
async function saveAttach(change: AttachChange) {
  const info = attach.info;
  if (!info || attach.busy) return;
  const own = info.page && info.page.state !== "inherit" ? info.page.state : null;
  const e = info.effective;
  const body: AttachChange = own ? { state: own, ...change } : { state: "inherit", mode: e.mode, session: e.session, harness: e.harness, model: e.model, ...change };
  attach.busy = true;
  attach.error = "";
  const gen = ++attach.infoGen;
  const runGen = attach.runGen;
  renderAttachPop();
  try {
    const r = await fetch(`${BASE}/attach`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const d = (await r.json().catch(() => ({}))) as AttachInfo & { error?: string };
    if (r.ok) applyAttach(d, gen, runGen);
    else attach.error = d.error || `Could not change it (${r.status}).`;
  } catch {
    attach.error = "Could not reach austere-axi. Check that it is still running.";
  }
  attach.busy = false;
  renderAttach();
}

function field(legend: string, ...children: Child[]): HTMLFieldSetElement {
  return h("fieldset", { class: "attach-field" }, h("legend", { text: legend }), ...children);
}

function renderAttachPop() {
  if (!attachPop) return;
  const info = attach.info;
  attachPop.textContent = "";
  attachPop.append(
    h(
      "div",
      { class: "attach-head" },
      h("strong", { text: "Agent on this page" }),
      h("button", { type: "button", class: "icon-btn attach-close", "aria-label": "Close", text: "×", onclick: closeAttach }),
    ),
  );
  if (!info) {
    attachPop.append(h("p", { class: "attach-note", text: "Loading…" }));
    return;
  }
  const e = info.effective;
  const pageState = info.page?.state ?? "inherit";
  const own = pageState !== "inherit";
  const project = info.project?.setting;
  const projectText = project && project.state !== "inherit" ? project.state : "off";
  attachPop.append(
    h("p", { class: "attach-note", text: "When on, a note you send or release starts the agent: it reads the notes, patches the page and replies." }),
    h(
      "div",
      { class: "seg attach-state", role: "group", "aria-label": "Attach" },
      ...(
        [
          ["on", "On"],
          ["off", "Off"],
          ["inherit", "Use project default"],
        ] as const
      ).map(([value, label]) =>
        h("button", {
          type: "button",
          "data-state": value,
          class: pageState === value ? "on" : null,
          "aria-pressed": String(pageState === value),
          // An auto page may not end up on (Q3, A17): neither by On nor by going back to a project default that is on.
          disabled: attach.busy || (!!info.auto && pageState !== value && (value === "on" || (value === "inherit" && projectText === "on"))),
          text: label,
          onclick: () => saveAttach({ state: value }),
        }),
      ),
    ),
    h("p", {
      class: "attach-note",
      text: own ? `Project default${info.project ? ` (${info.project.name})` : ""}: ${projectText}.` : `This page uses the project default: ${e.state}. Choose On or Off to give it its own setting.`,
    }),
  );
  if (info.auto && e.state !== "on") attachPop.append(h("div", { class: "attach-warn", text: `${info.auto}. Attach and --auto exclude each other: publish or share it without --auto to turn attach on.` }));

  const fieldsOff = !own || attach.busy;
  const sessionHarness = e.session === "author" ? info.author?.harness : info.sessions.find((s) => s.id === e.session)?.harness;
  const runHarness = sessionHarness ?? e.harness;
  const caps = info.harnesses[runHarness]?.capabilities;
  const blocked: string[] = [];
  const modes = field("Mode");
  for (const m of MODES) {
    const cap = caps?.[m.id];
    const reason = cap && !cap.ok ? cap.reason : null;
    if (reason) blocked.push(`${m.label}: ${reason}`);
    modes.append(
      h(
        "label",
        { class: `attach-radio${reason ? " disabled" : ""}`, title: reason || m.hint },
        h("input", { type: "radio", name: "attach-mode", value: m.id, checked: e.mode === m.id, disabled: fieldsOff || !!reason, onchange: () => saveAttach({ mode: m.id }) }),
        h("span", { text: m.label }),
      ),
    );
  }
  if (blocked.length) modes.append(h("div", { class: "attach-reason", text: blocked.join(" · ") }));
  if (e.mode !== "new") modes.append(h("div", { class: "attach-hint", text: `Resends the whole session each run${info.sessionFileSize ? ` · ${bytes(info.sessionFileSize)}` : ""}` }));

  const sessions = field("Session");
  const sessionRadio = (value: string, label: string, meta: string) =>
    h(
      "label",
      { class: "attach-radio attach-session" },
      h("input", { type: "radio", name: "attach-session", value, checked: e.session === value, disabled: fieldsOff, onchange: () => saveAttach({ session: value }) }),
      h("span", { text: label }),
      meta ? h("small", { text: meta }) : null,
    );
  sessions.append(sessionRadio("author", "Author", info.author ? `${info.author.harness} ${info.author.short}` : "none registered: a new session"));
  for (const s of info.sessions) sessions.append(sessionRadio(s.id, `${s.harness} ${s.short}`, `${s.roles.join(", ")} · ${ago(s.lastSeen)} · ${s.liveness}`));
  if (e.session !== "author" && !info.sessions.some((s) => s.id === e.session)) sessions.append(sessionRadio(e.session, `session ${e.session}`, "not registered for this page"));
  if (!info.sessions.length) sessions.append(h("div", { class: "attach-hint", text: "No agent session has opened, patched or polled this page yet." }));

  const harness = h("select", { class: "attach-select", "aria-label": "Harness", disabled: fieldsOff, onchange: (ev) => saveAttach({ harness: (ev.target as HTMLSelectElement).value }) });
  for (const [name, hi] of Object.entries(info.harnesses)) harness.append(h("option", { value: name, selected: name === e.harness, text: hi.found ? name : `${name} (not found)` }));
  const models = info.harnesses[runHarness]?.models;
  const modelCap = info.harnesses[runHarness]?.capabilities.model;
  const model = h("input", {
    type: "text",
    class: "attach-input",
    "aria-label": "Model",
    list: models?.length ? "attach-models" : null,
    value: e.model ?? "",
    placeholder: modelCap && !modelCap.ok ? modelCap.reason : "the harness's default",
    spellcheck: "false",
    autocomplete: "off",
    disabled: fieldsOff || (!!modelCap && !modelCap.ok),
    onchange: (ev) => saveAttach({ model: (ev.target as HTMLInputElement).value.trim() || null }),
  });
  const datalist = models?.length ? h("datalist", { id: "attach-models" }, ...models.map((m) => h("option", { value: m }))) : null;
  attachPop.append(modes, sessions, field("Harness (for a new session)", harness), field("Model", model, datalist));

  const grant = info.harnesses[info.target.harness]?.grantCommand;
  if (grant) {
    attachPop.append(
      h(
        "div",
        { class: "attach-warn attach-grant" },
        h("span", { text: `${info.target.harness} has no write grant: its runs cannot patch this page and end with “no reply”. Grant it once, at a terminal:` }),
        h("span", { class: "attach-cmd" }, h("code", { text: grant }), h("button", { type: "button", class: "btn tiny", text: "Copy", onclick: () => copyText(grant, "Command") })),
      ),
    );
  }
  for (const w of info.warnings) if (!(grant && w.includes(grant)) && !(info.auto && w.startsWith(info.auto))) attachPop.append(h("div", { class: "attach-warn", text: w }));
  attachPop.append(h("div", { class: "attach-run-slot" }));
  if (attach.error) attachPop.append(h("div", { class: "attach-error", role: "alert", text: attach.error }));
  renderAttachRun();
}

/** The popover's run section: its state, the buttons, and the log once asked for. */
function renderAttachRun() {
  const slot = attachPop?.querySelector(".attach-run-slot");
  if (!slot) return;
  slot.textContent = "";
  const run = attach.run;
  if (!run) return;
  const why = run.status === "failed" ? attach.message || RUN_REASONS[run.reason ?? ""] || run.reason || "" : run.status === "waiting_for_session" ? attach.message : "";
  slot.append(
    h(
      "div",
      { class: `attach-run ${run.status}` },
      h("div", { class: "attach-run-head" }, h("span", { class: "run-label" }, ...runLabel(run)), ...runButtons(run)),
      why ? h("div", { class: "attach-hint", text: why }) : null,
      attach.log ? h("pre", { class: "attach-log", text: attach.log.join("\n") || "(the log is empty)" }) : null,
    ),
  );
}

if (attachPill && attachPop) {
  attachPill.addEventListener("click", (e) => {
    e.stopPropagation();
    if (attachPop.hidden) openAttach();
    else closeAttach();
  });
  attachPop.addEventListener("click", (e) => e.stopPropagation());
  runStateEl?.addEventListener("click", (e) => e.stopPropagation());
  document.addEventListener("click", closeAttach);
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closeAttach();
  });
}

// ── mobile sheet ──

const isNarrow = () => window.matchMedia("(max-width: 860px)").matches;
function setSheet(open: boolean) {
  state.sheetOpen = open;
  SS.set(`austere:sheet:${SID}`, open);
  document.documentElement.classList.toggle("sheet-open", open);
  if (open) setTimeout(() => (log.scrollTop = log.scrollHeight), 50);
}
function renderDock() {
  const dock = $(".dock");
  const n = state.queue.length;
  const parts = ["Conversation"];
  if (n) parts.push(`${n} queued`);
  const last = state.transcript[state.transcript.length - 1];
  if (last?.role === "agent" && last.at > (SS.get<number>(`austere:seen:${SID}`) || 0)) parts.push("new reply");
  dock.innerHTML = `<span class="dock-grip"></span><span>${esc(parts.join(" · "))}</span><span class="dock-presence ${esc($(".presence").className.replace("presence", "").trim())}"></span>`;
}
function pulseDock() {
  const dock = $(".dock");
  dock.classList.remove("pulse");
  void dock.offsetWidth;
  dock.classList.add("pulse");
}
$(".dock").addEventListener("click", () => {
  SS.set(`austere:seen:${SID}`, Date.now());
  setSheet(true);
  renderDock();
});
$(".sheet-close").addEventListener("click", () => setSheet(false));
$(".scrim").addEventListener("click", () => setSheet(false));
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && state.sheetOpen && isNarrow()) setSheet(false);
});
let touchY: number | null = null;
$(".panel-head").addEventListener("touchstart", (e) => (touchY = e.touches[0].clientY), { passive: true });
$(".panel-head").addEventListener(
  "touchend",
  (e) => {
    if (touchY != null && e.changedTouches[0].clientY - touchY > 60) setSheet(false);
    touchY = null;
  },
  { passive: true },
);
$(".dock").addEventListener("touchstart", (e) => (touchY = e.touches[0].clientY), { passive: true });
$(".dock").addEventListener(
  "touchend",
  (e) => {
    if (touchY != null && touchY - e.changedTouches[0].clientY > 40) setSheet(true);
    touchY = null;
  },
  { passive: true },
);

// ── server events ──

// Third-party packs run their own code inside the page, which is also where
// annotations and button presses come from: say so, so the reviewer reads the
// queue before sending.
function showPackNotice(packs: string[] | undefined) {
  const notice = $(".notice");
  if (!packs || !packs.length) {
    notice.hidden = true;
    return;
  }
  // Lead with what to do: on a phone the line is cut to fit.
  notice.textContent = `Third-party pack code runs in this page: check queued items before you send (${packs.join(", ")}).`;
  notice.title = notice.textContent;
  notice.hidden = false;
}

function showBanner(text: string, actions: HTMLElement[] = []) {
  banner.textContent = "";
  if (!text) {
    banner.hidden = true;
    return;
  }
  banner.append(h("span", { text }), ...actions);
  banner.hidden = false;
}

function mergeEntries(entries: Entry[]) {
  for (const e of entries) {
    const i = state.transcript.findIndex((x) => x.id === e.id);
    if (e.discarded) {
      if (i >= 0) state.transcript.splice(i, 1);
    } else if (i >= 0) state.transcript[i] = e;
    else state.transcript.push(e);
  }
  state.transcript.sort((a, b) => a.at - b.at);
}

/** The page starts with the latest entries; older ones load on request. */
async function loadEarlier() {
  const first = state.transcript[0];
  if (!first) return;
  try {
    const r = await fetch(`${BASE}/transcript?before=${encodeURIComponent(first.id)}`);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const d: { entries?: Entry[]; more?: boolean } = await r.json();
    const known = new Set(state.transcript.map((e) => e.id));
    state.transcript = [...(d.entries || []).filter((e) => !e.discarded && !known.has(e.id)), ...state.transcript];
    state.more = !!d.more;
    const fromBottom = log.scrollHeight - log.scrollTop;
    renderLog();
    log.scrollTop = log.scrollHeight - fromBottom;
  } catch (err) {
    composerError(`Could not load earlier messages: ${(err as Error).message}`);
  }
}

let es: EventSource | null = null;
let disconnectedAt = 0;
function connect() {
  es = new EventSource(`${BASE}/events`);
  const source = es;
  source.addEventListener("open", () => {
    state.connected = true;
    disconnectedAt = 0;
    showBanner("");
    renderPresence();
  });
  source.addEventListener("error", () => {
    state.connected = false;
    if (!disconnectedAt) disconnectedAt = Date.now();
    renderPresence();
    setTimeout(() => {
      if (!state.connected && Date.now() - disconnectedAt > 3500) {
        showBanner("Lost the austere-axi server. Run any austere-axi command to restart it; this page reconnects on its own.", [
          h("button", { type: "button", class: "btn tiny", text: "Reload", onclick: () => location.reload() }),
        ]);
      }
    }, 4000);
  });
  if (OWNER) {
    // A published page's hosted viewers, relayed by the server (Q17), and the owner's own status and focus sent back.
    // The server keeps them for the page's socket; an unpublished page ignores them.
    const sendPresence = (frame: ClientPresence) => {
      fetch(`${BASE}/presence`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(frame) }).catch(() => {});
    };
    source.addEventListener("open", () => presence.connect(sendPresence));
    source.addEventListener("error", () => presence.disconnect());
    source.addEventListener("viewer", (e) => {
      const parsed = parseServerFrame(e.data);
      const f = parsed.ok ? parsed.value : null;
      if (f && (f.t === "hello" || f.t === "status" || f.t === "focus" || f.t === "bye")) presence.handle(f);
    });
    // The Agent pill (RLM-346): the setting and the runs, again on each (re)connect; then each run's changes as they happen.
    source.addEventListener("snapshot", () => {
      void loadAttach();
      void loadRunMarks();
    });
    source.addEventListener("attach", () => void loadAttach());
    source.addEventListener("run", (e) => {
      const d = JSON.parse(e.data) as RunEvent;
      const ended = !ACTIVE.has(d.run.status) || d.run.status === "failed";
      if (attach.run?.id !== d.run.id) attach.log = null;
      attach.runGen++;
      attach.run = d.run;
      attach.message = d.message ?? "";
      addRunMarks(d.run, d.message);
      renderLog();
      renderRunState();
      // A run that ended may have registered a session (A18): the popover's list changes.
      if (ended) void loadAttach();
    });
  }
  source.addEventListener("snapshot", (e) => {
    const d: SnapshotEvent = JSON.parse(e.data);
    state.transcript = (d.transcript || []).filter((e) => !e.discarded);
    state.presence = d.presence;
    state.archived = !!d.session.archived;
    state.unread = d.session.unread || 0;
    state.more = !!d.more;
    state.links = d.links;
    if (d.version && d.version !== BOOT.version) {
      showBanner("austere-axi was updated. This page is running the previous version.", [
        h("button", { type: "button", class: "btn tiny", text: "Reload", onclick: () => location.reload() }),
      ]);
    }
    showPackNotice(d.thirdPartyPacks);
    state.thirdParty = !!d.thirdPartyPacks?.length;
    // First snapshot: errors the frame reported before it belong to this revision.
    // A reconnect on the same revision resends what may have been lost (the server drops repeats).
    // On a newer revision the held errors describe an old program: the new render reports its own.
    // The same program on a newer revision (only the page shell changed) renders the same errors.
    if (state.program === null || d.revision === state.revision || d.program === state.program) {
      if (d.revision !== state.revision) state.errorsRevision = d.revision;
      state.revision = d.revision;
      reportRenderErrors();
    } else {
      state.revision = d.revision;
      state.parserErrors = [];
      state.runtimeErrors = [];
      state.renderReport = null;
    }
    if (state.program === null) state.program = d.program;
    else if (d.program !== state.program) {
      state.program = d.program;
      if (state.frameReady) post({ type: "source", program: d.program });
    }
    renderPresence();
    renderLog();
    setMode(state.mode);
  });
  source.addEventListener("transcript", (e) => {
    mergeEntries((JSON.parse(e.data) as { entries?: Entry[] }).entries || []);
    renderLog();
    renderDock();
  });
  source.addEventListener("presence", (e) => {
    const d: PresenceEvent = JSON.parse(e.data);
    state.presence = d.presence;
    state.archived = !!d.archived;
    state.unread = d.unread || 0;
    setMode(state.mode);
    renderPresence();
    renderLog();
  });
  source.addEventListener("changed", (e) => {
    const d: ChangedEvent = JSON.parse(e.data);
    state.revision = d.revision;
    state.renderReport = null;
    state.parserErrors = [];
    state.runtimeErrors = [];
    showPackNotice(d.thirdPartyPacks);
    state.thirdParty = !!d.thirdPartyPacks?.length;
    if (d.shellChanged || !state.frameReady) {
      state.program = d.program;
      // A full reload reports no changes: drop the previous turn's.
      state.changes = [];
      renderChanges();
      loadFrame();
    } else {
      state.program = d.program;
      post({ type: "source", program: d.program });
    }
    renderLog();
  });
  source.addEventListener("server", (e) => {
    const d: { state: string } = JSON.parse(e.data);
    if (d.state === "revoked") {
      source.close();
      state.connected = false;
      showBanner("Your invite was revoked. Ask the owner for a new link.");
      return;
    }
    if (d.state === "stopped") {
      showBanner("The austere-axi server stopped. Run any austere-axi command to start it again; this page reconnects on its own.");
    }
  });
}

// ── hosted: asset token and the page socket (docs/hosted-share-links.md, "Sync, access and presence") ──

// The page row's publishedAt the shell was built for; a later one offers a reload.
let publishedAt = HOSTED?.publishedAt;
// Highest row seq applied, kept for the tab: a reconnect pulls after it.
let cursor = 0;

/** Nothing more can be sent: say why in the presence label and the banner, and stop syncing. */
function lock(label: string, message: string, actions: HTMLElement[] = []) {
  lockout = label;
  state.connected = false;
  sync?.stop();
  showBanner(message, actions);
  renderPresence();
  renderComposer();
}

/** Locks on an answer that means this reviewer cannot get in (403) or the page is gone (404, 410). */
function refused(status: number): boolean {
  if (status === 403) {
    if (invite) lock("Invite no longer valid", "This invite is no longer valid. Ask the page owner for a new link.");
    else lock("Invite required", "This page is invite-only. Open it from the link the page owner sent you.");
  } else if (status === 404 || status === 410) lock("Page removed", "This page is no longer available.");
  else return false;
  return true;
}

/** POST {base}/asset-token: trades the invite (none on an unlisted page) for a 10-minute frame token. */
async function requestAssetToken(signal?: AbortSignal): Promise<{ status: number; token?: string; name?: string | null }> {
  const r = await fetch(`${BASE}/asset-token`, { method: "POST", headers: invite ? { "X-Austere-Invite": invite } : {}, signal });
  if (!r.ok) return { status: r.status };
  const d = (await r.json().catch(() => null)) as { token?: unknown; name?: unknown } | null;
  const token = typeof d?.token === "string" && /^[A-Za-z0-9_-]+$/.test(d.token) ? d.token : undefined;
  return { status: r.status, token, name: typeof d?.name === "string" && d.name ? d.name.slice(0, NAME_MAX) : null };
}

/** Loads the frame from `${artifactUrl}<assetToken>/` and learns who the reviewer is. */
async function loadHostedFrame(): Promise<boolean> {
  const answer = await requestAssetToken().catch(() => null);
  if (answer && refused(answer.status)) return false;
  if (!answer?.token) {
    showBanner(`Could not load this page${answer ? ` (HTTP ${answer.status})` : ""}.`, [
      h("button", { type: "button", class: "btn tiny", text: "Retry", onclick: () => startHosted() }),
    ]);
    return false;
  }
  inviteName = answer.name ?? null;
  if (inviteName) viewerName = inviteName;
  else {
    // An unlisted page answered without a name: the stored invite is not valid here, so stop sending it.
    if (invite) {
      invite = null;
      LS.remove(INVITE_KEY);
    }
    viewerName = String(LS.get("austere:name", "") || "").slice(0, NAME_MAX);
  }
  renderViewer();
  renderComposer();
  frame.src = `${BOOT.artifactUrl ?? `${BASE}/a/`}${answer.token}/`;
  return true;
}

/** Base64 of `bytes`, in chunks (spreading a whole runtime into fromCharCode overflows the stack). */
function base64(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

async function gzipBase64(code: string): Promise<string> {
  const stream = new Blob([code]).stream().pipeThrough(new CompressionStream("gzip"));
  return base64(new Uint8Array(await new Response(stream).arrayBuffer()));
}

// The published page's script tags: the pinned runtime and bundled packs (/rt/), and installed packs
// (/pk/). The service refuses any other `src`, so these are all the page runs.
const HOSTED_SCRIPT_RE = /<script\b[^>]*\bsrc\s*=\s*["'](\/(?:rt|pk)\/[^"']+)["'][^>]*>\s*<\/script\s*>/gi;

/**
 * Hosted "Download standalone HTML": the published page with its scripts packed in, in the format
 * `export` writes (src/shared/standalone.ts), so it opens offline. Images are already inlined by `publish`.
 */
async function downloadStandalone(): Promise<void> {
  const item = $<HTMLButtonElement>('[data-cmd="export"]');
  if (item.disabled) return;
  item.disabled = true;
  item.textContent = "Preparing download…";
  let url: string | undefined;
  try {
    const answer = await requestAssetToken();
    if (!answer.token) throw new Error(`HTTP ${answer.status}`);
    const r = await fetch(`${BOOT.artifactUrl ?? `${BASE}/a/`}${answer.token}/`);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const html = await r.text();
    const tags = [...html.matchAll(HOSTED_SCRIPT_RE)];
    if (!tags.length) throw new Error("the page has no runtime script");
    const packed = await Promise.all(
      tags.map(async (m) => {
        const s = await fetch(m[1]);
        if (!s.ok) throw new Error(`${m[1]}: HTTP ${s.status}`);
        return packedTag(m[1].replace(/^\/rt\/[^/]+\//, ""), await gzipBase64(await s.text()));
      }),
    );
    // All blocks and the loader where the first tag was: the runtime first, then the packs, in page order.
    let i = 0;
    const out = html.replace(HOSTED_SCRIPT_RE, () => (i++ ? "" : [...packed, LOADER_TAG].join("\n")));
    url = URL.createObjectURL(new Blob([out], { type: "text/html" }));
    const slug = BOOT.title.replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-+|-+$/g, "").slice(0, 80) || "page";
    // In the document while clicked: Firefox ignores a click on a detached download anchor.
    const a = h("a", { href: url, download: `${slug}.html`, hidden: true });
    document.body.append(a);
    a.click();
    a.remove();
  } catch (err) {
    showBanner(`Could not build the download: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    // Late enough for the browser to have read the blob, on every path that made one.
    if (url) setTimeout(URL.revokeObjectURL, 60_000, url);
    item.disabled = false;
    item.textContent = "Download standalone HTML";
  }
}

/** Applies rows as upserts by (type, id), then stores the cursor. */
function applyChanges(changes: ReceivedChanges) {
  if (changes.reset) state.transcript = [];
  const entries: Entry[] = [];
  for (const row of changes.rows) {
    if (row.type === "page") applyPage(row);
    // Reviewers see notes in every state; discarded ones are hidden.
    else if (row.type === "note") entries.push({ id: `note:${row.id}`, role: "user", author: row.author.slice(0, NAME_MAX), items: row.items, at: row.at, discarded: row.state === "discarded" });
    else if (row.type === "reply") entries.push({ id: `reply:${row.id}`, role: "agent", text: row.text, at: row.at });
  }
  mergeEntries(entries);
  cursor = changes.cursor;
  renderLog();
  renderDock();
}

function applyPage(row: PageRow) {
  // The server closes the socket (1000) after a deleted page's row.
  if (row.deleted) return lock("Page removed", "The owner removed this page.");
  publishedAt ??= row.publishedAt;
  if (row.publishedAt !== publishedAt) {
    showBanner("New version, reload", [h("button", { type: "button", class: "btn tiny", text: "Reload", onclick: () => location.reload() })]);
  }
  showPackNotice(row.packs.map((p) => p.name));
  renderShare(row.unlisted);
}

/**
 * Sharing follows the page, not the viewer: on an unlisted page the plain URL lets anyone in, so every
 * viewer (invited or not) may copy it; on an invite-only page each link names one reviewer, so the menu
 * says how the owner invites someone instead.
 */
function renderShare(unlisted: boolean) {
  $('[data-cmd="copy-link"]').hidden = !unlisted;
  $("[data-share-note]").hidden = unlisted;
}

/**
 * An ack settles one queued note. `rate_limited` keeps it in the outbox and sends the same mutation
 * again after `retryAfter` (the service does not store that answer). Any other error puts its items
 * back in the queue to be edited and sent again.
 */
function settle(ack: AckFrame) {
  const i = outbox.findIndex((o) => o.m.clientId === ack.clientId && o.m.n === ack.n);
  if (i < 0) return;
  if (ack.error?.code === "rate_limited") {
    const entry = outbox[i];
    const wait = Math.max(1, ack.error.retryAfter ?? 5);
    // The deadline is saved with the note, so a reconnect or a reload waits it out too.
    entry.retryAt = Date.now() + wait * 1000;
    outboxUnsaved = !SS.set(OUTBOX_KEY, outbox);
    rateLimited = `Too many notes for now: sending again in ${wait} s.`;
    showOutboxNotice();
    sendWhenDue(entry);
    return;
  }
  const [done] = outbox.splice(i, 1);
  // Saved again, or every note acked: nothing is left to lose on a reload.
  const saved = SS.set(OUTBOX_KEY, outbox);
  if (outboxUnsaved && (saved || !outbox.length)) outboxUnsaved = false;
  if (!outbox.some((o) => o.retryAt)) rateLimited = null;
  showOutboxNotice();
  if (ack.error) {
    for (const item of done.m.args.items) addToQueue({ ...item });
    composerError(`Not sent: ${ack.error.message}. Your notes are back in the queue.`);
  }
  renderLog();
  renderDock();
}

function onSyncFrame(frame: ReceivedFrame) {
  if (frame.t === "changes") applyChanges(frame);
  else if (frame.t === "ack") settle(frame);
  // `forbidden` and `upgrade_required` come before the server closes the socket: onSyncClose says why.
  else if (frame.t === "error" && frame.code !== "forbidden" && frame.code !== "upgrade_required") composerError(frame.message);
}

function onSyncClose(close: SyncClose, retrying: boolean) {
  state.connected = false;
  if (!retrying && !lockout) {
    if (close.error?.code === "upgrade_required") {
      lock("Update needed", "This page needs a newer review page. Reload to get it.", [
        h("button", { type: "button", class: "btn tiny", text: "Reload", onclick: () => location.reload() }),
      ]);
    } else if (close.code === 1000 && !close.error) lock("Page removed", "This page is no longer available.");
    // `forbidden` and close 1008: the invite was revoked or expired, or the page is no longer unlisted.
    else refused(403);
  }
  renderPresence();
}

/**
 * Hosted boot: trade for the frame's token, then open the page socket. It carries the rows, the
 * note mutations and presence (the server sends no presence on a --no-presence page).
 */
const RETRY_CHECK_MS = 5_000;

async function startHosted() {
  showBanner("");
  if (!(await loadHostedFrame()) || sync) return;
  const socket = openSyncSocket({
    url: `${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}${BASE}/sync`,
    protocols: () => syncProtocols(invite ? { invite } : {}),
    // A refused handshake shows no status to the page: ask the asset-token route why.
    mayRetry: async (close) => {
      if (lockout) return false;
      if (close.opened) return true;
      // A stalled check must not hold up the next attempt: past 5 s it counts as offline, and the socket retries.
      const answer = await requestAssetToken(AbortSignal.timeout(RETRY_CHECK_MS)).catch(() => null);
      return !(answer && refused(answer.status));
    },
  });
  sync = socket;
  socket.onOpen(() => {
    state.connected = true;
    socket.send({ v: SYNC_VERSION, t: "pull", after: cursor });
    // Unacked notes go again, in order; the server answers a repeat (clientId, n) with the same ack.
    for (const o of mine()) sendWhenDue(o);
    renderPresence();
  });
  socket.onFrame(onSyncFrame);
  socket.onClose(onSyncClose);
  socket.onOpen(() => presence.connect((frame) => void socket.send(frame)));
  socket.onFrame((f) => {
    if (f.t === "hello" || f.t === "status" || f.t === "focus" || f.t === "bye") presence.handle(f);
  });
  socket.onClose(() => presence.disconnect());
}


// ── boot ──

setMode(state.mode);
if (isNarrow() && state.sheetOpen) setSheet(true);
renderPresence();
renderLog();
renderDock();
if (HOSTED) startHosted();
else {
  loadFrame();
  connect();
}
