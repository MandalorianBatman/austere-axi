// Lanes layout for Architecture(direction "lanes"): top-level Groups become
// columns in the order listed, nodes stack in rows inside each column, rows
// line up across columns, and edges are routed at right angles through the
// gaps between columns and rows. Free of JSX and DOM so it is unit-tested in
// Node (test/components.test.ts). Never throws on agent input.
import { SIZES, sizeEdgeLabel, sizeNode, textWidth, wrapText } from "./_architecture-model.ts";
import type { EdgeLabelSize, LabelBox, LaidOutEdge, LaidOutGroup, LaidOutNode, Layout, Model, ModelEdge, ModelGroup, ModelNode, NodeSize, Point } from "./_architecture-model.ts";

export type Side = "left" | "right" | "top" | "bottom";

/** A lane's row before rows line up across lanes; `g` is its global row. */
interface LaneRow {
  ids: string[];
  pin: number | null;
  g: number;
}

interface Frame {
  x: number;
  y: number;
  w: number;
  h: number;
}

interface Lane {
  group: ModelGroup | null;
  nodes: string[];
  index: number;
  laneOf: Map<string, Lane>;
  rows: LaneRow[];
  /** Physical row index → node ids side by side in it. */
  phys: Map<number, string[]>;
  inner: number;
  headLine: string;
  frame: Frame;
}

/** A placed node box. */
export interface Box extends NodeSize {
  x: number;
  y: number;
  rowIndex: number;
  laneIndex: number;
}

interface Channel {
  key: string;
  axis: "x" | "y";
  lo: number;
  hi: number;
  fixed?: boolean;
}

interface Geometry {
  lanes: Lane[];
  boxes: Map<string, Box>;
  channels: Channel[];
  frameLines: { xs: number[]; ys: number[] };
  sides: (e: ModelEdge) => [Side, Side];
  width: number;
  height: number;
}

interface Plan {
  lanes: Lane[];
  byId: Map<string, ModelNode>;
  rowCount: number;
  sizes: Map<string, number>;
  width: number;
  layout: Layout | null;
}

/** A box as routeOrthogonal needs it. */
export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** An edge to route; placePorts fills in the ports. */
export interface RouteEdge {
  id: string;
  from: string;
  to: string;
  fromSide: Side;
  toSide: Side;
  fromPort?: Point;
  toPort?: Point;
}

interface PortedEdge extends RouteEdge {
  fromPort: Point;
  toPort: Point;
}

export interface RouteOptions {
  boxes: Map<string, Rect>;
  edges: RouteEdge[];
  xLines?: number[];
  yLines?: number[];
  avoid?: { xs: number[]; ys: number[] };
  bounds: { x0: number; y0: number; x1: number; y1: number };
}

interface Bounds {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** A key the code put in the map itself. */
const known = <K, V>(map: Map<K, V>, key: K): V => map.get(key) as V;

export const LANES = {
  margin: 16, // around the drawing
  lanePad: 14, // inside a lane frame
  head: 30, // lane heading band
  headSize: 12, // lane heading text
  colGap: 18, // between boxes side by side in a lane
  rowGap: 34, // between rows; grows when routes need more tracks
  gutter: 52, // between lanes; grows with labels and routes
  bottom: 18, // routing channel under the last row, inside the lanes
  track: 9, // spacing of parallel lines in a channel
  clear: 9, // routes keep this far from boxes
  stub: 14, // straight run out of a port before any bend
  laneMinW: 170,
  laneMaxHeadW: 300,
};

/**
 * Lay out a model in lanes: columns side by side. Returns null when there are
 * no groups (nothing to make columns of).
 */
export function runLanes(model: Model): Layout | null {
  const plan = planColumns(model);
  if (!plan) return null;
  if (!plan.layout) plan.layout = routeWithGrowth(model, plan.sizes, () => placeColumns(plan.lanes, plan.byId, plan.rowCount, plan.sizes, model));
  return plan.layout;
}

/**
 * Width the columns need before any routing (cheap): what decides between
 * columns and stacked bands, and whether the page should widen.
 */
export function lanesPlanWidth(model: Model): number {
  return planColumns(model)?.width ?? 0;
}

// One plan (and its routed layout) per model: the renderer keeps the model
// while the window resizes.
const plans = new WeakMap<Model, Plan | null>();

function planColumns(model: Model): Plan | null {
  const cached = plans.get(model);
  if (cached !== undefined) return cached;
  const lanes = prepareLanes(model);
  if (!lanes) {
    plans.set(model, null);
    return null;
  }
  const byId = new Map(model.nodes.map((n) => [n.id, n]));
  const rowCount = assignGlobalRows(lanes, model.edges);
  const sizes = new Map<string, number>();
  initialGutters(lanes, model.edges).forEach((g, i) => sizes.set(`g${i}`, g));
  // A labelled line dropping to the next row needs room for its label and
  // its arrowhead.
  const rowOf = new Map<string, { g: number; lane: Lane }>();
  for (const lane of lanes) for (const [g, ids] of lane.phys) for (const id of ids) rowOf.set(id, { g, lane });
  for (const e of model.edges) {
    const a = rowOf.get(e.from);
    const b = rowOf.get(e.to);
    const lb = sizeEdgeLabel(e.label);
    if (!a || !b || !lb || a.lane !== b.lane || Math.abs(a.g - b.g) !== 1) continue;
    const key = `r${Math.min(a.g, b.g)}`;
    sizes.set(key, Math.max(sizes.get(key) ?? LANES.rowGap, lb.height + 30));
  }
  const plan: Plan = { lanes, byId, rowCount, sizes, width: placeColumns(lanes, byId, rowCount, sizes, model).width, layout: null };
  plans.set(model, plan);
  return plan;
}

/**
 * The same lanes stacked as bands, one above the other, for a narrow screen:
 * boxes take the width, lines run down channels on either side.
 */
export function runStackedLanes(model: Model, targetWidth: number): Layout | null {
  const lanes = prepareLanes(model);
  if (!lanes) return null;
  // Same order as the columns, pins included: top to bottom by row.
  assignGlobalRows(lanes, model.edges);
  for (const lane of lanes) lane.rows.sort((a, b) => a.g - b.g);
  const byId = new Map(model.nodes.map((n) => [n.id, n]));
  const sizes = new Map<string, number>([
    ["left", 22],
    ["right", 22],
  ]);
  const layout = routeWithGrowth(model, sizes, () => placeBands(lanes, byId, sizes, model, targetWidth), STACKED_MAX_CHANNEL);
  if (layout) layout.rankdir = "stacked";
  return layout;
}

const STACKED_MAX_CHANNEL = 22 + 6 * 9;

function prepareLanes(model: Model): Lane[] | null {
  const lanes = assignLanes(model);
  if (!lanes) return null;
  const byId = new Map(model.nodes.map((n) => [n.id, n]));
  for (const lane of lanes) lane.rows = applyPins(laneRows(lane, model.edges), byId);
  return lanes;
}

/** Route, then widen any channel that ran out of tracks and route again. */
function routeWithGrowth(model: Model, sizes: Map<string, number>, place: () => Geometry, maxSize = Infinity): Layout {
  let result: { geo: Geometry; routed: Map<string, Point[]> } | null = null;
  for (let pass = 0; pass < 2; pass++) {
    const geo = place();
    const routed = routeAll(geo, model);
    result = { geo, routed };
    const grow = channelShortfall(geo, routed);
    let changed = false;
    for (const [key, need] of grow) {
      const next = Math.min(maxSize, Math.max(sizes.get(key) || 0, need));
      if (next > (sizes.get(key) || 0)) {
        sizes.set(key, next);
        changed = true;
      }
    }
    if (!changed) break;
  }
  // The loop runs at least once.
  return finish(result as { geo: Geometry; routed: Map<string, Point[]> }, model);
}

// ── Lanes and rows ──────────────────────────────────────────────────────────

function assignLanes(model: Model): Lane[] | null {
  const top = model.groups.filter((g) => !g.parent);
  if (!top.length) return null;
  const laneOf = new Map<string, Lane>();
  const newLane = (group: ModelGroup | null, nodes: string[]): Lane => ({ group, nodes, index: 0, laneOf, rows: [], phys: new Map(), inner: 0, headLine: "", frame: { x: 0, y: 0, w: 0, h: 0 } });
  const lanes = top.map((group) => newLane(group, []));
  for (const lane of lanes) {
    for (const m of lane.group?.members ?? []) {
      if (laneOf.has(m)) continue;
      laneOf.set(m, lane);
      lane.nodes.push(m);
    }
  }
  // Nodes in no group get a lane of their own, first when they mostly feed
  // the others (users, inputs), last when they mostly receive.
  const loose = model.nodes.map((n) => n.id).filter((id) => !laneOf.has(id));
  if (loose.length) {
    const isLoose = new Set(loose);
    let out = 0;
    let inn = 0;
    for (const e of model.edges) {
      if (isLoose.has(e.from) && !isLoose.has(e.to)) out++;
      if (!isLoose.has(e.from) && isLoose.has(e.to)) inn++;
    }
    const lane = newLane(null, loose);
    for (const id of loose) laneOf.set(id, lane);
    if (out >= inn) lanes.unshift(lane);
    else lanes.push(lane);
  }
  lanes.forEach((lane, i) => {
    lane.index = i;
  });
  for (const lane of lanes) lane.laneOf = laneOf;
  return lanes;
}

/**
 * Rows inside one lane. Nodes joined by edges inside the lane flow downward
 * (longest path, cycles broken in listed order); nodes with no edge inside
 * the lane each take a row. Blocks keep the order the group lists them in.
 */
function laneRows(lane: Lane, edges: ModelEdge[]): LaneRow[] {
  const ids = lane.nodes;
  const pos = new Map(ids.map((id, i) => [id, i]));
  const inLane = (id: string) => pos.has(id);
  const intra = edges.filter((e) => e.from !== e.to && inLane(e.from) && inLane(e.to));

  const parent = new Map(ids.map((id) => [id, id]));
  const find = (x: string): string => {
    while (parent.get(x) !== x) {
      parent.set(x, known(parent, known(parent, x)));
      x = known(parent, x);
    }
    return x;
  };
  for (const e of intra) parent.set(find(e.from), find(e.to));

  // Drop edges that close a cycle (in listed order), then longest path.
  const adj = new Map<string, string[]>(ids.map((id) => [id, []]));
  for (const e of intra) known(adj, e.from).push(e.to);
  const state = new Map<string, number>();
  const kept: [string, string][] = [];
  for (const root of ids) {
    if (state.get(root)) continue;
    const stack: [string, number][] = [[root, 0]];
    state.set(root, 1);
    while (stack.length) {
      const top = stack[stack.length - 1];
      const [u, k] = top;
      const next: string | undefined = known(adj, u)[k];
      if (next === undefined) {
        state.set(u, 2);
        stack.pop();
        continue;
      }
      top[1]++;
      if (state.get(next) === 1) continue; // back edge
      kept.push([u, next]);
      if (!state.get(next)) {
        state.set(next, 1);
        stack.push([next, 0]);
      }
    }
  }
  const rank = new Map(ids.map((id) => [id, 0]));
  for (let changed = true, guard = 0; changed && guard <= ids.length; guard++) {
    changed = false;
    for (const [u, v] of kept) {
      if (known(rank, v) < known(rank, u) + 1) {
        rank.set(v, known(rank, u) + 1);
        changed = true;
      }
    }
  }

  const blocks = new Map<string, string[]>();
  for (const id of ids) {
    const root = find(id);
    if (!blocks.has(root)) blocks.set(root, []);
    known(blocks, root).push(id);
  }
  const rows: LaneRow[] = [];
  for (const members of [...blocks.values()].sort((a, b) => known(pos, a[0]) - known(pos, b[0]))) {
    const byRank = new Map<number, string[]>();
    for (const id of members) {
      const r = known(rank, id);
      if (!byRank.has(r)) byRank.set(r, []);
      known(byRank, r).push(id);
    }
    for (const r of [...byRank.keys()].sort((a, b) => a - b)) {
      const ids = known(byRank, r);
      // Two boxes side by side read as a fork; more would make the column
      // too wide, so they stack.
      if (ids.length <= 2) rows.push({ ids, pin: null, g: 0 });
      else for (const id of ids) rows.push({ ids: [id], pin: null, g: 0 });
    }
  }
  return rows;
}

/** Node row pins: pinned nodes leave their row; same pin in a lane = side by side. */
function applyPins(rows: LaneRow[], byId: Map<string, ModelNode>): LaneRow[] {
  const out: LaneRow[] = [];
  const pinned = new Map<number, LaneRow>();
  for (const row of rows) {
    const free: string[] = [];
    for (const id of row.ids) {
      const pin = byId.get(id)?.row;
      if (!pin) {
        free.push(id);
        continue;
      }
      if (!pinned.has(pin)) {
        const pr: LaneRow = { ids: [], pin, g: 0 };
        pinned.set(pin, pr);
        out.push(pr);
      }
      known(pinned, pin).ids.push(id);
    }
    if (free.length) out.push({ ids: free, pin: null, g: 0 });
  }
  return out;
}

/**
 * Best non-decreasing fit to `values` (weighted least squares): pool adjacent
 * violators.
 */
function isotonic(values: number[], weights: number[]): number[] {
  const blocks: { s: number; w: number; n: number }[] = [];
  for (let k = 0; k < values.length; k++) {
    blocks.push({ s: values[k] * weights[k], w: weights[k], n: 1 });
    while (blocks.length > 1) {
      const b = blocks[blocks.length - 1];
      const a = blocks[blocks.length - 2];
      if (a.s / a.w <= b.s / b.w) break;
      a.s += b.s;
      a.w += b.w;
      a.n += b.n;
      blocks.pop();
    }
  }
  const out: number[] = [];
  for (const b of blocks) for (let k = 0; k < b.n; k++) out.push(b.s / b.w);
  return out;
}

/**
 * Give every lane row a global row number. Rows keep their order inside a
 * lane and sit as close as they can to the rows they connect to in other
 * lanes (an ordered least-squares fit per lane, a few sweeps across lanes);
 * rows with no such link pack upward. Pins are exact. Returns the number of
 * global rows; sets lane.phys.
 */
function assignGlobalRows(lanes: Lane[], edges: ModelEdge[]): number {
  const rowOf = new Map<string, LaneRow>();
  for (const lane of lanes) for (const r of lane.rows) for (const id of r.ids) rowOf.set(id, r);
  const laneOf = lanes[0].laneOf;
  const neighbors = new Map<LaneRow, LaneRow[]>();
  const link = (a: LaneRow, b: LaneRow) => {
    if (!neighbors.has(a)) neighbors.set(a, []);
    known(neighbors, a).push(b);
  };
  for (const e of edges) {
    const a = rowOf.get(e.from);
    const b = rowOf.get(e.to);
    if (!a || !b || laneOf.get(e.from) === laneOf.get(e.to)) continue;
    link(a, b);
    link(b, a);
  }
  for (const lane of lanes) lane.rows.forEach((r, i) => (r.g = r.pin ?? i + 1));
  for (let sweep = 0; sweep < 8; sweep++) {
    for (const lane of sweep % 2 ? [...lanes].reverse() : lanes) {
      // Pinned rows are fixed; the rest keep their order and fit around them.
      const free = lane.rows.filter((r) => !r.pin);
      const taken = new Set(lane.rows.filter((r) => r.pin).map((r) => r.pin));
      // Fit h = g - k (non-decreasing keeps rows in order, one apart).
      const want: number[] = [];
      const weight: number[] = [];
      free.forEach((r, i) => {
        const ns = neighbors.get(r);
        want.push(ns ? ns.reduce((sum, x) => sum + x.g, 0) / ns.length - (i + 1) : 0);
        weight.push(ns ? ns.length : 0.05);
      });
      const fit = isotonic(want, weight);
      let prev = 0;
      free.forEach((r, i) => {
        let g = Math.max(prev + 1, Math.max(0, Math.round(fit[i])) + i + 1);
        while (taken.has(g)) g++;
        r.g = g;
        prev = g;
      });
    }
  }
  // Number the rows that are used, top to bottom; rows that share a number in
  // one lane (only through pins) sit side by side.
  const used = [...new Set(lanes.flatMap((l) => l.rows.map((r) => r.g)))].sort((a, b) => a - b);
  const index = new Map(used.map((g, i) => [g, i]));
  for (const lane of lanes) {
    lane.phys = new Map();
    for (const r of lane.rows) {
      const g = known(index, r.g);
      if (!lane.phys.has(g)) lane.phys.set(g, []);
      known(lane.phys, g).push(...r.ids);
    }
  }
  return used.length;
}

const GUTTER_LABEL_W = 96;

function initialGutters(lanes: Lane[], edges: ModelEdge[]): number[] {
  const laneOf = lanes[0].laneOf;
  const gutters: number[] = new Array(Math.max(0, lanes.length - 1)).fill(LANES.gutter);
  const crossing: number[] = new Array(gutters.length).fill(0);
  for (const e of edges) {
    const a = laneOf.get(e.from)?.index;
    const b = laneOf.get(e.to)?.index;
    if (a === undefined || b === undefined || a === b) continue;
    const lo = Math.min(a, b);
    const hi = Math.max(a, b);
    for (let i = lo; i < hi; i++) crossing[i]++;
    // The label sits in the gutter next to the source.
    const lb = sizeEdgeLabel(e.label);
    if (lb) {
      const g = b > a ? a : a - 1;
      // Labels in a gutter wrap narrower rather than widen the diagram.
      gutters[g] = Math.max(gutters[g], (narrowLabel(e.label, GUTTER_LABEL_W)?.width ?? lb.width) + 22);
    }
  }
  return gutters.map((g, i) => Math.max(g, 24 + crossing[i] * LANES.track));
}

// ── Geometry ────────────────────────────────────────────────────────────────

function sizeLaneHeads(lanes: Lane[], inner: (lane: Lane) => number): void {
  for (const lane of lanes) {
    const label = lane.group?.label || "";
    lane.headLine = label ? wrapText(label, LANES.headSize, inner(lane), 1, true)[0] : "";
  }
}

function placeColumns(lanes: Lane[], byId: Map<string, ModelNode>, rowCount: number, sizes: Map<string, number>, model: Model): Geometry {
  const L = LANES;
  const natural = new Map(model.nodes.map((n) => [n.id, sizeNode(n)]));
  // A group inside a lane puts its label above its first box: leave room
  // under the lane heading for it.
  const nested = model.groups.some((g) => g.parent);
  const headH = (lanes.some((l) => l.group?.label) ? L.head : 0) + (nested ? 16 : 0);
  const gutter = (i: number) => sizes.get(`g${i}`) ?? L.gutter;
  const rowGap = (g: number) => sizes.get(`r${g}`) ?? L.rowGap;

  for (const lane of lanes) {
    let inner = L.laneMinW;
    for (const ids of lane.phys.values()) {
      const w = ids.reduce((sum, id) => sum + known(natural, id).width, 0) + L.colGap * (ids.length - 1);
      inner = Math.max(inner, w);
    }
    const label = lane.group?.label || "";
    if (label) inner = Math.max(inner, Math.min(textWidth(label, L.headSize, true) + 4, L.laneMaxHeadW));
    lane.inner = inner;
  }
  sizeLaneHeads(lanes, (lane) => lane.inner);

  // Stretch boxes to fill their lane row, then size them for that width.
  const sized = new Map<string, NodeSize>();
  for (const lane of lanes) {
    for (const ids of lane.phys.values()) {
      const sum = ids.reduce((acc, id) => acc + known(natural, id).width, 0);
      const extra = (lane.inner - sum - L.colGap * (ids.length - 1)) / ids.length;
      for (const id of ids) sized.set(id, sizeNode(known(byId, id), Math.floor(known(natural, id).width + extra)));
    }
  }
  const rowH: number[] = new Array(rowCount).fill(0);
  for (const lane of lanes) for (const [g, ids] of lane.phys) for (const id of ids) rowH[g] = Math.max(rowH[g], known(sized, id).height);

  const rowTop: number[] = [];
  let y = L.margin + headH + L.lanePad;
  for (let g = 0; g < rowCount; g++) {
    rowTop[g] = y;
    y += rowH[g] + (g < rowCount - 1 ? rowGap(g) : 0);
  }
  const contentBottom = y;
  const frameTop = L.margin;
  const frameBottom = contentBottom + L.bottom + L.lanePad;

  let x = L.margin;
  const boxes = new Map<string, Box>();
  for (const lane of lanes) {
    const w = lane.inner + L.lanePad * 2;
    lane.frame = { x, y: frameTop, w, h: frameBottom - frameTop };
    for (const [g, ids] of lane.phys) {
      let bx = x + L.lanePad;
      for (const id of ids) {
        const b = known(sized, id);
        boxes.set(id, { ...b, x: bx, y: Math.round(rowTop[g] + (rowH[g] - b.height) / 2), rowIndex: g, laneIndex: lane.index });
        bx += b.width + L.colGap;
      }
    }
    x += w + (lane.index < lanes.length - 1 ? gutter(lane.index) : 0);
  }
  const width = x + L.margin;
  const height = frameBottom + L.margin;

  const channels: Channel[] = [];
  lanes.forEach((lane, i) => {
    if (i < lanes.length - 1) channels.push({ key: `g${i}`, axis: "x", lo: lane.frame.x + lane.frame.w, hi: lanes[i + 1].frame.x });
  });
  for (let g = 0; g < rowCount - 1; g++) channels.push({ key: `r${g}`, axis: "y", lo: rowTop[g] + rowH[g], hi: rowTop[g + 1] });
  channels.push({ key: "bottom", axis: "y", lo: contentBottom, hi: frameBottom - 4, fixed: true });
  channels.push({ key: "outL", axis: "x", lo: 0, hi: L.margin, fixed: true }, { key: "outR", axis: "x", lo: width - L.margin, hi: width, fixed: true });
  channels.push({ key: "outB", axis: "y", lo: frameBottom, hi: height, fixed: true });
  const frameLines = { xs: lanes.flatMap((l) => [l.frame.x, l.frame.x + l.frame.w]), ys: [frameTop, frameBottom] };
  const sides = (e: ModelEdge): [Side, Side] => {
    const a = known(boxes, e.from);
    const b = known(boxes, e.to);
    if (a.laneIndex !== b.laneIndex) return b.laneIndex > a.laneIndex ? ["right", "left"] : ["left", "right"];
    if (b.rowIndex > a.rowIndex) return ["bottom", "top"];
    if (b.rowIndex < a.rowIndex) return ["top", "bottom"];
    return b.x > a.x ? ["right", "left"] : ["left", "right"];
  };
  return { lanes, boxes, channels, frameLines, sides, width, height };
}

function placeBands(lanes: Lane[], byId: Map<string, ModelNode>, sizes: Map<string, number>, model: Model, targetWidth: number): Geometry {
  const L = LANES;
  const left = known(sizes, "left");
  const right = known(sizes, "right");
  // Fit the width it is given: it may shrink to the legible scale, never scroll.
  const target = (targetWidth || 360) / 0.85;
  const room = Math.max(180, Math.min(720, target - left - right - L.lanePad * 2 - 4));
  sizeLaneHeads(lanes, () => room);
  const boxes = new Map<string, Box>();
  const channels: Channel[] = [];
  const x0 = left + L.lanePad;
  let y = L.margin;
  let seq = 0;
  let prevBottom: number | null = null;
  let prevLine: string[] = [];
  const nested = model.groups.some((g) => g.parent);
  for (const lane of lanes) {
    const top = y;
    y += (lane.headLine ? L.head : 0) + (nested ? 16 : 0) + L.lanePad;
    if (prevBottom !== null) channels.push({ key: `band${lane.index}`, axis: "y", lo: prevBottom, hi: top, fixed: true });
    let first = true;
    for (const row of lane.rows) {
      // Side by side only when the boxes fit; otherwise one per row.
      const natural = row.ids.map((id) => sizeNode(known(byId, id)));
      const fits = natural.reduce((sum, n) => sum + n.width, 0) + L.colGap * (row.ids.length - 1) <= room;
      const lines = fits ? [row.ids] : row.ids.map((id) => [id]);
      for (const ids of lines) {
        if (!first) {
          let gap = sizes.get(`s${seq}`) ?? 30;
          for (const e of model.edges) {
            const lb = sizeEdgeLabel(e.label);
            if (!lb) continue;
            const pair = (p: string, q: string) => prevLine.includes(p) && ids.includes(q);
            if (pair(e.from, e.to) || pair(e.to, e.from)) gap = Math.max(gap, lb.height + 30);
          }
          channels.push({ key: `s${seq}`, axis: "y", lo: y, hi: y + gap });
          y += gap;
        }
        first = false;
        const w = (room - L.colGap * (ids.length - 1)) / ids.length;
        const sized = ids.map((id) => sizeNode(known(byId, id), Math.floor(w)));
        const h = Math.max(...sized.map((b) => b.height));
        let bx = x0;
        ids.forEach((id, k) => {
          boxes.set(id, { ...sized[k], x: bx, y: Math.round(y + (h - sized[k].height) / 2), rowIndex: seq, laneIndex: lane.index });
          bx += sized[k].width + L.colGap;
        });
        y += h;
        seq++;
        prevLine = ids;
      }
    }
    y += L.lanePad;
    lane.frame = { x: left, y: top, w: room + L.lanePad * 2, h: y - top };
    prevBottom = y;
    y += 26;
  }
  const width = left + room + L.lanePad * 2 + right;
  // Every model with lanes has at least one lane.
  const height = (prevBottom as number) + L.margin;
  channels.push({ key: "left", axis: "x", lo: 0, hi: left }, { key: "right", axis: "x", lo: width - right, hi: width });
  const frameLines = { xs: [left, width - right], ys: lanes.flatMap((l) => [l.frame.y, l.frame.y + l.frame.h]) };
  // Down the right side going forward, up the left going back; the next box
  // directly below gets a straight drop.
  const sides = (e: ModelEdge): [Side, Side] => {
    const a = known(boxes, e.from);
    const b = known(boxes, e.to);
    if (a.rowIndex === b.rowIndex) return b.x > a.x ? ["right", "left"] : ["left", "right"];
    if (b.rowIndex === a.rowIndex + 1 && b.x < a.x + a.width && a.x < b.x + b.width) return ["bottom", "top"];
    return b.rowIndex > a.rowIndex ? ["right", "right"] : ["left", "left"];
  };
  return { lanes, boxes, channels, frameLines, sides, width, height };
}

// ── Routing ─────────────────────────────────────────────────────────────────

function trackPositions(lo: number, hi: number): number[] {
  const room = hi - lo - 12;
  if (room < 0) return [(lo + hi) / 2];
  const n = Math.min(SEARCH.maxTracks, Math.floor(room / LANES.track) + 1);
  const mid = (lo + hi) / 2;
  return Array.from({ length: n }, (_, k) => mid + (k - (n - 1) / 2) * LANES.track);
}

function routeAll(geo: Geometry, model: Model): Map<string, Point[]> {
  const { boxes } = geo;
  const edges: RouteEdge[] = [];
  const loops: ModelEdge[] = [];
  for (const e of model.edges) {
    if (!boxes.has(e.from) || !boxes.has(e.to)) continue;
    if (e.from === e.to) {
      loops.push(e);
      continue;
    }
    const [fromSide, toSide] = geo.sides(e);
    const a = known(boxes, e.from);
    const b = known(boxes, e.to);
    edges.push({ id: e.id, from: e.from, to: e.to, fromSide: openSide(a, fromSide, b, boxes), toSide: openSide(b, toSide, a, boxes) });
  }
  const xs: number[] = [];
  const ys: number[] = [];
  for (const c of geo.channels) (c.axis === "x" ? xs : ys).push(...trackPositions(c.lo, c.hi));
  const routes = routeOrthogonal({
    boxes,
    edges,
    xLines: xs,
    yLines: ys,
    avoid: geo.frameLines,
    bounds: { x0: 1, y0: 1, x1: geo.width - 1, y1: geo.height - 1 },
  });
  // A self-loop hangs off the bottom-right corner.
  for (const e of loops) {
    const b = known(boxes, e.from);
    const r = b.x + b.width;
    const bottom = b.y + b.height;
    routes.set(e.id, [
      { x: r - 30, y: bottom },
      { x: r - 30, y: bottom + 14 },
      { x: r + 12, y: bottom + 14 },
      { x: r + 12, y: bottom - 14 },
      { x: r, y: bottom - 14 },
    ]);
  }
  return routes;
}

/**
 * A side with another box right against it (boxes side by side in a row)
 * has no room for a line: use the top or bottom, toward the other end.
 */
function openSide(box: Rect, side: Side, other: Rect, boxes: Map<string, Rect>): Side {
  const reach = LANES.stub + LANES.clear + 2;
  const blocked = (sd: Side) => {
    for (const o of boxes.values()) {
      if (o === box) continue;
      const ySpan = o.y < box.y + box.height && box.y < o.y + o.height;
      const xSpan = o.x < box.x + box.width && box.x < o.x + o.width;
      if (sd === "right" && ySpan && o.x >= box.x + box.width && o.x - (box.x + box.width) < reach) return true;
      if (sd === "left" && ySpan && o.x + o.width <= box.x && box.x - (o.x + o.width) < reach) return true;
      if (sd === "bottom" && xSpan && o.y >= box.y + box.height && o.y - (box.y + box.height) < reach) return true;
      if (sd === "top" && xSpan && o.y + o.height <= box.y && box.y - (o.y + o.height) < reach) return true;
    }
    return false;
  };
  if (!blocked(side)) return side;
  const towardY: Side[] = other.y + other.height / 2 >= box.y + box.height / 2 ? ["bottom", "top"] : ["top", "bottom"];
  const towardX: Side[] = other.x + other.width / 2 >= box.x + box.width / 2 ? ["right", "left"] : ["left", "right"];
  const order = side === "left" || side === "right" ? towardY : towardX;
  return order.find((sd) => !blocked(sd)) || side;
}

/** Channels whose tracks all got used: the size each one needs. */
function channelShortfall(geo: Geometry, routes: Map<string, Point[]>): Map<string, number> {
  const vertical: number[] = [];
  const horizontal: number[] = [];
  for (const pts of routes.values()) {
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1];
      const b = pts[i];
      if (a.x === b.x && a.y !== b.y) vertical.push(a.x);
      else if (a.y === b.y && a.x !== b.x) horizontal.push(a.y);
    }
  }
  const need = new Map<string, number>();
  for (const c of geo.channels) {
    if (c.fixed) continue;
    const lines = c.axis === "x" ? vertical : horizontal;
    const used = new Set(lines.filter((v) => v > c.lo && v < c.hi).map((v) => Math.round(v))).size;
    if (used >= trackPositions(c.lo, c.hi).length) need.set(c.key, 24 + (used + 2) * LANES.track);
  }
  return need;
}

const NORMAL: Record<Side, [number, number]> = { left: [-1, 0], right: [1, 0], top: [0, -1], bottom: [0, 1] };

/** Spread the ends that share a side, each as close as possible to where its line wants to go. */
interface PortItem {
  other: string;
  edge: RouteEdge;
  end: "fromPort" | "toPort";
  want: number;
  pos: number;
}

function placePorts(boxes: Map<string, Rect>, edges: RouteEdge[]): void {
  const sides = new Map<string, { node: string; side: Side; items: PortItem[] }>();
  const add = (node: string, side: Side, other: string, edge: RouteEdge, end: "fromPort" | "toPort") => {
    const key = `${node}\u0000${side}`;
    if (!sides.has(key)) sides.set(key, { node, side, items: [] });
    known(sides, key).items.push({ other, edge, end, want: 0, pos: 0 });
  };
  for (const e of edges) {
    add(e.from, e.fromSide, e.to, e, "fromPort");
    add(e.to, e.toSide, e.from, e, "toPort");
  }
  for (const { node, side, items } of sides.values()) {
    const b = known(boxes, node);
    const horizontal = side === "left" || side === "right";
    const lo = horizontal ? b.y + 9 : b.x + 12;
    const hi = horizontal ? b.y + b.height - 9 : b.x + b.width - 12;
    for (const it of items) {
      const o = known(boxes, it.other);
      // Facing boxes that overlap: aim at the middle of the overlap, which is
      // the same point from both ends, so the line comes out straight.
      const oLo = horizontal ? o.y : o.x;
      const oHi = horizontal ? o.y + o.height : o.x + o.width;
      const sLo = horizontal ? b.y : b.x;
      const sHi = horizontal ? b.y + b.height : b.x + b.width;
      const overlap = Math.min(oHi, sHi) - Math.max(oLo, sLo);
      const want = overlap > 18 ? (Math.min(oHi, sHi) + Math.max(oLo, sLo)) / 2 : (oLo + oHi) / 2;
      it.want = Math.min(hi, Math.max(lo, want));
    }
    items.sort((a, c) => a.want - c.want);
    const gap = Math.min(14, items.length > 1 ? (hi - lo) / (items.length - 1) : 14);
    let prev = -Infinity;
    for (const it of items) {
      it.pos = Math.max(it.want, prev + gap);
      prev = it.pos;
    }
    const over = prev - hi;
    if (over > 0) {
      // Pushed past the end: slide the run back, keeping the spacing.
      let next = Infinity;
      for (let k = items.length - 1; k >= 0; k--) {
        items[k].pos = Math.min(items[k].pos, hi, next - gap);
        next = items[k].pos;
      }
    }
    for (const it of items) {
      const pos = Math.round(it.pos);
      const p = horizontal ? { x: side === "left" ? b.x : b.x + b.width, y: pos } : { x: pos, y: side === "top" ? b.y : b.y + b.height };
      it.edge[it.end] = p;
    }
  }
}

/** Binary min-heap of (key, item) in two flat arrays. */
class Heap {
  declare k: number[];
  declare v: number[];
  /** Key of the item the last pop() returned. */
  declare top: number;
  constructor() {
    this.k = [];
    this.v = [];
  }
  push(item: number, key: number): void {
    const { k, v } = this;
    let i = k.length;
    k.push(key);
    v.push(item);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (k[p] <= key) break;
      k[i] = k[p];
      v[i] = v[p];
      i = p;
    }
    k[i] = key;
    v[i] = item;
  }
  /** Pops the smallest; its key is left in this.top. */
  pop(): number {
    const { k, v } = this;
    const item = v[0];
    this.top = k[0];
    // Only called while the heap is not empty.
    const lastK = k.pop() as number;
    const lastV = v.pop() as number;
    const n = k.length;
    if (n) {
      let i = 0;
      for (;;) {
        const l = i * 2 + 1;
        if (l >= n) break;
        const m = l + 1 < n && k[l + 1] < k[l] ? l + 1 : l;
        if (k[m] >= lastK) break;
        k[i] = k[m];
        v[i] = v[m];
        i = m;
      }
      k[i] = lastK;
      v[i] = lastV;
    }
    return item;
  }
  get size(): number {
    return this.k.length;
  }
}

const COST = { bend: 36, overlap: 8, cross: 22, hug: 0.6 };
// The search may trade a little optimality for speed (weighted A*), and gives
// up on one edge after this many steps (it then gets a plain elbow).
const SEARCH = { weight: 1.5, maxSteps: 120000, maxTracks: 14 };

/**
 * Route edges at right angles around boxes. Each edge leaves its source side
 * and enters its target side straight; searches a grid made of the channel
 * lines plus lines just clear of every box, preferring few bends, no shared
 * runs and few crossings with lines already routed (short edges first).
 */
export function routeOrthogonal({ boxes, edges: input, xLines = [], yLines = [], avoid = { xs: [], ys: [] }, bounds }: RouteOptions): Map<string, Point[]> {
  const C = LANES.clear;
  const S = LANES.stub;
  placePorts(boxes, input);
  // placePorts gave every edge both ports.
  const edges = input as PortedEdge[];
  const stubOf = (p: Point, side: Side): Point => ({ x: p.x + NORMAL[side][0] * S, y: p.y + NORMAL[side][1] * S });

  const rnd = (v: number) => Math.round(v * 2) / 2;
  const hugXs = new Set<number>();
  const hugYs = new Set<number>();
  const xsAll = [...xLines];
  const ysAll = [...yLines];
  for (const b of boxes.values()) {
    xsAll.push(b.x - C, b.x + b.width + C);
    ysAll.push(b.y - C, b.y + b.height + C);
    hugXs.add(rnd(b.x - C)).add(rnd(b.x + b.width + C));
    hugYs.add(rnd(b.y - C)).add(rnd(b.y + b.height + C));
  }
  // Lines that run along a lane frame read as part of the frame: avoid them.
  for (const x of avoid.xs) hugXs.add(rnd(x));
  for (const y of avoid.ys) hugYs.add(rnd(y));
  for (const e of edges) {
    for (const [p, side] of [
      [e.fromPort, e.fromSide],
      [e.toPort, e.toSide],
    ] as [Point, Side][]) {
      const st = stubOf(p, side);
      xsAll.push(p.x, st.x);
      ysAll.push(p.y, st.y);
    }
  }
  const uniq = (arr: number[], lo: number, hi: number) => [...new Set(arr.map(rnd))].filter((v) => v >= lo && v <= hi).sort((a, b) => a - b);
  const xs = uniq(xsAll, bounds.x0, bounds.x1);
  const ys = uniq(ysAll, bounds.y0, bounds.y1);
  const nx = xs.length;
  const ny = ys.length;
  const xi = new Map(xs.map((v, i) => [v, i]));
  const yi = new Map(ys.map((v, i) => [v, i]));
  const ix = (v: number) => xi.get(rnd(v));
  const iy = (v: number) => yi.get(rnd(v));
  const hugX = Uint8Array.from(xs, (x) => (hugXs.has(x) ? 1 : 0));
  const hugY = Uint8Array.from(ys, (y) => (hugYs.has(y) ? 1 : 0));

  // hBlock[j*nx+i]: segment (i,j)→(i+1,j) passes through a box (with its
  // clearance); vBlock[j*nx+i]: (i,j)→(i,j+1). Marked box by box.
  const hBlock = new Uint8Array(nx * ny);
  const vBlock = new Uint8Array(nx * ny);
  const firstAbove = (arr: number[], v: number) => {
    let lo = 0;
    let hi = arr.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (arr[mid] > v) hi = mid;
      else lo = mid + 1;
    }
    return lo;
  };
  for (const b of boxes.values()) {
    const x0 = b.x - C;
    const x1 = b.x + b.width + C;
    const y0 = b.y - C;
    const y1 = b.y + b.height + C;
    const iA = firstAbove(xs, x0); // first line strictly right of x0
    const iB = firstAbove(xs, x1 - 1e-9); // first line at or right of x1
    const jA = firstAbove(ys, y0);
    const jB = firstAbove(ys, y1 - 1e-9);
    for (let j = jA; j < jB; j++) {
      for (let i = Math.max(0, iA - 1); i < Math.min(nx - 1, iB); i++) {
        const mx = (xs[i] + xs[i + 1]) / 2;
        if (mx > x0 && mx < x1) hBlock[j * nx + i] = 1;
      }
    }
    for (let i = iA; i < iB; i++) {
      for (let j = Math.max(0, jA - 1); j < Math.min(ny - 1, jB); j++) {
        const my = (ys[j] + ys[j + 1]) / 2;
        if (my > y0 && my < y1) vBlock[j * nx + i] = 1;
      }
    }
  }
  const hUse = new Uint16Array(nx * ny);
  const vUse = new Uint16Array(nx * ny);
  const hPass = new Uint16Array(nx * ny); // a route runs horizontally through this point
  const vPass = new Uint16Array(nx * ny);

  // Search state, shared by every edge; `seen` stamps which entries are live.
  const N = nx * ny * 4;
  const dist = new Float64Array(N);
  const prev = new Int32Array(N);
  const seen = new Uint32Array(N);
  let stamp = 0;

  const DX = [1, -1, 0, 0];
  const DY = [0, 0, 1, -1];
  const dirOf = (side: Side) => ({ right: 0, left: 1, bottom: 2, top: 3 })[side];
  const reverse = [1, 0, 3, 2];

  const routes = new Map<string, Point[]>();
  const order = [...edges].sort(
    (a, b) =>
      Math.abs(a.fromPort.x - a.toPort.x) + Math.abs(a.fromPort.y - a.toPort.y) - (Math.abs(b.fromPort.x - b.toPort.x) + Math.abs(b.fromPort.y - b.toPort.y)),
  );
  const solid = [...boxes.entries()];
  for (const e of order) {
    // Facing ports in line with nothing between them: one straight line.
    const a = e.fromPort;
    const b = e.toPort;
    if ((a.x === b.x || a.y === b.y) && dirOf(e.fromSide) === reverse[dirOf(e.toSide)] && towards(a, b, e.fromSide)) {
      const seg = { x0: Math.min(a.x, b.x), y0: Math.min(a.y, b.y), x1: Math.max(a.x, b.x), y1: Math.max(a.y, b.y) };
      const blocked = solid.some(([id, r]) => id !== e.from && id !== e.to && seg.x0 < r.x + r.width && r.x < seg.x1 && seg.y0 < r.y + r.height && r.y < seg.y1);
      if (!blocked) {
        routes.set(e.id, [a, b]);
        const path: [number | undefined, number | undefined][] = [];
        const [i0, j0, i1, j1] = [ix(a.x), iy(a.y), ix(b.x), iy(b.y)];
        if (j0 === j1) for (let i = Math.min(i0 as number, i1 as number); i <= Math.max(i0 as number, i1 as number); i++) path.push([i, j0]);
        else for (let j = Math.min(j0 as number, j1 as number); j <= Math.max(j0 as number, j1 as number); j++) path.push([i0, j]);
        if (path.every((pt): pt is [number, number] => pt[0] !== undefined && pt[1] !== undefined)) mark(path);
        continue;
      }
    }
    const st = stubOf(e.fromPort, e.fromSide);
    const tt = stubOf(e.toPort, e.toSide);
    const si = ix(st.x);
    const sj = iy(st.y);
    const ti = ix(tt.x);
    const tj = iy(tt.y);
    let path: [number, number][] | null = null;
    if (si !== undefined && sj !== undefined && ti !== undefined && tj !== undefined) {
      path = search(si, sj, dirOf(e.fromSide), ti, tj, reverse[dirOf(e.toSide)]);
    }
    const pts = path ? path.map(([i, j]) => ({ x: xs[i], y: ys[j] })) : elbow(st, tt, e.fromSide);
    if (path) mark(path);
    routes.set(e.id, simplify([e.fromPort, ...pts, e.toPort]));
  }
  return routes;

  function search(si: number, sj: number, sd: number, ti: number, tj: number, endDir: number): [number, number][] | null {
    stamp++;
    const W = SEARCH.weight;
    const tx = xs[ti];
    const ty = ys[tj];
    const heap = new Heap();
    const start = (sj * nx + si) * 4 + sd;
    dist[start] = 0;
    prev[start] = -1;
    seen[start] = stamp;
    heap.push(start, W * (Math.abs(xs[si] - tx) + Math.abs(ys[sj] - ty)));
    let best = -1;
    let bestCost = Infinity;
    let steps = 0;
    while (heap.size) {
      const st = heap.pop();
      if (heap.top >= bestCost) break;
      if (++steps > SEARCH.maxSteps) break;
      const d = st & 3;
      const p = st >> 2;
      const i = p % nx;
      const j = (p - i) / nx;
      const cost = dist[st];
      // A stale entry: this state was reached more cheaply since.
      if (heap.top > cost + W * (Math.abs(xs[i] - tx) + Math.abs(ys[j] - ty)) + 1e-6) continue;
      if (i === ti && j === tj) {
        const total = cost + (d === endDir ? 0 : COST.bend * (d === reverse[endDir] ? 3 : 1));
        if (total < bestCost) {
          bestCost = total;
          best = st;
        }
        continue;
      }
      for (let d2 = 0; d2 < 4; d2++) {
        if (d2 === reverse[d]) continue;
        const i2 = i + DX[d2];
        const j2 = j + DY[d2];
        if (i2 < 0 || j2 < 0 || i2 >= nx || j2 >= ny) continue;
        const horizontal = d2 < 2;
        const seg = horizontal ? j * nx + (i2 < i ? i2 : i) : (j2 < j ? j2 : j) * nx + i;
        if (horizontal ? hBlock[seg] : vBlock[seg]) continue;
        const len = horizontal ? Math.abs(xs[i2] - xs[i]) : Math.abs(ys[j2] - ys[j]);
        let c = len * ((horizontal ? hugY[j] : hugX[i]) ? 1 + COST.hug : 1);
        if (d2 !== d) c += COST.bend;
        const used = horizontal ? hUse[seg] : vUse[seg];
        if (used) c += used * COST.overlap * len;
        const p2 = j2 * nx + i2;
        if (horizontal ? vPass[p2] : hPass[p2]) c += COST.cross;
        const st2 = p2 * 4 + d2;
        const nd = cost + c;
        if (seen[st2] !== stamp || nd < dist[st2]) {
          seen[st2] = stamp;
          dist[st2] = nd;
          prev[st2] = st;
          heap.push(st2, nd + W * (Math.abs(xs[i2] - tx) + Math.abs(ys[j2] - ty)));
        }
      }
    }
    if (best < 0) return null;
    const out: [number, number][] = [];
    for (let st = best; st >= 0; st = prev[st]) {
      const p = st >> 2;
      out.push([p % nx, Math.floor(p / nx)]);
    }
    return out.reverse();
  }

  function mark(path: [number, number][]): void {
    for (let k = 1; k < path.length; k++) {
      const [i0, j0] = path[k - 1];
      const [i1, j1] = path[k];
      if (j0 === j1) {
        hUse[j0 * nx + Math.min(i0, i1)]++;
        hPass[j0 * nx + i0]++;
        hPass[j1 * nx + i1]++;
      } else {
        vUse[Math.min(j0, j1) * nx + i0]++;
        vPass[j0 * nx + i0]++;
        vPass[j1 * nx + i1]++;
      }
    }
  }
}

/** b lies ahead of a when leaving through `side`. */
function towards(a: Point, b: Point, side: Side): boolean {
  if (side === "right") return b.x > a.x;
  if (side === "left") return b.x < a.x;
  if (side === "bottom") return b.y > a.y;
  return b.y < a.y;
}

/** No path in the grid (should not happen): a plain elbow between the stubs. */
function elbow(s: Point, t: Point, fromSide: Side): Point[] {
  if (fromSide === "left" || fromSide === "right") {
    const mx = (s.x + t.x) / 2;
    return [s, { x: mx, y: s.y }, { x: mx, y: t.y }, t];
  }
  const my = (s.y + t.y) / 2;
  return [s, { x: s.x, y: my }, { x: t.x, y: my }, t];
}

function simplify(pts: Point[]): Point[] {
  const out: Point[] = [];
  for (const p of pts) {
    const last = out[out.length - 1];
    if (last && last.x === p.x && last.y === p.y) continue;
    if (out.length >= 2) {
      const a = out[out.length - 2];
      if ((a.x === last.x && last.x === p.x) || (a.y === last.y && last.y === p.y)) out.pop();
    }
    out.push(p);
  }
  return out;
}

// ── Labels and result ───────────────────────────────────────────────────────

/**
 * The label in a narrower chip, or null if that would cut a word in the
 * middle (paths and topics break at "/", "-", "_", ".", ":" like any wrap).
 */
function narrowLabel(label: string, width: number): EdgeLabelSize | null {
  if (label.split(/[\s/\-_.:]+/).some((word) => textWidth(word, SIZES.edge) > width - 12)) return null;
  if (textWidth(label, SIZES.edge) + 12 <= width) return null; // fits already: nothing to narrow
  const lines = wrapText(label, SIZES.edge, width - 12, 2);
  return { lines, width: Math.max(...lines.map((l) => textWidth(l, SIZES.edge))) + 12, height: 6 + lines.length * 13 };
}

const rectsOverlap = (a: Bounds, b: Bounds, pad = 0) => a.x0 < b.x1 + pad && b.x0 < a.x1 + pad && a.y0 < b.y1 + pad && b.y0 < a.y1 + pad;

/**
 * Put each edge label on its route where it covers no box, lane heading,
 * arrowhead or other label: centred on a segment, or beside a line in a
 * narrow channel, preferring segments in the gaps between lanes. A label
 * that fits nowhere at full width gets a narrower chip (full text in its
 * tooltip); one that fits nowhere at all stays inside the drawing.
 */
function placeLabels(edges: ModelEdge[], routes: Map<string, Point[]>, geo: Geometry): Map<string, LabelBox> {
  const { boxes } = geo;
  const bounds: Bounds = { x0: 2, y0: 2, x1: geo.width - 2, y1: geo.height - 2 };
  const boxRects: Bounds[] = [...boxes.values()].map((b) => ({ x0: b.x, y0: b.y, x1: b.x + b.width, y1: b.y + b.height }));
  const solid = [...boxRects];
  for (const lane of geo.lanes) {
    if (!lane.headLine) continue;
    const f = lane.frame;
    solid.push({ x0: f.x + 8, y0: f.y + 4, x1: f.x + 20 + textWidth(lane.headLine, LANES.headSize + 1, true), y1: f.y + LANES.head - 2 });
  }
  // Arrowheads: the last stretch of every route.
  for (const pts of routes.values()) {
    if (pts.length < 2) continue;
    const a = pts[pts.length - 2];
    const b = pts[pts.length - 1];
    const ux = Math.sign(b.x - a.x);
    const uy = Math.sign(b.y - a.y);
    const tail = { x: b.x - ux * 12, y: b.y - uy * 12 };
    solid.push({ x0: Math.min(tail.x, b.x) - 6, y0: Math.min(tail.y, b.y) - 6, x1: Math.max(tail.x, b.x) + 6, y1: Math.max(tail.y, b.y) + 6 });
  }
  const gutters = geo.channels.filter((c) => c.axis === "x" && !c.fixed);
  const inGutter = (x: number) => gutters.some((c) => x > c.lo && x < c.hi);
  const placed: Bounds[] = [];
  const out = new Map<string, LabelBox>();
  const area = (r: Bounds, list: Bounds[]) => list.reduce((sum, b) => sum + Math.max(0, Math.min(r.x1, b.x1) - Math.max(r.x0, b.x0)) * Math.max(0, Math.min(r.y1, b.y1) - Math.max(r.y0, b.y0)), 0);
  for (const e of edges) {
    const full = sizeEdgeLabel(e.label);
    const pts = routes.get(e.id);
    if (!full || !pts || pts.length < 2) continue;
    const segs: { a: Point; b: Point; vertical: boolean; score: number }[] = [];
    for (let k = 1; k < pts.length; k++) {
      const a = pts[k - 1];
      const b = pts[k];
      const len = Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
      const vertical = a.x === b.x;
      // In a gap between lanes a label reads as the line's, not a box's.
      const score = len + (vertical ? 0 : 20) + (inGutter((a.x + b.x) / 2) ? 200 : 0);
      segs.push({ a, b, vertical, score });
    }
    segs.sort((p, q) => q.score - p.score);
    const sizesToTry = [full, ...[GUTTER_LABEL_W, 76].filter((w) => w < full.width).map((w) => narrowLabel(e.label, w)).filter((lb): lb is EdgeLabelSize => !!lb)];
    let choice: { cx: number; cy: number; r: Bounds; lb: EdgeLabelSize } | null = null;
    let best: { cx: number; cy: number; r: Bounds; lb: EdgeLabelSize; cost: number } | null = null;
    for (const lb of sizesToTry) {
      for (const seg of segs) {
        // Centred on the line, then beside it (a narrow channel).
        const offsets: [number, number][] = seg.vertical ? [[0, 0], [lb.width / 2 - 5, 0], [-(lb.width / 2 - 5), 0]] : [[0, 0], [0, -(lb.height / 2 - 3)], [0, lb.height / 2 - 3]];
        // Middle first, then outward in small steps (so a label finds the gap
        // between two boxes along a long side channel).
        const len = Math.abs(seg.a.x - seg.b.x) + Math.abs(seg.a.y - seg.b.y);
        const step = Math.min(0.5, Math.max(6 / Math.max(1, len), 1 / 40));
        const ts = [0.5];
        for (let d = step; d < 0.5; d += step) ts.push(0.5 - d, 0.5 + d);
        for (const [dx, dy] of offsets) {
          for (const t of ts) {
            const cx = seg.a.x + (seg.b.x - seg.a.x) * t + dx;
            const cy = seg.a.y + (seg.b.y - seg.a.y) * t + dy;
            const r = { x0: cx - lb.width / 2, y0: cy - lb.height / 2, x1: cx + lb.width / 2, y1: cy + lb.height / 2 };
            if (r.x0 < bounds.x0 || r.x1 > bounds.x1 || r.y0 < bounds.y0 || r.y1 > bounds.y1) continue;
            const cost = area(r, boxRects) * 4 + area(r, solid) + area(r, placed) * 2;
            if (!best || cost < best.cost) best = { cx, cy, r, lb, cost };
            if (solid.some((q) => rectsOverlap(r, q, 3)) || placed.some((q) => rectsOverlap(r, q, 3))) continue;
            choice = { cx, cy, r, lb };
            break;
          }
          if (choice) break;
        }
        if (choice) break;
      }
      if (choice) break;
    }
    if (!choice) {
      if (best) choice = best;
      else {
        // Nowhere inside the drawing: the middle of the longest segment, clamped in.
        const seg = segs[0];
        const lb = sizesToTry[sizesToTry.length - 1];
        const cx = Math.min(bounds.x1 - lb.width / 2, Math.max(bounds.x0 + lb.width / 2, (seg.a.x + seg.b.x) / 2));
        const cy = Math.min(bounds.y1 - lb.height / 2, Math.max(bounds.y0 + lb.height / 2, (seg.a.y + seg.b.y) / 2));
        choice = { cx, cy, lb, r: { x0: cx - lb.width / 2, y0: cy - lb.height / 2, x1: cx + lb.width / 2, y1: cy + lb.height / 2 } };
      }
    }
    placed.push(choice.r);
    out.set(e.id, { cx: choice.cx, cy: choice.cy, width: choice.lb.width, height: choice.lb.height, lines: choice.lb.lines });
  }
  return out;
}

function finish({ geo, routed }: { geo: Geometry; routed: Map<string, Point[]> }, model: Model): Layout {
  const { boxes, lanes } = geo;
  const nodes: LaidOutNode[] = model.nodes.filter((n) => boxes.has(n.id)).map((n) => ({ ...n, ...known(boxes, n.id) }));
  const labels = placeLabels(model.edges, routed, geo);
  const edges: LaidOutEdge[] = model.edges
    .filter((e) => routed.has(e.id))
    .map((e) => ({ ...e, orthogonal: true, points: known(routed, e.id), labelBox: labels.get(e.id) || null }));

  const groups: LaidOutGroup[] = [];
  for (const lane of lanes) {
    if (!lane.group) continue;
    const f = lane.frame;
    groups.push({ ...lane.group, lane: true, labelLine: lane.headLine, x: f.x, y: f.y, width: f.w, height: f.h });
  }
  // Groups inside a lane: a frame around their members.
  for (const g of model.groups) {
    if (!g.parent) continue;
    const ms = g.members.map((id) => boxes.get(id)).filter((b): b is Box => !!b);
    if (!ms.length) continue;
    const pad = 9;
    const x0 = Math.min(...ms.map((b) => b.x)) - pad;
    const y0 = Math.min(...ms.map((b) => b.y)) - pad - (g.label ? 6 : 0);
    const x1 = Math.max(...ms.map((b) => b.x + b.width)) + pad;
    const y1 = Math.max(...ms.map((b) => b.y + b.height)) + pad;
    const labelLine = g.label ? wrapText(g.label, SIZES.group, Math.max(24, x1 - x0 - 24 - 14), 1)[0] : "";
    groups.push({ ...g, labelLine, x: x0, y: y0, width: x1 - x0, height: y1 - y0 });
  }
  // Everything drawn, including routes that went around the outside.
  let width = geo.width;
  let height = geo.height;
  for (const e of edges) {
    for (const p of e.points) {
      width = Math.max(width, Math.ceil(p.x + 8));
      height = Math.max(height, Math.ceil(p.y + 8));
    }
    if (e.labelBox) {
      width = Math.max(width, Math.ceil(e.labelBox.cx + e.labelBox.width / 2 + 6));
      height = Math.max(height, Math.ceil(e.labelBox.cy + e.labelBox.height / 2 + 6));
    }
  }
  return { rankdir: "lanes", nodes, edges, groups, width, height };
}

/** SVG path through right-angle points with softly rounded corners. */
export function orthogonalPath(points: Point[], radius = 6): string {
  if (!points.length) return "";
  const f = (n: number) => Math.round(n * 10) / 10;
  let d = `M${f(points[0].x)},${f(points[0].y)}`;
  for (let k = 1; k < points.length - 1; k++) {
    const p = points[k - 1];
    const c = points[k];
    const n = points[k + 1];
    const r = Math.min(radius, Math.hypot(c.x - p.x, c.y - p.y) / 2, Math.hypot(n.x - c.x, n.y - c.y) / 2);
    const ux = Math.sign(c.x - p.x);
    const uy = Math.sign(c.y - p.y);
    const vx = Math.sign(n.x - c.x);
    const vy = Math.sign(n.y - c.y);
    d += `L${f(c.x - ux * r)},${f(c.y - uy * r)}Q${f(c.x)},${f(c.y)} ${f(c.x + vx * r)},${f(c.y + vy * r)}`;
  }
  const last = points[points.length - 1];
  d += `L${f(last.x)},${f(last.y)}`;
  return d;
}
