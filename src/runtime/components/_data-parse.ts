// ERDiagram and ClassDiagram: the lines of text inside a box (a field, a class
// member), the cardinality of a relation, and the size of a box with rows. Free
// of JSX and DOM so it can be unit-tested in Node. Never throws on agent input.
import { SIZES, textWidth } from "./_architecture-model.ts";

export const ENTITY_KINDS = ["entity"] as const;
export const CLASS_KINDS = ["class", "interface", "abstract", "enum"] as const;
export const DATA_SHAPES = [...ENTITY_KINDS, ...CLASS_KINDS] as const;
export type DataShape = (typeof DATA_SHAPES)[number];

/** What is drawn at one end of a relation. The three triangle-and-diamond marks are UML's; the rest are crow's foot. */
export const END_MARKS = [
  "one",
  "zero-one",
  "many",
  "one-many",
  "zero-many",
  "triangle",
  "diamond",
  "diamond-open",
  "open",
] as const;
export type EndMark = (typeof END_MARKS)[number];

/** The marks on both ends of an edge, the text beside each end, and what a click on it is called. */
export interface EdgeEnds {
  fromMark: EndMark | "";
  toMark: EndMark | "";
  fromText: string;
  toText: string;
  part: string;
}

export const isDataShape = (shape: string): shape is DataShape =>
  (DATA_SHAPES as readonly string[]).includes(shape);

// ── Fields (ER and database schema) ──

export interface Field {
  name: string;
  type: string;
  /** Constraint chips as drawn: "PK", "FK users.id", "UQ", "IDX", "NN". */
  marks: string[];
}

const MARK_WORDS: Record<string, string> = {
  pk: "PK",
  primary: "PK",
  fk: "FK",
  unique: "UQ",
  uq: "UQ",
  index: "IDX",
  idx: "IDX",
  nn: "NN",
  notnull: "NN",
};

const bullet = (line: string) => line.replace(/^\s*[-*•]\s+/, "").trim();

/**
 * `"id uuid pk"` → name `id`, type `uuid`, marks `[PK]`. The first word is the
 * name; words up to the first mark are the type; `fk users.id` keeps its target.
 * Near-misses parse too: `PK`, `not null`, `primary key`, `unique`, `idx`.
 */
export function parseField(line: string): Field {
  const words = bullet(line).split(/\s+/).filter(Boolean);
  const name = words.shift() ?? "";
  const type: string[] = [];
  const marks: string[] = [];
  const add = (mark: string) => {
    if (!marks.includes(mark)) marks.push(mark);
  };
  for (let i = 0; i < words.length; i++) {
    const w = words[i].toLowerCase().replace(/[,;]+$/, "");
    const next = (words[i + 1] ?? "").toLowerCase();
    if (w === "not" && next === "null") {
      add("NN");
      i++;
    } else if (w === "primary" && next === "key") {
      add("PK");
      i++;
    } else if (w === "fk" || w === "references" || w === "ref" || w === "→" || w === "->") {
      const target = words[i + 1] ?? "";
      if (/[A-Za-z_]\w*\.\w+/.test(target) || /^(→|->)/.test(target)) {
        add(`FK ${target.replace(/^(→|->)/, "")}`);
        i++;
      } else add("FK");
    } else if (MARK_WORDS[w] && w !== "primary") add(MARK_WORDS[w]);
    else if (!marks.length) type.push(words[i]);
  }
  return { name, type: type.join(" "), marks };
}

// ── Members (UML class) ──

/** An operation has a parameter list; everything else is an attribute. */
export const isOperation = (line: string): boolean => line.includes("(");

// ── Cardinality ──

const SIDES: Record<string, EndMark> = {
  "1": "one",
  "1..1": "one",
  "0..1": "zero-one",
  "?": "zero-one",
  n: "many",
  m: "many",
  "*": "many",
  many: "many",
  "0..n": "zero-many",
  "0..m": "zero-many",
  "0..*": "zero-many",
  "1..n": "one-many",
  "1..m": "one-many",
  "1..*": "one-many",
};

/**
 * `"1:N"` → one at the first entity, many at the second. Reads `1:1`, `1:N`,
 * `N:M`, `0..1:1..*`, and with `-`, `to` or an arrow between the sides.
 * `null` when it does not read: the caller reports it.
 */
export function parseCardinality(text: string): { from: EndMark; to: EndMark } | null {
  const s = text.trim().toLowerCase();
  const sides = s.includes(":") ? s.split(":") : s.split(/\s*(?:-+>?|→|\bto\b)\s*/);
  if (sides.length !== 2) return null;
  const [a, b] = sides.map((x) => SIDES[x.trim()]);
  return a && b ? { from: a, to: b } : null;
}

// ── Boxes with rows ──

const PAD = 12;
const GAP = 14;
const ROW_H = 20;
const DIVIDER_H = 8;
const BODY_PAD = 5;
const MIN_W = 140;
const MAX_W = 360;
const NAME = 12;
const TYPE = 11;
const MARK = 10;

/** One line of a box, cut to its column. `part` is the line as the agent wrote it. */
export interface DataRow {
  part: string;
  main: string;
  type: string;
  marks: string;
  /** A hairline above it: where a class's operations begin. */
  divider: boolean;
}

export interface DataBox {
  width: number;
  height: number;
  headerHeight: number;
  /** The name, cut to the box. */
  title: string;
  stereotype: string;
  italic: boolean;
  rows: DataRow[];
  /** Left edge of the type and the mark columns, from the box's left edge. */
  typeX: number;
  markX: number;
}

/** `text` cut to `maxWidth` with a "…" when it does not fit. */
export function cut(text: string, size: number, maxWidth: number, mono = false): string {
  if (textWidth(text, size, mono) <= maxWidth) return text;
  const chars = [...text];
  let out = "";
  for (const ch of chars) {
    if (textWidth(`${out}${ch}…`, size, mono) > maxWidth) break;
    out += ch;
  }
  return `${out.trimEnd()}…`;
}

const STEREOTYPE: Record<string, string> = {
  interface: "«interface»",
  abstract: "«abstract»",
  enum: "«enumeration»",
};

/** Size a box: a header with the name, then one row for each line. */
export function sizeData(label: string, lines: string[], shape: DataShape): DataBox {
  const stereotype = STEREOTYPE[shape] ?? "";
  const headerHeight = stereotype ? 46 : 30;
  const headerW = Math.max(textWidth(label, SIZES.label), textWidth(stereotype, 10)) + PAD * 2;
  const clean = lines.map((l) => (shape === "entity" ? bullet(l) : l.trim())).filter(Boolean);

  let rows: DataRow[];
  let typeX = 0;
  let markX = 0;
  let natural = headerW;
  if (shape === "entity") {
    const fields = clean.map((line) => ({ line, ...parseField(line) }));
    const nameW = Math.max(0, ...fields.map((f) => textWidth(f.name, NAME)));
    const typeW = Math.min(120, Math.max(0, ...fields.map((f) => textWidth(f.type, TYPE, true))));
    const markW = Math.min(
      150,
      Math.max(0, ...fields.map((f) => textWidth(f.marks.join(" "), MARK, true))),
    );
    const avail = MAX_W - PAD * 2 - (typeW ? GAP + typeW : 0) - (markW ? GAP + markW : 0);
    let nameCol = nameW;
    let typeCol = typeW;
    if (nameW > avail) {
      nameCol = Math.max(48, avail);
      // No room even for a short name: the type column gives way.
      if (avail < 48 && typeW) typeCol = Math.max(30, typeW - (48 - avail));
    }
    typeX = PAD + nameCol + GAP;
    markX = typeX + (typeCol ? typeCol + GAP : 0);
    natural = Math.max(
      headerW,
      PAD * 2 + nameCol + (typeCol ? GAP + typeCol : 0) + (markW ? GAP + markW : 0),
    );
    rows = fields.map((f) => ({
      part: f.line,
      main: cut(f.name, NAME, nameCol),
      type: cut(f.type, TYPE, typeCol, true),
      marks: cut(f.marks.join(" "), MARK, markW, true),
      divider: false,
    }));
  } else {
    const attributes = shape === "enum" ? clean : clean.filter((l) => !isOperation(l));
    const operations = shape === "enum" ? [] : clean.filter(isOperation);
    const ordered = [...attributes, ...operations];
    const widest = Math.max(0, ...ordered.map((l) => textWidth(l, TYPE, true)));
    natural = Math.max(headerW, widest + PAD * 2);
    const inner = Math.min(MAX_W, Math.max(MIN_W, natural)) - PAD * 2;
    rows = ordered.map((line, i) => ({
      part: line,
      main: cut(line, TYPE, inner, true),
      type: "",
      marks: "",
      divider: i === attributes.length && attributes.length > 0 && operations.length > 0,
    }));
  }

  const width = Math.min(MAX_W, Math.max(MIN_W, natural));
  const dividers = rows.filter((r) => r.divider).length;
  const height = rows.length
    ? headerHeight + BODY_PAD * 2 + rows.length * ROW_H + dividers * DIVIDER_H
    : headerHeight;
  return {
    width,
    height,
    headerHeight,
    title: cut(label, SIZES.label, width - PAD * 2),
    stereotype,
    italic: shape === "abstract",
    rows,
    typeX,
    markX,
  };
}

/** Top of a row from the box's top edge. */
export function rowTop(box: DataBox, index: number): number {
  let y = box.headerHeight + BODY_PAD + index * ROW_H;
  for (let i = 0; i <= index; i++) if (box.rows[i].divider) y += DIVIDER_H;
  return y;
}

export { ROW_H, DIVIDER_H };
