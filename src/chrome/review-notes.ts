// The notes waiting to be sent ("Ready to send"), and what a note says about the part it points at.
import { S, set, setQueue } from "./review-store.ts";
import { str } from "./review-env.ts";
import type { QueueItem } from "./review-types.ts";

/** A note from the frame (untrusted), or one the page makes itself, joins the queue. */
export function addToQueue(raw: unknown): void {
  if (
    S().archived ||
    !raw ||
    typeof raw !== "object" ||
    typeof (raw as { kind?: unknown }).kind !== "string"
  )
    return;
  // Frame code is untrusted: the item is rendered here and saved to localStorage, so its text fields must be strings.
  const fields = raw as Record<string, unknown>;
  for (const k of [
    "target",
    "component",
    "note",
    "text",
    "selection",
    "excerpt",
    "message",
    "statement",
  ])
    if (k in fields) fields[k] = str(fields[k]);
  const item = raw as QueueItem;
  item.qid = `q${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  setQueue([...S().queue, item]);
}

export function removeFromQueue(qid: string | undefined): void {
  setQueue(S().queue.filter((q) => q.qid !== qid));
}

/** Edit saved: a message left empty goes away, an annotation keeps an empty note. */
export function saveEdit(qid: string | undefined, value: string): void {
  const item = S().queue.find((q) => q.qid === qid);
  const text = value.trim();
  set({ editing: null });
  if (!item) return;
  if (item.kind === "message" && !text) return removeFromQueue(qid);
  setQueue(
    S().queue.map((q) =>
      q.qid === qid ? (q.kind === "message" ? { ...q, text } : { ...q, note: text }) : q,
    ),
  );
}

export function anchorLabel(item: QueueItem): {
  icon: string;
  text: string | undefined;
  sub: string | undefined;
} {
  if (item.kind === "annotation") return { icon: "✎", text: item.target, sub: item.component };
  if (item.kind === "action") return { icon: "↗", text: item.message, sub: "button" };
  if (item.kind === "render-error")
    return { icon: "!", text: item.statement || "page", sub: "render issue" };
  return { icon: "", text: "", sub: "" };
}

export function flatForm(obj: object | null | undefined, prefix = ""): string[] {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(obj || {})) {
    if (v && typeof v === "object" && !Array.isArray(v)) parts.push(...flatForm(v, ""));
    else parts.push(`${prefix}${k}: ${Array.isArray(v) ? v.join(", ") : v}`);
  }
  return parts;
}

export function itemQuote(item: QueueItem): unknown {
  if (item.selection) return item.selection;
  if (item.detail?.part)
    return item.excerpt ? `${item.detail.part}  ${item.excerpt}` : item.detail.part;
  if (item.detail?.column) {
    const where = [item.detail.row && `row ${item.detail.row}`, `column ${item.detail.column}`]
      .filter(Boolean)
      .join(", ");
    return item.excerpt ? `${item.excerpt}  (${where})` : where;
  }
  if (item.kind === "action" && item.form) return flatForm(item.form).join(" · ");
  if (item.kind === "render-error") return item.message;
  return item.excerpt || "";
}
