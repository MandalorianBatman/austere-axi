// esbuild plugins and helpers shared by the build, the tests and the
// maintainer scripts.
import * as esbuild from "esbuild";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);
export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
export const COMPONENTS_DIR = path.join(ROOT, "src/runtime/components");
export const PACKS_DIR = path.join(ROOT, "packs");
const ENTRY_CANDIDATES = ["src/index.jsx", "src/index.js", "index.jsx", "index.js"];

/** Packs bundled with austere-axi: packs/<id>/ with a package.json and an entry module. */
export function bundledPackSources() {
  if (!fs.existsSync(PACKS_DIR)) return [];
  return fs
    .readdirSync(PACKS_DIR)
    .sort()
    .filter((id) => fs.existsSync(path.join(PACKS_DIR, id, "package.json")))
    .map((id) => {
      const dir = path.join(PACKS_DIR, id);
      const pkg = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8"));
      const entry = ENTRY_CANDIDATES.map((c) => path.join(dir, c)).find((f) => fs.existsSync(f));
      if (!entry) throw new Error(`packs/${id} has no entry module (${ENTRY_CANDIDATES.join(", ")})`);
      return { id, dir, name: pkg.name, entry };
    });
}

/**
 * `import bundledPacks from "austere:bundled-packs"` in the runtime → { <id>: { name, version,
 * components } } from dist/packs/<id>/catalog.json, so the runtime knows which
 * components load which bundled pack without carrying their code.
 */
export function bundledPacksPlugin(distDir) {
  return {
    name: "austere-bundled-packs",
    setup(build) {
      build.onResolve({ filter: /^austere:bundled-packs$/ }, () => ({ path: "bundled-packs", namespace: "austere-bundled-packs" }));
      build.onLoad({ filter: /.*/, namespace: "austere-bundled-packs" }, () => {
        const index = {};
        for (const { id } of bundledPackSources()) {
          const file = path.join(distDir, "packs", id, "catalog.json");
          if (!fs.existsSync(file)) throw new Error(`dist/packs/${id}/catalog.json is missing: build the packs first (node scripts/build.mjs packs)`);
          const cat = JSON.parse(fs.readFileSync(file, "utf8"));
          index[id] = { name: cat.pack, version: cat.version, components: cat.components.map((c) => c.name) };
        }
        return { contents: `export default ${JSON.stringify(index)};`, loader: "js" };
      });
    },
  };
}

/** In Node builds of the library, a bundled pack's "austere-axi/pack" import is the runtime's pack API. */
const packApiAlias = {
  name: "austere-pack-api",
  setup(build) {
    build.onResolve({ filter: /^austere-axi\/pack$/ }, () => ({ path: path.join(ROOT, "src/runtime/pack-api.js") }));
  },
};

/** Component files: every .js/.jsx in components/ whose name does not start with "_". */
export function componentFiles() {
  return fs
    .readdirSync(COMPONENTS_DIR)
    .filter((f) => /\.jsx?$/.test(f) && !f.startsWith("_"))
    .sort();
}

/**
 * `import components from "austere:components"` → every component file's
 * default export, in file order. A file exports one component, or an array
 * for a family (a container and its value-only parts, in prompt order).
 */
export const registryPlugin = {
  name: "austere-registry",
  setup(build) {
    build.onResolve({ filter: /^austere:components$/ }, () => ({ path: "components", namespace: "austere-registry" }));
    build.onLoad({ filter: /.*/, namespace: "austere-registry" }, () => {
      const files = componentFiles();
      const imports = files.map((f, i) => `import c${i} from ${JSON.stringify(`./${f}`)};`);
      const check = files.map(
        (f, i) =>
          `for (const c of [].concat(c${i})) if (!c || !c.definition) throw new Error(${JSON.stringify(
            `src/runtime/components/${f} must \`export default austereComponent({...})\` or an array of them (or start its name with "_" if it is a helper)`,
          )});`,
      );
      return {
        contents: [...imports, ...check, `export default [${files.map((_, i) => `c${i}`).join(", ")}].flat();`].join("\n"),
        resolveDir: COMPONENTS_DIR,
        loader: "js",
        watchFiles: files.map((f) => path.join(COMPONENTS_DIR, f)),
      };
    });
  },
};

function fontCss() {
  const file = require.resolve("@fontsource-variable/inter/files/inter-latin-wght-normal.woff2");
  const b64 = fs.readFileSync(file).toString("base64");
  return `@font-face{font-family:"Inter Variable";font-style:normal;font-display:swap;font-weight:100 900;src:url(data:font/woff2;base64,${b64}) format("woff2");unicode-range:U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD;}`;
}

/** Inline Inter as a data URL so artifacts render identically offline. */
export const fontPlugin = {
  name: "austere-font",
  setup(build) {
    build.onResolve({ filter: /\/font\.css$/ }, (args) => ({ path: args.path, namespace: "austere-font" }));
    build.onLoad({ filter: /.*/, namespace: "austere-font" }, () => ({ contents: fontCss(), loader: "text" }));
  },
};

// OpenUI's CodeBlock imports the full Prism build and every theme; swap in
// the light build with common languages (saves ~0.5 MB).
export const slimHighlighterPlugin = {
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

// Keep node_modules external when bundling for Node, except OpenUI component
// subpaths whose ESM uses extensionless imports Node cannot load.
const nodeExternals = {
  name: "externals",
  setup(build) {
    build.onResolve({ filter: /^[^./]/ }, (args) => {
      if (args.path.startsWith("austere:")) return undefined;
      return args.path.startsWith("@openuidev/react-ui/") && args.path !== "@openuidev/react-ui/genui-lib"
        ? undefined
        : { path: args.path, external: true };
    });
  },
};

/**
 * Bundle and import the library in Node: { austereLibrary, CUSTOM_COMPONENTS
 * (ours plus the bundled packs'), BUNDLED_PACKS, GROUPS, TIERS, EXAMPLES,
 * buildLibrary, PROMPT_OPTIONS, prompt(), catalog(version), schema() }.
 */
export async function loadLibrary() {
  const tmp = path.join(ROOT, "node_modules/.austere-build");
  fs.mkdirSync(tmp, { recursive: true });
  const out = path.join(tmp, `library-${process.pid}-${Date.now()}.mjs`);
  const packs = bundledPackSources();
  await esbuild.build({
    stdin: {
      contents: `
        import { buildLibrary, CUSTOM_COMPONENTS as CORE_COMPONENTS, groupsFor, tiersFor, examplesFor } from "./src/runtime/library.jsx";
        ${packs.map((p, i) => `import pack${i} from ${JSON.stringify("./" + path.relative(ROOT, p.entry).split(path.sep).join("/"))};`).join("\n")}
        // Bundled packs (Mermaid) are part of the core spec: no tag needed to use them.
        export const BUNDLED_PACKS = [${packs
          .map((p, i) => `{ id: ${JSON.stringify(p.id)}, name: ${JSON.stringify(p.name)}, components: [].concat(pack${i}.components || pack${i}) }`)
          .join(", ")}];
        const packComponents = BUNDLED_PACKS.flatMap((p) => p.components);
        export const CUSTOM_COMPONENTS = [...CORE_COMPONENTS, ...packComponents];
        export const austereLibrary = buildLibrary(packComponents);
        export const GROUPS = groupsFor(CUSTOM_COMPONENTS);
        export const TIERS = tiersFor(CUSTOM_COMPONENTS);
        export const EXAMPLES = examplesFor(CUSTOM_COMPONENTS);
        export { buildLibrary };
        export { catalogFromSpec, promptSpec } from "./src/shared/catalog.js";
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
    plugins: [fontPlugin, registryPlugin, packApiAlias, nodeExternals],
    outfile: out,
    logLevel: "error",
  });
  process.env.OPENUI_TELEMETRY_DISABLED = "1";
  try {
    const mod = await import(pathToFileURL(out).href);
    return {
      ...mod,
      prompt: () =>
        mod.generateSystemPrompt({ library: mod.promptSpec(mod.austereLibrary.toSpec(), mod.TIERS), promptOptions: mod.PROMPT_OPTIONS }),
      catalog: (version) => {
        const cat = mod.catalogFromSpec(mod.austereLibrary.toSpec(), { version, tiers: mod.TIERS, examples: mod.EXAMPLES });
        // Mark what a bundled pack provides, so `components` can say where it comes from.
        for (const p of mod.BUNDLED_PACKS) {
          for (const e of cat.components) if (p.components.some((c) => c.name === e.name)) e.pack = p.name;
        }
        return cat;
      },
      schema: () => ({ ...mod.austereLibrary.toJSONSchema(), root: mod.austereLibrary.root || "Stack" }),
    };
  } finally {
    fs.rmSync(out, { force: true });
  }
}

/** Rough token estimate used for the prompt budget (matches what the build prints). */
export const estimateTokens = (text) => Math.round(text.length / 3.8);

/** Wrap each component's examples (or its stress examples) in a minimal page program, one card each. */
export function examplePage(components, field = "example") {
  const cards = components
    .flatMap((c) => (c[field] || []).map((program) => ({ name: c.name, program })))
    .map(({ name, program }, i) => {
      const first = program.match(/^\s*([A-Za-z_][\w]*)\s*=/m)?.[1];
      return { id: `demo${i}`, line: `demo${i} = Card([CardHeader(${JSON.stringify(name)}), ${first}])`, program };
    });
  return [
    `root = Stack([${cards.map((c) => c.id).join(", ")}], "column", "l")`,
    ...cards.flatMap((c) => [c.line, c.program]),
  ].join("\n");
}

export function htmlPage(title, program, runtimeSrc) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${title}</title>
<script src="${runtimeSrc}"></script>
</head>
<body>
<script type="text/openui">
${program}
</script>
</body>
</html>
`;
}
