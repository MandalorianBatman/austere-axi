// Types for the pack kit (src/pack-kit/index.js, shipped as dist/pack-kit.mjs).
import type { PackCatalog } from "./catalog.js";

export { PACK_API, CONTENT_SLOTS } from "./pack.js";

export declare const ENTRY_CANDIDATES: string[];

export interface PackageJson {
  name?: string;
  version?: string;
  austere?: { entry?: string };
  [key: string]: unknown;
}

export declare function readPackageJson(dir: string): PackageJson;

/** The pack's entry module: package.json "austere.entry", else the first of ENTRY_CANDIDATES. */
export declare function packEntry(dir: string, pkg?: PackageJson): string;

export declare function sri(buffer: Uint8Array): string;

export interface BuildPackOptions {
  /** Pack folder (package.json + entry module). */
  dir: string;
  /** The esbuild module to bundle with. */
  esbuild: { build(options: any): Promise<unknown> };
  /** Default <dir>/dist. */
  outDir?: string;
  /** Default package.json name. */
  name?: string;
  /** Default package.json version. */
  version?: string;
  /** Core component names, to warn about collisions. */
  coreNames?: string[];
  /** Default true. */
  minify?: boolean;
}

export interface BuildPackResult {
  catalog: PackCatalog;
  warnings: string[];
  packFile: string;
  catalogFile: string;
}

export declare function buildPack(options: BuildPackOptions): Promise<BuildPackResult>;
