// The conversation's entries: merged in from the server's events (or, hosted, the socket's rows), and older ones on request.
import { BASE } from "./review-env.ts";
import { S, set } from "./review-store.ts";
import type { Entry, RunMark } from "./review-types.ts";

/** Entries by id: a new one joins, a changed one replaces its old self, a discarded one goes; oldest first. */
export function mergeEntries(entries: Entry[]): void {
  const next = [...S().transcript];
  for (const e of entries) {
    const i = next.findIndex((x) => x.id === e.id);
    if (e.discarded) {
      if (i >= 0) next.splice(i, 1);
    } else if (i >= 0) next[i] = e;
    else next.push(e);
  }
  set({ transcript: next.sort((a, b) => a.at - b.at) });
}

/** The page starts with the latest entries; older ones load on request. */
export async function loadEarlier(): Promise<void> {
  const first = S().transcript[0];
  if (!first) return;
  try {
    const r = await fetch(`${BASE}/transcript?before=${encodeURIComponent(first.id)}`);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const d: { entries?: Entry[]; more?: boolean } = await r.json();
    const known = new Set(S().transcript.map((e) => e.id));
    set({
      transcript: [
        ...(d.entries || []).filter((e) => !e.discarded && !known.has(e.id)),
        ...S().transcript,
      ],
      more: !!d.more,
    });
  } catch (err) {
    set({
      composerError: `Could not load earlier messages: ${(err as Error).message}`,
      composerRetry: false,
    });
  }
}

/** An agent run's start or end, as an entry among the Conversation's (the owner's). */
export function putRunMark(key: string, mark: RunMark): void {
  set({ runMarks: { ...S().runMarks, [key]: mark } });
}
