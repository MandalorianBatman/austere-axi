// Flowchart and StateMachine: the parsed OpenUI props → a graph of shaped nodes
// → an automatic dagre layout (Architecture's engine, with shapes of their
// own). Free of JSX and DOM so it can be unit-tested in Node. Never throws on
// agent input.
import {
  DEFAULT_TARGET_WIDTH,
  LEGIBLE_SCALE,
  NODE_TONES,
  SIZES,
  detailLinesFor,
  runLayout,
  scaleAt,
  textWidth,
  wrapText,
} from "./_architecture-model.ts";
import type {
  LaidOutEdge,
  LaidOutNode,
  Model,
  ModelNode,
  NodeSize,
  NodeTone,
  Point,
} from "./_architecture-model.ts";

export { NODE_TONES };
export const FLOW_KINDS = ["step", "decision", "start", "end"] as const;
export const STATE_KINDS = ["state", "initial", "final"] as const;
export const ORG_KINDS = ["person", "team", "agent", "gap"] as const;
export const FLOW_LINK_STYLES = ["dashed", "emphasis"] as const;
export const FLOW_DIRECTIONS = ["down", "right", "auto"] as const;

export type Shape =
  | (typeof FLOW_KINDS)[number]
  | (typeof STATE_KINDS)[number]
  | (typeof ORG_KINDS)[number];
export type FlowDirection = (typeof FLOW_DIRECTIONS)[number];
export type FlowEdgeStyle = "solid" | (typeof FLOW_LINK_STYLES)[number];

/** The parsed props of Flowchart(steps, links, direction?) and StateMachine(states, transitions, direction?). */
export type FlowInput = Record<string, unknown>;

export interface FlowNode {
  id: string;
  named: boolean;
  label: string;
  shape: Shape;
  detail: string;
  tone: NodeTone | "";
}

export interface FlowEdge {
  id: string;
  named: boolean;
  from: string;
  to: string;
  label: string;
  style: FlowEdgeStyle;
}

export interface FlowModel {
  nodes: FlowNode[];
  edges: FlowEdge[];
  direction: FlowDirection;
  problems: string[];
}

/** What differs between the diagram types. */
export interface FlowKind {
  /** The component the agent wrote, for messages. */
  component: "Flowchart" | "StateMachine" | "Tree" | "OrgChart";
  /** What the diagram is called to a reader (the frame's name, the aria label). */
  title: string;
  /** What its node and edge parts are called, for messages. */
  nodeName: string;
  edgeName: string;
  /** The props that hold the node list and the edge list. */
  nodesProp: string;
  edgesProp: string;
  kinds: readonly Shape[];
  defaultShape: Shape;
  defaultDirection: FlowDirection;
  /** The text of an edge from its props: the answer of a decision, or `event [guard] / action`. */
  edgeLabel: (props: Record<string, unknown>) => string;
  /** Builds the model itself, for types whose edges are not statements (Tree, OrgChart: a parent link on the child). */
  build?: (props: FlowInput | null | undefined, kind: FlowKind) => FlowModel;
  /** A hierarchy: right-angle connectors with no arrowheads, and lines that are not click targets. */
  hierarchy?: boolean;
  /** What `check` says about a built model, for types with a `build`. */
  notes?: (model: FlowModel, kind: FlowKind) => FlowNote[];
}

function transitionLabel(p: Record<string, unknown>): string {
  const event = str(p.event).trim();
  const guard = str(p.guard).trim();
  const action = str(p.action).trim();
  return [event, guard ? `[${guard}]` : "", action ? `/ ${action}` : ""].filter(Boolean).join(" ");
}

export const FLOWCHART: FlowKind = {
  component: "Flowchart",
  title: "Flowchart",
  nodeName: "FlowStep",
  edgeName: "FlowLink",
  nodesProp: "steps",
  edgesProp: "links",
  kinds: FLOW_KINDS,
  defaultShape: "step",
  defaultDirection: "down",
  edgeLabel: (p) => str(p.label).trim(),
};

export const STATE_MACHINE: FlowKind = {
  component: "StateMachine",
  title: "State machine",
  nodeName: "State",
  edgeName: "Transition",
  nodesProp: "states",
  edgesProp: "transitions",
  kinds: STATE_KINDS,
  defaultShape: "state",
  defaultDirection: "auto",
  edgeLabel: transitionLabel,
};

export interface ElementLike {
  props: Record<string, unknown>;
  statementId?: string;
}

export const isElement = (v: unknown): v is ElementLike =>
  !!v && typeof v === "object" && "props" in v && !!v.props && typeof v.props === "object";
export const str = (v: unknown): string => (typeof v === "string" ? v : v == null ? "" : String(v));
export const oneOf = <T extends string>(list: readonly T[], v: unknown): v is T =>
  (list as readonly unknown[]).includes(v);

/**
 * Id of an unnamed node or edge. Statement names are identifiers, so a "#"
 * cannot collide with one.
 */
export const syntheticId = (what: "node" | "edge", n: number): string => `#${what}${n}`;

/**
 * Parsed props → model. Ids are statement names; an inline (unnamed) node or
 * edge gets a synthetic id and is not a separate click target. A node an edge
 * names but the list leaves out is added, with a problem.
 */
export function buildFlow(props: FlowInput | null | undefined, kind: FlowKind): FlowModel {
  if (kind.build) return kind.build(props, kind);
  const problems: string[] = [];
  const nodes = new Map<string, FlowNode>();
  const seenEls = new Map<ElementLike, string>();
  let anon = 0;

  const addNode = (el: unknown): string | null => {
    if (!isElement(el)) return null;
    const seen = seenEls.get(el);
    if (seen !== undefined) return seen;
    const id = el.statementId || syntheticId("node", anon++);
    if (!nodes.has(id)) {
      const p = el.props;
      nodes.set(id, {
        id,
        named: !!el.statementId,
        label: str(p.label).trim() || id,
        shape: oneOf(kind.kinds, p.kind) ? p.kind : kind.defaultShape,
        detail: str(p.detail).trim(),
        tone: oneOf(NODE_TONES, p.tone) ? p.tone : "",
      });
    }
    seenEls.set(el, id);
    return id;
  };

  const nodeList = props?.[kind.nodesProp];
  for (const el of Array.isArray(nodeList) ? nodeList : []) addNode(el);
  const listed = new Set(nodes.keys());

  const edges: FlowEdge[] = [];
  const edgeIds = new Set<string>();
  const edgeList = props?.[kind.edgesProp];
  for (const el of Array.isArray(edgeList) ? edgeList : []) {
    if (!isElement(el)) continue;
    const id = el.statementId || syntheticId("edge", anon++);
    if (edgeIds.has(id)) continue;
    const from = addNode(el.props.from);
    const to = addNode(el.props.to);
    if (!from || !to) continue; // the parser already reports the missing end
    for (const end of [from, to]) {
      if (listed.has(end)) continue;
      listed.add(end);
      problems.push(
        `${kind.edgeName} ${id} uses ${end}, which is not in the ${kind.component} list. It is drawn anyway; list every ${kind.nodeName}.`,
      );
    }
    edgeIds.add(id);
    edges.push({
      id,
      named: !!el.statementId,
      from,
      to,
      label: kind.edgeLabel(el.props),
      style: oneOf(FLOW_LINK_STYLES, el.props.style) ? el.props.style : "solid",
    });
  }

  const wanted = props?.direction;
  const direction = oneOf(FLOW_DIRECTIONS, wanted) ? wanted : kind.defaultDirection;
  return { nodes: [...nodes.values()], edges, direction, problems };
}

// ── Shapes and their boxes ──

const LABEL = SIZES.label;
/** Boxes of the dot shapes: a click target big enough for a thumb, the mark drawn inside. */
export const DOT_BOX = 28;
export const DOT_R = 7;
export const RING_R = 10;
const PAD = 14;

export interface ShapeBox extends NodeSize {
  shape: Shape;
}

/** Size a node box by its shape. Text stays inside the box; a diamond is sized so its corners clear the text. */
export function sizeShape(node: FlowNode): ShapeBox {
  const none = { labelLines: [], detailLines: [], tagLine: "", tagRow: 0 };
  switch (node.shape) {
    case "initial":
    case "final":
      return { ...none, shape: node.shape, width: DOT_BOX, height: DOT_BOX };
    case "start":
    case "end": {
      const width = Math.min(200, Math.max(84, textWidth(node.label, LABEL) + 40));
      const labelLines = wrapText(node.label, LABEL, width - 32, 1);
      return { ...none, shape: node.shape, width, height: 34, labelLines };
    }
    case "decision": {
      // The text sits in the middle rectangle of the diamond: twice its size clears the corners.
      const labelLines = wrapText(node.label, LABEL, 112, 3);
      const w = Math.max(...labelLines.map((l) => textWidth(l, LABEL)));
      return {
        ...none,
        shape: node.shape,
        width: Math.max(140, Math.ceil(2 * w) + 24),
        height: Math.max(68, labelLines.length * 17 * 2 + 14),
        labelLines,
      };
    }
    default: {
      const natural = Math.max(
        textWidth(node.label, LABEL),
        ...node.detail.split("\n").map((t) => textWidth(t.trim(), SIZES.detail, true)),
      );
      const width = Math.min(SIZES.nodeMaxW, Math.max(SIZES.nodeMinW, natural + PAD * 2));
      const labelLines = wrapText(node.label, LABEL, width - PAD * 2, 2);
      const detailLines = detailLinesFor(node.detail, width - PAD * 2);
      const height =
        16 + labelLines.length * 17 + detailLines.length * 15 + (detailLines.length ? 1 : 0) + 8;
      return { ...none, shape: node.shape, width, height, labelLines, detailLines };
    }
  }
}

// ── Layout ──

export interface FlowLaidOutNode extends LaidOutNode {
  shape: Shape;
}

export interface FlowLayout {
  rankdir: string;
  nodes: FlowLaidOutNode[];
  edges: LaidOutEdge[];
  width: number;
  height: number;
}

/** Where the line from a shape's centre toward `toward` leaves the shape itself (dagre clips at the box); box shapes keep dagre's `end`. */
function clip(n: FlowLaidOutNode, end: Point, toward: Point): Point {
  const cx = n.x + n.width / 2;
  const cy = n.y + n.height / 2;
  const dx = toward.x - cx;
  const dy = toward.y - cy;
  if (!dx && !dy) return { x: cx, y: cy };
  let t: number;
  if (n.shape === "decision")
    t = 1 / (Math.abs(dx) / (n.width / 2) + Math.abs(dy) / (n.height / 2));
  else if (n.shape === "initial") t = DOT_R / Math.hypot(dx, dy);
  else if (n.shape === "final") t = RING_R / Math.hypot(dx, dy);
  else return end;
  return { x: cx + dx * t, y: cy + dy * t };
}

function runFlow(model: FlowModel, rankdir: "LR" | "TB"): FlowLayout {
  const shapes = new Map<string, FlowNode>(model.nodes.map((n) => [n.id, n]));
  const asModel: Model = {
    nodes: model.nodes.map((n): ModelNode => ({
      id: n.id,
      named: n.named,
      label: n.label,
      kind: "backend",
      detail: n.detail,
      tag: "",
      tone: n.tone,
      row: null,
    })),
    edges: model.edges.map((e) => ({
      id: e.id,
      named: e.named,
      from: e.from,
      to: e.to,
      label: e.label,
      style: "solid",
      tone: "",
    })),
    groups: [],
    direction: "auto",
    problems: [],
  };
  const layout = runLayout(asModel, rankdir, (n) => sizeShape(shapes.get(n.id) as FlowNode));
  const nodes: FlowLaidOutNode[] = layout.nodes.map((n) => ({
    ...n,
    shape: (shapes.get(n.id) as FlowNode).shape,
  }));
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const edges = layout.edges.map((e, i): LaidOutEdge => {
    const style = model.edges[i].style;
    const pts = e.points;
    if (e.from === e.to || pts.length < 2) return { ...e, style };
    const points = [...pts];
    points[0] = clip(byId.get(e.from) as FlowLaidOutNode, pts[0], pts[1]);
    points[points.length - 1] = clip(
      byId.get(e.to) as FlowLaidOutNode,
      pts[pts.length - 1],
      pts[pts.length - 2],
    );
    return { ...e, style, points };
  });
  return { rankdir, nodes, edges, width: layout.width, height: layout.height };
}

/**
 * Lay out a model. direction "down" or "right" forces it; "auto" runs across
 * while its text stays legible at `targetWidth`, else down (a long page is
 * cheap to scroll; shrunken text is not), and when neither is legible, down
 * unless across shrinks clearly less.
 */
export function layoutFlow(
  model: FlowModel,
  targetWidth = DEFAULT_TARGET_WIDTH,
): FlowLayout | null {
  if (!model.nodes.length) return null;
  if (model.direction === "right") return runFlow(model, "LR");
  if (model.direction === "down") return runFlow(model, "TB");
  const lr = runFlow(model, "LR");
  if (scaleAt(lr, targetWidth) >= LEGIBLE_SCALE) return lr;
  const tb = runFlow(model, "TB");
  if (scaleAt(tb, targetWidth) >= LEGIBLE_SCALE) return tb;
  return scaleAt(lr, targetWidth) > scaleAt(tb, targetWidth) * 1.1 ? lr : tb;
}

// ── What `check` can say without a browser ──

export interface FlowNote {
  code: string;
  message: string;
}

/** Most exits a decision keeps readable (upstream: more means nested decisions). */
export const MAX_DECISION_EXITS = 3;

/** Problems the model reports, and the upstream anti-patterns: decisions with 4+ exits or unlabeled exits, unlabeled transitions, more transitions than twice the states. */
export function flowNotes(props: FlowInput | null | undefined, kind: FlowKind): FlowNote[] {
  const model = buildFlow(props, kind);
  const notes: FlowNote[] = model.problems.map((message) => ({
    code: "flow",
    message: `${kind.component}: ${message}`,
  }));
  const label = (id: string) => model.nodes.find((n) => n.id === id)?.label ?? id;
  const shapeOf = (id: string) => model.nodes.find((n) => n.id === id)?.shape;
  if (kind.component === "Flowchart") {
    for (const n of model.nodes) {
      if (n.shape !== "decision") continue;
      const exits = model.edges.filter((e) => e.from === n.id);
      if (exits.length > MAX_DECISION_EXITS)
        notes.push({
          code: "flow",
          message: `Decision "${n.label}" has ${exits.length} exits, over ${MAX_DECISION_EXITS}. Split it into nested decisions.`,
        });
      const bare = exits.filter((e) => !e.label);
      if (bare.length)
        notes.push({
          code: "flow",
          message: `Decision "${n.label}" has ${bare.length === 1 ? "an exit" : "exits"} with no label. Label every exit with its answer.`,
        });
    }
  } else if (kind.notes) {
    notes.push(...kind.notes(model, kind));
  } else {
    const bare = model.edges.filter(
      (e) => !e.label && shapeOf(e.from) !== "initial" && shapeOf(e.to) !== "final",
    );
    if (bare.length)
      notes.push({
        code: "flow",
        message: `${bare.length} transition${bare.length === 1 ? "" : "s"} with no event (${bare
          .slice(0, 3)
          .map((e) => `${label(e.from)} → ${label(e.to)}`)
          .join(", ")}${bare.length > 3 ? ", …" : ""}). A transition says what triggers it.`,
      });
    if (model.edges.length > model.nodes.length * 2)
      notes.push({
        code: "flow",
        message: `${model.edges.length} transitions for ${model.nodes.length} states, more than twice as many: this is likely two state machines.`,
      });
  }
  return notes;
}
