import React from "react";
import { z } from "zod";
import { austereComponent, DiagramFrame } from "austere-axi/pack";
import type { RendererArgs } from "austere-axi/pack";
import { PHONE_ROOM, buildPolar } from "./_quantity-model.ts";
import { T } from "./_shape-view.tsx";
import { useProblems } from "./_matrix-view.tsx";
import guide from "./PolarChart.md";

type PolarProps = {
  labels?: unknown;
  values?: unknown;
  unit?: unknown;
  focus?: unknown;
  max?: unknown;
};

function PolarView({ props, statementId }: RendererArgs<PolarProps>) {
  const model = React.useMemo(() => buildPolar(props), [props]);
  useProblems(model.problems, "polar", "PolarChart", statementId);
  return (
    <DiagramFrame className="dg-polar" name="Polar chart">
      {({ room }) => {
        const view = room < PHONE_ROOM ? buildPolar(props, true) : model;
        if (model.categories.length < 3) {
          return {
            error: (
              <div className="austere-render-error">
                <strong>PolarChart needs 3 or more categories.</strong> Pass the labels, in their
                circular order, then one value for each.
              </div>
            ),
          };
        }
        const { cx, cy, R } = view.geo;
        const peak = view.categories.reduce(
          (best, c) => ((c.value ?? -1) > (best.value ?? -1) ? c : best),
          view.categories[0],
        );
        return {
          width: view.geo.w,
          caption: (
            <p className="dg-note">
              Ray length is the value, from 0 at the centre to {view.rings[4].text}
              {view.unit ? ` ${view.unit}` : ""} at the outer ring. Categories run clockwise from
              the top.
            </p>
          ),
          content: (
            <svg
              className="dg-pl-svg"
              viewBox={`0 0 ${view.geo.w} ${view.geo.h}`}
              role="img"
              aria-label={`Polar chart, clockwise from the top: ${view.categories.map((c) => `${c.label} ${c.valueText}`).join(", ")}. Largest: ${peak.label}.`}
            >
              {view.rings.map((ring, i) => (
                <circle
                  key={i}
                  className={`dg-pl-ring${i === 4 ? " is-outer" : ""}`}
                  cx={cx}
                  cy={cy}
                  r={ring.r}
                />
              ))}
              {view.categories.map((c, i) => (
                <line key={`s${i}`} className="dg-pl-spoke" x1={cx} y1={cy} x2={c.sx} y2={c.sy} />
              ))}
              {view.rings.map((ring, i) => (
                <T
                  key={`t${i}`}
                  className="dg-pl-tick"
                  x={cx - 5}
                  y={cy - ring.r + 11}
                  textAnchor="end"
                >
                  {ring.text}
                </T>
              ))}
              {view.categories.map((c, i) => (
                <g key={`c${i}`} className={`dg-pl-cat${c.focus ? " is-focal" : ""}`}>
                  <line
                    className="dg-pl-hit"
                    x1={cx}
                    y1={cy}
                    x2={c.sx}
                    y2={c.sy}
                    data-austere-part={c.part}
                  >
                    <title>{c.part}</title>
                  </line>
                  {c.value ? (
                    <>
                      <line
                        className="dg-pl-ray"
                        x1={cx}
                        y1={cy}
                        x2={c.x}
                        y2={c.y}
                        data-austere-part={c.part}
                      >
                        <title>{c.part}</title>
                      </line>
                      <circle className="dg-pl-end" cx={c.x} cy={c.y} r={c.focus ? 5 : 4} />
                    </>
                  ) : null}
                  <T
                    className="dg-pl-name"
                    x={c.lx}
                    y={c.ly}
                    textAnchor={c.anchor}
                    data-austere-part={c.part}
                  >
                    {c.name}
                  </T>
                  <T className="dg-pl-value" x={c.lx} y={c.ly + 14} textAnchor={c.anchor}>
                    {c.valueText}
                  </T>
                </g>
              ))}
            </svg>
          ),
        };
      }}
    </DiagramFrame>
  );
}

export default austereComponent({
  name: "PolarChart",
  group: "Diagrams",
  tier: "extended",
  family: "Quantity",
  keywords: [
    "polar",
    "polar chart",
    "radial",
    "cyclic",
    "clock",
    "by hour",
    "by month",
    "seasonal",
    "daily pattern",
    "wheel",
  ],
  guide,
  limits: [
    {
      prop: "labels",
      max: 8,
      message: "PolarChart: 8 categories at most. Use a LineChart for more ordered buckets.",
    },
  ],
  props: z.object({
    labels: z.array(z.string()),
    values: z.array(z.union([z.number(), z.string(), z.null()])),
    unit: z.string().optional(),
    focus: z.string().optional(),
    max: z.number().optional(),
  }),
  description:
    'One series across categories in a cycle (hours, months, weekdays): labels, then one value for each, as the length of a ray from the centre. unit ("%") follows the numbers; focus is the label of the one ray to stress; max sets the outer ring. Click target: each ray.',
  renderer: PolarView,
  example: [
    `demand = PolarChart(["00–03", "03–06", "06–09", "09–12", "12–15", "15–18", "18–21", "21–24"], [32, 18, 24, 58, 100, 82, 76, 45], "%", "12–15")`,
    `incidents = PolarChart(["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"], [14, 9, 11, 7, 21, 3, 0], "incidents")`,
  ],
  stress: [
    `stressPolar = PolarChart(["LABEL_WITH_A_VERY_LONG_UNBROKEN_NAME_THAT_MUST_BE_CUT_AT_THE_EDGE", "支払いの確認", "C", "D", "E", "F", "G", "Zero"], [1234567.891, 5, 998877, 0.001, 42, 7, 1000000, 0], "ms", "支払いの確認")`,
    `stressSpread = PolarChart(["A", "B", "C", "D", "E", "F", "G", "H"], [0.000001, 1000000000, 0, 7, 7, 7, 3, 999999999], "units")`,
  ],
});
