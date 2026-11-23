// The History panel, over the notes (the owner's): every revision, newest first, to pick one and see what it
// changed on the page; or one part's earlier texts, each with the note that changed it and Restore.
import { useEffect, useRef, useState } from "react";
import type { ReactElement } from "react";
import { plural } from "./format.ts";
import { Icon } from "./icon.tsx";
import { BASE } from "./review-env.ts";
import { post } from "./review-bridge.ts";
import { postHighlight } from "./review-changes.ts";
import { isoTime } from "./review-format.ts";
import { closeHistory, restoreStatement } from "./review-history.ts";
import { useFetchJson } from "./review-hooks.ts";
import { useReview } from "./review-store.ts";
import type { HistoryRevision, StatementVersion } from "./review-types.ts";
import { Button } from "@/chrome/ui/button";
import { ScrollArea } from "@/chrome/ui/scroll-area";
import { Skeleton } from "@/chrome/ui/skeleton";

const SOURCES: Record<string, string> = {
  patch: "patched",
  file: "edited",
  open: "found on open",
  restore: "restored",
};
const noteLine = (n: { author: string; target: string | null; text: string }): string =>
  `${n.author}${n.target ? ` on ${n.target}` : ""}: ${n.text}`;
const FAILED = "History could not be loaded. Check that austere-axi is still running.";

function Loading(): ReactElement {
  return (
    <div className="hist-loading" role="status" aria-label="Loading the history">
      <Skeleton className="h-16 w-full" />
      <Skeleton className="h-16 w-full" />
      <Skeleton className="h-16 w-full" />
    </div>
  );
}

function Empty({ children }: { children: string }): ReactElement {
  return <div className="hist-empty">{children}</div>;
}

/** Every revision: pick one to outline what it changed. The outline is a preview, taken back when the panel closes. */
function Revisions(): ReactElement {
  const hist = useReview((s) => s.hist);
  const failed = useReview((s) => s.histError);
  const sinceCount = useReview((s) => s.sinceCount);
  const sinceChanges = useReview((s) => s.sinceChanges);
  const [picked, setPicked] = useState<number | null>(null);
  const previewed = useRef(false);
  // Closing the panel (leaving this component) puts back what the control outlines.
  useEffect(
    () => () => {
      if (previewed.current) postHighlight(false);
    },
    [],
  );
  if (!hist) return failed ? <Empty>{FAILED}</Empty> : <Loading />;
  if (!hist.revisions.length) return <Empty>No revision is recorded yet.</Empty>;
  const pick = (r: HistoryRevision): void => {
    setPicked(r.rev);
    previewed.current = true;
    post({ type: "highlight", ids: r.changed.slice(0, 100), scroll: true });
  };
  return (
    <>
      {/* The same count the bar above the page shows. */}
      {sinceCount > 0 && sinceChanges.length > 0 ? (
        <div className="hist-since">{`${plural(sinceCount, "revision")} since you last looked`}</div>
      ) : null}
      {hist.revisions.map((r) => {
        const names = r.created
          ? [`${plural(r.created, "statement")} at the start`]
          : [...r.changed, ...r.removed.map((n) => `${n} (deleted)`)];
        return (
          <div className="hist-row" key={r.rev}>
            <Button
              type="button"
              variant="ghost"
              className="hist-pick h-auto justify-start whitespace-normal"
              aria-pressed={picked === r.rev}
              onClick={() => pick(r)}
            >
              <span className="hist-meta">
                {`${r.rev === hist.head ? "Now · " : ""}Revision ${r.rev} · ${isoTime(r.at)} · ${SOURCES[r.source] || r.source}${r.by ? ` by ${r.by}` : ""}`}
              </span>
              <span className="hist-names">
                {names.length > 6
                  ? `${names.slice(0, 6).join(", ")} +${names.length - 6}`
                  : names.join(", ")}
              </span>
              {r.cause.length ? (
                <span className="hist-cause">
                  {`${noteLine(r.cause[0]).slice(0, 140)}${r.cause.length > 1 ? ` (+${r.cause.length - 1} more)` : ""}`}
                </span>
              ) : null}
            </Button>
          </div>
        );
      })}
    </>
  );
}

/** One statement's earlier texts, newest first; the owner puts an earlier one back with Restore. */
function Versions({ name }: { name: string }): ReactElement {
  const loaded = useFetchJson<{ versions?: StatementVersion[] }>(
    `${BASE}/history?statement=${encodeURIComponent(name)}`,
  );
  if (loaded.status === "loading") return <Loading />;
  if (loaded.status === "error") return <Empty>{FAILED}</Empty>;
  const versions = loaded.data.versions ?? [];
  if (!versions.length) return <Empty>No earlier version is recorded.</Empty>;
  return (
    <>
      {versions.map((v, i) => (
        <div className="hist-row" key={v.rev}>
          <span className="hist-meta">
            {`${i === 0 ? "Now · " : ""}Revision ${v.rev} · ${isoTime(v.at)} · ${SOURCES[v.source] || v.source}`}
          </span>
          <pre className="hist-text">
            {v.text === null ? "(deleted)" : v.text.slice(0, 1500) || "(no text)"}
          </pre>
          {v.cause.length ? (
            <span className="hist-cause">
              {`${v.cause.slice(0, 2).map(noteLine).join(" · ").slice(0, 200)}${v.cause.length > 2 ? ` (+${v.cause.length - 2} more)` : ""}`}
            </span>
          ) : null}
          {i > 0 && v.text !== null ? (
            <Button
              type="button"
              size="xs"
              className="restore self-start"
              onClick={() => void restoreStatement(name, v.rev)}
            >
              Restore this version
            </Button>
          ) : null}
        </div>
      ))}
    </>
  );
}

export function HistoryPanel(): ReactElement {
  const open = useReview((s) => s.panel === "history");
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape" && !e.defaultPrevented) closeHistory();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open]);
  const statement = useReview((s) => s.historyFor);
  const title = useRef<HTMLSpanElement>(null);
  // Opening History puts the keyboard in it, on its title; Tab then reaches Close and the revisions.
  useEffect(() => {
    if (open) title.current?.focus();
  }, [open]);
  return (
    <div className="hist" role="dialog" aria-labelledby="hist-title" hidden={!open}>
      <div className="hist-head">
        <span className="hist-title" id="hist-title" tabIndex={-1} ref={title}>
          {statement ? `History · ${statement}` : "History"}
        </span>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          className="hist-close"
          aria-label="Close History"
          onClick={closeHistory}
        >
          <Icon name="close" size={16} width={1.8} />
        </Button>
      </div>
      {open ? (
        <ScrollArea className="hist-body">
          <div className="hist-list">
            {statement ? <Versions name={statement} /> : <Revisions />}
          </div>
        </ScrollArea>
      ) : null}
    </div>
  );
}
