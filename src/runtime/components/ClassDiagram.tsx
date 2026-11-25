import React from "react";
import { z } from "zod";
import type { RendererArgs } from "../../../types/pack.d.ts";
import { austereComponent } from "../define.ts";
import { FlowView } from "./_flow-view.tsx";
import { FLOW_DIRECTIONS, NODE_TONES } from "./_flow-model.ts";
import type { FlowInput } from "./_flow-model.ts";
import { CLASS_KINDS } from "./_data-parse.ts";
import { CLASS_DIAGRAM, LINK_KINDS, MAX_CLASSES, MAX_LINKS } from "./_data-model.ts";
import guide from "./ClassDiagram.md";

const nothing = () => null;

function ClassDiagramView({ props, statementId }: RendererArgs<FlowInput>) {
  return <FlowView props={props} statementId={statementId} kind={CLASS_DIAGRAM} />;
}

export const ClassBox = austereComponent({
  name: "ClassBox",
  group: "Diagrams",
  tier: "extended",
  props: z.object({
    name: z.string(),
    members: z.array(z.string()).optional(),
    kind: z.enum(CLASS_KINDS).optional(),
    tone: z.enum(NODE_TONES).optional(),
  }),
  description:
    'A class in a ClassDiagram: its name and one line for each member, as UML writes it: "-id: UUID", "+charge(amount): Receipt". Operations (with "(") draw below a rule. kind: class (default), interface, abstract, enum. Click target; so is each member line.',
  renderer: nothing,
  slots: null,
  tagged: false,
});

export const ClassLink = austereComponent({
  name: "ClassLink",
  group: "Diagrams",
  tier: "extended",
  props: z.object({
    from: ClassBox.definition.ref,
    to: ClassBox.definition.ref,
    kind: z.enum(LINK_KINDS).optional(),
    label: z.string().optional(),
    fromMultiplicity: z.string().optional(),
    toMultiplicity: z.string().optional(),
  }),
  description:
    "A relationship between two ClassBox statements (pass names). kind: association (default), inheritance and realization (from = child, to = parent), composition and aggregation (from = owner), dependency. Multiplicities: 1, 0..1, 0..*, 1..*. Click target.",
  renderer: nothing,
  slots: null,
  tagged: false,
});

export const ClassDiagram = austereComponent({
  name: "ClassDiagram",
  group: "Diagrams",
  tier: "extended",
  family: "Data model",
  keywords: [
    "class diagram",
    "uml",
    "uml class",
    "classes",
    "object model",
    "inheritance",
    "interface",
    "implements",
    "extends",
    "composition",
    "aggregation",
    "methods",
    "attributes",
    "domain classes",
  ],
  guide,
  limits: [
    {
      prop: "classes",
      max: MAX_CLASSES,
      message: "Split it by package into two diagrams.",
    },
    {
      prop: "links",
      max: MAX_LINKS,
      message: "Split it by package into two diagrams.",
    },
  ],
  props: z.object({
    classes: z.array(ClassBox.definition.ref),
    links: z.array(ClassLink.definition.ref),
    direction: z.enum(FLOW_DIRECTIONS).optional(),
  }),
  description:
    "Classes and interfaces with their members, joined by typed relationships, laid out automatically: write no coordinates. Parents sit above their children. Each ClassBox, each member line and each ClassLink is its own click target. direction: auto (default), down or right.",
  renderer: ClassDiagramView,
  example: [
    `shapes = ClassDiagram([cdShape, cdCircle, cdSquare], [cdCircleIs, cdSquareIs])
cdShape = ClassBox("Shape", ["+area(): float"], "interface")
cdCircle = ClassBox("Circle", ["-radius: float", "+area(): float"])
cdSquare = ClassBox("Square", ["-side: float", "+area(): float"])
cdCircleIs = ClassLink(cdCircle, cdShape, "realization")
cdSquareIs = ClassLink(cdSquare, cdShape, "realization")`,
    `payments = ClassDiagram([pyOrder, pyLine, pyCustomer, pyGateway, pyStripe, pyBank, pyReceipt], [pyHas, pyOwns, pyPlaced, pyUses, pyStripeIs, pyBankIs, pyIssues, pyCharges])
pyOrder = ClassBox("Order", ["-id: UUID", "-status: OrderStatus", "+total(): Money", "+pay(gateway): Receipt"], "class", "strong")
pyLine = ClassBox("OrderLine", ["-sku: string", "-quantity: int"])
pyCustomer = ClassBox("Customer", ["-email: string"])
pyGateway = ClassBox("PaymentGateway", ["+charge(amount): Receipt", "+refund(receipt): void"], "interface")
pyStripe = ClassBox("StripeGateway", ["-apiKey: string", "+charge(amount): Receipt"])
pyBank = ClassBox("BankTransfer", ["-iban: string", "+charge(amount): Receipt"])
pyReceipt = ClassBox("Receipt", ["-reference: string", "-paidAt: Date"])
pyHas = ClassLink(pyOrder, pyLine, "composition", "", "1", "1..*")
pyOwns = ClassLink(pyCustomer, pyOrder, "association", "places", "1", "0..*")
pyPlaced = ClassLink(pyOrder, pyCustomer, "dependency", "notifies")
pyUses = ClassLink(pyOrder, pyGateway, "dependency", "pays through")
pyStripeIs = ClassLink(pyStripe, pyGateway, "realization")
pyBankIs = ClassLink(pyBank, pyGateway, "realization")
pyIssues = ClassLink(pyGateway, pyReceipt, "association", "returns", "", "1")
pyCharges = ClassLink(pyOrder, pyReceipt, "aggregation")`,
  ],
  stress: [
    `stressClasses = ClassDiagram([scBase, scA, scB, scEnum, scAbs, scEmpty, scGhostKid], [scAIs, scBIs, scEnumUse, scSelf, scAbsIs, scBare, scToGhost])
scBase = ClassBox("BASE_CLASS_WITH_A_VERY_LONG_UNBROKEN_NAME_THAT_MUST_BE_CUT_AT_THE_BOX_EDGE", ["-a_very_long_unbroken_attribute_name_that_must_be_cut_at_the_edge_of_the_box: SomeVeryLongTypeName<WithGenerics, AndMore>", "+anOperationWithManyParameters(first: int, second: string, third: Map<string, List<int>>, fourth: bool): Result<Receipt, Error>", "", "+支払い(): void", "+getName(): string", "+setName(name): void"], "abstract")
scA = ClassBox("A", ["-a1: int", "-a2: int", "-a3: int", "-a4: int", "-a5: int", "-a6: int", "-a7: int", "+m1(): void", "+m2(): void", "+m3(): void", "+m4(): void", "+m5(): void", "+m6(): void"])
scB = ClassBox("Order management with a long human readable name", ["#protectedField: int"], "class", "danger")
scEnum = ClassBox("Status", ["PENDING", "PAID", "SHIPPED", "A_VALUE_WITH_A_VERY_LONG_UNBROKEN_NAME_THAT_MUST_BE_CUT_AT_THE_EDGE"], "enum")
scAbs = ClassBox("Marker", [], "interface")
scEmpty = ClassBox("Empty")
scAIs = ClassLink(scA, scBase, "inheritance")
scBIs = ClassLink(scB, scBase, "inheritance", "a label that is very long and keeps going so that it needs more than one line", "0..*", "1")
scEnumUse = ClassLink(scA, scEnum, "association", "status", "1", "1")
scSelf = ClassLink(scB, scB, "composition", "children", "1", "0..*")
scAbsIs = ClassLink(scEmpty, scAbs, "realization")
scBare = ClassLink(scEmpty, scA)
scToGhost = ClassLink(scB, scGhostKid, "dependency", "points at a class that is not listed")
scGhostKid = ClassBox("Unlisted", ["+run(): void"])`,
    `stressClassRight = ClassDiagram([clsRtA, clsRtB, clsRtC], [clsRtAB, clsRtBC], "right")
clsRtA = ClassBox("A", ["+go(): void"])
clsRtB = ClassBox("B", ["+go(): void"])
clsRtC = ClassBox("C", ["+go(): void"])
clsRtAB = ClassLink(clsRtB, clsRtA, "inheritance")
clsRtBC = ClassLink(clsRtC, clsRtB, "inheritance")`,
  ],
});

export default [ClassDiagram, ClassBox, ClassLink];
