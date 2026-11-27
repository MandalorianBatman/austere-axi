// The Conversation: what the agent said, the notes that were sent (with their delivery receipts), the page's render
// issues, and for the owner the agent runs. It follows the newest entry unless the reader has scrolled up.
import { useEffect, useLayoutEffect, useRef } from "react";
import type { ReactElement } from "react";
import { fmtTime } from "./review-format.ts";
import { HOSTED, OWNER } from "./review-env.ts";
import { Item } from "./review-item.tsx";
import { Markdown } from "./review-markdown.tsx";
import { addToQueue } from "./review-notes.ts";
import { heldAction } from "./review-send.ts";
import { loadEarlier } from "./review-transcript.ts";
import { useReview } from "./review-store.ts";
import type { Entry, RunMark } from "./review-types.ts";
import { Button } from "@/chrome/ui/button";
import { ScrollArea } from "@/chrome/ui/scroll-area";
import { Skeleton } from "@/chrome/ui/skeleton";

/** "You" for the viewer's own notes, otherwise the author's name; the owner's notes read "Owner" to a reviewer. */
function whoLabel(entry: Entry, viewerName: string): string {
  if (OWNER) return entry.author || "You";
  return entry.author === viewerName ? "You" : entry.author || "Owner";
}

function Receipt({ entry }: { entry: Entry }): ReactElement | null {
  const presence = useReview((s) => s.presence);
  const wake = useReview((s) => s.wake);
  const unread = useReview((s) => s.unread);
  const viewerName = useReview((s) => s.viewerName);
  const hostedOwner = useReview((s) => s.hostedOwner);
  // Hosted notes have no delivery receipts: the owner's agent sees them after a sync.
  if (HOSTED) {
    if (entry.pending)
      return (
        <div className="receipt">
          <em>Sending…</em>
        </div>
      );
    if (hostedOwner && !entry.held)
      return (
        <div className="receipt">
          <em>Sent to the agent</em>
        </div>
      );
    if (!hostedOwner)
      return entry.author === viewerName ? (
        <div className="receipt">
          <em>Sent to the page owner</em>
        </div>
      ) : null;
  }
  const mayRelease = OWNER || hostedOwner;
  if (entry.held)
    return (
      <div className="receipt held">
        <span className="held-label">
          {mayRelease ? "Held · not sent to the agent" : "Waiting for the owner to send it on"}
        </span>
        {mayRelease ? (
          <>
            <Button size="xs" type="button" onClick={() => void heldAction("release", [entry.id])}>
              Send
            </Button>
            <Button
              size="xs"
              type="button"
              variant="outline"
              onClick={() => void heldAction("discard", [entry.id])}
            >
              Discard
            </Button>
          </>
        ) : null}
      </div>
    );
  const steps: [string, number | undefined][] = [
    ["Seen", entry.seenAt],
    ["Working", entry.workAt],
    ["Done", entry.doneAt],
  ];
  return (
    <div className="receipt">
      {steps.map(([label, at]) => (
        <span
          key={label}
          className={at ? "on" : ""}
          title={at ? `${label} ${fmtTime(at)}` : `Not ${label.toLowerCase()} yet`}
        >
          {label}
          <span className="sr-only">{at ? ` ${fmtTime(at)}` : " not yet"}</span>
        </span>
      ))}
      {entry.seenAt && entry.seenBy ? (
        <em>{`Delivered to ${entry.seenBy} ${fmtTime(entry.seenAt)}`}</em>
      ) : !entry.seenAt ? (
        <em>
          {presence === "listening" || wake?.state === "idle"
            ? ""
            : wake?.state === "busy"
              ? "Queued · agent busy"
              : unread
                ? `waiting for the agent (${unread} not answered yet)`
                : "waiting for the agent"}
        </em>
      ) : null}
    </div>
  );
}

function Issues(): ReactElement | null {
  const parser = useReview((s) => s.parserErrors);
  const runtime = useReview((s) => s.runtimeErrors);
  const sent = useReview((s) => OWNER && s.renderReport === "sent");
  const archived = useReview((s) => s.archived);
  const issues = [...parser, ...runtime];
  if (!issues.length) return null;
  return (
    <div className="issues">
      <div className="issues-head">
        {`Render issues (${issues.length})${sent ? " · sent to the agent" : ""}`}
      </div>
      {issues.slice(0, 8).map((err, i) => (
        <div className="issue" key={i}>
          <div className="issue-text">
            {err.statementId ? <code>{err.statementId}</code> : null} {err.message}
          </div>
          {/* Once the owner's page has sent it to the agent (reportRenderErrors), there is nothing to queue. */}
          {archived || sent ? null : (
            <Button
              type="button"
              size="xs"
              variant="outline"
              onClick={() =>
                addToQueue({
                  kind: "render-error",
                  statement: err.statementId,
                  target: err.statementId,
                  message: err.message,
                  note: "Fix this render error.",
                })
              }
            >
              Queue fix
            </Button>
          )}
        </div>
      ))}
    </div>
  );
}

function RunRow({ mark }: { mark: RunMark }): ReactElement {
  return (
    <div className={`run-mark ${mark.tone}`}>
      <span>{mark.text}</span>
      <time>{fmtTime(mark.at)}</time>
    </div>
  );
}

function Message({ entry }: { entry: Entry }): ReactElement | null {
  const viewerName = useReview((s) => s.viewerName);
  if (entry.role === "agent")
    return (
      <div className="msg agent">
        <div className="who">{`Agent · ${fmtTime(entry.at)}`}</div>
        <Markdown source={entry.text} />
      </div>
    );
  const n = entry.items?.length ?? 0;
  const who = n
    ? `${whoLabel(entry, viewerName)} sent ${n} note${n === 1 ? "" : "s"}`
    : whoLabel(entry, viewerName);
  return (
    <>
      {/* A Done is an empty final batch: it has no bubble, only the line below. */}
      {n || !entry.end ? (
        <div className={`msg user${entry.held ? " held" : ""}`}>
          <div className="who">{`${who} · ${fmtTime(entry.at)}`}</div>
          {(entry.items || []).map((item, i) => (
            <Item key={i} item={item} held={!!entry.held} />
          ))}
          <Receipt entry={entry} />
        </div>
      ) : null}
      {entry.end ? (
        <div className="final-note" title={fmtTime(entry.at)}>
          {OWNER
            ? "You told the agent this was your last note. Notes you add later wait until an agent checks."
            : "The owner told the agent this was their last note. Notes added later wait until an agent checks."}
        </div>
      ) : null}
    </>
  );
}

const nearEnd = (el: HTMLElement): boolean => el.scrollHeight - el.scrollTop - el.clientHeight < 40;

export function Log({ inert }: { inert?: boolean }): ReactElement {
  const s = useReview();
  const root = useRef<HTMLDivElement>(null);
  const viewport = (): HTMLElement | null =>
    root.current?.querySelector<HTMLElement>('[data-slot="scroll-area-viewport"]') ?? null;
  // What the reader was looking at, kept as the reader scrolls: following the newest entry, or a distance from the end.
  const follow = useRef(true);
  const fromEnd = useRef(0);
  useEffect(() => {
    const vp = viewport();
    if (!vp) return;
    const onScroll = (): void => {
      follow.current = nearEnd(vp);
      fromEnd.current = vp.scrollHeight - vp.scrollTop;
    };
    vp.addEventListener("scroll", onScroll, { passive: true });
    return () => vp.removeEventListener("scroll", onScroll);
  }, []);

  const entries = s.pending.length
    ? [
        ...s.transcript,
        ...s.pending.map((o): Entry => ({
          id: `out:${o.m.clientId}:${o.m.n}`,
          role: "user",
          author: s.viewerName,
          items: o.m.args.items,
          at: o.at,
          pending: true,
        })),
      ]
    : s.transcript;
  // The owner's run marks sit among the entries by time; with older entries not loaded yet, older marks wait too.
  const since = s.more ? (entries[0]?.at ?? 0) : 0;
  const marks = OWNER ? Object.values(s.runMarks).filter((m) => m.at >= since) : [];
  const rows: (Entry | RunMark)[] = marks.length
    ? [...entries, ...marks].sort((a, b) => a.at - b.at)
    : entries;
  const heldIds = OWNER || s.hostedOwner ? s.transcript.filter((e) => e.held).map((e) => e.id) : [];
  const count = rows.length + s.queue.length;

  const last = useRef({ count, first: entries[0]?.id });
  useLayoutEffect(() => {
    const vp = viewport();
    if (!vp) return;
    const prev = last.current;
    last.current = { count, first: entries[0]?.id };
    if (
      prev.first !== undefined &&
      entries[0]?.id !== prev.first &&
      entries.some((e) => e.id === prev.first)
    )
      // Older entries were put in front: the reader stays where they were.
      vp.scrollTop = vp.scrollHeight - fromEnd.current;
    else if (follow.current || count !== prev.count) vp.scrollTop = vp.scrollHeight;
    fromEnd.current = vp.scrollHeight - vp.scrollTop;
  });
  // A log that was hidden (Explore) has no layout to follow new messages: show the latest as it comes back.
  useLayoutEffect(() => {
    const vp = viewport();
    if (vp && s.mode !== "explore") vp.scrollTop = vp.scrollHeight;
  }, [s.mode]);
  // The sheet on a phone slides in: the latest once it has.
  useEffect(() => {
    if (!s.sheetOpen) return;
    const t = window.setTimeout(() => {
      const vp = viewport();
      if (vp) vp.scrollTop = vp.scrollHeight;
    }, 50);
    return () => window.clearTimeout(t);
  }, [s.sheetOpen]);

  return (
    <ScrollArea className="log" ref={root} inert={inert}>
      <div className="log-body" aria-busy={!s.loaded}>
        <Issues />
        {s.more ? (
          <Button
            type="button"
            variant="outline"
            size="xs"
            className="load-earlier"
            onClick={() => void loadEarlier()}
          >
            Load earlier messages
          </Button>
        ) : null}
        {!s.loaded ? (
          <div className="log-loading" role="status" aria-label="Loading the conversation">
            <Skeleton className="h-4 w-1/3" />
            <Skeleton className="h-16 w-full" />
            <Skeleton className="h-4 w-1/2" />
          </div>
        ) : null}
        {s.loaded && !entries.length ? (
          <div className="empty">
            <strong>Nothing sent yet</strong>
            <p>
              {`Click a card, a table cell, a box in a diagram or a line of a diff, or select some text, and say what should change. Notes wait below until you send them together, ${HOSTED ? "and the page owner gets them." : "and the agent changes only the parts you pointed at."}`}
            </p>
          </div>
        ) : null}
        {rows.map((row) =>
          "tone" in row ? (
            <RunRow key={`${row.id}:${row.tone === "start" ? "start" : "end"}`} mark={row} />
          ) : (
            <Message key={row.id} entry={row} />
          ),
        )}
        {heldIds.length ? (
          <div className="held-bar">
            <span>{`${heldIds.length} held from teammates`}</span>
            <Button size="xs" type="button" onClick={() => void heldAction("release", heldIds)}>
              Send all
            </Button>
            <Button
              size="xs"
              type="button"
              variant="outline"
              onClick={() => void heldAction("discard")}
            >
              Discard all
            </Button>
          </div>
        ) : null}
        {s.archived ? (
          <div className="archived-note">
            {OWNER
              ? "This page is archived. Unarchive it from the ⋯ menu to add notes."
              : "The owner archived this page. Ask them to reopen it if you have more notes."}
          </div>
        ) : null}
      </div>
    </ScrollArea>
  );
}
