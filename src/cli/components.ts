// `austere-axi components ...`: browse the component catalog (core, bundled
// packs, installed packs, packs on npm) and manage packs.
import type { CatalogEntry } from "../../types/catalog.d.ts";
import { coreCatalog, installedPacks, isThirdParty } from "./packs.ts";
import { remotePacks } from "./remote-packs.ts";
import type { RemotePack, RemotePacks } from "./remote-packs.ts";
import { npmView } from "./registries.ts";
import { inChooser, searchCatalog, purposeOf } from "../shared/catalog.ts";

const BIN = "austere-axi";

/** A catalog entry with where it comes from: core, a bundled pack (part of core), an installed pack, or a pack on npm that is not installed. */
export type ComponentEntry = CatalogEntry &
  (
    | { source: "core" }
    | { source: "bundled" }
    | { source: "installed"; version: string }
    | {
        source: "remote";
        version: string;
        trust: RemotePack["trust"];
        registry: RemotePack["registry"];
      }
  );

export interface ComponentCatalog {
  entries: ComponentEntry[];
  notesOf: (e: ComponentEntry) => string[];
  groups: string[];
  /** Group → the order of its chooser families (core groups only). */
  families: Record<string, string[]>;
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

/** `components list <Group>`: one "use for" line for each container and recipe, by family where the group has them. */
export interface ComponentChooser {
  status?: undefined;
  group: string;
  choose: string[] | Record<string, string[]>;
  next: string;
}

export interface ShownComponent {
  name: string;
  /** Absent for a recipe. */
  signature?: string;
  /** A recipe's components: what the page writes. */
  recipe?: string;
  description: string;
  group: string;
  from: string;
  /** Signatures of the value-only parts its props name. */
  parts?: string[];
  /** Where it may sit, or which components take it (a value-only part). */
  sits?: string;
  notes?: string[];
  guide?: string;
  examples?: string[];
  use?: string;
}

export interface ComponentShow {
  components: ShownComponent[];
  unknown?: string[];
  remote?: string;
  next?: string;
  status?: "error";
}

/** A pack component with the fields a hand-written catalog may leave out (parseCatalog allows that) filled in, and a CRLF guide read as LF. */
const filled = <C extends CatalogEntry>(c: C): C => ({
  ...c,
  description: c.description ?? "",
  examples: c.examples ?? [],
  ...(typeof c.guide === "string" ? { guide: c.guide.replace(/\r\n?/g, "\n") } : {}),
});

/** Every component an agent can use here: core (with bundled packs) first, then installed packs, then the packs on npm given. */
export function catalogEntries(remote: RemotePack[] = []): ComponentCatalog {
  const core = coreCatalog();
  const out = core.components.map((c): ComponentEntry => ({
    ...c,
    source: c.pack === "core" ? "core" : "bundled",
  }));
  const notes = new Map(core.groups.map((g) => [`core\0${g.name}`, g.notes]));
  for (const p of installedPacks()) {
    for (const g of p.catalog.groups || []) notes.set(`${p.name}\0${g.name}`, g.notes);
    for (const c of p.catalog.components)
      out.push({ ...filled(c), pack: p.name, version: p.version, source: "installed" });
  }
  for (const p of remote) {
    for (const g of p.catalog.groups || []) notes.set(`${p.name}\0${g.name}`, g.notes);
    for (const c of p.catalog.components)
      out.push({
        ...filled(c),
        pack: p.name,
        version: p.version,
        source: "remote",
        trust: p.trust,
        registry: p.registry,
      });
  }
  const notesOf = (e: ComponentEntry): string[] =>
    notes.get(
      `${e.source === "installed" || e.source === "remote" ? e.pack : "core"}\0${e.group}`,
    ) || [];
  return {
    entries: out,
    notesOf,
    groups: core.groups.map((g) => g.name),
    families: Object.fromEntries(core.groups.map((g) => [g.name, g.families || []])),
  };
}

function where(e: ComponentEntry): string {
  if (e.uses)
    return e.source === "core" || e.source === "bundled"
      ? "core recipe"
      : `recipe from pack ${e.pack}`;
  if (e.source === "core") return e.tier === "extended" ? "core, not in spec" : "core";
  if (e.source === "bundled") return "core";
  if (e.source === "remote")
    return `npm ${e.pack}@${e.version}${e.registry.scope ? ` (${new URL(e.registry.url).host})` : ""}, not installed, ${e.trust}`;
  return `pack ${e.pack}@${e.version}`;
}

/** How to get a pack on npm: an agent installs a first-party one or one on the user's trust list; the user vets and installs a third-party one. */
function howToGet(e: ComponentEntry & { source: "remote" }): string {
  if (e.trust === "first-party")
    return `${e.pack} is not installed: \`${BIN} components add ${e.pack}\`.`;
  if (e.trust === "trusted")
    return `${e.pack} is on the user's trust list and not installed: you may run \`${BIN} components add ${e.pack}@${e.version}\`.`;
  return `${e.pack} is third-party and not installed: ask the user to review its source (${npmView(e.pack, e.registry)}) and run \`${BIN} components add ${e.pack} --trust\`.`;
}

/** A chooser line: the name (with what a recipe writes, or the pack it needs), then what it is for. */
function chooserLine(e: ComponentEntry): string {
  const tag = e.uses
    ? ` (recipe: ${e.uses[0]})`
    : e.source === "installed"
      ? ` (pack ${e.pack})`
      : "";
  return `${e.name}${tag}: ${clip(purposeOf(e), 160)}`;
}

/** `components list <group>`: the containers and recipes in (or also in) the group, by family where the group orders families. */
function chooser(group: string, entries: ComponentEntry[], order: string[]): ComponentChooser {
  const picked = entries.filter((e) => e.source !== "remote" && inChooser(e, group));
  const next = `\`${BIN} components show <Name>\` for the signature, usage guide and examples.`;
  if (!order.length) return { group, choose: picked.map(chooserLine), next };
  const families = [
    ...order,
    ...picked.map((e) => e.family || "Other").filter((f) => !order.includes(f)),
  ];
  const choose: Record<string, string[]> = {};
  for (const f of new Set(families)) {
    const lines = picked.filter((e) => (e.family || "Other") === f).map(chooserLine);
    if (lines.length) choose[f] = lines;
  }
  return { group, choose, next };
}

export function listComponents(
  filter: string | undefined,
): ComponentList | ComponentChooser | CommandError {
  const { entries, groups, families } = catalogEntries();
  const f = filter ? String(filter).toLowerCase() : null;
  // A group (core, or a pack's own category) gets the chooser; "core" and pack names get the name lists.
  if (f && f !== "core" && !installedPacks().some((p) => p.name.toLowerCase() === f)) {
    const group = entries.find((e) => e.source !== "remote" && e.group.toLowerCase() === f)?.group;
    if (group) return chooser(group, entries, families[group] || []);
  }
  const out: ComponentList = {};
  const core = entries.filter((e) => e.source === "core" || e.source === "bundled");
  const groupNames = [
    ...groups,
    ...new Set(core.map((e) => e.group).filter((g) => !groups.includes(g))),
  ];
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
  const packs = installedPacks().filter(
    (p) =>
      !f ||
      f === p.name.toLowerCase() ||
      p.catalog.components.some((c) => c.group.toLowerCase() === f),
  );
  if (packs.length) {
    out.packs = packs.map((p) => ({
      pack: `${p.name}@${p.version}`,
      trust: isThirdParty(p.name, p) ? "third-party" : undefined,
      components: p.catalog.components.map((c) => c.name).join(", "),
    }));
  }
  if (!Object.keys(out).length)
    return { status: "error", error: `nothing matches ${filter}; groups: ${groups.join(" ")}` };
  out.next = `\`${BIN} components show <Name>\` for a signature; \`${BIN} components search <words>\` to find one.`;
  return out;
}

/** `text` cut to `max` characters at a word boundary. */
const clip = (text: string, max: number): string =>
  text.length > max ? text.slice(0, max - 1).replace(/\s+\S*$/, "") + "…" : text;

type SearchResult =
  | CommandError
  | { status: "no matches"; query: string; remote?: string; next: string }
  | { query: string; results?: string[]; npm?: string[]; remote?: string; next: string };

export async function searchComponents(words: string[], group?: string): Promise<SearchResult> {
  const query = words.join(" ").trim();
  if (!query)
    return {
      status: "error",
      error: `search needs words: ${BIN} components search gantt timeline`,
    };
  const remote = await remotePacks();
  const catalog = catalogEntries(remote.packs);
  const { notesOf } = catalog;
  let entries = catalog.entries;
  if (group) {
    const g = group.toLowerCase();
    entries = entries.filter(
      (e) => e.group.toLowerCase() === g || !!e.alsoIn?.some((x) => x.toLowerCase() === g),
    );
    if (!entries.length)
      return {
        status: "error",
        error: `no group ${group}; groups: ${catalog.groups.join(" ")}`,
      };
  }
  // Packs on npm are ranked apart and capped, so third-party text can never push core and installed components out.
  const local = searchCatalog(
    entries.filter((e) => e.source !== "remote"),
    query,
    { notesOf, limit: 8 },
  ).map((h) => h.entry);
  const npm = searchCatalog(
    entries.filter((e) => e.source === "remote"),
    query,
    { notesOf, limit: 3 },
  ).map((h) => h.entry);
  if (!local.length && !npm.length) {
    return {
      status: "no matches",
      query,
      remote: remote.note,
      next: `Try other words, \`${BIN} components list\`, or build it from Card/Stack/Table/Architecture. Packs: \`${BIN} components add <npm-package>\`.`,
    };
  }
  const next = [`\`${BIN} components show <Name>\` for examples.`];
  // `show <Name>` returns the first entry by that name, so a pack on npm sharing it with another result or a local component needs --pack.
  // From every entry, not just the --group ones: `show` looks the name up in all of them.
  const localNames = new Set(
    catalog.entries.filter((e) => e.source !== "remote").map((e) => e.name),
  );
  const listed = [...local, ...npm].map((e) => e.name);
  for (const e of npm) {
    if (
      e.source === "remote" &&
      (localNames.has(e.name) || listed.filter((n) => n === e.name).length > 1)
    ) {
      next.push(
        `\`${BIN} components show ${e.name} --pack ${e.pack}\` for the one from ${e.pack}.`,
      );
    }
  }
  if (local.some((e) => e.source === "installed"))
    next.push(
      `Pack components need the page to declare their pack: \`${BIN} check --fix <file>\` adds it.`,
    );
  const seen = new Set<string>();
  for (const e of npm) {
    if (e.source !== "remote" || seen.has(e.pack)) continue;
    seen.add(e.pack);
    next.push(howToGet(e));
  }
  // One short line each: a long signature (a child list) is clipped; `show` prints it whole.
  const line = (e: ComponentEntry): string => {
    const head = e.uses
      ? `${e.name} (recipe: writes ${e.source === "remote" ? clip(e.uses.join(", "), 300) : e.uses.join(", ")})`
      : clip(e.signature, e.source === "remote" ? 300 : 160);
    const g = e.source === "remote" ? clip(e.group, 40) : e.group;
    return `${head} — ${clip(e.description, 140)} [${g}; ${where(e)}]`;
  };
  return {
    query,
    results: local.length ? local.map(line) : undefined,
    npm: npm.length ? npm.map(line) : undefined,
    remote: remote.note,
    next: next.join(" "),
  };
}

/** `pack`: look the names up in that pack only ("core", a bundled or installed pack, or a pack on npm). */
export async function showComponents(
  names: string[],
  pack?: string,
): Promise<ComponentShow | CommandError> {
  if (!names.length)
    return { status: "error", error: `show needs a name: ${BIN} components show Gantt` };
  const lookup = (all: ComponentEntry[], n: string) => {
    const entries = pack ? all.filter((x) => x.pack === pack) : all;
    return (
      entries.find((x) => x.name === n) ||
      entries.find((x) => x.name.toLowerCase() === n.toLowerCase())
    );
  };
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
  // The entries a component's signature can name: its own pack's, or core's (bundled packs included).
  const scopeOf = (e: ComponentEntry): ComponentEntry[] =>
    e.source === "core" || e.source === "bundled"
      ? entries.filter((x) => x.source === "core" || x.source === "bundled")
      : entries.filter((x) => x.source === e.source && x.pack === e.pack);
  const out: ComponentShow = {
    components: found.map((e) => {
      // A pack on npm is unvetted third-party text, so it gets a fixed share of the agent's context.
      const fromNpm = e.source === "remote";
      const cut = (text: string, max: number): string => (fromNpm ? clip(text, max) : text);
      const o: ShownComponent = {
        name: e.name,
        ...(e.uses
          ? { recipe: `no component of its own: write ${cut(e.uses.join(", "), 300)}` }
          : {}),
        ...(e.signature ? { signature: cut(e.signature, 300) } : {}),
        description: cut(e.description, 140),
        group: cut(e.group, 40),
        from: where(e),
      };
      const scope = scopeOf(e);
      const byName = new Map(scope.filter((x) => x.signature).map((x) => [x.name, x]));
      // A recipe's parts are the components it writes; a component's, the value-only parts its props name (and theirs).
      const parts: ComponentEntry[] = [];
      const queue = e.uses
        ? [...e.uses]
        : [...e.signature.matchAll(/\b[A-Z][A-Za-z0-9]*\b/g)].map((m) => m[0]);
      for (let n = queue.shift(); n !== undefined; n = queue.shift()) {
        const p = byName.get(n);
        if (!p || p === e || parts.includes(p) || (!e.uses && p.slots !== null)) continue;
        parts.push(p);
        if (!e.uses)
          queue.push(...[...p.signature.matchAll(/\b[A-Z][A-Za-z0-9]*\b/g)].map((m) => m[0]));
      }
      if (parts.length)
        o.parts = (fromNpm ? parts.slice(0, 5) : parts).map((p) => cut(p.signature, 300));
      if (e.slots === null) {
        const takers = scope
          .filter((x) => x !== e && new RegExp(`\\b${e.name}\\b`).test(x.signature))
          .map((x) => x.name);
        if (takers.length) o.sits = `a value inside ${takers.join(", ")}`;
      } else if (e.slots) o.sits = [...e.slots, "Stack"].join(", ");
      let notes = notesOf(e)
        .filter(
          (line) =>
            new RegExp(`\\b${e.name}\\b`).test(line) &&
            !line.startsWith("- Also in ") &&
            !line.startsWith("- More "),
        )
        .map((l) => l.replace(/^- /, ""));
      if (fromNpm) notes = notes.slice(0, 3).map((l) => clip(l, 140));
      if (notes.length) o.notes = notes;
      if (e.guide) o.guide = cut(e.guide, 600);
      const examples = e.examples.slice(0, fromNpm ? 1 : 2).map((x) => cut(x, 600));
      if (examples.length) o.examples = examples;
      if (e.source === "installed")
        o.use = `From pack ${e.pack}: after writing the page, \`${BIN} check --fix <file>\` declares it.`;
      if (e.source === "remote") o.use = howToGet(e);
      return o;
    }),
  };
  if (missing.length) {
    out.unknown = missing;
    if (remote) out.remote = remote.note;
    out.next = `\`${BIN} components search ${missing[0].toLowerCase()}\``;
  }
  if (!found.length) out.status = "error";
  return out;
}
