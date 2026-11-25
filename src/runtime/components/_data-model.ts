// ERDiagram and ClassDiagram: what differs from the flow model (`_flow-model.ts`),
// which they share for layout and drawing. An entity or class is a node with
// lines of text in it; a relation or link is an edge with a mark at each end.
// Free of JSX and DOM so it can be unit-tested in Node. Never throws on agent input.
import { CLASS_KINDS, ENTITY_KINDS, isOperation, parseCardinality } from "./_data-parse.ts";
import type { EdgeEnds, EndMark } from "./_data-parse.ts";
import { str } from "./_flow-model.ts";
import type { FlowEdgeStyle, FlowKind, FlowModel, FlowNote } from "./_flow-model.ts";

export const LINK_KINDS = [
  "inheritance",
  "realization",
  "composition",
  "aggregation",
  "association",
  "dependency",
] as const;
export type LinkKind = (typeof LINK_KINDS)[number];

/** Upstream limits (type-er.md gives none; type-uml-class.md, "Complexity budget"). */
export const MAX_FIELDS_SHOWN = 12;
export const MAX_CLASSES = 7;
export const MAX_LINKS = 8;
export const MAX_MEMBERS = 5;

// ── ERDiagram ──

function relationEnds(p: Record<string, unknown>, from: string, to: string) {
  const text = str(p.cardinality).trim();
  const label = str(p.label).trim();
  const parsed = text ? parseCardinality(text) : null;
  const ends: EdgeEnds = {
    fromMark: parsed?.from ?? "",
    toMark: parsed?.to ?? "",
    fromText: "",
    toText: "",
    part: `${from} → ${to}${label ? ` (${label})` : ""}`,
  };
  return {
    style: "solid" as FlowEdgeStyle,
    swap: false,
    ends,
    problem:
      text && !parsed
        ? `cardinality ${JSON.stringify(text)} is not one of 1:1, 1:N, N:1, N:M (or with 0..1, 1..*). The relation is drawn with no marks.`
        : undefined,
  };
}

export const ER_DIAGRAM: FlowKind = {
  component: "ERDiagram",
  title: "ER diagram",
  nodeName: "Entity",
  edgeName: "Relation",
  nodesProp: "entities",
  edgesProp: "relations",
  kinds: ENTITY_KINDS,
  defaultShape: "entity",
  defaultDirection: "auto",
  labelProp: "name",
  linesProp: "fields",
  edgeLabel: (p) => str(p.label).trim(),
  edgeEnds: relationEnds,
  notes: (model) => dataNotes(model, "ERDiagram", erNotes(model)),
};

function erNotes(model: FlowModel): string[] {
  const out: string[] = [];
  // A cardinality that did not read is already a problem of its own.
  const bare = model.edges.filter(
    (e) =>
      !e.ends?.fromMark &&
      !model.problems.some((p) => p.startsWith(`Relation ${e.id}: cardinality`)),
  );
  const label = (id: string) => model.nodes.find((n) => n.id === id)?.label ?? id;
  if (bare.length)
    out.push(
      `${bare.length} relation${bare.length === 1 ? "" : "s"} with no cardinality (${bare
        .slice(0, 3)
        .map((e) => `${label(e.from)} → ${label(e.to)}`)
        .join(", ")}${bare.length > 3 ? ", …" : ""}). Say 1:1, 1:N or N:M so the line carries it.`,
    );
  for (const n of model.nodes)
    if (n.lines.length > MAX_FIELDS_SHOWN)
      out.push(
        `Entity "${n.label}" has ${n.lines.length} fields, over ${MAX_FIELDS_SHOWN}. Show the ones the model is about.`,
      );
  return out;
}

// ── ClassDiagram ──

interface LinkSpec {
  /** The layout runs the arrow from the parent down to the child, so the parent sits above. */
  swap: boolean;
  style: FlowEdgeStyle;
  /** The mark at the layout's first end, and at its second. */
  start: EndMark | "";
  end: EndMark | "";
  /** What the sentence says: `A extends B`. */
  verb: string;
}

const LINKS: Record<LinkKind, LinkSpec> = {
  inheritance: { swap: true, style: "solid", start: "triangle", end: "", verb: "extends" },
  realization: { swap: true, style: "dashed", start: "triangle", end: "", verb: "implements" },
  composition: { swap: false, style: "solid", start: "diamond", end: "", verb: "owns" },
  aggregation: { swap: false, style: "solid", start: "diamond-open", end: "", verb: "has" },
  association: { swap: false, style: "solid", start: "", end: "open", verb: "→" },
  dependency: { swap: false, style: "dashed", start: "", end: "open", verb: "uses" },
};

const isLinkKind = (v: unknown): v is LinkKind => (LINK_KINDS as readonly unknown[]).includes(v);

function linkEnds(p: Record<string, unknown>, from: string, to: string) {
  const spec = LINKS[isLinkKind(p.kind) ? p.kind : "association"];
  const label = str(p.label).trim();
  const a = str(p.fromMultiplicity).trim();
  const b = str(p.toMultiplicity).trim();
  const ends: EdgeEnds = {
    fromMark: spec.start,
    toMark: spec.end,
    // Multiplicities are written from → to; the layout may run the link the other way.
    fromText: spec.swap ? b : a,
    toText: spec.swap ? a : b,
    part: `${from} ${spec.verb} ${to}${label ? ` (${label})` : ""}`,
  };
  return { style: spec.style, swap: spec.swap, ends };
}

export const CLASS_DIAGRAM: FlowKind = {
  component: "ClassDiagram",
  title: "Class diagram",
  nodeName: "ClassBox",
  edgeName: "ClassLink",
  nodesProp: "classes",
  edgesProp: "links",
  kinds: CLASS_KINDS,
  defaultShape: "class",
  defaultDirection: "auto",
  labelProp: "name",
  linesProp: "members",
  edgeLabel: (p) => str(p.label).trim(),
  edgeEnds: linkEnds,
  notes: (model) => dataNotes(model, "ClassDiagram", classNotes(model)),
};

const accessor = /^[+\-#~]?\s*(get|set)[A-Z_]\w*\s*\(/;

function classNotes(model: FlowModel): string[] {
  const out: string[] = [];
  for (const n of model.nodes) {
    const ops = n.lines.filter(isOperation);
    const attrs = n.lines.filter((l) => !isOperation(l));
    for (const [what, list] of [
      ["attributes", attrs],
      ["operations", ops],
    ] as const)
      if (n.shape !== "enum" && list.length > MAX_MEMBERS)
        out.push(
          `Class "${n.label}" has ${list.length} ${what}, over ${MAX_MEMBERS}. Show the ones that matter; a class diagram is an argument, not a header file.`,
        );
    const accessors = ops.filter((l) => accessor.test(l.trim()));
    if (accessors.length)
      out.push(
        `Class "${n.label}" lists getters or setters (${accessors[0].trim()}). They are noise: show the behavior that matters.`,
      );
  }
  const bare = model.edges.filter(
    (e) => e.ends?.toMark === "open" && e.style === "solid" && !e.ends.fromText && !e.ends.toText,
  );
  if (bare.length)
    out.push(
      `${bare.length} association${bare.length === 1 ? "" : "s"} with no multiplicity. Say 1, 0..* or 1..* at the ends.`,
    );
  const hasInheritance = model.edges.some((e) => e.ends?.fromMark === "triangle");
  const hasOperations = model.nodes.some((n) => n.lines.some(isOperation));
  if (model.nodes.length && !hasInheritance && !hasOperations)
    out.push(
      "No inheritance and no operations: this is a data model. Use ERDiagram (or the DatabaseSchema recipe).",
    );
  return out;
}

// ── Shared ──

function dataNotes(model: FlowModel, component: string, messages: string[]): FlowNote[] {
  const strong = model.nodes.filter((n) => n.tone === "strong");
  const all = [...messages];
  if (strong.length > 1)
    all.push(
      `${strong.length} boxes have tone "strong" (${strong.map((n) => n.label).join(", ")}). Mark the one that is the point: with several, none stands out.`,
    );
  return all.map((message) => ({ code: "flow", message: `${component}: ${message}` }));
}
