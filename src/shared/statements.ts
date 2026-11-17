// Splits an OpenUI Lang program into top-level statements without parsing
// expressions. Used by the runtime (change highlighting) and the CLI (line
// numbers and source excerpts for feedback). Follows the language's rules for
// what ends a statement: a newline at bracket depth zero, outside a string.
// Comments (`//` and `#` to end of line) are skipped outside strings.

const IDENT_START = /[A-Za-z_$]/;

/** A top-level statement: its id, source text and first and last line (1-based). */
export interface Statement {
  id: string;
  text: string;
  line: number;
  endLine: number;
}

/** Statement id -> statement. */
export type StatementMap = Map<string, Statement>;

export function splitStatements(source: string | null | undefined): Statement[] {
  const out: Statement[] = [];
  const src = String(source ?? "");
  let i = 0;
  let line = 1;
  const n = src.length;

  while (i < n) {
    // Skip blank space between statements, and whole-line comments.
    const c = src[i];
    if (c === "\n") {
      line++;
      i++;
      continue;
    }
    if (c === " " || c === "\t" || c === "\r") {
      i++;
      continue;
    }
    if (c === "#" || (c === "/" && src[i + 1] === "/")) {
      while (i < n && src[i] !== "\n") i++;
      continue;
    }

    const start = i;
    const startLine = line;
    let depth = 0;
    let quote: string | null = null;
    let esc = false;
    while (i < n) {
      const ch = src[i];
      if (quote) {
        if (esc) esc = false;
        else if (ch === "\\") esc = true;
        else if (ch === quote) quote = null;
        if (ch === "\n") line++;
        i++;
        continue;
      }
      if (ch === '"' || ch === "'") {
        quote = ch;
        i++;
        continue;
      }
      if (ch === "#" || (ch === "/" && src[i + 1] === "/")) {
        while (i < n && src[i] !== "\n") i++;
        continue;
      }
      if (ch === "(" || ch === "[" || ch === "{") depth++;
      else if (ch === ")" || ch === "]" || ch === "}") depth = Math.max(0, depth - 1);
      else if (ch === "\n") {
        if (depth === 0 && !nextLineContinuesTernary(src, i + 1)) break;
        line++;
      }
      i++;
    }
    const text = src.slice(start, i).replace(/\s+$/, "");
    const m = /^\s*([A-Za-z_$][\w$]*)\s*=/.exec(text);
    if (m && IDENT_START.test(m[1][0])) {
      out.push({ id: m[1], text, line: startLine, endLine: line });
    }
  }
  return out;
}

function nextLineContinuesTernary(src: string, from: number): boolean {
  let j = from;
  while (j < src.length && (src[j] === " " || src[j] === "\t")) j++;
  return src[j] === "?" || src[j] === ":";
}

/** Map of statement id -> statement text (later definitions win, as in the language). */
export function statementMap(source: string | null | undefined): StatementMap {
  const map: StatementMap = new Map();
  for (const s of splitStatements(source)) map.set(s.id, s);
  return map;
}

/** Ids whose text is new or different in `next` compared to `prev`. */
export function changedStatementIds(prevSource: string | null | undefined, nextSource: string | null | undefined): string[] {
  const prev = statementMap(prevSource);
  const next = statementMap(nextSource);
  const changed: string[] = [];
  for (const [id, s] of next) {
    const before = prev.get(id);
    if (!before || normalize(before.text) !== normalize(s.text)) changed.push(id);
  }
  return changed;
}

/** Ids of statements whose text references `id` as a whole word. */
export function referencesTo(map: StatementMap, id: string): string[] {
  const re = new RegExp(`(^|[^\\w$])${escapeRe(id)}(?![\\w$])`);
  const refs: string[] = [];
  for (const [other, s] of map) {
    if (other === id) continue;
    const body = s.text.slice(s.text.indexOf("=") + 1);
    if (re.test(stripStrings(body))) refs.push(other);
  }
  return refs;
}

function stripStrings(text: string): string {
  return text.replace(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/gs, '""');
}

function normalize(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function escapeRe(s: string): string {
  return s.replace(/[$()*+.?[\\\]^{|}]/g, "\\$&");
}

/** Names of the statements `text` refers to: every identifier outside a string that is a key of `known`. */
function mentionedIds(text: string, known: ReadonlyMap<string, unknown>, self: string): string[] {
  const body = stripStrings(text.slice(text.indexOf("=") + 1));
  const out = new Set<string>();
  // No lookbehind: this module runs in the browser bundles, and older Safari cannot parse one.
  for (const m of body.matchAll(/[\w$]+/g)) if (/^[A-Za-z_$]/.test(m[0]) && m[0] !== self && known.has(m[0])) out.add(m[0]);
  return [...out];
}

/** `ids` and every statement they refer to, directly or not, in source order. */
export function closureOf(map: StatementMap, ids: Iterable<string>): string[] {
  const keep = new Set<string>();
  const todo = [...ids];
  while (todo.length) {
    const id = todo.pop() as string;
    const s = map.get(id);
    if (!s || keep.has(id)) continue;
    keep.add(id);
    todo.push(...mentionedIds(s.text, map, id));
  }
  return [...map.keys()].filter((id) => keep.has(id));
}

/**
 * Rewrite `text` (statements) with each statement name in `renames` replaced, in definitions and
 * in references alike. Strings and comments are left as they are.
 */
export function renameStatements(text: string, renames: ReadonlyMap<string, string>): string {
  if (!renames.size) return text;
  let out = "";
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < text.length && text[j] !== c) j += text[j] === "\\" ? 2 : 1;
      out += text.slice(i, j + 1);
      i = j + 1;
    } else if (c === "#" || (c === "/" && text[i + 1] === "/")) {
      const j = text.indexOf("\n", i);
      const end = j < 0 ? text.length : j;
      out += text.slice(i, end);
      i = end;
    } else if (/[A-Za-z_$]/.test(c)) {
      let j = i + 1;
      while (j < text.length && /[\w$]/.test(text[j])) j++;
      const word = text.slice(i, j);
      // A member (`.name`) and an object key (`{name:` or `, name:`) are not references to a statement.
      const before = out.trimEnd().slice(-1);
      const after = /^\s*(.)/.exec(text.slice(j))?.[1];
      const key = after === ":" && (before === "{" || before === ",");
      out += before === "." || key ? word : (renames.get(word) ?? word);
      i = j;
    } else {
      out += c;
      i++;
    }
  }
  return out;
}
