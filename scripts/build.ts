// Builds everything the published package needs into dist/:
//   austere.js       runtime (React + OpenUI renderer + curated library + review layer), CSS inlined
//   packs/<id>/      bundled component packs (pack.js + catalog.json), loaded by
//                    pages that call their components
//   pack-kit.mjs     builds third-party packs (`austere-axi components build`)
//   spec.json        library JSON schema for `austere-axi check`
//   prompt.md        component reference for `austere-axi spec`
//   catalog.json     every component (signature, group, tier, examples) for `components`
//   chrome/          review UI and the hub shell, served by the local server
//   cli.mjs          the CLI + server, dependencies bundled
//   sync.mjs         hosted-page sync protocol ("austere-axi/sync"), zod bundled
//   harness/omp.js   the omp / Pi extension that wakes an idle agent session; .js, which omp's extensions/ folder loads
//   harness/copilot/extension.mjs   the same for Copilot CLI; link the folder into ~/.copilot/extensions/
//   harness/opencode.js   the same for OpenCode; link it into ~/.config/opencode/plugins/
import * as esbuild from "esbuild";
import fs from "node:fs";
import path from "node:path";
import {
  IIFE_TSCONFIG,
  ROOT,
  bundledPackSources,
  bundledPacksPlugin,
  chromeFontsPlugin,
  estimateTokens,
  fontPlugin,
  loadLibrary,
  registryPlugin,
  slimHighlighterPlugin,
  tailwindPlugin,
  zodLocalesPlugin,
} from "./lib/plugins.ts";
import { guideStubPlugin } from "../src/pack-kit/shim.ts";

const DIST = path.join(ROOT, "dist");
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")) as {
  version: string;
};
const only = process.argv.slice(2);
const want = (step: string): boolean => only.length === 0 || only.includes(step);

// A full build starts empty, so output an older build made (a removed pack, a dropped asset) cannot ship in the package.
if (only.length === 0) fs.rmSync(DIST, { recursive: true, force: true });
fs.mkdirSync(DIST, { recursive: true });

async function buildRuntime() {
  const result = await esbuild.build({
    entryPoints: [path.join(ROOT, "src/runtime/index.tsx")],
    bundle: true,
    format: "iife",
    minify: true,
    target: "es2020",
    jsx: "automatic",
    legalComments: "none",
    loader: { ".css": "text" },
    tsconfigRaw: IIFE_TSCONFIG,
    define: {
      "process.env.NODE_ENV": '"production"',
      __AUSTERE_VERSION__: JSON.stringify(pkg.version),
    },
    plugins: [
      fontPlugin,
      registryPlugin,
      slimHighlighterPlugin,
      zodLocalesPlugin,
      bundledPacksPlugin(DIST),
      // Usage guides are catalog text (`components show`); the page never reads them.
      guideStubPlugin,
    ],
    // One runtime per page: a second copy (an exported page, which inlines one, opened for
    // review) would render the page twice and open two annotate boxes. The first sets
    // window.__austere; any later copy does nothing.
    banner: { js: "if(!window.__austere){" },
    footer: { js: "}" },
    outfile: path.join(DIST, "austere.js"),
    metafile: true,
    logLevel: "warning",
  });
  const size = fs.statSync(path.join(DIST, "austere.js")).size;
  console.log(`runtime  dist/austere.js ${(size / 1024 / 1024).toFixed(2)} MB`);
  return result;
}

async function buildPacks() {
  const { buildPack } = await import("../src/pack-kit/index.ts");
  process.env.OPENUI_TELEMETRY_DISABLED = "1";
  // A pack removed from packs/ must not linger in dist/, where the CLI and runtime would still find it.
  fs.rmSync(path.join(DIST, "packs"), { recursive: true, force: true });
  for (const p of bundledPackSources()) {
    const outDir = path.join(DIST, "packs", p.id);
    const { catalog, warnings } = await buildPack({
      dir: p.dir,
      esbuild,
      outDir,
      version: pkg.version,
    });
    for (const w of warnings) console.warn(`pack     ${p.id}: ${w}`);
    console.log(
      `pack     dist/packs/${p.id}/pack.js ${(catalog.size / 1024).toFixed(1)} KB (${catalog.components.map((c) => c.name).join(", ")})`,
    );
  }
}

const packsBuilt = () =>
  bundledPackSources().every((p) => fs.existsSync(path.join(DIST, "packs", p.id, "catalog.json")));

async function buildPackKit() {
  const out = path.join(DIST, "pack-kit.mjs");
  await esbuild.build({
    entryPoints: [path.join(ROOT, "src/pack-kit/index.ts")],
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node20",
    minify: true,
    legalComments: "none",
    banner: {
      js: "import { createRequire as __austereRequire } from 'node:module'; const require = __austereRequire(import.meta.url);",
    },
    define: { "process.env.NODE_ENV": '"production"' },
    outfile: out,
    logLevel: "warning",
  });
  console.log(`packkit  dist/pack-kit.mjs ${(fs.statSync(out).size / 1024).toFixed(0)} KB`);
}

// "austere-axi/sync" for austere-cloud and the CLI: platform-neutral ESM (Workers, browsers, Node), zod inside.
async function buildSync() {
  const out = path.join(DIST, "sync.mjs");
  await esbuild.build({
    entryPoints: [path.join(ROOT, "src/shared/sync.ts")],
    bundle: true,
    platform: "neutral",
    format: "esm",
    target: "es2022",
    minify: true,
    legalComments: "none",
    plugins: [zodLocalesPlugin],
    outfile: out,
    logLevel: "warning",
  });
  console.log(`sync     dist/sync.mjs ${(fs.statSync(out).size / 1024).toFixed(0)} KB`);
}

async function buildSpec() {
  const lib = await loadLibrary();
  const prompt = lib.prompt();
  // The parser validates against the library's JSON schema, not the prompt spec.
  fs.writeFileSync(path.join(DIST, "spec.json"), JSON.stringify(lib.schema()));
  fs.writeFileSync(path.join(DIST, "prompt.md"), prompt);
  fs.writeFileSync(path.join(DIST, "catalog.json"), JSON.stringify(lib.catalog(pkg.version)));
  const names = Object.keys(lib.austereLibrary.components);
  console.log(
    `spec     ${names.length} components, prompt ${prompt.length} chars (~${estimateTokens(prompt)} tokens)`,
  );
}

async function buildChrome() {
  const outDir = path.join(DIST, "chrome");
  fs.mkdirSync(outDir, { recursive: true });
  await esbuild.build({
    entryPoints: ["chrome.ts", "chrome.css", "shell.tsx", "shell.css"].map((f) =>
      path.join(ROOT, "src/chrome", f),
    ),
    bundle: true,
    minify: true,
    format: "iife",
    target: "es2020",
    jsx: "automatic",
    tsconfigRaw: IIFE_TSCONFIG,
    alias: { "@": path.join(ROOT, "src") },
    define: { "process.env.NODE_ENV": '"production"' },
    outdir: outDir,
    // The hosted page socket reads frames with the sync module, which bundles zod.
    plugins: [chromeFontsPlugin, tailwindPlugin, zodLocalesPlugin],
    logLevel: "warning",
  });
  console.log("chrome   dist/chrome/");
}

async function buildCli() {
  const out = path.join(DIST, "cli.mjs");
  await esbuild.build({
    entryPoints: [path.join(ROOT, "src/cli/main.ts")],
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

// The harness extensions that wake an idle agent session: loaded by the harness, node builtins only.
// omp / Pi (Bun) loads a .js file; Copilot CLI loads `<name>/extension.mjs` and provides its SDK;
// OpenCode (Bun) loads `*.js` and `*.ts` from its plugins/ folders.
async function buildHarness() {
  const builds = [
    { entry: "src/harness/omp.ts", out: "harness/omp.js" },
    { entry: "src/harness/copilot-extension.ts", out: "harness/copilot/extension.mjs" },
    { entry: "src/harness/opencode-plugin.ts", out: "harness/opencode.js" },
  ];
  for (const b of builds) {
    const out = path.join(DIST, b.out);
    await esbuild.build({
      entryPoints: [path.join(ROOT, b.entry)],
      bundle: true,
      platform: "node",
      format: "esm",
      target: "node20",
      external: ["@github/copilot-sdk", "@github/copilot-sdk/*"],
      outfile: out,
      logLevel: "warning",
    });
    console.log(`harness  dist/${b.out} ${(fs.statSync(out).size / 1024).toFixed(0)} KB`);
  }
}

if (want("packs") || (want("runtime") && !packsBuilt())) await buildPacks();
if (want("packkit")) await buildPackKit();
if (want("sync")) await buildSync();
if (want("runtime")) await buildRuntime();
if (want("spec")) await buildSpec();
if (want("chrome") && fs.existsSync(path.join(ROOT, "src/chrome/chrome.ts"))) await buildChrome();
if (want("cli") && fs.existsSync(path.join(ROOT, "src/cli/main.ts"))) await buildCli();
if (want("harness")) await buildHarness();
