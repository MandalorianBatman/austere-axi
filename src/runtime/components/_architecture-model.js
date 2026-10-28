// Architecture diagrams: the parsed OpenUI props → a graph model → an automatic
// dagre layout. Free of JSX and DOM so it can be unit-tested in Node
// (test/components.test.js). Never throws on agent input.
import dagre from "@dagrejs/dagre";

// Vocabulary borrowed from archify's JSON IR, so agents that know it feel at home.
export const NODE_KINDS = ["frontend", "backend", "database", "messagebus", "cloud", "security", "external"];
export const EDGE_STYLES = ["solid", "dashed", "emphasis", "security"];
export const GROUP_KINDS = ["region", "security"];
export const DIRECTIONS = ["auto", "right", "down"];

export const SIZES = {
  label: 13,
  detail: 11,
  tag: 10,
  edge: 11,
  group: 11,
  nodeMinW: 128,
  nodeMaxW: 232,
  padX: 14,
  icon: 15,
};

// Width the page column gives a diagram on desktop; the renderer passes the
// real width of its container when it knows it.
export const DEFAULT_TARGET_WIDTH = 900;

/**
 * Approximate advance width of text at a font size. Deterministic (no DOM) and
 * deliberately generous, so laid-out boxes never clip their text.
 */
export function textWidth(text, size, mono = false) {
  let w = 0;
  for (const ch of String(text ?? "")) {
    if (mono) w += 0.62;
    else if (ch.charCodeAt(0) > 0x2e7f) w += 1.02; // CJK and other wide scripts
    else if (/[ilI.,:;'|!()[\]{} ]/.test(ch)) w += 0.32;
    else if (/[mwMW@%&]/.test(ch)) w += 0.88;
    else if (/[A-Z0-9#$?_~]/.test(ch)) w += 0.68;
    else w += 0.57;
  }
  return Math.ceil(w * size);
}

/**
 * Break text into at most `maxLines` lines no wider than `maxWidth`, preferring
 * breaks after spaces, "/", "-", "_" and "."; the last line ends in "…" when cut.
 */
export function wrapText(text, size, maxWidth, maxLines = 2, mono = false) {
  // Words keep their trailing break character ("src/", "read-"); no lookbehind,
  // which Safari before 16.4 cannot parse at all.
  const words = (String(text ?? "").trim().match(/[^\s/\-_.:]*[\s/\-_.:]?/g) || []).filter(Boolean);
  const lines = [];
  let line = "";
  const push = (s) => lines.push(s.trimEnd());
  for (const word of words) {
    if (textWidth(line + word, size, mono) <= maxWidth) {
      line += word;
      continue;
    }
    if (line) push(line);
    line = "";
    // A single word wider than the line: hard-break it.
    let rest = word;
    while (textWidth(rest, size, mono) > maxWidth) {
      let cut = rest.length;
      while (cut > 1 && textWidth(rest.slice(0, cut), size, mono) > maxWidth) cut--;
      push(rest.slice(0, cut));
      rest = rest.slice(cut);
    }
    line = rest;
  }
  if (line) push(line);
  if (lines.length <= maxLines) return lines.length ? lines : [""];
  const kept = lines.slice(0, maxLines);
  let last = kept[maxLines - 1];
  while (last && textWidth(`${last}…`, size, mono) > maxWidth) last = last.slice(0, -1);
  kept[maxLines - 1] = `${last}…`;
  return kept;
}

const isElement = (v) => v && typeof v === "object" && v.props && typeof v.props === "object";
const str = (v) => (typeof v === "string" ? v : v == null ? "" : String(v));

/**
 * Parsed props of Architecture(nodes, edges, groups?, direction?) → model.
 * Ids are statement names; inline (unnamed) nodes, edges and groups get
 * synthetic ids and are not separate click targets.
 * @returns {{ nodes: object[], edges: object[], groups: object[], direction: string, problems: string[] }}
 */
export function buildModel(props) {
  const problems = [];
  const nodes = new Map();
  const seenEls = new Map();
  let anon = 0;

  const addNode = (el) => {
    if (!isElement(el)) return null;
    if (seenEls.has(el)) return seenEls.get(el);
    const id = el.statementId || `_node${anon++}`;
    if (!nodes.has(id)) {
      const p = el.props;
      const label = str(p.label).trim() || id;
      nodes.set(id, {
        id,
        named: !!el.statementId,
        label,
        kind: NODE_KINDS.includes(p.kind) ? p.kind : "backend",
        detail: str(p.detail).trim(),
        tag: str(p.tag).trim(),
      });
    }
    seenEls.set(el, id);
    return id;
  };

  for (const el of Array.isArray(props?.nodes) ? props.nodes : []) addNode(el);

  const edges = [];
  const edgeIds = new Set();
  for (const el of Array.isArray(props?.edges) ? props.edges : []) {
    if (!isElement(el)) continue;
    const id = el.statementId || `_edge${anon++}`;
    if (edgeIds.has(id)) continue;
    const from = addNode(el.props.from);
    const to = addNode(el.props.to);
    if (!from || !to) continue; // the parser already reports the missing end
    edgeIds.add(id);
    edges.push({
      id,
      named: !!el.statementId,
      from,
      to,
      label: str(el.props.label).trim(),
      style: EDGE_STYLES.includes(el.props.style) ? el.props.style : "solid",
    });
  }

  const groups = [];
  const groupIds = new Set();
  for (const el of Array.isArray(props?.groups) ? props.groups : []) {
    if (!isElement(el)) continue;
    const id = el.statementId || `_group${anon++}`;
    if (groupIds.has(id)) continue;
    const members = [...new Set((Array.isArray(el.props.members) ? el.props.members : []).map(addNode).filter(Boolean))];
    if (!members.length) continue;
    groupIds.add(id);
    groups.push({
      id,
      named: !!el.statementId,
      label: str(el.props.label).trim(),
      kind: GROUP_KINDS.includes(el.props.kind) ? el.props.kind : "region",
      members,
    });
  }

  nestGroups(groups, problems);
  const direction = DIRECTIONS.includes(props?.direction) ? props.direction : "auto";
  return { nodes: [...nodes.values()], edges, groups, direction, problems };
}

/**
 * Groups must form a tree for drawing. Each group's parent is the smallest
 * group that contains all its members; each node sits in the smallest group
 * that lists it. Groups that overlap without nesting are reported.
 */
function nestGroups(groups, problems) {
  const bySize = [...groups].sort((a, b) => a.members.length - b.members.length);
  for (const g of bySize) {
    const set = new Set(g.members);
    g.parent =
      bySize.find((o) => o !== g && o.members.length >= g.members.length && bySize.indexOf(o) > bySize.indexOf(g) && g.members.every((m) => o.members.includes(m)))
        ?.id ?? null;
    g.memberSet = set;
  }
  const owner = new Map();
  for (const g of bySize) {
    for (const m of g.members) {
      if (!owner.has(m)) owner.set(m, g.id);
      else {
        const first = groups.find((x) => x.id === owner.get(m));
        if (!isAncestor(groups, g.id, first.id)) {
          problems.push(
            `Groups ${first.named ? first.id : `"${first.label}"`} and ${g.named ? g.id : `"${g.label}"`} share ${m} but neither contains the other; it is drawn in the first. Nest one group inside the other or remove ${m} from one.`,
          );
        }
      }
    }
  }
  for (const g of groups) g.directMembers = g.members.filter((m) => owner.get(m) === g.id);
}

function isAncestor(groups, ancestorId, id) {
  let cur = groups.find((g) => g.id === id);
  while (cur?.parent) {
    if (cur.parent === ancestorId) return true;
    cur = groups.find((g) => g.id === cur.parent);
  }
  return false;
}

/** Size a node box from its text: label (≤2 lines), detail (1 line), tag chip. */
export function sizeNode(node) {
  const { label, detail, tag, nodeMinW, nodeMaxW, padX, icon } = SIZES;
  const labelRoom = nodeMaxW - padX * 2 - icon - 6;
  const natural = Math.max(
    textWidth(node.label, label) + icon + 6,
    node.detail ? textWidth(node.detail, detail, true) : 0,
    node.tag ? textWidth(node.tag, tag) + 24 : 0,
  );
  const width = Math.min(nodeMaxW, Math.max(nodeMinW, natural + padX * 2));
  const labelLines = wrapText(node.label, label, Math.min(labelRoom, width - padX * 2 - icon - 6), 2);
  const detailLine = node.detail ? wrapText(node.detail, detail, width - padX * 2, 1, true)[0] : "";
  const height = 16 + labelLines.length * 17 + (detailLine ? 16 : 0) + 8;
  return { width, height, labelLines, detailLine };
}

function runLayout(model, rankdir) {
  const g = new dagre.graphlib.Graph({ compound: true, multigraph: true });
  g.setGraph({ rankdir, nodesep: rankdir === "LR" ? 26 : 34, ranksep: rankdir === "LR" ? 46 : 42, edgesep: 14, marginx: 18, marginy: 22 });
  g.setDefaultEdgeLabel(() => ({}));
  const boxes = new Map();
  for (const n of model.nodes) {
    const box = sizeNode(n);
    boxes.set(n.id, box);
    g.setNode(n.id, { width: box.width, height: box.height });
  }
  for (const grp of model.groups) g.setNode(`group:${grp.id}`, {});
  for (const grp of model.groups) {
    if (grp.parent) g.setParent(`group:${grp.id}`, `group:${grp.parent}`);
    for (const m of grp.directMembers) g.setParent(m, `group:${grp.id}`);
  }
  for (const e of model.edges) {
    const lw = e.label ? textWidth(e.label, SIZES.edge) + 12 : 0;
    g.setEdge(e.from, e.to, e.label ? { width: lw, height: 18, labelpos: "c" } : {}, e.id);
  }
  dagre.layout(g);

  const nodes = model.nodes.map((n) => {
    const p = g.node(n.id);
    const box = boxes.get(n.id);
    return { ...n, ...box, x: p.x - box.width / 2, y: p.y - box.height / 2 };
  });
  const edges = model.edges.map((e) => {
    const d = g.edge({ v: e.from, w: e.to, name: e.id }) || {};
    return {
      ...e,
      points: (d.points || []).map((pt) => ({ x: pt.x, y: pt.y })),
      labelBox: e.label ? { cx: d.x, cy: d.y, width: textWidth(e.label, SIZES.edge) + 12, height: 18 } : null,
    };
  });
  const groups = model.groups.map((grp) => {
    const p = g.node(`group:${grp.id}`) || {};
    return { ...grp, x: (p.x ?? 0) - (p.width ?? 0) / 2, y: (p.y ?? 0) - (p.height ?? 0) / 2, width: p.width ?? 0, height: p.height ?? 0 };
  });
  const gr = g.graph();
  let width = Math.ceil(gr.width || 0);
  // dagre reserves room for self-loops but returns unusable points for them;
  // draw each as a small arc off the node's right side, label beside it.
  for (const e of edges) {
    if (e.from !== e.to) continue;
    const n = nodes.find((x) => x.id === e.from);
    const r = n.x + n.width;
    const y1 = n.y + n.height * 0.3;
    const y2 = n.y + n.height * 0.7;
    e.points = [
      { x: r, y: y1 },
      { x: r + 26, y: y1 - 10 },
      { x: r + 26, y: y2 + 10 },
      { x: r, y: y2 },
    ];
    if (e.labelBox) e.labelBox = { ...e.labelBox, cx: r + 30 + e.labelBox.width / 2, cy: n.y + n.height / 2 };
    const right = e.labelBox ? e.labelBox.cx + e.labelBox.width / 2 : r + 30;
    width = Math.max(width, Math.ceil(right + 12));
  }
  return { rankdir, nodes, edges, groups, width, height: Math.ceil(gr.height || 0) };
}

/** Higher is better: legible at the available width, and not absurdly tall. */
export function fitScore(layout, targetWidth = DEFAULT_TARGET_WIDTH) {
  const scale = Math.min(1, targetWidth / Math.max(1, layout.width));
  const shown = layout.height * scale;
  return scale - Math.max(0, (shown - 760) / 1600);
}

/**
 * Lay out a model. direction "right" or "down" forces it; "auto" tries both
 * and keeps the one that stays legible at `targetWidth` (ties go to "right"),
 * so the same diagram can run across on a desktop and down on a phone.
 */
export function layoutModel(model, targetWidth = DEFAULT_TARGET_WIDTH) {
  if (!model.nodes.length) return null;
  if (model.direction === "right") return runLayout(model, "LR");
  if (model.direction === "down") return runLayout(model, "TB");
  const lr = runLayout(model, "LR");
  const tb = runLayout(model, "TB");
  return fitScore(lr, targetWidth) >= fitScore(tb, targetWidth) - 0.04 ? lr : tb;
}

/** d3 curveBasis through dagre's points, so edges read as smooth curves. */
export function edgePath(points) {
  if (!points.length) return "";
  const f = (n) => Math.round(n * 10) / 10;
  if (points.length < 3) return `M${f(points[0].x)},${f(points[0].y)}L${f(points.at(-1).x)},${f(points.at(-1).y)}`;
  let [x0, y0] = [points[0].x, points[0].y];
  let [x1, y1] = [points[1].x, points[1].y];
  let d = `M${f(x0)},${f(y0)}L${f((5 * x0 + x1) / 6)},${f((5 * y0 + y1) / 6)}`;
  for (let i = 2; i < points.length; i++) {
    const { x, y } = points[i];
    d += `C${f((2 * x0 + x1) / 3)},${f((2 * y0 + y1) / 3)} ${f((x0 + 2 * x1) / 3)},${f((y0 + 2 * y1) / 3)} ${f((x0 + 4 * x1 + x) / 6)},${f((y0 + 4 * y1 + y) / 6)}`;
    [x0, y0, x1, y1] = [x1, y1, x, y];
  }
  d += `C${f((2 * x0 + x1) / 3)},${f((2 * y0 + y1) / 3)} ${f((x0 + 2 * x1) / 3)},${f((y0 + 2 * y1) / 3)} ${f(x1)},${f(y1)}`;
  return d;
}
