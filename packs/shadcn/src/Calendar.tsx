import React from "react";
import { z } from "zod";
import { austereComponent } from "austere-axi/pack";

const DAY = /^(\d{4})-(\d{2})-(\d{2})(?:\s+(.*))?$/;
const WEEK = ["Mo", "Tu", "We", "Th", "Fr", "Sa", "Su"];

/** Marks as { day -> label } for the month; entries are "YYYY-MM-DD" or "YYYY-MM-DD label". */
function marksFor(year, month, entries) {
  const marks = new Map();
  for (const raw of Array.isArray(entries) ? entries : []) {
    const m = DAY.exec(String(raw).trim());
    if (m && Number(m[1]) === year && Number(m[2]) === month) marks.set(Number(m[3]), (m[4] || "").trim());
  }
  return marks;
}

function CalendarView({ props }) {
  const m = /^(\d{4})-(\d{2})/.exec(String(props.month ?? ""));
  const year = m ? Number(m[1]) : NaN;
  const month = m ? Number(m[2]) : NaN;
  if (!(month >= 1 && month <= 12)) return <div className="austere-render-error">Calendar needs a month like "2026-11".</div>;
  const first = new Date(Date.UTC(year, month - 1, 1));
  const days = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const lead = (first.getUTCDay() + 6) % 7;
  const marks = marksFor(year, month, props.highlights);
  const title = first.toLocaleString("en-US", { month: "long", year: "numeric", timeZone: "UTC" });
  const cells = [...Array(lead).fill(null), ...Array.from({ length: days }, (_, i) => i + 1)];
  return (
    <div className="sh-calendar">
      <div className="sh-calendar-title">{title}</div>
      <div className="sh-calendar-grid">
        {WEEK.map((d) => (
          <span key={d} className="sh-calendar-dow">
            {d}
          </span>
        ))}
        {cells.map((d, i) => {
          if (d === null) return <span key={`b${i}`} />;
          const marked = marks.has(d);
          const note = marks.get(d);
          return (
            <span
              key={d}
              className={`sh-calendar-day${marked ? " is-marked" : ""}`}
              title={note || undefined}
              data-austere-part={marked ? `${title.split(" ")[0]} ${d}${note ? `: ${note}` : ""}` : undefined}
            >
              {d}
            </span>
          );
        })}
      </div>
    </div>
  );
}

export default austereComponent({
  name: "Calendar",
  group: "Data",
  tier: "extended",
  props: z.object({ month: z.string(), highlights: z.array(z.string()).optional() }),
  description:
    'Read-only month grid (not a date picker). month is "YYYY-MM"; highlights lists "YYYY-MM-DD" or "YYYY-MM-DD label" entries to mark, e.g. a freeze or a release. Marked days are click targets.',
  renderer: CalendarView,
  example: `window = Calendar("2026-11", ["2026-11-04 Code freeze", "2026-11-12 Release", "2026-11-13"])`,
});
