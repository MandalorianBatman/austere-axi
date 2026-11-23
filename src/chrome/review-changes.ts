// "N changed": what the page outlines as changed. The control outlines the last turn's changes and, for the owner,
// everything since they last looked; while it is on, new changes join the outline until it is switched off.
import { useEffect } from "react";
import { post } from "./review-bridge.ts";
import { S, set, useReview } from "./review-store.ts";
import type { ReviewState } from "./review-store.ts";

export const shownChanges = (s: Pick<ReviewState, "changes" | "sinceChanges">): string[] =>
  [...new Set([...s.changes, ...s.sinceChanges])].slice(0, 100);

/** Tells the frame what to outline: the changes while the control is on, nothing when it is off. */
export function postHighlight(scroll: boolean): void {
  const s = S();
  post({ type: "highlight", ids: s.highlight ? shownChanges(s) : [], scroll });
}

/** The control, or the "Outline them" button of the strip above the page. */
export function toggleHighlight(): void {
  set({ highlight: !S().highlight });
  postHighlight(S().highlight);
}

/** While the outline is on, a new turn's changes (or the owner's, once known) are added to it without scrolling. */
export function useHighlightSync(): void {
  const changes = useReview((s) => s.changes);
  const sinceChanges = useReview((s) => s.sinceChanges);
  useEffect(() => {
    if (S().highlight) postHighlight(false);
  }, [changes, sinceChanges]);
}
