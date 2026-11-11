// @ts-check
// The program half of `austere-axi check`: what a parser, a program and (optionally)
// a map of statement lines say about the program. No Node APIs, so the CLI and the
// website playground (in the browser) run the very same validation.
import { splitStatements } from "./statements.js";
import { architectureNotes } from "../runtime/components/_architecture-model.js";

/** Every rendered element of a component, found by walking from the root. */
function elementsOf(root, typeName) {
  const out = [];
  const seen = new Set();
  const stack = [root];
  while (stack.length) {
    const v = stack.pop();
    if (!v || typeof v !== "object" || seen.has(v)) continue;
    seen.add(v);
    if (v.typeName === typeName && v.props) out.push(v);
    for (const child of Array.isArray(v) ? v : Object.values(v.props || {})) stack.push(child);
  }
  return out;
}

/**
 * @param {string} program OpenUI Lang source
 * @param {object} options
 * @param {() => { parse(program: string): any }} options.parser built lazily: building it may throw
 * @param {(id: string) => number|undefined} [options.lineOf] line of a statement, where the caller has one
 * @param {(entry: any) => any} [options.decorate] rewrite an error or warning before it is reported
 * @returns {{ statements: number, errors: any[], warnings: any[] }}
 */
export function checkProgram(program, { parser, lineOf = () => undefined, decorate = (entry) => entry }) {
  const errors = [];
  const warnings = [];
  let parsed;
  try {
    parsed = parser().parse(program);
  } catch (err) {
    errors.push({ code: "parse-failed", message: String(/** @type {any} */ (err)?.message || err) });
    return { statements: 0, errors, warnings };
  }
  // The parser reports a bad statement once per reference to it; say it once.
  const seen = new Set();
  for (const e of parsed.meta.errors) {
    const key = `${e.severity}\0${e.code}\0${e.statementId}\0${e.message}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const entry = decorate({
      code: e.code,
      statement: e.statementId,
      line: lineOf(e.statementId),
      component: e.component || undefined,
      path: e.path || undefined,
      message: e.message,
    });
    if (e.severity === "warning") warnings.push(entry);
    else errors.push(entry);
  }
  if (!parsed.root) {
    errors.push({
      code: "no-root",
      message: "Nothing to render: define root = Stack([...]) and reference every section from it.",
    });
  }
  for (const id of parsed.meta.unresolved) {
    errors.push({ code: "unresolved", statement: id, message: `${id} is referenced but never defined, so it renders as nothing.` });
  }
  if (parsed.root && parsed.meta.orphaned.length) {
    const ids = parsed.meta.orphaned;
    warnings.push({
      code: "orphaned",
      statements: ids,
      message: `Defined but not reachable from root, so not rendered: ${ids.join(", ")}. Reference them from a parent or delete them.`,
    });
  }
  if (parsed.meta.incomplete) {
    errors.push({ code: "incomplete", message: "The program ends mid-statement (an unclosed string or bracket)." });
  }
  // Diagrams: what the layout will do, which the parser cannot see.
  const diagrams = new Set();
  for (const el of elementsOf(parsed.root, "Architecture")) {
    // A diagram shown in two places is one statement: warn once.
    if (el.statementId && diagrams.has(el.statementId)) continue;
    diagrams.add(el.statementId);
    try {
      for (const note of architectureNotes(el.props)) {
        warnings.push({ code: note.code, statement: el.statementId, line: lineOf(el.statementId), message: note.message });
      }
    } catch {
      // A layout bug must never fail check; the page reports it when it renders.
    }
  }
  const dupes = new Map();
  for (const s of splitStatements(program)) dupes.set(s.id, (dupes.get(s.id) || 0) + 1);
  for (const [id, n] of dupes) {
    if (n > 1) warnings.push({ code: "duplicate", statement: id, message: `${id} is defined ${n} times; the last one wins.` });
  }
  return { statements: parsed.meta.statementCount, errors, warnings };
}
