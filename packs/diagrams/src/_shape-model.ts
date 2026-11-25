// Quadrant, Venn, Pyramid, Loop, Fishbone and WardleyMap: parsed props → geometry.
// Pure TypeScript (no JSX), so Node tests can import it. Never throws: a shape that is
// wrong still draws what it can, and says what it dropped in `problems`.
import { clean, parseNumber, partsOf } from "./_matrix-model.ts";
import type { Part } from "./_matrix-model.ts";

// ── text ──

/** Estimated width of a text in px: Latin averages 0.58 em, wide scripts a full em. */
export function textW(text: string, size: number): number {
  let w = 0;
  for (const ch of text) w += ((ch.codePointAt(0) ?? 0) > 0x2e7f ? 1 : 0.58) * size;
  return w;
}

/** One line cut with "…" to fit `max` px. */
export function fit(text: string, max: number, size: number): string {
  if (textW(text, size) <= max) return text;
  let out = "";
  for (const ch of text) {
    if (textW(out + ch + "…", size) > max) break;
    out += ch;
  }
  return `${out.trimEnd()}…`;
}

/** Lines of at most `max` px, broken at spaces (inside a word when it is too long). The last line is cut with "…". */
export function wrapText(text: string, max: number, size: number, maxLines: number): string[] {
  const lines: string[] = [];
  let line = "";
  const push = () => {
    if (line) lines.push(line);
    line = "";
  };
  for (const word of text.split(" ").filter(Boolean)) {
    if (textW(word, size) > max) {
      push();
      let chunk = "";
      for (const ch of word) {
        if (textW(chunk + ch, size) > max && chunk) {
          lines.push(chunk);
          chunk = "";
        }
        chunk += ch;
      }
      line = chunk;
      continue;
    }
    const next = line ? `${line} ${word}` : word;
    if (textW(next, size) > max) {
      push();
      line = word;
    } else line = next;
  }
  push();
  if (lines.length > maxLines) {
    const kept = lines.slice(0, maxLines);
    kept[maxLines - 1] = fit(`${kept[maxLines - 1]} ${lines.slice(maxLines).join(" ")}`, max, size);
    return kept;
  }
  return lines.length ? lines : [""];
}

/**
 * Lines of at most `max` px, broken only at spaces. With `strict`, returns null when a word is
 * wider than `max` or the text needs more than `maxLines`; otherwise such a word, or the end of
 * the last line, is cut with "…".
 */
export function wrapWords(
  text: string,
  max: number,
  size: number,
  maxLines: number,
  strict: boolean,
): string[] | null {
  const lines: string[] = [];
  let line = "";
  for (const raw of text.split(" ").filter(Boolean)) {
    let word = raw;
    if (textW(word, size) > max) {
      if (strict) return null;
      word = fit(word, max, size);
    }
    const next = line ? `${line} ${word}` : word;
    if (textW(next, size) > max) {
      lines.push(line);
      line = word;
    } else line = next;
  }
  if (line) lines.push(line);
  if (lines.length > maxLines) {
    if (strict) return null;
    const kept = lines.slice(0, maxLines);
    kept[maxLines - 1] = fit(`${kept[maxLines - 1]} ${lines.slice(maxLines).join(" ")}`, max, size);
    return kept;
  }
  return lines.length ? lines : [""];
}

export interface Rect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}
const hit = (a: Rect, b: Rect): boolean => a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1;
const r1 = (n: number): number => Math.round(n * 10) / 10;

/** The first part of a one-element prop (a hub), or undefined. */
function single(
  value: unknown,
  tag: string,
  part: string,
  component: string,
  problems: string[],
): Part | undefined {
  return partsOf(value == null ? [] : [value], tag, part, component, problems)[0];
}

const flag = (v: unknown): boolean => v === true || v === "true";

// ── Quadrant ──

export const QUAD = {
  w: 640,
  h: 500,
  x0: 60,
  x1: 600,
  y0: 56,
  y1: 456,
  item: 200,
  corner: 230,
} as const;
/** On a phone the plot fills the width, so the figure is drawn at scale 1. */
export const QUAD_PHONE = {
  w: 350,
  h: 430,
  x0: 30,
  x1: 340,
  y0: 44,
  y1: 392,
  item: 112,
  corner: 130,
} as const;
export type QuadGeo = typeof QUAD | typeof QUAD_PHONE;

export interface QuadItem {
  id: string;
  named: boolean;
  label: string;
  /** What the reader sees: the label, cut to fit. */
  shown: string;
  x: number;
  y: number;
  px: number;
  py: number;
  focus: boolean;
  lx: number;
  ly: number;
  anchor: "start" | "middle" | "end";
}

export interface QuadModel {
  items: QuadItem[];
  xAxis: string;
  yAxis: string;
  /** Top left, top right, bottom left, bottom right; "" when not named. */
  quadrants: string[];
  problems: string[];
  geo: QuadGeo;
}

const LABEL_SIZE = 12;
const CANDIDATES: [number, number, "start" | "middle" | "end"][] = [
  [10, 4, "start"],
  [-10, 4, "end"],
  [0, -11, "middle"],
  [0, 19, "middle"],
  [10, -9, "start"],
  [-10, -9, "end"],
  [10, 17, "start"],
  [-10, 17, "end"],
];

/** Quadrant(items, xAxis, yAxis, quadrants?): items placed by x and y (0 to 100), labels placed so none overlaps. */
export function buildQuadrant(
  props: Record<string, unknown> | undefined,
  phone = false,
): QuadModel {
  const problems: string[] = [];
  const geo: QuadGeo = phone ? QUAD_PHONE : QUAD;
  const { x0, x1, y0, y1 } = geo;
  const cx = (x0 + x1) / 2;
  const cy = (y0 + y1) / 2;
  const items: QuadItem[] = [];
  let focused = false;
  for (const part of partsOf(props?.items, "item", "QuadrantItem", "Quadrant", problems)) {
    const label = clean(part.props.label) || part.id;
    const said = fit(label, 120, 12);
    let x = parseNumber(part.props.x);
    let y = parseNumber(part.props.y);
    if (x === null || y === null) {
      problems.push(
        `QuadrantItem "${said}" needs x and y from 0 to 100 (x: ${clean(part.props.x) || "none"}, y: ${clean(part.props.y) || "none"}). It is not drawn.`,
      );
      continue;
    }
    if (x < 0 || x > 100 || y < 0 || y > 100) {
      problems.push(`QuadrantItem "${said}" is outside 0 to 100. It is drawn at the edge.`);
      x = Math.min(100, Math.max(0, x));
      y = Math.min(100, Math.max(0, y));
    }
    if (x === 50 || y === 50) {
      problems.push(
        `QuadrantItem "${said}" sits on an axis line, so its quadrant is unclear. Move it off 50.`,
      );
    }
    let focus = flag(part.props.focus);
    if (focus && focused) {
      problems.push(`More than one QuadrantItem has focus. "${label}" is drawn without it.`);
      focus = false;
    }
    focused ||= focus;
    items.push({
      id: part.id,
      named: part.named,
      label,
      shown: fit(label, geo.item, LABEL_SIZE),
      x,
      y,
      px: x0 + (x / 100) * (x1 - x0),
      py: y1 - (y / 100) * (y1 - y0),
      focus,
      lx: 0,
      ly: 0,
      anchor: "start",
    });
  }
  const names = Array.isArray(props?.quadrants) ? props.quadrants.map((q) => clean(q)) : [];
  const quadrants = [0, 1, 2, 3].map((i) => fit(names[i] ?? "", geo.corner, 10));
  // Space the labels must keep clear: the dots, the quadrant names, the axis lines.
  const taken: Rect[] = items.map((i) => ({
    x0: i.px - 6,
    y0: i.py - 6,
    x1: i.px + 6,
    y1: i.py + 6,
  }));
  const corner = (i: number): Rect | null => {
    if (!quadrants[i]) return null;
    const w = textW(quadrants[i].toUpperCase(), 10) * 1.2 + 4;
    const left = i % 2 === 0;
    const top = i < 2;
    const xa = left ? x0 + 12 : x1 - 12 - w;
    const ya = top ? y0 + 6 : y1 - 22;
    return { x0: xa, y0: ya, x1: xa + w, y1: ya + 16 };
  };
  for (let i = 0; i < 4; i++) {
    const c = corner(i);
    if (c) taken.push(c);
  }
  for (const item of items) {
    const w = textW(item.shown, LABEL_SIZE);
    let best = { cost: Infinity, c: CANDIDATES[0], box: null as Rect | null };
    CANDIDATES.forEach((c, order) => {
      const [dx, dy, anchor] = c;
      const left =
        anchor === "start" ? item.px + dx : anchor === "end" ? item.px + dx - w : item.px - w / 2;
      const base = item.py + dy;
      const box: Rect = { x0: left, y0: base - 11, x1: left + w, y1: base + 4 };
      let cost = order;
      for (const t of taken) if (hit(box, t)) cost += 1000;
      if (box.x0 < x0 + 4 || box.x1 > x1 - 4 || box.y0 < y0 + 2 || box.y1 > y1 - 2) cost += 1000;
      if (box.x0 < cx && cx < box.x1) cost += 1000;
      if (box.y0 < cy && cy < box.y1) cost += 1000;
      if (cost < best.cost) best = { cost, c, box };
    });
    const [dx, dy, anchor] = best.c;
    item.anchor = anchor;
    item.lx = item.px + dx;
    item.ly = item.py + dy;
    if (best.box) taken.push(best.box);
    if (best.cost >= 1000) {
      problems.push(
        `The label of "${fit(item.label, 120, 12)}" overlaps another label or an axis. Move the items apart.`,
      );
    }
  }
  return {
    items,
    xAxis: fit(clean(props?.xAxis), 200, 10),
    yAxis: fit(clean(props?.yAxis), 200, 10),
    quadrants,
    problems,
    geo,
  };
}

// ── Venn ──

export interface VennSetModel {
  id: string;
  named: boolean;
  name: string;
  detail: string;
  cx: number;
  cy: number;
  r: number;
}

export interface RegionLine {
  text: string;
  cls: "name" | "detail" | "overlap";
}

export interface RegionLabel {
  x: number;
  y: number;
  lines: RegionLine[];
  /** For the click target: a box around the text. */
  box: Rect;
}

export interface VennOverlapModel {
  id: string;
  named: boolean;
  label: string;
  /** Indexes into `sets`, ascending. */
  of: number[];
  focus: boolean;
  text: RegionLabel | null;
}

export interface VennModel {
  sets: VennSetModel[];
  setLabels: (RegionLabel | null)[];
  overlaps: VennOverlapModel[];
  w: number;
  h: number;
  problems: string[];
}

const LH = 15;

/** Venn(sets, overlaps?): 2 or 3 circles, radius by area when the sets have sizes; each overlap named by the sets it joins. */
export function buildVenn(props: Record<string, unknown> | undefined): VennModel {
  const problems: string[] = [];
  let setParts = partsOf(props?.sets, "set", "VennSet", "Venn", problems);
  if (setParts.length > 3) {
    problems.push(
      `Venn draws 2 or 3 sets. ${setParts
        .slice(3)
        .map((p) => clean(p.props.name) || p.id)
        .join(", ")} ${setParts.length > 4 ? "are" : "is"} not drawn. Use a Heatmap for more.`,
    );
    setParts = setParts.slice(0, 3);
  }
  if (setParts.length < 2) {
    return { sets: [], setLabels: [], overlaps: [], w: 0, h: 0, problems };
  }
  const n = setParts.length;
  const sizes = setParts.map((p) => {
    const s = parseNumber(p.props.size);
    return s !== null && s > 0 ? s : null;
  });
  const sized = sizes.every((s) => s !== null);
  if (!sized && sizes.some((s) => s !== null)) {
    problems.push("Only some VennSets have a size. Every circle is drawn the same size.");
  }
  const maxSize = sized ? Math.max(...(sizes as number[])) : 1;
  const base = n === 2 ? 150 : 125;
  const sets: VennSetModel[] = setParts.map((p, i) => ({
    id: p.id,
    named: p.named,
    name: clean(p.props.name) || p.id,
    detail: clean(p.props.detail),
    cx: 0,
    cy: 0,
    r: sized ? Math.max(base * 0.42, base * Math.sqrt((sizes[i] as number) / maxSize)) : base,
  }));
  const factor = n === 2 ? 0.62 : 0.66;
  const dist = (a: number, b: number) => factor * (sets[a].r + sets[b].r);
  sets[1].cx = dist(0, 1);
  if (n === 3) {
    const ab = dist(0, 1);
    const ac = dist(0, 2);
    const bc = dist(1, 2);
    const x = (ac * ac - bc * bc + ab * ab) / (2 * ab);
    sets[2].cx = x;
    sets[2].cy = Math.sqrt(Math.max(ac * ac - x * x, 0));
  }
  // Move to the origin of the box, margin 24.
  const minX = Math.min(...sets.map((s) => s.cx - s.r));
  const minY = Math.min(...sets.map((s) => s.cy - s.r));
  const maxX = Math.max(...sets.map((s) => s.cx + s.r));
  const maxY = Math.max(...sets.map((s) => s.cy + s.r));
  const M = 24;
  for (const s of sets) {
    s.cx += M - minX;
    s.cy += M - minY;
  }
  const w = Math.ceil(maxX - minX + 2 * M);
  const h = Math.ceil(maxY - minY + 2 * M);

  const maskAt = (x: number, y: number): number => {
    let m = 0;
    sets.forEach((s, i) => {
      if ((x - s.cx) ** 2 + (y - s.cy) ** 2 < s.r * s.r) m |= 1 << i;
    });
    return m;
  };
  const STEP = 3;
  const pts = new Map<number, { x: number; y: number }[]>();
  for (let y = 0; y <= h; y += STEP) {
    for (let x = 0; x <= w; x += STEP) {
      const m = maskAt(x, y);
      if (!m) continue;
      let list = pts.get(m);
      if (!list) pts.set(m, (list = []));
      list.push({ x, y });
    }
  }
  const placed: Rect[] = [];
  /** True when the whole box lies inside the region `mask` (sampled every 4px along and across it). */
  const inside = (mask: number, r: Rect): boolean => {
    for (
      let x = r.x0;
      x <= r.x1 + 0.1;
      x += Math.max(4, (r.x1 - r.x0) / Math.ceil((r.x1 - r.x0) / 4))
    ) {
      for (const y of [r.y0, (r.y0 + r.y1) / 2, r.y1]) if (maskAt(x, y) !== mask) return false;
    }
    for (const x of [r.x0, r.x1]) {
      for (let y = r.y0; y <= r.y1; y += 4) if (maskAt(x, y) !== mask) return false;
    }
    return true;
  };
  /** Text for one region, cut to fit inside it and clear of every label placed before; null with a reported problem when it cannot. */
  const place = (
    mask: number,
    what: string,
    blocks: { text: string; size: number; cls: RegionLine["cls"]; max: number }[],
  ): RegionLabel | null => {
    const list = pts.get(mask);
    if (!list?.length) {
      problems.push(
        `The region of ${what} is empty: the circles do not overlap there. Change the sizes.`,
      );
      return null;
    }
    const mx = list.reduce((a, q) => a + q.x, 0) / list.length;
    const my = list.reduce((a, q) => a + q.y, 0) / list.length;
    const order = list
      .map((q) => ({ q, d: (q.x - mx) ** 2 + (q.y - my) ** 2 }))
      .sort((u, v) => u.d - v.d)
      .map((u) => u.q);
    // First try to keep every word whole and nothing cut; then allow a cut with "…".
    for (const strict of [true, false]) {
      for (const W of [150, 110, 84, 64, 48, 36]) {
        const lines: RegionLine[] = [];
        let whole = true;
        for (const bl of blocks) {
          if (!bl.text) continue;
          const room = Math.max(1, 4 - lines.length);
          const wrapped = wrapWords(bl.text, W, bl.size, Math.min(bl.max, room), strict);
          if (!wrapped) {
            whole = false;
            break;
          }
          for (const text of wrapped) lines.push({ text, cls: bl.cls });
        }
        if (!whole) continue;
        const width = Math.max(
          ...lines.map((l) => textW(l.text, l.cls === "detail" ? 11 : 13)),
          12,
        );
        const height = lines.length * LH;
        for (const q of order.slice(0, 1500)) {
          const box: Rect = {
            x0: q.x - width / 2 - 3,
            y0: q.y - height / 2 - 2,
            x1: q.x + width / 2 + 3,
            y1: q.y + height / 2 + 2,
          };
          if (inside(mask, box) && !placed.some((o) => hit(box, o))) {
            placed.push(box);
            return { x: q.x, y: q.y, lines, box };
          }
        }
      }
    }
    problems.push(`There is no room for the label of ${what}. Shorten it, or change the sizes.`);
    return null;
  };

  const overlaps: VennOverlapModel[] = [];
  const seen = new Set<number>();
  let focused = false;
  for (const part of partsOf(props?.overlaps, "overlap", "VennOverlap", "Venn", problems)) {
    const label = clean(part.props.label) || part.id;
    const names = Array.isArray(part.props.of) ? part.props.of.map((v) => clean(v)) : [];
    const of: number[] = [];
    const missing: string[] = [];
    for (const name of names) {
      const at = sets.findIndex((s) => s.name.toLowerCase() === name.toLowerCase());
      if (at < 0) missing.push(name);
      else if (!of.includes(at)) of.push(at);
    }
    if (missing.length) {
      problems.push(
        `VennOverlap "${label}" names ${missing.map((m) => `"${m}"`).join(", ")}, which is not a set. Use the exact VennSet name.`,
      );
    }
    of.sort((a, b) => a - b);
    if (of.length < 2) {
      problems.push(`VennOverlap "${label}" must name two or three sets. It is not drawn.`);
      continue;
    }
    const mask = of.reduce((m, i) => m | (1 << i), 0);
    if (seen.has(mask)) {
      problems.push(`Two VennOverlaps name the same sets. "${label}" is not drawn.`);
      continue;
    }
    seen.add(mask);
    let focus = flag(part.props.focus);
    if (focus && focused) {
      problems.push(`More than one VennOverlap has focus. "${label}" is drawn without it.`);
      focus = false;
    }
    focused ||= focus;
    overlaps.push({
      id: part.id,
      named: part.named,
      label,
      of,
      focus,
      text: place(mask, `"${label}"`, [{ text: label, size: 13, cls: "overlap", max: 3 }]),
    });
  }
  const setLabels = sets.map((s, i) =>
    place(1 << i, `"${s.name}"`, [
      { text: s.name, size: 13, cls: "name", max: 2 },
      { text: s.detail, size: 11, cls: "detail", max: 2 },
    ]),
  );
  return { sets, setLabels, overlaps, w, h, problems };
}

// ── Pyramid ──

export const PYR = { w: 640, shape: 340, rowH: 66, gap: 4, top: 14, labelX: 388 } as const;

export interface PyrLayer {
  id: string;
  named: boolean;
  name: string;
  detail: string;
  /** The value as printed; "" when none. */
  value: string;
  focus: boolean;
  /** Corners, top left clockwise. */
  points: [number, number][];
  y: number;
  /** Funnel: the change from the layer above, "−38%". */
  drop: string;
}

export interface PyrModel {
  layers: PyrLayer[];
  funnel: boolean;
  /** Funnel without values for every layer: the widths are a taper, not data. */
  toScale: boolean;
  h: number;
  problems: string[];
}

const group = (n: number): string => {
  const [i, f] = String(Math.round(n * 100) / 100).split(".");
  return i.replace(/\B(?=(\d{3})+$)/g, ",") + (f ? `.${f}` : "");
};

/** Pyramid(layers, shape?): ranked layers, first at the top. A funnel draws each layer as wide as its value. */
export function buildPyramid(props: Record<string, unknown> | undefined): PyrModel {
  const problems: string[] = [];
  const shape = clean(props?.shape).toLowerCase();
  const funnel = shape === "funnel";
  if (shape && shape !== "funnel" && shape !== "pyramid") {
    problems.push(
      `Pyramid shape "${shape}" is not known. Use "pyramid" or "funnel". It is a pyramid.`,
    );
  }
  const parts = partsOf(props?.layers, "layer", "PyramidLayer", "Pyramid", problems);
  const nums = parts.map((p) => parseNumber(p.props.value));
  const toScale = funnel && parts.length > 0 && nums.every((v) => v !== null && v >= 0);
  if (funnel && parts.length && !toScale) {
    problems.push(
      "Funnel layers need a value each (a number, 0 or more) for honest widths. The widths are a taper, not to scale.",
    );
  }
  const n = parts.length;
  const { shape: SW, rowH, gap, top } = PYR;
  const cx = PYR.shape / 2 + 10;
  const half = (w: number) => w / 2;
  const maxV = toScale ? Math.max(...(nums as number[]), 1e-9) : 1;
  const totalH = n * rowH + (n - 1) * gap;
  let focused = false;
  const layers: PyrLayer[] = parts.map((p, i) => {
    const y = top + i * (rowH + gap);
    let wTop: number;
    let wBottom: number;
    if (funnel) {
      if (toScale) {
        wTop = (SW * (nums[i] as number)) / maxV;
        wBottom = i + 1 < n ? (SW * (nums[i + 1] as number)) / maxV : wTop;
      } else {
        wTop = SW * (1 - (0.7 * i) / n);
        wBottom = SW * (1 - (0.7 * (i + 1)) / n);
      }
    } else {
      // Width grows linearly from a point; each layer's edges are on the same two lines.
      wTop = (SW * (i * (rowH + gap))) / totalH;
      wBottom = (SW * (i * (rowH + gap) + rowH)) / totalH;
    }
    const name = clean(p.props.name) || p.id;
    let focus = flag(p.props.focus);
    if (focus && focused) {
      problems.push(`More than one PyramidLayer has focus. "${name}" is drawn without it.`);
      focus = false;
    }
    focused ||= focus;
    const raw = p.props.value;
    const value =
      nums[i] !== null && typeof raw !== "string" ? group(nums[i] as number) : clean(raw);
    const prev = i > 0 ? nums[i - 1] : null;
    const cur = nums[i];
    let drop = "";
    if (funnel && toScale && prev && cur !== null && prev > 0) {
      const pct = Math.round(((cur - prev) / prev) * 100);
      drop = pct === 0 ? "0%" : `${pct < 0 ? "−" : "+"}${Math.abs(pct)}%`;
    }
    return {
      id: p.id,
      named: p.named,
      name,
      detail: clean(p.props.detail),
      value,
      focus,
      points: [
        [cx - half(wTop), y],
        [cx + half(wTop), y],
        [cx + half(wBottom), y + rowH],
        [cx - half(wBottom), y + rowH],
      ],
      y,
      drop,
    };
  });
  return { layers, funnel, toScale, h: top + totalH + top, problems };
}

// ── Loop ──

export interface LoopStepModel {
  id: string;
  named: boolean;
  name: string;
  detail: string;
  writes: string;
  focus: boolean;
  x: number;
  y: number;
  lines: string[];
  detailLine: string;
}

export interface LoopLayout {
  steps: LoopStepModel[];
  hub: {
    id: string;
    named: boolean;
    name: string;
    detail: string;
    x: number;
    y: number;
    lines: string[];
    detailLine: string;
  } | null;
  arcs: { d: string; head: string }[];
  spokes: {
    d: string;
    head: string;
    label: string;
    lx: number;
    ly: number;
    anchor: "start" | "end";
    mask: Rect;
  }[];
  w: number;
  h: number;
  /** The ring and boxes, relative to the viewBox origin `x`, `y`. */
  x: number;
  y: number;
  problems: string[];
}

export const LOOP = { sw: 172, sh: 64, hw: 196, hh: 84 } as const;

/** Distance from a box's centre to its edge along the unit vector u. */
const boxDist = (ux: number, uy: number, a: number, b: number): number =>
  Math.min(
    Math.abs(ux) > 1e-9 ? a / Math.abs(ux) : Infinity,
    Math.abs(uy) > 1e-9 ? b / Math.abs(uy) : Infinity,
  );

/** LoopHub / LoopStep parsing and the ring geometry: stations at equal angles clockwise from the top, arcs of one circle. */
export function layoutLoop(props: Record<string, unknown> | undefined): LoopLayout {
  const problems: string[] = [];
  let parts = partsOf(props?.steps, "step", "LoopStep", "Loop", problems);
  if (parts.length > 8) {
    problems.push(
      `A Loop has 8 steps at most. ${parts.length - 8} are not drawn. Split it into an overview and detail loops.`,
    );
    parts = parts.slice(0, 8);
  }
  const hubPart = single(props?.hub, "hub", "LoopHub", "Loop", problems);
  const N = parts.length;
  const { sw, sh, hw, hh } = LOOP;
  const a = sw / 2;
  const b = sh / 2;
  let focused = false;
  const steps: LoopStepModel[] = parts.map((p) => {
    const name = clean(p.props.name) || p.id;
    let focus = flag(p.props.focus);
    if (focus && focused) {
      problems.push(`More than one LoopStep has focus. "${name}" is drawn without it.`);
      focus = false;
    }
    focused ||= focus;
    const detail = clean(p.props.detail);
    return {
      id: p.id,
      named: p.named,
      name,
      detail,
      writes: clean(p.props.writes),
      focus,
      x: 0,
      y: 0,
      lines: wrapText(name, sw - 24, 14.5, detail ? 2 : 3),
      detailLine: detail ? fit(detail, sw - 24, 12) : "",
    };
  });
  const empty: LoopLayout = {
    steps,
    hub: null,
    arcs: [],
    spokes: [],
    w: 0,
    h: 0,
    x: 0,
    y: 0,
    problems,
  };
  if (!N) return empty;
  if (N < 2) problems.push("A Loop needs at least 2 steps: the last feeds the first.");
  const theta = (k: number) => -Math.PI / 2 + (k * 2 * Math.PI) / N;
  const hasHub = !!hubPart;
  // Angle from station k, either way round the circle, at which the circle leaves its box.
  const leave = (R: number, k: number, dir: 1 | -1): number => {
    const t = theta(k);
    const inside = (ang: number) =>
      Math.abs(R * (Math.cos(t + dir * ang) - Math.cos(t))) <= a &&
      Math.abs(R * (Math.sin(t + dir * ang) - Math.sin(t))) <= b;
    let lo = 0;
    let hi = Math.PI;
    for (let i = 0; i < 40; i++) {
      const mid = (lo + hi) / 2;
      if (inside(mid)) lo = mid;
      else hi = mid;
    }
    return hi;
  };
  const stepAngle = (2 * Math.PI) / N;
  let R = 150;
  for (; R < 700; R += 6) {
    let ok = true;
    for (let k = 0; k < N && ok; k++) {
      const gapA = stepAngle - leave(R, k, 1) - leave(R, (k + 1) % N, -1);
      if (gapA * R < 34) ok = false;
      if (hasHub) {
        const ux = Math.cos(theta(k));
        const uy = Math.sin(theta(k));
        if (R - boxDist(ux, uy, a, b) - boxDist(ux, uy, hw / 2, hh / 2) - 6 < 30) ok = false;
      }
    }
    if (ok) break;
  }
  const arcs: LoopLayout["arcs"] = [];
  const pt = (R2: number, ang: number) => [R2 * Math.cos(ang), R2 * Math.sin(ang)] as const;
  steps.forEach((s, k) => {
    const [px, py] = pt(R, theta(k));
    s.x = px - a;
    s.y = py - b;
  });
  if (N > 1) {
    for (let k = 0; k < N; k++) {
      const j = (k + 1) % N;
      const from = theta(k) + leave(R, k, 1);
      // The last step feeds the first: its target angle is one turn on.
      const entry = theta(j) + (j === 0 ? 2 * Math.PI : 0) - leave(R, j, -1);
      const endPath = entry - 9 / R;
      const [sx, sy] = pt(R, from);
      const [ex, ey] = pt(R, endPath);
      const [tx, ty] = pt(R, entry);
      const tan = [-Math.sin(entry), Math.cos(entry)];
      const nor = [Math.cos(entry), Math.sin(entry)];
      const p = (u: number, v: number) =>
        `${r1(tx - tan[0] * u + nor[0] * v)},${r1(ty - tan[1] * u + nor[1] * v)}`;
      arcs.push({
        d: `M${r1(sx)} ${r1(sy)}A${R} ${R} 0 0 1 ${r1(ex)} ${r1(ey)}`,
        head: `${p(10, -4.5)} ${r1(tx)},${r1(ty)} ${p(10, 4.5)}`,
      });
    }
  }
  const spokes: LoopLayout["spokes"] = [];
  let hub: LoopLayout["hub"] = null;
  if (hubPart) {
    const hn = clean(hubPart.props.name) || hubPart.id;
    const hd = clean(hubPart.props.detail);
    hub = {
      id: hubPart.id,
      named: hubPart.named,
      name: hn,
      detail: hd,
      x: -hw / 2,
      y: -hh / 2,
      lines: wrapText(hn, hw - 28, 15.5, hd ? 2 : 3),
      detailLine: hd ? fit(hd, hw - 28, 12) : "",
    };
    steps.forEach((s, k) => {
      const ux = Math.cos(theta(k));
      const uy = Math.sin(theta(k));
      const ds = boxDist(ux, uy, a, b);
      const dh = boxDist(ux, uy, hw / 2, hh / 2);
      const [cxk, cyk] = pt(R, theta(k));
      const sx = cxk - ds * ux;
      const sy = cyk - ds * uy;
      const tipD = dh + 6;
      const tx = tipD * ux;
      const ty = tipD * uy;
      const ex = (tipD + 8) * ux;
      const ey = (tipD + 8) * uy;
      // Arrowhead at the hub end, pointing inward (-u).
      const hx = (u: number, v: number) =>
        `${r1(tx + ux * u - uy * v)},${r1(ty + uy * u + ux * v)}`;
      const label = fit(s.writes, 96, 10);
      const mx = (sx + ex) / 2;
      const my = (sy + ey) / 2;
      const nx = -uy;
      const ny = ux;
      const anchor: "start" | "end" = nx >= 0 ? "start" : "end";
      const lx = mx + nx * 9;
      const ly = my + ny * 9 + 3;
      const tw = textW(label.toUpperCase(), 10) * 1.12;
      const left = anchor === "start" ? lx : lx - tw;
      spokes.push({
        d: `M${r1(sx)} ${r1(sy)}L${r1(ex)} ${r1(ey)}`,
        head: `${hx(9, -4)} ${r1(tx)},${r1(ty)} ${hx(9, 4)}`,
        label,
        lx: r1(lx),
        ly: r1(ly),
        anchor,
        mask: { x0: left - 3, y0: ly - 10, x1: left + tw + 3, y1: ly + 4 },
      });
    });
  }
  const minX = Math.min(-R - a, hub ? hub.x : 0) - 24;
  const maxX = Math.max(R + a, hub ? -hub.x : 0) + 24;
  const minY = Math.min(-R - b, hub ? hub.y : 0) - 24;
  const maxY = Math.max(R + b, hub ? -hub.y : 0) + 24;
  return { steps, hub, arcs, spokes, w: maxX - minX, h: maxY - minY, x: minX, y: minY, problems };
}

// ── Fishbone ──

export interface FishCauseModel {
  id: string;
  named: boolean;
  text: string;
  root: boolean;
  lines: string[];
  /** Where the tick leaves the bone, and where its label ends. */
  bx: number;
  by: number;
  lx: number;
  ly: number;
  box: Rect;
}

export interface FishBoneModel {
  category: string;
  tag: string;
  above: boolean;
  root: boolean;
  /** Where the bone meets the spine, and its far end. */
  ax: number;
  fx: number;
  fy: number;
  tagBox: Rect;
  causes: FishCauseModel[];
}

export interface FishModel {
  effectLines: string[];
  effectBox: Rect;
  bones: FishBoneModel[];
  spineX0: number;
  cy: number;
  hasRoot: boolean;
  x: number;
  y: number;
  w: number;
  h: number;
  problems: string[];
}

export const FISH = { dx: 96, dy: 168, step: 170, effectW: 200, effectH: 96, tagH: 26 } as const;

/** Fishbone(effect, causes): 60° bones alternate above and below the spine, one for each category in order of first use. */
export function layoutFishbone(props: Record<string, unknown> | undefined): FishModel {
  const problems: string[] = [];
  const effect = clean(props?.effect);
  const cats = new Map<
    string,
    { name: string; causes: { part: Part; text: string; root: boolean }[] }
  >();
  let rootSeen = false;
  for (const part of partsOf(props?.causes, "cause", "FishCause", "Fishbone", problems)) {
    const text = clean(part.props.text) || part.id;
    let category = clean(part.props.category);
    if (!category) {
      problems.push(`FishCause "${text}" has no category. It is filed under "Other".`);
      category = "Other";
    }
    let root = flag(part.props.root);
    if (root && rootSeen) {
      problems.push(`More than one FishCause is the root cause. "${text}" is drawn without it.`);
      root = false;
    }
    rootSeen ||= root;
    const key = category.toLowerCase();
    let cat = cats.get(key);
    if (!cat) cats.set(key, (cat = { name: category, causes: [] }));
    cat.causes.push({ part, text, root });
  }
  const { dx, dy, step, effectW, effectH, tagH } = FISH;
  const effectLines = wrapText(effect || "Effect", effectW - 24, 14, 4);
  const list = [...cats.values()];
  const cy = dy + tagH + 32;
  const effectX = 0;
  const bones: FishBoneModel[] = [];
  let minX = -40;
  let minY = cy - effectH / 2;
  let maxY = cy + effectH / 2;
  list.forEach((cat, i) => {
    const above = i % 2 === 0;
    const side = above ? -1 : 1;
    const ax = effectX - 56 - i * step;
    const fx = ax - dx;
    const fy = cy + side * dy;
    const tag = fit(cat.name, 170, 12);
    const tw = textW(tag, 12) + 22;
    const tagBox: Rect = above
      ? { x0: fx - tw / 2, y0: fy - tagH, x1: fx + tw / 2, y1: fy }
      : { x0: fx - tw / 2, y0: fy, x1: fx + tw / 2, y1: fy + tagH };
    minX = Math.min(minX, tagBox.x0);
    minY = Math.min(minY, tagBox.y0);
    maxY = Math.max(maxY, tagBox.y1);
    const c = cat.causes.length;
    const many = c > 3;
    if (c > 3) {
      problems.push(
        `The "${cat.name}" bone has ${c} causes. 3 or fewer read well: split the category.`,
      );
    }
    const causes: FishCauseModel[] = cat.causes.map((cause, j) => {
      const t = (j + 1) / (c + 1);
      const bx = ax - dx * t;
      const by = cy + side * dy * t;
      const lines = wrapText(cause.text, 200, 12.5, many ? 1 : 2);
      const lw = Math.max(...lines.map((l) => textW(l, 12.5)));
      const lx = bx - 38;
      const height = lines.length * 14;
      const box: Rect = {
        x0: lx - lw - 4,
        y0: by - height / 2 - 2,
        x1: bx + 2,
        y1: by + height / 2 + 2,
      };
      minX = Math.min(minX, box.x0);
      return {
        id: cause.part.id,
        named: cause.part.named,
        text: cause.text,
        root: cause.root,
        lines,
        bx,
        by,
        lx,
        ly: by - ((lines.length - 1) * 14) / 2 + 4,
        box,
      };
    });
    bones.push({
      category: cat.name,
      tag,
      above,
      root: causes.some((x) => x.root),
      ax,
      fx,
      fy,
      tagBox,
      causes,
    });
  });
  if (list.length > 6) {
    problems.push(
      `The Fishbone has ${list.length} categories. 6 or fewer keep it readable: group them.`,
    );
  }
  const x = minX - 20;
  const effectBox: Rect = {
    x0: effectX,
    y0: cy - effectH / 2,
    x1: effectX + effectW,
    y1: cy + effectH / 2,
  };
  return {
    effectLines,
    effectBox,
    bones,
    spineX0: Math.min(minX + 20, effectX - 120),
    cy,
    hasRoot: bones.some((b) => b.root),
    x,
    y: minY - 20,
    w: effectX + effectW + 20 - x,
    h: maxY - minY + 40,
    problems,
  };
}

// ── Wardley map ──

export const STAGES = ["Genesis", "Custom-built", "Product", "Commodity"] as const;
export const WARD = { w: 760, h: 520, x0: 100, x1: 740, y0: 44, y1: 440 } as const;

export interface WardPartModel {
  id: string;
  named: boolean;
  name: string;
  shown: string;
  stage: number;
  visibility: number;
  px: number;
  py: number;
  evolving: boolean;
  /** Arrow end x when the part is evolving and the arrow is drawn. */
  arrowTo: number | null;
  lbox: Rect;
}

export interface WardModel {
  parts: WardPartModel[];
  links: { from: number; to: number }[];
  problems: string[];
}

const stageOf = (v: unknown): number => {
  const k = clean(v)
    .toLowerCase()
    .replace(/[^a-z]/g, "");
  if (k.startsWith("gen")) return 0;
  if (k.startsWith("cus")) return 1;
  if (k.startsWith("pro")) return 2;
  if (k.startsWith("com")) return 3;
  return -1;
};

/** WardleyMap(parts): each part in one of four evolution bands, at a visibility from 0 (invisible) to 100; links by name. */
export function buildWardley(props: Record<string, unknown> | undefined): WardModel {
  const problems: string[] = [];
  const { x0, x1, y0, y1 } = WARD;
  const bandW = (x1 - x0) / 4;
  const parts: WardPartModel[] = [];
  const needs: unknown[][] = [];
  for (const p of partsOf(props?.parts, "part", "WardleyPart", "WardleyMap", problems)) {
    const name = clean(p.props.name) || p.id;
    const stage = stageOf(p.props.stage);
    const vis = parseNumber(p.props.visibility);
    if (stage < 0 || vis === null) {
      problems.push(
        `WardleyPart "${name}" needs a stage (genesis, custom, product or commodity) and a visibility from 0 to 100. It is not drawn.`,
      );
      continue;
    }
    let visibility = vis;
    if (vis < 0 || vis > 100) {
      problems.push(
        `WardleyPart "${name}" has visibility ${vis}. Use 0 (invisible) to 100 (visible).`,
      );
      visibility = Math.min(100, Math.max(0, vis));
    }
    const shown = fit(name, bandW - 16, 12);
    parts.push({
      id: p.id,
      named: p.named,
      name,
      shown,
      stage,
      visibility,
      px: x0 + bandW * (stage + 0.5),
      py: y1 - 22 - (visibility / 100) * (y1 - y0 - 44),
      evolving: flag(p.props.evolving),
      arrowTo: null,
      lbox: { x0: 0, y0: 0, x1: 0, y1: 0 },
    });
    needs.push(Array.isArray(p.props.needs) ? p.props.needs : []);
  }
  // Labels sit above their dot; a part is nudged sideways inside its band when it would touch another.
  const placed: Rect[] = [];
  const order = parts.map((_, i) => i).sort((a, b) => parts[b].visibility - parts[a].visibility);
  for (const i of order) {
    const p = parts[i];
    const w = textW(p.shown, 12);
    const bandLo = x0 + bandW * p.stage;
    const bandHi = bandLo + bandW;
    const span = Math.max(0, bandW / 2 - w / 2 - 6);
    let best: { cost: number; dx: number; box: Rect } | null = null;
    for (const f of [0, 0.5, -0.5, 1, -1]) {
      const dx = f * span;
      const cxl = p.px + dx;
      const box: Rect = { x0: cxl - w / 2, y0: p.py - 28, x1: cxl + w / 2, y1: p.py - 11 };
      const dot: Rect = { x0: cxl - 9, y0: p.py - 9, x1: cxl + 9, y1: p.py + 9 };
      let cost = Math.abs(f);
      for (const t of placed) if (hit(box, t) || hit(dot, t)) cost += 1000;
      if (!best || cost < best.cost) best = { cost, dx, box };
    }
    if (best) {
      p.px += best.dx;
      p.lbox = best.box;
      placed.push(best.box, { x0: p.px - 9, y0: p.py - 9, x1: p.px + 9, y1: p.py + 9 });
      if (best.cost >= 1000)
        problems.push(
          `The label of "${p.name}" overlaps another. Change a visibility so they are apart.`,
        );
    }
  }
  const index = new Map(parts.map((p, i) => [p.name.toLowerCase(), i]));
  const links: WardModel["links"] = [];
  const seen = new Set<string>();
  parts.forEach((p, i) => {
    for (const raw of needs[i]) {
      const to = index.get(clean(raw).toLowerCase());
      if (to === undefined) {
        problems.push(
          `WardleyPart "${p.name}" needs "${clean(raw)}", which is not a part. The link is dropped.`,
        );
      } else if (to === i) {
        problems.push(`WardleyPart "${p.name}" needs itself. The link is dropped.`);
      } else if (!seen.has(`${i}>${to}`)) {
        seen.add(`${i}>${to}`);
        links.push({ from: i, to });
      }
    }
  });
  if (links.length > 12)
    problems.push(`The map has ${links.length} links. 12 or fewer keep it readable.`);
  let arrows = 0;
  for (const p of parts) {
    if (!p.evolving) continue;
    if (p.stage === 3) {
      problems.push(`"${p.name}" is already a commodity. It cannot move on, so no arrow is drawn.`);
    } else if (arrows >= 2) {
      problems.push(`"${p.name}": 2 movement arrows at most. This one is not drawn.`);
    } else {
      arrows++;
      p.arrowTo = Math.min(x1 - 6, p.px + Math.min(bandW * 0.62, 90));
    }
  }
  return { parts, links, problems };
}
