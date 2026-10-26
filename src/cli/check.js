// Validate an artifact without a browser: the same parser the renderer uses,
// run against the curated library's JSON schema.
import fs from "node:fs";
import { createParser } from "@openuidev/lang-core";
import { readArtifact } from "./artifact.js";
import { assetPath } from "./paths.js";
import { splitStatements } from "../shared/statements.js";

let parser = null;
const customParsers = new WeakMap();

/** Parser for the shipped spec, or for a given library schema (tests, maintainer scripts). */
function getParser(schema) {
  if (schema) {
    if (!customParsers.has(schema)) customParsers.set(schema, createParser(schema, schema.root || "Stack"));
    return customParsers.get(schema);
  }
  if (!parser) {
    const spec = JSON.parse(fs.readFileSync(assetPath("spec.json"), "utf8"));
    parser = createParser(spec, spec.root || "Stack");
  }
  return parser;
}

/** Map statement id -> 1-based line in the HTML file. */
export function statementLines(html) {
  const art = readArtifact(html);
  const out = new Map();
  if (art.program == null) return out;
  for (const s of splitStatements(art.program)) out.set(s.id, { line: art.programLine + s.line - 1, text: s.text });
  return out;
}

export function checkHtml(html, { schema } = {}) {
  const art = readArtifact(html);
  const result = { ok: true, errors: [], warnings: [], statements: 0, title: art.title, hasMermaid: false };
  if (art.program == null) {
    result.ok = false;
    result.errors.push({
      code: "no-program",
      message: 'No <script type="text/openui"> block found. Put the OpenUI Lang program inside one (see `austere-axi --help`).',
    });
    return result;
  }
  if (!art.runtimeSrc) {
    result.warnings.push({
      code: "no-runtime-tag",
      message: "No austere.js runtime <script> tag. Review still works, but the file will not render when opened directly.",
    });
  }
  result.hasMermaid = /\bMermaid\s*\(/.test(art.program);
  const lines = statementLines(html);
  const lineOf = (id) => (id && lines.get(id)?.line) || undefined;

  let parsed;
  try {
    parsed = getParser(schema).parse(art.program);
  } catch (err) {
    result.ok = false;
    result.errors.push({ code: "parse-failed", message: String(err?.message || err) });
    return result;
  }
  result.statements = parsed.meta.statementCount;
  for (const e of parsed.meta.errors) {
    const entry = {
      code: e.code,
      statement: e.statementId,
      line: lineOf(e.statementId),
      component: e.component || undefined,
      path: e.path || undefined,
      message: e.message,
    };
    if (e.severity === "warning") result.warnings.push(entry);
    else result.errors.push(entry);
  }
  if (!parsed.root) {
    result.errors.push({
      code: "no-root",
      message: "Nothing to render: define root = Stack([...]) and reference every section from it.",
    });
  }
  for (const id of parsed.meta.unresolved) {
    result.errors.push({ code: "unresolved", statement: id, message: `${id} is referenced but never defined, so it renders as nothing.` });
  }
  if (parsed.root && parsed.meta.orphaned.length) {
    const ids = parsed.meta.orphaned;
    result.warnings.push({
      code: "orphaned",
      statements: ids,
      message: `Defined but not reachable from root, so not rendered: ${ids.join(", ")}. Reference them from a parent or delete them.`,
    });
  }
  if (parsed.meta.incomplete) {
    result.errors.push({ code: "incomplete", message: "The program ends mid-statement (an unclosed string or bracket)." });
  }
  const dupes = new Map();
  for (const s of splitStatements(art.program)) dupes.set(s.id, (dupes.get(s.id) || 0) + 1);
  for (const [id, n] of dupes) {
    if (n > 1) {
      result.warnings.push({ code: "duplicate", statement: id, message: `${id} is defined ${n} times; the last one wins.` });
    }
  }
  result.ok = result.errors.length === 0;
  return result;
}
