// Builds everything the published package needs into dist/:
//   austere.js       runtime (React + OpenUI renderer + curated library + review layer), CSS inlined
//   mermaid.min.js   lazy-loaded only by artifacts that use Mermaid
//   packs/<id>/      bundled component packs (pack.js + catalog.json), loaded by
//                    pages that call their components
//   pack-kit.mjs     builds third-party packs (`austere-axi components build`)
//   spec.json        library JSON schema for `austere-axi check`
//   prompt.md        component reference for `austere-axi spec`
//   catalog.json     every component (signature, group, tier, examples) for `components`
//   chrome/          review UI served by the local server
//   cli.mjs          the CLI + server, dependencies bundled
import * as esbuild from "esbuild";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import {
  ROOT,
  bundledPackSources,
  bundledPacksPlugin,
  estimateTokens,
  fontPlugin,
  loadLibrary,
  registryPlugin,
  slimHighlighterPlugin,
} from "./lib/plugins.mjs";

const require = createRequire(import.meta.url);
const DIST = path.join(ROOT, "dist");
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
const only = process.argv.slice(2);
const want = (step) => only.length === 0 || only.includes(step);

fs.mkdirSync(DIST, { recursive: true });

async function buildRuntime() {
  const result = await esbuild.build({
    entryPoints: [path.join(ROOT, "src/runtime/index.jsx")],
    bundle: true,
    format: "iife",
    minify: true,
    target: "es2020",
    jsx: "automatic",
    legalComments: "none",
    loader: { ".css": "text" },
    define: {
      "process.env.NODE_ENV": '"production"',
      __AUSTERE_VERSION__: JSON.stringify(pkg.version),
    },
    plugins: [fontPlugin, registryPlugin, slimHighlighterPlugin, bundledPacksPlugin(DIST)],
    outfile: path.join(DIST, "austere.js"),
    metafile: true,
    logLevel: "warning",
  });
  const size = fs.statSync(path.join(DIST, "austere.js")).size;
  console.log(`runtime  dist/austere.js ${(size / 1024 / 1024).toFixed(2)} MB`);
  return result;
}

function copyMermaid() {
  const src = path.join(path.dirname(require.resolve("mermaid/package.json")), "dist/mermaid.min.js");
  fs.copyFileSync(src, path.join(DIST, "mermaid.min.js"));
  console.log(`mermaid  dist/mermaid.min.js ${(fs.statSync(src).size / 1024 / 1024).toFixed(2)} MB`);
}

async function buildPacks() {
  const { buildPack } = await import("../src/pack-kit/index.js");
  process.env.OPENUI_TELEMETRY_DISABLED = "1";
  for (const p of bundledPackSources()) {
    const outDir = path.join(DIST, "packs", p.id);
    const { catalog, warnings } = await buildPack({ dir: p.dir, esbuild, outDir, version: pkg.version });
    for (const w of warnings) console.warn(`pack     ${p.id}: ${w}`);
    console.log(`pack     dist/packs/${p.id}/pack.js ${(catalog.size / 1024).toFixed(1)} KB (${catalog.components.map((c) => c.name).join(", ")})`);
  }
}

const packsBuilt = () => bundledPackSources().every((p) => fs.existsSync(path.join(DIST, "packs", p.id, "catalog.json")));

async function buildPackKit() {
  const out = path.join(DIST, "pack-kit.mjs");
  await esbuild.build({
    entryPoints: [path.join(ROOT, "src/pack-kit/index.js")],
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node20",
    minify: true,
    legalComments: "none",
    banner: { js: "import { createRequire as __austereRequire } from 'node:module'; const require = __austereRequire(import.meta.url);" },
    define: { "process.env.NODE_ENV": '"production"' },
    outfile: out,
    logLevel: "warning",
  });
  console.log(`packkit  dist/pack-kit.mjs ${(fs.statSync(out).size / 1024).toFixed(0)} KB`);
}

async function buildSpec() {
  const lib = await loadLibrary();
  const prompt = lib.prompt();
  // The parser validates against the library's JSON schema, not the prompt spec.
  fs.writeFileSync(path.join(DIST, "spec.json"), JSON.stringify(lib.schema()));
  fs.writeFileSync(path.join(DIST, "prompt.md"), prompt);
  fs.writeFileSync(path.join(DIST, "catalog.json"), JSON.stringify(lib.catalog(pkg.version)));
  const names = Object.keys(lib.austereLibrary.components);
  console.log(`spec     ${names.length} components, prompt ${prompt.length} chars (~${estimateTokens(prompt)} tokens)`);
}

async function buildChrome() {
  const outDir = path.join(DIST, "chrome");
  fs.mkdirSync(outDir, { recursive: true });
  await esbuild.build({
    entryPoints: [path.join(ROOT, "src/chrome/chrome.js"), path.join(ROOT, "src/chrome/chrome.css")],
    bundle: true,
    minify: true,
    format: "iife",
    target: "es2020",
    outdir: outDir,
    logLevel: "warning",
  });
  console.log("chrome   dist/chrome/");
}

async function buildCli() {
  const out = path.join(DIST, "cli.mjs");
  await esbuild.build({
    entryPoints: [path.join(ROOT, "src/cli/main.js")],
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node20",
    banner: {
      js: "#!/usr/bin/env node\nimport { createRequire as __austereRequire } from 'node:module'; const require = __austereRequire(import.meta.url);",
    },
    define: { __AUSTERE_VERSION__: JSON.stringify(pkg.version), __AUSTERE_BUNDLED__: "true" },
    outfile: out,
    logLevel: "warning",
  });
  fs.chmodSync(out, 0o755);
  console.log(`cli      dist/cli.mjs ${(fs.statSync(out).size / 1024).toFixed(0)} KB`);
}

if (want("packs") || (want("runtime") && !packsBuilt())) await buildPacks();
if (want("packkit")) await buildPackKit();
if (want("runtime")) await buildRuntime();
if (want("mermaid")) copyMermaid();
if (want("spec")) await buildSpec();
if (want("chrome") && fs.existsSync(path.join(ROOT, "src/chrome/chrome.js"))) await buildChrome();
if (want("cli") && fs.existsSync(path.join(ROOT, "src/cli/main.js"))) await buildCli();
