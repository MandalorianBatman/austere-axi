import React from "react";
import { z } from "zod";
import type { RendererArgs } from "../../../types/pack.d.ts";
import { austereComponent } from "../define.ts";
import { FlowView } from "./_flow-view.tsx";
import { FLOW_DIRECTIONS, NODE_TONES } from "./_flow-model.ts";
import type { FlowInput } from "./_flow-model.ts";
import { ER_DIAGRAM } from "./_data-model.ts";
import guide from "./ERDiagram.md";

const nothing = () => null;

function ERDiagramView({ props, statementId }: RendererArgs<FlowInput>) {
  return <FlowView props={props} statementId={statementId} kind={ER_DIAGRAM} />;
}

export const Entity = austereComponent({
  name: "Entity",
  group: "Diagrams",
  tier: "extended",
  props: z.object({
    name: z.string(),
    fields: z.array(z.string()).optional(),
    tone: z.enum(NODE_TONES).optional(),
  }),
  description:
    'An entity in an ERDiagram: a box with its name and one line for each field, written like "id uuid pk", "email text unique", "user_id uuid fk users.id" (name, type, then pk, fk, unique, index, nn). tone strong = the central entity. Click target; so is each field line.',
  renderer: nothing,
  slots: null,
  tagged: false,
});

export const Relation = austereComponent({
  name: "Relation",
  group: "Diagrams",
  tier: "extended",
  props: z.object({
    from: Entity.definition.ref,
    to: Entity.definition.ref,
    cardinality: z.string().optional(),
    label: z.string().optional(),
  }),
  description:
    'A line between two Entity statements (pass their names, not strings). cardinality reads from to: "1:1", "1:N", "N:1", "N:M", or with 0..1 and 1..* ("1:0..*"); it is drawn as crow\'s foot marks at each end. label is the verb ("places"). Click target.',
  renderer: nothing,
  slots: null,
  tagged: false,
});

export const ERDiagram = austereComponent({
  name: "ERDiagram",
  group: "Diagrams",
  tier: "extended",
  family: "Data model",
  keywords: [
    "er diagram",
    "erd",
    "entity relationship",
    "data model",
    "domain model",
    "entities",
    "cardinality",
    "one to many",
    "many to many",
    "relations",
    "schema",
    "resources",
    "api resources",
  ],
  guide,
  props: z.object({
    entities: z.array(Entity.definition.ref),
    relations: z.array(Relation.definition.ref),
    direction: z.enum(FLOW_DIRECTIONS).optional(),
  }),
  description:
    "Entities with their fields, joined by relations with cardinality, laid out automatically: write no coordinates. Each Entity, each of its field lines, and each Relation is its own click target. direction auto (default) runs across when that fits the page legibly, else down.",
  renderer: ERDiagramView,
  example: [
    `shop = ERDiagram([shCustomer, shOrder], [shPlaces])
shCustomer = Entity("Customer", ["id", "email", "name"])
shOrder = Entity("Order", ["id", "placed_at", "total"])
shPlaces = Relation(shCustomer, shOrder, "1:N", "places")`,
    `billing = ERDiagram([bgAccount, bgUser, bgSub, bgPlan, bgInvoice, bgLine], [bgHas, bgOwns, bgOn, bgBills, bgContains, bgPriced])
bgAccount = Entity("Account", ["id uuid pk", "name text nn", "created_at timestamptz"], "strong")
bgUser = Entity("User", ["id uuid pk", "account_id uuid fk Account.id", "email text unique"])
bgSub = Entity("Subscription", ["id uuid pk", "account_id uuid fk Account.id", "plan_id uuid fk Plan.id", "status text nn"])
bgPlan = Entity("Plan", ["id uuid pk", "name text unique", "monthly_cents int nn"])
bgInvoice = Entity("Invoice", ["id uuid pk", "subscription_id uuid fk Subscription.id", "issued_at timestamptz", "paid bool"])
bgLine = Entity("InvoiceLine", ["id uuid pk", "invoice_id uuid fk Invoice.id", "amount_cents int nn"])
bgHas = Relation(bgAccount, bgUser, "1:0..*", "has")
bgOwns = Relation(bgAccount, bgSub, "1:N", "owns")
bgOn = Relation(bgSub, bgPlan, "N:1", "is on")
bgBills = Relation(bgSub, bgInvoice, "1:N", "bills")
bgContains = Relation(bgInvoice, bgLine, "1:1..*", "contains")
bgPriced = Relation(bgPlan, bgLine, "N:M", "prices")`,
  ],
  stress: [
    `stressEr = ERDiagram([seA, seB, seC, seD, seGhostKid], [seAB, seBC, seCA, seSelf, seBad, seNone, seToGhost])
seA = Entity("ENTITY_WITH_A_VERY_LONG_UNBROKEN_NAME_THAT_MUST_BE_CUT_AT_THE_BOX_EDGE", ["a_very_long_unbroken_field_name_that_must_be_cut_at_the_column text_with_a_long_type pk unique index nn", "id uuid pk", "支払い text", "📦 emoji text", "", "numeric_with_params numeric(12, 2) fk accounts.id", "x"], "strong")
seB = Entity("Orders and everything about how an order moves through the warehouse", ["f1 text", "f2 text", "f3 text", "f4 text", "f5 text", "f6 text", "f7 text", "f8 text", "f9 text", "f10 text", "f11 text", "f12 text", "f13 text", "f14 text"])
seC = Entity("Empty")
seD = Entity("c", ["- bullet field text", "* another bullet uuid pk", "primary_key_word uuid primary key", "nullable text not null"], "danger")
seAB = Relation(seA, seB, "1:N", "a label that is very long and keeps going so that it needs two lines or three to fit")
seBC = Relation(seB, seC, "N:M")
seCA = Relation(seC, seA, "0..1:1..*", "back")
seSelf = Relation(seD, seD, "1:N", "manages")
seBad = Relation(seA, seD, "0..1:1..*", "optional on one side, at least one on the other")
seNone = Relation(seD, seB)
seToGhost = Relation(seB, seGhostKid, "1:N", "points at an entity that is not listed")
seGhostKid = Entity("Unlisted", ["id uuid pk"])`,
    `stressErDown = ERDiagram([erdDnA, erdDnB, erdDnC], [erdDnAB, erdDnBC], "down")
erdDnA = Entity("A", ["id"])
erdDnB = Entity("B", ["id", "a_id fk A.id"])
erdDnC = Entity("C", ["id", "b_id fk B.id"])
erdDnAB = Relation(erdDnA, erdDnB, "1:N")
erdDnBC = Relation(erdDnB, erdDnC, "1:N")`,
  ],
});

export default [ERDiagram, Entity, Relation];
