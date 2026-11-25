import React from "react";
import { z } from "zod";
import { austereComponent, DiagramFrame } from "austere-axi/pack";
import type { RendererArgs } from "austere-axi/pack";
import { LOOP, layoutLoop } from "./_shape-model.ts";
import { Hit, T } from "./_shape-view.tsx";
import { useProblems } from "./_matrix-view.tsx";
import guide from "./Loop.md";

const nothing = () => null;

export const LoopStep = austereComponent({
  name: "LoopStep",
  group: "Diagrams",
  tier: "extended",
  props: z.object({
    name: z.string(),
    detail: z.string().optional(),
    writes: z.string().optional(),
    focus: z.boolean().optional(),
  }),
  description:
    "One step of a Loop, in clockwise order from the top. detail: a short note. writes: one or two words for what this step adds to the hub. focus marks the decision gate (one only). Click target.",
  renderer: nothing,
  slots: null,
  tagged: false,
});

export const LoopHub = austereComponent({
  name: "LoopHub",
  group: "Diagrams",
  tier: "extended",
  props: z.object({ name: z.string(), detail: z.string().optional() }),
  description:
    "The shared state in the centre of a Loop: every step writes to it. name is its label, detail a short note. Click target.",
  renderer: nothing,
  slots: null,
  tagged: false,
});

type LoopProps = { steps?: unknown; hub?: unknown };

function LoopView({ props, statementId }: RendererArgs<LoopProps>) {
  const lay = React.useMemo(() => layoutLoop(props), [props]);
  useProblems(lay.problems, "loop", "Loop", statementId);
  const { sw, sh, hw, hh } = LOOP;
  return (
    <DiagramFrame className="dg-loop" name="Loop">
      {() => {
        if (!lay.steps.length) {
          return {
            error: (
              <div className="austere-render-error">
                <strong>Loop has no steps.</strong> List the LoopStep statements in clockwise order,
                and an optional LoopHub.
              </div>
            ),
          };
        }
        return {
          width: lay.w,
          content: (
            <svg
              className="dg-lp-svg"
              viewBox={`${lay.x} ${lay.y} ${lay.w} ${lay.h}`}
              role="img"
              aria-label={`Loop: ${lay.steps.map((s) => s.name).join(", then ")}, and back to ${lay.steps[0].name}${lay.hub ? `; each step writes to ${lay.hub.name}` : ""}`}
            >
              {lay.arcs.map((a, i) => (
                <g key={i} className="dg-lp-ring">
                  <path className="dg-lp-arc" d={a.d} />
                  <polygon className="dg-lp-head" points={a.head} />
                </g>
              ))}
              {lay.spokes.map((s, i) => (
                <g key={i} className="dg-lp-spoke">
                  <path className="dg-lp-write" d={s.d} />
                  <polygon className="dg-lp-write-head" points={s.head} />
                  {s.label ? (
                    <>
                      <rect
                        className="dg-lp-mask"
                        x={s.mask.x0}
                        y={s.mask.y0}
                        width={s.mask.x1 - s.mask.x0}
                        height={s.mask.y1 - s.mask.y0}
                      />
                      <T className="dg-lp-writes" x={s.lx} y={s.ly} textAnchor={s.anchor}>
                        {s.label.toUpperCase()}
                      </T>
                    </>
                  ) : null}
                </g>
              ))}
              {lay.steps.map((s) => (
                <g
                  key={s.id}
                  className={`dg-lp-step${s.focus ? " is-focal" : ""}`}
                  data-oui-id={s.named ? s.id : undefined}
                  data-oui-c={s.named ? "LoopStep" : undefined}
                >
                  <title>{s.detail ? `${s.name}: ${s.detail}` : s.name}</title>
                  <g data-austere-part={s.name}>
                    <Hit x0={s.x} y0={s.y} x1={s.x + sw} y1={s.y + sh} />
                    <rect className="dg-lp-box" x={s.x} y={s.y} width={sw} height={sh} rx={8} />
                    {s.lines.map((line, i) => {
                      const total = s.lines.length + (s.detailLine ? 1 : 0);
                      const top = s.y + sh / 2 - ((total - 1) * 16) / 2 + 4;
                      return (
                        <T
                          key={i}
                          className="dg-lp-name"
                          x={s.x + sw / 2}
                          y={top + i * 16}
                          textAnchor="middle"
                        >
                          {line}
                        </T>
                      );
                    })}
                    {s.detailLine ? (
                      <T
                        className="dg-lp-detail"
                        x={s.x + sw / 2}
                        y={s.y + sh / 2 - (s.lines.length * 16) / 2 + 4 + s.lines.length * 16 + 2}
                        textAnchor="middle"
                      >
                        {s.detailLine}
                      </T>
                    ) : null}
                  </g>
                </g>
              ))}
              {lay.hub ? (
                <g
                  className="dg-lp-hub"
                  data-oui-id={lay.hub.named ? lay.hub.id : undefined}
                  data-oui-c={lay.hub.named ? "LoopHub" : undefined}
                >
                  <title>
                    {lay.hub.detail ? `${lay.hub.name}: ${lay.hub.detail}` : lay.hub.name}
                  </title>
                  <g data-austere-part={lay.hub.name}>
                    <rect
                      className="dg-lp-hub-box"
                      x={lay.hub.x}
                      y={lay.hub.y}
                      width={hw}
                      height={hh}
                      rx={10}
                    />
                    {lay.hub.lines.map((line, i) => {
                      const total = lay.hub!.lines.length + (lay.hub!.detailLine ? 1 : 0);
                      const y = -((total - 1) * 17) / 2 + 5 + i * 17;
                      return (
                        <T key={i} className="dg-lp-hub-name" x={0} y={y} textAnchor="middle">
                          {line}
                        </T>
                      );
                    })}
                    {lay.hub.detailLine ? (
                      <T
                        className="dg-lp-hub-detail"
                        x={0}
                        y={-((lay.hub.lines.length * 17) / 2) + 5 + lay.hub.lines.length * 17 + 1}
                        textAnchor="middle"
                      >
                        {lay.hub.detailLine}
                      </T>
                    ) : null}
                  </g>
                </g>
              ) : null}
            </svg>
          ),
        };
      }}
    </DiagramFrame>
  );
}

export const Loop = austereComponent({
  name: "Loop",
  group: "Diagrams",
  tier: "extended",
  family: "Shapes",
  keywords: [
    "loop",
    "cycle",
    "flywheel",
    "feedback loop",
    "reinforcing",
    "virtuous circle",
    "operating loop",
    "continuous improvement",
    "circular process",
    "hub",
  ],
  guide,
  limits: [
    {
      prop: "steps",
      max: 8,
      message: "Loop: 8 steps at most. Split it into an overview loop and detail loops.",
    },
  ],
  props: z.object({
    steps: z.array(LoopStep.definition.ref),
    hub: z.optional(LoopHub.definition.ref),
  }),
  description:
    "A reinforcing cycle: LoopSteps in a ring, clockwise from the top, the last feeding the first. An optional hub (LoopHub) in the centre receives a dashed write-back from every step. Each step and the hub is a click target.",
  renderer: LoopView,
  example: [
    `reviewLoop = Loop([lpA, lpB, lpC])
lpA = LoopStep("Write")
lpB = LoopStep("Review")
lpC = LoopStep("Revise")`,
    `learningLoop = Loop([lsA, lsB, lsC, lsD, lsE], lsHub)
lsA = LoopStep("Capture", "Signals come in", "Signals")
lsB = LoopStep("Research", "Evidence is pulled")
lsC = LoopStep("Decide", "A person approves", null, true)
lsD = LoopStep("Act", "The work ships", "Outcomes")
lsE = LoopStep("Measure", "Results are logged")
lsHub = LoopHub("Shared memory", "One record for every pass")`,
  ],
  stress: [
    `stressLoop = Loop([ls1, ls2, ls3, ls4, ls5, ls6, ls7, ls8], lsH)
ls1 = LoopStep("STEP_WITH_A_VERY_LONG_UNBROKEN_NAME_THAT_MUST_BE_CUT_AT_THE_EDGE", "DETAIL_WITH_A_VERY_LONG_UNBROKEN_TOKEN_THAT_MUST_BE_CUT", "A_LABEL_WITH_NO_BREAKS_AT_ALL_THAT_GOES_ON", true)
ls2 = LoopStep("支払い", "東京")
ls3 = LoopStep("Third step has a long human readable name", "Detail", "Writes")
ls4 = LoopStep("Fourth", null, "Out")
ls5 = LoopStep("Fifth")
ls6 = LoopStep("Sixth", "Detail", "In")
ls7 = LoopStep("Seventh")
ls8 = LoopStep("Eighth")
lsH = LoopHub("HUB_WITH_A_VERY_LONG_UNBROKEN_NAME_THAT_MUST_BE_CUT_AT_THE_EDGE", "DETAIL_WITH_A_VERY_LONG_UNBROKEN_TOKEN_THAT_MUST_BE_CUT")`,
    `stressPair = Loop([lpX, lpY])
lpX = LoopStep("Only two")
lpY = LoopStep("Steps")`,
  ],
});

export default [Loop, LoopStep, LoopHub];
