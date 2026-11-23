// The panel's views (Notes; for the owner also Agent and History) and, on a phone, the dock and the sheet's controls.
import { useEffect, useRef } from "react";
import type { ReactElement } from "react";
import { useShallow } from "zustand/react/shallow";
import { Icon } from "./icon.tsx";
import { openAttach, closeAttach } from "./review-attach.ts";
import { closePanel, openHistory } from "./review-history.ts";
import { swipe, useNarrow, useNow } from "./review-hooks.ts";
import { OWNER, SID, SS } from "./review-env.ts";
import { presenceView } from "./review-presence.ts";
import { set, setSheet, useReview } from "./review-store.ts";
import { Button } from "@/chrome/ui/button";
import { Tabs, TabsList, TabsTrigger } from "@/chrome/ui/tabs";

/** Notes, Agent and History. Agent and History open over the notes; the tab says which is showing. */
export function PanelTabs(): ReactElement {
  const s = useReview(
    useShallow((r) => ({
      panel: r.panel,
      queued: r.queue.length,
      archived: r.archived,
      lockout: r.lockout,
      connected: r.connected,
      presence: r.presence,
      since: r.since,
      wake: r.wake,
      unread: r.unread,
      attachInfo: r.attachInfo,
    })),
  );
  const presence = presenceView(s, useNow());
  return (
    <Tabs
      value={s.panel}
      // Arrow keys move between the tabs; Enter or Space opens one, as a click does.
      activationMode="manual"
      onValueChange={(tab) => {
        if (tab === "agent") openAttach();
        else if (tab === "history") openHistory();
        else {
          closeAttach();
          closePanel();
        }
      }}
    >
      <TabsList variant="line" className="panel-tabs" aria-label="Review panel views">
        <TabsTrigger value="notes" className="panel-tab" data-tab="notes" aria-controls={undefined}>
          Notes <span className="tab-count">{s.queued ? String(s.queued) : ""}</span>
        </TabsTrigger>
        {OWNER ? (
          <TabsTrigger
            value="agent"
            className="panel-tab"
            data-tab="agent"
            aria-controls={undefined}
          >
            Agent{" "}
            <span className={`tab-dot ${presence.cls}`} role="img" aria-label={presence.label} />
          </TabsTrigger>
        ) : null}
        {OWNER ? (
          <TabsTrigger
            value="history"
            className="panel-tab"
            data-tab="history"
            aria-controls={undefined}
          >
            History
          </TabsTrigger>
        ) : null}
      </TabsList>
    </Tabs>
  );
}

/** The panel's head: the tabs, and on a phone the way to close the sheet (a swipe down does too). */
export function PanelHead(): ReactElement {
  return (
    <div className="panel-head" {...swipe((dy) => dy > 60 && setSheet(false))}>
      <PanelTabs />
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        className="sheet-close"
        aria-label="Close the notes"
        onClick={() => setSheet(false)}
      >
        <Icon name="chevronDown" size={20} width={2} />
      </Button>
    </div>
  );
}

/** The bar at the foot of a phone's screen: how many notes are ready, and the agent's state; it opens the sheet. */
export function Dock(): ReactElement {
  const s = useReview(
    useShallow((r) => ({
      queued: r.queue.length,
      last: r.transcript[r.transcript.length - 1],
      seenAt: r.seenAt,
      pulse: r.dockPulse,
      archived: r.archived,
      lockout: r.lockout,
      connected: r.connected,
      presence: r.presence,
      since: r.since,
      wake: r.wake,
      unread: r.unread,
      attachInfo: r.attachInfo,
    })),
  );
  const now = useNow();
  const open = useReview((r) => r.sheetOpen);
  const parts = [s.queued ? `${s.queued} note${s.queued === 1 ? "" : "s"} ready` : "Notes"];
  if (s.last?.role === "agent" && s.last.at > s.seenAt) parts.push("new reply");
  // On a phone the header hides the presence: the dock carries its label (none when an attached agent's pill says it).
  const presence = presenceView(s, now);
  const ref = useRef<HTMLButtonElement>(null);
  const first = useRef(true);
  // A button the frame pressed pulses the dock; restarting the animation needs the class taken off and put back.
  useEffect(() => {
    const el = ref.current;
    if (first.current || !el) return void (first.current = false);
    el.classList.remove("pulse");
    void el.offsetWidth;
    el.classList.add("pulse");
  }, [s.pulse]);
  return (
    <Button
      type="button"
      variant="ghost"
      className="dock"
      ref={ref}
      aria-haspopup="dialog"
      aria-expanded={open}
      aria-controls={open ? "notes-sheet" : undefined}
      onClick={() => {
        const at = Date.now();
        SS.set(`austere:seen:${SID}`, at);
        set({ seenAt: at });
        setSheet(true);
      }}
      {...swipe((dy) => dy < -40 && setSheet(true))}
    >
      <span className="dock-grip" />
      <span className="dock-text">
        <span className="dock-title">{parts.join(" · ")}</span>
        {presence.attached ? null : (
          <span className={`dock-presence ${presence.cls}`}>{presence.label}</span>
        )}
      </span>
      <Icon name="chevronDown" size={16} width={2} cls="dock-caret" />
    </Button>
  );
}

/** Whether History covers the notes, the queue and the composer (a wide screen): they take no focus then. */
export function useCovered(): boolean {
  const history = useReview((s) => s.panel === "history");
  const narrow = useNarrow();
  return history && !narrow;
}
