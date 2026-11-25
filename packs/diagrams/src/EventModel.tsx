import React from "react";
import { z } from "zod";
import { austereComponent } from "austere-axi/pack";
import type { RendererArgs } from "austere-axi/pack";
import { EVENT_KINDS, buildEventModel } from "./_board-model.ts";
import { BoardView } from "./_board-view.tsx";
import guide from "./EventModel.md";

const nothing = () => null;

export const EventItem = austereComponent({
  name: "EventItem",
  group: "Diagrams",
  tier: "extended",
  props: z.object({
    name: z.string(),
    stage: z.string(),
    kind: z.enum(EVENT_KINDS),
    detail: z.string().optional(),
  }),
  description:
    'One part of an EventModel at a stage. kind is "command" (an intent, imperative: Place order), "event" (a fact, past tense: Order placed) or "read-model" (a view: Order list). detail is a line of fields. Click target.',
  renderer: nothing,
  slots: null,
  tagged: false,
});

type EventModelProps = {
  stages?: unknown;
  items?: unknown;
};

function EventModelView({ props, statementId }: RendererArgs<EventModelProps>) {
  const board = React.useMemo(() => buildEventModel(props), [props]);
  return (
    <BoardView
      board={board}
      component="EventModel"
      cardComponent="EventItem"
      name="Event model"
      statementId={statementId}
    />
  );
}

export const EventModel = austereComponent({
  name: "EventModel",
  group: "Diagrams",
  tier: "extended",
  family: "Boards",
  keywords: [
    "event modeling",
    "event model",
    "event storming",
    "command",
    "domain event",
    "read model",
    "projection",
    "event sourcing",
    "cqrs",
    "aggregate",
  ],
  guide,
  limits: [
    {
      prop: "stages",
      max: 6,
      message:
        "EventModel: 6 stages at most. Split a longer scenario into an overview and a detail.",
    },
    {
      prop: "items",
      max: 18,
      message: "EventModel: one command, event and read model for each stage, 18 at most.",
    },
  ],
  props: z.object({
    stages: z.array(z.string()),
    items: z.array(EventItem.definition.ref),
  }),
  description:
    "Commands, events and read models in ordered stages (names, left to right): three rows, one EventItem for each. In a stage the command sits above the event it causes and the read model below. Stage order is scenario order, not time. Each item is a click target.",
  renderer: EventModelView,
  example: [
    `orderModel = EventModel(["Place", "Pay"], [emPlace, emPlaced, emList, emPay, emPaid])
emPlace = EventItem("Place order", "Place", "command")
emPlaced = EventItem("Order placed", "Place", "event")
emList = EventItem("Open orders", "Place", "read-model")
emPay = EventItem("Pay order", "Pay", "command")
emPaid = EventItem("Order paid", "Pay", "event")`,
    `refundModel = EventModel(["Request", "Approve", "Pay out", "Report"], [erA, erB, erC, erD, erE, erF, erG, erH, erI])
erA = EventItem("Request refund", "Request", "command", "orderId, reason")
erB = EventItem("Refund requested", "Request", "event", "refundId")
erC = EventItem("Pending refunds", "Request", "read-model")
erD = EventItem("Approve refund", "Approve", "command", "refundId, agent")
erE = EventItem("Refund approved", "Approve", "event")
erF = EventItem("Pay out refund", "Pay out", "command")
erG = EventItem("Refund paid", "Pay out", "event", "amount, method")
erH = EventItem("Refund history", "Report", "read-model")
erI = EventItem("Refund total by month", "Report", "read-model")`,
  ],
  stress: [
    `stressEvents = EventModel(["STAGE_WITH_A_VERY_LONG_UNBROKEN_NAME_THAT_MUST_WRAP_OR_BE_CUT", "支払い"], [exA, exB, exC, exD])
exA = EventItem("A_COMMAND_NAME_WITH_A_VERY_LONG_UNBROKEN_TOKEN_THAT_MUST_WRAP_OR_BE_CUT_AT_THE_EDGE", "STAGE_WITH_A_VERY_LONG_UNBROKEN_NAME_THAT_MUST_WRAP_OR_BE_CUT", "command", "field_one, field_two_with_a_very_long_unbroken_token_that_must_be_cut")
exB = EventItem("東京リージョンの切り替え", "支払い", "event")
exC = EventItem("Read", "支払い", "read-model")
exD = EventItem("Second command in the same cell", "支払い", "event")`,
  ],
});

export default [EventModel, EventItem];
