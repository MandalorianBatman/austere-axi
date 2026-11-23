// Review chrome: artifact frame + conversation panel. Plain DOM, no framework.

// The local server inlines the boot object as window.__AUSTERE__. The hosted
// service's CSP forbids inline scripts, so it ships the same object as JSON in
// <script type="application/json" id="austere-boot">.

import "./zod-jitless.ts";
import { SYNC_VERSION, parseServerFrame, syncProtocols } from "../shared/sync.ts";
import type { ClientPresence, PageRow, ReceivedChanges, ReceivedFrame } from "../shared/sync.ts";
import { Presence } from "./presence.ts";
import { openSyncSocket } from "./sync-socket.ts";
import type { SyncClose } from "./sync-socket.ts";
import { h } from "./dom.ts";
import type { Child } from "./dom.ts";
import { installNav } from "./nav.ts";
import { icon } from "./icons.ts";
import { LOADER_TAG, packedTag } from "../shared/standalone.ts";
import { mountApp } from "./review-app.tsx";
import { flash, reload, showBanner } from "./review-banner.ts";
import type { BannerAction } from "./review-banner.ts";
import { post, setFrame } from "./review-bridge.ts";
import { copyAgentPrompt, copyText, loadAgentPrompt } from "./review-clipboard.ts";
import {
  BASE,
  BOOT,
  HOSTED,
  LS,
  NAME_MAX,
  OWNER,
  SID,
  SS,
  str,
} from "./review-env.ts";
import { addToQueue } from "./review-notes.ts";
import { postHighlight } from "./review-changes.ts";
import { closePanel, openHistory, sendHistoryCounts } from "./review-history.ts";
import { archivePage, openShare, unarchivePage } from "./review-page.ts";
import { mergeEntries, putRunMark } from "./review-transcript.ts";
import { getSync, mine, refreshPending, sendWhenDue, setSync, settle } from "./review-outbox.ts";
import { setRoster, presenceView } from "./review-presence.ts";

import { S, isNarrow, set, setSheet, useReview } from "./review-store.ts";
import type { ReviewState } from "./review-store.ts";
import type {
  AttachChange,
  AttachInfo,
  AttachModeId,
  ChangedEvent,
  Entry,
  FrameMessage,
  Mode,
  PresenceEvent,
  RunEvent,
  RunMark,
  RunSummary,
  SnapshotEvent,
} from "./review-types.ts";

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

// The panels that React draws read the store (review-store.ts); the code that is still plain DOM reads and writes it
// as `state`. Each panel that moves takes its fields out of the code below.
const state = new Proxy({} as ReviewState, {
  get: (_, key: string) => S()[key as keyof ReviewState],
  set: (_, key: string, value: unknown) => {
    set({ [key]: value });
    return true;
  },
});

// ── markup ──

// Elements of the markup below: the queries are of known elements (a cast at the boundary).
const $ = <E extends Element = HTMLElement>(sel: string, root: ParentNode = document): E =>
  root.querySelector(sel) as E;

mountApp();

function renderViewer() {
  if (OWNER) return;
  const name = state.viewerName;
  $(".file").textContent = name ? `reviewing as ${name}` : "";
}

// Hosted: the report box and the footer.

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
        h("button", {
          type: "button",
          class: "btn tiny ghost",
          text: "Cancel",
          onclick: () => {
            if (reportForm) reportForm.hidden = true;
          },
        }),
        h("button", { type: "submit", class: "btn tiny primary", text: "Send report" }),
      ),
    )
  : null;
if (HOSTED) {
  const foot = h(
    "footer",
    { class: "hosted-foot" },
    h("a", {
      href: "https://github.com/MandalorianBatman/austere-axi",
      target: "_blank",
      rel: "noopener noreferrer",
      text: "Made with austere-axi",
    }),
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
        const headers: Record<string, string> = {
          "content-type": "application/json",
          ...(invite ? { "X-Austere-Invite": invite } : {}),
        };
        const r = await fetch(HOSTED?.report as string, {
          method: "POST",
          headers,
          body: JSON.stringify({ reason }),
        });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        $<HTMLTextAreaElement>("textarea", reportForm).value = "";
        reportForm.hidden = true;
        $(".report-open", foot).replaceWith(
          h("span", { class: "report-done", text: "Reported. Thank you." }),
        );
      } catch (err) {
        status.textContent = `Not sent: ${(err as Error).message}`;
      }
    });
  }
  $(".panel").append(foot);
}

const frame = $<HTMLIFrameElement>(".frame");
setFrame(frame);

// A hosted shell names no page (austere-cloud keeps the title from anyone without access): the
// asset-token answer and the frame bring the real one.
let pageTitle = BOOT.title;
function showTitle(title: string) {
  pageTitle = title;
  $(".title").textContent = title;
  document.title = `${title} · austere`;
}
showTitle(BOOT.title);
if (OWNER) $(".file").textContent = BOOT.name;
renderViewer();

// Presence (Q17): chips for the others on the page and their last click in the frame. The
// transport calls connect/handle/disconnect: the page socket when hosted, the server's relay locally.
const presence = new Presence({
  chips: $(".viewers"),
  showFocus: (marks) => post({ type: "presence", marks }),
  reveal: (id) => post({ type: "reveal", id }),
  name: () => state.viewerName || undefined,
});
setRoster(presence);
window.addEventListener("pagehide", () => presence.leave());

$(".file").title = BOOT.file || "";

// ── frame bridge ──

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
        // The owner's quick switcher: the frame hands Ctrl/Cmd+K over instead of letting the browser take it.
        quickSwitch: OWNER && !HOSTED,
      });
      break;
    case "ready":
      state.frameReady = true;
      if (typeof d.title === "string" && d.title.trim()) showTitle(d.title.trim());
      // A reloaded frame starts unmarked; it handles "highlight" from the start.
      if (state.highlight) postHighlight(false);
      sendHistoryCounts();
      presence.redraw();
      // The old frame's note box is gone, whether or not its blur arrived.
      presence.setWriting("note", false);
      // A search hit opened the page at one of its parts: outline it once the frame has rendered.
      nav?.frameReady();
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
      reportRenderErrors();
      break;
    case "runtime-error":
      const error = d.error;
      if (
        error &&
        !state.runtimeErrors.some(
          (x) => x.statementId === error.statementId && x.message === error.message,
        )
      ) {
        state.runtimeErrors = [...state.runtimeErrors, error];
        state.errorsRevision = state.revision;
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
      state.changes = Array.isArray(d.ids)
        ? d.ids.filter((id): id is string => typeof id === "string").slice(0, 50)
        : [];
      break;
    case "toggle-mode":
      setMode(state.mode === "annotate" ? "explore" : "annotate");
      break;
    case "quick-switch":
      // Ctrl/Cmd+K pressed inside the frame (sent only when init said the owner has a switcher).
      nav?.toggleSwitcher();
      break;
    case "history":
      // The popover's History (n) on a statement: the owner's only, and only a statement name is taken from the frame.
      if (OWNER && !HOSTED && typeof d.id === "string")
        openHistory(d.id.slice(0, 200));
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

// ── render errors ──

// The owner's page sends render failures to the agent on its own, so the agent never has to look
// at the page to learn it is broken. Each report carries the revision its errors came from; the
// server drops repeats and reports for an older revision. If the post fails, "Queue fix" stays.
let renderReportTimer: ReturnType<typeof setTimeout> | undefined;
function reportRenderErrors() {
  // Third-party pack code runs in the frame and could forge errors: the owner queues those by hand.
  if (!OWNER || state.archived || state.thirdParty) return;
  clearTimeout(renderReportTimer);
  renderReportTimer = setTimeout(async () => {
    const errors = [...state.parserErrors, ...state.runtimeErrors].map((e) => ({
      statement: str(e.statementId),
      message: str(e.message),
    }));
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
  }, 500);
}

// ── mode, presence, changes ──

function setMode(mode: string | undefined) {
  state.mode = mode === "explore" ? "explore" : "annotate";
  LS.set("austere:mode", state.mode);
  // Explore uses the page alone: the conversation panel (and, on narrow screens, its sheet and dock) steps aside.
  document.documentElement.classList.toggle("exploring", state.mode === "explore");
  // An archived page takes no notes: the frame is in Explore, and the switch says so.
  const shown: Mode = state.archived ? "explore" : state.mode;
  $(".subbar-hint").textContent = state.archived
    ? "The page is archived: it takes no notes"
    : shown === "explore"
      ? "Use the page normally: tabs, forms, links"
      : "Click any part of the page to comment on it";
  // The mode buttons only: the attach panel's On / Off / default is a .seg too.
  for (const b of document.querySelectorAll<HTMLButtonElement>(".seg button[data-mode]")) {
    b.classList.toggle("on", b.dataset.mode === shown);
    b.setAttribute("aria-pressed", String(b.dataset.mode === shown));
    b.disabled = state.archived && b.dataset.mode === "annotate";
    if (b.dataset.mode === "annotate")
      b.title = state.archived
        ? "The page is archived: it takes no notes"
        : "Click anything to comment on it (⌘/Ctrl+I)";
  }
  post({ type: "mode", mode: shown });
}
for (const b of document.querySelectorAll<HTMLButtonElement>(".seg button[data-mode]"))
  b.addEventListener("click", () => setMode(b.dataset.mode));
document.addEventListener("keydown", (e) => {
  if ((e.metaKey || e.ctrlKey) && (e.key === "i" || e.key === "I")) {
    e.preventDefault();
    setMode(state.mode === "annotate" ? "explore" : "annotate");
  }
});

function renderPresence() {
  const view = presenceView(S(), Date.now());
  const dot = document.querySelector(".tab-dot");
  if (dot) {
    dot.setAttribute("class", `tab-dot ${view.cls}`);
    dot.setAttribute("aria-label", view.label);
  }
  if (OWNER) {
    $('[data-cmd="archive"]').hidden = state.archived;
    $('[data-cmd="unarchive"]').hidden = !state.archived;
  }
  renderDock();
}
// "Agent working (2 min)" and "Took your notes 14 min ago" count up on their own.
setInterval(() => {
  if (state.presence === "working" || state.presence === "stale") renderPresence();
}, 30_000);

// ── menu ──

const menuPop = $(".menu-pop");

$(".menu-btn").addEventListener("click", (e) => {
  e.stopPropagation();
  menuPop.hidden = !menuPop.hidden;
  if (attachPop) closeAttach();
  if (!menuPop.hidden && OWNER) void loadAgentPrompt();
});
document.addEventListener("click", () => (menuPop.hidden = true));

menuPop.addEventListener("click", async (e) => {
  const cmd =
    e.target instanceof Element
      ? e.target.closest<HTMLElement>("[data-cmd]")?.dataset.cmd
      : undefined;
  // The share note stays open so its command can be selected.
  if (!cmd) return e.stopPropagation();
  if (cmd === "copy-path") await copyText(BOOT.file, "File path");
  // Hosted, the URL without its fragment: the invite token is already out of the address bar.
  if (cmd === "copy-link")
    await copyText(
      HOSTED ? location.origin + location.pathname : state.links?.remote || location.href,
      HOSTED ? "Page link" : "Review link",
    );
  if (cmd === "copy-agent-prompt") await copyAgentPrompt();
  if (cmd === "history") openHistory();
  if (cmd === "reload") loadFrame();
  if (cmd === "export" && HOSTED) {
    // The menu stays open on "Preparing download…" until the file is saved or the banner says why not.
    e.stopPropagation();
    await downloadStandalone();
    menuPop.hidden = true;
  }
  if (cmd === "share") await openShare();
  if (cmd === "archive") await archivePage();
  if (cmd === "unarchive") await unarchivePage();
});

// ── attach: the Agent pill (RLM-346; the owner's only, never on a reviewer's or a hosted page) ──

const MODES: { id: AttachModeId; label: string; hint: string }[] = [
  { id: "same", label: "Same session", hint: "Each run continues the session" },
  { id: "fork", label: "Fork", hint: "Each run branches from the session" },
  {
    id: "new",
    label: "New session",
    hint: "The first run starts a session; later runs continue it",
  },
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
const attach: {
  info: AttachInfo | null;
  run: RunSummary | null;
  message: string;
  log: string[] | null;
  busy: boolean;
  error: string;
  infoGen: number;
  infoShown: number;
  runGen: number;
} = {
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
  if (run.started_at)
    putRunMark(`${run.id}:start`, {
      id: run.id,
      at: run.started_at,
      text: `Agent run started${what ? ` · ${what}` : ""}`,
      tone: "start",
    });
  if (!run.ended_at || (!run.started_at && run.status !== "failed")) return;
  const took = run.started_at ? ` after ${clock(run.ended_at - run.started_at)}` : "";
  const why = message || RUN_REASONS[run.reason ?? ""] || run.reason || "";
  const end: Pick<RunMark, "text" | "tone"> =
    run.status === "done"
      ? { text: `Agent run finished${took}`, tone: "done" }
      : run.status === "failed"
        ? {
            text: `Agent run ${run.started_at ? "failed" : "did not start"}${why ? `: ${why}` : ""}`,
            tone: "failed",
          }
        : run.status === "stopped"
          ? { text: `Agent run stopped${took}`, tone: "stopped" }
          : { text: "Agent run interrupted: the server restarted", tone: "stopped" };
  putRunMark(`${run.id}:end`, { id: run.id, at: run.ended_at, ...end });
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
}

function renderAttach() {
  if (!attachPill) return;
  const info = attach.info;
  const on = info?.effective.state === "on";
  const detail =
    on && info
      ? [info.target.harness, info.effective.mode, info.effective.model].filter(Boolean).join(" · ")
      : "Off";
  $(".attach-detail").textContent = detail;
  $(".attach-short").textContent = on ? "On" : "Off";
  attachPill.classList.toggle("on", on);
  attachPill.title = on
    ? `Agent attached: ${detail}. A note you send starts it.`
    : "Attach an agent to this page";
  state.attachOn = on;
  renderPresence();
  renderRunState();
  if (attachPop && !attachPop.hidden) renderAttachPop();
}

/** Stop, View log and Retry for the run's state. */
function runButtons(run: RunSummary): HTMLElement[] {
  if (run.status === "running" || run.status === "queued" || run.status === "waiting_for_session") {
    return [
      h("button", {
        type: "button",
        class: "btn tiny ghost run-stop",
        text: "Stop",
        onclick: () => runAction("stop"),
      }),
    ];
  }
  if (run.status === "failed") {
    return [
      h("button", {
        type: "button",
        class: "btn tiny ghost run-log",
        text: "View log",
        onclick: () => openLog(),
      }),
      h("button", {
        type: "button",
        class: "btn tiny run-retry",
        text: "Retry",
        onclick: () => runAction("retry"),
      }),
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
      return [
        "Running ",
        h("span", {
          class: "run-elapsed",
          text: clock(Date.now() - (run.started_at ?? Date.now())),
        }),
      ];
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

const ACTIVE = new Set<RunSummary["status"]>([
  "queued",
  "waiting_for_session",
  "running",
  "failed",
]);

function renderRunState() {
  if (!runStateEl) return;
  const run = attach.run;
  runStateEl.textContent = "";
  const show = !!run && ACTIVE.has(run.status);
  runStateEl.hidden = !show;
  runStateEl.className = `run-state${run ? ` ${run.status}` : ""}`;
  attachPill?.setAttribute("data-run", show && run ? run.status : "");
  if (run && show) {
    runStateEl.title =
      run.status === "failed"
        ? attach.message || RUN_REASONS[run.reason ?? ""] || ""
        : run.status === "waiting_for_session"
          ? attach.message
          : "";
    runStateEl.append(h("span", { class: "run-label" }, ...runLabel(run)), ...runButtons(run));
  }
  clearInterval(elapsedTimer);
  if (run?.status === "running") {
    elapsedTimer = window.setInterval(() => {
      for (const el of document.querySelectorAll(".run-elapsed"))
        el.textContent = clock(Date.now() - (run.started_at ?? Date.now()));
    }, 1000);
  }
  renderAttachRun();
}

async function runAction(kind: "stop" | "retry") {
  const r = await fetch(`${BASE}/run/${kind}`, { method: "POST" }).catch(() => null);
  if (!r) return flash("Could not reach austere-axi. Check that it is still running.");
  if (!r.ok) {
    const d = (await r.json().catch(() => ({}))) as { error?: string };
    flash(
      d.error
        ? `${kind === "stop" ? "Stop" : "Retry"}: ${d.error}`
        : `${kind} failed (${r.status})`,
    );
  }
}

async function openLog() {
  const run = attach.run;
  if (!run || !attachPop) return;
  openAttach();
  let log: string[];
  try {
    const r = await fetch(`${BASE}/run/${run.id}/log`);
    log = r.ok
      ? ((await r.json()) as { tail: string[] }).tail
      : [`Could not read the log (${r.status}).`];
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
  if (!attachPop) return;
  menuPop.hidden = true;
  state.panel = "agent";
}

function closeAttach() {
  if (state.panel === "agent") state.panel = "notes";
}

/** The Agent popover follows the panel: shown while it is the view, with fresh settings. */
function showAttachPop(open: boolean) {
  if (!attachPop || !attachPill || attachPop.hidden === !open) return;
  attachPop.hidden = !open;
  attachPill.setAttribute("aria-expanded", String(open));
  if (open) {
    renderAttachPop();
    void loadAttach();
  } else {
    attach.log = null;
    attach.error = "";
  }
}

/** The panel's views: Notes, or the Agent and History panels that open over it. */
function renderTabs() {
  const current = state.panel;
  for (const t of document.querySelectorAll<HTMLElement>(".panel-tab")) {
    if (t.dataset.tab === current) t.setAttribute("aria-current", "true");
    else t.removeAttribute("aria-current");
  }
  // On a wide screen the Agent and History panels lie over the notes, the queue and the composer:
  // what is covered takes no focus. On a narrow one they are popovers, and the sheet under them stays in use.
  const covered = current !== "notes" && !isNarrow();
  for (const el of document.querySelectorAll<HTMLElement>(
    ".panel > .log, .panel > .queue, .panel > .composer",
  ))
    el.inert = covered;
}

$(".panel-tabs").addEventListener("click", (e) => {
  const tab =
    e.target instanceof Element
      ? e.target.closest<HTMLElement>("[data-tab]")?.dataset.tab
      : undefined;
  if (!tab) return;
  // The document's click closes the Agent panel and the ⋯ menu: a tab click is not an outside click for the first.
  e.stopPropagation();
  menuPop.hidden = true;
  if (tab === "agent") openAttach();
  else if (tab === "history") openHistory();
  else closePanel();
});
window.matchMedia("(max-width: 860px)").addEventListener("change", renderTabs);
useReview.subscribe((s, prev) => {
  if (s.panel === prev.panel) return;
  showAttachPop(s.panel === "agent");
  renderTabs();
});

/** Write the page's own row; from "Use project default", the page takes the fields it showed. */
async function saveAttach(change: AttachChange) {
  const info = attach.info;
  if (!info || attach.busy) return;
  const own = info.page && info.page.state !== "inherit" ? info.page.state : null;
  const e = info.effective;
  const body: AttachChange = own
    ? { state: own, ...change }
    : {
        state: "inherit",
        mode: e.mode,
        session: e.session,
        harness: e.harness,
        model: e.model,
        ...change,
      };
  attach.busy = true;
  attach.error = "";
  const gen = ++attach.infoGen;
  const runGen = attach.runGen;
  renderAttachPop();
  try {
    const r = await fetch(`${BASE}/attach`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
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
      h(
        "button",
        {
          type: "button",
          class: "icon-btn attach-close",
          "aria-label": "Close",
          onclick: closeAttach,
        },
        icon("close", { size: 16, width: 1.8 }),
      ),
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
    h("p", {
      class: "attach-note",
      text: "When on, a note you send or release starts the agent: it reads the notes, patches the page and replies.",
    }),
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
          disabled:
            attach.busy ||
            (!!info.auto &&
              pageState !== value &&
              (value === "on" || (value === "inherit" && projectText === "on"))),
          text: label,
          onclick: () => saveAttach({ state: value }),
        }),
      ),
    ),
    h("p", {
      class: "attach-note",
      text: own
        ? `Project default${info.project ? ` (${info.project.name})` : ""}: ${projectText}.`
        : `This page uses the project default: ${e.state}. Choose On or Off to give it its own setting.`,
    }),
  );
  if (info.auto && e.state !== "on")
    attachPop.append(
      h("div", {
        class: "attach-warn",
        text: `${info.auto}. Attach and --auto exclude each other: publish or share it without --auto to turn attach on.`,
      }),
    );

  const fieldsOff = !own || attach.busy;
  const sessionHarness =
    e.session === "author"
      ? info.author?.harness
      : info.sessions.find((s) => s.id === e.session)?.harness;
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
        h("input", {
          type: "radio",
          name: "attach-mode",
          value: m.id,
          checked: e.mode === m.id,
          disabled: fieldsOff || !!reason,
          onchange: () => saveAttach({ mode: m.id }),
        }),
        h("span", { text: m.label }),
      ),
    );
  }
  if (blocked.length) modes.append(h("div", { class: "attach-reason", text: blocked.join(" · ") }));
  if (e.mode !== "new")
    modes.append(
      h("div", {
        class: "attach-hint",
        text: `Resends the whole session each run${info.sessionFileSize ? ` · ${bytes(info.sessionFileSize)}` : ""}`,
      }),
    );

  const sessions = field("Session");
  const sessionRadio = (value: string, label: string, meta: string) =>
    h(
      "label",
      { class: "attach-radio attach-session" },
      h("input", {
        type: "radio",
        name: "attach-session",
        value,
        checked: e.session === value,
        disabled: fieldsOff,
        onchange: () => saveAttach({ session: value }),
      }),
      h("span", { text: label }),
      meta ? h("small", { text: meta }) : null,
    );
  sessions.append(
    sessionRadio(
      "author",
      "Author",
      info.author
        ? `${info.author.harness} ${info.author.short}`
        : "none registered: a new session",
    ),
  );
  for (const s of info.sessions)
    sessions.append(
      sessionRadio(
        s.id,
        `${s.harness} ${s.short}`,
        `${s.roles.join(", ")} · ${ago(s.lastSeen)} · ${s.liveness}`,
      ),
    );
  if (e.session !== "author" && !info.sessions.some((s) => s.id === e.session))
    sessions.append(
      sessionRadio(e.session, `session ${e.session}`, "not registered for this page"),
    );
  if (!info.sessions.length)
    sessions.append(
      h("div", {
        class: "attach-hint",
        text: "No agent session has opened, patched or polled this page yet.",
      }),
    );

  const harness = h("select", {
    class: "attach-select",
    "aria-label": "Harness",
    disabled: fieldsOff,
    onchange: (ev) => saveAttach({ harness: (ev.target as HTMLSelectElement).value }),
  });
  for (const [name, hi] of Object.entries(info.harnesses))
    harness.append(
      h("option", {
        value: name,
        selected: name === e.harness,
        text: hi.found ? name : `${name} (not found)`,
      }),
    );
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
  const datalist = models?.length
    ? h("datalist", { id: "attach-models" }, ...models.map((m) => h("option", { value: m })))
    : null;
  attachPop.append(
    modes,
    sessions,
    field("Harness (for a new session)", harness),
    field("Model", model, datalist),
  );

  const grant = info.harnesses[info.target.harness]?.grantCommand;
  if (grant) {
    attachPop.append(
      h(
        "div",
        { class: "attach-warn attach-grant" },
        h("span", {
          text: `${info.target.harness} has no write grant: its runs cannot patch this page and end with “no reply”. Grant it once, at a terminal:`,
        }),
        h(
          "span",
          { class: "attach-cmd" },
          h("code", { text: grant }),
          h("button", {
            type: "button",
            class: "btn tiny",
            text: "Copy",
            onclick: () => copyText(grant, "Command"),
          }),
        ),
      ),
    );
  }
  for (const w of info.warnings)
    if (!(grant && w.includes(grant)) && !(info.auto && w.startsWith(info.auto)))
      attachPop.append(h("div", { class: "attach-warn", text: w }));
  attachPop.append(h("div", { class: "attach-run-slot" }));
  if (attach.error)
    attachPop.append(h("div", { class: "attach-error", role: "alert", text: attach.error }));
  renderAttachRun();
}

/** The popover's run section: its state, the buttons, and the log once asked for. */
function renderAttachRun() {
  const slot = attachPop?.querySelector(".attach-run-slot");
  if (!slot) return;
  slot.textContent = "";
  const run = attach.run;
  if (!run) return;
  const why =
    run.status === "failed"
      ? attach.message || RUN_REASONS[run.reason ?? ""] || run.reason || ""
      : run.status === "waiting_for_session"
        ? attach.message
        : "";
  slot.append(
    h(
      "div",
      { class: `attach-run ${run.status}` },
      h(
        "div",
        { class: "attach-run-head" },
        h("span", { class: "run-label" }, ...runLabel(run)),
        ...runButtons(run),
      ),
      why ? h("div", { class: "attach-hint", text: why }) : null,
      attach.log
        ? h("pre", { class: "attach-log", text: attach.log.join("\n") || "(the log is empty)" })
        : null,
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

function renderDock() {
  const dock = $(".dock");
  const n = state.queue.length;
  const parts = [n ? `${n} note${n === 1 ? "" : "s"} ready` : "Notes"];
  const last = state.transcript[state.transcript.length - 1];
  if (last?.role === "agent" && last.at > (SS.get<number>(`austere:seen:${SID}`) || 0))
    parts.push("new reply");
  // On a phone the header hides the presence: the dock carries its label (none when an attached agent's pill says it).
  const p = presenceView(S(), Date.now());
  const label = p.attached ? null : h("span", { class: `dock-presence ${p.cls}`, text: p.label });
  dock.replaceChildren(
    h("span", { class: "dock-grip" }),
    h(
      "span",
      { class: "dock-text" },
      h("span", { class: "dock-title", text: parts.join(" · ") }),
      label,
    ),
    icon("chevronDown", { size: 16, width: 2, cls: "dock-caret" }),
  );
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
$(".panel-head").addEventListener("touchstart", (e) => (touchY = e.touches[0].clientY), {
  passive: true,
});
$(".panel-head").addEventListener(
  "touchend",
  (e) => {
    if (touchY != null && e.changedTouches[0].clientY - touchY > 60) setSheet(false);
    touchY = null;
  },
  { passive: true },
);
$(".dock").addEventListener("touchstart", (e) => (touchY = e.touches[0].clientY), {
  passive: true,
});
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
        showBanner(
          "Lost the austere-axi server. Run any austere-axi command to restart it; this page reconnects on its own.",
          [reload()],
        );
      }
    }, 4000);
  });
  if (OWNER) {
    // A published page's hosted viewers, relayed by the server (Q17), and the owner's own status and focus sent back.
    // The server keeps them for the page's socket; an unpublished page ignores them.
    const sendPresence = (frame: ClientPresence) => {
      fetch(`${BASE}/presence`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(frame),
      }).catch(() => {});
    };
    source.addEventListener("open", () => presence.connect(sendPresence));
    source.addEventListener("error", () => presence.disconnect());
    source.addEventListener("viewer", (e) => {
      const parsed = parseServerFrame(e.data);
      const f = parsed.ok ? parsed.value : null;
      if (f && (f.t === "hello" || f.t === "status" || f.t === "focus" || f.t === "bye"))
        presence.handle(f);
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
      renderRunState();
      // A run that ended may have registered a session (A18): the popover's list changes.
      if (ended) void loadAttach();
    });
  }
  source.addEventListener("snapshot", (e) => {
    const d: SnapshotEvent = JSON.parse(e.data);
    state.transcript = (d.transcript || []).filter((e) => !e.discarded);
    state.presence = d.presence;
    state.since = d.since == null ? null : d.since + (Date.now() - d.now);
    state.wake = d.wake ?? null;
    state.archived = !!d.session.archived;
    state.unread = d.session.unread || 0;
    state.more = !!d.more;
    state.links = d.links;
    if (d.version && d.version !== BOOT.version) {
      showBanner("austere-axi was updated. This page is running the previous version.", [reload()]);
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
    state.loaded = true;
    setMode(state.mode);
  });
  source.addEventListener("transcript", (e) => {
    mergeEntries((JSON.parse(e.data) as { entries?: Entry[] }).entries || []);
    renderDock();
  });
  source.addEventListener("presence", (e) => {
    const d: PresenceEvent = JSON.parse(e.data);
    state.presence = d.presence;
    state.since = d.since == null ? null : d.since + (Date.now() - d.now);
    state.wake = d.wake ?? null;
    state.archived = !!d.archived;
    state.unread = d.unread || 0;
    setMode(state.mode);
    renderPresence();
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
      loadFrame();
    } else {
      state.program = d.program;
      post({ type: "source", program: d.program });
    }
  });
  source.addEventListener("server", (e) => {
    const d: { state: string } = JSON.parse(e.data);
    if (d.state === "revoked") {
      source.close();
      state.connected = false;
      showBanner("The owner revoked this device's access to this page. Ask them for a new link.");
      return;
    }
    if (d.state === "stopped") {
      showBanner(
        "The austere-axi server stopped. Run any austere-axi command to start it again; this page reconnects on its own.",
      );
    }
  });
}

// ── hosted: asset token and the page socket (docs/hosted-share-links.md, "Sync, access and presence") ──

// The page row's publishedAt the shell was built for; a later one offers a reload.
let publishedAt = HOSTED?.publishedAt;
// Highest row seq applied, kept for the tab: a reconnect pulls after it.
let cursor = 0;
// The service let this browser in on the owner's sign-in cookie (`publish login`), not an invite.
let ownerView = false;

/** Nothing more can be sent: say why in the presence label and the banner, and stop syncing. */
function lock(label: string, message: string, actions: BannerAction[] = []) {
  set({ lockout: label, connected: false });
  getSync()?.stop();
  showBanner(message, actions);
  renderPresence();
}

/** Locks on an answer that means this reviewer cannot get in (403) or the page is gone (404, 410). */
function refused(status: number): boolean {
  if (status === 403) {
    // The service's account sign-in (same origin, a plain navigation); it brings the viewer back to this page.
    const signIn =
      typeof HOSTED?.signIn === "string" &&
      HOSTED.signIn.startsWith("/") &&
      !HOSTED.signIn.startsWith("//")
        ? HOSTED.signIn
        : null;
    const actions: BannerAction[] = signIn ? [{ label: "Sign in", href: signIn }] : [];
    const orSignIn = signIn ? " Or sign in with the account the owner shared it with." : "";
    if (ownerView)
      lock(
        "Signed out",
        `Your owner sign-in has expired. ${signIn ? "Sign in again, or run" : "Run"} \`austere-axi publish login <file>\` for a new link.`,
        actions,
      );
    else if (invite)
      lock(
        "Invite no longer valid",
        `This invite is no longer valid. Ask the page owner for a new link.${orSignIn}`,
        actions,
      );
    else
      lock(
        "Invite required",
        `This page is invite-only. Open it from the link the page owner sent you.${orSignIn}`,
        actions,
      );
  } else if (status === 404 || status === 410)
    lock("Page removed", "This page is no longer available.");
  else return false;
  return true;
}

/**
 * POST {base}/asset-token: trades the invite (none on an unlisted page) or the owner's sign-in
 * cookie for a 10-minute frame token, the page title and who the viewer is.
 */
async function requestAssetToken(signal?: AbortSignal): Promise<{
  status: number;
  token?: string;
  name?: string | null;
  title?: string;
  owner?: boolean;
}> {
  const r = await fetch(`${BASE}/asset-token`, {
    method: "POST",
    headers: invite ? { "X-Austere-Invite": invite } : {},
    signal,
  });
  if (!r.ok) return { status: r.status };
  const d = (await r.json().catch(() => null)) as {
    token?: unknown;
    name?: unknown;
    title?: unknown;
    owner?: unknown;
  } | null;
  const token =
    typeof d?.token === "string" && /^[A-Za-z0-9_-]+$/.test(d.token) ? d.token : undefined;
  return {
    status: r.status,
    token,
    name: typeof d?.name === "string" && d.name ? d.name.slice(0, NAME_MAX) : null,
    title: typeof d?.title === "string" && d.title ? d.title : undefined,
    owner: d?.owner === true,
  };
}

/** Loads the frame from `${artifactUrl}<assetToken>/` and learns who the reviewer is. */
async function loadHostedFrame(): Promise<boolean> {
  const answer = await requestAssetToken().catch(() => null);
  if (answer && refused(answer.status)) return false;
  if (!answer?.token) {
    showBanner(`Could not load this page${answer ? ` (HTTP ${answer.status})` : ""}.`, [
      { label: "Retry", onClick: () => void startHosted() },
    ]);
    return false;
  }
  if (typeof answer.title === "string" && answer.title.trim()) showTitle(answer.title.trim());
  ownerView = !!answer.owner;
  const inviteName = answer.name ?? null;
  if (inviteName) set({ inviteName, viewerName: inviteName });
  else {
    // An unlisted page answered without a name: the stored invite is not valid here, so stop sending it.
    if (invite) {
      invite = null;
      LS.remove(INVITE_KEY);
    }
    set({
      inviteName,
      viewerName: String(LS.get("austere:name", "") || "").slice(0, NAME_MAX),
    });
  }
  // The notes waiting for an ack are the ones of the reviewer this page now is.
  refreshPending();
  renderViewer();
  frame.src = `${BOOT.artifactUrl ?? `${BASE}/a/`}${answer.token}/`;
  return true;
}

/** Base64 of `bytes`, in chunks (spreading a whole runtime into fromCharCode overflows the stack). */
function base64(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000)
    bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

async function gzipBase64(code: string): Promise<string> {
  const stream = new Blob([code]).stream().pipeThrough(new CompressionStream("gzip"));
  return base64(new Uint8Array(await new Response(stream).arrayBuffer()));
}

// The published page's script tags: the pinned runtime and bundled packs (/rt/), and installed packs
// (/pk/). The service refuses any other `src`, so these are all the page runs.
const HOSTED_SCRIPT_RE =
  /<script\b[^>]*\bsrc\s*=\s*["'](\/(?:rt|pk)\/[^"']+)["'][^>]*>\s*<\/script\s*>/gi;

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
    const out = html.replace(HOSTED_SCRIPT_RE, () =>
      i++ ? "" : [...packed, LOADER_TAG].join("\n"),
    );
    url = URL.createObjectURL(new Blob([out], { type: "text/html" }));
    const slug =
      pageTitle
        .replace(/[^\p{L}\p{N}]+/gu, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 80) || "page";
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
    else if (row.type === "note")
      entries.push({
        id: `note:${row.id}`,
        role: "user",
        author: row.author.slice(0, NAME_MAX),
        items: row.items,
        at: row.at,
        discarded: row.state === "discarded",
      });
    else if (row.type === "reply")
      entries.push({ id: `reply:${row.id}`, role: "agent", text: row.text, at: row.at });
  }
  mergeEntries(entries);
  cursor = changes.cursor;
  state.loaded = true;
  renderDock();
}

function applyPage(row: PageRow) {
  // The server closes the socket (1000) after a deleted page's row.
  if (row.deleted) return lock("Page removed", "The owner removed this page.");
  publishedAt ??= row.publishedAt;
  if (row.publishedAt !== publishedAt) {
    showBanner("New version, reload", [reload()]);
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

function onSyncFrame(frame: ReceivedFrame) {
  if (frame.t === "changes") applyChanges(frame);
  else if (frame.t === "ack") settle(frame);
  // `forbidden` and `upgrade_required` come before the server closes the socket: onSyncClose says why.
  else if (frame.t === "error" && frame.code !== "forbidden" && frame.code !== "upgrade_required")
    set({ composerError: frame.message });
}

function onSyncClose(close: SyncClose, retrying: boolean) {
  state.connected = false;
  if (!retrying && !state.lockout) {
    if (close.error?.code === "upgrade_required") {
      lock("Update needed", "This page needs a newer review page. Reload to get it.", [reload()]);
    } else if (close.code === 1000 && !close.error)
      lock("Page removed", "This page is no longer available.");
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
  if (!(await loadHostedFrame()) || getSync()) return;
  const socket = openSyncSocket({
    url: `${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}${BASE}/sync`,
    protocols: () => syncProtocols(invite ? { invite } : {}),
    // A refused handshake shows no status to the page: ask the asset-token route why.
    mayRetry: async (close) => {
      if (state.lockout) return false;
      if (close.opened) return true;
      // A stalled check must not hold up the next attempt: past 5 s it counts as offline, and the socket retries.
      const answer = await requestAssetToken(AbortSignal.timeout(RETRY_CHECK_MS)).catch(() => null);
      return !(answer && refused(answer.status));
    },
  });
  setSync(socket);
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

// The owner's way between pages and the hub (RLM-358): never for a reviewer or a hosted page.
const nav =
  OWNER && !HOSTED
    ? installNav({
        id: SID,
        bar: $(".bar-title"),
        menu: menuPop,
        flash,
        highlight: (ids) => post({ type: "highlight", ids, scroll: true }),
        openAttach,
      })
    : null;
if (nav) {
  // After this click has reached the document, as the menu's Go to page does.
  $(".goto-btn").addEventListener("click", () => setTimeout(() => nav.toggleSwitcher(), 0));
}
// What is still drawn by hand follows the store: the Conversation, the dock and the Notes tab's count.
useReview.subscribe((s, prev) => {
  if (s.queue === prev.queue) return;
  $(".tab-count").textContent = s.queue.length ? String(s.queue.length) : "";
  renderDock();
});
if (state.queue.length) $(".tab-count").textContent = String(state.queue.length);
setMode(state.mode);
if (isNarrow() && state.sheetOpen) setSheet(true);
refreshPending();
renderPresence();
renderDock();
if (HOSTED) startHosted();
else {
  loadFrame();
  connect();
}
