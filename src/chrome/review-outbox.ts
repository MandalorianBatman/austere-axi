// Hosted: notes go out as `addNote` mutations over the page's socket. A note stays in the outbox (sessionStorage)
// until its ack and is re-sent after a reconnect or a reload, under its own key.
import { LIMITS, mutation } from "../shared/sync.ts";
import type { AckFrame, AddNoteArgs, NoteAnnotation, NoteItem } from "../shared/sync.ts";
import type { SyncSocket } from "./sync-socket.ts";
import { HOSTED, SID, SS, str } from "./review-env.ts";
import { addToQueue, flatForm } from "./review-notes.ts";
import { S, set, setQueue } from "./review-store.ts";
import type { OutboxEntry, QueueItem } from "./review-types.ts";

// New notes are numbered under a clientId made for this page load and kept only in memory, with a
// counter from 1. Nothing about it is read back from storage, so a duplicated tab (which copies
// sessionStorage) or a failed write can never number two different notes with the same (clientId, n).
let CLIENT = "";
if (HOSTED) {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  CLIENT = btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
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
let clientN = 0;
// The outbox could not be saved: a reload before the acks would lose those notes, so the composer says so.
let outboxUnsaved = false;
// A note is waiting out a `rate_limited` answer: the composer says when it goes again.
let rateLimit: number | null = null;
/** The one pending timed re-send per waiting note. */
const retryTimers = new Map<OutboxEntry, number>();
let sync: SyncSocket | null = null;

export const getSync = (): SyncSocket | null => sync;
export const setSync = (socket: SyncSocket | null): void => {
  sync = socket;
};

/**
 * The reviewer this page sends as: the invite's name (the service names the note by it), or the
 * open link (the note carries its own self-declared name). Known once the asset token is traded.
 */
function sender(): string {
  const name = S().inviteName;
  return name ? `invite:${name}` : "open";
}
/** The outbox notes of the reviewer this page is now: another reviewer's notes are never sent under this one's socket. */
export function mine(): OutboxEntry[] {
  const as = sender();
  return outbox.filter((o) => o.as === as);
}

/** The composer's outbox notices: a rate-limit wait (a Badge with a countdown) and the unsaved-copy warning, each while it holds. */
function showOutboxNotice(): void {
  set({ rateLimit, outboxUnsaved });
}

/**
 * Sends an outbox note now, or, while it waits out `retryAfter`, once its deadline passes. One
 * timer per note: a reconnect or a second refusal never schedules an earlier or a second send.
 */
export function sendWhenDue(entry: OutboxEntry): void {
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

/**
 * The service takes messages and annotations only (NoteItem): a button press goes as a message,
 * a render issue as an annotation on its statement. Fields the frame gave as anything but strings are dropped.
 */
function toNoteItem(item: QueueItem): NoteItem {
  if (item.kind === "message") return { kind: "message", text: str(item.text) };
  if (item.kind === "action")
    return {
      kind: "message",
      text: [str(item.message), item.form ? flatForm(item.form).join(" · ") : ""]
        .filter(Boolean)
        .join(" · "),
    };
  const out: NoteAnnotation = { kind: "annotation" };
  const target = item.kind === "render-error" ? item.statement : item.target;
  if (typeof target === "string" && target) out.target = target;
  for (const k of ["component", "selection", "excerpt", "note"] as const) {
    const v = item[k];
    if (typeof v === "string" && v) out[k] = v;
  }
  if (item.kind === "render-error" && typeof item.message === "string") out.excerpt = item.message;
  if (Array.isArray(item.path))
    out.path = item.path.filter((p): p is string => typeof p === "string");
  const d = item.detail;
  if (d && typeof d === "object") {
    const detail: NonNullable<NoteAnnotation["detail"]> = {};
    for (const k of ["part", "row", "column"] as const)
      if (typeof d[k] === "string") detail[k] = d[k];
    if (Number.isInteger(d.rowIndex)) detail.rowIndex = d.rowIndex as number;
    if (Object.keys(detail).length) out.detail = detail;
  }
  return out;
}

/** Hosted: queues the batch as one `addNote` and sends it if the socket is open; the ack settles it. */
export function sendHosted(queued: QueueItem[]): void {
  const { lockout, inviteName, viewerName } = S();
  if (lockout || inviteName === undefined) return;
  // Only an unlisted page without an invite takes a self-declared name; an invite names its reviewer.
  if (inviteName === null && !viewerName) return void set({ askName: true });
  const items = queued.map(toNoteItem);
  const bytes = new TextEncoder().encode(JSON.stringify(items)).length;
  if (bytes > LIMITS.noteItemsBytes) {
    set({
      composerError: `Too long to send: ${bytes} bytes, the limit is ${LIMITS.noteItemsBytes}. Shorten or remove a note.`,
    });
    return;
  }
  const args: AddNoteArgs = inviteName === null ? { items, name: viewerName } : { items };
  const m = mutation("addNote", args, { clientId: CLIENT, n: ++clientN });
  outbox.push({ m, at: Date.now(), as: sender() });
  outboxUnsaved = !SS.set(OUTBOX_KEY, outbox);
  sync?.send(m);
  setQueue([]);
  set({ draft: "" });
  showOutboxNotice();
  refreshPending();
}

/** Hosted owner: releases or discards a held note over the page socket. Not kept for a re-send; an ack error shows in `settle`. */
export function sendOwnerAction(name: "releaseNote" | "discardNote", note: string): void {
  sync?.send(mutation(name, { note }, { clientId: CLIENT, n: ++clientN }));
}

/**
 * An ack settles one queued note. `rate_limited` keeps it in the outbox and sends the same mutation
 * again after `retryAfter` (the service does not store that answer). Any other error puts its items
 * back in the queue to be edited and sent again.
 */
export function settle(ack: AckFrame): void {
  const i = outbox.findIndex((o) => o.m.clientId === ack.clientId && o.m.n === ack.n);
  if (i < 0) {
    // Not a note of the outbox: a release or discard the service refused.
    if (ack.error) set({ composerError: ack.error.message });
    return;
  }
  if (ack.error?.code === "rate_limited") {
    const entry = outbox[i];
    const wait = Math.max(1, ack.error.retryAfter ?? 5);
    // The deadline is saved with the note, so a reconnect or a reload waits it out too.
    entry.retryAt = Date.now() + wait * 1000;
    outboxUnsaved = !SS.set(OUTBOX_KEY, outbox);
    rateLimit = entry.retryAt;
    showOutboxNotice();
    sendWhenDue(entry);
    return;
  }
  const [done] = outbox.splice(i, 1);
  // Saved again, or every note acked: nothing is left to lose on a reload.
  const saved = SS.set(OUTBOX_KEY, outbox);
  if (outboxUnsaved && (saved || !outbox.length)) outboxUnsaved = false;
  if (!outbox.some((o) => o.retryAt)) rateLimit = null;
  showOutboxNotice();
  if (ack.error) {
    for (const item of done.m.args.items) addToQueue({ ...item });
    set({
      composerError: `Couldn't send: ${ack.error.message}. Your notes are back in the queue.`,
      composerRetry: true,
    });
  }
  refreshPending();
}

/** The Conversation shows the notes still waiting for their ack; call this after the outbox or the reviewer changes. */
export function refreshPending(): void {
  set({ pending: mine() });
}
