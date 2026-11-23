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
import { installNav } from "./nav.ts";
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
import { openAttach, loadRunMarks, onRunEvent, reloadAttach } from "./review-attach.ts";
import { openHistory, sendHistoryCounts } from "./review-history.ts";
import { archivePage, openShare, unarchivePage } from "./review-page.ts";
import { mergeEntries } from "./review-transcript.ts";
import { getSync, mine, refreshPending, sendWhenDue, setSync, settle } from "./review-outbox.ts";
import { setRoster } from "./review-presence.ts";

import { S, set } from "./review-store.ts";
import type { ReviewState } from "./review-store.ts";
import type {
  ChangedEvent,
  Entry,
  FrameMessage,
  Mode,
  PresenceEvent,
  RunEvent,
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
      set({ dockPulse: S().dockPulse + 1 });
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

// ── menu ──

const menuPop = $(".menu-pop");

$(".menu-btn").addEventListener("click", (e) => {
  e.stopPropagation();
  menuPop.hidden = !menuPop.hidden;
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
  });
  source.addEventListener("error", () => {
    state.connected = false;
    if (!disconnectedAt) disconnectedAt = Date.now();
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
      reloadAttach();
      void loadRunMarks();
    });
    source.addEventListener("attach", reloadAttach);
    source.addEventListener("run", (e) => onRunEvent(JSON.parse(e.data) as RunEvent));
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
    state.loaded = true;
    setMode(state.mode);
  });
  source.addEventListener("transcript", (e) => {
    mergeEntries((JSON.parse(e.data) as { entries?: Entry[] }).entries || []);
  });
  source.addEventListener("presence", (e) => {
    const d: PresenceEvent = JSON.parse(e.data);
    state.presence = d.presence;
    state.since = d.since == null ? null : d.since + (Date.now() - d.now);
    state.wake = d.wake ?? null;
    state.archived = !!d.archived;
    state.unread = d.unread || 0;
    setMode(state.mode);
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
setMode(state.mode);
refreshPending();
if (HOSTED) startHosted();
else {
  loadFrame();
  connect();
}
