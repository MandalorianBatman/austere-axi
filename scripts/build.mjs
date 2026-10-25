// Builds everything the published package needs into dist/:
//   austere.js       runtime (React + OpenUI renderer + curated library + review layer), CSS inlined
//   mermaid.min.js   lazy-loaded only by artifacts that use Mermaid
//   spec.json        library JSON schema for `austere-axi check`
//   prompt.md        component reference for `austere-axi spec`
//   chrome/          review UI served by the local server
//   cli.mjs          the CLI + server, dependencies bundled
import * as esbuild from "esbuild";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DIST = path.join(ROOT, "dist");
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
const only = process.argv.slice(2);
const want = (step) => only.length === 0 || only.includes(step);

fs.mkdirSync(DIST, { recursive: true });

function fontCss() {
  const file = require.resolve("@fontsource-variable/inter/files/inter-latin-wght-normal.woff2");
  const b64 = fs.readFileSync(file).toString("base64");
  return `@font-face{font-family:"Inter Variable";font-style:normal;font-display:swap;font-weight:100 900;src:url(data:font/woff2;base64,${b64}) format("woff2");unicode-range:U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD;}`;
}

const virtualFont = {
  name: "austere-font",
  setup(build) {
    build.onResolve({ filter: /\/font\.css$/ }, (args) => ({ path: args.path, namespace: "austere-font" }));
    build.onLoad({ filter: /.*/, namespace: "austere-font" }, () => ({ contents: fontCss(), loader: "text" }));
  },
};

// OpenUI's CodeBlock imports the full Prism build and every theme; swap in
// the light build with common languages (saves ~0.5 MB).
const slimHighlighter = {
  name: "austere-slim-highlighter",
  setup(build) {
    build.onResolve({ filter: /^react-syntax-highlighter$/ }, () => ({
      path: path.join(ROOT, "src/runtime/highlighter.js"),
    }));
    build.onResolve({ filter: /^react-syntax-highlighter\/dist\/cjs\/styles\/prism(\/index\.js)?$/ }, () => ({
      path: path.join(ROOT, "src/runtime/highlighter-styles.js"),
    }));
  },
};

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
    plugins: [virtualFont, slimHighlighter],
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

async function buildSpec() {
  const tmp = path.join(ROOT, "node_modules/.austere-build");
  fs.mkdirSync(tmp, { recursive: true });
  const out = path.join(tmp, "spec-entry.mjs");
  await esbuild.build({
    stdin: {
      contents: `
        export { austereLibrary } from "./src/runtime/library.jsx";
        export { PROMPT_OPTIONS } from "./src/runtime/prompt.js";
        export { generateSystemPrompt } from "@openuidev/lang-core";
      `,
      resolveDir: ROOT,
      loader: "js",
    },
    bundle: true,
    platform: "node",
    format: "esm",
    jsx: "automatic",
    loader: { ".css": "empty", ".scss": "empty" },
    plugins: [
      virtualFont,
      {
        // Keep node_modules external, except component subpaths whose ESM uses
        // extensionless imports Node cannot load (only the bundler can).
        name: "externals",
        setup(build) {
          build.onResolve({ filter: /^[^./]/ }, (args) =>
            args.path.startsWith("@openuidev/react-ui/") && args.path !== "@openuidev/react-ui/genui-lib"
              ? undefined
              : { path: args.path, external: true },
          );
        },
      },
    ],
    outfile: out,
    logLevel: "warning",
  });
  process.env.OPENUI_TELEMETRY_DISABLED = "1";
  const mod = await import(pathToFileURL(out).href + `?t=${Date.now()}`);
  const spec = mod.austereLibrary.toSpec();
  const prompt = mod.generateSystemPrompt({ library: spec, promptOptions: mod.PROMPT_OPTIONS });
  // The parser validates against the library's JSON schema, not the prompt spec.
  const schema = { ...mod.austereLibrary.toJSONSchema(), root: mod.austereLibrary.root || "Stack" };
  fs.writeFileSync(path.join(DIST, "spec.json"), JSON.stringify(schema));
  fs.writeFileSync(path.join(DIST, "prompt.md"), prompt);
  const names = Object.keys(spec.components || {});
  console.log(`spec     ${names.length} components, prompt ${prompt.length} chars (~${Math.round(prompt.length / 3.8)} tokens)`);
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

if (want("runtime")) await buildRuntime();
if (want("mermaid")) copyMermaid();
if (want("spec")) await buildSpec();
if (want("chrome") && fs.existsSync(path.join(ROOT, "src/chrome/chrome.js"))) await buildChrome();
if (want("cli") && fs.existsSync(path.join(ROOT, "src/cli/main.js"))) await buildCli();
