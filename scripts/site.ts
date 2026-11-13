// npm run site — builds the public website into _site/ (deployed by .github/workflows/pages.yml).
//
//   site/**             copied as is; every .html goes through render() for {{root}}, {{nav}}, {{hero}}, {{version}}
//   dist/austere.js ... the runtime and the bundled packs, so live pages load them from the site itself
//   gallery/<id>.html   each file in examples/, with its runtime tag pointed at ../austere.js
//   gallery/thumbs/     screenshots of those pages, taken by scripts/shot.ts (which also fails on render errors)
//   gallery/index.html  thumbnail, OpenUI Lang source and token count for each example
//   assets/hero.png     the landing page's screenshot, unless docs/demo.gif exists (copied to assets/demo.gif)
//   assets/social-preview.png  og:image, copied from docs/social-preview.png when present (else hero.png)
//   copy.js             site/copy.ts compiled (site/*.ts sources are not copied)
//   play/play.js        site/play/*.ts bundled (the parser, checker and editor), with play/data.json beside it:
//                       spec, component catalog and a starter template per example
//
// Needs `npm run build` first, and Chrome or CHROME_PATH (same as `npm run shot`).
// Nothing here is published to npm: package.json `files` lists neither site/ nor _site/.
import * as esbuild from "esbuild";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { escapeHtml, readArtifact, rewriteRuntime } from "../src/cli/artifact.ts";
import { checkHtml } from "../src/cli/check.ts";
import { IIFE_TSCONFIG, ROOT, estimateTokens } from "./lib/plugins.ts";

interface Example {
  id: string;
  title: string;
  description: string;
  program: string;
  tokens: number;
  statements: number;
  check: ReturnType<typeof checkHtml>;
  live: string;
}

interface ShotResult {
  code: number | null;
  output: string;
}

const SITE = path.join(ROOT, "site");
const DIST = path.join(ROOT, "dist");
const EXAMPLES = path.join(ROOT, "examples");
const OUT = path.join(ROOT, "_site");
const DEMO_GIF = path.join(ROOT, "docs", "demo.gif");
const SOCIAL = path.join(ROOT, "docs", "social-preview.png");
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")) as { version: string };

const REPO = "https://github.com/MandalorianBatman/austere-axi";
const THUMB = { width: 1280, height: 800 };
const HERO_EXAMPLE = "session-migration";
// Gallery order. Examples not listed follow, alphabetically.
const ORDER = ["session-migration", "incident-postmortem", "api-design-review", "pr-summary", "sprint-plan", "code-review", "shadcn"];
const NAV = [
  { href: "play/", label: "Play" },
  { href: "gallery/", label: "Gallery" },
  { href: REPO, label: "GitHub" },
  { href: "https://www.npmjs.com/package/austere-axi", label: "npm" },
  { href: "https://skills.sh/mandalorianbatman/austere-axi", label: "skills.sh" },
];

for (const f of ["austere.js", "spec.json", "catalog.json"]) {
  if (!fs.existsSync(path.join(DIST, f))) {
    console.error(`dist/${f} is missing: run \`npm run build\` first`);
    process.exit(2);
  }
}

const formatInt = (n: number): string => n.toLocaleString("en-US");
const decode = (s: string): string => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&");

/** Fill the placeholders of a site page. `rel` is the page's path inside _site/, with forward slashes. */
function render(html: string, rel: string, vars: Record<string, string> = {}): string {
  const depth = rel.split("/").length - 1;
  const root = "../".repeat(depth);
  const current = rel === "gallery/index.html" ? "gallery/" : rel.replace(/index\.html$/, "");
  const nav = `<nav class="site-nav" aria-label="Main">${NAV.map((n) => {
    const href = /^https?:/.test(n.href) ? n.href : `{{root}}${n.href}`;
    return `<a href="${href}"${n.href === current ? ' aria-current="page"' : ""}>${escapeHtml(n.label)}</a>`;
  }).join("")}</nav>`;
  const all = { nav, version: pkg.version, ...vars };
  let out = html;
  for (const [key, value] of Object.entries(all)) out = out.replaceAll(`{{${key}}}`, () => value);
  return out.replaceAll("{{root}}", root);
}

function* htmlFiles(dir: string): Generator<string> {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* htmlFiles(file);
    else if (entry.name.endsWith(".html")) yield file;
  }
}

/** Run scripts/shot.ts on a page; it exits non-zero on render errors and page errors. */
function shot(file: string, out: string, { width, height }: { width: number; height: number }): Promise<ShotResult> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(ROOT, "scripts/shot.ts"), file, "--out", out, "--width", String(width), "--height", String(height)], {
      cwd: ROOT,
      env: process.env,
    });
    let output = "";
    child.stdout.on("data", (d) => (output += d));
    child.stderr.on("data", (d) => (output += d));
    child.on("close", (code) => resolve({ code, output: output.trim() }));
  });
}

async function pool<T, R>(items: T[], size: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(size, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        results[i] = await fn(items[i]);
      }
    }),
  );
  return results;
}

function loadExamples(): Example[] {
  const ids = fs
    .readdirSync(EXAMPLES)
    .filter((f) => f.endsWith(".html"))
    .map((f) => f.slice(0, -".html".length));
  const rank = (id: string) => (ORDER.includes(id) ? ORDER.indexOf(id) : ORDER.length);
  ids.sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
  return ids.map((id) => {
    const html = fs.readFileSync(path.join(EXAMPLES, `${id}.html`), "utf8");
    const art = readArtifact(html);
    if (art.program === null) throw new Error(`examples/${id}.html has no <script type="text/openui"> block`);
    const description = /<meta\s+name=["']description["']\s+content=["']([^"']*)["']/i.exec(html)?.[1];
    const program = art.program.trim();
    const result = checkHtml(html);
    return {
      id,
      title: art.title || id,
      description: description ? decode(description) : "",
      program,
      tokens: estimateTokens(program),
      statements: result.statements,
      check: result,
      live: rewriteRuntime(html, '<script src="../austere.js"></script>'),
    };
  });
}

function galleryPage(examples: Example[]): string {
  const entries = examples.map((ex) => {
    const alt = `Screenshot of the ${ex.title} page`;
    return `<article class="entry" id="${ex.id}">
  <div>
    <a class="thumb" href="${ex.id}.html"><img src="thumbs/${ex.id}.png" width="${THUMB.width}" height="${THUMB.height}" loading="lazy" alt="${escapeHtml(alt)}"><span>Open live page</span></a>
    <h2>${escapeHtml(ex.title)}</h2>
    ${ex.description ? `<p class="desc">${escapeHtml(ex.description)}</p>` : ""}
    <ul class="stats">
      <li class="tokens">~${formatInt(ex.tokens)} tokens</li>
      <li>${ex.statements} statements</li>
      <li>passes <code>austere-axi check</code></li>
    </ul>
    <p class="links-row"><a href="${ex.id}.html">Live page</a> · <a href="${REPO}/blob/main/examples/${ex.id}.html">Source file on GitHub</a></p>
  </div>
  <div class="source">
    <h3>OpenUI Lang source</h3>
    <pre tabindex="0"><code>${escapeHtml(ex.program)}</code></pre>
  </div>
</article>`;
  });
  const index = examples.map((ex) => `<li><a href="#${ex.id}">${escapeHtml(ex.title)}</a></li>`).join("");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Gallery · austere-axi</title>
<meta name="description" content="Review pages written in OpenUI Lang: an incident postmortem, an API design review, a PR summary, a sprint plan and more, each next to its source and token count.">
<link rel="stylesheet" href="{{root}}site.css">
<link rel="icon" href="{{root}}favicon.svg" type="image/svg+xml">
</head>
<body>
<header class="site-header">
  <div class="wrap">
    <a class="brand" href="{{root}}">austere-axi</a>
    {{nav}}
  </div>
</header>
<main class="wrap">
  <div class="page-head">
    <h1>Gallery</h1>
    <p>Every page here is a plain <code>.html</code> file: one runtime script tag and one OpenUI Lang program. The thumbnails are screenshots taken at build time. Open one to see the live page. Token counts are estimates of the program text (characters ÷ 3.8).</p>
    <p>Buttons and forms do nothing on this site. Under <code>austere-axi &lt;file&gt;</code> they send your choices to the agent.</p>
    <ul class="index">${index}</ul>
  </div>
${entries.join("\n")}
</main>
<footer class="site-footer">
  <div class="wrap">
    <span>austere-axi v{{version}} · MIT license</span>
    <span><a href="${REPO}">Source on GitHub</a></span>
  </div>
</footer>
</body>
</html>
`;
}

function heroHtml(example: Example): string {
  const gif = fs.existsSync(DEMO_GIF);
  const src = gif ? "assets/demo.gif" : "assets/hero.png";
  const alt = gif ? "Demo: an agent writes a page, the reviewer clicks a part and sends a note." : `The ${example.title} page, rendered by austere-axi.`;
  const caption = gif
    ? "The review loop in about 30 seconds."
    : `A real page: ${example.title.toLowerCase()}, written in about ${formatInt(Math.round(example.tokens / 50) * 50)} tokens. <a href="{{root}}gallery/${example.id}.html">Open the live page</a>.`;
  return `<a class="shot" href="{{root}}gallery/${example.id}.html">
        <div class="shot-bar"><i></i><i></i><i></i><span>austere-axi plan.html</span></div>
        <img src="{{root}}${src}" width="${THUMB.width}" height="${THUMB.height}" alt="${escapeHtml(alt)}">
      </a>
      <p class="shot-caption">${caption}</p>`;
}

// 1. Examples must pass `check` before anything is written.
const examples = loadExamples();
const failed = examples.filter((ex) => !ex.check.ok);
for (const ex of failed) console.error(`examples/${ex.id}.html fails check:\n${JSON.stringify(ex.check.errors, null, 1)}`);
for (const ex of examples) for (const w of ex.check.warnings || []) console.warn(`examples/${ex.id}.html: ${w.message || JSON.stringify(w)}`);
if (failed.length) process.exit(1);
const heroExample = examples.find((ex) => ex.id === HERO_EXAMPLE) || examples[0];

// 2. Static files, runtime and live pages.
fs.rmSync(OUT, { recursive: true, force: true });
// The playground's modules are bundled below; their sources stay out of the site.
fs.cpSync(SITE, OUT, { recursive: true, filter: (src) => !src.endsWith(".ts") });
// site/copy.ts is a plain page script: compiled, not bundled.
await esbuild.build({
  entryPoints: [path.join(SITE, "copy.ts")],
  outfile: path.join(OUT, "copy.js"),
  format: "iife",
  target: "es2022",
  tsconfigRaw: IIFE_TSCONFIG,
  logLevel: "warning",
});
fs.writeFileSync(path.join(OUT, ".nojekyll"), "");
fs.copyFileSync(path.join(DIST, "austere.js"), path.join(OUT, "austere.js"));
const packsDir = path.join(DIST, "packs");
for (const id of fs.existsSync(packsDir) ? fs.readdirSync(packsDir) : []) {
  fs.mkdirSync(path.join(OUT, "packs", id), { recursive: true });
  fs.copyFileSync(path.join(packsDir, id, "pack.js"), path.join(OUT, "packs", id, "pack.js"));
}
fs.mkdirSync(path.join(OUT, "gallery", "thumbs"), { recursive: true });
fs.mkdirSync(path.join(OUT, "assets"), { recursive: true });
for (const ex of examples) fs.writeFileSync(path.join(OUT, "gallery", `${ex.id}.html`), ex.live);

// The playground (site/play/): its modules are bundled into one file, and the data it needs
// (the parser's schema, the component catalog, one template per example) sits beside it.
await esbuild.build({
  entryPoints: [path.join(SITE, "play", "play.ts")],
  outfile: path.join(OUT, "play", "play.js"),
  bundle: true,
  format: "esm",
  target: "es2022",
  minify: true,
  legalComments: "none",
  logLevel: "warning",
});
const readJson = (name: string): unknown => JSON.parse(fs.readFileSync(path.join(DIST, name), "utf8"));
fs.writeFileSync(
  path.join(OUT, "play", "data.json"),
  JSON.stringify({
    version: pkg.version,
    spec: readJson("spec.json"),
    catalog: readJson("catalog.json"),
    templates: examples.map(({ id, title, description, program }) => ({ id, title, description, program })),
  }),
);
// 3. Screenshots, from the pages as deployed. shot.ts fails on render errors.
const jobs = examples.map((ex) => ({ ex, file: path.join(OUT, "gallery", `${ex.id}.html`), out: path.join(OUT, "gallery", "thumbs", `${ex.id}.png`) }));
const shots = await pool(jobs, 4, async (job) => ({ job, ...(await shot(job.file, job.out, THUMB)) }));
const broken = shots.filter((s) => s.code !== 0);
for (const s of broken) console.error(`gallery/${s.job.ex.id}.html did not render cleanly (exit ${s.code}):\n${s.output}`);
if (broken.length) process.exit(1);
fs.copyFileSync(path.join(OUT, "gallery", "thumbs", `${heroExample.id}.png`), path.join(OUT, "assets", "hero.png"));
if (fs.existsSync(DEMO_GIF)) fs.copyFileSync(DEMO_GIF, path.join(OUT, "assets", "demo.gif"));
const social = fs.existsSync(SOCIAL);
if (social) fs.copyFileSync(SOCIAL, path.join(OUT, "assets", "social-preview.png"));

// 4. Pages: the site's own, then the generated gallery.
fs.writeFileSync(path.join(OUT, "gallery", "index.html"), galleryPage(examples));
for (const file of htmlFiles(OUT)) {
  const rel = path.relative(OUT, file).split(path.sep).join("/");
  if (rel.startsWith("gallery/") && rel !== "gallery/index.html") continue; // live examples are artifacts, not site pages
  fs.writeFileSync(file, render(fs.readFileSync(file, "utf8"), rel, { hero: heroHtml(heroExample), ogImage: social ? "social-preview.png" : "hero.png" }));
}

console.log(`site: ${path.relative(ROOT, OUT)}/ (${examples.length} examples)`);
for (const ex of examples) console.log(`  gallery/${ex.id}.html  ~${formatInt(ex.tokens)} tokens, ${ex.statements} statements`);
