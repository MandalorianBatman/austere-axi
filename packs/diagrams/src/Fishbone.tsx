import React from "react";
import { z } from "zod";
import { austereComponent, DiagramFrame } from "austere-axi/pack";
import type { RendererArgs } from "austere-axi/pack";
import { FISH, layoutFishbone } from "./_shape-model.ts";
import { Hit, T } from "./_shape-view.tsx";
import { useProblems } from "./_matrix-view.tsx";
import guide from "./Fishbone.md";

const nothing = () => null;

export const FishCause = austereComponent({
  name: "FishCause",
  group: "Diagrams",
  tier: "extended",
  props: z.object({
    text: z.string(),
    category: z.string(),
    root: z.boolean().optional(),
  }),
  description:
    "One cause on a Fishbone. text is a short finding. category names its bone (the same spelling groups causes). root marks the confirmed root cause (one only). Click target: its tick and label.",
  renderer: nothing,
  slots: null,
  tagged: false,
});

type FishboneProps = { effect?: unknown; causes?: unknown };

function FishboneView({ props, statementId }: RendererArgs<FishboneProps>) {
  const model = React.useMemo(() => layoutFishbone(props), [props]);
  useProblems(model.problems, "fishbone", "Fishbone", statementId);
  const { dx, dy } = FISH;
  return (
    <DiagramFrame className="dg-fishbone" name="Fishbone diagram">
      {() => {
        if (!model.bones.length) {
          return {
            error: (
              <div className="austere-render-error">
                <strong>Fishbone has no causes.</strong> List the FishCause statements, each with
                the category it belongs to.
              </div>
            ),
          };
        }
        const e = model.effectBox;
        return {
          width: model.w,
          content: (
            <svg
              className="dg-fb-svg"
              viewBox={`${model.x} ${model.y} ${model.w} ${model.h}`}
              role="img"
              aria-label={`Fishbone: ${model.effectLines.join(" ")}; categories ${model.bones.map((b) => b.category).join(", ")}`}
            >
              <line
                className="dg-fb-spine"
                x1={model.spineX0}
                y1={model.cy}
                x2={e.x0 - 8}
                y2={model.cy}
              />
              <polygon
                className="dg-fb-spine-head"
                points={`${e.x0 - 14},${model.cy - 5} ${e.x0},${model.cy} ${e.x0 - 14},${model.cy + 5}`}
              />
              {model.bones.map((b) => (
                <g key={b.category} className={`dg-fb-bone${b.root ? " is-root" : ""}`}>
                  <line
                    className="dg-fb-line"
                    x1={b.ax}
                    y1={model.cy}
                    x2={b.fx}
                    y2={model.cy + (b.above ? -dy : dy)}
                  />
                  {b.causes.map((c) => (
                    <g
                      key={c.id}
                      className={`dg-fb-cause${c.root ? " is-root" : ""}`}
                      data-oui-id={c.named ? c.id : undefined}
                      data-oui-c={c.named ? "FishCause" : undefined}
                    >
                      <title>{`${b.category}: ${c.text}`}</title>
                      <g data-austere-part={`${b.category}: ${c.text}`}>
                        <Hit x0={c.box.x0} y0={c.box.y0} x1={c.box.x1} y1={c.box.y1} />
                        <line className="dg-fb-tick" x1={c.bx} y1={c.by} x2={c.bx - 32} y2={c.by} />
                        {c.lines.map((line, i) => (
                          <T
                            key={i}
                            className="dg-fb-cause-text"
                            x={c.lx}
                            y={c.ly + i * 14}
                            textAnchor="end"
                          >
                            {line}
                          </T>
                        ))}
                      </g>
                    </g>
                  ))}
                  <g data-austere-part={`Category: ${b.category}`}>
                    <title>{b.category}</title>
                    <rect
                      className="dg-fb-tag"
                      x={b.tagBox.x0}
                      y={b.tagBox.y0}
                      width={b.tagBox.x1 - b.tagBox.x0}
                      height={b.tagBox.y1 - b.tagBox.y0}
                      rx={4}
                    />
                    <T
                      className="dg-fb-tag-text"
                      x={(b.tagBox.x0 + b.tagBox.x1) / 2}
                      y={(b.tagBox.y0 + b.tagBox.y1) / 2 + 4}
                      textAnchor="middle"
                    >
                      {b.tag}
                    </T>
                  </g>
                </g>
              ))}
              <g
                className={`dg-fb-effect${model.hasRoot ? " is-root" : ""}`}
                data-austere-part="Effect"
              >
                <rect
                  className="dg-fb-effect-box"
                  x={e.x0}
                  y={e.y0}
                  width={e.x1 - e.x0}
                  height={e.y1 - e.y0}
                  rx={8}
                />
                {model.effectLines.map((line, i) => (
                  <T
                    key={i}
                    className="dg-fb-effect-text"
                    x={(e.x0 + e.x1) / 2}
                    y={model.cy - ((model.effectLines.length - 1) * 17) / 2 + 5 + i * 17}
                    textAnchor="middle"
                  >
                    {line}
                  </T>
                ))}
              </g>
            </svg>
          ),
        };
      }}
    </DiagramFrame>
  );
}

export const Fishbone = austereComponent({
  name: "Fishbone",
  group: "Diagrams",
  tier: "extended",
  family: "Shapes",
  keywords: [
    "fishbone",
    "ishikawa",
    "root cause",
    "cause and effect",
    "post-mortem",
    "postmortem",
    "incident analysis",
    "5 whys",
    "contributing factors",
    "why did it happen",
  ],
  guide,
  limits: [
    {
      prop: "causes",
      max: 18,
      message: "Fishbone: 18 causes at most. Keep the confirmed findings, or split by subsystem.",
    },
  ],
  props: z.object({
    effect: z.string(),
    causes: z.array(FishCause.definition.ref),
  }),
  description:
    "Root-cause diagram: one observed effect (a symptom, not a fix) and FishCauses grouped on bones by category, in order of first use. One cause may be the confirmed root. Each cause is a click target.",
  renderer: FishboneView,
  example: [
    `outageFish = Fishbone("Checkout p99 latency tripled", [fbA, fbB])
fbA = FishCause("Slow query on orders", "Data")
fbB = FishCause("Cold cache after deploy", "Deploy")`,
    `incidentFish = Fishbone("Checkout p99 latency tripled on Nov 12", [fiA, fiB, fiC, fiD, fiE, fiF])
fiA = FishCause("Missing index on orders.user_id", "Data", true)
fiB = FishCause("Table grew 4x in a month", "Data")
fiC = FishCause("Cache cold after deploy", "Deploy")
fiD = FishCause("No canary stage", "Deploy")
fiE = FishCause("Retry storm from the mobile app", "Clients")
fiF = FishCause("No alert on p99, only on errors", "Monitoring")`,
  ],
  stress: [
    `stressFish = Fishbone("AN_EFFECT_WITH_A_VERY_LONG_UNBROKEN_NAME_THAT_MUST_BE_CUT_AT_THE_EDGE_OF_THE_BOX_AND_GOES_ON_AND_ON", [xfA, xfB, xfC, xfD, xfE, xfF, xfG, xfH, xfI, xfJ, xfK, xfL])
xfA = FishCause("CAUSE_WITH_A_VERY_LONG_UNBROKEN_TOKEN_THAT_MUST_BE_CUT_AT_THE_EDGE_OF_THE_LABEL", "CATEGORY_WITH_A_VERY_LONG_UNBROKEN_NAME_THAT_MUST_BE_CUT", true)
xfB = FishCause("支払いの確認", "支払い")
xfC = FishCause("Third one", "Third")
xfD = FishCause("D", "Third")
xfE = FishCause("E", "Third")
xfF = FishCause("A long human readable cause that needs two lines of room", "支払い")
xfG = FishCause("G", "Fourth")
xfH = FishCause("H", "Fourth")
xfI = FishCause("I", "Fifth")
xfJ = FishCause("J", "Sixth")
xfK = FishCause("K", "Sixth")
xfL = FishCause("L", "fourth")`,
  ],
});

export default [Fishbone, FishCause];
