// The local server's event stream (the owner and a local reviewer; a hosted reviewer syncs over the page's socket instead,
// review-hosted.ts). Each event lands in the store.
import { parseServerFrame } from "../shared/sync.ts";
import type { ClientPresence } from "../shared/sync.ts";
import { BASE, BOOT, OWNER } from "./review-env.ts";
import { loadRunMarks, onRunEvent, reloadAttach } from "./review-attach.ts";
import { reload, showBanner } from "./review-banner.ts";
import { post } from "./review-bridge.ts";
import { loadFrame, reportRenderErrors } from "./review-frame.ts";
import { getRoster } from "./review-presence.ts";
import { S, set } from "./review-store.ts";
import { mergeEntries } from "./review-transcript.ts";
import type {
  ChangedEvent,
  Entry,
  PresenceEvent,
  RunEvent,
  SnapshotEvent,
} from "./review-types.ts";

let disconnectedAt = 0;

/** The agent's state as the server reports it, the same in a snapshot and in a `presence` event. */
function agentState(d: {
  presence: string;
  since?: number;
  now: number;
  wake?: SnapshotEvent["wake"];
}): void {
  set({
    presence: d.presence,
    since: d.since == null ? null : d.since + (Date.now() - d.now),
    wake: d.wake ?? null,
  });
}

export function connect(): void {
  const source = new EventSource(`${BASE}/events`);
  source.addEventListener("open", () => {
    set({ connected: true });
    disconnectedAt = 0;
    showBanner("");
  });
  source.addEventListener("error", () => {
    set({ connected: false });
    if (!disconnectedAt) disconnectedAt = Date.now();
    setTimeout(() => {
      if (!S().connected && Date.now() - disconnectedAt > 3500) {
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
    const sendPresence = (frame: ClientPresence): void => {
      fetch(`${BASE}/presence`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(frame),
      }).catch(() => {});
    };
    source.addEventListener("open", () => getRoster()?.connect(sendPresence));
    source.addEventListener("error", () => getRoster()?.disconnect());
    source.addEventListener("viewer", (e) => {
      const parsed = parseServerFrame(e.data);
      const f = parsed.ok ? parsed.value : null;
      if (f && (f.t === "hello" || f.t === "status" || f.t === "focus" || f.t === "bye"))
        getRoster()?.handle(f);
    });
    // The Agent pill: the setting and the runs, again on each (re)connect; then each run's changes as they happen.
    source.addEventListener("snapshot", () => {
      reloadAttach();
      void loadRunMarks();
    });
    source.addEventListener("attach", reloadAttach);
    source.addEventListener("run", (e) => onRunEvent(JSON.parse(e.data) as RunEvent));
  }
  source.addEventListener("snapshot", (e) => {
    const d: SnapshotEvent = JSON.parse(e.data);
    const s = S();
    set({
      transcript: (d.transcript || []).filter((x) => !x.discarded),
      archived: !!d.session.archived,
      unread: d.session.unread || 0,
      more: !!d.more,
      links: d.links,
      packs: d.thirdPartyPacks ?? [],
      thirdParty: !!d.thirdPartyPacks?.length,
      loaded: true,
    });
    agentState(d);
    if (d.version && d.version !== BOOT.version) {
      showBanner("austere-axi was updated. This page is running the previous version.", [reload()]);
    }
    // First snapshot: errors the frame reported before it belong to this revision.
    // A reconnect on the same revision resends what may have been lost (the server drops repeats).
    // On a newer revision the held errors describe an old program: the new render reports its own.
    // The same program on a newer revision (only the page shell changed) renders the same errors.
    if (s.program === null || d.revision === s.revision || d.program === s.program) {
      set({
        revision: d.revision,
        ...(d.revision !== s.revision ? { errorsRevision: d.revision } : {}),
      });
      reportRenderErrors();
    } else set({ revision: d.revision, parserErrors: [], runtimeErrors: [], renderReport: null });
    if (s.program === null) set({ program: d.program });
    else if (d.program !== s.program) {
      set({ program: d.program });
      if (s.frameReady) post({ type: "source", program: d.program });
    }
  });
  source.addEventListener("transcript", (e) => {
    mergeEntries((JSON.parse(e.data) as { entries?: Entry[] }).entries || []);
  });
  source.addEventListener("presence", (e) => {
    const d: PresenceEvent = JSON.parse(e.data);
    agentState(d);
    set({ archived: !!d.archived, unread: d.unread || 0 });
  });
  source.addEventListener("changed", (e) => {
    const d: ChangedEvent = JSON.parse(e.data);
    set({
      revision: d.revision,
      renderReport: null,
      parserErrors: [],
      runtimeErrors: [],
      packs: d.thirdPartyPacks ?? [],
      thirdParty: !!d.thirdPartyPacks?.length,
      program: d.program,
    });
    if (d.shellChanged || !S().frameReady) {
      // A full reload reports no changes: drop the previous turn's.
      set({ changes: [] });
      loadFrame();
    } else post({ type: "source", program: d.program });
  });
  source.addEventListener("server", (e) => {
    const d: { state: string } = JSON.parse(e.data);
    if (d.state === "revoked") {
      source.close();
      set({ connected: false });
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
