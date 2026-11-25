// The drawing Flowchart, StateMachine, Tree and OrgChart share: shaped nodes and
// edges in Architecture's look (its CSS classes), each node (and, in graphs,
// each edge) its own click target. Helper, not a component (the file name
// starts with "_").
import React, { useEffect, useId, useMemo } from "react";
import type { ReactNode, SVGProps } from "react";
import type { DiagramContent } from "../../../types/pack.d.ts";
import { reportRuntimeError } from "../env.ts";
import { DiagramFrame } from "./_diagram-frame.ts";
import { DEFAULT_TARGET_WIDTH, edgePath } from "./_architecture-model.ts";
import type { LaidOutEdge } from "./_architecture-model.ts";
import { DOT_BOX, DOT_R, RING_R, buildFlow, layoutFlow } from "./_flow-model.ts";
import type { FlowInput, FlowKind, FlowLaidOutNode, FlowLayout, FlowModel } from "./_flow-model.ts";

// Every SVG text ends in a space: annotation quotes use textContent, which
// would otherwise run a label and the next one together.
const T = ({ children, ...rest }: SVGProps<SVGTextElement> & { children?: ReactNode }) => (
  <text {...rest}>{children} </text>
);

function Shape({ n }: { n: FlowLaidOutNode }) {
  const cx = n.x + n.width / 2;
  const cy = n.y + n.height / 2;
  switch (n.shape) {
    case "initial":
      return <circle className="austere-flow-dot" cx={cx} cy={cy} r={DOT_R} />;
    case "final":
      return (
        <>
          <circle className="austere-flow-ring" cx={cx} cy={cy} r={RING_R} />
          <circle className="austere-flow-dot" cx={cx} cy={cy} r={DOT_R - 2} />
        </>
      );
    case "decision":
      return (
        <polygon
          className="austere-arch-node-box"
          points={`${cx},${n.y} ${n.x + n.width},${cy} ${cx},${n.y + n.height} ${n.x},${cy}`}
        />
      );
    case "start":
    case "end":
      return (
        <rect
          className="austere-arch-node-box"
          x={n.x}
          y={n.y}
          width={n.width}
          height={n.height}
          rx={n.height / 2}
        />
      );
    case "team":
      // A second card behind: a group of people, not one.
      return (
        <>
          <rect
            className="austere-arch-node-box is-behind"
            x={n.x + 5}
            y={n.y + 5}
            width={n.width}
            height={n.height}
            rx={6}
          />
          <rect
            className="austere-arch-node-box"
            x={n.x}
            y={n.y}
            width={n.width}
            height={n.height}
            rx={6}
          />
        </>
      );
    case "agent":
      return (
        <rect
          className="austere-arch-node-box"
          x={n.x}
          y={n.y}
          width={n.width}
          height={n.height}
          rx={Math.min(18, n.height / 2)}
        />
      );
    default:
      return (
        <rect
          className="austere-arch-node-box"
          x={n.x}
          y={n.y}
          width={n.width}
          height={n.height}
          rx={n.shape === "state" ? 8 : 6}
        />
      );
  }
}

function NodeView({ n, component }: { n: FlowLaidOutNode; component: string }) {
  const cx = n.x + n.width / 2;
  const cy = n.y + n.height / 2;
  const dot = n.shape === "initial" || n.shape === "final";
  // Labels centre in the shape; a detail block hangs below the label lines.
  const first = dot
    ? 0
    : n.shape === "decision" || n.shape === "start" || n.shape === "end"
      ? cy - ((n.labelLines.length - 1) * 17) / 2 + 4.5
      : n.y + 25;
  return (
    <g
      className={`austere-arch-node austere-flow-node s-${n.shape}${n.tone ? ` t-${n.tone}` : ""}`}
      data-oui-id={n.named ? n.id : undefined}
      data-oui-c={n.named ? component : undefined}
    >
      <title>{[n.label, n.detail].filter(Boolean).join(" · ")}</title>
      <g data-austere-part={n.label}>
        <Shape n={n} />
        {dot ? (
          // A thumb-sized target around the small mark.
          <rect
            className="austere-flow-hit"
            x={cx - DOT_BOX / 2}
            y={cy - DOT_BOX / 2}
            width={DOT_BOX}
            height={DOT_BOX}
          />
        ) : null}
        {n.labelLines.map((line, i) => (
          <T
            key={i}
            className="austere-arch-node-label"
            x={cx}
            y={first + i * 17}
            textAnchor="middle"
          >
            {line}
          </T>
        ))}
        {n.detailLines.map((line, i) => (
          <T
            key={`d${i}`}
            className="austere-arch-node-detail"
            x={cx}
            y={first + (n.labelLines.length - 1) * 17 + 19 + i * 15}
            textAnchor="middle"
          >
            {line}
          </T>
        ))}
      </g>
    </g>
  );
}

/**
 * A parent link as a right-angle route: down from the parent, across on a bus
 * just above the children, down into the child (or the same turned sideways).
 * A dotted-line link keeps dagre's route, which steers round other boxes.
 */
function hierarchyPath(
  e: LaidOutEdge,
  byId: Map<string, FlowLaidOutNode>,
  rankdir: string,
): string {
  if (e.style !== "solid") return edgePath(e.points);
  const from = byId.get(e.from);
  const to = byId.get(e.to);
  if (!from || !to) return "";
  const f = (v: number) => Math.round(v * 10) / 10;
  if (rankdir === "LR") {
    const x1 = from.x + from.width;
    const x2 = to.x;
    const xm = Math.max(x1 + 8, x2 - 23);
    const y1 = from.y + from.height / 2;
    const y2 = to.y + to.height / 2;
    return `M${f(x1)},${f(y1)}H${f(xm)}V${f(y2)}H${f(x2)}`;
  }
  const y1 = from.y + from.height;
  const y2 = to.y;
  const ym = Math.max(y1 + 8, y2 - 21);
  const x1 = from.x + from.width / 2;
  const x2 = to.x + to.width / 2;
  return `M${f(x1)},${f(y1)}V${f(ym)}H${f(x2)}V${f(y2)}`;
}
function drawing(layout: FlowLayout, uid: string, kind: FlowKind): DiagramContent {
  const byId = new Map(layout.nodes.map((n) => [n.id, n]));
  const nodeComponent = kind.nodeName;
  const edgeComponent = kind.edgeName;
  // Part names: "From → To", plus the answer or event when there is one.
  const partOf = (e: LaidOutEdge) => {
    const base = `${byId.get(e.from)?.label} → ${byId.get(e.to)?.label}`;
    return e.label ? `${base} (${e.label})` : base;
  };
  // A hierarchy has right-angle parent links and no arrowheads; lines are not targets.
  const hierarchy = !!kind.hierarchy;
  const styles = hierarchy ? [] : [...new Set(layout.edges.map((e) => e.style))];
  const content = (
    <svg
      className="austere-arch-svg"
      viewBox={`0 0 ${layout.width} ${layout.height}`}
      role="img"
      aria-label={`${kind.title}: ${layout.nodes.map((n) => n.label).join(", ")}`}
    >
      <defs>
        {styles.map((s) => (
          <marker
            key={s}
            id={`${uid}-${s}`}
            viewBox="0 0 10 10"
            refX="9"
            refY="5"
            markerUnits="userSpaceOnUse"
            markerWidth="9"
            markerHeight="9"
            orient="auto-start-reverse"
          >
            <path d="M0,0L10,5L0,10z" className={`austere-arch-arrow s-${s}`} />
          </marker>
        ))}
      </defs>

      {layout.edges.map((e) => {
        const d = hierarchy ? hierarchyPath(e, byId, layout.rankdir) : edgePath(e.points);
        if (!d) return null;
        return (
          <g
            key={e.id}
            className={`austere-arch-edge s-${e.style}`}
            data-oui-id={e.named ? e.id : undefined}
            data-oui-c={e.named ? edgeComponent : undefined}
          >
            {hierarchy ? null : (
              <path className="austere-arch-edge-hit" d={d} data-austere-part={partOf(e)} />
            )}
            <path
              className="austere-arch-edge-line"
              d={d}
              markerEnd={hierarchy ? undefined : `url(#${uid}-${e.style})`}
            />
          </g>
        );
      })}

      {/* Labels sit above every line so a crossing edge never hides them. */}
      {layout.edges.map((e) => {
        const box = e.labelBox;
        return box ? (
          <g
            key={`el-${e.id}`}
            className={`austere-arch-edge s-${e.style}`}
            data-oui-id={e.named ? e.id : undefined}
            data-oui-c={e.named ? edgeComponent : undefined}
          >
            {box.lines.join(" ") !== e.label ? <title>{e.label}</title> : null}
            <g className="austere-arch-edge-label" data-austere-part={partOf(e)}>
              <rect
                x={box.cx - box.width / 2}
                y={box.cy - box.height / 2}
                width={box.width}
                height={box.height}
                rx="5"
              />
              <text textAnchor="middle">
                {box.lines.map((line, i) => (
                  <tspan key={i} x={box.cx} y={box.cy + 4 + (i - (box.lines.length - 1) / 2) * 13}>
                    {line}{" "}
                  </tspan>
                ))}
              </text>
            </g>
          </g>
        ) : null;
      })}

      {layout.nodes.map((n) => (
        <NodeView key={n.id} n={n} component={nodeComponent} />
      ))}
    </svg>
  );
  return { content, width: layout.width };
}

function errorText(err: unknown): string {
  const message =
    err !== null && typeof err === "object" && "message" in err ? err.message : undefined;
  return String(message || err);
}

// Layout is a pure function of the model and the width, and the frame asks for
// the inline and the Expand view on every render: remember the answers.
type LayoutResult = { layout: FlowLayout | null; error: string | null };
const layoutCache = new WeakMap<FlowModel, Map<number, LayoutResult>>();
function layoutFor(model: FlowModel, width: number): LayoutResult {
  let byWidth = layoutCache.get(model);
  if (!byWidth) layoutCache.set(model, (byWidth = new Map()));
  let hit = byWidth.get(width);
  if (!hit) {
    try {
      hit = { layout: layoutFlow(model, width), error: null };
    } catch (err) {
      hit = { layout: null, error: errorText(err) };
    }
    byWidth.set(width, hit);
  }
  return hit;
}

function LayoutFailed({
  error,
  statementId,
  component,
}: {
  error: string;
  statementId?: string;
  component: string;
}) {
  useEffect(() => {
    reportRuntimeError({
      source: "flow",
      statementId,
      component,
      message: `Layout failed: ${error}`,
    });
  }, [error, statementId, component]);
  return (
    <div className="austere-render-error">
      <strong>Diagram failed to lay out.</strong> {error}
    </div>
  );
}

export function FlowView({
  props,
  statementId,
  kind,
}: {
  props: FlowInput;
  statementId?: string;
  kind: FlowKind;
}) {
  const rawId = useId();
  const uid = `austere-flow-${rawId.replace(/[^a-zA-Z0-9_-]/g, "")}`;
  const model = useMemo(() => buildFlow(props, kind), [props, kind]);

  const problemKey = model.problems.join("\n");
  useEffect(() => {
    for (const message of model.problems) {
      reportRuntimeError({ source: "flow", statementId, component: kind.component, message });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [problemKey, statementId]);

  return (
    <DiagramFrame className="austere-arch austere-flow" name={kind.title}>
      {({ room, full }) => {
        const { layout, error } = layoutFor(model, room || DEFAULT_TARGET_WIDTH);
        if (error) {
          return {
            content: null,
            error: (
              <LayoutFailed error={error} statementId={statementId} component={kind.component} />
            ),
          };
        }
        if (!layout) return null;
        // Expand: as wide as the diagram wants.
        const shown = full ? layoutFor(model, Number.MAX_SAFE_INTEGER).layout : layout;
        return shown ? drawing(shown, uid, kind) : null;
      }}
    </DiagramFrame>
  );
}
