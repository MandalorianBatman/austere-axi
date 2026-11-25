import React from "react";
import { z } from "zod";
import { tagSchemaId } from "@openuidev/react-lang";
import type { RendererArgs } from "../../../types/pack.d.ts";
import { austereComponent } from "../define.ts";
import { FlowView } from "./_flow-view.tsx";
import { FLOW_DIRECTIONS, NODE_TONES, ORG_KINDS } from "./_flow-model.ts";
import type { FlowInput } from "./_flow-model.ts";
import { ORG_CHART } from "./_tree-model.ts";
import guide from "./OrgChart.md";

const nothing = () => null;

// A Person names who they report to, another Person: the schema points at
// itself, so the reference is made by name before the part exists.
const personRef = z.any();
tagSchemaId(personRef, "Person");

function OrgChartView({ props, statementId }: RendererArgs<FlowInput>) {
  return <FlowView props={props} statementId={statementId} kind={ORG_CHART} />;
}

export const Person = austereComponent({
  name: "Person",
  group: "Diagrams",
  tier: "extended",
  props: z.object({
    name: z.string(),
    role: z.string().optional(),
    reportsTo: personRef.optional(),
    kind: z.enum(ORG_KINDS).optional(),
    dotted: personRef.optional(),
    tone: z.enum(NODE_TONES).optional(),
  }),
  description:
    "A person, team or agent in an OrgChart. role: 2 to 4 words of scope, or a handle. reportsTo: the Person above (none for the top). kind: person (default), team, agent or gap (dashed: not set up). dotted: a second Person they answer to. tone strong: the front door. Click target.",
  renderer: nothing,
  slots: null,
  tagged: false,
});

export const OrgChart = austereComponent({
  name: "OrgChart",
  group: "Diagrams",
  tier: "extended",
  family: "Hierarchy",
  keywords: [
    "org chart",
    "organization",
    "organisation",
    "reporting line",
    "reports to",
    "team structure",
    "who owns what",
    "ownership",
    "responsibility",
    "escalation",
    "routing map",
    "agent team",
    "roles",
    "raci",
  ],
  guide,
  limits: [
    {
      prop: "people",
      max: 12,
      message:
        "Draw an overview and one chart for each team: more than 12 nodes hide who owns what.",
    },
  ],
  props: z.object({
    people: z.array(Person.definition.ref),
    direction: z.enum(FLOW_DIRECTIONS).optional(),
  }),
  description:
    "Who owns what, laid out automatically: people, teams or agents under whoever they report to. Each Person names its manager (reportsTo) and may add a dashed dotted-line link. Each Person is its own click target. direction: down (default), right or auto.",
  renderer: OrgChartView,
  example: [
    `teamChart = OrgChart([ogLead, ogApi, ogOps, ogWeb])
ogLead = Person("Dana Reyes", "Engineering lead")
ogApi = Person("Sam Ito", "Backend", ogLead)
ogWeb = Person("Mia Okafor", "Frontend", ogLead)
ogOps = Person("Priya Nair", "Platform", ogLead)`,
    `supportChart = OrgChart([spFront, spBilling, spPlatform, spRefunds, spInvoices, spOncall, spSecurity])
spFront = Person("Triage agent", "front door: every new ticket", null, "agent", null, "strong")
spBilling = Person("Billing", "payments and plans", spFront, "team")
spPlatform = Person("Platform", "outages and APIs", spFront, "team")
spRefunds = Person("Refund agent", "under $200, auto", spBilling, "agent")
spInvoices = Person("Lena Hart", "invoices, tax", spBilling)
spOncall = Person("Omar Said", "on-call engineer", spPlatform, "person", spBilling)
spSecurity = Person("Security on-call", "not set up yet", spFront, "gap")`,
  ],
  stress: [
    `stressOrg = OrgChart([orCeo, orA, orB, orC, orD, orE, orF, orG, orH, orGhostKid, orGhost])
orCeo = Person("A_VERY_LONG_UNBROKEN_NAME_FOR_THE_PERSON_AT_THE_TOP_OF_THE_COMPANY", "a-very-long-unbroken-role-token-that-must-be-cut.example.internal", null, "person", null, "strong")
orA = Person("Head of a department with a long human readable title that wraps", "owns billing, invoicing, refunds and dunning", orCeo, "team")
orB = Person("支払いチーム", "東京リージョン", orCeo, "agent")
orC = Person("📦 Logistics", "", orCeo, "gap")
orD = Person("d", "", orA, "person", orB)
orE = Person("e", "", orA)
orF = Person("f", "", orA)
orG = Person("g", "", orA)
orH = Person("h", "", orA)
orGhostKid = Person("Reports to a person who has no manager", "", orGhost)
orGhost = Person("Ghost")
`,
  ],
});

export default [OrgChart, Person];
