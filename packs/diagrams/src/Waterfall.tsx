import React from "react";
import { z } from "zod";
import { austereComponent, DiagramFrame } from "austere-axi/pack";
import type { RendererArgs } from "austere-axi/pack";
import { WF, buildWaterfall } from "./_quantity-model.ts";
import { T } from "./_shape-view.tsx";
import { useProblems } from "./_matrix-view.tsx";
import guide from "./Waterfall.md";

type WaterfallProps = {
  labels?: unknown;
  values?: unknown;
  unit?: unknown;
  focus?: unknown;
  subtotal?: unknown;
};

function WaterfallView({ props, statementId }: RendererArgs<WaterfallProps>) {
  const model = React.useMemo(() => buildWaterfall(props), [props]);
  useProblems(model.problems, "waterfall", "Waterfall", statementId);
  return (
    <DiagramFrame className="dg-waterfall" name="Waterfall chart">
      {() => {
        if (!model.bars.length) {
          return {
            error: (
              <div className="austere-render-error">
                <strong>Waterfall needs a start, an end and numbers.</strong> Pass the labels, then
                one value for each: the start total, the signed steps, the end total.
              </div>
            ),
          };
        }
        const axisX = WF.left - 6;
        const rightEdge = model.w - WF.right;
        return {
          width: model.w,
          caption: (
            <p className="dg-note">
              Filled bars rise, hollow bars fall; totals stand on the baseline. A line carries the
              running total from one bar to the next.
            </p>
          ),
          content: (
            <svg
              className="dg-wf-svg"
              viewBox={`0 0 ${model.w} ${model.h}`}
              role="img"
              aria-label={`Waterfall: ${model.bars.map((b) => `${b.label} ${b.valueText}`).join(", ")}`}
            >
              {model.ticks.map((t, i) => (
                <g key={i}>
                  <line className="dg-wf-grid" x1={axisX} x2={rightEdge} y1={t.y} y2={t.y} />
                  <T className="dg-wf-tick" x={axisX - 6} y={t.y + 4} textAnchor="end">
                    {t.text}
                  </T>
                </g>
              ))}
              <line
                className="dg-wf-base"
                x1={axisX}
                x2={rightEdge}
                y1={model.zeroY}
                y2={model.zeroY}
              />
              {model.carries.map((c, i) => (
                <line key={i} className="dg-wf-carry" x1={c.x1} x2={c.x2} y1={c.y} y2={c.y} />
              ))}
              {model.bars.map((b, i) => (
                <g key={i} className={`dg-wf-bar k-${b.kind}${b.focus ? " is-focal" : ""}`}>
                  <rect
                    className="dg-wf-rect"
                    x={b.x}
                    y={b.y}
                    width={WF.bar}
                    height={b.h}
                    rx={2}
                    data-austere-part={b.part}
                  >
                    <title>{b.part}</title>
                  </rect>
                  <T className="dg-wf-value" x={b.cx} y={b.valueY} textAnchor="middle">
                    {b.valueText}
                  </T>
                  {b.lines.map((line, k) => (
                    <T
                      key={k}
                      className="dg-wf-label"
                      x={b.cx}
                      y={WF.top + WF.plot + 22 + k * 15}
                      textAnchor="middle"
                      data-austere-part={k === 0 ? b.part : undefined}
                    >
                      {line}
                    </T>
                  ))}
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
  name: "Waterfall",
  group: "Diagrams",
  tier: "extended",
  family: "Quantity",
  keywords: [
    "waterfall",
    "bridge",
    "walk",
    "budget bridge",
    "p&l",
    "variance",
    "running total",
    "start to end",
    "headcount change",
    "contributions",
  ],
  guide,
  limits: [
    {
      prop: "labels",
      max: 8,
      message: 'Waterfall: 8 bars at most. Merge the small steps into one "Other" step.',
    },
  ],
  props: z.object({
    labels: z.array(z.string()),
    values: z.array(z.union([z.number(), z.string(), z.null()])),
    unit: z.string().optional(),
    focus: z.string().optional(),
    subtotal: z.string().optional(),
  }),
  description:
    "How a start total becomes an end total: labels, then values. First is the start total, last the end total, between are signed steps (-38 falls); the page checks they add up. unit follows numbers; focus labels a step to stress; subtotal a middle total. Click target: each bar.",
  renderer: WaterfallView,
  example: [
    `headcount = Waterfall(["FY25 roster", "Hires", "Transfers in", "Attrition", "FY26 roster"], [240, 64, 12, -38, 278], "people", "Attrition")`,
    `budget = Waterfall(["FY25 plan", "Cloud", "Licences", "Contractors", "Mid-year", "Savings", "Travel", "FY26 plan"], [1.2, 0.35, 0.1, -0.15, 1.5, -0.2, 0.05, 1.35], "M USD", "Savings", "Mid-year")`,
  ],
  stress: [
    `stressWaterfall = Waterfall(["START_TOTAL_WITH_A_VERY_LONG_UNBROKEN_NAME_THAT_MUST_BE_CUT", "支払いの確認", "Rises", "Big rise", "Falls a lot", "END_TOTAL_WITH_A_VERY_LONG_UNBROKEN_NAME_THAT_MUST_BE_CUT"], [1234567.5, 400000, 12, 1000000, -9999999, -7365419.5], "USD", "Falls a lot")`,
    `stressBelowZero = Waterfall(["Start", "Big loss", "Recovery", "Churn", "Upsell", "End"], [100, -150, 40, -30, 25, -15], "k")`,
  ],
});
