// @ts-check
// Validate an artifact without a browser: the same parser the renderer uses,
// run against the curated library's JSON schema.
import fs from "node:fs";
import { createParser } from "@openuidev/lang-core";
import { readArtifact } from "./artifact.js";
import { assetPath } from "./paths.js";
import { mergePackSchemas, packDefining, pagePacks } from "./packs.js";
import { splitStatements } from "../shared/statements.js";
import { checkProgram } from "../shared/check-program.js";

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

/**
 * @param {string} html
 * @param {{ schema?: object, file?: string }} [options]
 */
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
  const core = checkProgram(art.program, {
    parser: () => getParser(schema, packs.installed),
    lineOf: (id) => (id && lines.get(id)?.line) || undefined,
    decorate: (entry) => (entry.code === "unknown-component" ? unknownComponent(entry, packs, file) : entry),
  });
  result.statements = core.statements;
  result.errors.push(...core.errors);
  result.warnings.push(...core.warnings);
  result.ok = result.errors.length === 0;
  return result;
}
