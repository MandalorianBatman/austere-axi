import React from "react";
import { z } from "zod";
import { austereComponent, DiagramFrame } from "austere-axi/pack";
import type { RendererArgs } from "austere-axi/pack";
import { buildHeatmap, rampFill } from "./_matrix-model.ts";
import { useProblems } from "./_matrix-view.tsx";
import guide from "./Heatmap.md";

const nothing = () => null;

export const HeatRow = austereComponent({
  name: "HeatRow",
  group: "Diagrams",
  tier: "extended",
  props: z.object({
    label: z.string(),
    values: z.array(z.union([z.number(), z.string(), z.null()])),
    focus: z.string().optional(),
  }),
  description:
    "One row of a Heatmap: its label and one value for each column, in column order (null or a non-number shows –). focus is the name of the one column whose cell in this row is the point of the figure. Click target.",
  renderer: nothing,
  slots: null,
  tagged: false,
});

type HeatmapProps = { columns?: unknown; rows?: unknown; unit?: unknown };

const STEPS = [0, 0.25, 0.5, 0.75, 1];

function HeatmapView({ props, statementId }: RendererArgs<HeatmapProps>) {
  const map = React.useMemo(() => buildHeatmap(props), [props]);
  useProblems(map.problems, "heatmap", "Heatmap", statementId);
  return (
    <DiagramFrame className="dg-mx dg-heatmap" name="Heatmap">
      {() => {
        if (!map.columns.length || !map.rows.length) {
          return {
            error: (
              <div className="austere-render-error">
                <strong>Heatmap has no {map.columns.length ? "rows" : "columns"}.</strong> Pass the
                column names, then the HeatRow statements.
              </div>
            ),
          };
        }
        return {
          caption: (
            <p className="dg-mx-legend">
              {map.low ? (
                <>
                  <span className="dg-hm-ramp" aria-hidden="true">
                    {STEPS.map((t) => (
                      <i key={t} style={{ background: rampFill(t).fill }} />
                    ))}
                  </span>
                  Lighter is higher: {map.low} to {map.high}.
                </>
              ) : null}
              {map.hasFocal
                ? " The ringed cell is the one the figure is about, and is outside the scale."
                : ""}
            </p>
          ),
          content: (
            <table
              className="dg-mx-table"
              style={{ minWidth: `${88 + map.columns.length * 52}px` }}
            >
              <thead>
                <tr>
                  <td aria-hidden="true" />
                  {map.columns.map((column, c) => (
                    <th scope="col" key={c} data-austere-part={`${column} column`}>
                      {column}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {map.rows.map((row) => (
                  <tr
                    key={row.id}
                    data-oui-id={row.named ? row.id : undefined}
                    data-oui-c={row.named ? "HeatRow" : undefined}
                  >
                    <th scope="row" data-austere-part={`${row.label} row`}>
                      {row.label}
                    </th>
                    {row.cells.map((cell, c) => (
                      <td
                        key={c}
                        className={`dg-hm-cell${cell.value === null ? " is-na" : ""}${cell.focal ? " is-focal" : ""}`}
                        style={cell.fill ? { background: cell.fill } : undefined}
                        data-ink={cell.fill ? cell.ink : undefined}
                        data-sr={cell.focal ? " (key cell)" : undefined}
                      >
                        {cell.text}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          ),
        };
      }}
    </DiagramFrame>
  );
}

export const Heatmap = austereComponent({
  name: "Heatmap",
  group: "Diagrams",
  tier: "extended",
  family: "Matrices",
  keywords: [
    "heatmap",
    "heat map",
    "matrix",
    "grid of numbers",
    "cross tab",
    "correlation",
    "confusion matrix",
    "failure rate by",
    "volume by",
    "which cell stands out",
    "hot spot",
    "intensity",
  ],
  guide,
  limits: [
    {
      prop: "columns",
      max: 6,
      message: "Heatmap: 6 columns at most. Group the columns, or split the figure.",
    },
    {
      prop: "rows",
      max: 7,
      message: "Heatmap: 7 rows at most. Group the rows, or use a Table.",
    },
  ],
  props: z.object({
    columns: z.array(z.string()),
    rows: z.array(HeatRow.definition.ref),
    unit: z.string().optional(),
  }),
  description:
    'Rows against columns with a number in every cell and a fill that follows it: columns (names) and one HeatRow for each row. unit is printed after each value ("%"). Each cell prints its value; a HeatRow\'s focus rings the one key cell. Each row is a click target.',
  renderer: HeatmapView,
  example: [
    `failRate = Heatmap(["S1", "S2", "S3", "S4"], [hmAuth, hmPay, hmSearch], "%")
hmAuth = HeatRow("auth", [4, 6, 3, 5])
hmPay = HeatRow("payments", [2, 5, 9, 47], "S4")
hmSearch = HeatRow("search", [1, 2, 2, 3])`,
    `tickets = Heatmap(["Mon", "Tue", "Wed", "Thu", "Fri"], [tkBilling, tkLogin, tkExport, tkApi])
tkBilling = HeatRow("Billing", [12, 18, 9, 14, 31])
tkLogin = HeatRow("Login", [22, 19, 25, 21, 17])
tkExport = HeatRow("Export", [3, 4, 2, 6, 5])
tkApi = HeatRow("API", [8, 7, 11, null, 9])`,
  ],
  stress: [
    `stressHeat = Heatmap(["COLUMN_WITH_A_VERY_LONG_UNBROKEN_NAME_THAT_MUST_WRAP", "支払い", "C", "D", "E", "F"], [hsA, hsB, hsC], "%")
hsA = HeatRow("ROW_WITH_A_VERY_LONG_UNBROKEN_LABEL_THAT_MUST_WRAP_OR_BE_CUT_AT_THE_EDGE", [0, 1, 2, 3, 4, 1234567.891], "F")
hsB = HeatRow("東京", [5, 5, 5, 5, 5, 5])
hsC = HeatRow("Gaps", [null, "n/a", "12", "1,200", -3, 0])`,
  ],
});

export default [Heatmap, HeatRow];
