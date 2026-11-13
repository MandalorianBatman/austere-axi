// `austere-axi components ...`: browse the component catalog (core, bundled
// packs, installed packs, packs on npm) and manage packs.
import type { CatalogEntry } from "../../types/catalog.d.ts";
import { coreCatalog, installedPacks, isThirdParty } from "./packs.ts";
import { remotePacks } from "./remote-packs.ts";
import type { RemotePack, RemotePacks } from "./remote-packs.ts";
import { searchCatalog } from "../shared/catalog.ts";

const BIN = "austere-axi";

/** A catalog entry with where it comes from: core, a bundled pack (part of core), an installed pack, or a pack on npm that is not installed. */
export type ComponentEntry = CatalogEntry &
  ({ source: "core" } | { source: "bundled" } | { source: "installed"; version: string } | { source: "remote"; version: string; trust: RemotePack["trust"] });

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
  remote?: string;
  next?: string;
  status?: "error";
}

/** Every component an agent can use here: core (with bundled packs) first, then installed packs, then the packs on npm given. */
export function catalogEntries(remote: RemotePack[] = []): ComponentCatalog {
  const core = coreCatalog();
  const out = core.components.map((c): ComponentEntry => ({ ...c, source: c.pack === "core" ? "core" : "bundled" }));
  const notes = new Map(core.groups.map((g) => [`core\0${g.name}`, g.notes]));
  for (const p of installedPacks()) {
    for (const g of p.catalog.groups || []) notes.set(`${p.name}\0${g.name}`, g.notes);
    for (const c of p.catalog.components) out.push({ ...c, pack: p.name, version: p.version, source: "installed" });
  }
  for (const p of remote) {
    for (const g of p.catalog.groups || []) notes.set(`${p.name}\0${g.name}`, g.notes);
    for (const c of p.catalog.components) out.push({ ...c, pack: p.name, version: p.version, source: "remote", trust: p.trust });
  }
  const notesOf = (e: ComponentEntry): string[] => notes.get(`${e.source === "installed" || e.source === "remote" ? e.pack : "core"}\0${e.group}`) || [];
  return { entries: out, notesOf, groups: core.groups.map((g) => g.name) };
}

function where(e: ComponentEntry): string {
  if (e.source === "core") return e.tier === "extended" ? "core, not in spec" : "core";
  if (e.source === "bundled") return "core";
  if (e.source === "remote") return `npm ${e.pack}@${e.version}, not installed, ${e.trust}`;
  return `pack ${e.pack}@${e.version}`;
}

/** How to get a pack on npm: an agent installs a first-party one; the user vets and installs a third-party one. */
function howToGet(e: ComponentEntry & { source: "remote" }): string {
  return e.trust === "first-party"
    ? `${e.pack} is not installed: \`${BIN} components add ${e.pack}\`.`
    : `${e.pack} is third-party and not installed: ask the user to review its source (npm view ${e.pack} repository) and run \`${BIN} components add ${e.pack} --trust\`.`;
}

const remoteNote = (r: RemotePacks): string | undefined => (r.unavailable ? `unavailable, local components only (${r.unavailable})` : undefined);

export function listComponents(filter: string | undefined): ComponentList | CommandError {
  const { entries, groups } = catalogEntries();
  const f = filter ? String(filter).toLowerCase() : null;
  const out: ComponentList = {};
  const core = entries.filter((e) => e.source === "core" || e.source === "bundled");
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

type SearchResult =
  | CommandError
  | { status: "no matches"; query: string; remote?: string; next: string }
  | { query: string; results: string[]; remote?: string; next: string };

export async function searchComponents(words: string[]): Promise<SearchResult> {
  const query = words.join(" ").trim();
  if (!query) return { status: "error", error: `search needs words: ${BIN} components search gantt timeline` };
  const remote = await remotePacks();
  const { entries, notesOf } = catalogEntries(remote.packs);
  const hits = searchCatalog(entries, query, { notesOf, limit: 8 }).map((h) => h.entry);
  if (!hits.length) {
    return {
      status: "no matches",
      query,
      remote: remoteNote(remote),
      next: `Try other words, \`${BIN} components list\`, or build it from Card/Stack/Table/Architecture. Packs: \`${BIN} components add <npm-package>\`.`,
    };
  }
  const next = [`\`${BIN} components show <Name>\` for examples.`];
  if (hits.some((e) => e.source === "installed")) next.push(`Pack components need the page to declare their pack: \`${BIN} check --fix <file>\` adds it.`);
  const seen = new Set<string>();
  for (const e of hits) {
    if (e.source !== "remote" || seen.has(e.pack)) continue;
    seen.add(e.pack);
    next.push(howToGet(e));
  }
  return {
    query,
    results: hits.map((e) => `${e.signature} — ${short(e.description)} [${e.group}; ${where(e)}]`),
    remote: remoteNote(remote),
    next: next.join(" "),
  };
}

export async function showComponents(names: string[]): Promise<ComponentShow | CommandError> {
  if (!names.length) return { status: "error", error: `show needs a name: ${BIN} components show Gantt` };
  const lookup = (entries: ComponentEntry[], n: string) => entries.find((x) => x.name === n) || entries.find((x) => x.name.toLowerCase() === n.toLowerCase());
  let catalog = catalogEntries();
  let remote: RemotePacks | undefined;
  if (names.some((n) => !lookup(catalog.entries, n))) {
    remote = await remotePacks();
    catalog = catalogEntries(remote.packs);
  }
  const { entries, notesOf } = catalog;
  const found: ComponentEntry[] = [];
  const missing: string[] = [];
  for (const n of names) {
    const e = lookup(entries, n);
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
      if (e.source === "remote") o.use = howToGet(e);
      return o;
    }),
  };
  if (missing.length) {
    out.unknown = missing;
    if (remote) out.remote = remoteNote(remote);
    out.next = `\`${BIN} components search ${missing[0].toLowerCase()}\``;
  }
  if (!found.length) out.status = "error";
  return out;
}
