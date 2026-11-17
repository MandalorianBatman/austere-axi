// A statement as plain text: what a person would read on the page, for the content index,
// `find`, `show --text` and the history views. No Node APIs: the playground runs it too.
//
// The parser's tree names every prop, so the rules read props by name; the library schema
// (spec.json, merged with the page's packs) says which props are enumerations (variant, size,
// kind: not text). A statement holds the strings of its own props, in signature order. A
// reference to another statement is not followed: that statement has its own row. The few
// exceptions are parts that are only read together: a form's fields and options, a chart's
// series names.
import { splitStatements } from "./statements.ts";

/** A parsed element, as much of it as text needs. */
interface ElementLike {
  type: "element";
  typeName: string;
  props: Record<string, unknown>;
  statementId?: string;
}

/** A node of the library schema: text reads each component's props, and which of them are enumerations. */
interface SchemaLike {
  properties?: Record<string, SchemaLike>;
  [keyword: string]: unknown;
}

/** The part of the library schema (spec.json, merged with the page's packs) text reads. */
export interface TextSpec {
  $defs?: Record<string, SchemaLike>;
}

/** What a statement is: the component it calls (empty for a plain value) and its text. */
export interface StatementText {
  name: string;
  component: string;
  text: string;
}

const isElement = (v: unknown): v is ElementLike => !!v && typeof v === "object" && (v as { type?: unknown }).type === "element" && typeof (v as { typeName?: unknown }).typeName === "string";

/** Components read together with what they hold, references included. */
const DEEP = new Set(["Form"]);

/** Props whose references are read with the statement: a chart's series carry its legend. */
const DEEP_PROPS = new Set(["series"]);

/** Props that are identifiers, not text. */
const IDS = new Set(["id"]);

/** Components whose `name` is a field's identifier, not text (an Avatar's name is text). */
const FIELDS = new Set(["Form", "Input", "TextArea", "Select", "Slider", "CheckBoxGroup", "CheckBoxItem", "RadioGroup", "RadioItem", "SwitchGroup", "SwitchItem", "FormControl"]);

/** Every element of the tree that is a statement, by its name; the first one found when a statement is shown twice. */
export function elementsByStatement(root: unknown): Map<string, ElementLike> {
  const out = new Map<string, ElementLike>();
  const seen = new Set<object>();
  const stack: unknown[] = [root];
  while (stack.length) {
    const v = stack.pop();
    if (!v || typeof v !== "object" || seen.has(v)) continue;
    seen.add(v);
    if (isElement(v)) {
      if (v.statementId && !out.has(v.statementId)) out.set(v.statementId, v);
      stack.push(...Object.values(v.props || {}));
    } else {
      stack.push(...(Array.isArray(v) ? v : Object.values(v)));
    }
  }
  return out;
}

/** The text of one statement's element. */
function textOf(el: ElementLike, spec: TextSpec | undefined, follow: boolean, top: ElementLike): string[] {
  switch (el.typeName) {
    case "Table":
      return [tableText(el, spec)];
    case "Architecture":
      return architectureText(el);
    case "Edge":
      return [edgeText(el)];
    case "Group": {
      const members = (Array.isArray(el.props.members) ? el.props.members : []).map(labelOf).filter(Boolean);
      return [String(el.props.label ?? ""), ...(members.length ? [`members: ${members.join(", ")}`] : [])].filter(Boolean);
    }
    case "Diff":
      return diffText(el);
  }
  const defs = spec?.$defs?.[el.typeName]?.properties;
  const lines: string[] = [];
  const deep = follow || (el === top && DEEP.has(el.typeName));
  // `schema` is the library's description of the value: an enumeration is not text, wherever it sits.
  const walk = (v: unknown, node: SchemaLike | undefined, deepHere: boolean): void => {
    const ref = typeof node?.$ref === "string" ? spec?.$defs?.[node.$ref.replace(/^#\/\$defs\//, "")] : undefined;
    const schema = ref ?? node;
    if (schema?.enum) return;
    if (typeof v === "string") {
      if (v.trim()) lines.push(v);
    } else if (Array.isArray(v)) {
      const items = schema?.items;
      for (const x of v) walk(x, items && typeof items === "object" ? (items as SchemaLike) : undefined, deepHere);
    } else if (isElement(v)) {
      // A reference has its own row; an element written in place is part of this statement.
      if (v.statementId && !deepHere) return;
      lines.push(...textOf(v, spec, deepHere || DEEP.has(v.typeName), top));
    } else if (v && typeof v === "object" && !("k" in v)) {
      // A plain object (a row of an EntityList); `k` marks an expression such as a button's action.
      for (const [k, x] of Object.entries(v)) walk(x, schema?.properties?.[k], deepHere);
    }
  };
  for (const [prop, v] of Object.entries(el.props || {})) {
    if (IDS.has(prop) || (prop === "name" && FIELDS.has(el.typeName))) continue;
    walk(v, defs?.[prop], deep || DEEP_PROPS.has(prop));
  }
  return lines;
}

/** A cell of a table or a node's label: strings and numbers as written, an element as its text. */
function cellText(v: unknown, spec: TextSpec | undefined): string {
  if (v == null) return "";
  if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") return String(v);
  if (isElement(v)) return textOf(v, spec, true, v).join(" ");
  return Array.isArray(v) ? v.map((x) => cellText(x, spec)).join(" ") : "";
}

const cell = (s: string): string => s.replace(/\|/g, "\\|").replace(/\s*\n\s*/g, " ").trim();

/** A table as a Markdown table, from its columns. */
function tableText(el: ElementLike, spec: TextSpec | undefined): string {
  const cols = (Array.isArray(el.props.columns) ? el.props.columns : []).filter(isElement);
  if (!cols.length) return "";
  const data = cols.map((c) => (Array.isArray(c.props.data) ? c.props.data : []));
  const rows = Math.max(0, ...data.map((d) => d.length));
  const head = cols.map((c) => cell(String(c.props.label ?? "")));
  const lines = [`| ${head.join(" | ")} |`, `| ${head.map(() => "---").join(" | ")} |`];
  for (let r = 0; r < rows; r++) lines.push(`| ${data.map((d) => cell(cellText(d[r], spec))).join(" | ")} |`);
  return lines.join("\n");
}

const labelOf = (v: unknown): string => (isElement(v) ? String(v.props.label ?? v.statementId ?? "") : typeof v === "string" ? v : "");

/** A diagram as its nodes, then one `a → b (label)` line per edge. */
function architectureText(el: ElementLike): string[] {
  const nodes = (Array.isArray(el.props.nodes) ? el.props.nodes : []).map(labelOf).filter(Boolean);
  const lines = nodes.length ? [`nodes: ${nodes.join(", ")}`] : [];
  for (const e of Array.isArray(el.props.edges) ? el.props.edges : []) if (isElement(e)) lines.push(edgeText(e));
  return lines;
}

/** `a → b (label)` */
function edgeText(e: ElementLike): string {
  const label = typeof e.props.label === "string" && e.props.label ? ` (${e.props.label})` : "";
  return `${labelOf(e.props.from)} → ${labelOf(e.props.to)}${label}`;
}

/** A diff as its file names with + and − counts: the body is the page's, not the index's. */
function diffText(el: ElementLike): string[] {
  const lines: string[] = [];
  if (typeof el.props.title === "string" && el.props.title) lines.push(el.props.title);
  const files: { name: string; add: number; del: number }[] = [];
  let current: { name: string; add: number; del: number } | null = null;
  for (const line of String(el.props.patch ?? "").split("\n")) {
    const head = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
    if (head) files.push((current = { name: head[2], add: 0, del: 0 }));
    else if (/^\+\+\+ /.test(line)) {
      const name = line.slice(4).replace(/^b\//, "").trim();
      if (!current || (current.add || current.del)) files.push((current = { name, add: 0, del: 0 }));
      else if (name !== "/dev/null") current.name = name;
    } else if (/^--- /.test(line)) continue;
    else if (current && line.startsWith("+")) current.add++;
    else if (current && line.startsWith("-")) current.del++;
  }
  for (const f of files) lines.push(`${f.name} +${f.add} −${f.del}`);
  return lines;
}

/** The string literals of a statement's source: what is left to read when the parser has no element for it. */
function literalsOf(source: string): string[] {
  const body = source.slice(source.indexOf("=") + 1);
  const out: string[] = [];
  for (const m of body.matchAll(/"((?:[^"\\]|\\[\s\S])*)"|'((?:[^'\\]|\\[\s\S])*)'/g)) {
    const s = (m[1] ?? m[2]).replace(/\\(["'\\])/g, "$1").replace(/\\n/g, "\n");
    if (s.trim()) out.push(s);
  }
  return out;
}

/**
 * The plain text of statement `name`. `root` is the parsed tree (null when the program did not
 * parse), `source` the statement's own source, the fallback for a statement the tree does not
 * hold (not reachable from root, or not a component).
 */
export function statementText(root: unknown, name: string, source: string, spec?: TextSpec, elements: Map<string, ElementLike> = elementsByStatement(root)): StatementText {
  const el = elements.get(name);
  if (el) return { name, component: el.typeName, text: textOf(el, spec, false, el).join("\n") };
  const head = /^\s*[A-Za-z_$][\w$]*\s*=\s*([A-Z][\w$]*)\s*\(/.exec(source);
  return { name, component: head?.[1] ?? "", text: literalsOf(source).join("\n") };
}

/** Every statement of a program as text, in source order; a name defined twice is its last definition, as in the language. */
export function programText(program: string, root: unknown, spec?: TextSpec): StatementText[] {
  const elements = elementsByStatement(root);
  const last = new Map<string, string>();
  for (const s of splitStatements(program)) {
    last.delete(s.id);
    last.set(s.id, s.text);
  }
  return [...last].map(([id, source]) => statementText(root, id, source, spec, elements));
}

/** A row of an outline: a named statement, how deep it sits under root, and what it starts with. */
export interface OutlineRow {
  name: string;
  component: string;
  depth: number;
  /** The named statements directly under it. */
  children: number;
  /** Its first words. */
  words: string;
}

const words = (text: string, n: number): string => {
  const w = text.split(/\s+/).filter(Boolean);
  return w.length > n ? `${w.slice(0, n).join(" ")}…` : w.join(" ");
};

/** Components whose parts the outline folds into their row: the row's text already says what they hold, and `show --deps` reads the parts. */
const FOLDED = new Set(["Architecture", "Table", "Form"]);

/**
 * The page as a tree from `root`: one row per named statement, each once (the first place it
 * is used), with its first 8 words; the parts of a diagram, a table or a form are counted in
 * its row, not listed. A statement nothing refers to, that root does not reach, is listed in `unreached`.
 */
export function outlineOf(program: string, root: unknown, spec?: TextSpec): { rows: OutlineRow[]; unreached: string[] } {
  const elements = elementsByStatement(root);
  const rows: OutlineRow[] = [];
  const seen = new Set<string>();
  const walk = (v: unknown, depth: number, parent: OutlineRow | null, folded: boolean): void => {
    if (!v || typeof v !== "object") return;
    if (Array.isArray(v)) return void v.forEach((x) => walk(x, depth, parent, folded));
    if (!isElement(v)) return;
    let row = parent;
    let next = depth;
    let inside = folded;
    if (v.statementId && !seen.has(v.statementId)) {
      seen.add(v.statementId);
      if (parent) parent.children++;
      if (!folded) {
        const t = statementText(root, v.statementId, "", spec, elements);
        row = { name: v.statementId, component: v.typeName, depth, children: 0, words: words(t.text, 8) };
        rows.push(row);
        next = depth + 1;
        inside = FOLDED.has(v.typeName);
      }
    } else if (v.statementId) return;
    for (const child of Object.values(v.props || {})) walk(child, next, row, inside);
  };
  walk(root, 0, null, false);
  const map = new Map(splitStatements(program).map((s) => [s.id, s.text]));
  const referenced = new Set<string>();
  for (const [id, text] of map) {
    const body = text.slice(text.indexOf("=") + 1).replace(/"(?:[^"\\]|\\[\s\S])*"|'(?:[^'\\]|\\[\s\S])*'/g, '""');
    for (const other of map.keys()) if (other !== id && new RegExp(`(^|[^\\w$])${other.replace(/\$/g, "\\$")}(?![\\w$])`).test(body)) referenced.add(other);
  }
  return { rows, unreached: [...map.keys()].filter((id) => !seen.has(id) && !referenced.has(id) && id !== "root") };
}
