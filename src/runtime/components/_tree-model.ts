// Tree and OrgChart: parsed OpenUI props → the flow model (`_flow-model.ts`), so
// they share its layout, shapes and view. A node names its parent (Tree) or the
// person it reports to (OrgChart); there are no edge statements. Free of JSX and
// DOM so it can be unit-tested in Node. Never throws on agent input.
import { FLOW_DIRECTIONS, NODE_TONES, ORG_KINDS, isElement, oneOf, str } from "./_flow-model.ts";
import type {
  ElementLike,
  FlowEdge,
  FlowKind,
  FlowModel,
  FlowNode,
  FlowNote,
  Shape,
} from "./_flow-model.ts";

/** Upstream limits (type-tree.md, type-org-chart.md). */
export const MAX_TREE_DEPTH = 4;
export const MAX_LEVEL_BREADTH = 5;
export const MAX_DIRECT_REPORTS = 5;

interface HierarchySpec {
  component: "Tree" | "OrgChart";
  title: string;
  nodeName: string;
  nodesProp: string;
  /** The props of a node that hold its text, its parent and (OrgChart) its dotted-line link. */
  labelProp: string;
  detailProp: string;
  parentProp: string;
  dottedProp?: string;
  kinds: readonly Shape[];
  defaultShape: Shape;
  defaultDirection: "down" | "auto";
  notes: (model: FlowModel, tree: TreeShape) => string[];
}

/** The solid (parent) links of a model, read as a forest. */
export interface TreeShape {
  parentOf: Map<string, string>;
  childrenOf: Map<string, string[]>;
  roots: string[];
  /** Level of each node, the root being 1. */
  depth: Map<string, number>;
}

export function treeShape(model: FlowModel): TreeShape {
  const parentOf = new Map<string, string>();
  const childrenOf = new Map<string, string[]>();
  for (const e of model.edges) {
    if (e.style !== "solid") continue;
    parentOf.set(e.to, e.from);
    childrenOf.set(e.from, [...(childrenOf.get(e.from) ?? []), e.to]);
  }
  const roots = model.nodes.filter((n) => !parentOf.has(n.id)).map((n) => n.id);
  const depth = new Map<string, number>();
  for (const n of model.nodes) {
    // Parent links are acyclic (the build breaks any loop), so this ends.
    let d = 1;
    for (let cur = parentOf.get(n.id); cur !== undefined; cur = parentOf.get(cur)) d++;
    depth.set(n.id, d);
  }
  return { parentOf, childrenOf, roots, depth };
}

function build(spec: HierarchySpec) {
  return (props: Record<string, unknown> | null | undefined, kind: FlowKind): FlowModel => {
    const problems: string[] = [];
    const nodes = new Map<string, FlowNode>();
    const seenEls = new Map<ElementLike, string>();
    const queue: { id: string; el: ElementLike }[] = [];
    let anon = 0;

    const addNode = (el: unknown): string | null => {
      if (!isElement(el)) return null;
      const seen = seenEls.get(el);
      if (seen !== undefined) return seen;
      // Statement names are identifiers: "#" cannot collide with one.
      const id = el.statementId || `#node${anon++}`;
      if (!nodes.has(id)) {
        const p = el.props;
        nodes.set(id, {
          id,
          named: !!el.statementId,
          label: str(p[spec.labelProp]).trim() || id,
          shape: oneOf(spec.kinds, p.kind) ? p.kind : spec.defaultShape,
          detail: str(p[spec.detailProp]).trim(),
          tone: oneOf(NODE_TONES, p.tone) ? p.tone : "",
        });
        queue.push({ id, el });
      }
      seenEls.set(el, id);
      return id;
    };

    const list = props?.[spec.nodesProp];
    for (const el of Array.isArray(list) ? list : []) addNode(el);
    const listed = new Set(nodes.keys());

    // A node a link names but the list leaves out is drawn anyway, with a problem.
    const parentOf = new Map<string, string>();
    const dotted = new Map<string, string>();
    const resolve = (id: string, value: unknown, what: string): string | null => {
      const target = addNode(value);
      if (!target) {
        if (value != null)
          problems.push(
            `${spec.nodeName} ${id}: ${what} must be the name of a ${spec.nodeName} statement, not ${JSON.stringify(value)}. The link is ignored.`,
          );
        return null;
      }
      if (target === id) {
        problems.push(`${spec.nodeName} ${id} is its own ${what}. The link is ignored.`);
        return null;
      }
      if (!listed.has(target)) {
        listed.add(target);
        problems.push(
          `${spec.nodeName} ${id} names ${target} as its ${what}, but ${target} is not in the ${spec.component} list. It is drawn anyway; list every ${spec.nodeName}.`,
        );
      }
      return target;
    };
    // The queue grows when a link names a node the list left out.
    for (let i = 0; i < queue.length; i++) {
      const { id, el } = queue[i];
      const parent = resolve(id, el.props[spec.parentProp], spec.parentProp);
      if (parent) parentOf.set(id, parent);
      if (spec.dottedProp) {
        const other = resolve(id, el.props[spec.dottedProp], "dotted-line link");
        if (other) dotted.set(id, other);
      }
    }

    // A parent chain that comes back to its start is cut at the node that closes it.
    for (const id of nodes.keys()) {
      const seen = new Set([id]);
      for (let cur = parentOf.get(id); cur !== undefined; cur = parentOf.get(cur)) {
        if (cur === id) {
          problems.push(
            `${spec.nodeName} ${id} is its own ancestor (${spec.parentProp} loops back). Its ${spec.parentProp} link is ignored.`,
          );
          parentOf.delete(id);
          break;
        }
        if (seen.has(cur)) break; // runs into a loop that another node closes
        seen.add(cur);
      }
    }

    const edges: FlowEdge[] = [];
    const edge = (id: string, from: string, to: string, style: FlowEdge["style"]) =>
      edges.push({ id, named: false, from, to, label: "", style });
    for (const id of nodes.keys()) {
      const parent = parentOf.get(id);
      if (parent) edge(`#parent:${id}`, parent, id, "solid");
    }
    for (const [id, other] of dotted) {
      if (other !== parentOf.get(id)) edge(`#dotted:${id}`, other, id, "dashed");
    }

    const wanted = props?.direction;
    const direction = oneOf(FLOW_DIRECTIONS, wanted) ? wanted : spec.defaultDirection;
    return { nodes: [...nodes.values()], edges, direction, problems };
  };
}

function notesOf(spec: HierarchySpec) {
  return (model: FlowModel): FlowNote[] => {
    const tree = treeShape(model);
    const messages = spec.notes(model, tree);
    const strong = model.nodes.filter((n) => n.tone === "strong");
    if (strong.length > 1)
      messages.push(
        `${strong.length} nodes have tone "strong" (${strong.map((n) => n.label).join(", ")}). Mark one: with several, none stands out.`,
      );
    return messages.map((message) => ({
      code: "flow",
      message: `${spec.component}: ${message}`,
    }));
  };
}

const names = (model: FlowModel, ids: string[]): string =>
  ids
    .slice(0, 3)
    .map((id) => model.nodes.find((n) => n.id === id)?.label ?? id)
    .join(", ") + (ids.length > 3 ? ", …" : "");

function depthNote(tree: TreeShape, what: string): string[] {
  const deepest = Math.max(0, ...tree.depth.values());
  return deepest > MAX_TREE_DEPTH
    ? [`${deepest} levels deep, over ${MAX_TREE_DEPTH}. Split it ${what}.`]
    : [];
}

const TREE_SPEC: HierarchySpec = {
  component: "Tree",
  title: "Tree",
  nodeName: "TreeNode",
  nodesProp: "nodes",
  labelProp: "label",
  detailProp: "detail",
  parentProp: "parent",
  kinds: ["step"],
  defaultShape: "step",
  defaultDirection: "auto",
  notes: (model, tree) => {
    const out: string[] = [];
    if (tree.roots.length > 1)
      out.push(
        `${tree.roots.length} nodes have no parent (${names(model, tree.roots)}). A tree has one root: give the others a parent, or draw separate trees.`,
      );
    out.push(...depthNote(tree, "at a clear branch into two trees"));
    const perLevel = new Map<number, number>();
    for (const d of tree.depth.values()) perLevel.set(d, (perLevel.get(d) ?? 0) + 1);
    for (const [level, n] of perLevel)
      if (n > MAX_LEVEL_BREADTH)
        out.push(
          `Level ${level} has ${n} nodes, over ${MAX_LEVEL_BREADTH}. Group siblings under a parent node.`,
        );
    return out;
  },
};

const ORG_SPEC: HierarchySpec = {
  component: "OrgChart",
  title: "Org chart",
  nodeName: "Person",
  nodesProp: "people",
  labelProp: "name",
  detailProp: "role",
  parentProp: "reportsTo",
  dottedProp: "dotted",
  kinds: ORG_KINDS,
  defaultShape: "person",
  defaultDirection: "down",
  notes: (model, tree) => {
    const out: string[] = [];
    if (tree.roots.length > 1)
      out.push(
        `${tree.roots.length} people report to no one (${names(model, tree.roots)}). One front door is usual: set reportsTo, or draw separate charts.`,
      );
    out.push(...depthNote(tree, "into an overview and one chart for each team"));
    for (const [id, kids] of tree.childrenOf)
      if (kids.length > MAX_DIRECT_REPORTS)
        out.push(
          `${names(model, [id])} has ${kids.length} direct reports, over ${MAX_DIRECT_REPORTS}. Add a team between them.`,
        );
    return out;
  },
};

function kindOf(spec: HierarchySpec): FlowKind {
  return {
    component: spec.component,
    title: spec.title,
    nodeName: spec.nodeName,
    edgeName: "",
    nodesProp: spec.nodesProp,
    edgesProp: "",
    kinds: spec.kinds,
    defaultShape: spec.defaultShape,
    defaultDirection: spec.defaultDirection,
    edgeLabel: () => "",
    build: build(spec),
    hierarchy: true,
    notes: notesOf(spec),
  };
}

export const TREE: FlowKind = kindOf(TREE_SPEC);
export const ORG_CHART: FlowKind = kindOf(ORG_SPEC);
