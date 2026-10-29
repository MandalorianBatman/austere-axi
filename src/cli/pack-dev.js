// Writing your own pack: `components new` scaffolds one, `components build`
// turns it into dist/pack.js + dist/catalog.json with the pack kit.
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { VERSION, packKitPath } from "./paths.js";
import { coreCatalog } from "./packs.js";
import { isValidPackName } from "../shared/packs-meta.js";

const TEMPLATE = {
  "src/index.js": `// The pack: every component it adds, plus CSS the runtime puts on the page once.
import Timeline from "./Timeline.jsx";
import css from "./style.css";

export default { components: [Timeline], css };
`,
  "src/Timeline.jsx": `// One component per file. austereComponent is the same contract the core
// components follow: PascalCase name, zod props in positional order (append
// only once published), a one-line description, an example program.
// React, zod and "austere-axi/pack" come from the page's runtime; do not
// bundle your own copies (the build maps them for you).
import React from "react";
import { z } from "zod";
import { austereComponent } from "austere-axi/pack";

function TimelineView({ props }) {
  const events = (props.events ?? []).map((line) => {
    const [when, what, ...rest] = String(line).split("|").map((s) => s.trim());
    return { when, what: what ?? "", detail: rest.join(" | ") };
  });
  return (
    <ol className="pack-timeline">
      {events.map((e, i) => (
        // data-austere-part makes each event its own annotation target.
        <li key={i} data-austere-part={e.what || e.when}>
          <time>{e.when}</time>
          <strong>{e.what}</strong>
          {e.detail ? <span>{e.detail}</span> : null}
        </li>
      ))}
    </ol>
  );
}

export default austereComponent({
  name: "Timeline",
  // A core group (Layout Content Data Charts Forms Buttons) or a category of your own.
  group: "Content",
  props: z.object({
    events: z.array(z.string()),
  }),
  description: 'Vertical timeline. events are "when | what | detail" strings, oldest first.',
  renderer: TimelineView,
  example: \`launch = Timeline(["Mon | Freeze | branch cut", "Wed | Canary | 5% of traffic", "Fri | GA"])\`,
});
`,
  "src/style.css": `.pack-timeline {
  font-size: 14px;
  list-style: none;
  margin: 0;
  padding: 0 0 0 14px;
  border-left: 2px solid #34343a;
  display: grid;
  gap: 12px;
}
.pack-timeline li {
  display: grid;
  gap: 2px;
}
.pack-timeline time {
  font-size: 12px;
  color: #8b8b94;
}
.pack-timeline span {
  color: #b4b4bc;
}
`,
};

function packageJson(name) {
  return {
    name,
    version: "0.1.0",
    description: "Components for austere-axi review pages.",
    keywords: ["austere-axi-pack"],
    license: "MIT",
    files: ["dist"],
    scripts: { build: "austere-axi components build ." },
    devDependencies: { "austere-axi": `^${VERSION}`, esbuild: "^0.28.0" },
    austere: { api: 1 },
  };
}

function readme(name) {
  return `# ${name}

Components for [austere-axi](https://github.com/MandalorianBatman/austere-axi) review pages.

\`\`\`sh
npm install
npm run build                          # dist/pack.js + dist/catalog.json
npx austere-axi components add .       # use it on this machine
npx austere-axi components show Timeline
\`\`\`

A page that uses it declares it in its head (\`austere-axi check --fix page.html\` writes this):

\`\`\`html
<meta name="austere-packs" content="${name}@0.1.0">
\`\`\`

Publish with \`npm publish\` after \`npm run build\`. Others install it with
\`austere-axi components add ${name} --trust\`.
`;
}

export function newPack(dir, { name } = {}) {
  if (!dir) throw new Error("new needs a folder: austere-axi components new austere-pack-timeline");
  const abs = path.resolve(dir);
  if (fs.existsSync(abs) && fs.readdirSync(abs).length) throw new Error(`${abs} is not empty`);
  const pkgName = name || path.basename(abs).toLowerCase().replace(/[^a-z0-9._-]+/g, "-");
  if (!isValidPackName(pkgName)) throw new Error(`${JSON.stringify(pkgName)} is not an npm package name; pass --name`);
  const files = {
    "package.json": JSON.stringify(packageJson(pkgName), null, 2) + "\n",
    "README.md": readme(pkgName),
    ".gitignore": "node_modules\n",
    ...TEMPLATE,
  };
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(abs, rel)), { recursive: true });
    fs.writeFileSync(path.join(abs, rel), text);
  }
  return { dir: abs, name: pkgName, files: Object.keys(files) };
}

/** esbuild from the pack's own node_modules, else the current folder's, else ours (development). */
async function findEsbuild(dir) {
  for (const base of [path.join(dir, "package.json"), path.join(process.cwd(), "package.json"), import.meta.url]) {
    try {
      const resolved = createRequire(base).resolve("esbuild");
      return await import(pathToFileURL(resolved).href);
    } catch {
      // next
    }
  }
  return null;
}

export async function buildPackDir(dir = ".") {
  const abs = path.resolve(dir);
  if (!fs.existsSync(path.join(abs, "package.json"))) throw new Error(`${abs} has no package.json (\`austere-axi components new <dir>\` makes a pack)`);
  const esbuild = await findEsbuild(abs);
  if (!esbuild) throw new Error(`components build needs esbuild: run \`npm install -D esbuild\` in ${abs}`);
  process.env.OPENUI_TELEMETRY_DISABLED ||= "1";
  const kit = await import(pathToFileURL(packKitPath()).href);
  const { catalog, warnings, packFile, catalogFile } = await kit.buildPack({
    dir: abs,
    esbuild,
    coreNames: coreCatalog().components.map((c) => c.name),
  });
  return {
    name: catalog.pack,
    version: catalog.version,
    components: catalog.components.map((c) => c.name),
    size: catalog.size,
    files: [packFile, catalogFile],
    warnings,
  };
}
