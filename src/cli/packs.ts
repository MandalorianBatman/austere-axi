// Component packs on this machine.
//   bundled    shipped in dist/packs/<id>/ (shadcn); in the core spec, loaded implicitly
//   installed  added with `components add`; files in <state>/packs/<name>@<version>/,
//              recorded in <state>/packs.json with the integrity of their pack.js
// A page uses an installed pack only when it declares it:
//   <meta name="austere-packs" content="name@version sha384-…">
import fs from "node:fs";
import path from "node:path";
import type { LibraryJSONSchema } from "@openuidev/lang-core";
import type { Catalog, PackCatalog } from "../../types/catalog.d.ts";
import { assetPath, stateDir } from "./paths.ts";
import { PACKS_META_RE, formatPacksMeta, parsePacksMeta } from "../shared/packs-meta.ts";
import type { PackRef } from "../shared/packs-meta.ts";
import { CATALOG_FORMAT } from "../shared/catalog.ts";

/** The core catalog (dist/catalog.json): the shipped one carries no version. */
export type CoreCatalog = Omit<Catalog, "version"> & { version?: string };

export interface BundledPack {
  id: string;
  name: string;
  version: string;
  dir: string;
  catalog: PackCatalog;
  bundled: true;
}

export type PackSource = "npm" | "tarball" | "folder";
export type PackTrust = "first-party" | "local" | "--trust";

/** One pack in <state>/packs.json. */
export interface LockEntry {
  version: string;
  integrity: string;
  source: PackSource;
  resolved: string;
  trust: PackTrust;
  components: string[];
  installedAt: string;
}

export interface Lock {
  format: number;
  packs: Record<string, LockEntry>;
}

export interface InstalledPack extends LockEntry {
  name: string;
  dir: string;
  catalog: PackCatalog;
}

/** A declared pack installed here at another version. */
export interface MismatchedPack extends PackRef {
  installedVersion: string;
}

export interface PagePacks {
  declared: PackRef[];
  installed: InstalledPack[];
  missing: PackRef[];
  mismatched: MismatchedPack[];
  stale: PackRef[];
  thirdParty: PackRef[];
}

/** A JSON schema fragment, as the spec and pack catalogs hold it. */
export interface SchemaNode {
  $ref?: string;
  anyOf?: SchemaNode[];
  items?: SchemaNode;
  properties?: Record<string, SchemaNode>;
  required?: string[];
  description?: string;
  type?: string;
  [keyword: string]: unknown;
}

/** The library JSON schema (dist/spec.json): what `check` parses against. */
export interface SpecSchema extends LibraryJSONSchema {
  $defs?: Record<string, SchemaNode>;
  properties?: Record<string, unknown>;
  required?: string[];
  root?: string;
}

export const PACK_API = 1;
/** Packs published by austere-axi itself; anything else needs --trust to install. */
export const TRUSTED_SCOPE = "@austere-axi/";

/** By name alone: what the registry (and so jsDelivr) serves under @austere-axi/ is ours. */
export function isFirstParty(name: string): boolean {
  return name.startsWith(TRUSTED_SCOPE);
}

/**
 * Whether a pack's code is someone else's. An installed pack goes by how it
 * was installed (a folder or tarball can claim any name); one not installed
 * here is fetched from the registry by name.
 */
export function isThirdParty(name: string, installed: Pick<LockEntry, "trust" | "source"> | null = findInstalled(name)): boolean {
  if (installed) return !(installed.trust === "first-party" && installed.source === "npm");
  return !isFirstParty(name);
}

function readJson<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

function writeJsonAtomic(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + "\n");
  fs.renameSync(tmp, file);
}

// ── catalogs ──

let core: CoreCatalog | null = null;
export function coreCatalog(): CoreCatalog {
  if (!core) core = readJson<CoreCatalog>(assetPath("catalog.json"), { format: CATALOG_FORMAT, pack: "core", groups: [], components: [] });
  return core;
}

let bundled: BundledPack[] | null = null;
export function bundledPacks(): BundledPack[] {
  if (bundled) return bundled;
  bundled = [];
  const root = assetPath("packs");
  if (!fs.existsSync(root)) return bundled;
  for (const id of fs.readdirSync(root).sort()) {
    const catalog = readJson<PackCatalog | null>(path.join(root, id, "catalog.json"), null);
    if (!catalog) continue;
    bundled.push({ id, name: catalog.pack, version: catalog.version, dir: path.join(root, id), catalog, bundled: true });
  }
  return bundled;
}

// ── lockfile ──

export function lockFile(): string {
  return path.join(stateDir(), "packs.json");
}

export function packsDir(): string {
  return path.join(stateDir(), "packs");
}

export function readLock(): Lock {
  const lock = readJson<Lock | null>(lockFile(), null);
  return lock && lock.packs && typeof lock.packs === "object" ? lock : { format: 1, packs: {} };
}

export function writeLock(lock: Lock): void {
  writeJsonAtomic(lockFile(), lock);
}

/** Folder name for an installed pack: "@scope/name@1.0.0" → "@scope+name@1.0.0". */
export function packDirName(name: string, version: string): string {
  return `${name.replace("/", "+")}@${version}`;
}

export function installedPacks(): InstalledPack[] {
  const lock = readLock();
  return Object.entries(lock.packs)
    .map(([name, e]) => {
      const dir = path.join(packsDir(), packDirName(name, e.version));
      return { name, ...e, dir, catalog: readJson<PackCatalog | null>(path.join(dir, "catalog.json"), null) };
    })
    .filter((p): p is InstalledPack => !!p.catalog)
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function findInstalled(name: string): InstalledPack | null {
  return installedPacks().find((p) => p.name === name) || null;
}

/** pack.js of an installed pack at exactly this version, or null (the server serves it). */
export function installedPackFile(name: string, version: string): string | null {
  const p = findInstalled(name);
  if (!p || p.version !== version) return null;
  const file = path.join(p.dir, "pack.js");
  return fs.existsSync(file) ? file : null;
}

// ── pages ──

export function declaredPacks(html: string): PackRef[] {
  const m = PACKS_META_RE.exec(html);
  return m ? parsePacksMeta(m[1]) : [];
}

/** Component names a program calls. */
export function calledComponents(program: string | null | undefined): Set<string> {
  const out = new Set<string>();
  for (const m of String(program || "").matchAll(/(?<![\w@$.])([A-Z][A-Za-z0-9]*)\s*\(/g)) out.add(m[1]);
  return out;
}

/** Bundled packs the program needs (no tag required). */
export function implicitPacks(program: string): BundledPack[] {
  const called = calledComponents(program);
  return bundledPacks().filter((p) => p.catalog.components.some((c) => called.has(c.name)));
}

/**
 * What a page's packs look like here.
 *   installed: declared packs installed at that version (their catalogs extend `check`)
 *   missing: declared but not installed;  mismatched: installed at another version
 */
export function pagePacks(html: string): PagePacks {
  const declared = declaredPacks(html);
  const installed: InstalledPack[] = [];
  const missing: PackRef[] = [];
  const mismatched: MismatchedPack[] = [];
  for (const d of declared) {
    const p = findInstalled(d.name);
    if (!p) missing.push(d);
    else if (p.version !== d.version) mismatched.push({ ...d, installedVersion: p.version });
    else installed.push(p);
  }
  // Declared with a hash that is not the installed build's (rebuilt and re-added at the same version).
  const stale = declared.filter((d) => d.integrity && installed.some((p) => p.name === d.name && p.integrity !== d.integrity));
  return {
    declared,
    installed,
    missing,
    mismatched,
    stale,
    thirdParty: declared.filter((d) => isThirdParty(d.name, installed.find((p) => p.name === d.name) || findInstalled(d.name))),
  };
}

/** Installed pack that defines a component, for "declare this pack" hints. */
export function packDefining(name: string): InstalledPack | null {
  return installedPacks().find((p) => p.catalog.components.some((c) => c.name === name)) || null;
}

/** The meta tag `check --fix` writes: installed packs whose components the program calls. */
export function neededPacks(program: string): PackRef[] {
  const called = calledComponents(program);
  const coreNames = new Set(coreCatalog().components.map((c) => c.name));
  const out: PackRef[] = [];
  for (const p of installedPacks()) {
    if (p.catalog.components.some((c) => called.has(c.name) && !coreNames.has(c.name))) {
      out.push({ name: p.name, version: p.version, integrity: p.integrity });
    }
  }
  return out;
}

export function packsMetaTag(packs: PackRef[]): string {
  return `<meta name="austere-packs" content="${formatPacksMeta(packs)}">`;
}

/** Put (or replace, or remove) the meta tag in a page's <head>. */
export function setPacksMeta(html: string, packs: PackRef[]): string {
  const has = PACKS_META_RE.test(html);
  if (!packs.length) return has ? html.replace(new RegExp(`[ \\t]*${PACKS_META_RE.source}[ \\t]*\\r?\\n?`, "i"), "") : html;
  const tag = packsMetaTag(packs);
  if (has) return html.replace(PACKS_META_RE, () => tag);
  // Before the runtime <script>, so the packs are known when it boots; else at the end of <head>.
  const runtime = /[ \t]*<script\b[^>]*\bsrc=["'][^"']*austere(?:\.min)?\.js[^"']*["'][^>]*>/i.exec(html);
  if (runtime) return html.slice(0, runtime.index) + tag + "\n" + html.slice(runtime.index);
  const head = /<\/head>/i.exec(html);
  if (head) return html.slice(0, head.index) + tag + "\n" + html.slice(head.index);
  return tag + "\n" + html;
}

// ── schema ──

/**
 * The core JSON schema extended with packs' components: their $defs, a
 * top-level property each, and a $ref in every slot union they declare
 * (e.g. "Card.children"). Components the schema already has are left alone.
 */
export function mergePackSchemas(schema: SpecSchema, catalogs: PackCatalog[]): SpecSchema {
  if (!catalogs.length) return schema;
  const out = structuredClone(schema);
  out.$defs ||= {};
  out.properties ||= {};
  out.required ||= [];
  for (const cat of catalogs) {
    // A catalog's defs are JSON schema objects (the pack kit writes them from the library's schema).
    for (const [k, v] of Object.entries(cat.defs || {})) if (!out.$defs[k]) out.$defs[k] = v as SchemaNode;
    for (const c of cat.components || []) {
      if (out.properties[c.name]) continue;
      const ref = { $ref: `#/$defs/${c.name}` };
      out.properties[c.name] = ref;
      out.required.push(c.name);
      for (const slot of c.slots || []) {
        const [parent, prop] = slot.split(".");
        const p = out.$defs[parent] && out.$defs[parent].properties && out.$defs[parent].properties[prop];
        const union = (p && p.items && p.items.anyOf) || (p && p.anyOf);
        if (union && !union.some((r) => r.$ref === ref.$ref)) union.push({ ...ref });
      }
    }
  }
  return out;
}
