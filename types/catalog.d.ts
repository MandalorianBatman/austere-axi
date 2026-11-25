// Types for the component catalog (src/shared/catalog.js) and the catalog.json
// a pack ships. Hand-written. Keep it in step with CATALOG_FORMAT.

export declare const CATALOG_FORMAT: 1;

export type Tier = "core" | "extended";

/** A list prop's longest sensible length; `check` warns past it. */
export interface ComponentLimit {
  /** Name of a list prop. */
  prop: string;
  max: number;
  /** What to do instead, e.g. "Split it into two diagrams." */
  message: string;
}

/**
 * The read-path fields a component (or a recipe) may carry. None of them goes into `spec`;
 * `components list|show|search` and `check` read them.
 */
export interface EntryDetails {
  /** Usage guide (markdown): `## Use for`, `## Not for`, `## Limits`, `## Usual errors`. */
  guide?: string;
  /** Words a user would say for it (funnel, spider, root cause); they rank search. */
  keywords?: string[];
  /** Short heading the `components list <Group>` chooser groups it under. */
  family?: string;
  limits?: ComponentLimit[];
  /** Other groups whose chooser lists it too (Steps in Diagrams). */
  alsoIn?: string[];
}

export interface CatalogEntry extends EntryDetails {
  name: string;
  group: string;
  /** "" for a recipe. */
  signature: string;
  description: string;
  tier: Tier;
  /** "core", or the name of the pack that owns the component. */
  pack: string;
  examples: string[];
  /** Parent slots it may fill ("Card.children"); null for a value-only part. Absent in older catalogs. */
  slots?: string[] | null;
  /** Set on a recipe: it has no component of its own; the page writes these. */
  uses?: string[];
}

/** A catalog entry with no component: an upstream diagram type an existing component draws well. */
export interface Recipe extends EntryDetails {
  name: string;
  group: string;
  description: string;
  /** The components the page writes. */
  uses: string[];
  examples: string[];
}

export interface CatalogGroup {
  name: string;
  notes: string[];
  /** Order of the chooser's families in this group; families not named here come after. */
  families?: string[];
}

export interface Catalog {
  format: typeof CATALOG_FORMAT;
  pack: string;
  version: string;
  groups: CatalogGroup[];
  components: CatalogEntry[];
}

/** What a pack's dist/catalog.json holds: the catalog plus the pack-only fields. */
export interface PackCatalog extends Omit<Catalog, "components"> {
  /** Pack API version the bundle targets. */
  api: number;
  /** `sha384-<base64>` of dist/pack.js. */
  integrity: string;
  /** Size of dist/pack.js in bytes. */
  size: number;
  /** True when the pack ships CSS. */
  css: boolean;
  components: (CatalogEntry & { slots: string[] | null })[];
  /** JSON schema $defs reachable from the pack's components. */
  defs: Record<string, unknown>;
}

export interface SpecGroup {
  name: string;
  components: string[];
  notes?: string[];
}

/** The part of an OpenUI `library.toSpec()` result that the catalog reads. */
export interface LibrarySpec {
  components: Record<string, { signature: string; description?: string }>;
  componentGroups?: SpecGroup[];
}

export interface CatalogFromSpecOptions {
  pack?: string;
  version?: string;
  tiers?: Record<string, string>;
  examples?: Record<string, string[]>;
  /** Guide, keywords, family, limits and alsoIn by component name. */
  details?: Record<string, EntryDetails>;
  /** Parent slots by component name (null for a value-only part). */
  slots?: Record<string, string[] | null>;
  /** Group → order of its chooser families. */
  families?: Record<string, string[]>;
  /** Keep just these components (a pack's own, out of a library that also holds the core). */
  only?: string[] | null;
}

export declare function catalogFromSpec(
  spec: LibrarySpec,
  options?: CatalogFromSpecOptions,
): Catalog;

/** What is wrong with a component's or recipe's read-path fields, or null. `props`: the prop names `limits` may name. */
export declare function detailsProblem(d: EntryDetails, props?: string[]): string | null;

/** A recipe as a catalog entry. */
export declare function recipeEntry(recipe: Recipe, pack?: string): CatalogEntry;

export interface PromptSpecOptions {
  /** Names left out of the printed child lists of these parents; the parser schema keeps them. */
  lean?: { parents: string[]; hide: string[] };
  /** Group → names its generated line lists, pointing at `components list <Group>` (instead of "Also in"). */
  chooser?: Record<string, string[]>;
}

/** The spec the prompt is generated from: extended-tier components leave it. */
export declare function promptSpec<S extends LibrarySpec>(
  spec: S,
  tiers?: Record<string, string>,
  options?: PromptSpecOptions,
): S;

/** The chooser's "use for" text: the first sentence under the guide's `## Use for`, else the description. */
export declare function purposeOf(entry: Pick<CatalogEntry, "guide" | "description">): string;

/** True when the `components list <group>` chooser lists the entry: a container or a recipe in, or also in, that group. */
export declare function inChooser(entry: CatalogEntry, group: string): boolean;

export interface SearchOptions {
  notesOf?: (entry: CatalogEntry) => string[];
  limit?: number;
}

export declare function searchCatalog(
  entries: CatalogEntry[],
  query: string,
  options?: SearchOptions,
): { entry: CatalogEntry; score: number }[];
