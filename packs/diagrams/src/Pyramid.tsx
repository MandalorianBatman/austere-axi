import React from "react";
import { z } from "zod";
import { austereComponent, DiagramFrame } from "austere-axi/pack";
import type { RendererArgs } from "austere-axi/pack";
import { PYR, buildPyramid } from "./_shape-model.ts";
import { Hit, T } from "./_shape-view.tsx";
import { useProblems } from "./_matrix-view.tsx";
import guide from "./Pyramid.md";

const nothing = () => null;

export const PyramidLayer = austereComponent({
  name: "PyramidLayer",
  group: "Diagrams",
  tier: "extended",
  props: z.object({
    name: z.string(),
    value: z.union([z.number(), z.string()]).optional(),
    detail: z.string().optional(),
    focus: z.boolean().optional(),
  }),
  description:
    "One layer of a Pyramid, listed top to bottom. value: a number (sets the width in a funnel) or short text. detail: a short note. focus marks the one layer to stress (one only). Click target: the layer and its label.",
  renderer: nothing,
  slots: null,
  tagged: false,
});

type PyramidProps = { layers?: unknown; shape?: unknown };

function PyramidView({ props, statementId }: RendererArgs<PyramidProps>) {
  const model = React.useMemo(() => buildPyramid(props), [props]);
  useProblems(model.problems, "pyramid", "Pyramid", statementId);
  return (
    <DiagramFrame className="dg-pyramid" name={model.funnel ? "Funnel" : "Pyramid"}>
      {() => {
        if (!model.layers.length) {
          return {
            error: (
              <div className="austere-render-error">
                <strong>Pyramid has no layers.</strong> List the PyramidLayer statements, top to
                bottom.
              </div>
            ),
          };
        }
        return {
          width: PYR.w,
          caption:
            model.funnel && !model.toScale ? (
              <p className="dg-py-note">Widths are not to scale: some layers have no value.</p>
            ) : model.funnel ? (
              <p className="dg-py-note">Each layer is as wide as its value.</p>
            ) : null,
          content: (
            <svg
              className="dg-py-svg"
              viewBox={`0 0 ${PYR.w} ${model.h}`}
              role="img"
              aria-label={`${model.funnel ? "Funnel" : "Pyramid"}, top to bottom: ${model.layers.map((l) => l.name).join(", ")}`}
            >
              {model.layers.map((l, i) => {
                const [tl, tr, br, bl] = l.points;
                const mid = l.y + 33;
                const edge = (tr[0] + br[0]) / 2;
                const lines = [
                  l.name,
                  l.value && `${l.value}${l.drop ? `  ${l.drop}` : ""}`,
                  l.detail,
                ];
                return (
                  <g
                    key={l.id}
                    className={`dg-py-layer t-${i % 6}${l.focus ? " is-focal" : ""}`}
                    data-oui-id={l.named ? l.id : undefined}
                    data-oui-c={l.named ? "PyramidLayer" : undefined}
                  >
                    <title>{lines.filter(Boolean).join(" · ")}</title>
                    <g data-austere-part={l.name}>
                      <polygon
                        className="dg-py-shape"
                        points={[tl, tr, br, bl].map((p) => p.join(",")).join(" ")}
                      />
                      <Hit x0={edge + 4} y0={l.y} x1={PYR.w - 6} y1={l.y + 66} />
                      <line
                        className="dg-py-leader"
                        x1={edge + 6}
                        y1={mid}
                        x2={PYR.labelX - 10}
                        y2={mid}
                      />
                      <T
                        className="dg-py-name"
                        x={PYR.labelX}
                        y={mid - (l.value || l.detail ? 8 : -4)}
                      >
                        {l.name.length > 30 ? `${l.name.slice(0, 29)}…` : l.name}
                      </T>
                      {l.value ? (
                        <T className="dg-py-value" x={PYR.labelX} y={mid + 9}>
                          {l.value.length > 20 ? `${l.value.slice(0, 19)}…` : l.value}
                          {l.drop ? ` · ${l.drop}` : ""}
                        </T>
                      ) : null}
                      {l.detail ? (
                        <T className="dg-py-detail" x={PYR.labelX} y={mid + (l.value ? 24 : 10)}>
                          {l.detail.length > 34 ? `${l.detail.slice(0, 33)}…` : l.detail}
                        </T>
                      ) : null}
                    </g>
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

export const Pyramid = austereComponent({
  name: "Pyramid",
  group: "Diagrams",
  tier: "extended",
  family: "Shapes",
  keywords: [
    "pyramid",
    "funnel",
    "conversion funnel",
    "hierarchy of needs",
    "ranks",
    "tiers",
    "levels",
    "drop-off",
    "sales funnel",
    "value stack",
    "maslow",
  ],
  guide,
  limits: [
    {
      prop: "layers",
      max: 6,
      message: "Pyramid: 6 layers at most. Merge the small ones, or split into two.",
    },
  ],
  props: z.object({
    layers: z.array(PyramidLayer.definition.ref),
    shape: z.string().optional(),
  }),
  description:
    'Ranked layers, listed top to bottom (PyramidLayer). shape: "pyramid" (default, point up) or "funnel" (point down; each layer as wide as its number value, with the drop from the layer above). Each layer is a click target.',
  renderer: PyramidView,
  example: [
    `needsPyramid = Pyramid([pyA, pyB, pyC])
pyA = PyramidLayer("Delight")
pyB = PyramidLayer("Reliable")
pyC = PyramidLayer("Works")`,
    `signupFunnel = Pyramid([fnA, fnB, fnC, fnD], "funnel")
fnA = PyramidLayer("Visited", 12400, "From the launch post")
fnB = PyramidLayer("Started sign-up", 3100)
fnC = PyramidLayer("Verified email", 1900, "Mail lands in spam for some")
fnD = PyramidLayer("Paid", 420, "The goal", true)`,
  ],
  stress: [
    `stressPyramid = Pyramid([pyAs, pyBs, pyCs, pyDs, pyEs, pyFs], "funnel")
pyAs = PyramidLayer("LAYER_WITH_A_VERY_LONG_UNBROKEN_NAME_THAT_MUST_BE_CUT_AT_THE_EDGE", 1234567890, "DETAIL_WITH_A_VERY_LONG_UNBROKEN_TOKEN_THAT_MUST_BE_CUT_AT_THE_EDGE")
pyBs = PyramidLayer("支払い", 998877665.5)
pyCs = PyramidLayer("Zero", 0)
pyDs = PyramidLayer("Rises again", 5000, null, true)
pyEs = PyramidLayer("E", 1)
pyFs = PyramidLayer("Last", 0.000001)`,
    `stressTiers = Pyramid([ptA, ptB, ptC])
ptA = PyramidLayer("TOP_LAYER_WITH_A_VERY_LONG_UNBROKEN_NAME_THAT_MUST_BE_CUT", "a long text value that has to be cut at the edge of the label column", "DETAIL_WITH_A_VERY_LONG_UNBROKEN_TOKEN_THAT_MUST_BE_CUT_AT_THE_EDGE", true)
ptB = PyramidLayer("支払い", 42)
ptC = PyramidLayer("Base")`,
  ],
});

export default [Pyramid, PyramidLayer];
