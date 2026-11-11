// The program half of `austere-axi check`: what a parser, a program and (optionally)
// a map of statement lines say about the program. No Node APIs, so the CLI and the
// website playground (in the browser) run the very same validation.
import type { ElementNode, ParseResult } from "@openuidev/react-lang";
import { splitStatements } from "./statements.ts";
import { architectureNotes } from "../runtime/components/_architecture-model.ts";

/** An error or warning `check` reports. */
export interface CheckEntry {
  code: string;
  message: string;
  statement?: string;
  statements?: string[];
  line?: number;
  component?: string;
  path?: string;
}

export interface CheckResult {
  statements: number;
  errors: CheckEntry[];
  warnings: CheckEntry[];
}

export interface CheckProgramOptions {
  /** Built lazily: building it may throw. */
  parser: () => { parse(program: string): ParseResult };
  /** Line of a statement, where the caller has one. */
  lineOf?: (id: string | undefined) => number | undefined;
  /** Rewrite an error or warning before it is reported. */
  decorate?: (entry: CheckEntry) => CheckEntry;
}

/** Every rendered element of a component, found by walking from the root. */
function elementsOf(root: unknown, typeName: string): ElementNode[] {
  const out: ElementNode[] = [];
  const seen = new Set<object>();
  const stack: unknown[] = [root];
  while (stack.length) {
    const v = stack.pop();
    if (!v || typeof v !== "object" || seen.has(v)) continue;
    seen.add(v);
    const node: { typeName?: unknown; props?: unknown } = v;
    // Anything with this typeName and props is a parsed element.
    if (node.typeName === typeName && node.props) out.push(node as ElementNode);
    for (const child of Array.isArray(v) ? v : Object.values(node.props || {})) stack.push(child);
  }
  return out;
}

/** `program` is OpenUI Lang source. */
export function checkProgram(program: string, { parser, lineOf = () => undefined, decorate = (entry) => entry }: CheckProgramOptions): CheckResult {
  const errors: CheckEntry[] = [];
  const warnings: CheckEntry[] = [];
  let parsed: ParseResult;
  try {
    parsed = parser().parse(program);
  } catch (err) {
    errors.push({ code: "parse-failed", message: String((err && typeof err === "object" && "message" in err ? err.message : undefined) || err) });
    return { statements: 0, errors, warnings };
  }
  // The parser reports a bad statement once per reference to it; say it once.
  const seen = new Set<string>();
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
  const diagrams = new Set<string | undefined>();
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
  const dupes = new Map<string, number>();
  for (const s of splitStatements(program)) dupes.set(s.id, (dupes.get(s.id) || 0) + 1);
  for (const [id, n] of dupes) {
    if (n > 1) warnings.push({ code: "duplicate", statement: id, message: `${id} is defined ${n} times; the last one wins.` });
  }
  return { statements: parsed.meta.statementCount, errors, warnings };
}
