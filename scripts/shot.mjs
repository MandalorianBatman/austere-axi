// npm run shot -- <file.html|url> [--out shot.png] [--width 1280] [--height 900] [--full] [--parts]
//
// Renders an artifact headlessly with the freshly built runtime (requests for
// austere.js / mermaid.min.js, including the CDN tag, are served from dist/)
// and saves a screenshot. Prints page errors, render errors, and with --parts
// every data-austere-part a reviewer could click, grouped by statement.
//
// Browser: CHROME_PATH if set, otherwise an installed Chrome (channel "chrome").
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { launchBrowser } from "./lib/browser.mjs";
import { ROOT } from "./lib/plugins.mjs";

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  if (i < 0) return fallback;
  const v = args[i + 1];
  return v && !v.startsWith("--") ? v : true;
};
const target = args.find((a, i) => !a.startsWith("--") && !(i > 0 && args[i - 1].startsWith("--") && !["--full", "--parts"].includes(args[i - 1])));
if (!target) {
  console.error("usage: npm run shot -- <file.html|url> [--out shot.png] [--width 1280] [--height 900] [--full] [--parts]");
  process.exit(2);
}
const url = /^https?:|^file:/.test(target) ? target : pathToFileURL(path.resolve(target)).href;
const width = Number(flag("width", 1280));
const height = Number(flag("height", 900));
const out = flag("out", path.join(ROOT, ".dev", `shot-${width}.png`));

const { browser, reason } = await launchBrowser();
if (!browser) {
  console.error(`Could not start a browser: ${reason}`);
  process.exit(2);
}
const page = await browser.newPage({ viewport: { width, height } });
const problems = [];
page.on("pageerror", (e) => problems.push(`pageerror: ${e.message}`));
page.on("console", (m) => {
  if (m.type() === "error" || (m.type() === "warning" && m.text().startsWith("[austere]"))) problems.push(`console: ${m.text()}`);
});
await page.route(/\/(austere|mermaid\.min)\.js(\?.*)?$/, (route) => {
  const name = /mermaid/.test(route.request().url()) ? "mermaid.min.js" : "austere.js";
  route.fulfill({ path: path.join(ROOT, "dist", name), contentType: "text/javascript" });
});
await page.goto(url, { waitUntil: "load" });
await page.waitForTimeout(1500);
const info = await page.evaluate(() => {
  const parts = {};
  for (const el of document.querySelectorAll("[data-austere-part]")) {
    const id = el.closest("[data-oui-id]")?.getAttribute("data-oui-id") || "(none)";
    (parts[id] ||= []).push(el.getAttribute("data-austere-part"));
  }
  return {
    statements: document.querySelectorAll("[data-oui-id]").length,
    renderErrors: Array.from(document.querySelectorAll(".austere-render-error")).map((e) => e.textContent.trim()),
    overflowX: document.documentElement.scrollWidth > window.innerWidth + 1,
    parts,
  };
});
fs.mkdirSync(path.dirname(out), { recursive: true });
await page.screenshot({ path: out, fullPage: !!flag("full", false) });
await browser.close();

console.log(`screenshot: ${out}`);
console.log(`rendered statements: ${info.statements}`);
if (info.overflowX) console.log(`WARNING: page scrolls horizontally at ${width}px`);
for (const e of info.renderErrors) console.log(`render error: ${e}`);
for (const p of problems) console.log(p);
if (flag("parts", false)) {
  for (const [id, list] of Object.entries(info.parts)) {
    console.log(`parts in ${id}: ${list.slice(0, 12).join(" | ")}${list.length > 12 ? ` (+${list.length - 12})` : ""}`);
  }
  if (!Object.keys(info.parts).length) console.log("parts: none");
}
if (info.renderErrors.length || problems.some((p) => p.startsWith("pageerror"))) process.exitCode = 1;
