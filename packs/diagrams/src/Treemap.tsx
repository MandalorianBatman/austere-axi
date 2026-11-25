import React from "react";
import { z } from "zod";
import { austereComponent, DiagramFrame } from "austere-axi/pack";
import type { RendererArgs } from "austere-axi/pack";
import { TM, buildTreemap, fmtNum } from "./_quantity-model.ts";
import { T } from "./_shape-view.tsx";
import { useProblems } from "./_matrix-view.tsx";
import guide from "./Treemap.md";

type TreemapProps = {
  labels?: unknown;
  values?: unknown;
  unit?: unknown;
  focus?: unknown;
  groups?: unknown;
};

function TreemapView({ props, statementId }: RendererArgs<TreemapProps>) {
  const model = React.useMemo(() => buildTreemap(props), [props]);
  useProblems(model.problems, "treemap", "Treemap", statementId);
  return (
    <DiagramFrame className="dg-treemap" name="Treemap">
      {() => {
        if (!model.cells.length) {
          return {
            error: (
              <div className="austere-render-error">
                <strong>Treemap has nothing to draw.</strong> Pass the labels, then one number above
                0 for each.
              </div>
            ),
          };
        }
        return {
          width: model.w,
          caption: (
            <>
              <p className="dg-note">
                Area is the value
                {model.unit ? ` (${model.unit})` : ""}; the whole is {fmtNum(model.total)}
                {model.unit ? ` ${model.unit}` : ""}.
                {model.cells.some((c) => c.focus) ? " The outlined cell is the one stressed." : ""}
              </p>
              {model.unlabeled.length ? (
                <p className="dg-note">
                  Too small for a label: {model.unlabeled.map((c) => c.part).join("; ")}.
                </p>
              ) : null}
            </>
          ),
          content: (
            <svg
              className="dg-tm-svg"
              viewBox={`0 0 ${model.w} ${model.h}`}
              role="img"
              aria-label={`Treemap of ${fmtNum(model.total)}: ${model.cells.map((c) => c.part).join(", ")}`}
            >
              {model.groups.map((g, i) => (
                <g key={`g${i}`} className="dg-tm-group">
                  <rect
                    className="dg-tm-group-box"
                    x={g.x}
                    y={g.y}
                    width={g.w}
                    height={g.h}
                    rx={3}
                    data-austere-part={g.part}
                  >
                    <title>{g.part}</title>
                  </rect>
                  {g.titled ? (
                    <T
                      className="dg-tm-group-name"
                      x={g.x + 8}
                      y={g.y + 13}
                      data-austere-part={g.part}
                    >
                      {g.name.length > Math.max(4, (g.w - 16) / 7)
                        ? `${g.name.slice(0, Math.max(3, Math.floor((g.w - 16) / 7) - 1))}…`
                        : g.name}
                    </T>
                  ) : null}
                </g>
              ))}
              {model.cells.map((c, i) => (
                <g
                  key={i}
                  className={`dg-tm-cell r-${Math.min(c.rank, 5)}${c.focus ? " is-focal" : ""}`}
                >
                  <rect
                    className="dg-tm-rect"
                    x={c.x}
                    y={c.y}
                    width={c.w}
                    height={c.h}
                    rx={2}
                    data-austere-part={c.part}
                  >
                    <title>{c.part}</title>
                  </rect>
                  {c.lines.map((line, k) => (
                    <T
                      key={k}
                      className={`dg-tm-${line.cls}`}
                      x={c.x + 8}
                      y={c.y + 20 + k * (line.cls === "name" ? 17 : 16)}
                    >
                      {line.text}
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
  name: "Treemap",
  group: "Diagrams",
  tier: "extended",
  family: "Quantity",
  keywords: [
    "treemap",
    "tree map",
    "part of whole",
    "share",
    "disk usage",
    "bundle size",
    "spend breakdown",
    "market share",
    "what dominates",
    "proportion",
  ],
  guide,
  limits: [
    {
      prop: "labels",
      max: 8,
      message:
        'Treemap: 8 cells at most. Merge the tail into one "Other" cell and say what it holds.',
    },
  ],
  props: z.object({
    labels: z.array(z.string()),
    values: z.array(z.union([z.number(), z.string(), z.null()])),
    unit: z.string().optional(),
    focus: z.string().optional(),
    groups: z.array(z.string()).optional(),
  }),
  description:
    "A whole split into parts by area: labels, then one value above 0 for each. unit follows numbers; focus is the label of the one cell to outline. groups gives each label its parent name for a second level. Cells show name, value and share. Click target: each cell and group.",
  renderer: TreemapView,
  example: [
    `bundle = Treemap(["vendor", "app", "i18n", "charts", "other"], [412, 268, 96, 74, 31], "KB", "vendor")`,
    `spend = Treemap(["Compute", "Storage", "Egress", "Support", "Seats", "Training"], [5200, 2100, 900, 1200, 800, 300], "USD", null, ["Cloud", "Cloud", "Cloud", "People", "People", "People"])`,
  ],
  stress: [
    `stressTreemap = Treemap(["CELL_WITH_A_VERY_LONG_UNBROKEN_NAME_THAT_MUST_BE_CUT_AT_THE_EDGE", "支払いの確認", "Mid", "Small", "Tiny", "Sliver"], [9876543.21, 400000, 120000, 3000, 40, 1], "bytes", "Sliver")`,
    `stressGroups = Treemap(["A", "B", "C", "D", "E"], [50, 30, 20, 10, 5], null, null, ["GROUP_WITH_A_VERY_LONG_UNBROKEN_NAME_THAT_MUST_BE_CUT", "GROUP_WITH_A_VERY_LONG_UNBROKEN_NAME_THAT_MUST_BE_CUT", "Two", "Two", ""])`,
  ],
});
