import React from "react";
import { z } from "zod";
import { austereComponent, DiagramFrame } from "austere-axi/pack";
import type { RendererArgs } from "austere-axi/pack";
import { QUAD, buildQuadrant } from "./_shape-model.ts";
import type { QuadItem } from "./_shape-model.ts";
import { Hit, T } from "./_shape-view.tsx";
import { useProblems } from "./_matrix-view.tsx";
import guide from "./Quadrant.md";

const nothing = () => null;

export const QuadrantItem = austereComponent({
  name: "QuadrantItem",
  group: "Diagrams",
  tier: "extended",
  props: z.object({
    label: z.string(),
    x: z.number(),
    y: z.number(),
    focus: z.boolean().optional(),
  }),
  description:
    "One item in a Quadrant. x is across (0 left to 100 right), y is up (0 bottom to 100 top). focus marks the one to do first (one item only). Click target: its dot and label.",
  renderer: nothing,
  slots: null,
  tagged: false,
});

type QuadrantProps = { items?: unknown; xAxis?: unknown; yAxis?: unknown; quadrants?: unknown };

function ItemView({ item }: { item: QuadItem }) {
  const w = item.shown.length * 7 + 8;
  const left =
    item.anchor === "start" ? item.lx : item.anchor === "end" ? item.lx - w : item.lx - w / 2;
  return (
    <g
      className={`dg-qd-item${item.focus ? " is-focal" : ""}`}
      data-oui-id={item.named ? item.id : undefined}
      data-oui-c={item.named ? "QuadrantItem" : undefined}
    >
      <title>{`${item.label} (x ${item.x}, y ${item.y})`}</title>
      <g data-austere-part={item.label}>
        <Hit
          x0={Math.min(item.px - 9, left)}
          y0={item.ly - 13}
          x1={Math.max(item.px + 9, left + w)}
          y1={item.ly + 6}
        />
        <circle className="dg-qd-dot" cx={item.px} cy={item.py} r={5} />
        <T className="dg-qd-label" x={item.lx} y={item.ly} textAnchor={item.anchor}>
          {item.shown}
        </T>
      </g>
    </g>
  );
}

function QuadrantView({ props, statementId }: RendererArgs<QuadrantProps>) {
  const model = React.useMemo(() => buildQuadrant(props), [props]);
  useProblems(model.problems, "quadrant", "Quadrant", statementId);
  const { x0, x1, y0, y1, w, h } = QUAD;
  const cx = (x0 + x1) / 2;
  const cy = (y0 + y1) / 2;
  return (
    <DiagramFrame className="dg-quadrant" name="Quadrant">
      {() => {
        if (!model.items.length) {
          return {
            error: (
              <div className="austere-render-error">
                <strong>Quadrant has no items.</strong> List the QuadrantItem statements, each with
                an x and a y from 0 to 100.
              </div>
            ),
          };
        }
        return {
          width: w,
          content: (
            <svg
              className="dg-qd-svg"
              viewBox={`0 0 ${w} ${h}`}
              role="img"
              aria-label={`Quadrant of ${model.yAxis || "y"} against ${model.xAxis || "x"}: ${model.items.map((i) => i.label).join(", ")}`}
            >
              <rect className="dg-qd-plot" x={x0} y={y0} width={x1 - x0} height={y1 - y0} />
              <line className="dg-qd-axis" x1={x0} y1={cy} x2={x1 - 6} y2={cy} />
              <line className="dg-qd-axis" x1={cx} y1={y1} x2={cx} y2={y0 + 6} />
              <polygon
                className="dg-qd-tip"
                points={`${x1 - 12},${cy - 5} ${x1},${cy} ${x1 - 12},${cy + 5}`}
              />
              <polygon
                className="dg-qd-tip"
                points={`${cx - 5},${y0 + 12} ${cx},${y0} ${cx + 5},${y0 + 12}`}
              />
              <T className="dg-qd-axis-name" x={x1} y={y1 + 24} textAnchor="end">
                {model.xAxis.toUpperCase()}
              </T>
              <T className="dg-qd-axis-name" x={cx} y={y0 - 12} textAnchor="middle">
                {model.yAxis.toUpperCase()}
              </T>
              {model.quadrants.map((name, i) =>
                name ? (
                  <T
                    key={i}
                    className="dg-qd-quadrant"
                    x={i % 2 === 0 ? x0 + 12 : x1 - 12}
                    y={i < 2 ? y0 + 18 : y1 - 10}
                    textAnchor={i % 2 === 0 ? "start" : "end"}
                    data-austere-part={`${["Top left", "Top right", "Bottom left", "Bottom right"][i]} quadrant: ${name}`}
                  >
                    {name.toUpperCase()}
                  </T>
                ) : null,
              )}
              {model.items.map((item) => (
                <ItemView key={item.id} item={item} />
              ))}
            </svg>
          ),
        };
      }}
    </DiagramFrame>
  );
}

export const Quadrant = austereComponent({
  name: "Quadrant",
  group: "Diagrams",
  tier: "extended",
  family: "Shapes",
  keywords: [
    "quadrant",
    "2x2",
    "two by two",
    "matrix",
    "impact effort",
    "prioritization",
    "priority",
    "positioning",
    "portfolio map",
    "decision frame",
    "eisenhower",
    "urgent important",
  ],
  guide,
  limits: [
    {
      prop: "items",
      max: 12,
      message: "Quadrant: 12 items at most. Cluster the small ones, or split into two quadrants.",
    },
  ],
  props: z.object({
    items: z.array(QuadrantItem.definition.ref),
    xAxis: z.string(),
    yAxis: z.string(),
    quadrants: z.array(z.string()).optional(),
  }),
  description:
    'Two named axes and four quadrants, items placed by x and y (0 to 100). xAxis and yAxis are one word each ("Effort"). quadrants: 4 names, top left, top right, bottom left, bottom right. Labels never overlap. Each QuadrantItem is a click target.',
  renderer: QuadrantView,
  example: [
    `impactMap = Quadrant([qxA, qxB, qxC], "Effort", "Impact")
qxA = QuadrantItem("Cache the lookup", 20, 80)
qxB = QuadrantItem("Rewrite the parser", 85, 70)
qxC = QuadrantItem("Rename the flags", 30, 20)`,
    `roadmapGrid = Quadrant([rmA, rmB, rmC, rmD, rmE, rmF], "Effort", "Impact", ["Quick wins", "Big bets", "Fill-ins", "Drop"])
rmA = QuadrantItem("Retry on 502", 15, 85, true)
rmB = QuadrantItem("Single sign-on", 80, 90)
rmC = QuadrantItem("Dark mode", 35, 30)
rmD = QuadrantItem("Multi-region", 92, 60)
rmE = QuadrantItem("Typo sweep", 8, 12)
rmF = QuadrantItem("Rebuild the editor", 78, 22)`,
  ],
  stress: [
    `stressQuad = Quadrant([sqA, sqB, sqC, sqD, sqE, sqF, sqG, sqH], "AN_AXIS_NAME_WITH_NO_BREAKS_AT_ALL_THAT_GOES_ON", "支払い", ["A_QUADRANT_NAME_WITH_NO_BREAKS_AT_ALL_THAT_GOES_ON_AND_ON", "", "Third", "支払いの確認"])
sqA = QuadrantItem("ITEM_WITH_A_VERY_LONG_UNBROKEN_NAME_THAT_MUST_BE_CUT_AT_THE_EDGE", 8, 82)
sqB = QuadrantItem("A long human readable item name that needs the room it can get", 70, 70)
sqC = QuadrantItem("支払いの確認", 95, 95, true)
sqD = QuadrantItem("Edge of the plot", 1, 40)
sqE = QuadrantItem("Bottom right corner", 90, 16)
sqF = QuadrantItem("F", 20, 20)
sqG = QuadrantItem("G", 30, 28)
sqH = QuadrantItem("H", 60, 35)`,
  ],
});

export default [Quadrant, QuadrantItem];
