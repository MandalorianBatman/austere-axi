// Opt-in browser suite for the website playground (npm run test:browser; needs Chrome or CHROME_PATH).
// Builds the site (`npm run site`), serves _site/ and drives /play/ like a visitor:
//   - edit a statement, watch the frame update in place
//   - problems come from the same check as `austere-axi check`, with line numbers
//   - the share link reproduces the page; Download gives a file the CLI accepts
//   - clicking a part and queueing a note shows the statement name the agent receives
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { launchBrowser } from "../../scripts/lib/browser.mjs";
import { ROOT } from "../../scripts/lib/plugins.mjs";
import { readArtifact } from "../../src/cli/artifact.js";

const SITE = path.join(ROOT, "_site");
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".json": "application/json", ".css": "text/css", ".png": "image/png", ".svg": "image/svg+xml" };
const PROGRAM = `root = Stack([intro, plan], "column", "l")
intro = Card([CardHeader("Hello playground", "first version")])
plan = Card([CardHeader("Plan"), steps])
steps = MarkDownRenderer("Ship the **playground**")
`;

let browser;
let server;
let base;
let skipReason;

before(async () => {
  const launched = await launchBrowser();
  if (!launched.browser) {
    skipReason = launched.reason;
    return;
  }
  browser = launched.browser;
  const built = spawnSync(process.execPath, [path.join(ROOT, "scripts/site.mjs")], { cwd: ROOT, env: process.env, encoding: "utf8" });
  assert.equal(built.status, 0, `npm run site failed:\n${built.stdout}\n${built.stderr}`);
  server = http.createServer((req, res) => {
    let p = decodeURIComponent(new URL(req.url, "http://x").pathname);
    if (p.endsWith("/")) p += "index.html";
    const file = path.join(SITE, p);
    if (!file.startsWith(SITE) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.statusCode = 404;
      return res.end();
    }
    res.setHeader("content-type", TYPES[path.extname(file)] || "application/octet-stream");
    res.end(fs.readFileSync(file));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await browser?.close();
  await new Promise((resolve) => (server ? server.close(resolve) : resolve()));
});

/** Open /play/ (optionally with a hash) and wait for the first render. */
async function open(t, { hash = "", viewport = { width: 1360, height: 900 }, context } = {}) {
  if (skipReason) return t.skip(skipReason);
  const ctx = context || (await browser.newContext({ viewport }));
  const page = await ctx.newPage();
  const problems = [];
  page.on("pageerror", (e) => problems.push(`pageerror: ${e.message}`));
  page.on("console", (m) => {
    if (m.type() === "error") problems.push(`console error: ${m.text()}`);
  });
  await page.goto(`${base}/play/${hash}`);
  const frame = await (await page.waitForSelector("#frame", { state: "attached" })).contentFrame();
  await frame.waitForSelector("[data-oui-id]", { timeout: 15_000 });
  return { ctx, page, frame, problems };
}

async function type(page, program) {
  await page.locator("#source").fill(program);
}

describe("playground", () => {
  test("starts on an example that passes check", async (t) => {
    const s = await open(t);
    if (!s) return;
    try {
      await s.page.waitForFunction(() => /Passes austere-axi check/.test(document.querySelector("#status").textContent));
      assert.match(await s.page.textContent("#status"), /\d+ statements · ~[\d,]+ tokens/);
      assert.deepEqual(s.problems, []);
    } finally {
      await s.ctx.close();
    }
  });

  test("an edit re-renders the frame in place", async (t) => {
    const s = await open(t);
    if (!s) return;
    try {
      await type(s.page, PROGRAM);
      await s.frame.getByText("Ship the").waitFor();
      await s.frame.evaluate(() => (window.__same = true)); // lost if the frame reloads
      await type(s.page, PROGRAM.replace("Ship the **playground**", "Ship the **second version**"));
      await s.frame.getByText("second version").waitFor();
      assert.equal(await s.frame.evaluate(() => window.__same), true);
      assert.deepEqual(s.problems, []);
    } finally {
      await s.ctx.close();
    }
  });

  test("problems are reported with their line, from the same check as the CLI", async (t) => {
    const s = await open(t);
    if (!s) return;
    try {
      await type(s.page, PROGRAM.replace("MarkDownRenderer", "NoSuchThing"));
      const item = s.page.locator("#diag li.error").first();
      await item.waitFor();
      assert.match(await item.textContent(), /line 4/);
      assert.match(await item.textContent(), /Unknown component "NoSuchThing"/);
      assert.match(await s.page.textContent("#status"), /1 error/);
      assert.equal(await s.page.locator("#editor .marks i.error").count(), 1);
      await item.locator("button").click(); // selects the statement in the editor
      assert.match(await s.page.locator("#source").evaluate((el) => el.value.slice(el.selectionStart, el.selectionEnd)), /^steps = NoSuchThing/);
      await type(s.page, PROGRAM);
      await s.page.waitForFunction(() => /Passes austere-axi check/.test(document.querySelector("#status").textContent));
      assert.equal(await s.page.locator("#diag li").count(), 0);
    } finally {
      await s.ctx.close();
    }
  });

  test("a shared link reproduces the page", async (t) => {
    const a = await open(t);
    if (!a) return;
    try {
      await type(a.page, PROGRAM);
      await a.frame.getByText("Ship the").waitFor();
      await a.page.waitForFunction(() => location.hash.startsWith("#code=v1."));
      const url = a.page.url();
      assert.ok(url.length < 2000, `link of ${url.length} characters`);
      const b = await open(t, { hash: new URL(url).hash });
      try {
        assert.equal(await b.page.locator("#source").inputValue(), PROGRAM);
        assert.equal(
          await b.frame.locator("#austere-root").innerHTML(),
          await a.frame.locator("#austere-root").innerHTML(),
        );
      } finally {
        await b.ctx.close();
      }
    } finally {
      await a.ctx.close();
    }
  });

  test("a damaged link falls back to the default page and says so", async (t) => {
    const s = await open(t, { hash: "#code=v1.not-a-real-payload" });
    if (!s) return;
    try {
      await s.page.locator("#toast").waitFor();
      assert.match(await s.page.textContent("#toast"), /damaged|truncated/);
      assert.ok((await s.page.locator("#source").inputValue()).startsWith("root ="));
    } finally {
      await s.ctx.close();
    }
  });

  test("Download .html gives a file the CLI checks and opens", async (t) => {
    const s = await open(t);
    if (!s) return;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "austere-play-"));
    try {
      await type(s.page, PROGRAM);
      const [download] = await Promise.all([s.page.waitForEvent("download"), s.page.click("#download")]);
      const file = path.join(dir, download.suggestedFilename());
      await download.saveAs(file);
      assert.equal(download.suggestedFilename(), "hello-playground.html");
      const html = fs.readFileSync(file, "utf8");
      assert.equal(readArtifact(html).program.trim(), PROGRAM.trim());
      const cli = path.join(ROOT, "src/cli/main.js");
      const check = spawnSync(process.execPath, [cli, "check", file], { encoding: "utf8", env: { ...process.env, AUSTERE_AXI_STATE_DIR: dir } });
      assert.equal(check.status, 0, check.stdout + check.stderr);
      assert.match(check.stdout, /status: ok/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
      await s.ctx.close();
    }
  });

  test("clicking a part shows the statement name the agent receives", async (t) => {
    const s = await open(t);
    if (!s) return;
    try {
      await type(s.page, PROGRAM);
      await s.frame.getByText("Ship the").waitFor();
      await s.frame.getByText("Ship the").click();
      const pop = s.frame.locator(".austere-pop");
      await pop.waitFor({ state: "visible" });
      assert.match(await pop.locator(".austere-pop-path").textContent(), /steps/);
      await pop.locator("textarea").fill("Mention the date");
      await pop.locator("textarea").press("Enter");
      const text = await s.page.locator("#fb-text").textContent();
      assert.match(text, /^status: feedback/);
      assert.match(text, /annotation: steps \(MarkDownRenderer\)/);
      assert.match(text, /line: 4/);
      assert.match(text, /note: Mention the date/);
      await s.page.locator("#fb-jump .chip", { hasText: "steps" }).click();
      assert.match(await s.page.locator("#source").evaluate((el) => el.value.slice(el.selectionStart, el.selectionEnd)), /^steps = /);
    } finally {
      await s.ctx.close();
    }
  });

  test("the component reference lists the catalog and filters", async (t) => {
    const s = await open(t);
    if (!s) return;
    try {
      await s.page.click("#tab-ref");
      await s.page.locator("#ref .comp").first().waitFor();
      const all = await s.page.locator("#ref .comp").count();
      assert.ok(all > 60, `${all} components`);
      await s.page.fill("#ref-filter", "table");
      assert.ok((await s.page.locator("#ref .comp").count()) < all);
      await s.page.fill("#ref-filter", "zzzz-no-such");
      assert.equal(await s.page.locator("#ref .comp").count(), 0);
    } finally {
      await s.ctx.close();
    }
  });

  test("works on a phone: tabs switch panels and nothing scrolls sideways", async (t) => {
    const s = await open(t, { viewport: { width: 390, height: 844 } });
    if (!s) return;
    try {
      assert.equal(await s.page.locator("#pane-source").isVisible(), true);
      assert.equal(await s.page.locator("#pane-preview").isVisible(), false);
      await s.page.click("#tab-preview");
      assert.equal(await s.page.locator("#pane-preview").isVisible(), true);
      assert.equal(await s.page.locator("#pane-source").isVisible(), false);
      const overflow = await s.page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      assert.ok(overflow <= 0, `page scrolls ${overflow}px sideways`);
      await s.page.click("#tab-source");
      await type(s.page, PROGRAM);
      await s.page.click("#tab-preview");
      await s.frame.getByText("Hello playground").waitFor();
    } finally {
      await s.ctx.close();
    }
  });
});
