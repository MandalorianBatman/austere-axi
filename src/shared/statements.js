// Splits an OpenUI Lang program into top-level statements without parsing
// expressions. Used by the runtime (change highlighting) and the CLI (line
// numbers and source excerpts for feedback). Follows the language's rules for
// what ends a statement: a newline at bracket depth zero, outside a string.
// Comments (`//` and `#` to end of line) are skipped outside strings.

const IDENT_START = /[A-Za-z_$]/;

/**
 * @param {string} source
 * @returns {{ id: string, text: string, line: number, endLine: number }[]}
 */
export function splitStatements(source) {
  const out = [];
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
    let quote = null;
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

function nextLineContinuesTernary(src, from) {
  let j = from;
  while (j < src.length && (src[j] === " " || src[j] === "\t")) j++;
  return src[j] === "?" || src[j] === ":";
}

/** Map of statement id -> statement text (later definitions win, as in the language). */
export function statementMap(source) {
  const map = new Map();
  for (const s of splitStatements(source)) map.set(s.id, s);
  return map;
}

/** Ids whose text is new or different in `next` compared to `prev`. */
export function changedStatementIds(prevSource, nextSource) {
  const prev = statementMap(prevSource);
  const next = statementMap(nextSource);
  const changed = [];
  for (const [id, s] of next) {
    const before = prev.get(id);
    if (!before || normalize(before.text) !== normalize(s.text)) changed.push(id);
  }
  return changed;
}

/** Ids of statements whose text references `id` as a whole word. */
export function referencesTo(map, id) {
  const re = new RegExp(`(^|[^\\w$])${escapeRe(id)}(?![\\w$])`);
  const refs = [];
  for (const [other, s] of map) {
    if (other === id) continue;
    const body = s.text.slice(s.text.indexOf("=") + 1);
    if (re.test(stripStrings(body))) refs.push(other);
  }
  return refs;
}

function stripStrings(text) {
  return text.replace(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/gs, '""');
}

function normalize(text) {
  return text.replace(/\s+/g, " ").trim();
}

function escapeRe(s) {
  return s.replace(/[$()*+.?[\\\]^{|}]/g, "\\$&");
}
