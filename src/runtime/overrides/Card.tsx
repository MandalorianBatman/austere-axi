import React from "react";
import type { ComponentRenderProps } from "@openuidev/react-lang";
import { Card } from "@openuidev/react-ui/Card";
import type * as UI from "@openuidev/react-ui";

// The subpath's declarations re-export "./Card" without an extension, which
// NodeNext resolution cannot follow; name its export from the package root.
declare module "@openuidev/react-ui/Card" {
  export const Card: typeof UI.Card;
}

/** A child as the parser hands it over; CardHeader(title, subtitle) is the one read here. */
interface ChildNode {
  typeName?: string;
  props?: { title?: unknown; subtitle?: unknown };
}

export interface CardProps {
  children?: unknown;
  variant?: "card" | "sunk" | "clear";
  direction?: "row" | "column";
  gap?: string;
  align?: string;
  justify?: string;
  wrap?: boolean;
}

// The stock genui-lib Card's layout, unchanged: its flex params map to these.
const GAP: Record<string, string> = {
  none: "0",
  xs: "var(--openui-space-xs)",
  s: "var(--openui-space-s)",
  m: "var(--openui-space-m)",
  l: "var(--openui-space-l)",
  xl: "var(--openui-space-xl)",
  "2xl": "var(--openui-space-2xl)",
};
const ALIGN: Record<string, string> = { start: "flex-start", center: "center", end: "flex-end", stretch: "stretch", baseline: "baseline" };
const JUSTIFY: Record<string, string> = {
  start: "flex-start",
  center: "center",
  end: "flex-end",
  between: "space-between",
  around: "space-around",
  evenly: "space-evenly",
};

// Fold state by statement name, so a live update that re-mounts or reorders cards keeps
// what the reviewer folded.
const foldedIds = new Set<string>();

/** The leading CardHeader when it has a title to stand for the folded card. */
function titledHeader(children: unknown[]): ChildNode | undefined {
  const first = children[0] as ChildNode | null | undefined;
  return first?.typeName === "CardHeader" && first.props?.title ? first : undefined;
}

// The stock Card, plus a fold for the reviewer: a column Card that opens with a titled
// CardHeader and has more after it gets a chevron button beside the title. Cards start open;
// folded, only the header shows. The body stays in the DOM as hidden="until-found", so
// find-in-page reaches it (and unfolds it), and so does the annotation layer's reveal. A row
// Card keeps the stock layout (its header is one cell of the row). The agent writes nothing
// new: same props, no prompt text.
export function FoldableCardRenderer({ props, renderNode, statementId }: ComponentRenderProps<CardProps>) {
  const children = Array.isArray(props.children) ? props.children : [];
  const header = children.length > 1 && props.direction !== "row" ? titledHeader(children) : undefined;
  const [folded, setFolded] = React.useState(() => !!statementId && foldedIds.has(statementId));
  const bodyRef = React.useRef<HTMLDivElement>(null);

  // React only writes hidden as a boolean, so "until-found" is set by hand. The browser
  // removes it on a find-in-page match and fires beforematch, which unfolds the card.
  React.useLayoutEffect(() => {
    const body = bodyRef.current;
    if (!body) return;
    if (folded) body.setAttribute("hidden", "until-found");
    else body.removeAttribute("hidden");
    if (statementId) {
      if (folded) foldedIds.add(statementId);
      else foldedIds.delete(statementId);
    }
    const unfold = () => setFolded(false);
    body.addEventListener("beforematch", unfold);
    return () => body.removeEventListener("beforematch", unfold);
  }, [folded, statementId, header]);

  const style: React.CSSProperties = {
    flex: 1,
    minWidth: 0,
    display: "flex",
    flexDirection: props.direction || "column",
    flexWrap: props.wrap ? "wrap" : "nowrap",
    gap: GAP[props.gap || "m"] || GAP.m,
    alignItems: ALIGN[props.align || "stretch"] || "stretch",
    justifyContent: JUSTIFY[props.justify || "start"] || "flex-start",
  };

  if (!header) {
    return (
      <Card variant={props.variant ?? "card"} width="full" style={style}>
        {renderNode(props.children)}
      </Card>
    );
  }

  const label = String(header.props?.title);
  return (
    <Card variant={props.variant ?? "card"} width="full" style={style}>
      <div className="austere-card-head">
        {renderNode(header)}
        <button
          type="button"
          className="austere-card-fold"
          aria-expanded={!folded}
          aria-label={label}
          onClick={() => setFolded(!folded)}
        >
          <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
            <path d="M4 6l4 4 4-4" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
      </div>
      <div ref={bodyRef} className="austere-card-body">
        {renderNode(children.slice(1))}
      </div>
    </Card>
  );
}
