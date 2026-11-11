// npm run build && npm run social [-- --out docs/social-preview.png]
//
// Renders the 1200x630 social preview image (GitHub repo settings → Social preview,
// Open Graph / Twitter card on the site): the headline, the one-line pitch, and a real
// render of the demo page (scripts/lib/demo-page.mjs) with a reviewer's note pinned to the
// Postgres node. Needs Chrome or CHROME_PATH (as `npm run shot`) and `npm run build`.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { launchBrowser } from "./lib/browser.mjs";
import { PAGE } from "./lib/demo-page.mjs";
import { ROOT } from "./lib/plugins.mjs";

const args = process.argv.slice(2);
const outArg = args.indexOf("--out");
const OUT = path.resolve(ROOT, outArg >= 0 ? args[outArg + 1] : "docs/social-preview.png");
const runtime = path.join(ROOT, "dist", "austere.js");
if (!fs.existsSync(runtime)) {
  console.error("dist/austere.js is missing: run npm run build first");
  process.exit(2);
}

const { browser, reason } = await launchBrowser();
if (!browser) {
  console.error(`Could not start a browser: ${reason}`);
  process.exit(2);
}
try {
  // 1. The real artifact, rendered with the freshly built runtime.
  const PANEL_W = 600; // as placed on the card
  const SHOT_W = 1000; // rendered wide (diagram runs left to right), shown scaled down
  const SCALE = PANEL_W / SHOT_W;
  const PANEL_H = 410;
  const WIN_TOP = Math.round((630 - (PANEL_H + 38)) / 2);
  const shot = await browser.newPage({ viewport: { width: SHOT_W, height: Math.round(PANEL_H / SCALE) }, deviceScaleFactor: 1.5 });
  await shot.route(/\/(austere\.js|mermaid\.min\.js|packs\/[\w-]+\/pack\.js)(\?.*)?$/, (route) => {
    const name = /\/(austere\.js|mermaid\.min\.js|packs\/[\w-]+\/pack\.js)(\?.*)?$/.exec(route.request().url())[1];
    route.fulfill({ path: path.join(ROOT, "dist", name), contentType: "text/javascript" });
  });
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "austere-social-"));
  fs.writeFileSync(path.join(tmp, "plan.html"), PAGE);
  await shot.goto(pathToFileURL(path.join(tmp, "plan.html")).href);
  await shot.waitForSelector('[data-oui-id="pg"]');
  await shot.waitForTimeout(1200);
  const png = await shot.screenshot();
  const pg = await shot.locator('[data-oui-id="pg"]').first().boundingBox();
  await shot.close();
  fs.rmSync(tmp, { recursive: true, force: true });

  // 2. The card.
  const BUBBLE_W = 300;
  const bubbleX = Math.min(Math.round((pg.x + pg.width * 0.5) * SCALE - 40), PANEL_W - BUBBLE_W - 20);
  const bubbleY = Math.round((pg.y + pg.height) * SCALE + 12);
  const html = `<!doctype html><meta charset="utf-8"><style>
*{box-sizing:border-box}html,body{margin:0}
body{width:1200px;height:630px;overflow:hidden;position:relative;background:radial-gradient(900px 500px at 85% 0%,#1b2236 0%,#0c0c0f 60%);color:#f2f2f5;font-family:Inter,"Helvetica Neue",Arial,system-ui,sans-serif}
.left{position:absolute;left:72px;top:0;width:470px;height:630px;display:flex;flex-direction:column;justify-content:center}
.tag{font:600 15px/1 ui-monospace,"DejaVu Sans Mono",monospace;letter-spacing:.14em;text-transform:uppercase;color:#8fb4ff;margin-bottom:26px}
h1{margin:0 0 26px;font-size:76px;line-height:1;letter-spacing:-.035em;font-weight:700}
p{margin:0;font-size:29px;line-height:1.35;color:#b9b9c4}
p b{color:#f2f2f5;font-weight:600}
.cmd{margin-top:38px;display:inline-block;align-self:flex-start;font:20px/1 ui-monospace,"DejaVu Sans Mono",monospace;color:#d8d8e0;background:#16161b;border:1px solid #2a2a33;border-radius:10px;padding:14px 18px}
.cmd i{color:#7ee2a0;font-style:normal}
.win{position:absolute;left:590px;top:${WIN_TOP}px;width:${PANEL_W + 2}px;height:${PANEL_H + 38}px;border-radius:14px;overflow:hidden;border:1px solid #30303a;background:#0c0c0c;box-shadow:0 30px 80px rgba(0,0,0,.6)}
.win .bar{height:38px;display:flex;align-items:center;gap:7px;padding:0 14px;background:#131318;border-bottom:1px solid #26262e;font:13px system-ui,sans-serif;color:#7c7c88}
.win .bar i{width:11px;height:11px;border-radius:50%;background:#2c2c36}
.win img{display:block;width:${PANEL_W}px;height:${PANEL_H}px}
.note{position:absolute;left:${590 + 1 + bubbleX}px;top:${WIN_TOP + 38 + bubbleY}px;width:${BUBBLE_W}px;background:#f6f6f8;color:#15151a;border-radius:12px;padding:14px 16px;box-shadow:0 14px 40px rgba(0,0,0,.55);font-size:19px;line-height:1.35}
.note small{display:block;color:#5d5d6a;font:600 12px/1 ui-monospace,monospace;letter-spacing:.04em;margin-bottom:8px}
.note:before{content:"";position:absolute;left:${Math.round((pg.x + pg.width * 0.5) * SCALE) - bubbleX - 9}px;top:-9px;width:18px;height:18px;background:#f6f6f8;transform:rotate(45deg);border-radius:3px}
</style>
<div class="left"><div class="tag">Agent review pages</div><h1>austere-axi</h1><p>The agent writes a few lines. <b>You click any part, leave a note,</b> and the page patches in place.</p><div class="cmd"><i>$</i> npx -y austere-axi --help</div></div>
<div class="win"><div class="bar"><i></i><i></i><i></i><span style="margin-left:8px">plan.html</span></div><img src="data:image/png;base64,${png.toString("base64")}"></div>
<div class="note"><small>pg · Node</small>Add a read replica for failover</div>`;
  const card = await browser.newPage({ viewport: { width: 1200, height: 630 }, deviceScaleFactor: 1 });
  await card.setContent(html);
  await card.waitForTimeout(200);
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  await card.screenshot({ path: OUT });
  console.log(`${path.relative(ROOT, OUT)}  ${(fs.statSync(OUT).size / 1024).toFixed(0)} KB (1200x630)`);
} finally {
  await browser.close();
}
