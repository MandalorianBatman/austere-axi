// The bar above the page and the page's header: who is on the page and what the agent does.
import type { ReactElement } from "react";
import { useShallow } from "zustand/react/shallow";
import { plural } from "./format.ts";
import { Icon } from "./icon.tsx";
import { shownChanges, toggleHighlight } from "./review-changes.ts";
import { useNow } from "./review-hooks.ts";
import { closePanel, openHistory } from "./review-history.ts";
import { presenceView } from "./review-presence.ts";
import { set, useReview } from "./review-store.ts";
import { Button } from "@/chrome/ui/button";

/** The agent's state in words, counting up ("Agent working (2 min)"): one label, the same one the Agent tab and the dock show. */
export function PresencePill(): ReactElement {
  const s = useReview(
    useShallow((r) => ({
      archived: r.archived,
      lockout: r.lockout,
      connected: r.connected,
      presence: r.presence,
      since: r.since,
      wake: r.wake,
      unread: r.unread,
      attachOn: r.attachOn,
    })),
  );
  const view = presenceView(s, useNow());
  return (
    <span className={`presence ${view.cls}${view.attached ? " attached" : ""}`} title={view.title}>
      {view.label}
    </span>
  );
}

/** "N changed": outlines on the page what the last turn (and, for the owner, everything since they looked) changed. */
export function ChangesButton(): ReactElement {
  const s = useReview(
    useShallow((r) => ({ changes: r.changes, sinceChanges: r.sinceChanges, highlight: r.highlight })),
  );
  const shown = shownChanges(s);
  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      className="changes"
      aria-pressed={s.highlight}
      // While on, the button stays so it can be switched off, even after a turn that changed nothing.
      hidden={!shown.length && !s.highlight}
      title={
        shown.length
          ? `${s.highlight ? "Hide" : "Highlight"} what changed${s.sinceChanges.length ? " since you last looked and in the last turn" : " in the last turn"}: ${shown.join(", ")}`
          : "The last turn changed nothing on the page. Click to stop highlighting."
      }
      onClick={toggleHighlight}
    >
      <Icon name="check" size={13} width={2.2} />
      {shown.length} changed
    </Button>
  );
}

/** The newest revision the history knows. */
export function Revision(): ReactElement {
  const head = useReview((s) => s.hist?.head ?? 0);
  return (
    <span className="rev" hidden={!head}>
      {head ? `Revision ${head}` : ""}
    </span>
  );
}

/** Opens the History panel over the notes, or closes it. */
export function HistoryButton(): ReactElement {
  const open = useReview((s) => s.panel === "history");
  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      className="hist-btn"
      aria-expanded={open}
      title="Every version of this page, and what changed since you last looked"
      onClick={() => (open ? closePanel() : openHistory())}
    >
      <Icon name="clock" size={13} width={1.9} />
      History
    </Button>
  );
}

/** Revisions made while the owner was away, with the way to see what they changed. */
export function SinceBar(): ReactElement {
  const s = useReview(
    useShallow((r) => ({ count: r.sinceCount, dismissed: r.sinceDismissed, highlight: r.highlight })),
  );
  return (
    <div className="since" role="status" hidden={!s.count || s.dismissed}>
      <span className="since-dot" aria-hidden="true" />
      <span className="since-text">{`${plural(s.count, "revision")} since you last looked`}</span>
      <Button
        type="button"
        size="xs"
        variant="outline"
        data-since="show"
        aria-pressed={s.highlight}
        onClick={toggleHighlight}
      >
        Outline them
      </Button>
      <Button type="button" size="xs" variant="ghost" data-since="history" onClick={() => openHistory()}>
        History
      </Button>
      <Button
        type="button"
        size="icon-xs"
        variant="ghost"
        className="since-x"
        data-since="dismiss"
        aria-label="Dismiss"
        onClick={() => set({ sinceDismissed: true })}
      >
        <Icon name="close" size={14} width={2} />
      </Button>
    </div>
  );
}
