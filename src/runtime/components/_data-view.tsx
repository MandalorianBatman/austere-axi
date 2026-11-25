// The drawing of ERDiagram and ClassDiagram's parts: a box with a header and one
// row for each line of text, and the mark at each end of a relation. Used by
// `_flow-view.tsx`. Helper, not a component (the file name starts with "_").
import React from "react";
import type { ReactNode, SVGProps } from "react";
import type { EndMark } from "./_data-parse.ts";
import { ROW_H, cut, rowTop } from "./_data-parse.ts";
import type { Point } from "./_architecture-model.ts";
import type { FlowLaidOutNode } from "./_flow-model.ts";

// Every SVG text ends in a space: annotation quotes use textContent, which
// would otherwise run a label and the next one together.
export const T = ({ children, ...rest }: SVGProps<SVGTextElement> & { children?: ReactNode }) => (
  <text {...rest}>{children} </text>
);

const PAD = 12;

/** A box with a name and rows. Each row is its own part, worded as the agent wrote the line. */
export function DataNode({ n, component }: { n: FlowLaidOutNode; component: string }) {
  const d = n.data;
  if (!d) return null;
  const cx = n.x + n.width / 2;
  const right = n.x + n.width;
  return (
    <g
      className={`austere-arch-node austere-flow-node austere-data-node s-${n.shape}${n.tone ? ` t-${n.tone}` : ""}`}
      data-oui-id={n.named ? n.id : undefined}
      data-oui-c={n.named ? component : undefined}
    >
      <title>{n.label}</title>
      <rect
        className="austere-arch-node-box"
        x={n.x}
        y={n.y}
        width={n.width}
        height={n.height}
        rx={6}
      />
      {d.rows.length ? (
        <line
          className="austere-data-rule"
          x1={n.x}
          x2={right}
          y1={n.y + d.headerHeight}
          y2={n.y + d.headerHeight}
        />
      ) : null}
      <g data-austere-part={n.label}>
        <rect
          className="austere-flow-hit"
          x={n.x}
          y={n.y}
          width={n.width}
          height={d.headerHeight}
        />
        <T
          className={`austere-arch-node-label${d.italic ? " is-italic" : ""}`}
          x={cx}
          y={n.y + d.headerHeight - 11}
          textAnchor="middle"
        >
          {d.title}
        </T>
      </g>
      {/* Outside the part, so the quote is the name alone; a click falls through to the header. */}
      {d.stereotype ? (
        <T className="austere-data-stereo" x={cx} y={n.y + 17} textAnchor="middle">
          {d.stereotype}
        </T>
      ) : null}
      {d.rows.map((row, i) => {
        const top = n.y + rowTop(d, i);
        return (
          <g key={i} data-austere-part={row.part}>
            {row.divider ? (
              <line className="austere-data-rule" x1={n.x} x2={right} y1={top - 4} y2={top - 4} />
            ) : null}
            <rect className="austere-flow-hit" x={n.x} y={top} width={n.width} height={ROW_H} />
            <T
              className={row.type || row.marks ? "austere-data-name" : "austere-data-member"}
              x={n.x + PAD}
              y={top + 14}
            >
              {row.main}
            </T>
            {row.type ? (
              <T className="austere-data-type" x={n.x + d.typeX} y={top + 14}>
                {row.type}
              </T>
            ) : null}
            {row.marks ? (
              <T className="austere-data-mark" x={n.x + d.markX} y={top + 14}>
                {row.marks}
              </T>
            ) : null}
          </g>
        );
      })}
    </g>
  );
}

// Each mark is drawn with its tip on the box's edge and the line running away
// along +x; `EndMarkView` turns it to the line's real direction.
const FOOT = "M0,-6L12,0L0,6";
const MARKS: Record<EndMark, ReactNode> = {
  one: <path d="M7,-6V6M11,-6V6" />,
  "zero-one": (
    <>
      <path d="M7,-6V6" />
      <circle className="is-hollow" cx={15} cy={0} r={4} />
    </>
  ),
  many: <path d={FOOT} />,
  "one-many": <path d={`${FOOT}M16,-6V6`} />,
  "zero-many": (
    <>
      <path d={FOOT} />
      <circle className="is-hollow" cx={20} cy={0} r={4} />
    </>
  ),
  triangle: <polygon className="is-hollow" points="0,0 14,-7 14,7" />,
  diamond: <polygon className="is-fill" points="0,0 8,-5 16,0 8,5" />,
  "diamond-open": <polygon className="is-hollow" points="0,0 8,-5 16,0 8,5" />,
  open: <path d="M10,-5L0,0L10,5" />,
};

/** `mark` at `at`, turned toward `toward` (the next point of the line); `text` (a multiplicity) beside it. */
export function EndMarkView({
  mark,
  at,
  toward,
  text,
}: {
  mark: EndMark | "";
  at: Point;
  toward: Point;
  text: string;
}) {
  const dx = toward.x - at.x;
  const dy = toward.y - at.y;
  const len = Math.hypot(dx, dy);
  if (!len || (!mark && !text)) return null;
  const angle = (Math.atan2(dy, dx) * 180) / Math.PI;
  const ux = dx / len;
  const uy = dy / len;
  return (
    <>
      {mark ? (
        <g
          className="austere-data-end"
          transform={`translate(${at.x.toFixed(1)} ${at.y.toFixed(1)}) rotate(${angle.toFixed(1)})`}
        >
          {MARKS[mark]}
        </g>
      ) : null}
      {text ? (
        <T
          className="austere-data-mult"
          x={at.x + ux * 24 - uy * 12}
          y={at.y + uy * 24 + ux * 12 + 3.5}
          textAnchor="middle"
        >
          {cut(text, 10, 44)}
        </T>
      ) : null}
    </>
  );
}
