import React from "react";
import { z } from "zod";
import type { RendererArgs } from "../../../types/pack.d.ts";
import { austereComponent } from "../define.ts";
import { FlowView } from "./_flow-view.tsx";
import { FLOW_DIRECTIONS, NODE_TONES, STATE_KINDS, STATE_MACHINE } from "./_flow-model.ts";
import type { FlowInput } from "./_flow-model.ts";
import guide from "./StateMachine.md";

const nothing = () => null;

function StateMachineView({ props, statementId }: RendererArgs<FlowInput>) {
  return <FlowView props={props} statementId={statementId} kind={STATE_MACHINE} />;
}

export const State = austereComponent({
  name: "State",
  group: "Diagrams",
  tier: "extended",
  props: z.object({
    label: z.string(),
    kind: z.enum(STATE_KINDS).optional(),
    detail: z.string().optional(),
    tone: z.enum(NODE_TONES).optional(),
  }),
  description:
    "A state in a StateMachine. kind: state (default, rounded box), initial (filled dot: where it starts) or final (ringed dot: where it ends). detail is monospace, up to 2 lines (entry or exit actions). tone tints it (danger = the error state). Click target.",
  renderer: nothing,
  slots: null,
  tagged: false,
});

export const Transition = austereComponent({
  name: "Transition",
  group: "Diagrams",
  tier: "extended",
  props: z.object({
    from: State.definition.ref,
    to: State.definition.ref,
    event: z.string().optional(),
    guard: z.string().optional(),
    action: z.string().optional(),
  }),
  description:
    "An arrow between two State statements (pass their names, not strings), drawn as `event [guard] / action`. Say what triggers it. from = to draws a self-transition. Leave the event out only for the arrow from an initial or into a final state. Click target.",
  renderer: nothing,
  slots: null,
  tagged: false,
});

export const StateMachine = austereComponent({
  name: "StateMachine",
  group: "Diagrams",
  tier: "extended",
  family: "Flow",
  keywords: [
    "state machine",
    "state diagram",
    "states",
    "transitions",
    "status",
    "lifecycle",
    "fsm",
    "finite state",
    "order status",
    "connection lifecycle",
    "job status",
    "wizard",
  ],
  guide,
  props: z.object({
    states: z.array(State.definition.ref),
    transitions: z.array(Transition.definition.ref),
    direction: z.enum(FLOW_DIRECTIONS).optional(),
  }),
  description:
    "States and the transitions between them, laid out automatically: write no coordinates. Each State and Transition is its own statement and click target. direction auto (default) runs across when that fits the page legibly, else down.",
  renderer: StateMachineView,
  example: [
    `lock = StateMachine([lkStart, lkIdle, lkHeld], [lkFirst, lkAcquire, lkRelease])
lkStart = State("Start", "initial")
lkIdle = State("Idle")
lkHeld = State("Held")
lkFirst = Transition(lkStart, lkIdle)
lkAcquire = Transition(lkIdle, lkHeld, "acquire")
lkRelease = Transition(lkHeld, lkIdle, "release")`,
    `order = StateMachine([odStart, odPending, odPaid, odShipped, odDelivered, odCancelled, odRefunded, odEnd], [odFirst, odPay, odExpire, odShip, odTrack, odDeliver, odRefund, odReturned, odEndDelivered, odEndCancelled, odEndRefunded])
odStart = State("Start", "initial")
odPending = State("Pending", "state", "entry: reserve stock")
odPaid = State("Paid")
odShipped = State("Shipped")
odDelivered = State("Delivered", "state", "", "success")
odCancelled = State("Cancelled", "state", "exit: release stock", "danger")
odRefunded = State("Refunded", "state", "", "warning")
odEnd = State("End", "final")
odFirst = Transition(odStart, odPending)
odPay = Transition(odPending, odPaid, "payment captured")
odExpire = Transition(odPending, odCancelled, "timeout", "after 15 min")
odShip = Transition(odPaid, odShipped, "label printed")
odTrack = Transition(odShipped, odShipped, "tracking update")
odDeliver = Transition(odShipped, odDelivered, "carrier scan")
odRefund = Transition(odPaid, odRefunded, "refund requested", "not shipped", "void label")
odReturned = Transition(odDelivered, odRefunded, "return approved", "within 30 days")
odEndDelivered = Transition(odDelivered, odEnd)
odEndCancelled = Transition(odCancelled, odEnd)
odEndRefunded = Transition(odRefunded, odEnd)`,
  ],
  stress: [
    `stressStates = StateMachine([ssInit, ssWait, ssPay, ssPack, ssShip, ssSent, ssDone, ssLost, ssGhost], [ssT0, ssT1, ssT2, ssT3, ssT4, ssT5, ssT6, ssT7, ssT8, ssT9, ssBare, ssBack, ssToGhost, ssTwice, ssTwice2])
ssInit = State("INITIAL_STATE_WITH_A_VERY_LONG_UNBROKEN_NAME_THAT_MUST_BE_CUT_AT_THE_BOX_EDGE", "initial")
ssWait = State("Awaiting confirmation from the billing service with a long name", "state", "a-very-long-unbroken-detail-token-that-must-be-cut.example.internal")
ssPay = State("支払い待ち", "state", "東京リージョン\\nsecond line\\nthird line that is cut", "danger")
ssPack = State("📦 Packed")
ssShip = State("s4", "state", "", "strong")
ssSent = State("s5")
ssDone = State("s6", "final")
ssLost = State("s7", "final")
ssT0 = Transition(ssInit, ssWait)
ssT1 = Transition(ssWait, ssPay, "an event whose name is long enough to crowd its neighbours", "a guard that is also very long and keeps going", "and then an action")
ssT2 = Transition(ssPay, ssPack, "支払い完了")
ssT3 = Transition(ssPack, ssShip, "pack")
ssT4 = Transition(ssShip, ssSent, "ship")
ssT5 = Transition(ssSent, ssDone)
ssT6 = Transition(ssShip, ssLost, "cancel")
ssT7 = Transition(ssPay, ssPay, "retry", "attempts < 3")
ssT8 = Transition(ssWait, ssWait, "a self transition with a long label that needs room")
ssT9 = Transition(ssSent, ssPay, "bounce")
ssBare = Transition(ssPack, ssPack, "")
ssBack = Transition(ssLost, ssWait, "reopen")
ssToGhost = Transition(ssSent, ssGhost, "to a state that hangs off the side")
ssTwice = Transition(ssWait, ssPack, "first")
ssTwice2 = Transition(ssWait, ssPack, "second")
ssGhost = State("Side state")`,
    `stressDown = StateMachine([sdA, sdB, sdC], [sdAB, sdBC, sdCA], "down")
sdA = State("A", "initial")
sdB = State("B")
sdC = State("C")
sdAB = Transition(sdA, sdB)
sdBC = Transition(sdB, sdC, "go")
sdCA = Transition(sdC, sdA, "reset")`,
  ],
});

export default [StateMachine, State, Transition];
