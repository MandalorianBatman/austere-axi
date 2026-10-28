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
  edgeMaxW: 176,
  padX: 14,
  icon: 15,
  tagRow: 17,
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
  for (const ch of String(text ?? "")) w += charUnits(ch, mono);
  return Math.ceil(w * size);
}

function charUnits(ch, mono) {
  if (mono) return 0.62;
  if (ch.charCodeAt(0) > 0x2e7f) return 1.02; // CJK and other wide scripts
  if (/[ilI.,:;'|!()[\]{} ]/.test(ch)) return 0.32;
  if (/[mwMW@%&]/.test(ch)) return 0.88;
  if (/[A-Z0-9#$?_~]/.test(ch)) return 0.68;
  return 0.57;
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
    // One line past the limit proves the text is cut; stop measuring there
    // (an agent may paste a 10 kB token).
    if (lines.length > maxLines) break;
    if (textWidth(line + word, size, mono) <= maxWidth) {
      line += word;
      continue;
    }
    if (line) push(line);
    line = "";
    // A single word wider than the line: hard-break it at the longest prefix
    // that fits, measured forward and never inside a surrogate pair.
    let rest = word;
    while (lines.length <= maxLines && textWidth(rest, size, mono) > maxWidth) {
      let cut = 0;
      let units = 0;
      for (const ch of rest) {
        const u = charUnits(ch, mono);
        if (cut > 0 && Math.ceil((units + u) * size) > maxWidth) break;
        units += u;
        cut += ch.length;
      }
      push(rest.slice(0, cut));
      rest = rest.slice(cut);
    }
    line = rest;
  }
  if (line) push(line);
  if (lines.length <= maxLines) return lines.length ? lines : [""];
  const kept = lines.slice(0, maxLines);
  let last = Array.from(kept[maxLines - 1]);
  while (last.length && textWidth(`${last.join("")}…`, size, mono) > maxWidth) last.pop();
  kept[maxLines - 1] = `${last.join("").trimEnd()}…`;
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
        let first = groups.find((x) => x.id === owner.get(m));
        if (!isAncestor(groups, g.id, first.id)) {
          // Name the outermost group around the first that does not contain g:
          // that is the one g really crosses.
          for (let up = groups.find((x) => x.id === first.parent); up; up = groups.find((x) => x.id === up.parent)) {
            if (g.members.every((x) => up.memberSet.has(x))) break;
            first = up;
          }
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

/**
 * Size a node box from its text: a tag chip row (when tagged), label (≤2
 * lines), detail (1 line). Everything stays inside the box, so a chip never
 * covers an arrowhead.
 */
export function sizeNode(node) {
  const { label, detail, tag, nodeMinW, nodeMaxW, padX, icon } = SIZES;
  const labelRoom = nodeMaxW - padX * 2 - icon - 6;
  const natural = Math.max(
    textWidth(node.label, label) + icon + 6,
    node.detail ? textWidth(node.detail, detail, true) : 0,
    node.tag ? textWidth(node.tag, tag) + 14 : 0,
  );
  const width = Math.min(nodeMaxW, Math.max(nodeMinW, natural + padX * 2));
  const labelLines = wrapText(node.label, label, Math.min(labelRoom, width - padX * 2 - icon - 6), 2);
  const detailLine = node.detail ? wrapText(node.detail, detail, width - padX * 2, 1, true)[0] : "";
  const tagLine = node.tag ? wrapText(node.tag, tag, width - padX * 2 - 14, 1)[0] : "";
  const tagRow = tagLine ? SIZES.tagRow : 0;
  const height = 16 + tagRow + labelLines.length * 17 + (detailLine ? 16 : 0) + 8;
  return { width, height, labelLines, detailLine, tagLine, tagRow };
}

/** An edge label: up to two lines, so a sentence does not widen the whole diagram. */
export function sizeEdgeLabel(label) {
  if (!label) return null;
  const lines = wrapText(label, SIZES.edge, SIZES.edgeMaxW - 12, 2);
  const width = Math.max(...lines.map((l) => textWidth(l, SIZES.edge))) + 12;
  return { lines, width, height: 6 + lines.length * 13 };
}

function runLayout(model, rankdir) {
  const g = new dagre.graphlib.Graph({ compound: true, multigraph: true });
  g.setGraph({ rankdir, nodesep: rankdir === "LR" ? 26 : 34, ranksep: rankdir === "LR" ? 46 : 42, edgesep: 14, marginx: 18, marginy: 14 });
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
  const labels = new Map(model.edges.map((e) => [e.id, sizeEdgeLabel(e.label)]));
  for (const e of model.edges) {
    const lb = labels.get(e.id);
    g.setEdge(e.from, e.to, lb ? { width: lb.width, height: lb.height, labelpos: "c" } : {}, e.id);
  }
  dagre.layout(g);

  const nodes = model.nodes.map((n) => {
    const p = g.node(n.id);
    const box = boxes.get(n.id);
    return { ...n, ...box, x: p.x - box.width / 2, y: p.y - box.height / 2 };
  });
  const edges = model.edges.map((e) => {
    const d = g.edge({ v: e.from, w: e.to, name: e.id }) || {};
    const lb = labels.get(e.id);
    return {
      ...e,
      points: (d.points || []).map((pt) => ({ x: pt.x, y: pt.y })),
      labelBox: lb ? { cx: d.x, cy: d.y, width: lb.width, height: lb.height, lines: lb.lines } : null,
    };
  });
  const groups = model.groups.map((grp) => {
    const p = g.node(`group:${grp.id}`) || {};
    const width = p.width ?? 0;
    // The label chip sits on the frame's top edge; it never runs past the frame.
    const labelLine = grp.label ? wrapText(grp.label, SIZES.group, Math.max(24, width - 24 - 14), 1)[0] : "";
    return { ...grp, labelLine, x: (p.x ?? 0) - width / 2, y: (p.y ?? 0) - (p.height ?? 0) / 2, width, height: p.height ?? 0 };
  });
  const gr = g.graph();
  let width = Math.ceil(gr.width || 0);
  let height = Math.ceil(gr.height || 0);
  // dagre reserves a spot for each self-loop's label next to its node (to the
  // right going down, below going across, where no other edge attaches) but
  // returns unusable points. Draw each loop as an arc reaching to its label.
  for (const e of edges) {
    if (e.from !== e.to) continue;
    const n = nodes.find((x) => x.id === e.from);
    const d = g.edge({ v: e.from, w: e.to, name: e.id }) || {};
    const r = n.x + n.width;
    const b = n.y + n.height;
    const cx = n.x + n.width / 2;
    const cy = n.y + n.height / 2;
    const placed = Number.isFinite(d.x) && Number.isFinite(d.y);
    if (rankdir === "TB") {
      const lx = placed ? d.x : r + 30 + (e.labelBox ? e.labelBox.width / 2 : 0);
      const reach = Math.max(r + 18, e.labelBox ? lx - e.labelBox.width / 2 - 3 : lx);
      const y1 = cy - n.height * 0.22;
      const y2 = cy + n.height * 0.22;
      e.points = [
        { x: r, y: y1 },
        { x: reach, y: y1 - 8 },
        { x: reach, y: y2 + 8 },
        { x: r, y: y2 },
      ];
      if (e.labelBox) e.labelBox = { ...e.labelBox, cx: Math.max(lx, reach + 3 + e.labelBox.width / 2), cy };
    } else {
      const ly = placed ? d.y : b + 30 + (e.labelBox ? e.labelBox.height / 2 : 0);
      const reach = Math.max(b + 16, e.labelBox ? ly - e.labelBox.height / 2 - 3 : ly);
      const spread = Math.min(30, n.width * 0.3);
      e.points = [
        { x: cx - spread, y: b },
        { x: cx - spread - 8, y: reach },
        { x: cx + spread + 8, y: reach },
        { x: cx + spread, y: b },
      ];
      if (e.labelBox) e.labelBox = { ...e.labelBox, cx, cy: Math.max(ly, reach + 3 + e.labelBox.height / 2) };
    }
    const xs = e.points.map((p) => p.x);
    const ys = e.points.map((p) => p.y);
    if (e.labelBox) {
      xs.push(e.labelBox.cx + e.labelBox.width / 2);
      ys.push(e.labelBox.cy + e.labelBox.height / 2);
    }
    width = Math.max(width, Math.ceil(Math.max(...xs) + 12));
    height = Math.max(height, Math.ceil(Math.max(...ys) + 10));
  }
  return { rankdir, nodes, edges, groups, width, height };
}

// Text shown at less than this fraction of its size starts to be hard to read.
export const LEGIBLE_SCALE = 0.85;

/** Fraction of natural size a layout is drawn at in `targetWidth`. */
export function scaleAt(layout, targetWidth = DEFAULT_TARGET_WIDTH) {
  return Math.min(1, targetWidth / Math.max(1, layout.width));
}

/**
 * Lay out a model. direction "right" or "down" forces it. "auto" keeps
 * left-to-right while its text stays legible at `targetWidth`, otherwise
 * top-to-bottom (a long page is cheap to scroll; shrunken text is not), and
 * when neither is legible, top-to-bottom unless left-to-right shrinks clearly
 * less. So the same diagram can run across on a desktop and down on a phone.
 */
export function layoutModel(model, targetWidth = DEFAULT_TARGET_WIDTH) {
  if (!model.nodes.length) return null;
  if (model.direction === "right") return runLayout(model, "LR");
  if (model.direction === "down") return runLayout(model, "TB");
  const lr = runLayout(model, "LR");
  if (scaleAt(lr, targetWidth) >= LEGIBLE_SCALE) return lr;
  const tb = runLayout(model, "TB");
  if (scaleAt(tb, targetWidth) >= LEGIBLE_SCALE) return tb;
  // Neither fits: top-to-bottom unless left-to-right is clearly larger. Down
  // keeps each group in fewer ranks, so zones stay compact instead of
  // stretching into bands across the diagram.
  return scaleAt(lr, targetWidth) > scaleAt(tb, targetWidth) * 1.1 ? lr : tb;
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
