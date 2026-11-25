// Send: the queue and the note in the box go to the agent (local) or into the outbox (hosted).
import { BASE, OWNER, HOSTED } from "./review-env.ts";
import { sendHosted } from "./review-outbox.ts";
import { S, set, setQueue } from "./review-store.ts";
import type { Entry, QueueItem } from "./review-types.ts";

/** The note box, so a Send with nothing to send can put the cursor in it. */
export const composerInput: { current: HTMLTextAreaElement | null } = { current: null };

/** `end`: Send & finish, or Done on its own, which tells the agent there are no more notes (an empty final batch). */
export async function sendAll(end = false): Promise<void> {
  const s = S();
  if (s.sending || s.archived) return;
  const text = s.draft.trim();
  const sentQids = new Set(s.queue.map((q) => q.qid));
  const items: QueueItem[] = s.queue.map(({ qid, ...rest }) => rest);
  if (text) items.push({ kind: "message", text });
  if (end && !OWNER) return;
  if (!items.length && !end) return void composerInput.current?.focus();
  if (HOSTED) return sendHosted(items);
  set({ sending: true, composerError: "", composerRetry: false });
  try {
    const r = await fetch(`${BASE}/send`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ items, end }),
    });
    const data: { error?: string; entry?: Entry } = await r.json().catch(() => ({}));
    if (!r.ok)
      throw new Error(data.error || `The agent service answered ${r.status}`, { cause: "http" });
    setQueue(S().queue.filter((q) => !sentQids.has(q.qid)));
    set({ draft: "" });
    const entry = data.entry;
    if (entry && !S().transcript.some((e) => e.id === entry.id))
      set({ transcript: [...S().transcript, entry] });
  } catch (err) {
    set({
      composerError:
        err instanceof Error && err.cause === "http"
          ? `Not sent: ${err.message}. Your notes are kept.`
          : "Couldn't reach the agent. Your notes are kept.",
      composerRetry: true,
    });
  } finally {
    set({ sending: false });
  }
}

/** Release or discard held notes (the owner's, from a teammate); an unreachable server shows in the composer. */
export async function heldAction(kind: "release" | "discard", ids?: string[]): Promise<void> {
  try {
    await fetch(`${BASE}/${kind}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(ids ? { ids } : { all: true }),
    });
  } catch {
    set({ composerError: "Could not reach the server. Try again." });
  }
}
