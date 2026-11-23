// The artifact frame: loading it, and what comes back over the bridge. The page inside is untrusted, so each message
// is checked where it is read (strings only, the owner's own messages only for the owner).
import { useEffect } from "react";
import { BASE, BOOT, HOSTED, OWNER, SID, SS, str } from "./review-env.ts";
import { post, getFrame } from "./review-bridge.ts";
import { postHighlight } from "./review-changes.ts";
import { openHistory, sendHistoryCounts } from "./review-history.ts";
import { loadHostedFrame } from "./review-hosted.ts";
import { addToQueue } from "./review-notes.ts";
import { getRoster } from "./review-presence.ts";
import { S, set, setMode } from "./review-store.ts";
import type { FrameMessage } from "./review-types.ts";

/** What the owner's header navigation (nav.ts) offers the frame: the quick switcher, and outlining a search hit. */
export interface FrameNav {
  frameReady(): void;
  toggleSwitcher(): void;
}
let nav: FrameNav | null = null;
export const setNav = (n: FrameNav | null): void => {
  nav = n;
};

export function loadFrame(): void {
  set({ frameReady: false });
  // Hosted: the frame's URL carries a short-lived asset token, traded again on every load.
  if (HOSTED) void loadHostedFrame();
  else {
    const frame = getFrame();
    if (frame) frame.src = `${BOOT.artifactUrl ?? `${BASE}/a/`}?r=${Date.now()}`;
  }
}

// The owner's page sends render failures to the agent on its own, so the agent never has to look
// at the page to learn it is broken. Each report carries the revision its errors came from; the
// server drops repeats and reports for an older revision. If the post fails, "Queue fix" stays.
let renderReportTimer: ReturnType<typeof setTimeout> | undefined;
export function reportRenderErrors(): void {
  // Third-party pack code runs in the frame and could forge errors: the owner queues those by hand.
  if (!OWNER || S().archived || S().thirdParty) return;
  clearTimeout(renderReportTimer);
  renderReportTimer = setTimeout(async () => {
    const s = S();
    const errors = [...s.parserErrors, ...s.runtimeErrors].map((e) => ({
      statement: str(e.statementId),
      message: str(e.message),
    }));
    if (!errors.length) return;
    const reply = await fetch(`${BASE}/render-errors`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ revision: s.errorsRevision, errors }),
    }).then(
      async (r) => (r.ok ? ((await r.json()) as { stale?: boolean }) : null),
      () => null,
    );
    // A stale report (an older revision) reached no one; the new render reports its own errors.
    set({ renderReport: reply && !reply.stale ? "sent" : reply ? null : "failed" });
  }, 500);
}

// Popups from the frame keep its sandbox, so external links are opened here
// instead. Never this origin: artifact code must not get a window on it.
function openExternal(url: unknown): void {
  let u: URL;
  try {
    u = new URL(String(url));
  } catch {
    return;
  }
  if (!/^(https?|mailto):$/.test(u.protocol) || u.origin === location.origin) return;
  window.open(u.href, "_blank", "noopener");
}

function onMessage(e: MessageEvent): void {
  if (e.source !== getFrame()?.contentWindow) return;
  const d = e.data as FrameMessage | null | undefined;
  if (!d || d.austere !== 1) return;
  const s = S();
  switch (d.type) {
    case "hello":
      post({
        type: "init",
        mode: s.archived ? "explore" : s.mode,
        state: SS.get(`austere:form:${SID}`),
        scrollY: s.scrollY,
        // The owner's quick switcher: the frame hands Ctrl/Cmd+K over instead of letting the browser take it.
        quickSwitch: OWNER && !HOSTED,
      });
      break;
    case "ready":
      set({ frameReady: true });
      if (typeof d.title === "string" && d.title.trim()) set({ title: d.title.trim() });
      // A reloaded frame starts unmarked; it handles "highlight" from the start.
      if (s.highlight) postHighlight(false);
      sendHistoryCounts();
      getRoster()?.redraw();
      // The old frame's note box is gone, whether or not its blur arrived.
      getRoster()?.setWriting("note", false);
      // A search hit opened the page at one of its parts: outline it once the frame has rendered.
      nav?.frameReady();
      break;
    case "annotate":
      addToQueue(d.item);
      break;
    case "focus":
      // The statement this viewer clicked is its focus for the others.
      if (typeof d.id === "string") getRoster()?.setFocus(d.id);
      break;
    case "writing":
      getRoster()?.setWriting("note", d.on === true);
      break;
    case "action":
      addToQueue(d.item);
      set({ dockPulse: s.dockPulse + 1 });
      break;
    case "errors":
      set({
        parserErrors: (d.errors || []).filter((x) => x.severity !== "warning"),
        errorsRevision: s.revision,
      });
      reportRenderErrors();
      break;
    case "runtime-error": {
      const error = d.error;
      if (
        error &&
        !s.runtimeErrors.some(
          (x) => x.statementId === error.statementId && x.message === error.message,
        )
      ) {
        set({ runtimeErrors: [...s.runtimeErrors, error], errorsRevision: s.revision });
        reportRenderErrors();
      }
      break;
    }
    case "state":
      SS.set(`austere:form:${SID}`, d.state);
      break;
    case "scroll":
      set({ scrollY: d.y || 0 });
      break;
    case "changes":
      // Frame code is untrusted: keep string ids only.
      set({
        changes: Array.isArray(d.ids)
          ? d.ids.filter((id): id is string => typeof id === "string").slice(0, 50)
          : [],
      });
      break;
    case "toggle-mode":
      setMode(s.mode === "annotate" ? "explore" : "annotate");
      break;
    case "quick-switch":
      // Ctrl/Cmd+K pressed inside the frame (sent only when init said the owner has a switcher).
      nav?.toggleSwitcher();
      break;
    case "history":
      // The popover's History (n) on a statement: the owner's only, and only a statement name is taken from the frame.
      if (OWNER && !HOSTED && typeof d.id === "string") openHistory(d.id.slice(0, 200));
      break;
    case "open-url":
      openExternal(d.url);
      break;
  }
}

/** The frame's messages, for as long as the page is open. */
export function useFrameMessages(): void {
  useEffect(() => {
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, []);
}
