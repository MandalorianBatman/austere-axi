// The component catalog: one entry per component (signature, description,
// group, tier, examples, pack) and per recipe. It is what `components list|search|show`
// read, what a pack ships as catalog.json, and where the prompt's tiers are
// decided. Plain data and pure functions: used by the build, the CLI and tests.
import type {
  Catalog,
  CatalogEntry,
  CatalogFromSpecOptions,
  EntryDetails,
  LibrarySpec,
  PromptSpecOptions,
  Recipe,
} from "../../types/catalog.d.ts";

export const CATALOG_FORMAT = 1;

/** The read-path fields that are set, copied (so an entry never shares a list with its source). */
function detailsOf(d: EntryDetails | undefined): EntryDetails {
  const out: EntryDetails = {};
  if (!d) return out;
  // A guide checked out with CRLF (Windows) reads as LF, so `show` prints it as a block.
  if (d.guide) out.guide = d.guide.replace(/\r\n?/g, "\n");
  if (d.keywords?.length) out.keywords = [...d.keywords];
  if (d.family) out.family = d.family;
  if (d.limits?.length) out.limits = d.limits.map((l) => ({ ...l }));
  if (d.alsoIn?.length) out.alsoIn = [...d.alsoIn];
  return out;
}

/**
 * What is wrong with a component's or recipe's read-path fields, or null.
 * `props`: the component's prop names, which `limits` must name.
 */
export function detailsProblem(d: EntryDetails, props?: string[]): string | null {
  if (d.guide != null && typeof d.guide !== "string") return "guide must be markdown text";
  if (
    d.keywords != null &&
    !(Array.isArray(d.keywords) && d.keywords.every((k) => typeof k === "string" && k.trim()))
  )
    return "keywords must be a list of words";
  if (d.family != null && !(typeof d.family === "string" && /^\S.{0,29}$/.test(d.family)))
    return "family must be a short name (up to 30 characters)";
  if (
    d.alsoIn != null &&
    !(Array.isArray(d.alsoIn) && d.alsoIn.every((g) => typeof g === "string" && g))
  )
    return "alsoIn must be a list of group names";
  if (d.limits == null) return null;
  if (!Array.isArray(d.limits)) return "limits must be a list of { prop, max, message }";
  for (const l of d.limits) {
    if (!l || typeof l.prop !== "string" || typeof l.message !== "string")
      return "each limit needs a prop name and a message";
    if (!Number.isInteger(l.max) || l.max < 1) return `limit on ${l.prop}: max must be 1 or more`;
    if (props && !props.includes(l.prop))
      return `limit on ${l.prop}: there is no prop by that name`;
  }
  return null;
}

/**
 * Catalog from an OpenUI library spec (`library.toSpec()`).
 * `only` keeps just these components (a pack's own, out of a library that also holds the core).
 */
export function catalogFromSpec(
  spec: LibrarySpec,
  {
    pack = "core",
    version = "",
    tiers = {},
    examples = {},
    details = {},
    slots = {},
    families = {},
    only = null,
  }: CatalogFromSpecOptions = {},
): Catalog {
  const groupOf = new Map<string, string>();
  for (const g of spec.componentGroups || [])
    for (const n of g.components) if (!groupOf.has(n)) groupOf.set(n, g.name);
  const keep = only ? new Set(only) : null;
  const components = Object.entries(spec.components)
    .filter(([name]) => !keep || keep.has(name))
    .map(([name, c]): CatalogEntry => {
      const e: CatalogEntry = {
        name,
        group: groupOf.get(name) || "Other",
        signature: c.signature,
        description: c.description || "",
        tier: tiers[name] === "extended" ? "extended" : "core",
        pack,
        examples: examples[name] || [],
        ...detailsOf(details[name]),
      };
      if (name in slots) e.slots = slots[name];
      return e;
    });
  const names = new Set(components.map((c) => c.name));
  const groups = (spec.componentGroups || [])
    .filter((g) => g.components.some((n) => names.has(n)))
    .map((g) =>
      families[g.name]?.length
        ? { name: g.name, notes: g.notes || [], families: [...families[g.name]] }
        : { name: g.name, notes: g.notes || [] },
    );
  return { format: CATALOG_FORMAT, pack, version, groups, components };
}

/** A recipe as a catalog entry: no signature, out of `spec`, `uses` names what to write. */
export function recipeEntry(r: Recipe, pack = "core"): CatalogEntry {
  return {
    name: r.name,
    group: r.group,
    signature: "",
    description: r.description,
    tier: "extended",
    pack,
    examples: [...r.examples],
    ...detailsOf(r),
    uses: [...r.uses],
  };
}

/** `signature` with `hide` left out of each `(A | B | ...)[]` list, as long as one name stays. */
function leanSignature(signature: string, hide: Set<string>): string {
  return signature.replace(
    /\(([A-Z][A-Za-z0-9]*(?: \| [A-Z][A-Za-z0-9]*)+)\)\[\]/g,
    (all, list) => {
      const kept = String(list)
        .split(" | ")
        .filter((n) => !hide.has(n));
      return kept.length ? `(${kept.join(" | ")})[]` : all;
    },
  );
}

/**
 * The spec the prompt is generated from: extended-tier components leave it,
 * and each group gets one line naming them, so an agent knows they exist and
 * asks for the full signature only when it needs one. `lean` drops names from
 * printed child lists (the parser keeps accepting them); `chooser` gives a
 * group a line that names its other types and points at `components list`.
 */
export function promptSpec<S extends LibrarySpec>(
  spec: S,
  tiers: Record<string, string> = {},
  { lean, chooser = {} }: PromptSpecOptions = {},
): S {
  const extended = new Set(
    Object.keys(tiers).filter((n) => tiers[n] === "extended" && spec.components[n]),
  );
  if (!extended.size && !lean && !Object.keys(chooser).length) return spec;
  const hide = new Set([...extended, ...(lean?.hide || [])]);
  const leanParents = new Set(lean?.parents || []);
  const components = Object.fromEntries(
    Object.entries(spec.components)
      .filter(([n]) => !extended.has(n))
      .map(([n, c]) =>
        leanParents.has(n) ? [n, { ...c, signature: leanSignature(c.signature, hide) }] : [n, c],
      ),
  );
  const componentGroups = (spec.componentGroups || []).map((g) => {
    const more = g.components.filter((n) => extended.has(n));
    const choose = chooser[g.name];
    const line = choose?.length
      ? `- More ${g.name} (\`austere-axi components list ${g.name}\` says what each is for): ${choose.join(", ")}.`
      : more.length
        ? `- Also in ${g.name} (\`austere-axi components show <Name>\` for the signature): ${more.join(", ")}.`
        : null;
    return {
      ...g,
      components: g.components.filter((n) => !extended.has(n)),
      notes: line ? [...(g.notes || []), line] : g.notes,
    };
  });
  return { ...spec, components, componentGroups };
}

/** The chooser's "use for" text: the first sentence under the guide's `## Use for`, else the description. */
export function purposeOf(entry: Pick<CatalogEntry, "guide" | "description">): string {
  const guide = typeof entry.guide === "string" ? entry.guide : "";
  const head = /^#{1,6}[ \t]*Use for[ \t]*$/im.exec(guide);
  // The paragraph (or first bullet) under the heading, up to a blank line or the next heading.
  const paragraph = head
    ? guide
        .slice(head.index + head[0].length)
        .replace(/^\s+/, "")
        .split(/\r?\n[ \t]*\r?\n|\r?\n(?=#)/)[0]
    : "";
  const text = (paragraph || entry.description || "")
    .replace(/^\s*[-*][ \t]+/, "")
    .split(/\r?\n\s*[-*][ \t]+/)[0]
    .replace(/\s+/g, " ")
    .trim();
  // The first sentence: a stop before a space or the end, not the one in "e.g." or "i.e.".
  const sentence = /^.*?(?<!\b(?:e\.g|i\.e|etc|vs))[.!?](?=\s|$)/.exec(text);
  return (sentence ? sentence[0] : text).replace(/[.!?]$/, "");
}

/** True when the `components list <group>` chooser lists the entry: a container or a recipe in, or also in, that group. */
export function inChooser(entry: CatalogEntry, group: string): boolean {
  const g = group.toLowerCase();
  const inGroup =
    entry.group.toLowerCase() === g || !!entry.alsoIn?.some((x) => x.toLowerCase() === g);
  return inGroup && (!!entry.uses || entry.slots !== null);
}

const words = (text: string | undefined) =>
  String(text || "")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 1);

/**
 * Rank catalog entries for a free-text query: names first, then keywords,
 * groups, descriptions, prop names and the notes of the entry's group. The
 * component names inside a signature (a child list) do not count.
 */
export function searchCatalog<E extends CatalogEntry>(
  entries: E[],
  query: string,
  { notesOf = () => [], limit = 8 }: { notesOf?: (entry: E) => string[]; limit?: number } = {},
): { entry: E; score: number }[] {
  const q = String(query || "")
    .trim()
    .toLowerCase();
  const terms = words(q);
  if (!terms.length) return [];
  const scored: { entry: E; score: number }[] = [];
  for (const e of entries) {
    const name = e.name.toLowerCase();
    const keywords = (e.keywords || []).map((k) => k.toLowerCase());
    const keywordWords = keywords.flatMap(words);
    const groups = [e.group, ...(e.alsoIn || [])].flatMap(words);
    const desc = words(e.description);
    const props = words(e.signature.replace(/\b[A-Z][A-Za-z0-9]*\b/g, " "));
    let score = 0;
    if (name === q) score += 100;
    if (keywords.includes(q)) score += 20;
    for (const t of terms) {
      if (name === t) score += 60;
      else if (name.startsWith(t)) score += 30;
      else if (name.includes(t)) score += 20;
      if (keywordWords.includes(t)) score += 12;
      else if (keywordWords.some((w) => w.startsWith(t))) score += 6;
      if (groups.includes(t)) score += 15;
      if (e.family && words(e.family).includes(t)) score += 6;
      if (e.pack && e.pack.toLowerCase().includes(t)) score += 10;
      if (desc.includes(t)) score += 8;
      else if (desc.some((w) => w.startsWith(t))) score += 4;
      if (props.includes(t)) score += 3;
      if (notesOf(e).some((n) => words(n).includes(t) && n.includes(e.name))) score += 6;
    }
    if (score > 0) scored.push({ entry: e, score: score - (e.tier === "extended" ? 1 : 0) });
  }
  return scored
    .sort((a, b) => b.score - a.score || a.entry.name.localeCompare(b.entry.name))
    .slice(0, limit);
}
