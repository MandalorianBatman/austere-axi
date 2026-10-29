// @ts-check
// The component catalog: one entry per component (signature, description,
// group, tier, examples, pack). It is what `components list|search|show`
// read, what a pack ships as catalog.json, and where the prompt's tiers are
// decided. Plain data and pure functions: used by the build, the CLI and tests.

export const CATALOG_FORMAT = 1;

/**
 * Catalog from an OpenUI library spec (`library.toSpec()`).
 * @param {{components: Record<string, {signature: string, description?: string}>, componentGroups?: {name: string, components: string[], notes?: string[]}[]}} spec
 * @param {{ pack?: string, version?: string, tiers?: Record<string, string>, examples?: Record<string, string[]>, only?: string[] }} [options]
 *   `only` keeps just these components (a pack's own, out of a library that also holds the core).
 */
export function catalogFromSpec(spec, { pack = "core", version = "", tiers = {}, examples = {}, only = null } = {}) {
  const groupOf = new Map();
  for (const g of spec.componentGroups || []) for (const n of g.components) if (!groupOf.has(n)) groupOf.set(n, g.name);
  const keep = only ? new Set(only) : null;
  const components = Object.entries(spec.components)
    .filter(([name]) => !keep || keep.has(name))
    .map(([name, c]) => ({
      name,
      group: groupOf.get(name) || "Other",
      signature: c.signature,
      description: c.description || "",
      tier: tiers[name] === "extended" ? "extended" : "core",
      pack,
      examples: examples[name] || [],
    }));
  const names = new Set(components.map((c) => c.name));
  const groups = (spec.componentGroups || [])
    .filter((g) => g.components.some((n) => names.has(n)))
    .map((g) => ({ name: g.name, notes: g.notes || [] }));
  return { format: CATALOG_FORMAT, pack, version, groups, components };
}

/**
 * The spec the prompt is generated from: extended-tier components leave it,
 * and each group gets one line naming them, so an agent knows they exist and
 * asks for the full signature only when it needs one.
 */
export function promptSpec(spec, tiers = {}) {
  const extended = new Set(Object.keys(tiers).filter((n) => tiers[n] === "extended" && spec.components[n]));
  if (!extended.size) return spec;
  const components = Object.fromEntries(Object.entries(spec.components).filter(([n]) => !extended.has(n)));
  const componentGroups = (spec.componentGroups || []).map((g) => {
    const more = g.components.filter((n) => extended.has(n));
    return {
      ...g,
      components: g.components.filter((n) => !extended.has(n)),
      notes: more.length ? [...(g.notes || []), `- Also in ${g.name} (\`austere-axi components show <Name>\` for the signature): ${more.join(", ")}.`] : g.notes,
    };
  });
  return { ...spec, components, componentGroups };
}

const words = (text) =>
  String(text || "")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 1);

/**
 * Rank catalog entries for a free-text query: names first, then groups,
 * descriptions, signatures and the notes of the entry's group.
 * @returns {{ entry: object, score: number }[]}
 */
export function searchCatalog(entries, query, { notesOf = /** @type {(entry: any) => string[]} */ (() => []), limit = 8 } = {}) {
  const q = String(query || "").trim().toLowerCase();
  const terms = words(q);
  if (!terms.length) return [];
  const scored = [];
  for (const e of entries) {
    const name = e.name.toLowerCase();
    let score = 0;
    if (name === q) score += 100;
    for (const t of terms) {
      if (name === t) score += 60;
      else if (name.startsWith(t)) score += 30;
      else if (name.includes(t)) score += 20;
      if (e.group.toLowerCase() === t) score += 15;
      if (e.pack && e.pack.toLowerCase().includes(t)) score += 10;
      const desc = words(e.description);
      if (desc.includes(t)) score += 8;
      else if (desc.some((w) => w.startsWith(t))) score += 4;
      if (words(e.signature).includes(t)) score += 3;
      if (notesOf(e).some((n) => words(n).includes(t) && n.includes(e.name))) score += 6;
    }
    if (score > 0) scored.push({ entry: e, score: score - (e.tier === "extended" ? 1 : 0) });
  }
  return scored.sort((a, b) => b.score - a.score || a.entry.name.localeCompare(b.entry.name)).slice(0, limit);
}
