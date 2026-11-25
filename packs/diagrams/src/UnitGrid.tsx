import React from "react";
import { z } from "zod";
import { austereComponent, DiagramFrame } from "austere-axi/pack";
import type { RendererArgs } from "austere-axi/pack";
import { UNIT_SHAPES, UNIT_TOTAL, buildUnitGrid } from "./_matrix-model.ts";
import { useProblems } from "./_matrix-view.tsx";
import guide from "./UnitGrid.md";

const nothing = () => null;

export const UnitShare = austereComponent({
  name: "UnitShare",
  group: "Diagrams",
  tier: "extended",
  props: z.object({
    name: z.string(),
    count: z.number(),
    detail: z.string().optional(),
  }),
  description:
    "One part of a UnitGrid: its name and how many of the 100 units it holds (a whole number). detail is a short note under the name. Each part has its own shape and colour. Click target: its squares and its legend line.",
  renderer: nothing,
  slots: null,
  tagged: false,
});

type UnitGridProps = { parts?: unknown; unit?: unknown };

function UnitGridView({ props, statementId }: RendererArgs<UnitGridProps>) {
  const grid = React.useMemo(() => buildUnitGrid(props), [props]);
  useProblems(grid.problems, "unitgrid", "UnitGrid", statementId);
  return (
    <DiagramFrame className="dg-unit" name="Unit grid">
      {() => {
        if (!grid.parts.length) {
          return {
            error: (
              <div className="austere-render-error">
                <strong>UnitGrid has no parts.</strong> List the UnitShare statements, in the order
                they fill the grid.
              </div>
            ),
          };
        }
        const byIndex = new Map(grid.parts.map((p) => [p.index, p]));
        return {
          content: (
            <div className="dg-ug">
              <div className="dg-ug-grid" aria-hidden="true">
                {grid.cells.map((index, i) => {
                  const part = byIndex.get(index);
                  return part ? (
                    <span
                      className="dg-ug-cell"
                      key={i}
                      data-oui-id={part.named ? part.id : undefined}
                      data-oui-c={part.named ? "UnitShare" : undefined}
                    >
                      <i
                        className={`dg-ug-unit u-${part.index % UNIT_SHAPES}`}
                        data-austere-part={`${part.name}: ${part.count} of ${UNIT_TOTAL}`}
                      />
                    </span>
                  ) : (
                    <span className="dg-ug-cell" key={i}>
                      <i
                        className="dg-ug-unit is-rest"
                        data-austere-part={`Remaining: ${grid.remaining} of ${UNIT_TOTAL}`}
                      />
                    </span>
                  );
                })}
              </div>
              <ul className="dg-ug-legend" aria-label="Parts of the whole">
                {grid.parts.map((part) => (
                  <li
                    key={part.id}
                    data-oui-id={part.named ? part.id : undefined}
                    data-oui-c={part.named ? "UnitShare" : undefined}
                  >
                    <i className={`dg-ug-mark u-${part.index % UNIT_SHAPES}`} aria-hidden="true" />
                    <span className="dg-ug-name" data-austere-part={part.name}>
                      {part.name}
                    </span>
                    <span
                      className="dg-ug-count"
                      data-austere-part={`${part.name}: ${part.count} of ${UNIT_TOTAL}`}
                    >
                      {part.count}
                    </span>
                    {part.asked ? (
                      <span className="dg-ug-note">
                        shown as {part.count}: counted {part.asked}
                      </span>
                    ) : null}
                    {part.detail ? (
                      <span
                        className="dg-ug-note"
                        data-austere-part={`${part.name}: ${part.detail}`}
                      >
                        {part.detail}
                      </span>
                    ) : null}
                  </li>
                ))}
                {grid.remaining ? (
                  <li className="is-rest">
                    <i className="dg-ug-mark is-rest" aria-hidden="true" />
                    <span className="dg-ug-name">Remaining</span>
                    <span className="dg-ug-count">{grid.remaining}</span>
                  </li>
                ) : null}
              </ul>
            </div>
          ),
          caption: (
            <p className="dg-mx-legend">
              One square is 1 {grid.unit || "unit"}; {UNIT_TOTAL} in all. Squares fill left to
              right, top to bottom.
            </p>
          ),
        };
      }}
    </DiagramFrame>
  );
}

export const UnitGrid = austereComponent({
  name: "UnitGrid",
  group: "Diagrams",
  tier: "extended",
  family: "Quantity",
  keywords: [
    "unit grid",
    "waffle",
    "waffle chart",
    "100 squares",
    "out of 100",
    "percent complete",
    "completion",
    "checklist progress",
    "capacity",
    "share of a whole",
    "survey responses",
    "inventory count",
  ],
  guide,
  limits: [
    {
      prop: "parts",
      max: 6,
      message: 'UnitGrid: 6 parts at most. Merge the small ones into "Other", or use a BarChart.',
    },
  ],
  props: z.object({
    parts: z.array(UnitShare.definition.ref),
    unit: z.string().optional(),
  }),
  description:
    'One whole of 100 equal squares, filled in reading order by named parts: one UnitShare(name, count) for each, counts summing to 100 or less (the rest shows as Remaining). unit names what one square is ("check"). Each part is a click target.',
  renderer: UnitGridView,
  example: [
    `readiness = UnitGrid([ugDone, ugLeft], "release check")
ugDone = UnitShare("Passing", 64)
ugLeft = UnitShare("Failing", 7, "Three are flaky")`,
    `inbox = UnitGrid([uiRead, uiAct, uiWait, uiNew], "message")
uiRead = UnitShare("Read, no action", 41)
uiAct = UnitShare("Needs a reply", 18, "Oldest is 6 days")
uiWait = UnitShare("Waiting on others", 12)
uiNew = UnitShare("New today", 9)`,
  ],
  stress: [
    `stressUnits = UnitGrid([usA, usB, usC, usD, usE, usF], "UNIT_WITH_A_VERY_LONG_UNBROKEN_NAME_THAT_MUST_WRAP_OR_BE_CUT_AT_THE_EDGE")
usA = UnitShare("PART_WITH_A_VERY_LONG_UNBROKEN_NAME_THAT_MUST_WRAP_OR_BE_CUT_AT_THE_EDGE", 33.4, "DETAIL_WITH_A_VERY_LONG_UNBROKEN_TOKEN_THAT_MUST_WRAP_OR_BE_CUT")
usB = UnitShare("支払い", 0)
usC = UnitShare("📦 Ship it", 1)
usD = UnitShare("D", 20)
usE = UnitShare("E", 20)
usF = UnitShare("F", 25)`,
  ],
});

export default [UnitGrid, UnitShare];
