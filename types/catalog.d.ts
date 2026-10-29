// Types for the component catalog (src/shared/catalog.js) and the catalog.json
// a pack ships. Hand-written. Keep it in step with CATALOG_FORMAT.

export declare const CATALOG_FORMAT: 1;

export type Tier = "core" | "extended";

export interface CatalogEntry {
  name: string;
  group: string;
  signature: string;
  description: string;
  tier: Tier;
  /** "core", or the name of the pack that owns the component. */
  pack: string;
  examples: string[];
}

export interface CatalogGroup {
  name: string;
  notes: string[];
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
  /** Keep just these components (a pack's own, out of a library that also holds the core). */
  only?: string[] | null;
}

export declare function catalogFromSpec(spec: LibrarySpec, options?: CatalogFromSpecOptions): Catalog;

/** The spec the prompt is generated from: extended-tier components leave it. */
export declare function promptSpec<S extends LibrarySpec>(spec: S, tiers?: Record<string, string>): S;

export interface SearchOptions {
  notesOf?: (entry: CatalogEntry) => string[];
  limit?: number;
}

export declare function searchCatalog(
  entries: CatalogEntry[],
  query: string,
  options?: SearchOptions,
): { entry: CatalogEntry; score: number }[];
