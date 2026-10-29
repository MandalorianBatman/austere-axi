// Validate an artifact without a browser: the same parser the renderer uses,
// run against the curated library's JSON schema.
import fs from "node:fs";
import { createParser } from "@openuidev/lang-core";
import { readArtifact } from "./artifact.js";
import { assetPath } from "./paths.js";
import { mergePackSchemas, packDefining, pagePacks } from "./packs.js";
import { splitStatements } from "../shared/statements.js";
import { architectureNotes } from "../runtime/components/_architecture-model.js";

let coreSpec = null;
const packParsers = new Map();
const customParsers = new WeakMap();

/**
 * Parser for the shipped spec extended with the page's installed packs, or
 * for a given library schema (tests, maintainer scripts).
 */
function getParser(schema, packs = []) {
  if (schema) {
    if (!customParsers.has(schema)) customParsers.set(schema, createParser(schema, schema.root || "Stack"));
    return customParsers.get(schema);
  }
  const key = packs.map((p) => `${p.name}@${p.version}:${p.integrity || ""}`).join(",");
  if (!packParsers.has(key)) {
    coreSpec ||= JSON.parse(fs.readFileSync(assetPath("spec.json"), "utf8"));
    const spec = mergePackSchemas(coreSpec, packs.map((p) => p.catalog));
    packParsers.set(key, createParser(spec, spec.root || "Stack"));
  }
  return packParsers.get(key);
}

/** The parser lists every component on an unknown name; say where to look instead. */
function unknownComponent(entry, packs, file) {
  const name = entry.component;
  const from = name && packDefining(name);
  if (from) {
    return {
      ...entry,
      code: "missing-pack",
      message: `${name} comes from pack ${from.name}@${from.version}, which this page does not declare. \`austere-axi check --fix ${file}\` adds it.`,
    };
  }
  const unseen = [...packs.missing, ...packs.mismatched];
  if (unseen.length) {
    return {
      ...entry,
      message: `Unknown component "${name}" (not core; the page's pack ${unseen.map((p) => `${p.name}@${p.version}`).join(", ")} is not installed here, so check cannot see its components).`,
    };
  }
  return {
    ...entry,
    message: `Unknown component "${name}". Find the right one: \`austere-axi components search ${String(name || "").toLowerCase()}\`.`,
  };
}

/** Map statement id -> 1-based line in the HTML file. */
export function statementLines(html) {
  const art = readArtifact(html);
  const out = new Map();
  if (art.program == null) return out;
  for (const s of splitStatements(art.program)) out.set(s.id, { line: art.programLine + s.line - 1, text: s.text });
  return out;
}

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

export function checkHtml(html, { schema, file = "<file>" } = {}) {
  const art = readArtifact(html);
  const packs = schema ? { installed: [], missing: [], mismatched: [], stale: [], declared: [] } : pagePacks(html);
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
  for (const p of packs.missing) {
    result.warnings.push({
      code: "pack-not-installed",
      message: `The page declares pack ${p.name}@${p.version}, which is not installed here; its components cannot be checked. \`austere-axi components add ${p.name}@${p.version}\` installs it.`,
    });
  }
  for (const p of packs.stale || []) {
    result.warnings.push({
      code: "pack-integrity",
      message: `The page pins ${p.name}@${p.version} to another build than the one installed (rebuilt and added again?), so the review page will refuse to load it. \`austere-axi check --fix ${file}\` updates the hash.`,
    });
  }
  for (const p of packs.mismatched) {
    result.warnings.push({
      code: "pack-version",
      message: `The page declares ${p.name}@${p.version} but ${p.installedVersion} is installed; check skipped its components. \`austere-axi check --fix ${file}\` switches the page to ${p.installedVersion}.`,
    });
  }
  const lines = statementLines(html);
  const lineOf = (id) => (id && lines.get(id)?.line) || undefined;

  let parsed;
  try {
    parsed = getParser(schema, packs.installed).parse(art.program);
  } catch (err) {
    result.ok = false;
    result.errors.push({ code: "parse-failed", message: String(err?.message || err) });
    return result;
  }
  result.statements = parsed.meta.statementCount;
  // The parser reports a bad statement once per reference to it; say it once.
  const seen = new Set();
  for (const e of parsed.meta.errors) {
    const key = `${e.severity}\0${e.code}\0${e.statementId}\0${e.message}`;
    if (seen.has(key)) continue;
    seen.add(key);
    let entry = {
      code: e.code,
      statement: e.statementId,
      line: lineOf(e.statementId),
      component: e.component || undefined,
      path: e.path || undefined,
      message: e.message,
    };
    if (e.code === "unknown-component") entry = unknownComponent(entry, packs, file);
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
  // Diagrams: what the layout will do, which the parser cannot see.
  const diagrams = new Set();
  for (const el of elementsOf(parsed.root, "Architecture")) {
    // A diagram shown in two places is one statement: warn once.
    if (el.statementId && diagrams.has(el.statementId)) continue;
    diagrams.add(el.statementId);
    try {
      for (const note of architectureNotes(el.props)) {
        result.warnings.push({ code: note.code, statement: el.statementId, line: lineOf(el.statementId), message: note.message });
      }
    } catch {
      // A layout bug must never fail check; the page reports it when it renders.
    }
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
