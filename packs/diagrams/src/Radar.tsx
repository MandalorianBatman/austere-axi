import React from "react";
import { z } from "zod";
import { austereComponent, DiagramFrame } from "austere-axi/pack";
import type { RendererArgs } from "austere-axi/pack";
import { RADAR, buildRadar } from "./_quantity-model.ts";
import { T } from "./_shape-view.tsx";
import { useProblems } from "./_matrix-view.tsx";
import guide from "./Radar.md";

const nothing = () => null;

export const RadarSeries = austereComponent({
  name: "RadarSeries",
  group: "Diagrams",
  tier: "extended",
  props: z.object({
    name: z.string(),
    values: z.array(z.union([z.number(), z.string(), z.null()])),
    focus: z.boolean().optional(),
  }),
  description:
    "One entity of a Radar: its name and one score for each label, in label order (same scale for all). focus marks the one entity to stress (one only). Click target: its polygon and its legend entry.",
  renderer: nothing,
  slots: null,
  tagged: false,
});

type RadarProps = { labels?: unknown; series?: unknown; max?: unknown; unit?: unknown };

function RadarView({ props, statementId }: RendererArgs<RadarProps>) {
  const model = React.useMemo(() => buildRadar(props), [props]);
  useProblems(model.problems, "radar", "Radar", statementId);
  return (
    <DiagramFrame className="dg-radar" name="Radar chart">
      {() => {
        if (model.axes.length < 3 || !model.series.length) {
          return {
            error: (
              <div className="austere-render-error">
                <strong>
                  Radar needs {model.axes.length < 3 ? "3 or more labels" : "one RadarSeries"}.
                </strong>{" "}
                Pass the criteria as labels, then a RadarSeries for each entity.
              </div>
            ),
          };
        }
        const { cx, cy } = RADAR;
        const ordered = [...model.series].sort((a, b) => Number(a.focus) - Number(b.focus));
        const pts = (list: [number, number][]) => list.map((p) => `${p[0]},${p[1]}`).join(" ");
        return {
          width: RADAR.w,
          caption: (
            <ul className="dg-rd-legend" aria-label="Entities">
              {model.series.map((s) => (
                <li
                  key={s.id}
                  className={`c-${s.index % 5}${s.focus ? " is-focal" : ""}`}
                  data-oui-id={s.named ? s.id : undefined}
                  data-oui-c={s.named ? "RadarSeries" : undefined}
                >
                  <i className="dg-rd-swatch" aria-hidden="true" />
                  <span data-austere-part={s.part}>{s.name}</span>
                </li>
              ))}
              <li className="dg-rd-scale">
                Scale 0 to {model.rings[4].text}
                {model.unit ? ` ${model.unit}` : ""}; the outer ring is the best score.
              </li>
            </ul>
          ),
          content: (
            <svg
              className="dg-rd-svg"
              viewBox={`0 0 ${RADAR.w} ${RADAR.h}`}
              role="img"
              aria-label={`Radar chart of ${model.series.map((s) => s.name).join(", ")} on ${model.axes.map((a) => a.label).join(", ")}`}
            >
              {model.rings.map((ring, i) => (
                <polygon
                  key={i}
                  className={`dg-rd-ring${i === 4 ? " is-outer" : ""}`}
                  points={pts(ring.points)}
                />
              ))}
              {model.axes.map((a, i) => (
                <line key={i} className="dg-rd-spoke" x1={cx} y1={cy} x2={a.sx} y2={a.sy} />
              ))}
              {model.rings.map((ring, i) => (
                <T
                  key={i}
                  className="dg-rd-tick"
                  x={cx - 5}
                  y={ring.points[0][1] + 11}
                  textAnchor="end"
                >
                  {ring.text}
                </T>
              ))}
              {model.axes.map((a, i) => (
                <T key={i} className="dg-rd-axis" x={a.lx} y={a.ly} textAnchor={a.anchor}>
                  {a.name}
                </T>
              ))}
              {ordered.map((s) => (
                <g
                  key={s.id}
                  className={`dg-rd-series c-${s.index % 5}${s.focus ? " is-focal" : ""}`}
                  data-oui-id={s.named ? s.id : undefined}
                  data-oui-c={s.named ? "RadarSeries" : undefined}
                >
                  <polygon className="dg-rd-hit" points={pts(s.points)} data-austere-part={s.part}>
                    <title>{s.part}</title>
                  </polygon>
                  <polygon
                    className="dg-rd-shape"
                    points={pts(s.points)}
                    data-austere-part={s.part}
                  >
                    <title>{s.part}</title>
                  </polygon>
                  {s.focus
                    ? s.points.map((p, i) => (
                        <circle key={i} className="dg-rd-dot" cx={p[0]} cy={p[1]} r={4} />
                      ))
                    : null}
                </g>
              ))}
            </svg>
          ),
        };
      }}
    </DiagramFrame>
  );
}

export const Radar = austereComponent({
  name: "Radar",
  group: "Diagrams",
  tier: "extended",
  family: "Quantity",
  keywords: [
    "radar",
    "spider",
    "web chart",
    "scorecard",
    "capability matrix",
    "evaluation",
    "criteria",
    "compare options",
    "shape of each option",
  ],
  guide,
  limits: [
    {
      prop: "labels",
      max: 5,
      message: "Radar: 5 criteria at most. Split the criteria into two charts, or use a Table.",
    },
    {
      prop: "series",
      max: 5,
      message: "Radar: 5 entities at most. Split into two charts, or use a Table.",
    },
  ],
  props: z.object({
    labels: z.array(z.string()),
    series: z.array(RadarSeries.definition.ref),
    max: z.number().optional(),
    unit: z.string().optional(),
  }),
  description:
    "Several entities scored on the same 3 to 5 criteria: labels (one word each), then one RadarSeries for each entity, with a score for each label on one scale from 0. max sets the outer ring; unit follows numbers. One entity may be the focus. Click target: each entity.",
  renderer: RadarView,
  example: [
    `backends = Radar(["Latency", "Cost", "Durability", "Ops", "Ecosystem"], [rdA, rdB, rdC])
rdA = RadarSeries("MinIO", [9, 8, 9, 6, 7], true)
rdB = RadarSeries("S3", [7, 5, 10, 9, 10])
rdC = RadarSeries("Ceph", [6, 7, 9, 3, 6])`,
    `frameworks = Radar(["Speed", "Docs", "Hiring", "Tooling"], [rfA, rfB, rfC], 10)
rfA = RadarSeries("Next.js", [7, 9, 9, 8])
rfB = RadarSeries("Remix", [8, 7, 6, 7])
rfC = RadarSeries("Astro", [9, 8, 5, 7])`,
  ],
  stress: [
    `stressRadar = Radar(["CRITERION_WITH_A_VERY_LONG_UNBROKEN_NAME_THAT_MUST_BE_CUT_AT_THE_EDGE", "支払いの確認", "Ops", "Cost", "Zero"], [rsA, rsB, rsC, rsD, rsE])
rsA = RadarSeries("ENTITY_WITH_A_VERY_LONG_UNBROKEN_NAME_THAT_MUST_BE_CUT_AT_THE_EDGE", [10, 10, 10, 10, 0], true)
rsB = RadarSeries("支払い", [1, 2, 3, 4, 5])
rsC = RadarSeries("Flat", [5, 5, 5, 5, 5])
rsD = RadarSeries("Tiny", [0.001, 0.002, 0.001, 0.002, 0.001])
rsE = RadarSeries("Spiky", [10, 0, 10, 0, 10])`,
    `stressTriangle = Radar(["A", "B", "C"], [rtA])
rtA = RadarSeries("Solo", [100, 50, 0])`,
  ],
});

export default [Radar, RadarSeries];
