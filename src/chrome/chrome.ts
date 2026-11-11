// Review chrome: artifact frame + conversation panel. Plain DOM, no framework.

// The local server inlines the boot object as window.__AUSTERE__. The hosted
// service's CSP forbids inline scripts, so it ships the same object as JSON in
// <script type="application/json" id="austere-boot">.

type Mode = "annotate" | "explore";

/** The boot object the server hands the page. */
interface Boot {
  id: string;
  title: string;
  name: string;
  file: string;
  version?: string;
  artifactUrl?: string;
  hosted?: { base?: string; report?: string } | null;
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
  | { type: "open-url"; url: unknown }
);

/** Messages the chrome posts to the frame. */
type ChromeMessage =
  | { type: "init"; mode: Mode; state: unknown; scrollY: number }
  | { type: "reveal"; id: string | undefined }
  | { type: "mode"; mode: Mode }
  | { type: "highlight"; ids: string[]; scroll: boolean }
  | { type: "source"; program: string };

interface SessionInfo {
  status: string;
  endedBy: string | null;
  closed?: boolean;
  unread?: number;
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
}

interface PresenceEvent extends SessionInfo {
  presence: string;
}

interface ChangedEvent {
  program: string;
  shellChanged?: boolean;
  thirdPartyPacks?: string[];
}

interface HostedConversation {
  notes?: { seq: number; author?: string; items?: unknown; at: number }[];
  replies?: { seq: number; text?: string; at: number }[];
  publishedAt?: unknown;
  cursor?: string | number | null;
  thirdPartyPacks?: string[];
}

interface ItemOptions {
  queued?: boolean;
  held?: boolean;
}

type AttrValue = string | boolean | null | undefined | ((e: Event) => unknown);
type Child = Node | string | number | null | undefined | false;

const BOOT: Boot = (window as Window & { __AUSTERE__?: Boot }).__AUSTERE__ ?? JSON.parse(document.getElementById("austere-boot")?.textContent || "{}");
const SID = BOOT.id;
// Hosted mode (austere-cloud, docs/hosted-share-links.md): a public reviewer
// page that polls instead of streaming and has no owner controls.
const HOSTED = BOOT.hosted || null;
const BASE = BOOT.hosted?.base ?? `/s/${SID}`;
const VIEWER = BOOT.viewer || { role: "owner", name: "" };
const OWNER = !HOSTED && VIEWER.role === "owner";
const NAME_MAX = 40;
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
};
const SS = {
  get<T = unknown>(key: string): T | null {
    try {
      return JSON.parse(sessionStorage.getItem(key) || "null");
    } catch {
      return null;
    }
  },
  set(key: string, value: unknown) {
    try {
      sessionStorage.setItem(key, JSON.stringify(value));
    } catch {
      // ignore
    }
  },
};
// A hosted reviewer names themself once; the local server names invited reviewers.
let viewerName: string = HOSTED ? String(LS.get("austere:name", "") || "").slice(0, NAME_MAX) : VIEWER.name;

const state: {
  mode: Mode;
  queue: QueueItem[];
  transcript: Entry[];
  presence: string;
  status: string;
  endedBy: string | null;
  closed: boolean;
  unread: number;
  more: boolean;
  program: string | null;
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
  status: "open",
  endedBy: null,
  closed: false,
  unread: 0,
  more: false,
  program: null,
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
      <span class="presence"></span>
      <div class="menu">
        <button type="button" class="icon-btn menu-btn" aria-label="More">⋯</button>
        <div class="menu-pop" hidden>
          <button type="button" data-cmd="copy-path">Copy file path</button>
          <button type="button" data-cmd="copy-link">Copy review link</button>
          <button type="button" data-cmd="reload">Reload artifact</button>
          <a data-cmd="export" href="${BASE}/export">Download standalone HTML</a>
          <button type="button" data-cmd="end" class="danger">End review</button>
          <button type="button" data-cmd="close" class="danger">Close review</button>
          <button type="button" data-cmd="reopen">Reopen review</button>
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

if (!OWNER) {
  for (const sel of ['[data-cmd="copy-path"]', '[data-cmd="copy-link"]', '[data-cmd="export"]', '[data-cmd="end"]', '[data-cmd="close"]', '[data-cmd="reopen"]', ".send-end"]) $(sel)?.remove();
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
        const r = await fetch(HOSTED.report as string, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ reason }) });
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
  frame.src = `${BOOT.artifactUrl ?? `${BASE}/a/`}?r=${Date.now()}`;
}

window.addEventListener("message", (e) => {
  if (e.source !== frame.contentWindow) return;
  const d = e.data as FrameMessage | null | undefined;
  if (!d || d.austere !== 1) return;
  switch (d.type) {
    case "hello":
      post({
        type: "init",
        mode: state.closed ? "explore" : state.mode,
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
      break;
    case "annotate":
      addToQueue(d.item);
      break;
    case "action":
      addToQueue(d.item);
      pulseDock();
      break;
    case "errors":
      state.parserErrors = (d.errors || []).filter((x) => x.severity !== "warning");
      renderLog();
      break;
    case "runtime-error":
      const error = d.error;
      if (error && !state.runtimeErrors.some((x) => x.statementId === error.statementId && x.message === error.message)) {
        state.runtimeErrors.push(error);
        renderLog();
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
  if (state.closed || !raw || typeof raw !== "object" || typeof (raw as { kind?: unknown }).kind !== "string") return;
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
  if (HOSTED) return entry.author === viewerName ? h("div", { class: "receipt" }, h("em", { text: "Sent to the page owner" })) : null;
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
    const box = h("div", { class: "issues" }, h("div", { class: "issues-head", text: `Render issues (${issues.length})` }));
    for (const err of issues.slice(0, 8)) {
      box.append(
        h(
          "div",
          { class: "issue" },
          h("div", { class: "issue-text" }, err.statementId ? h("code", { text: err.statementId }) : null, " ", err.message),
          state.closed
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
  if (!state.transcript.length && !state.queue.length) {
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
  for (const entry of state.transcript) {
    if (entry.role === "agent") {
      log.append(
        h(
          "div",
          { class: "msg agent" },
          h("div", { class: "who", text: `Agent · ${fmtTime(entry.at)}` }),
          h("div", { class: "md", html: markdown(entry.text) }),
        ),
      );
    } else {
      const bubble = h("div", { class: `msg user${entry.held ? " held" : ""}` }, h("div", { class: "who", text: `${whoLabel(entry)} · ${fmtTime(entry.at)}${entry.end ? " · ended review" : ""}` }));
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
  if (state.closed) {
    log.append(h("div", { class: "ended-note", text: OWNER ? "You closed this review." : "The owner closed this review." }));
  } else if (state.status === "ended") {
    const who = state.endedBy === "agent" ? "The agent ended this review." : OWNER ? "You ended this review." : "The owner ended this review.";
    log.append(h("div", { class: "ended-note", text: `${who} Notes you send now reach the agent the next time it polls.` }));
  }
  const count = state.transcript.length + state.queue.length;
  if (scrollToEnd || atBottom || count !== lastLogCount) log.scrollTop = log.scrollHeight;
  lastLogCount = count;
  renderComposer();
}

// ── composer / sending ──

// Hosted: set once the service answers 404/410 for this page; nothing more can be sent.
let gone = false;

function renderComposer() {
  const closed = state.closed;
  const n = state.queue.length;
  textarea.disabled = closed || gone || state.sending;
  $<HTMLButtonElement>(".send").disabled = closed || gone || state.sending;
  if ($(".send-end")) $<HTMLButtonElement>(".send-end").disabled = closed || state.sending;
  $(".send").textContent = state.sending ? "Sending…" : n ? `Send ${n}` : "Send";
  textarea.placeholder = closed ? "Review closed" : n ? "Add a message (optional)…" : "Message the agent…";
}

function composerError(text: string) {
  const el = $(".composer-error");
  el.textContent = text || "";
  el.hidden = !text;
}

async function sendAll(end = false) {
  if (state.sending || state.closed) return;
  const text = textarea.value.trim();
  const items: QueueItem[] = state.queue.map(({ qid, ...rest }) => rest);
  if (text) items.push({ kind: "message", text });
  if (!items.length && !end) {
    textarea.focus();
    return;
  }
  if (end && !OWNER) return;
  if (end && !items.length && !confirm("End this review? The agent will stop listening; notes you send later still reach it.")) return;
  if (HOSTED && !viewerName && nameForm) {
    nameForm.hidden = false;
    $("input", nameForm).focus();
    return;
  }
  state.sending = true;
  composerError("");
  renderComposer();
  try {
    const r = await fetch(`${BASE}/send`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(HOSTED ? { name: viewerName, items } : { items, end }),
    });
    const data: { error?: string; entry?: Entry } = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
    state.queue = [];
    saveQueue();
    textarea.value = "";
    const entry = data.entry;
    if (entry && !state.transcript.some((e) => e.id === entry.id)) state.transcript.push(entry);
    if (HOSTED) pollConversation();
  } catch (err) {
    composerError(`Not sent: ${(err as Error).message}. Your notes are still queued.`);
  } finally {
    state.sending = false;
    renderLog(true);
    renderDock();
  }
}

$(".composer").addEventListener("submit", (e) => {
  e.preventDefault();
  sendAll(false);
});
$(".send-end")?.addEventListener("click", () => sendAll(true));
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
  for (const b of document.querySelectorAll<HTMLButtonElement>(".seg button")) b.classList.toggle("on", b.dataset.mode === state.mode);
  post({ type: "mode", mode: state.closed ? "explore" : state.mode });
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
  if (state.closed) [label, cls] = ["Review closed", "ended"];
  else if (gone) [label, cls] = ["Page removed", "ended"];
  else if (!state.connected) [label, cls] = ["Reconnecting…", "off"];
  else if (HOSTED) [label, cls] = ["Shared page", "hosted"];
  else if (state.presence === "listening") [label, cls] = ["Agent listening", "listening"];
  else if (state.presence === "working") [label, cls] = ["Agent working", "working"];
  else if (state.status === "ended") [label, cls] = ["Agent stopped", "idle"];
  else [label, cls] = ["Agent not listening", "idle"];
  if (cls === "idle" && state.unread) label += ` · ${state.unread} waiting`;
  el.className = `presence ${cls}`;
  el.textContent = label;
  el.title =
    cls === "idle"
      ? "Your notes are kept and reach the agent the next time it polls."
      : cls === "working"
        ? "The agent has your last batch."
        : cls === "hosted"
          ? "Notes go to the page owner. Replies show up within 30 seconds."
          : "";
  document.documentElement.classList.toggle("is-ended", state.closed);
  if (OWNER) {
    $('[data-cmd="end"]').hidden = state.status === "ended";
    $('[data-cmd="close"]').hidden = state.closed;
    $('[data-cmd="reopen"]').hidden = !state.closed && state.status !== "ended";
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
$(".menu-btn").addEventListener("click", (e) => {
  e.stopPropagation();
  menuPop.hidden = !menuPop.hidden;
});
document.addEventListener("click", () => (menuPop.hidden = true));
menuPop.addEventListener("click", async (e) => {
  const cmd = e.target instanceof Element ? e.target.closest<HTMLElement>("[data-cmd]")?.dataset.cmd : undefined;
  if (!cmd) return;
  if (cmd === "copy-path") navigator.clipboard?.writeText(BOOT.file);
  if (cmd === "copy-link") navigator.clipboard?.writeText(state.links?.remote || location.href);
  if (cmd === "reload") loadFrame();
  if (cmd === "end") {
    if (state.queue.length) return sendAll(true);
    if (!confirm("End this review? The agent will stop listening.")) return;
    await fetch(`${BASE}/end`, { method: "POST" }).catch(() => {});
  }
  if (cmd === "close") {
    if (!confirm("Close this review? No one can add notes until you reopen it.")) return;
    await fetch(`${BASE}/close`, { method: "POST" }).catch(() => {});
  }
  if (cmd === "reopen") await fetch(`${BASE}/reopen`, { method: "POST" }).catch(() => {});
});

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
  source.addEventListener("snapshot", (e) => {
    const d: SnapshotEvent = JSON.parse(e.data);
    state.transcript = (d.transcript || []).filter((e) => !e.discarded);
    state.presence = d.presence;
    state.status = d.session.status;
    state.endedBy = d.session.endedBy;
    state.closed = !!d.session.closed;
    state.unread = d.session.unread || 0;
    state.more = !!d.more;
    state.links = d.links;
    if (d.version && d.version !== BOOT.version) {
      showBanner("austere-axi was updated. This page is running the previous version.", [
        h("button", { type: "button", class: "btn tiny", text: "Reload", onclick: () => location.reload() }),
      ]);
    }
    showPackNotice(d.thirdPartyPacks);
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
    state.status = d.status;
    state.endedBy = d.endedBy;
    state.closed = !!d.closed;
    state.unread = d.unread || 0;
    setMode(state.mode);
    renderPresence();
    renderLog();
  });
  source.addEventListener("changed", (e) => {
    const d: ChangedEvent = JSON.parse(e.data);
    state.parserErrors = [];
    state.runtimeErrors = [];
    showPackNotice(d.thirdPartyPacks);
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
  source.addEventListener("ended", (e) => {
    const d: { by: string | null; closed?: boolean } = JSON.parse(e.data);
    state.status = "ended";
    state.endedBy = d.by;
    if (d.closed) {
      state.closed = true;
      post({ type: "mode", mode: "explore" });
    }
    renderPresence();
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

// Hosted: no live stream. Check {base}/conversation every 30 s and on focus.
const POLL_MS = 30_000;
let cursor: string | number | null = null;
let publishedAt: unknown = null;
let polling: Promise<void> | null = null;
let pollAgain = false;

/** Maps the service's notes and replies onto transcript entries. */
function hostedEntries(d: HostedConversation): Entry[] {
  const notes = (d.notes || []).map((n): Entry => ({ id: `n${n.seq}`, role: "user", author: String(n.author || "").slice(0, NAME_MAX), items: Array.isArray(n.items) ? n.items.filter((x: unknown): x is QueueItem => !!x && typeof x === "object") : [], at: n.at }));
  const replies = (d.replies || []).map((r): Entry => ({ id: `r${r.seq}`, role: "agent", text: String(r.text || ""), at: r.at }));
  return [...notes, ...replies];
}

async function pollConversation(): Promise<void> {
  if (gone) return;
  if (polling) {
    pollAgain = true;
    return polling;
  }
  polling = (async () => {
    try {
      const r = await fetch(`${BASE}/conversation${cursor == null ? "" : `?after=${encodeURIComponent(cursor)}`}`, { cache: "no-store" });
      if (r.status === 404 || r.status === 410) {
        gone = true;
        state.connected = false;
        showBanner("This page is no longer available.");
        renderPresence();
        renderComposer();
        return;
      }
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const d: HostedConversation = await r.json();
      state.connected = true;
      if (publishedAt == null) publishedAt = d.publishedAt;
      else if (d.publishedAt !== publishedAt) {
        showBanner("New version, reload", [h("button", { type: "button", class: "btn tiny", text: "Reload", onclick: () => location.reload() })]);
      }
      if (d.cursor != null) cursor = d.cursor;
      mergeEntries(hostedEntries(d));
      showPackNotice(d.thirdPartyPacks);
    } catch {
      state.connected = false;
    } finally {
      polling = null;
      renderPresence();
      renderLog();
      renderDock();
    }
    if (pollAgain) {
      pollAgain = false;
      await pollConversation();
    }
  })();
  return polling;
}

function startPolling() {
  pollConversation();
  setInterval(pollConversation, POLL_MS);
  window.addEventListener("focus", () => pollConversation());
}

if (!HOSTED) {
  window.addEventListener("pagehide", (e) => {
    if (!e.persisted) navigator.sendBeacon?.(`${BASE}/bye`);
  });
}

// ── boot ──

setMode(state.mode);
if (isNarrow() && state.sheetOpen) setSheet(true);
renderPresence();
renderLog();
renderDock();
loadFrame();
if (HOSTED) startPolling();
else connect();

// A module, so its top-level names stay out of the global scope of the type check.
export {};
