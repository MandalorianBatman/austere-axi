// npm run gallery [-- Name ...] — writes .dev/gallery.html with every custom
// component's example (or just the named ones), one Card each, for visual
// checks with `npm run shot` or a real review (`node dist/cli.mjs .dev/gallery.html`).
import fs from "node:fs";
import path from "node:path";
import { checkHtml } from "../src/cli/check.js";
import { ROOT, examplePage, htmlPage, loadLibrary } from "./lib/plugins.mjs";

const wanted = process.argv.slice(2);
const lib = await loadLibrary();
const picked = wanted.length ? lib.CUSTOM_COMPONENTS.filter((c) => wanted.includes(c.name)) : lib.CUSTOM_COMPONENTS;
const unknown = wanted.filter((n) => !lib.CUSTOM_COMPONENTS.some((c) => c.name === n));
if (unknown.length) {
  console.error(`not a custom component: ${unknown.join(", ")}`);
  process.exit(1);
}
const html = htmlPage("Component gallery", examplePage(picked), "../dist/austere.js");
const out = path.join(ROOT, ".dev", "gallery.html");
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, html);
const r = checkHtml(html, { schema: lib.schema() });
console.log(`gallery: ${path.relative(ROOT, out)} (${picked.map((c) => c.name).join(", ")})`);
console.log(r.ok ? "check: ok" : `check: ${JSON.stringify(r.errors, null, 1)}`);
if (!r.ok) process.exitCode = 1;
