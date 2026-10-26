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

/** Component files: every .js/.jsx in components/ whose name does not start with "_". */
export function componentFiles() {
  return fs
    .readdirSync(COMPONENTS_DIR)
    .filter((f) => /\.jsx?$/.test(f) && !f.startsWith("_"))
    .sort();
}

/** `import components from "austere:components"` → array of every component file's default export. */
export const registryPlugin = {
  name: "austere-registry",
  setup(build) {
    build.onResolve({ filter: /^austere:components$/ }, () => ({ path: "components", namespace: "austere-registry" }));
    build.onLoad({ filter: /.*/, namespace: "austere-registry" }, () => {
      const files = componentFiles();
      const imports = files.map((f, i) => `import c${i} from ${JSON.stringify(path.join(COMPONENTS_DIR, f))};`);
      const check = files.map(
        (f, i) =>
          `if (!c${i} || !c${i}.definition) throw new Error(${JSON.stringify(
            `src/runtime/components/${f} must \`export default austereComponent({...})\` (or start its name with "_" if it is a helper)`,
          )});`,
      );
      return {
        contents: [...imports, ...check, `export default [${files.map((_, i) => `c${i}`).join(", ")}];`].join("\n"),
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
 * Bundle and import the library in Node: { austereLibrary, CUSTOM_COMPONENTS,
 * GROUPS, PROMPT_OPTIONS, generateSystemPrompt, prompt() }.
 */
export async function loadLibrary() {
  const tmp = path.join(ROOT, "node_modules/.austere-build");
  fs.mkdirSync(tmp, { recursive: true });
  const out = path.join(tmp, `library-${process.pid}-${Date.now()}.mjs`);
  await esbuild.build({
    stdin: {
      contents: `
        export { austereLibrary, CUSTOM_COMPONENTS, GROUPS } from "./src/runtime/library.jsx";
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
    plugins: [fontPlugin, registryPlugin, nodeExternals],
    outfile: out,
    logLevel: "error",
  });
  process.env.OPENUI_TELEMETRY_DISABLED = "1";
  try {
    const mod = await import(pathToFileURL(out).href);
    return {
      ...mod,
      prompt: () =>
        mod.generateSystemPrompt({ library: mod.austereLibrary.toSpec(), promptOptions: mod.PROMPT_OPTIONS }),
      schema: () => ({ ...mod.austereLibrary.toJSONSchema(), root: mod.austereLibrary.root || "Stack" }),
    };
  } finally {
    fs.rmSync(out, { force: true });
  }
}

/** Rough token estimate used for the prompt budget (matches what the build prints). */
export const estimateTokens = (text) => Math.round(text.length / 3.8);

/** Wrap each component's example (or its stress example) in a minimal page program. */
export function examplePage(components, field = "example") {
  const cards = components
    .filter((c) => c[field])
    .map((c, i) => {
      const first = c[field].match(/^\s*([A-Za-z_][\w]*)\s*=/m)?.[1];
      return { id: `demo${i}`, line: `demo${i} = Card([CardHeader(${JSON.stringify(c.name)}), ${first}])`, program: c[field] };
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
