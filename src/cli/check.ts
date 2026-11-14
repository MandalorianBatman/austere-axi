// Validate an artifact without a browser: the same parser the renderer uses,
// run against the curated library's JSON schema.
import fs from "node:fs";
import { createParser } from "@openuidev/lang-core";
import type { Parser } from "@openuidev/lang-core";
import { hasInlineRuntime, readArtifact } from "./artifact.ts";
import { assetPath } from "./paths.ts";
import { mergePackSchemas, packDefining, pagePacks } from "./packs.ts";
import type { InstalledPack, PagePacks, SpecSchema } from "./packs.ts";
import { splitStatements } from "../shared/statements.ts";
import { checkProgram } from "../shared/check-program.ts";
import type { CheckEntry } from "../shared/check-program.ts";

export interface CheckResult {
  ok: boolean;
  errors: CheckEntry[];
  warnings: CheckEntry[];
  statements: number;
  title: string;
}

export interface CheckOptions {
  schema?: SpecSchema;
  file?: string;
}

let coreSpec: SpecSchema | null = null;
const packParsers = new Map<string, Parser>();
const customParsers = new WeakMap<SpecSchema, Parser>();

/**
 * Parser for the shipped spec extended with the page's installed packs, or
 * for a given library schema (tests, maintainer scripts).
 */
function getParser(schema: SpecSchema | undefined, packs: InstalledPack[] = []): Parser {
  if (schema) {
    let custom = customParsers.get(schema);
    if (!custom) customParsers.set(schema, (custom = createParser(schema, schema.root || "Stack")));
    return custom;
  }
  const key = packs.map((p) => `${p.name}@${p.version}:${p.integrity || ""}`).join(",");
  let parser = packParsers.get(key);
  if (!parser) {
    const core: SpecSchema = (coreSpec ||= JSON.parse(fs.readFileSync(assetPath("spec.json"), "utf8")));
    const spec = mergePackSchemas(core, packs.map((p) => p.catalog));
    packParsers.set(key, (parser = createParser(spec, spec.root || "Stack")));
  }
  return parser;
}

/** Components austere-axi used to have: an old page names them, so say what replaced them. */
const REMOVED: Record<string, string> = {
  Mermaid: "Mermaid was removed from austere-axi. Draw the diagram with Architecture, or show the source as text in a CodeBlock.",
};

/** The parser lists every component on an unknown name; say where to look instead. */
function unknownComponent(entry: CheckEntry, packs: PagePacks, file: string): CheckEntry {
  const name = entry.component;
  const from = name && packDefining(name);
  if (from) {
    return {
      ...entry,
      code: "missing-pack",
      message: `${name} comes from pack ${from.name}@${from.version}, which this page does not declare. \`austere-axi check --fix ${file}\` adds it.`,
    };
  }
  const removed = name && REMOVED[name];
  if (removed) return { ...entry, message: removed };
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
export function statementLines(html: string): Map<string, { line: number; text: string }> {
  const art = readArtifact(html);
  const out = new Map<string, { line: number; text: string }>();
  if (art.program == null) return out;
  for (const s of splitStatements(art.program)) out.set(s.id, { line: art.programLine + s.line - 1, text: s.text });
  return out;
}

export function checkHtml(html: string, { schema, file = "<file>" }: CheckOptions = {}): CheckResult {
  const art = readArtifact(html);
  const packs: PagePacks = schema ? { installed: [], missing: [], mismatched: [], stale: [], declared: [], thirdParty: [] } : pagePacks(html);
  const result: CheckResult = { ok: true, errors: [], warnings: [], statements: 0, title: art.title };
  if (art.program == null) {
    result.ok = false;
    result.errors.push({
      code: "no-program",
      message: 'No <script type="text/openui"> block found. Put the OpenUI Lang program inside one (see `austere-axi --help`).',
    });
    return result;
  }
  if (hasInlineRuntime(html)) {
    result.warnings.push({
      code: "exported-copy",
      message: `This is an exported copy (runtime inlined, ${(html.length / 1024 / 1024).toFixed(1)} MB). Review and patch the source page instead, then export it again.`,
    });
  } else if (!art.runtimeSrc) {
    result.warnings.push({
      code: "no-runtime-tag",
      message: "No austere.js runtime <script> tag. Review still works, but the file will not render when opened directly.",
    });
  }
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
