import React from "react";
import { z } from "zod";
import { austereComponent } from "austere-axi/pack";

const nothing = () => null;
const STATES = ["done", "current", "upcoming"];

function TimelineView({ props }) {
  const items = (Array.isArray(props.items) ? props.items : []).filter((el) => el && el.props);
  return (
    <ol className="sh-timeline">
      {items.map((el, i) => {
        const p = el.props;
        const state = STATES.includes(p.state) ? p.state : "done";
        return (
          <li key={i} className={`sh-timeline-item is-${state}`} data-austere-part={p.title}>
            <span className="sh-timeline-dot" aria-hidden="true" />
            <div className="sh-timeline-body">
              <div className="sh-timeline-head">
                <strong>{p.title}</strong>
                {p.date ? <span className="sh-muted">{p.date}</span> : null}
              </div>
              {p.detail ? <div className="sh-muted">{p.detail}</div> : null}
            </div>
          </li>
        );
      })}
    </ol>
  );
}

export const TimelineItem = austereComponent({
  name: "TimelineItem",
  group: "Content",
  tier: "extended",
  props: z.object({
    title: z.string(),
    date: z.string().optional(),
    detail: z.string().optional(),
    state: z.enum(STATES).optional(),
  }),
  description: "One event in a Timeline. state: done (default), current or upcoming.",
  renderer: nothing,
  slots: null,
  tagged: false,
});

export const Timeline = austereComponent({
  name: "Timeline",
  group: "Content",
  tier: "extended",
  props: z.object({ items: z.array(TimelineItem.definition.ref) }),
  description: "Vertical history or schedule of TimelineItems, oldest first. Each item is a click target.",
  renderer: TimelineView,
  example: `history = Timeline([found, fixed, rollout])
found = TimelineItem("Bug found", "Oct 28", "Retries double-charge on timeout.")
fixed = TimelineItem("Fix merged", "Oct 29", "Idempotency key added.", "current")
rollout = TimelineItem("Rollout", "Nov 3", "", "upcoming")`,
});
