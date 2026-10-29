import React from "react";
import { z } from "zod";
import { austereComponent } from "austere-axi/pack";

// Hover and keyboard focus show the card; the page is static, so no portal or positioning engine.
function TooltipView({ props }) {
  return (
    <span className="sh-pop sh-tooltip" tabIndex={0}>
      <span className="sh-pop-trigger">{props.text}</span>
      <span className="sh-pop-card" role="tooltip">
        {props.tip}
      </span>
    </span>
  );
}

export const Tooltip = austereComponent({
  name: "Tooltip",
  group: "Content",
  tier: "extended",
  props: z.object({ text: z.string(), tip: z.string() }),
  description: "Inline text with a short hint on hover or focus (a term and its definition). Keep tip to one line.",
  renderer: TooltipView,
  example: `term = Tooltip("idempotent", "Safe to run twice with the same result.")`,
});

function HoverCardView({ props }) {
  return (
    <span className="sh-pop sh-hovercard" tabIndex={0}>
      <span className="sh-pop-trigger">{props.text}</span>
      <span className="sh-pop-card sh-card" role="tooltip">
        <strong>{props.title}</strong>
        {props.body ? <span className="sh-muted">{props.body}</span> : null}
      </span>
    </span>
  );
}

export const HoverCard = austereComponent({
  name: "HoverCard",
  group: "Content",
  tier: "extended",
  props: z.object({ text: z.string(), title: z.string(), body: z.string().optional() }),
  description: "Inline text that shows a small card (title and a line or two of body) on hover or focus, e.g. a person or a service.",
  renderer: HoverCardView,
  example: `svc = HoverCard("billing-api", "billing-api", "Owns invoices and refunds. On call: payments team.")`,
});
