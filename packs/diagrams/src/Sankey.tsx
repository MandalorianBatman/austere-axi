import React from "react";
import { z } from "zod";
import { austereComponent, DiagramFrame } from "austere-axi/pack";
import type { RendererArgs } from "austere-axi/pack";
import { PHONE_ROOM, SK, SK_PHONE, buildSankey } from "./_quantity-model.ts";
import { T } from "./_shape-view.tsx";
import { useProblems } from "./_matrix-view.tsx";
import guide from "./Sankey.md";

type SankeyProps = {
  sources?: unknown;
  targets?: unknown;
  values?: unknown;
  unit?: unknown;
  focus?: unknown;
};

function SankeyView({ props, statementId }: RendererArgs<SankeyProps>) {
  const base = React.useMemo(() => buildSankey(props), [props]);
  useProblems(base.problems, "sankey", "Sankey", statementId);
  return (
    <DiagramFrame className="dg-sankey" name="Sankey diagram">
      {({ room, full }) => {
        const phone = !full && room < PHONE_ROOM;
        const model = phone ? buildSankey(props, true) : base;
        const bar = phone ? SK_PHONE.bar : SK.bar;
        if (model.layers < 2 || !model.flows.length) {
          return {
            error: (
              <div className="austere-render-error">
                <strong>Sankey has no flows to draw.</strong> Pass the sources, the targets and one
                value above 0 for each flow.
              </div>
            ),
          };
        }
        return {
          width: model.w,
          caption: (
            <p className="dg-note">
              Band width is the amount, on one scale for every band and bar. Flow runs left to
              right.
            </p>
          ),
          content: (
            <svg
              className="dg-sk-svg"
              viewBox={`0 0 ${model.w} ${model.h}`}
              role="img"
              aria-label={`Sankey diagram: ${model.flows.map((f) => f.part).join("; ")}`}
            >
              {model.flows
                .slice()
                .sort((a, b) => Number(a.focus) - Number(b.focus))
                .map((f, i) => (
                  <path
                    key={i}
                    className={`dg-sk-band${f.focus ? " is-focal" : ""}`}
                    d={f.d}
                    data-austere-part={f.part}
                  >
                    <title>{f.part}</title>
                  </path>
                ))}
              {model.nodes.map((n) => {
                const x = n.side === "left" ? n.x - 8 : n.x + bar + 8;
                const anchor = n.side === "left" ? "end" : "start";
                const y = n.y + n.h / 2 - (n.lines.length === 2 ? 2 : 0);
                return (
                  <g key={n.id} className={`dg-sk-node${n.focus ? " is-focal" : ""}`}>
                    <rect
                      className="dg-sk-bar"
                      x={n.x}
                      y={n.y}
                      width={bar}
                      height={n.h}
                      data-austere-part={n.part}
                    >
                      <title>{n.part}</title>
                    </rect>
                    {n.lines.map((line, k) => (
                      <T
                        key={k}
                        className={`dg-sk-${line.cls}`}
                        x={x}
                        y={y + k * 15}
                        textAnchor={anchor}
                        data-austere-part={k === 0 ? n.part : undefined}
                      >
                        {line.text}
                      </T>
                    ))}
                  </g>
                );
              })}
            </svg>
          ),
        };
      }}
    </DiagramFrame>
  );
}

export default austereComponent({
  name: "Sankey",
  group: "Diagrams",
  tier: "extended",
  family: "Quantity",
  keywords: [
    "sankey",
    "flow",
    "flow of quantity",
    "split and merge",
    "allocation",
    "where does it go",
    "budget flow",
    "compute budget",
    "energy flow",
    "volume flow",
  ],
  guide,
  limits: [
    {
      prop: "values",
      max: 12,
      message: "Sankey: 12 flows at most. Split into two linked Sankeys, or merge the small flows.",
    },
  ],
  props: z.object({
    sources: z.array(z.string()),
    targets: z.array(z.string()),
    values: z.array(z.union([z.number(), z.string(), z.null()])),
    unit: z.string().optional(),
    focus: z.string().optional(),
  }),
  description:
    "A quantity that splits and merges across stages: one flow for each position in sources, targets and values (same length). Stages follow the flows left to right; band width is the amount. unit follows numbers; focus names a node to stress. Click target: each band and node.",
  renderer: SankeyView,
  example: [
    `ciBudget = Sankey(["CI minutes", "CI minutes", "CI minutes", "Unit tests", "Unit tests", "E2E", "E2E", "E2E", "Build"], ["Unit tests", "E2E", "Build", "Passed", "Failed", "Passed", "Failed", "Flaked", "Passed"], [5200, 4000, 2800, 4700, 500, 2600, 400, 1000, 2800], "min", "Flaked")`,
    `hiring = Sankey(["Applied", "Applied", "Screened", "Screened"], ["Screened", "Not screened", "Onsite", "Failed screen"], [400, 600, 90, 310], "people")`,
  ],
  stress: [
    `stressSankey = Sankey(["SOURCE_WITH_A_VERY_LONG_UNBROKEN_NAME_THAT_MUST_BE_CUT_AT_THE_EDGE", "SOURCE_WITH_A_VERY_LONG_UNBROKEN_NAME_THAT_MUST_BE_CUT_AT_THE_EDGE", "支払いの確認", "支払いの確認", "Mid"], ["支払いの確認", "Mid", "Out A", "TARGET_WITH_A_VERY_LONG_UNBROKEN_NAME_THAT_MUST_BE_CUT_AT_THE_EDGE", "Out A"], [1234567, 3, 700000, 534567, 3], "bytes", "Mid")`,
    `stressDense = Sankey(["S1", "S1", "S2", "S2", "S3", "S3", "M1", "M1", "M2", "M2", "M3", "M3"], ["M1", "M2", "M2", "M3", "M1", "M3", "T1", "T2", "T2", "T3", "T1", "T3"], [5, 3, 4, 6, 2, 1, 4, 3, 2, 5, 3, 4])`,
  ],
});
