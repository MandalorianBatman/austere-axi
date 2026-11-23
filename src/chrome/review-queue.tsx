// "Ready to send": the queued notes, numbered in the order they go out, each with Edit and Remove.
import { useLayoutEffect, useRef } from "react";
import type { ReactElement } from "react";
import { Icon } from "./icon.tsx";
import { Item } from "./review-item.tsx";
import { removeFromQueue } from "./review-notes.ts";
import { set, useReview } from "./review-store.ts";
import { Button } from "@/chrome/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/chrome/ui/tooltip";

function IconAction({
  label,
  className,
  onClick,
  children,
}: {
  label: string;
  className: string;
  onClick: () => void;
  children: ReactElement;
}): ReactElement {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          className={`text-[var(--faint)] ${className}`}
          aria-label={label}
          onClick={onClick}
        >
          {children}
        </Button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

export function Queue(): ReactElement {
  const queue = useReview((s) => s.queue);
  const n = queue.length;
  const list = useRef<HTMLOListElement>(null);
  const before = useRef(n);
  // The list scrolls by itself: an Edit or Remove keeps its place, a new note is brought into view.
  useLayoutEffect(() => {
    if (n > before.current && list.current) list.current.scrollTop = list.current.scrollHeight;
    before.current = n;
  }, [n]);
  return (
    <section className="queue" aria-label="Ready to send" hidden={!n}>
      <div className="queue-head">
        <span className="queue-title">Ready to send · {n}</span>
        <span className="queue-sub">Sent together, in this order</span>
      </div>
      <ol className="queue-list" ref={list}>
        {queue.map((item, i) => (
          <li className="q-item" key={item.qid}>
            <span className="q-num" aria-hidden="true">
              {i + 1}
            </span>
            <Item item={item} queued />
            <div className="q-actions">
              <IconAction
                label={`Edit note ${i + 1}`}
                className="q-edit"
                onClick={() => set({ editing: item.qid ?? null })}
              >
                <Icon name="pencil" size={14} width={1.8} />
              </IconAction>
              <IconAction
                label={`Remove note ${i + 1}`}
                className="q-remove"
                onClick={() => removeFromQueue(item.qid)}
              >
                <Icon name="close" size={14} width={1.8} />
              </IconAction>
            </div>
          </li>
        ))}
      </ol>
    </section>
  );
}
