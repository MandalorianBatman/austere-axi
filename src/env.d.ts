// Ambient declarations for the build: esbuild `define`s, the virtual modules
// scripts/lib/plugins.ts serves, and the loaders scripts/build.ts configures.

// Defined by esbuild's `define` in scripts/build.ts; absent when run from source.
declare const __AUSTERE_BUNDLED__: boolean | undefined;
declare const __AUSTERE_VERSION__: string | undefined;

/** Every component file in src/runtime/components/ (registryPlugin), flattened, in file order. */
declare module "austere:components" {
  import type { AustereComponent } from "../types/pack.d.ts";
  const components: AustereComponent[];
  export default components;
}

/** The bundled packs' catalogs, reduced to what the runtime needs to load them (bundledPacksPlugin). */
declare module "austere:bundled-packs" {
  const packs: Record<string, { name: string; version: string; components: string[] }>;
  export default packs;
}

/** CSS is imported as text (`loader: { ".css": "text" }`) and injected by the runtime or the pack. */
declare module "*.css" {
  const css: string;
  export default css;
}
