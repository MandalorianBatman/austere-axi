// The bar above the page and the page's header: who is on the page and what the agent does.
import type { ReactElement } from "react";
import { useShallow } from "zustand/react/shallow";
import { useNow } from "./review-hooks.ts";
import { presenceView } from "./review-presence.ts";
import { useReview } from "./review-store.ts";

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
