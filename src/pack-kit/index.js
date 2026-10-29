// The pack kit: builds a component pack into the two files austere-axi reads.
//   dist/pack.js       browser bundle; registers the pack's components when loaded
//   dist/catalog.json  the pack's components (signatures, groups, examples) and
//                      the JSON schema `check` merges into the core one
// Shipped as dist/pack-kit.mjs for `austere-axi components build`, and used by
// scripts/build.mjs for the packs bundled with austere-axi. esbuild is passed
// in (the pack's own), so austere-axi does not ship a bundler.
//
// A pack's entry module default-exports its components:
//   import { austereComponent } from "austere-axi/pack";
//   import css from "./gantt.css";
//   export default { components: [Gantt, GanttTask], css };
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { pathToFileURL } from "node:url";
import { createLibrary } from "@openuidev/react-lang";
import { hostShimPlugin } from "./shim.js";
import { installHost } from "../runtime/host.js";
import { PACK_API } from "../runtime/pack-api.js";
import { CONTENT_SLOTS } from "../runtime/define.js";
import { catalogFromSpec } from "../shared/catalog.js";
import { isValidPackName, isValidVersion } from "../shared/packs-meta.js";

export { PACK_API, CONTENT_SLOTS };

export const ENTRY_CANDIDATES = ["src/index.jsx", "src/index.js", "index.jsx", "index.js"];

export function readPackageJson(dir) {
  const file = path.join(dir, "package.json");
  if (!fs.existsSync(file)) return {};
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

/** The pack's entry module: package.json "austere.entry", else the first of ENTRY_CANDIDATES. */
export function packEntry(dir, pkg = readPackageJson(dir)) {
  const named = pkg.austere && pkg.austere.entry;
  const candidates = named ? [named] : ENTRY_CANDIDATES;
  for (const c of candidates) {
    const file = path.resolve(dir, c);
    if (fs.existsSync(file)) return file;
  }
  throw new Error(`no pack entry in ${dir}: expected ${candidates.join(" or ")}`);
}

export function sri(buffer) {
  return `sha384-${crypto.createHash("sha384").update(buffer).digest("base64")}`;
}

/** $defs reachable from the pack's own components: what `check` adds to the core schema. */
function reachableDefs(schema, roots) {
  const defs = schema.$defs || {};
  const keep = {};
  const queue = [...roots];
  while (queue.length) {
    const name = queue.shift();
    if (keep[name] || !defs[name]) continue;
    keep[name] = defs[name];
    JSON.stringify(defs[name], (k, v) => {
      if (k === "$ref" && typeof v === "string" && v.startsWith("#/$defs/")) queue.push(v.slice(8));
      return v;
    });
  }
  return keep;
}

const BUILD_DEFAULTS = {
  bundle: true,
  jsx: "automatic",
  loader: { ".css": "text", ".svg": "text" },
  logLevel: "silent",
  plugins: [hostShimPlugin],
};

function buildError(err, what) {
  const first = err && err.errors && err.errors[0];
  if (!first) return err;
  const at = first.location ? ` (${first.location.file}:${first.location.line})` : "";
  return new Error(`${what}: ${first.text}${at}`);
}

/**
 * Build a pack.
 * @param {object} o
 * @param {string} o.dir                 pack folder (package.json + entry module)
 * @param {object} o.esbuild             the esbuild module to bundle with
 * @param {string} [o.outDir]            default <dir>/dist
 * @param {string} [o.name]              default package.json name
 * @param {string} [o.version]           default package.json version
 * @param {string[]} [o.coreNames]       core component names, to warn about collisions
 * @param {boolean} [o.minify]           default true
 * @returns {Promise<{ catalog: object, warnings: string[], packFile: string, catalogFile: string }>}
 */
export async function buildPack({ dir, esbuild, outDir, name, version, coreNames = [], minify = true }) {
  dir = path.resolve(dir);
  const pkg = readPackageJson(dir);
  name = name || pkg.name;
  version = version || pkg.version;
  if (!name || !isValidPackName(name)) throw new Error(`pack name ${JSON.stringify(name || "")} is not a valid npm package name`);
  if (!version || !isValidVersion(version)) throw new Error(`pack ${name}: version ${JSON.stringify(version || "")} is not x.y.z`);
  const entry = packEntry(dir, pkg);
  outDir = path.resolve(outDir || path.join(dir, "dist"));
  fs.mkdirSync(outDir, { recursive: true });
  const warnings = [];

  // 1. Browser bundle: the entry plus a registerPack call.
  const packFile = path.join(outDir, "pack.js");
  try {
    await esbuild.build({
      ...BUILD_DEFAULTS,
      stdin: {
        contents: [
          `import pack from ${JSON.stringify(entry)};`,
          `import { registerPack } from "austere-axi/pack";`,
          `registerPack({ name: ${JSON.stringify(name)}, version: ${JSON.stringify(version)}, api: ${PACK_API},`,
          `  components: [].concat(pack && pack.components ? pack.components : pack), css: pack && pack.css });`,
        ].join("\n"),
        resolveDir: dir,
        sourcefile: "austere-pack-entry.js",
        loader: "js",
      },
      format: "iife",
      minify,
      target: "es2020",
      legalComments: "none",
      define: { "process.env.NODE_ENV": '"production"' },
      outfile: packFile,
    });
  } catch (err) {
    throw buildError(err, `pack ${name}: browser build failed`);
  }

  // 2. The same module in Node, to read its component definitions.
  const tmp = path.join(outDir, `.catalog-${process.pid}-${Date.now()}.mjs`);
  let exported;
  try {
    await esbuild.build({ ...BUILD_DEFAULTS, entryPoints: [entry], platform: "node", format: "esm", outfile: tmp });
    installHost();
    exported = (await import(pathToFileURL(tmp).href)).default;
  } catch (err) {
    const e = buildError(err, `pack ${name}: could not load its components in Node`);
    if (!err.errors) e.message += " (keep window/document access inside renderers and effects, not at module level)";
    throw e;
  } finally {
    fs.rmSync(tmp, { force: true });
  }
  const components = [].concat(exported && exported.components ? exported.components : exported || []).flat();
  if (!components.length) throw new Error(`pack ${name}: the entry module must export default { components: [...] }`);
  for (const c of components) {
    if (!c || !c.definition) throw new Error(`pack ${name}: components must be austereComponent(...) results`);
  }
  const seen = new Set();
  for (const c of components) {
    if (seen.has(c.name)) throw new Error(`pack ${name}: two components are named ${c.name}`);
    seen.add(c.name);
    if (coreNames.includes(c.name)) warnings.push(`${c.name} is already a core component; pages will use the core one`);
    if (c.slots !== null && !c.example) warnings.push(`${c.name} has no example; add one so \`components show\` can teach it`);
  }

  // 3. Catalog: signatures from a library of just the pack's components.
  const groups = [];
  for (const c of components) {
    let g = groups.find((x) => x.name === c.group);
    if (!g) groups.push((g = { name: c.group, components: [], notes: [] }));
    g.components.push(c.name);
    g.notes.push(...c.notes);
  }
  const library = createLibrary({ id: name, components: components.map((c) => c.definition), componentGroups: groups });
  const spec = library.toSpec();
  const schema = library.toJSONSchema();
  const base = catalogFromSpec(spec, {
    pack: name,
    version,
    tiers: Object.fromEntries(components.map((c) => [c.name, c.tier])),
    examples: Object.fromEntries(components.filter((c) => c.example).map((c) => [c.name, c.example])),
  });
  const bytes = fs.readFileSync(packFile);
  const catalog = {
    ...base,
    api: PACK_API,
    integrity: sri(bytes),
    size: bytes.length,
    css: Boolean(exported && typeof exported.css === "string" && exported.css),
    components: base.components.map((e) => ({ ...e, slots: components.find((c) => c.name === e.name).slots })),
    defs: reachableDefs(schema, components.map((c) => c.name)),
  };
  const catalogFile = path.join(outDir, "catalog.json");
  fs.writeFileSync(catalogFile, JSON.stringify(catalog, null, 1) + "\n");
  return { catalog, warnings, packFile, catalogFile };
}
