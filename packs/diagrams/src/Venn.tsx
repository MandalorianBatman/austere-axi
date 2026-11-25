import React from "react";
import { z } from "zod";
import { austereComponent, DiagramFrame } from "austere-axi/pack";
import type { RendererArgs } from "austere-axi/pack";
import { buildVenn } from "./_shape-model.ts";
import type { RegionLabel, VennModel } from "./_shape-model.ts";
import { Hit, T } from "./_shape-view.tsx";
import { useProblems } from "./_matrix-view.tsx";
import guide from "./Venn.md";

const nothing = () => null;

export const VennSet = austereComponent({
  name: "VennSet",
  group: "Diagrams",
  tier: "extended",
  props: z.object({
    name: z.string(),
    size: z.number().optional(),
    detail: z.string().optional(),
  }),
  description:
    "One circle of a Venn. name is its label. size (optional, above 0) makes its area follow that number; give it to every set or none. detail is a short note. Click target: the circle.",
  renderer: nothing,
  slots: null,
  tagged: false,
});

export const VennOverlap = austereComponent({
  name: "VennOverlap",
  group: "Diagrams",
  tier: "extended",
  props: z.object({
    label: z.string(),
    of: z.array(z.string()),
    focus: z.boolean().optional(),
  }),
  description:
    "A named overlap in a Venn. of lists the exact names of 2 or 3 VennSets it joins. focus tints it as the sweet spot (one only). Click target: the region.",
  renderer: nothing,
  slots: null,
  tagged: false,
});

type VennProps = { sets?: unknown; overlaps?: unknown };

function Lines({ label, part }: { label: RegionLabel; part?: string }) {
  const top = label.y - (label.lines.length * 15) / 2 + 11;
  return (
    <g data-austere-part={part}>
      {label.lines.map((l, i) => (
        <T key={i} className={`dg-vn-t-${l.cls}`} x={label.x} y={top + i * 15} textAnchor="middle">
          {l.text}
        </T>
      ))}
    </g>
  );
}

/** The region where the listed sets meet, as a stack of clips, for a click target and the focus tint. */
function Region({
  model,
  of,
  ids,
  className,
}: {
  model: VennModel;
  of: number[];
  ids: string;
  className: string;
}) {
  const [first, ...rest] = of;
  const last = model.sets[rest[rest.length - 1]];
  const wrap = (list: number[], inner: React.ReactNode): React.ReactNode =>
    list.reduceRight<React.ReactNode>(
      (acc, i) => <g clipPath={`url(#${ids}-${i})`}>{acc}</g>,
      inner,
    );
  return wrap(
    [first, ...rest.slice(0, -1)],
    <circle className={className} cx={last.cx} cy={last.cy} r={last.r} />,
  );
}

function VennView({ props, statementId }: RendererArgs<VennProps>) {
  const model = React.useMemo(() => buildVenn(props), [props]);
  const ids = `dg-vn-${React.useId().replace(/[^a-zA-Z0-9]/g, "")}`;
  useProblems(model.problems, "venn", "Venn", statementId);
  return (
    <DiagramFrame className="dg-venn" name="Venn diagram">
      {() => {
        if (model.sets.length < 2) {
          return {
            error: (
              <div className="austere-render-error">
                <strong>Venn needs 2 or 3 sets.</strong> List the VennSet statements, then the
                VennOverlap statements that name the sets they join.
              </div>
            ),
          };
        }
        // Three-set overlaps last, so a click in the centre reaches the centre.
        const ordered = [...model.overlaps].sort((a, b) => a.of.length - b.of.length);
        return {
          width: model.w,
          content: (
            <svg
              className="dg-vn-svg"
              viewBox={`0 0 ${model.w} ${model.h}`}
              role="img"
              aria-label={`Venn diagram of ${model.sets.map((s) => s.name).join(", ")}`}
            >
              <defs>
                {model.sets.map((s, i) => (
                  <clipPath id={`${ids}-${i}`} key={i}>
                    <circle cx={s.cx} cy={s.cy} r={s.r} />
                  </clipPath>
                ))}
              </defs>
              {model.sets.map((s, i) => (
                <g
                  key={s.id}
                  className={`dg-vn-set s-${i}`}
                  data-oui-id={s.named ? s.id : undefined}
                  data-oui-c={s.named ? "VennSet" : undefined}
                >
                  <title>{s.name}</title>
                  <circle className="dg-vn-circle" cx={s.cx} cy={s.cy} r={s.r} />
                </g>
              ))}
              {ordered.map((o) =>
                o.focus ? (
                  <g key={`t-${o.id}`} className="dg-vn-focus-tint" aria-hidden="true">
                    <Region model={model} of={o.of} ids={ids} className="dg-vn-tint" />
                  </g>
                ) : null,
              )}
              {ordered.map((o) => (
                <g
                  key={o.id}
                  className={`dg-vn-overlap${o.focus ? " is-focal" : ""}`}
                  data-oui-id={o.named ? o.id : undefined}
                  data-oui-c={o.named ? "VennOverlap" : undefined}
                >
                  <title>{`${o.of.map((i) => model.sets[i].name).join(" + ")}: ${o.label}`}</title>
                  <Region model={model} of={o.of} ids={ids} className="dg-sh-hit" />
                  {o.text ? <Lines label={o.text} part={o.label} /> : null}
                </g>
              ))}
              {model.sets.map((s, i) => {
                const label = model.setLabels[i];
                return label ? (
                  <g key={`l-${s.id}`}>
                    <Lines label={label} part={s.name} />
                  </g>
                ) : null;
              })}
            </svg>
          ),
        };
      }}
    </DiagramFrame>
  );
}

export const Venn = austereComponent({
  name: "Venn",
  group: "Diagrams",
  tier: "extended",
  family: "Shapes",
  keywords: [
    "venn",
    "overlap",
    "intersection",
    "sets",
    "where a meets b",
    "shared traits",
    "ikigai",
    "sweet spot",
    "common ground",
    "set overlap",
  ],
  guide,
  limits: [
    {
      prop: "sets",
      max: 3,
      message: "Venn: 3 sets at most. Use a Heatmap (sets against traits) for more.",
    },
  ],
  props: z.object({
    sets: z.array(VennSet.definition.ref),
    overlaps: z.array(VennOverlap.definition.ref).optional(),
  }),
  description:
    "2 or 3 circles with a label for each set (VennSet) and each overlap (VennOverlap, naming the sets it joins). Give every set a size to make areas honest. One overlap may be the focus. Each set and overlap is a click target.",
  renderer: VennView,
  example: [
    `skillsVenn = Venn([vnA, vnB], [vnAB])
vnA = VennSet("Frontend")
vnB = VennSet("Backend")
vnAB = VennOverlap("Full stack", ["Frontend", "Backend"])`,
    `hireVenn = Venn([hvA, hvB, hvC], [hvAB, hvAC, hvBC, hvABC])
hvA = VennSet("Wants the job", null, "Motivated")
hvB = VennSet("Can do the job", null, "Skilled")
hvC = VennSet("Fits the budget", null, "Affordable")
hvAB = VennOverlap("Good fit", ["Wants the job", "Can do the job"])
hvAC = VennOverlap("Settles", ["Wants the job", "Fits the budget"])
hvBC = VennOverlap("Contractor", ["Can do the job", "Fits the budget"])
hvABC = VennOverlap("Hire", ["Wants the job", "Can do the job", "Fits the budget"], true)`,
  ],
  stress: [
    `stressVenn = Venn([vsA, vsB, vsC], [vsAB, vsAC, vsBC, vsABC])
vsA = VennSet("SET_WITH_A_VERY_LONG_UNBROKEN_NAME_THAT_MUST_BE_CUT_AT_THE_EDGE", 1000, "DETAIL_WITH_A_VERY_LONG_UNBROKEN_TOKEN_THAT_MUST_BE_CUT_TOO")
vsB = VennSet("支払い", 400)
vsC = VennSet("C", 120)
vsAB = VennOverlap("OVERLAP_WITH_A_VERY_LONG_UNBROKEN_NAME_THAT_MUST_BE_CUT_AT_THE_EDGE", ["SET_WITH_A_VERY_LONG_UNBROKEN_NAME_THAT_MUST_BE_CUT_AT_THE_EDGE", "支払い"], true)
vsAC = VennOverlap("A long overlap label that needs a few lines of room", ["SET_WITH_A_VERY_LONG_UNBROKEN_NAME_THAT_MUST_BE_CUT_AT_THE_EDGE", "C"])
vsBC = VennOverlap("支払いの確認", ["c", "支払い"])
vsABC = VennOverlap("Centre", ["C", "支払い", "SET_WITH_A_VERY_LONG_UNBROKEN_NAME_THAT_MUST_BE_CUT_AT_THE_EDGE"])`,
  ],
});

export default [Venn, VennSet, VennOverlap];
