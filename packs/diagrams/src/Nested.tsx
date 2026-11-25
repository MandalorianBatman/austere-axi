import React, { useEffect, useMemo } from "react";
import { z } from "zod";
import { austereComponent, DiagramFrame, reportRuntimeError } from "austere-axi/pack";
import type { RendererArgs } from "austere-axi/pack";
import { LEVEL_TONES, NESTED_SPEC, buildLevels } from "./_containment-model.ts";
import type { Level } from "./_containment-model.ts";
import guide from "./Nested.md";

const nothing = () => null;

/** Deepest step of the ring styling; a level past it looks like the last step (check warns above 6 levels). */
const LAST_STEP = 5;

function Ring({ levels, at }: { levels: Level[]; at: number }) {
  const level = levels[at];
  return (
    <div
      className={`dg-nest-level d-${Math.min(at, LAST_STEP)}${level.tone ? ` t-${level.tone}` : ""}`}
      role="group"
      aria-label={level.label}
      data-oui-id={level.named ? level.id : undefined}
      data-oui-c={level.named ? "NestedLevel" : undefined}
    >
      <div className="dg-nest-head" data-austere-part={level.label}>
        <span className="dg-nest-label">{level.label}</span>{" "}
        {level.note ? <span className="dg-nest-note">{level.note}</span> : null}
      </div>
      {at + 1 < levels.length ? <Ring levels={levels} at={at + 1} /> : null}
    </div>
  );
}

function NestedView({ props, statementId }: RendererArgs<{ levels?: unknown }>) {
  const model = useMemo(() => buildLevels(props?.levels, NESTED_SPEC), [props]);
  const problemKey = model.problems.join("\n");
  useEffect(() => {
    for (const message of model.problems)
      reportRuntimeError({ source: "nested", statementId, component: "Nested", message });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [problemKey, statementId]);

  return (
    <DiagramFrame className="dg-nest" name="Nested diagram">
      {() =>
        model.levels.length
          ? { content: <Ring levels={model.levels} at={0} /> }
          : {
              error: (
                <div className="austere-render-error">
                  <strong>Nested has no levels.</strong> List the NestedLevel statements, outermost
                  first.
                </div>
              ),
            }
      }
    </DiagramFrame>
  );
}

export const NestedLevel = austereComponent({
  name: "NestedLevel",
  group: "Diagrams",
  tier: "extended",
  props: z.object({
    label: z.string(),
    note: z.string().optional(),
    tone: z.enum(LEVEL_TONES).optional(),
  }),
  description:
    "One ring of a Nested diagram. label names the scope; note is a short aside next to it. tone tints the ring (strong = the one level to notice, danger = a risk). Click target.",
  renderer: nothing,
  slots: null,
  tagged: false,
});

export const Nested = austereComponent({
  name: "Nested",
  group: "Diagrams",
  tier: "extended",
  family: "Hierarchy",
  keywords: [
    "nested",
    "containment",
    "boxes in boxes",
    "scope",
    "boundary",
    "trust zone",
    "blast radius",
    "inside",
    "concentric",
    "rings",
    "folder nesting",
  ],
  guide,
  limits: [
    {
      prop: "levels",
      max: 6,
      message: "Detail disappears inward: split it into two diagrams, or drop the levels between.",
    },
  ],
  props: z.object({
    levels: z.array(NestedLevel.definition.ref),
  }),
  description:
    "Scope by containment: boxes inside boxes, outermost level first, 2 to 4 usual. Each NestedLevel sits inside the one before it. Write no sizes. Each NestedLevel is its own click target.",
  renderer: NestedView,
  example: [
    `scopeNest = Nested([nsOrg, nsWorkspace, nsProject])
nsOrg = NestedLevel("Organization")
nsWorkspace = NestedLevel("Workspace")
nsProject = NestedLevel("Project")`,
    `blastNest = Nested([bkAws, bkVpc, bkCluster, bkNs, bkPod])
bkAws = NestedLevel("AWS account prod-eu", "billing and IAM boundary")
bkVpc = NestedLevel("VPC 10.4.0.0/16", "no inbound from the internet")
bkCluster = NestedLevel("EKS cluster core-1", "one control plane")
bkNs = NestedLevel("Namespace payments", "network policy: deny all but gateway")
bkPod = NestedLevel("Pod payments-api", "a bad deploy stops here", "strong")`,
  ],
  stress: [
    `stressNest = Nested([nxA, nxB, nxC, nxD, nxE, nxF])
nxA = NestedLevel("OUTERMOST_SCOPE_WITH_A_VERY_LONG_UNBROKEN_NAME_THAT_MUST_WRAP_OR_BE_CUT", "an aside that goes on and on and on and on and on and on for a long time")
nxB = NestedLevel("支払いチームの管理するリージョン", "東京リージョン")
nxC = NestedLevel("📦 Ship it", "", "danger")
nxD = NestedLevel("d")
nxE = NestedLevel("Level with a long human readable name that wraps over two lines and then some more")
nxF = NestedLevel("Innermost level, the sixth", "note", "strong")`,
  ],
});

export default [Nested, NestedLevel];
