import React from "react";
import { z } from "zod";
import { austereComponent } from "austere-axi/pack";

function SkeletonView({ props }) {
  const lines = Math.min(12, Math.max(1, Number.isInteger(props.lines) ? props.lines : 3));
  return (
    <div className="sh-skeleton" aria-hidden="true">
      {props.shape === "avatar" ? <span className="sh-skel sh-skel-avatar" /> : null}
      <div className="sh-skeleton-lines">
        {Array.from({ length: lines }, (_, i) => (
          <span key={i} className="sh-skel" style={{ width: i === lines - 1 && lines > 1 ? "60%" : "100%" }} />
        ))}
      </div>
    </div>
  );
}

export default austereComponent({
  name: "Skeleton",
  group: "Content",
  tier: "extended",
  props: z.object({ lines: z.number().int().optional(), shape: z.enum(["lines", "avatar"]).optional() }),
  description: "Grey placeholder block for content not yet written or loaded (default 3 lines). shape avatar adds a round head.",
  renderer: SkeletonView,
  example: `pending = Skeleton(3, "avatar")`,
});
