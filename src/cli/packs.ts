// @ts-check
// Component packs on this machine.
//   bundled    shipped in dist/packs/<id>/ (Mermaid); in the core spec, loaded implicitly
//   installed  added with `components add`; files in <state>/packs/<name>@<version>/,
//              recorded in <state>/packs.json with the integrity of their pack.js
// A page uses an installed pack only when it declares it:
//   <meta name="austere-packs" content="name@version sha384-…">
import fs from "node:fs";
import path from "node:path";
import { assetPath, stateDir } from "./paths.js";
import { PACKS_META_RE, formatPacksMeta, parsePacksMeta } from "../shared/packs-meta.js";
import { CATALOG_FORMAT } from "../shared/catalog.js";

export const PACK_API = 1;
/** Packs published by austere-axi itself; anything else needs --trust to install. */
export const TRUSTED_SCOPE = "@austere-axi/";

/** By name alone: what the registry (and so jsDelivr) serves under @austere-axi/ is ours. */
export function isFirstParty(name) {
  return name.startsWith(TRUSTED_SCOPE);
}

/**
 * Whether a pack's code is someone else's. An installed pack goes by how it
 * was installed (a folder or tarball can claim any name); one not installed
 * here is fetched from the registry by name.
 */
export function isThirdParty(name, installed = findInstalled(name)) {
  if (installed) return !(installed.trust === "first-party" && installed.source === "npm");
  return !isFirstParty(name);
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

function writeJsonAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + "\n");
  fs.renameSync(tmp, file);
}

// ── catalogs ──

let core = null;
export function coreCatalog() {
  if (!core) core = readJson(assetPath("catalog.json"), { format: CATALOG_FORMAT, pack: "core", groups: [], components: [] });
  return core;
}

let bundled = null;
/** @returns {{ id: string, name: string, version: string, dir: string, catalog: any, bundled: true }[]} */
export function bundledPacks() {
  if (bundled) return bundled;
  bundled = [];
  const root = assetPath("packs");
  if (!fs.existsSync(root)) return bundled;
  for (const id of fs.readdirSync(root).sort()) {
    const catalog = readJson(path.join(root, id, "catalog.json"), null);
    if (!catalog) continue;
    bundled.push({ id, name: catalog.pack, version: catalog.version, dir: path.join(root, id), catalog, bundled: true });
  }
  return bundled;
}

// ── lockfile ──

export function lockFile() {
  return path.join(stateDir(), "packs.json");
}

export function packsDir() {
  return path.join(stateDir(), "packs");
}

export function readLock() {
  const lock = readJson(lockFile(), null);
  return lock && lock.packs && typeof lock.packs === "object" ? lock : { format: 1, packs: {} };
}

export function writeLock(lock) {
  writeJsonAtomic(lockFile(), lock);
}

/** Folder name for an installed pack: "@scope/name@1.0.0" → "@scope+name@1.0.0". */
export function packDirName(name, version) {
  return `${name.replace("/", "+")}@${version}`;
}

/** @returns {{ name, version, integrity, source, resolved, trust, installedAt, dir, catalog }[]} */
export function installedPacks() {
  const lock = readLock();
  return Object.entries(lock.packs)
    .map(([name, e]) => {
      const dir = path.join(packsDir(), packDirName(name, e.version));
      return { name, ...e, dir, catalog: readJson(path.join(dir, "catalog.json"), null) };
    })
    .filter((p) => p.catalog)
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function findInstalled(name) {
  return installedPacks().find((p) => p.name === name) || null;
}

/** pack.js of an installed pack at exactly this version, or null (the server serves it). */
export function installedPackFile(name, version) {
  const p = findInstalled(name);
  if (!p || p.version !== version) return null;
  const file = path.join(p.dir, "pack.js");
  return fs.existsSync(file) ? file : null;
}

// ── pages ──

export function declaredPacks(html) {
  const m = PACKS_META_RE.exec(html);
  return m ? parsePacksMeta(m[1]) : [];
}

/** Component names a program calls. */
export function calledComponents(program) {
  const out = new Set();
  for (const m of String(program || "").matchAll(/(?<![\w@$.])([A-Z][A-Za-z0-9]*)\s*\(/g)) out.add(m[1]);
  return out;
}

/** Bundled packs the program needs (no tag required). */
export function implicitPacks(program) {
  const called = calledComponents(program);
  return bundledPacks().filter((p) => p.catalog.components.some((c) => called.has(c.name)));
}

/**
 * What a page's packs look like here.
 * @returns {{ declared, installed, missing, mismatched, stale, thirdParty }}
 *   installed: declared packs installed at that version (their catalogs extend `check`)
 *   missing: declared but not installed;  mismatched: installed at another version
 */
export function pagePacks(html) {
  const declared = declaredPacks(html);
  const installed = [];
  const missing = [];
  const mismatched = [];
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
export function packDefining(name) {
  return installedPacks().find((p) => p.catalog.components.some((c) => c.name === name)) || null;
}

/** The meta tag `check --fix` writes: installed packs whose components the program calls. */
export function neededPacks(program) {
  const called = calledComponents(program);
  const coreNames = new Set(coreCatalog().components.map((c) => c.name));
  const out = [];
  for (const p of installedPacks()) {
    if (p.catalog.components.some((c) => called.has(c.name) && !coreNames.has(c.name))) {
      out.push({ name: p.name, version: p.version, integrity: p.integrity });
    }
  }
  return out;
}

export function packsMetaTag(packs) {
  return `<meta name="austere-packs" content="${formatPacksMeta(packs)}">`;
}

/** Put (or replace, or remove) the meta tag in a page's <head>. */
export function setPacksMeta(html, packs) {
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
export function mergePackSchemas(schema, catalogs) {
  if (!catalogs.length) return schema;
  const out = structuredClone(schema);
  out.$defs ||= {};
  out.properties ||= {};
  out.required ||= [];
  for (const cat of catalogs) {
    for (const [k, v] of Object.entries(cat.defs || {})) if (!out.$defs[k]) out.$defs[k] = v;
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
