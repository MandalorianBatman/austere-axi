// PolarChart, Waterfall, Treemap and Sankey: parsed props → geometry.
// Pure TypeScript (no JSX), so Node tests can import it. Never throws: a figure that is
// wrong still draws what it can, and says what it dropped or could not reconcile in `problems`.
import { clean, parseNumber, partsOf } from "./_matrix-model.ts";
import { fit, textW, wrapWords } from "./_shape-model.ts";

// ── numbers ──

/** 1234.5 → "1,234.5"; at most 2 decimals. */
export function fmtNum(n: number): string {
  const r = Math.round(n * 100) / 100;
  const [int, dec] = String(Math.abs(r)).split(".");
  const grouped = int.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${r < 0 ? "−" : ""}${grouped}${dec ? `.${dec}` : ""}`;
}

/** A value with its unit: "12 min", "40%". A one-character symbol sticks to the number. */
export function withUnit(n: number, unit: string): string {
  const num = fmtNum(n);
  if (!unit) return num;
  return /^[^\p{L}\p{N}\s]$/u.test(unit) ? `${num}${unit}` : `${num} ${unit}`;
}

const signed = (n: number, unit: string): string => `${n > 0 ? "+" : ""}${withUnit(n, unit)}`;

/** The smallest of 1, 2, 2.5, 5 and 10 times a power of ten that is at least `n`. */
export function niceMax(n: number): number {
  if (!(n > 0) || !Number.isFinite(n)) return 1;
  const p = 10 ** Math.floor(Math.log10(n));
  for (const m of [1, 2, 2.5, 5, 10]) if (m * p >= n * (1 - 1e-12)) return m * p;
  return 10 * p;
}

const same = (a: number, b: number): boolean =>
  Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a), Math.abs(b));

/** Names and numbers that line up by position; an entry with no usable number is dropped and reported. */
function pairs(
  labelsIn: unknown,
  valuesIn: unknown,
  what: string,
  problems: string[],
): { label: string; value: number | null }[] {
  const names = Array.isArray(labelsIn) ? labelsIn : [];
  const nums = Array.isArray(valuesIn) ? valuesIn : [];
  if (names.length !== nums.length) {
    problems.push(
      `${what}: ${names.length} labels but ${nums.length} values. They are paired by position; the extra are dropped.`,
    );
  }
  const out: { label: string; value: number | null }[] = [];
  for (let i = 0; i < Math.min(names.length, nums.length); i++) {
    out.push({ label: clean(names[i]) || `#${i + 1}`, value: parseNumber(nums[i]) });
  }
  return out;
}

const focusKey = (v: unknown): string => clean(v).toLowerCase();

// ── Radar ──

export const RADAR = { w: 640, h: 500, cx: 320, cy: 244, R: 160 } as const;

export interface RadarSeriesModel {
  id: string;
  named: boolean;
  name: string;
  /** Values as drawn: 0 to max. */
  values: number[];
  points: [number, number][];
  focus: boolean;
  index: number;
  /** What the reviewer hears: "MinIO: Latency 9, Cost 8". */
  part: string;
}

export interface RadarAxis {
  label: string;
  name: string;
  sx: number;
  sy: number;
  lx: number;
  ly: number;
  anchor: "start" | "middle" | "end";
}

export interface RadarModel {
  axes: RadarAxis[];
  series: RadarSeriesModel[];
  max: number;
  unit: string;
  rings: { points: [number, number][]; text: string }[];
  problems: string[];
}

/** Radar(labels, series, max?, unit?): several entities scored on the same criteria; each RadarSeries is one polygon. */
export function buildRadar(props: Record<string, unknown> | undefined): RadarModel {
  const problems: string[] = [];
  const unit = clean(props?.unit);
  let names = (Array.isArray(props?.labels) ? props.labels : []).map(
    (l, i) => clean(l) || `#${i + 1}`,
  );
  if (names.length > 8) {
    problems.push(`Radar draws 8 criteria at most. ${names.length - 8} are not drawn.`);
    names = names.slice(0, 8);
  }
  const n = names.length;
  const parts = partsOf(props?.series, "series", "RadarSeries", "Radar", problems);
  const raw = parts.map((p) => {
    const name = clean(p.props.name) || p.id;
    const given = Array.isArray(p.props.values) ? p.props.values : [];
    if (given.length !== n) {
      problems.push(
        `RadarSeries "${name}" has ${given.length} values for ${n} labels. Missing values are drawn as 0; the extra are dropped.`,
      );
    }
    const values = names.map((label, i) => {
      const v = parseNumber(given[i]);
      if (v === null && i < given.length)
        problems.push(`"${name}" has no number for ${label}. It is drawn as 0.`);
      if (v !== null && v < 0)
        problems.push(
          `"${name}" has ${fmtNum(v)} for ${label}. A radar starts at 0; it is drawn as 0.`,
        );
      return v !== null && v > 0 ? v : 0;
    });
    return { p, name, values, focus: p.props.focus === true || p.props.focus === "true" };
  });
  const dataMax = Math.max(0, ...raw.flatMap((r) => r.values));
  let max = parseNumber(props?.max) ?? 0;
  if (props?.max != null && !(max > 0)) {
    problems.push("Radar max must be a number above 0. It is set from the data.");
    max = 0;
  }
  if (max > 0 && max < dataMax) {
    problems.push(
      `The largest score is ${fmtNum(dataMax)}, above max ${fmtNum(max)}. max is raised.`,
    );
    max = 0;
  }
  if (!(max > 0)) max = niceMax(dataMax);
  const { cx, cy, R } = RADAR;
  const at = (i: number, r: number): [number, number] => {
    const a = -Math.PI / 2 + (2 * Math.PI * i) / Math.max(n, 1);
    return [cx + r * Math.cos(a), cy + r * Math.sin(a)];
  };
  const axes = names.map((label, i): RadarAxis => {
    const a = -Math.PI / 2 + (2 * Math.PI * i) / Math.max(n, 1);
    const cos = Math.cos(a);
    const sin = Math.sin(a);
    const anchor = Math.abs(cos) < 0.26 ? "middle" : cos > 0 ? "start" : "end";
    const [sx, sy] = at(i, R);
    return {
      label,
      name: fit(label, anchor === "middle" ? 200 : 130, 12),
      sx,
      sy,
      lx: cx + (R + 14) * cos,
      ly: cy + (R + 14) * sin + (sin > 0.5 ? 12 : sin < -0.5 ? -4 : 4),
      anchor,
    };
  });
  const seen = new Set<string>();
  let focused = false;
  const series = raw.map((r, index): RadarSeriesModel => {
    if (seen.has(r.name.toLowerCase()))
      problems.push(`Two RadarSeries are named "${r.name}". Name each one apart.`);
    seen.add(r.name.toLowerCase());
    let focus = r.focus;
    if (focus && focused) {
      problems.push(`More than one RadarSeries has focus. "${r.name}" is drawn without it.`);
      focus = false;
    }
    focused ||= focus;
    return {
      id: r.p.id,
      named: r.p.named,
      name: r.name,
      values: r.values,
      points: r.values.map((v, i) => at(i, (R * Math.min(v, max)) / max)),
      focus,
      index,
      part: fit(
        `${r.name}: ${names.map((l, i) => `${l} ${fmtNum(r.values[i])}`).join(", ")}`,
        600,
        12,
      ),
    };
  });
  if (series.length > 5) {
    problems.push(
      `Radar has ${series.length} series; 5 read best. Split into two charts, or use a Table.`,
    );
  }
  return {
    axes,
    series,
    max,
    unit,
    rings: RINGS.map((f) => ({ points: names.map((_, i) => at(i, R * f)), text: fmtNum(max * f) })),
    problems,
  };
}

// ── PolarChart ──

export const POLAR = { w: 640, h: 540, cx: 320, cy: 270, R: 170 } as const;
const RINGS = [0.2, 0.4, 0.6, 0.8, 1];

export interface PolarCategory {
  label: string;
  value: number | null;
  /** What the reviewer hears: "12–15: 100 %". */
  part: string;
  focus: boolean;
  angle: number;
  /** The end of the value ray; the centre when the value is 0 or missing. */
  x: number;
  y: number;
  /** The outer end of the spoke. */
  sx: number;
  sy: number;
  lx: number;
  ly: number;
  anchor: "start" | "middle" | "end";
  name: string;
  valueText: string;
}

export interface PolarModel {
  categories: PolarCategory[];
  max: number;
  unit: string;
  rings: { r: number; text: string }[];
  problems: string[];
}

/** PolarChart(labels, values, unit?, focus?, max?): one value for each category, as the length of a ray from the centre. */
export function buildPolar(props: Record<string, unknown> | undefined): PolarModel {
  const problems: string[] = [];
  const unit = clean(props?.unit);
  let list = pairs(props?.labels, props?.values, "PolarChart", problems);
  if (list.length > 16) {
    problems.push(`PolarChart draws 16 categories at most. ${list.length - 16} are not drawn.`);
    list = list.slice(0, 16);
  }
  const seen = new Set<string>();
  for (const e of list) {
    const k = e.label.toLowerCase();
    if (seen.has(k)) problems.push(`Two categories are named "${e.label}". Name each one apart.`);
    seen.add(k);
  }
  for (const e of list) {
    if (e.value === null) {
      problems.push(`"${e.label}" has no number. It is shown as –, not as 0.`);
    } else if (e.value < 0) {
      problems.push(`"${e.label}" is below 0. A polar chart starts at 0, so it is not drawn.`);
      e.value = null;
    }
  }
  const dataMax = Math.max(0, ...list.map((e) => e.value ?? 0));
  let max = parseNumber(props?.max) ?? 0;
  if (props?.max != null && !(max > 0)) {
    problems.push("PolarChart max must be a number above 0. It is set from the data.");
    max = 0;
  }
  if (max > 0 && max < dataMax) {
    problems.push(
      `The largest value is ${fmtNum(dataMax)}, above max ${fmtNum(max)}. max is raised.`,
    );
    max = 0;
  }
  if (!(max > 0)) max = niceMax(dataMax);
  const n = list.length;
  const { cx, cy, R } = POLAR;
  const focusAt =
    props?.focus == null ? -1 : list.findIndex((e) => focusKey(e.label) === focusKey(props.focus));
  if (props?.focus != null && clean(props.focus) && focusAt < 0) {
    problems.push(`focus "${clean(props.focus)}" is not a category label. No category is marked.`);
  }
  const categories = list.map((e, i): PolarCategory => {
    const angle = -Math.PI / 2 + (2 * Math.PI * i) / Math.max(n, 1);
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    const r = e.value === null ? 0 : (R * e.value) / max;
    const anchor = Math.abs(cos) < 0.26 ? "middle" : cos > 0 ? "start" : "end";
    const edge = R + 18;
    return {
      label: e.label,
      value: e.value,
      part: `${e.label}: ${e.value === null ? "no value" : withUnit(e.value, unit)}`,
      focus: i === focusAt,
      angle,
      x: cx + r * cos,
      y: cy + r * sin,
      sx: cx + R * cos,
      sy: cy + R * sin,
      lx: cx + edge * cos,
      ly: cy + edge * sin + (sin > 0.5 ? 10 : sin < -0.5 ? -14 : -3),
      anchor,
      name: fit(e.label, anchor === "middle" ? 190 : 118, 12),
      valueText: e.value === null ? "–" : withUnit(e.value, unit),
    };
  });
  return {
    categories,
    max,
    unit,
    rings: RINGS.map((f) => ({ r: R * f, text: fmtNum(max * f) })),
    problems,
  };
}

// ── Waterfall ──

export const WF = {
  pitch: 100,
  bar: 64,
  left: 64,
  right: 24,
  top: 28,
  plot: 260,
  foot: 70,
} as const;

export interface WfBar {
  label: string;
  kind: "total" | "up" | "down";
  /** The number as given. */
  value: number;
  /** The level the bar starts from, and ends at. A total starts at 0. */
  from: number;
  to: number;
  x: number;
  y: number;
  h: number;
  cx: number;
  focus: boolean;
  part: string;
  valueText: string;
  /** Where the value is printed: above or below the bar. */
  valueY: number;
  lines: string[];
}

export interface WfModel {
  bars: WfBar[];
  /** The running total carried across each gap, at its own level. */
  carries: { x1: number; x2: number; y: number }[];
  ticks: { y: number; text: string }[];
  zeroY: number;
  w: number;
  h: number;
  problems: string[];
}

/** Waterfall(labels, values, unit?, focus?, subtotal?): first value starts, last ends, the rest are signed steps. */
export function buildWaterfall(props: Record<string, unknown> | undefined): WfModel {
  const problems: string[] = [];
  const unit = clean(props?.unit);
  const all = pairs(props?.labels, props?.values, "Waterfall", problems);
  const list: { label: string; value: number }[] = [];
  all.forEach((e, i) => {
    if (e.value === null) {
      problems.push(`"${e.label}" has no number. It is not drawn, and the walk may not add up.`);
    } else if (e.value === 0 && i > 0 && i < all.length - 1) {
      problems.push(`"${e.label}" is 0. A zero step is not drawn; say it in the text.`);
    } else list.push({ label: e.label, value: e.value });
  });
  const empty: WfModel = { bars: [], carries: [], ticks: [], zeroY: 0, w: 0, h: 0, problems };
  if (list.length < 2) return empty;
  if (list.length > 8) {
    problems.push(
      `Waterfall has ${list.length} bars; 8 read best. Merge the small steps into one "Other" step.`,
    );
  }
  const subKey = props?.subtotal == null ? "" : focusKey(props.subtotal);
  const subAt = subKey
    ? list.findIndex((e, i) => i > 0 && i < list.length - 1 && focusKey(e.label) === subKey)
    : -1;
  if (subKey && subAt < 0) {
    problems.push(
      `subtotal "${clean(props?.subtotal)}" is not a label between the first and the last. No subtotal is drawn.`,
    );
  }
  const focusAt =
    props?.focus == null || !clean(props.focus)
      ? -1
      : list.findIndex(
          (e, i) =>
            i > 0 &&
            i < list.length - 1 &&
            i !== subAt &&
            focusKey(e.label) === focusKey(props.focus),
        );
  if (props?.focus != null && clean(props.focus) && focusAt < 0) {
    problems.push(`focus "${clean(props.focus)}" is not a step label. No step is marked.`);
  }
  const last = list.length - 1;
  const spec = list.map((e, i) => {
    const kind0: "total" | "delta" = i === 0 || i === last || i === subAt ? "total" : "delta";
    return { ...e, kind0 };
  });
  if (spec[0].value <= 0) {
    problems.push(
      `The start total is ${fmtNum(spec[0].value)}. A waterfall starts from a total above 0.`,
    );
  }
  // Levels: a total sets the level to its own value; a step moves it.
  let level = 0;
  const raw = spec.map((e, i) => {
    const before = level;
    let from = 0;
    let to = e.value;
    if (e.kind0 === "total") {
      if (i > 0 && !same(before, e.value)) {
        problems.push(
          `${i === last ? "The end total" : `The subtotal "${e.label}"`} is ${fmtNum(e.value)}, but the start and the steps before it make ${fmtNum(before)}. The figure does not add up.`,
        );
      }
      level = e.value;
    } else {
      from = before;
      to = before + e.value;
      level = to;
    }
    return { ...e, from, to };
  });
  const lo = Math.min(0, ...raw.flatMap((b) => [b.from, b.to]));
  const hi = Math.max(1e-9, ...raw.flatMap((b) => [b.from, b.to]));
  const step = niceMax((hi - lo) / 4);
  const top = Math.ceil(hi / step) * step;
  const bottom = lo < 0 ? Math.floor(lo / step) * step : 0;
  const span = top - bottom || 1;
  const yOf = (v: number) => WF.top + ((top - v) / span) * WF.plot;
  const n = raw.length;
  const bars = raw.map((b, i): WfBar => {
    const yTop = yOf(Math.max(b.from, b.to));
    const yBottom = yOf(Math.min(b.from, b.to));
    const h = Math.max(2, yBottom - yTop);
    const kind = b.kind0 === "total" ? "total" : b.value >= 0 ? "up" : "down";
    const x = WF.left + i * WF.pitch + (WF.pitch - WF.bar) / 2;
    const valueText = kind === "total" ? withUnit(b.value, unit) : signed(b.value, unit);
    return {
      label: b.label,
      kind,
      value: b.value,
      from: b.from,
      to: b.to,
      x,
      y: yTop,
      h,
      cx: x + WF.bar / 2,
      focus: i === focusAt,
      part: `${b.label}: ${valueText}`,
      valueText,
      valueY: kind === "down" && yTop + h + 14 < WF.top + WF.plot ? yTop + h + 14 : yTop - 7,
      lines: wrapWords(b.label, WF.pitch - 8, 12, 3, false) ?? [b.label],
    };
  });
  const carries = bars.slice(0, -1).map((b, i) => ({
    x1: b.x + WF.bar,
    x2: bars[i + 1].x,
    y: yOf(raw[i].kind0 === "total" ? raw[i].value : raw[i].to),
  }));
  const ticks: { y: number; text: string }[] = [];
  for (let v = bottom; v <= top + step * 1e-9; v += step)
    ticks.push({ y: yOf(v), text: fmtNum(v) });
  const maxLines = Math.max(...bars.map((b) => b.lines.length));
  return {
    bars,
    carries,
    ticks,
    zeroY: yOf(0),
    w: WF.left + n * WF.pitch + WF.right,
    h: WF.top + WF.plot + 22 + maxLines * 15 + 10,
    problems,
  };
}

// ── Treemap ──

export const TM = { w: 640, h: 400, gap: 3, head: 18 } as const;

export interface TmRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface TmCell extends TmRect {
  label: string;
  value: number;
  share: number;
  group: string;
  rank: number;
  focus: boolean;
  part: string;
  /** Text lines that fit in the cell, by size: [] for a sliver. */
  lines: { text: string; cls: "name" | "value" }[];
}

export interface TmGroup extends TmRect {
  name: string;
  value: number;
  share: number;
  /** False when the box is too small to carry its name. */
  titled: boolean;
  part: string;
}

export interface TmModel {
  cells: TmCell[];
  groups: TmGroup[];
  total: number;
  unit: string;
  /** Cells too small to carry text, for the legend under the figure. */
  unlabeled: TmCell[];
  w: number;
  h: number;
  problems: string[];
}

/** Squarified layout (Bruls et al.): items in descending order, laid in rows along the shorter side. */
export function squarify(values: number[], box: TmRect): TmRect[] {
  const total = values.reduce((a, b) => a + b, 0);
  const out: TmRect[] = new Array(values.length);
  if (!(total > 0) || box.w <= 0 || box.h <= 0) return values.map(() => ({ ...box, w: 0, h: 0 }));
  const scale = (box.w * box.h) / total;
  let { x, y, w, h } = box;
  let i = 0;
  const worst = (row: number[], side: number): number => {
    const s = row.reduce((a, b) => a + b, 0);
    const mx = Math.max(...row);
    const mn = Math.min(...row);
    return Math.max((side * side * mx) / (s * s), (s * s) / (side * side * mn));
  };
  while (i < values.length) {
    const side = Math.min(w, h);
    const row: number[] = [values[i] * scale];
    let j = i + 1;
    while (j < values.length && worst([...row, values[j] * scale], side) <= worst(row, side)) {
      row.push(values[j] * scale);
      j++;
    }
    const sum = row.reduce((a, b) => a + b, 0);
    const thick = sum / side;
    let pos = 0;
    for (let k = 0; k < row.length; k++) {
      const len = row[k] / thick;
      out[i + k] =
        w >= h ? { x, y: y + pos, w: thick, h: len } : { x: x + pos, y, w: len, h: thick };
      pos += len;
    }
    if (w >= h) {
      x += thick;
      w -= thick;
    } else {
      y += thick;
      h -= thick;
    }
    i = j;
  }
  return out;
}

const inset = (r: TmRect, d: number): TmRect => ({
  x: r.x + d,
  y: r.y + d,
  w: Math.max(0, r.w - 2 * d),
  h: Math.max(0, r.h - 2 * d),
});

/** Treemap(labels, values, unit?, focus?, groups?): area is the value. groups names the parent of each label for a second level. */
export function buildTreemap(props: Record<string, unknown> | undefined): TmModel {
  const problems: string[] = [];
  const unit = clean(props?.unit);
  const all = pairs(props?.labels, props?.values, "Treemap", problems);
  const groupNames = Array.isArray(props?.groups) ? props.groups.map((g) => clean(g)) : [];
  if (groupNames.length && groupNames.length !== all.length) {
    problems.push(
      `Treemap: ${all.length} labels but ${groupNames.length} groups. A label with no group goes in "Other".`,
    );
  }
  const items: { label: string; value: number; group: string; index: number }[] = [];
  all.forEach((e, i) => {
    if (e.value === null || !(e.value > 0)) {
      problems.push(
        `"${e.label}" is ${e.value === null ? "not a number" : fmtNum(e.value)}. A cell needs a value above 0; it is not drawn. Merge small parts into "Other".`,
      );
    } else
      items.push({
        label: e.label,
        value: e.value,
        group: groupNames.length ? groupNames[i] || "Other" : "",
        index: i,
      });
  });
  const empty: TmModel = {
    cells: [],
    groups: [],
    total: 0,
    unit,
    unlabeled: [],
    w: TM.w,
    h: TM.h,
    problems,
  };
  if (!items.length) return empty;
  if (items.length > 8) {
    problems.push(
      `Treemap has ${items.length} cells; 8 read best, and the small ones lose their labels. Merge the tail into one "Other" cell and say what it holds.`,
    );
  }
  const total = items.reduce((a, b) => a + b.value, 0);
  const focusAt =
    props?.focus == null || !clean(props.focus)
      ? -1
      : items.findIndex((e) => focusKey(e.label) === focusKey(props.focus));
  if (props?.focus != null && clean(props.focus) && focusAt < 0) {
    problems.push(`focus "${clean(props.focus)}" is not a label. No cell is marked.`);
  }
  const rankOf = new Map(
    [...items].sort((a, b) => b.value - a.value).map((e, r) => [e.index, r] as [number, number]),
  );
  const cells: TmCell[] = [];
  const groups: TmGroup[] = [];
  const whole: TmRect = { x: 0, y: 0, w: TM.w, h: TM.h };
  const makeCell = (e: (typeof items)[number], r: TmRect): TmCell => {
    const box = inset(r, TM.gap / 2);
    const share = e.value / total;
    const pct = `${share >= 0.1 ? Math.round(share * 100) : Math.round(share * 1000) / 10}%`;
    const valueText = withUnit(e.value, unit);
    const lines: TmCell["lines"] = [];
    const room = box.w - 16;
    if (box.w >= 110 && box.h >= 56) {
      for (const t of wrapWords(e.label, room, 14, box.h >= 86 ? 2 : 1, false) ?? [])
        lines.push({ text: t, cls: "name" });
      const both = `${valueText} · ${pct}`;
      lines.push({ text: fit(textW(both, 12) <= room ? both : valueText, room, 12), cls: "value" });
    } else if (box.w >= 70 && box.h >= 40) {
      lines.push(
        { text: fit(e.label, room, 13), cls: "name" },
        { text: fit(valueText, room, 12), cls: "value" },
      );
    } else if (box.w >= 40 && box.h >= 22) {
      lines.push({ text: fit(e.label, box.w - 10, 12), cls: "name" });
    }
    return {
      ...box,
      label: e.label,
      value: e.value,
      share,
      group: e.group,
      rank: rankOf.get(e.index) ?? 0,
      focus: e.index === items[focusAt]?.index && focusAt >= 0,
      part: `${e.label}: ${valueText} (${pct})`,
      lines,
    };
  };
  const twoLevels = items.some((e) => e.group);
  if (!twoLevels) {
    const sorted = [...items].sort((a, b) => b.value - a.value);
    const rects = squarify(
      sorted.map((e) => e.value),
      whole,
    );
    sorted.forEach((e, i) => cells.push(makeCell(e, rects[i])));
  } else {
    const byGroup = new Map<string, typeof items>();
    for (const e of items) byGroup.set(e.group, [...(byGroup.get(e.group) ?? []), e]);
    const order = [...byGroup.entries()]
      .map(([name, list]) => ({
        name,
        list: list.sort((a, b) => b.value - a.value),
        value: list.reduce((a, b) => a + b.value, 0),
      }))
      .sort((a, b) => b.value - a.value);
    const rects = squarify(
      order.map((g) => g.value),
      whole,
    );
    order.forEach((g, gi) => {
      const box = inset(rects[gi], TM.gap / 2);
      const titled = box.w >= 70 && box.h >= 56;
      const valueText = withUnit(g.value, unit);
      const pct = `${Math.round((g.value / total) * 100)}%`;
      groups.push({
        ...box,
        name: g.name,
        value: g.value,
        share: g.value / total,
        titled,
        part: `${g.name}: ${valueText} (${pct})`,
      });
      const body = inset(
        {
          x: box.x,
          y: box.y + (titled ? TM.head : 0),
          w: box.w,
          h: box.h - (titled ? TM.head : 0),
        },
        TM.gap,
      );
      const inner = squarify(
        g.list.map((e) => e.value),
        body,
      );
      g.list.forEach((e, i) =>
        cells.push(
          makeCell(e, {
            x: inner[i].x - TM.gap / 2,
            y: inner[i].y - TM.gap / 2,
            w: inner[i].w + TM.gap,
            h: inner[i].h + TM.gap,
          }),
        ),
      );
    });
  }
  return {
    cells,
    groups,
    total,
    unit,
    unlabeled: cells.filter((c) => !c.lines.length),
    w: TM.w,
    h: TM.h,
    problems,
  };
}

// ── Sankey ──

export const SK = {
  w: 760,
  h: 380,
  left: 150,
  right: 150,
  top: 16,
  bottom: 16,
  bar: 12,
  gap: 22,
} as const;

export interface SkNode {
  id: number;
  name: string;
  layer: number;
  value: number;
  x: number;
  y: number;
  h: number;
  focus: boolean;
  part: string;
  side: "left" | "right" | "inside";
  lines: { text: string; cls: "name" | "value" }[];
}

export interface SkFlow {
  from: number;
  to: number;
  value: number;
  /** Ribbon path, closed. */
  d: string;
  focus: boolean;
  part: string;
}

export interface SkModel {
  nodes: SkNode[];
  flows: SkFlow[];
  layers: number;
  unit: string;
  w: number;
  h: number;
  problems: string[];
}

/** Sankey(sources, targets, values, unit?, focus?): one flow for each position; node height and band width share one scale. */
export function buildSankey(props: Record<string, unknown> | undefined): SkModel {
  const problems: string[] = [];
  const unit = clean(props?.unit);
  const empty: SkModel = { nodes: [], flows: [], layers: 0, unit, w: SK.w, h: SK.h, problems };
  const src = Array.isArray(props?.sources) ? props.sources : [];
  const dst = Array.isArray(props?.targets) ? props.targets : [];
  const val = Array.isArray(props?.values) ? props.values : [];
  if (src.length !== dst.length || src.length !== val.length) {
    problems.push(
      `Sankey: ${src.length} sources, ${dst.length} targets and ${val.length} values. A flow needs all three; the extra are dropped.`,
    );
  }
  const names: string[] = [];
  const idOf = (raw: unknown): number => {
    const name = clean(raw);
    const at = names.findIndex((n) => n.toLowerCase() === name.toLowerCase());
    if (at >= 0) return at;
    names.push(name);
    return names.length - 1;
  };
  const edges: { from: number; to: number; value: number }[] = [];
  for (let i = 0; i < Math.min(src.length, dst.length, val.length); i++) {
    const a = clean(src[i]);
    const b = clean(dst[i]);
    const v = parseNumber(val[i]);
    if (!a || !b) {
      problems.push(`Flow ${i + 1} has no ${a ? "target" : "source"}. It is not drawn.`);
      continue;
    }
    if (v === null || !(v > 0)) {
      problems.push(
        `The flow ${a} → ${b} is ${v === null ? "not a number" : fmtNum(v)}. A band needs a value above 0; it is not drawn.`,
      );
      continue;
    }
    if (a.toLowerCase() === b.toLowerCase()) {
      problems.push(`The flow ${a} → ${b} returns to its own node. It is not drawn.`);
      continue;
    }
    const from = idOf(a);
    const to = idOf(b);
    const dup = edges.find((e) => e.from === from && e.to === to);
    if (dup) {
      problems.push(`${a} → ${b} is listed twice. The values are added.`);
      dup.value += v;
    } else edges.push({ from, to, value: v });
  }
  if (!edges.length) return empty;
  const n = names.length;
  // A flow back to a node on the way to it (a retry) is dropped; the rest stay.
  const alive = edges.slice();
  const hasIn = new Set(alive.map((e) => e.to));
  const state = new Array<0 | 1 | 2>(n).fill(0);
  const back = new Set<(typeof edges)[number]>();
  const visit = (id: number) => {
    state[id] = 1;
    for (const e of alive) {
      if (e.from !== id) continue;
      if (state[e.to] === 1) back.add(e);
      else if (state[e.to] === 0) visit(e.to);
    }
    state[id] = 2;
  };
  for (let id = 0; id < n; id++) if (!hasIn.has(id) && state[id] === 0) visit(id);
  for (let id = 0; id < n; id++) if (state[id] === 0) visit(id);
  if (back.size) {
    problems.push(
      `${[...back].map((e) => `${names[e.from]} → ${names[e.to]}`).join(", ")} flows back to an earlier node. A Sankey has no cycles; ${back.size > 1 ? "those flows are" : "that flow is"} not drawn. Make a retry its own node.`,
    );
    for (let q = alive.length - 1; q >= 0; q--) if (back.has(alive[q])) alive.splice(q, 1);
  }
  // Layers: the longest path from a source.
  const layer = new Array<number>(n).fill(0);
  const indeg = new Array<number>(n).fill(0);
  for (const e of alive) indeg[e.to]++;
  const queue = names.map((_, i) => i).filter((i) => indeg[i] === 0);
  while (queue.length) {
    const id = queue.shift() as number;
    for (const e of alive) {
      if (e.from !== id) continue;
      layer[e.to] = Math.max(layer[e.to], layer[id] + 1);
      if (--indeg[e.to] === 0) queue.push(e.to);
    }
  }
  const layers = Math.max(...layer) + 1;
  if (layers < 2) return { ...empty, problems };
  if (layers > 4) {
    problems.push(`The flows have ${layers} stages. 3 read best: split into two Sankeys.`);
  }
  const inSum = new Array<number>(n).fill(0);
  const outSum = new Array<number>(n).fill(0);
  for (const e of alive) {
    outSum[e.from] += e.value;
    inSum[e.to] += e.value;
  }
  const value = names.map((_, i) => Math.max(inSum[i], outSum[i]));
  names.forEach((name, i) => {
    if (inSum[i] > 0 && outSum[i] > 0 && !same(inSum[i], outSum[i])) {
      problems.push(
        `${name}: ${fmtNum(inSum[i])} flows in and ${fmtNum(outSum[i])} flows out. The bar is as tall as the larger side.`,
      );
    }
  });
  // Order within a column by the average position of its neighbours, to keep the bands from crossing.
  const columns: number[][] = Array.from({ length: layers }, () => []);
  names.forEach((_, i) => {
    if (inSum[i] + outSum[i] > 0) columns[layer[i]].push(i);
  });
  for (const col of columns) col.sort((a, b) => value[b] - value[a]);
  const pos = new Array<number>(n).fill(0);
  const reindex = () => columns.forEach((col) => col.forEach((id, k) => (pos[id] = k)));
  reindex();
  for (let pass = 0; pass < 6; pass++) {
    const forward = pass % 2 === 0;
    const seq = forward ? columns.slice(1) : columns.slice(0, -1).reverse();
    for (const col of seq) {
      const bary = new Map<number, number>();
      for (const id of col) {
        let s = 0;
        let w = 0;
        for (const e of alive) {
          const other = forward ? (e.to === id ? e.from : -1) : e.from === id ? e.to : -1;
          if (other >= 0) {
            s += pos[other] * e.value;
            w += e.value;
          }
        }
        bary.set(id, w ? s / w : pos[id]);
      }
      col.sort((a, b) => (bary.get(a) as number) - (bary.get(b) as number));
      reindex();
    }
  }
  // One scale for every column.
  const room = SK.h - SK.top - SK.bottom;
  let k = Infinity;
  for (const col of columns) {
    const sum = col.reduce((a, id) => a + value[id], 0);
    k = Math.min(k, (room - SK.gap * (col.length - 1)) / sum);
  }
  const nodes: SkNode[] = [];
  const plotW = SK.w - SK.left - SK.right;
  const focusId =
    props?.focus == null || !clean(props.focus)
      ? -1
      : names.findIndex((x) => x.toLowerCase() === focusKey(props.focus));
  if (props?.focus != null && clean(props.focus) && focusId < 0) {
    problems.push(`focus "${clean(props.focus)}" is not a node name. Nothing is marked.`);
  }
  for (let c = 0; c < layers; c++) {
    const col = columns[c];
    const height = col.reduce((a, id) => a + value[id] * k, 0) + SK.gap * (col.length - 1);
    let y = SK.top + (room - height) / 2;
    for (const id of col) {
      const h = Math.max(2, value[id] * k);
      const x = SK.left + (layers > 1 ? (c * (plotW - SK.bar)) / (layers - 1) : 0);
      const side: SkNode["side"] =
        c === 0 ? "left" : outSum[id] === 0 || c === layers - 1 ? "right" : "inside";
      const room1 = side === "inside" ? 150 : SK.left - 18;
      nodes[id] = {
        id,
        name: names[id],
        layer: c,
        value: value[id],
        x,
        y,
        h,
        focus: id === focusId,
        part: `${names[id]}: ${withUnit(value[id], unit)}`,
        side,
        lines: [
          { text: fit(names[id], room1, 14), cls: "name" },
          { text: fit(withUnit(value[id], unit), room1, 12), cls: "value" },
        ],
      };
      y += h + SK.gap;
    }
  }
  // Bands: each node gives its outgoing bands, and takes its incoming ones, in the order of the other end.
  const outAt = new Map<number, number>();
  const inAt = new Map<number, number>();
  const sy = new Map<string, number>();
  const ty = new Map<string, number>();
  for (const node of nodes.filter(Boolean)) {
    let a = node.y;
    for (const e of alive
      .filter((x) => x.from === node.id)
      .sort((p, q) => nodes[p.to].y - nodes[q.to].y)) {
      sy.set(`${e.from}>${e.to}`, a);
      a += e.value * k;
    }
    outAt.set(node.id, a);
    let b = node.y;
    for (const e of alive
      .filter((x) => x.to === node.id)
      .sort((p, q) => nodes[p.from].y - nodes[q.from].y)) {
      ty.set(`${e.from}>${e.to}`, b);
      b += e.value * k;
    }
    inAt.set(node.id, b);
  }
  const r = (x: number) => Math.round(x * 10) / 10;
  const flows: SkFlow[] = alive.map((e) => {
    const key = `${e.from}>${e.to}`;
    const t = Math.max(2, e.value * k);
    const xs = nodes[e.from].x + SK.bar;
    const xt = nodes[e.to].x;
    const mid = (xs + xt) / 2;
    const y0 = sy.get(key) as number;
    const y1 = ty.get(key) as number;
    const d = `M${r(xs)},${r(y0)}C${r(mid)},${r(y0)} ${r(mid)},${r(y1)} ${r(xt)},${r(y1)}L${r(xt)},${r(y1 + t)}C${r(mid)},${r(y1 + t)} ${r(mid)},${r(y0 + t)} ${r(xs)},${r(y0 + t)}Z`;
    return {
      from: e.from,
      to: e.to,
      value: e.value,
      d,
      focus: focusId >= 0 && (e.from === focusId || e.to === focusId),
      part: `${names[e.from]} → ${names[e.to]}: ${withUnit(e.value, unit)}`,
    };
  });
  return { nodes: nodes.filter(Boolean), flows, layers, unit, w: SK.w, h: SK.h, problems };
}
