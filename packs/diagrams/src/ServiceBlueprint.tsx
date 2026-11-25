import React from "react";
import { z } from "zod";
import { austereComponent } from "austere-axi/pack";
import type { RendererArgs } from "austere-axi/pack";
import { LAYERS, buildBlueprint } from "./_board-model.ts";
import { BoardView } from "./_board-view.tsx";
import guide from "./ServiceBlueprint.md";

const nothing = () => null;

export const BlueprintStep = austereComponent({
  name: "BlueprintStep",
  group: "Diagrams",
  tier: "extended",
  props: z.object({
    action: z.string(),
    stage: z.string(),
    layer: z.enum(LAYERS),
    detail: z.string().optional(),
    focus: z.boolean().optional(),
  }),
  description:
    'One cell of a ServiceBlueprint: an action at a stage, in a layer ("customer", "frontstage", "backstage", "support" or "evidence"). detail is a system or a wait ("dunning-job · 4h"). focus: true marks the one failure or wait the diagram is about. Click target.',
  renderer: nothing,
  slots: null,
  tagged: false,
});

type BlueprintProps = {
  stages?: unknown;
  steps?: unknown;
};

function BlueprintView({ props, statementId }: RendererArgs<BlueprintProps>) {
  const board = React.useMemo(() => buildBlueprint(props), [props]);
  return (
    <BoardView
      board={board}
      component="ServiceBlueprint"
      cardComponent="BlueprintStep"
      name="Service blueprint"
      statementId={statementId}
    />
  );
}

export const ServiceBlueprint = austereComponent({
  name: "ServiceBlueprint",
  group: "Diagrams",
  tier: "extended",
  family: "Boards",
  keywords: [
    "service blueprint",
    "blueprint",
    "line of visibility",
    "frontstage",
    "backstage",
    "customer actions",
    "support process",
    "what the customer sees",
    "hidden work",
    "service design",
  ],
  guide,
  limits: [
    {
      prop: "stages",
      max: 6,
      message: "ServiceBlueprint: 4 to 6 stages. Split a longer service into two blueprints.",
    },
    {
      prop: "steps",
      max: 24,
      message: "ServiceBlueprint: one action for each stage and layer, 24 at most.",
    },
  ],
  props: z.object({
    stages: z.array(z.string()),
    steps: z.array(BlueprintStep.definition.ref),
  }),
  description:
    "How a service runs, stage by stage: stages across (names, in order), the layers down with a line of visibility between frontstage and backstage. One BlueprintStep for each cell. No arrows: stage order is the sequence. Each step is a click target.",
  renderer: BlueprintView,
  example: [
    `retryBlueprint = ServiceBlueprint(["Pay", "Fail", "Retry"], [sbPay, sbShow, sbCharge, sbFail, sbRetry, sbJob])
sbPay = BlueprintStep("Pays by card", "Pay", "customer")
sbShow = BlueprintStep("Sees a receipt", "Pay", "frontstage")
sbCharge = BlueprintStep("Charges the card", "Pay", "backstage", "payments-api")
sbFail = BlueprintStep("Sees a retry banner", "Fail", "frontstage")
sbRetry = BlueprintStep("Taps retry", "Retry", "customer")
sbJob = BlueprintStep("Dunning job runs", "Fail", "backstage", "4h wait", true)`,
    `supportBlueprint = ServiceBlueprint(["Report", "Triage", "Fix", "Confirm"], [spA, spB, spC, spD, spE, spF, spG, spH, spI])
spA = BlueprintStep("Describes the problem", "Report", "customer")
spB = BlueprintStep("Contact form", "Report", "evidence")
spC = BlueprintStep("Gets a ticket number", "Report", "frontstage", "auto reply")
spD = BlueprintStep("Waits for an answer", "Triage", "customer")
spE = BlueprintStep("Agent reads the ticket", "Triage", "frontstage")
spF = BlueprintStep("Routes by product", "Triage", "backstage", "rules engine · 2h", true)
spG = BlueprintStep("Engineer reproduces", "Fix", "backstage", "staging")
spH = BlueprintStep("Runbook and on-call rota", "Fix", "support")
spI = BlueprintStep("Confirms it works", "Confirm", "customer")`,
  ],
  stress: [
    `stressBlueprint = ServiceBlueprint(["STAGE_WITH_A_VERY_LONG_UNBROKEN_NAME_THAT_MUST_WRAP_OR_BE_CUT", "支払い", "Third"], [sxA, sxB, sxC, sxD, sxE])
sxA = BlueprintStep("AN_ACTION_WITH_A_VERY_LONG_UNBROKEN_TOKEN_THAT_MUST_WRAP_OR_BE_CUT_AT_THE_EDGE", "STAGE_WITH_A_VERY_LONG_UNBROKEN_NAME_THAT_MUST_WRAP_OR_BE_CUT", "customer", "a-detail-with-a-very-long-unbroken-token-that-must-be-cut")
sxB = BlueprintStep("東京リージョンの切り替え", "支払い", "frontstage", "", true)
sxC = BlueprintStep("Backstage", "支払い", "backstage")
sxD = BlueprintStep("Evidence", "Third", "evidence")
sxE = BlueprintStep("Support", "Third", "support", "runbook")`,
  ],
});

export default [ServiceBlueprint, BlueprintStep];
