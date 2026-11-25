// Heatmap, PermissionMatrix, UnitGrid and Traceability: parsed props → rows and cells.
// Pure TypeScript (no JSX), so Node tests can import it. Never throws: a shape that is
// wrong still draws what it can, and says what it dropped in `problems`.
import { isElement } from "./element.ts";

export const str = (v: unknown): string => (typeof v === "string" ? v : v == null ? "" : String(v));
export const clean = (v: unknown): string => str(v).trim().replace(/\s+/g, " ");
const key = (v: unknown): string => clean(v).toLowerCase();

/** Labels in list order. A repeat is kept: values line up with columns by position. */
export function labels(v: unknown): string[] {
  return (Array.isArray(v) ? v : []).map((item, i) => clean(item) || `#${i + 1}`);
}

export interface Part {
  /** The statement name; "#row0" and so on for an inline (unnamed) part. */
  id: string;
  named: boolean;
  props: Record<string, unknown>;
}

/** Parts in list order. A part listed twice is drawn once. */
export function partsOf(
  list: unknown,
  tag: string,
  part: string,
  component: string,
  problems: string[],
): Part[] {
  const out: Part[] = [];
  const seen = new Set<unknown>();
  const ids = new Set<string>();
  let anon = 0;
  for (const el of Array.isArray(list) ? list : []) {
    if (!isElement<Record<string, unknown>>(el)) continue;
    const statementId =
      "statementId" in el && typeof el.statementId === "string" ? el.statementId : "";
    // Statement names are identifiers: "#" cannot collide with one.
    const id = statementId || `#${tag}${anon++}`;
    if (seen.has(el) || ids.has(id)) {
      problems.push(`${part} ${id} is listed twice in ${component}. It is drawn once.`);
      continue;
    }
    seen.add(el);
    ids.add(id);
    out.push({ id, named: !!statementId, props: el.props });
  }
  return out;
}

/** A finite number from a number or a numeric string ("1,200", "47%"); null for anything else. */
export function parseNumber(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v !== "string") return null;
  const text = v.trim().replace(/,/g, "").replace(/%$/, "");
  if (!text) return null;
  const n = Number(text);
  return Number.isFinite(n) ? n : null;
}

const round2 = (n: number): string => String(Math.round(n * 100) / 100);

// ── Heatmap ──

export interface HeatCell {
  /** What is printed in the cell: the value and the unit, "–" when there is none. */
  text: string;
  value: number | null;
  /** The one editorial cell, outside the ramp. */
  focal: boolean;
  fill: string;
  /** The text colour that reads on `fill`. */
  ink: "light" | "dark";
}

export interface HeatRowModel {
  id: string;
  named: boolean;
  label: string;
  cells: HeatCell[];
}

export interface HeatModel {
  columns: string[];
  rows: HeatRowModel[];
  /** The ramp's range over the cells that are not focal, as printed. "" when no cell has a value. */
  low: string;
  high: string;
  hasFocal: boolean;
  problems: string[];
}

type Rgb = readonly [number, number, number];
const RAMP_LOW: Rgb = [44, 48, 62];
const RAMP_HIGH: Rgb = [200, 208, 228];
/** The accent, for the one focal cell. */
export const FOCAL_FILL: Rgb = [143, 176, 255];

const rgb = (c: Rgb): string => `rgb(${c[0]}, ${c[1]}, ${c[2]})`;
const mix = (a: Rgb, b: Rgb, t: number): Rgb => [
  Math.round(a[0] + (b[0] - a[0]) * t),
  Math.round(a[1] + (b[1] - a[1]) * t),
  Math.round(a[2] + (b[2] - a[2]) * t),
];
const channel = (c: number): number => {
  const s = c / 255;
  return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
};
/** WCAG relative luminance. */
export const luminance = (c: Rgb): number =>
  0.2126 * channel(c[0]) + 0.7152 * channel(c[1]) + 0.0722 * channel(c[2]);

/** White on dark fills, black on light ones; the switch sits where both pass 4.5:1. */
export function inkFor(c: Rgb): "light" | "dark" {
  return luminance(c) > 0.179 ? "dark" : "light";
}

/** The fill of a ramp step, t from 0 (lowest) to 1 (highest). */
export function rampFill(t: number): { fill: string; ink: "light" | "dark" } {
  const c = mix(RAMP_LOW, RAMP_HIGH, Math.min(1, Math.max(0, t)));
  return { fill: rgb(c), ink: inkFor(c) };
}

/** Heatmap(columns, rows, unit?): one HeatRow of values for each row, the fill following the value. */
export function buildHeatmap(props: Record<string, unknown> | undefined): HeatModel {
  const problems: string[] = [];
  const columns = labels(props?.columns);
  const unit = str(props?.unit).trim();
  const parts = partsOf(props?.rows, "row", "HeatRow", "Heatmap", problems);
  let focalSeen = false;
  const rows: HeatRowModel[] = parts.map((part) => {
    const label = clean(part.props.label) || part.id;
    const values = Array.isArray(part.props.values) ? part.props.values : [];
    if (values.length !== columns.length) {
      problems.push(
        `HeatRow "${label}" has ${values.length} values for ${columns.length} columns. ${values.length < columns.length ? "The rest show as –" : "The extra values are dropped"}.`,
      );
    }
    const focus = key(part.props.focus);
    const focusAt = focus ? columns.findIndex((c) => key(c) === focus) : -1;
    if (focus && focusAt < 0) {
      problems.push(
        `HeatRow "${label}" has focus "${clean(part.props.focus)}", which is not a column.`,
      );
    }
    const cells = columns.map((_, c): HeatCell => {
      const value = parseNumber(values[c]);
      const focal = c === focusAt && !focalSeen;
      if (focal) focalSeen = true;
      else if (c === focusAt) {
        problems.push(`HeatRow "${label}": only one focal cell is drawn. The first one wins.`);
      }
      return {
        text: value === null ? "–" : `${round2(value)}${unit}`,
        value,
        focal,
        fill: "",
        ink: "light",
      };
    });
    return { id: part.id, named: part.named, label, cells };
  });
  // The ramp covers the cells that are not focal: an outlier would flatten the rest.
  const ramp = rows.flatMap((r) =>
    r.cells.flatMap((c) => (!c.focal && c.value !== null ? [c.value] : [])),
  );
  const min = ramp.length ? Math.min(...ramp) : 0;
  const max = ramp.length ? Math.max(...ramp) : 0;
  for (const row of rows) {
    for (const cell of row.cells) {
      if (cell.focal) {
        cell.fill = rgb(FOCAL_FILL);
        cell.ink = inkFor(FOCAL_FILL);
      } else if (cell.value !== null) {
        Object.assign(cell, rampFill(max === min ? 0.5 : (cell.value - min) / (max - min)));
      }
    }
  }
  return {
    columns,
    rows,
    low: ramp.length ? `${round2(min)}${unit}` : "",
    high: ramp.length ? `${round2(max)}${unit}` : "",
    hasFocal: focalSeen,
    problems,
  };
}

// ── PermissionMatrix ──

export const ACCESS_LEVELS = ["none", "read", "write", "admin"] as const;
export type AccessLevel = (typeof ACCESS_LEVELS)[number];

const ACCESS_WORDS: Record<AccessLevel, string[]> = {
  none: ["", "none", "no", "no access", "deny", "denied", "n", "-", "–", "—", "0"],
  read: ["read", "r", "ro", "read only", "readonly", "select", "view", "login", "list"],
  write: ["write", "w", "rw", "r/w", "read/write", "read write", "edit", "update", "insert"],
  admin: ["admin", "full", "owner", "manage", "all", "own"],
};

export const ACCESS_LABELS: Record<AccessLevel, string> = {
  none: "None",
  read: "Read",
  write: "Write",
  admin: "Admin",
};

/** A level from the word an agent wrote ("R/W", "SELECT", "Full"); null for a word that is none of them. */
export function parseAccess(v: unknown): AccessLevel | null {
  const word = key(v);
  return ACCESS_LEVELS.find((level) => ACCESS_WORDS[level].includes(word)) ?? null;
}

export interface AccessCell {
  /** null: a word that is not a level, printed as written. */
  level: AccessLevel | null;
  text: string;
  focal: boolean;
}

export interface AccessRowModel {
  id: string;
  named: boolean;
  resource: string;
  hint: string;
  cells: AccessCell[];
}

export interface AccessModel {
  roles: string[];
  rows: AccessRowModel[];
  /** The levels that appear, in order, for the legend. */
  used: AccessLevel[];
  hasFocal: boolean;
  problems: string[];
}

/** PermissionMatrix(roles, rows): one AccessRow of grants for each resource, in role order. */
export function buildPermissions(props: Record<string, unknown> | undefined): AccessModel {
  const problems: string[] = [];
  const roles = labels(props?.roles);
  const parts = partsOf(props?.rows, "row", "AccessRow", "PermissionMatrix", problems);
  let focalSeen = false;
  const used = new Set<AccessLevel>();
  const rows: AccessRowModel[] = parts.map((part) => {
    const resource = clean(part.props.resource) || part.id;
    const grants = Array.isArray(part.props.grants) ? part.props.grants : [];
    if (grants.length !== roles.length) {
      problems.push(
        `AccessRow "${resource}" has ${grants.length} grants for ${roles.length} roles. ${grants.length < roles.length ? "The rest show as None" : "The extra grants are dropped"}.`,
      );
    }
    const focus = key(part.props.focus);
    const focusAt = focus ? roles.findIndex((r) => key(r) === focus) : -1;
    if (focus && focusAt < 0) {
      problems.push(
        `AccessRow "${resource}" has focus "${clean(part.props.focus)}", which is not a role.`,
      );
    }
    const cells = roles.map((_, c): AccessCell => {
      const raw = c < grants.length ? grants[c] : "";
      const level = parseAccess(raw);
      if (level) used.add(level);
      const focal = c === focusAt && !focalSeen;
      if (focal) focalSeen = true;
      else if (c === focusAt) {
        problems.push(`AccessRow "${resource}": only one focal cell is drawn. The first one wins.`);
      }
      return { level, text: level ? ACCESS_LABELS[level] : clean(raw), focal };
    });
    return { id: part.id, named: part.named, resource, hint: clean(part.props.hint), cells };
  });
  return {
    roles,
    rows,
    used: ACCESS_LEVELS.filter((l) => used.has(l)),
    hasFocal: focalSeen,
    problems,
  };
}

// ── UnitGrid ──

export const UNIT_TOTAL = 100;
/** Shapes and colours repeat after this many parts, so a part is never told by colour alone. */
export const UNIT_SHAPES = 6;

export interface UnitPart {
  id: string;
  named: boolean;
  name: string;
  detail: string;
  /** Whole units drawn. */
  count: number;
  /** "63.4" when the count was not whole: the legend says it was rounded. */
  asked: string;
  /** Position in the list, for the shape and colour. */
  index: number;
}

export interface UnitModel {
  parts: UnitPart[];
  /** Units no part claims. */
  remaining: number;
  /** For each of the 100 units in reading order: the part's index, or -1 for remaining. */
  cells: number[];
  unit: string;
  problems: string[];
}

/** UnitGrid(parts, unit?): 100 equal units in reading order, the parts filling them in list order. */
export function buildUnitGrid(props: Record<string, unknown> | undefined): UnitModel {
  const problems: string[] = [];
  const parts: UnitPart[] = [];
  let left = UNIT_TOTAL;
  partsOf(props?.parts, "share", "UnitShare", "UnitGrid", problems).forEach((part, index) => {
    const name = clean(part.props.name) || part.id;
    const raw = parseNumber(part.props.count);
    if (raw === null || raw < 0) {
      problems.push(
        `UnitShare "${name}" has count ${clean(part.props.count) || "none"}. Use a whole number from 0 to 100. It shows 0.`,
      );
    }
    const asked = raw === null || raw < 0 ? 0 : raw;
    let count = Math.round(asked);
    if (count > left) {
      problems.push(
        `UnitGrid holds 100 units. ${name} is cut to ${left}. Make the counts add up to 100 or less.`,
      );
      count = left;
    }
    left -= count;
    parts.push({
      id: part.id,
      named: part.named,
      name,
      detail: clean(part.props.detail),
      count,
      asked: asked !== Math.round(asked) ? round2(asked) : "",
      index,
    });
  });
  const cells: number[] = [];
  for (const part of parts) for (let i = 0; i < part.count; i++) cells.push(part.index);
  while (cells.length < UNIT_TOTAL) cells.push(-1);
  return { parts, remaining: left, cells, unit: clean(props?.unit), problems };
}

// ── Traceability ──

export interface TraceLink {
  /** The TraceItem's statement name. */
  id: string;
  named: boolean;
  /** The stable ID printed on the page ("D-12"). */
  code: string;
  name: string;
}

export interface TraceRow {
  id: string;
  named: boolean;
  code: string;
  text: string;
  source: string;
  design: TraceLink[];
  tests: TraceLink[];
}

export interface TraceModel {
  rows: TraceRow[];
  /** True when any requirement names a source: the Source column is drawn only then. */
  sourced: boolean;
  /** The IDs of the requirements with no design element, and with no test. */
  gaps: { noDesign: string[]; noTest: string[] };
  problems: string[];
}

export const TRACE_KINDS = ["design", "test"] as const;

/** Traceability(requirements, items): a row for each requirement; each item's `covers` IDs link it. */
export function buildTrace(props: Record<string, unknown> | undefined): TraceModel {
  const problems: string[] = [];
  const rows: TraceRow[] = [];
  const byCode = new Map<string, TraceRow>();
  for (const part of partsOf(props?.requirements, "req", "TraceReq", "Traceability", problems)) {
    const code = clean(part.props.id);
    if (!code) {
      problems.push(`TraceReq ${part.id} has no id. It is not drawn.`);
      continue;
    }
    if (byCode.has(key(code))) {
      problems.push(
        `Requirement id "${code}" is used twice in Traceability. The second is not drawn.`,
      );
      continue;
    }
    const row: TraceRow = {
      id: part.id,
      named: part.named,
      code,
      text: clean(part.props.text),
      source: clean(part.props.source),
      design: [],
      tests: [],
    };
    byCode.set(key(code), row);
    rows.push(row);
  }
  for (const part of partsOf(props?.items, "item", "TraceItem", "Traceability", problems)) {
    const code = clean(part.props.id);
    const name = clean(part.props.name);
    const kind = key(part.props.kind);
    const link: TraceLink = { id: part.id, named: part.named, code: code || part.id, name };
    if (kind !== "design" && kind !== "test") {
      problems.push(
        `TraceItem "${link.code}" has kind "${clean(part.props.kind)}". Use ${TRACE_KINDS.join(" or ")}. It is not drawn.`,
      );
      continue;
    }
    const covers = Array.isArray(part.props.covers) ? part.props.covers : [];
    let linked = 0;
    for (const cover of covers) {
      const row = byCode.get(key(cover));
      if (!row) {
        problems.push(
          `TraceItem "${link.code}" covers "${clean(cover)}", which no TraceReq has as its id.`,
        );
        continue;
      }
      const list = kind === "design" ? row.design : row.tests;
      if (!list.includes(link)) list.push(link);
      linked++;
    }
    if (!linked) problems.push(`TraceItem "${link.code}" covers no requirement. It is not drawn.`);
  }
  return {
    rows,
    sourced: rows.some((r) => r.source),
    gaps: {
      noDesign: rows.filter((r) => !r.design.length).map((r) => r.code),
      noTest: rows.filter((r) => !r.tests.length).map((r) => r.code),
    },
    problems,
  };
}
