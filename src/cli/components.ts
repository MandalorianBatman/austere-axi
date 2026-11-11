// `austere-axi components ...`: browse the component catalog (core, bundled
// packs, installed packs) and manage packs.
import type { CatalogEntry } from "../../types/catalog.d.ts";
import { coreCatalog, installedPacks, isThirdParty } from "./packs.ts";
import { searchCatalog } from "../shared/catalog.ts";

const BIN = "austere-axi";

/** A catalog entry with where it comes from: core, a bundled pack (part of core), or an installed pack. */
export type ComponentEntry = CatalogEntry & { source: "core" | "bundled" | "installed"; version?: string };

export interface ComponentCatalog {
  entries: ComponentEntry[];
  notesOf: (e: ComponentEntry) => string[];
  groups: string[];
}

/** An error the CLI prints as is (exit 1). */
export interface CommandError {
  status: "error";
  error: string;
}

export interface ComponentList {
  status?: undefined;
  core?: Record<string, string>;
  extended?: Record<string, string>;
  packs?: { pack: string; trust: "third-party" | undefined; components: string }[];
  next?: string;
}

export interface ShownComponent {
  name: string;
  signature: string;
  description: string;
  group: string;
  from: string;
  notes?: string[];
  example?: string;
  use?: string;
}

export interface ComponentShow {
  components: ShownComponent[];
  unknown?: string[];
  next?: string;
  status?: "error";
}

/** Every component an agent can use here: core (with bundled packs) first, then installed packs. */
export function catalogEntries(): ComponentCatalog {
  const core = coreCatalog();
  const out = core.components.map((c): ComponentEntry => ({ ...c, source: c.pack === "core" ? "core" : "bundled" }));
  const notes = new Map(core.groups.map((g) => [`core\0${g.name}`, g.notes]));
  for (const p of installedPacks()) {
    for (const g of p.catalog.groups || []) notes.set(`${p.name}\0${g.name}`, g.notes);
    for (const c of p.catalog.components) out.push({ ...c, pack: p.name, version: p.version, source: "installed" });
  }
  const notesOf = (e: ComponentEntry): string[] => notes.get(`${e.source === "installed" ? e.pack : "core"}\0${e.group}`) || [];
  return { entries: out, notesOf, groups: core.groups.map((g) => g.name) };
}

function where(e: ComponentEntry): string {
  if (e.source === "core") return e.tier === "extended" ? "core, not in spec" : "core";
  if (e.source === "bundled") return "core";
  return `pack ${e.pack}@${e.version}`;
}

export function listComponents(filter: string | undefined): ComponentList | CommandError {
  const { entries, groups } = catalogEntries();
  const f = filter ? String(filter).toLowerCase() : null;
  const out: ComponentList = {};
  const core = entries.filter((e) => e.source !== "installed");
  const groupNames = [...groups, ...new Set(core.map((e) => e.group).filter((g) => !groups.includes(g)))];
  const coreOut: Record<string, string> = {};
  const extended: Record<string, string> = {};
  for (const g of groupNames) {
    if (f && f !== "core" && g.toLowerCase() !== f) continue;
    const inGroup = core.filter((e) => e.group === g);
    const main = inGroup.filter((e) => e.tier !== "extended").map((e) => e.name);
    const more = inGroup.filter((e) => e.tier === "extended").map((e) => e.name);
    if (main.length) coreOut[g] = main.join(", ");
    if (more.length) extended[g] = more.join(", ");
  }
  if (Object.keys(coreOut).length) out.core = coreOut;
  // Core components the spec leaves out to save tokens: still usable, signatures via `show`.
  if (Object.keys(extended).length) out.extended = extended;
  const packs = installedPacks().filter((p) => !f || f === p.name.toLowerCase() || p.catalog.components.some((c) => c.group.toLowerCase() === f));
  if (packs.length) {
    out.packs = packs.map((p) => ({
      pack: `${p.name}@${p.version}`,
      trust: isThirdParty(p.name, p) ? "third-party" : undefined,
      components: p.catalog.components.map((c) => c.name).join(", "),
    }));
  }
  if (!Object.keys(out).length) return { status: "error", error: `nothing matches ${filter}; groups: ${groups.join(" ")}` };
  out.next = `\`${BIN} components show <Name>\` for a signature; \`${BIN} components search <words>\` to find one.`;
  return out;
}

const short = (text: string): string => (text.length > 140 ? text.slice(0, 139).replace(/\s+\S*$/, "") + "…" : text);

export function searchComponents(words: string[]): CommandError | { status: "no matches"; query: string; next: string } | { query: string; results: string[]; next: string } {
  const query = words.join(" ").trim();
  if (!query) return { status: "error", error: `search needs words: ${BIN} components search gantt timeline` };
  const { entries, notesOf } = catalogEntries();
  const hits = searchCatalog(entries, query, { notesOf, limit: 8 });
  if (!hits.length) {
    return {
      status: "no matches",
      query,
      next: `Try other words, \`${BIN} components list\`, or build it from Card/Stack/Table/Architecture. Packs: \`${BIN} components add <npm-package>\`.`,
    };
  }
  return {
    query,
    results: hits.map(({ entry: e }) => `${e.signature} — ${short(e.description)} [${e.group}; ${where(e)}]`),
    next: hits.some(({ entry: e }) => e.source === "installed")
      ? `\`${BIN} components show <Name>\` for examples. Pack components need the page to declare their pack: \`${BIN} check --fix <file>\` adds it.`
      : `\`${BIN} components show <Name>\` for examples.`,
  };
}

export function showComponents(names: string[]): ComponentShow | CommandError {
  if (!names.length) return { status: "error", error: `show needs a name: ${BIN} components show Gantt` };
  const { entries, notesOf } = catalogEntries();
  const found: ComponentEntry[] = [];
  const missing: string[] = [];
  for (const n of names) {
    const e = entries.find((x) => x.name === n) || entries.find((x) => x.name.toLowerCase() === n.toLowerCase());
    if (!e) missing.push(n);
    else found.push(e);
  }
  const out: ComponentShow = {
    components: found.map((e) => {
      const o: ShownComponent = { name: e.name, signature: e.signature, description: e.description, group: e.group, from: where(e) };
      const notes = notesOf(e).filter((line) => new RegExp(`\\b${e.name}\\b`).test(line) && !line.startsWith("- Also in "));
      if (notes.length) o.notes = notes.map((l) => l.replace(/^- /, ""));
      if (e.examples && e.examples.length) o.example = e.examples[0];
      if (e.source === "installed") o.use = `From pack ${e.pack}: after writing the page, \`${BIN} check --fix <file>\` declares it.`;
      return o;
    }),
  };
  if (missing.length) {
    out.unknown = missing;
    out.next = `\`${BIN} components search ${missing[0].toLowerCase()}\``;
  }
  if (!found.length) out.status = "error";
  return out;
}
