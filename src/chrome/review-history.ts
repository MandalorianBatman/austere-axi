// The owner's history: what changed since they last looked, every version, a part's earlier texts, restore.
// The newest answer wins without counters: each load belongs to an effect, and the effect's cleanup aborts it.
import { useEffect, useRef, useState } from "react";
import { BASE, UNREACHABLE, failure } from "./review-env.ts";
import { flash, showBanner } from "./review-banner.ts";
import { post } from "./review-bridge.ts";
import { S, set, useReview } from "./review-store.ts";
import type { HistoryData } from "./review-types.ts";

const inView = (): boolean => document.visibilityState === "visible";

/** The frame's annotate popover offers History (n) on a statement with earlier versions. */
export function sendHistoryCounts(): void {
  const hist = S().hist;
  if (!hist) return;
  const counts: Record<string, number> = {};
  for (const r of hist.revisions)
    for (const name of new Set([...r.changed, ...r.removed]))
      counts[name] = (counts[name] || 0) + 1;
  post({ type: "history-counts", counts });
}

/** "2 revisions since you last looked": every revision after `baseline`, and the statements they changed. */
function applySince(hist: HistoryData, baseline: number): void {
  const newer = hist.revisions.filter((r) => r.rev > baseline);
  set({
    sinceChanges: [...new Set(newer.flatMap((r) => r.changed))].slice(0, 100),
    sinceCount: newer.length,
    sinceDismissed: false,
  });
}

/** The owner has the page in view: the server remembers the newest revision they could have seen. */
async function markViewed(hist: HistoryData): Promise<void> {
  if (!inView() || hist.viewed >= hist.head) return;
  const head = hist.head;
  const r = await fetch(`${BASE}/viewed`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ rev: head }),
  }).catch(() => null);
  const now = S().hist;
  if (r?.ok && now) set({ hist: { ...now, viewed: Math.max(now.viewed, head) } });
}

/** Ask for a fresh history (the panel was opened, a restore changed the page). */
export function reloadHistory(): void {
  set({ historyTick: S().historyTick + 1 });
}

/**
 * Keeps `hist` current for the local owner: when the page opens and when its tab comes back (compare with what the
 * owner saw last, then record that they have seen the newest), and when the page changes under an open tab (a tab in
 * view has seen that change).
 */
export function useHistoryFeed(): void {
  const revision = useReview((s) => s.revision);
  const tick = useReview((s) => s.historyTick);
  const [entered, setEntered] = useState(0);
  const handled = useRef(-1);
  useEffect(() => {
    const back = (): void => {
      if (inView()) setEntered((n) => n + 1);
    };
    document.addEventListener("visibilitychange", back);
    return () => document.removeEventListener("visibilitychange", back);
  }, []);
  useEffect(() => {
    // The first snapshot brings the revision: until then there is nothing to compare.
    if (revision === 0) return;
    const ctl = new AbortController();
    void (async () => {
      let data: HistoryData;
      try {
        const r = await fetch(`${BASE}/history`, { signal: ctl.signal });
        if (!r.ok) throw new Error(String(r.status));
        data = (await r.json()) as HistoryData;
      } catch {
        if (!ctl.signal.aborted) set({ histError: true });
        return;
      }
      if (ctl.signal.aborted) return;
      set({ hist: data, histError: false });
      // The first look at a page has nothing to compare with: every revision so far is what the owner sees now.
      if (handled.current !== entered) {
        handled.current = entered;
        applySince(data, data.viewed || data.head);
      }
      void markViewed(data);
    })();
    return () => ctl.abort();
  }, [revision, tick, entered]);
  const hist = useReview((s) => s.hist);
  // The frame learns which statements have earlier versions; a frame that reloads asks again when it is ready.
  useEffect(() => {
    sendHistoryCounts();
  }, [hist]);
}

/** The History panel, over the notes: every revision, or one statement's earlier texts. */
export function openHistory(statement: string | null = null): void {
  if (S().panel !== "history")
    opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  set({ panel: "history", historyFor: statement });
  reloadHistory();
}

/** What had focus when History opened (the History tab or button): focus goes back to it when History closes. */
let opener: HTMLElement | null = null;

export const closePanel = (): void => set({ panel: "notes" });

/** Closes History from inside it (Esc, Close, a restore): focus returns to what opened it, if that is still there. */
export function closeHistory(): void {
  closePanel();
  if (opener?.isConnected) opener.focus();
  opener = null;
}

/** Puts one statement back as it was in an earlier revision. */
export async function restoreStatement(name: string, rev: number): Promise<void> {
  const r = await fetch(`${BASE}/restore`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ rev, statements: [name] }),
  }).catch(() => null);
  if (!r) return showBanner(UNREACHABLE);
  if (!r.ok) return showBanner(`Could not restore ${name}: ${await failure(r)}`);
  const done = (await r.json().catch(() => ({}))) as { unchanged?: boolean };
  closeHistory();
  flash(
    done.unchanged
      ? `${name} already reads as it did in revision ${rev}.`
      : `${name} is back as it was in revision ${rev}.`,
  );
  reloadHistory();
}
