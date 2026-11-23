// One note: the part it points at, what it quotes, and the text. The queue shows them editable; the Conversation
// shows them as they were sent (and, held, as the agent would receive them).
import { Component, useEffect, useRef } from "react";
import type { ReactElement, ReactNode } from "react";
import { str } from "./review-env.ts";
import { anchorLabel, flatForm, itemQuote, saveEdit } from "./review-notes.ts";
import { post } from "./review-bridge.ts";
import { isNarrow, set, setSheet, useReview } from "./review-store.ts";
import type { QueueItem } from "./review-types.ts";
import { Textarea } from "@/chrome/ui/textarea";

/** One bad item shows a marker instead of taking the whole panel down. */
class ItemBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  override state = { failed: false };
  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }
  override render(): ReactNode {
    return this.state.failed ? (
      <div className="item">
        <div className="note">This note could not be displayed.</div>
      </div>
    ) : (
      this.props.children
    );
  }
}

function Anchor({ item }: { item: QueueItem }): ReactElement | null {
  const a = anchorLabel(item);
  if (!a.text) return null;
  const reveal = item.kind === "annotation" || item.kind === "render-error";
  return (
    <button
      type="button"
      className="anchor"
      title={item.kind === "annotation" ? "Show in the page" : ""}
      onClick={() => {
        if (!reveal) return;
        post({ type: "reveal", id: item.target || item.statement });
        if (isNarrow()) setSheet(false);
      }}
    >
      <span className="anchor-icon">{a.icon}</span>
      <span className="anchor-text">{a.text}</span>
      {a.sub ? <span className="anchor-sub">{a.sub}</span> : null}
    </button>
  );
}

/** The note's text, edited in place: Enter saves, Escape drops the change, leaving the box saves. */
function Edit({ item, text }: { item: QueueItem; text: string }): ReactElement {
  const ref = useRef<HTMLTextAreaElement>(null);
  const cancelled = useRef(false);
  useEffect(() => ref.current?.focus(), []);
  return (
    <Textarea
      ref={ref}
      className="edit min-h-0 text-[length:var(--fs)]"
      rows={2}
      aria-label="Edit the note"
      defaultValue={text}
      onKeyDown={(e) => {
        if (e.key === "Enter" && !e.shiftKey) {
          e.preventDefault();
          saveEdit(item.qid, e.currentTarget.value);
        } else if (e.key === "Escape") {
          cancelled.current = true;
          set({ editing: null });
        }
      }}
      onBlur={(e) => {
        if (!cancelled.current) saveEdit(item.qid, e.currentTarget.value);
      }}
    />
  );
}

function ItemView({
  item,
  queued,
  held,
}: {
  item: QueueItem;
  queued?: boolean;
  held?: boolean;
}): ReactElement {
  const editing = useReview((s) => queued === true && s.editing === item.qid);
  // What the agent receives on release: within the path above the leaf, the whole detail, the whole quote.
  const within =
    held && item.kind === "annotation"
      ? (Array.isArray(item.path) ? item.path : [])
          .slice(0, -1)
          .filter((p) => typeof p === "string" && p !== "root")
      : [];
  const quote = str(itemQuote(item));
  const text = (item.kind === "message" ? item.text : item.note) ?? "";
  return (
    <div className={`item kind-${item.kind}${queued ? " q" : ""}`}>
      <Anchor item={item} />
      {within.length ? <div className="anchor-sub">{`within ${within.join(" > ")}`}</div> : null}
      {held && item.kind === "annotation" && item.detail && typeof item.detail === "object" ? (
        <div className="anchor-sub">{flatForm(item.detail).join(" · ")}</div>
      ) : null}
      {quote ? (
        <blockquote>{held || quote.length <= 260 ? quote : `${quote.slice(0, 259)}…`}</blockquote>
      ) : null}
      {editing ? (
        <Edit item={item} text={text} />
      ) : text ? (
        <div className="note">{text}</div>
      ) : null}
    </div>
  );
}

export function Item(props: { item: QueueItem; queued?: boolean; held?: boolean }): ReactElement {
  return (
    <ItemBoundary>
      <ItemView {...props} />
    </ItemBoundary>
  );
}
