import React from "react";
import { z } from "zod";
import type { RendererArgs } from "../../../types/pack.d.ts";
import { austereComponent } from "../define.ts";
import { FlowView } from "./_flow-view.tsx";
import {
  FLOWCHART,
  FLOW_DIRECTIONS,
  FLOW_KINDS,
  FLOW_LINK_STYLES,
  NODE_TONES,
} from "./_flow-model.ts";
import type { FlowInput } from "./_flow-model.ts";
import guide from "./Flowchart.md";

const nothing = () => null;

function FlowchartView({ props, statementId }: RendererArgs<FlowInput>) {
  return <FlowView props={props} statementId={statementId} kind={FLOWCHART} />;
}

export const FlowStep = austereComponent({
  name: "FlowStep",
  group: "Diagrams",
  tier: "extended",
  props: z.object({
    label: z.string(),
    kind: z.enum(FLOW_KINDS).optional(),
    detail: z.string().optional(),
    tone: z.enum(NODE_TONES).optional(),
  }),
  description:
    "A shape in a Flowchart. kind: step (default, rectangle), decision (diamond; write the question), start or end (oval). detail is a monospace line under a step. tone tints it (danger = risk, strong = the outcome). Click target.",
  renderer: nothing,
  slots: null,
  tagged: false,
});

export const FlowLink = austereComponent({
  name: "FlowLink",
  group: "Diagrams",
  tier: "extended",
  props: z.object({
    from: FlowStep.definition.ref,
    to: FlowStep.definition.ref,
    label: z.string().optional(),
    style: z.enum(FLOW_LINK_STYLES).optional(),
  }),
  description:
    'An arrow between two FlowStep statements (pass their names, not strings). label: the answer, on every link out of a decision ("yes", "no", "retry < 3"). style: emphasis for the happy path, dashed for a fallback. Click target.',
  renderer: nothing,
  slots: null,
  tagged: false,
});

export const Flowchart = austereComponent({
  name: "Flowchart",
  group: "Diagrams",
  tier: "extended",
  family: "Flow",
  keywords: [
    "flowchart",
    "flow chart",
    "decision",
    "decision tree",
    "branch",
    "branching",
    "if else",
    "yes no",
    "algorithm",
    "triage",
    "routing",
    "should i",
    "logic",
    "onboarding flow",
  ],
  guide,
  props: z.object({
    steps: z.array(FlowStep.definition.ref),
    links: z.array(FlowLink.definition.ref),
    direction: z.enum(FLOW_DIRECTIONS).optional(),
  }),
  description:
    "Decision logic laid out automatically, top to bottom: FlowSteps (start, end, step, decision) joined by FlowLinks. Write no coordinates. Each FlowStep and FlowLink is its own statement and click target. direction: down (default), right or auto.",
  renderer: FlowchartView,
  example: [
    `retry = Flowchart([rtStart, rtCall, rtOk, rtDone, rtWait], [rtToCall, rtToCheck, rtYes, rtNo, rtAgain])
rtStart = FlowStep("Send request", "start")
rtCall = FlowStep("Call the API")
rtOk = FlowStep("Status 2xx?", "decision")
rtDone = FlowStep("Use the response", "end")
rtWait = FlowStep("Wait, then retry")
rtToCall = FlowLink(rtStart, rtCall)
rtToCheck = FlowLink(rtCall, rtOk)
rtYes = FlowLink(rtOk, rtDone, "yes", "emphasis")
rtNo = FlowLink(rtOk, rtWait, "no")
rtAgain = FlowLink(rtWait, rtCall, null, "dashed")`,
    `triage = Flowchart([tgOpened, tgKnown, tgArticle, tgBlocked, tgPage, tgQueue, tgClosed], [tgToKnown, tgKnownYes, tgKnownNo, tgArticleDone, tgBlockedYes, tgBlockedNo, tgPageDone, tgQueueDone])
tgOpened = FlowStep("Ticket arrives", "start")
tgKnown = FlowStep("Known issue?", "decision")
tgArticle = FlowStep("Reply with the help article", "step", "macro kb-known")
tgBlocked = FlowStep("Is the customer blocked?", "decision")
tgPage = FlowStep("Page the on-call engineer", "step", "SLA 30 min", "danger")
tgQueue = FlowStep("Add to the weekly bug queue")
tgClosed = FlowStep("Ticket closed", "end")
tgToKnown = FlowLink(tgOpened, tgKnown)
tgKnownYes = FlowLink(tgKnown, tgArticle, "yes", "emphasis")
tgKnownNo = FlowLink(tgKnown, tgBlocked, "no")
tgArticleDone = FlowLink(tgArticle, tgClosed)
tgBlockedYes = FlowLink(tgBlocked, tgPage, "yes")
tgBlockedNo = FlowLink(tgBlocked, tgQueue, "no")
tgPageDone = FlowLink(tgPage, tgClosed)
tgQueueDone = FlowLink(tgQueue, tgClosed)`,
  ],
  stress: [
    `stressFlow = Flowchart([fsA, fsB, fsC, fsD, fsE, fsF, fsG, fsH, fsI, fsGhost], [fsAB, fsAB2, fsBC, fsBD, fsBE, fsBF, fsCG, fsDG, fsEH, fsFH, fsGI, fsHI, fsIA, fsLoop, fsToGhost], "down")
fsA = FlowStep("ONBOARDING_ROUTING_DECISION_FOR_ENTERPRISE_ACCOUNTS_WITH_SSO_ENABLED", "start", "a-very-long-unbroken-detail-token-that-must-be-cut.example.internal")
fsB = FlowStep("Is this a question that a very long human readable sentence can only barely state clearly?", "decision")
fsC = FlowStep("支払いの確認", "step", "東京リージョン")
fsD = FlowStep("📦 Ship it", "step", "line one\\nline two\\nline three that is cut")
fsE = FlowStep("e", "end")
fsF = FlowStep("f", "decision")
fsG = FlowStep("Step with a long human readable name that wraps over two lines and then some more", "step", "", "danger")
fsH = FlowStep("h", "step", "", "strong")
fsI = FlowStep("i", "end", "ignored detail")
fsAB = FlowLink(fsA, fsB)
fsAB2 = FlowLink(fsA, fsB, "a second link between the same two steps")
fsBC = FlowLink(fsB, fsC, "yes")
fsBD = FlowLink(fsB, fsD, "an answer that is long enough to crowd its neighbours", "emphasis")
fsBE = FlowLink(fsB, fsE)
fsBF = FlowLink(fsB, fsF, "no")
fsCG = FlowLink(fsC, fsG)
fsDG = FlowLink(fsD, fsG, "", "dashed")
fsEH = FlowLink(fsE, fsH)
fsFH = FlowLink(fsF, fsH, "maybe")
fsGI = FlowLink(fsG, fsI)
fsHI = FlowLink(fsH, fsI)
fsIA = FlowLink(fsI, fsA, "loop back to the very beginning of the whole process", "dashed")
fsLoop = FlowLink(fsG, fsG, "again")
fsToGhost = FlowLink(fsH, fsGhost, "to a step that hangs off the side")
fsGhost = FlowStep("Side step")`,
    `stressWide = Flowchart([fwOne, fwTwo, fwThree, fwFour, fwFive, fwSix], [fwL1, fwL2, fwL3, fwL4, fwL5], "right")
fwOne = FlowStep("First", "start")
fwTwo = FlowStep("Second step with a long name")
fwThree = FlowStep("Third?", "decision")
fwFour = FlowStep("Fourth step with a long name")
fwFive = FlowStep("Fifth step with a long name")
fwSix = FlowStep("Last", "end")
fwL1 = FlowLink(fwOne, fwTwo)
fwL2 = FlowLink(fwTwo, fwThree)
fwL3 = FlowLink(fwThree, fwFour, "yes")
fwL4 = FlowLink(fwFour, fwFive)
fwL5 = FlowLink(fwFive, fwSix)`,
  ],
});

export default [Flowchart, FlowStep, FlowLink];
