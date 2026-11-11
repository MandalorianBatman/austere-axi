import React from "react";
import { z } from "zod";
import { austereComponent } from "austere-axi/pack";

function ProgressView({ props }) {
  const max = Number(props.max) > 0 ? Number(props.max) : 100;
  const value = Math.min(max, Math.max(0, Number(props.value) || 0));
  const pct = Math.round((value / max) * 100);
  return (
    <div className="sh-progress">
      <div className="sh-progress-head">
        <span>{props.label}</span>
        <span className="sh-muted">{pct}%</span>
      </div>
      <div className="sh-progress-bar" role="progressbar" aria-valuemin={0} aria-valuemax={max} aria-valuenow={value}>
        <div className="sh-progress-fill" style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

export default austereComponent({
  name: "Progress",
  group: "Data",
  tier: "extended",
  props: z.object({ value: z.number(), label: z.string().optional(), max: z.number().optional() }),
  description: "Progress bar. value counts toward max (default 100); label names what is progressing. Shows a percentage.",
  renderer: ProgressView,
  example: `migration = Progress(64, "Rows migrated")`,
});
