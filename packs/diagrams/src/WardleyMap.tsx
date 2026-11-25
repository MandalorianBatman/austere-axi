import React from "react";
import { z } from "zod";
import { austereComponent, DiagramFrame } from "austere-axi/pack";
import type { RendererArgs } from "austere-axi/pack";
import { STAGES, WARD, buildWardley } from "./_shape-model.ts";
import { Hit, T } from "./_shape-view.tsx";
import { useProblems } from "./_matrix-view.tsx";
import guide from "./WardleyMap.md";

const nothing = () => null;

export const WardleyPart = austereComponent({
  name: "WardleyPart",
  group: "Diagrams",
  tier: "extended",
  props: z.object({
    name: z.string(),
    stage: z.string(),
    visibility: z.number(),
    needs: z.array(z.string()).optional(),
    evolving: z.boolean().optional(),
  }),
  description:
    "One part of a WardleyMap. stage: genesis, custom, product or commodity. visibility: 0 (invisible to the user) to 100 (visible). needs: exact names of the parts it depends on. evolving draws an arrow towards commodity. Click target: its dot and label.",
  renderer: nothing,
  slots: null,
  tagged: false,
});

type WardleyProps = { parts?: unknown };

function WardleyView({ props, statementId }: RendererArgs<WardleyProps>) {
  const model = React.useMemo(() => buildWardley(props), [props]);
  useProblems(model.problems, "wardley", "WardleyMap", statementId);
  const { w, h, x0, x1, y0, y1 } = WARD;
  const band = (x1 - x0) / 4;
  return (
    <DiagramFrame className="dg-wardley" name="Wardley map">
      {() => {
        if (!model.parts.length) {
          return {
            error: (
              <div className="austere-render-error">
                <strong>WardleyMap has no parts.</strong> List the WardleyPart statements, each with
                a stage and a visibility.
              </div>
            ),
          };
        }
        return {
          width: w,
          content: (
            <svg
              className="dg-wd-svg"
              viewBox={`0 0 ${w} ${h}`}
              role="img"
              aria-label={`Wardley map: ${model.parts.map((p) => `${p.name} (${STAGES[p.stage]})`).join(", ")}`}
            >
              {[1, 2, 3].map((i) => (
                <line
                  key={i}
                  className="dg-wd-band"
                  x1={x0 + band * i}
                  y1={y0}
                  x2={x0 + band * i}
                  y2={y1}
                />
              ))}
              <line className="dg-wd-axis" x1={x0} y1={y1} x2={x1} y2={y1} />
              <line className="dg-wd-axis" x1={x0} y1={y0} x2={x0} y2={y1} />
              {STAGES.map((s, i) => (
                <T
                  key={s}
                  className="dg-wd-stage"
                  x={x0 + band * (i + 0.5)}
                  y={y1 + 22}
                  textAnchor="middle"
                >
                  {s.toUpperCase()}
                </T>
              ))}
              <T className="dg-wd-vis" x={x0 - 10} y={y0 + 12} textAnchor="end">
                Visible
              </T>
              <T className="dg-wd-vis" x={x0 - 10} y={y0 + 26} textAnchor="end">
                to the user
              </T>
              <T className="dg-wd-vis" x={x0 - 10} y={y1 - 4} textAnchor="end">
                Invisible
              </T>
              {model.links.map((l, i) => {
                const a = model.parts[l.from];
                const b = model.parts[l.to];
                const len = Math.hypot(b.px - a.px, b.py - a.py) || 1;
                const ux = (b.px - a.px) / len;
                const uy = (b.py - a.py) / len;
                return (
                  <line
                    key={i}
                    className="dg-wd-link"
                    x1={a.px + ux * 7}
                    y1={a.py + uy * 7}
                    x2={b.px - ux * 7}
                    y2={b.py - uy * 7}
                  />
                );
              })}
              {model.parts.map((p) => (
                <g
                  key={p.id}
                  className={`dg-wd-part${p.arrowTo !== null ? " is-moving" : ""}`}
                  data-oui-id={p.named ? p.id : undefined}
                  data-oui-c={p.named ? "WardleyPart" : undefined}
                >
                  <title>{`${p.name} (${STAGES[p.stage]}, visibility ${p.visibility})`}</title>
                  <g data-austere-part={p.name}>
                    <Hit
                      x0={Math.min(p.lbox.x0, p.px - 9)}
                      y0={p.lbox.y0 - 2}
                      x1={Math.max(p.lbox.x1, p.px + 9)}
                      y1={p.py + 9}
                    />
                    {p.arrowTo !== null ? (
                      <>
                        <line
                          className="dg-wd-move"
                          x1={p.px + 9}
                          y1={p.py}
                          x2={p.arrowTo - 7}
                          y2={p.py}
                        />
                        <polygon
                          className="dg-wd-move-head"
                          points={`${p.arrowTo - 9},${p.py - 4.5} ${p.arrowTo},${p.py} ${p.arrowTo - 9},${p.py + 4.5}`}
                        />
                      </>
                    ) : null}
                    <circle className="dg-wd-dot" cx={p.px} cy={p.py} r={6} />
                    <T
                      className="dg-wd-label"
                      x={(p.lbox.x0 + p.lbox.x1) / 2}
                      y={p.py - 15}
                      textAnchor="middle"
                    >
                      {p.shown}
                    </T>
                  </g>
                </g>
              ))}
            </svg>
          ),
        };
      }}
    </DiagramFrame>
  );
}

export const WardleyMap = austereComponent({
  name: "WardleyMap",
  group: "Diagrams",
  tier: "extended",
  family: "Shapes",
  keywords: [
    "wardley",
    "wardley map",
    "value chain",
    "evolution",
    "genesis commodity",
    "build or buy",
    "strategy map",
    "commoditisation",
    "commoditization",
    "what to build",
  ],
  guide,
  limits: [
    {
      prop: "parts",
      max: 9,
      message: "WardleyMap: 9 parts at most. Map one value chain, or split by user need.",
    },
  ],
  props: z.object({ parts: z.array(WardleyPart.definition.ref) }),
  description:
    "Parts of a value chain: visibility (y, 0 to 100) against evolution (x, four bands: genesis, custom, product, commodity), with dependency links by name and up to 2 movement arrows. Each WardleyPart is a click target.",
  renderer: WardleyView,
  example: [
    `searchChain = WardleyMap([wmA, wmB])
wmA = WardleyPart("Search page", "product", 90, ["Index"])
wmB = WardleyPart("Index", "custom", 30)`,
    `assistantMap = WardleyMap([wrA, wrB, wrC, wrD, wrE, wrF])
wrA = WardleyPart("Support assistant", "custom", 95, ["Agent orchestration", "Knowledge base"])
wrB = WardleyPart("Agent orchestration", "genesis", 70, ["Model API"], true)
wrC = WardleyPart("Knowledge base", "product", 62, ["Search index"])
wrD = WardleyPart("Model API", "product", 35, ["Compute"])
wrE = WardleyPart("Search index", "product", 40, ["Compute"])
wrF = WardleyPart("Compute", "commodity", 8)`,
  ],
  stress: [
    `stressWardley = WardleyMap([wsA, wsB, wsC, wsD, wsE, wsF, wsG, wsH, wsI])
wsA = WardleyPart("PART_WITH_A_VERY_LONG_UNBROKEN_NAME_THAT_MUST_BE_CUT_AT_THE_EDGE", "genesis", 100, ["支払い"], true)
wsB = WardleyPart("支払い", "genesis", 80, ["Same band", "Commodity part"], true)
wsC = WardleyPart("Same band", "genesis", 60)
wsD = WardleyPart("Same height", "custom", 60, ["Same band"])
wsE = WardleyPart("Also product", "Product", 60, ["Same height"])
wsF = WardleyPart("Product part with a long human readable name", "product", 40, ["Commodity part"])
wsG = WardleyPart("Commodity part", "commodity", 5)
wsH = WardleyPart("Top commodity", "commodity", 95, ["Commodity part"])
wsI = WardleyPart("Bottom genesis", "genesis", 0)`,
  ],
});

export default [WardleyMap, WardleyPart];
