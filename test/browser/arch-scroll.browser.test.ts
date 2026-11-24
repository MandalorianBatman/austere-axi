// Opt-in browser suite (npm run test:browser; needs Chrome or CHROME_PATH).
// A wide Architecture scrolls sideways in a focusable, named region; a cue and edge fades show
// only while part of it is hidden, and print shows the full width.
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import type { Browser, Frame } from "playwright-core";
import { launchBrowser } from "../../scripts/lib/browser.ts";
import { CDN_RUNTIME_URL } from "../../src/cli/artifact.ts";
import { htmlPage } from "../../scripts/lib/plugins.ts";
import { ownerHeaders } from "../owner.ts";
import { freePort } from "../port.ts";

const ROOT = path.resolve(import.meta.dirname, "../..");
const STATE = fs.mkdtempSync(path.join(os.tmpdir(), "austere-arch-state-"));
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), "austere-arch-work-"));
let port: number;
let server: ChildProcess;
let browser: Browser;
let skipReason: string | undefined;

const lanes = Array.from({ length: 5 }, (_, i) => i);
const chain = Array.from({ length: 14 }, (_, i) => i);
const PROGRAM = [
  `root = Stack([card, chainCard])`,
  `chainCard = Card([CardHeader("Forced chain"), chain])`,
  `chain = Architecture([${chain.map((i) => `c${i}`)}], [${chain.slice(1).map((i) => `f${i}`)}], null, "right")`,
  ...chain.map((i) => `c${i} = Node("Step ${i} of the pipeline")`),
  ...chain.slice(1).map((i) => `f${i} = Edge(c${i - 1}, c${i})`),
  `card = Card([CardHeader("Platform lanes"), d])`,
  `d = Architecture([${lanes.map((i) => `n${i}`)}], [${lanes.slice(1).map((i) => `e${i}`)}], [${lanes.map((i) => `g${i}`)}], "lanes")`,
  ...lanes.map((i) => `n${i} = Node("Service number ${i} with a name", "backend", "detail")`),
  ...lanes.map((i) => `g${i} = Group("TEAM ${i}", [n${i}])`),
  ...lanes.slice(1).map((i) => `e${i} = Edge(n${i - 1}, n${i}, "a label of some length")`),
].join("\n");

function api(route: string, body: unknown): Promise<{ session: { id: string }; code: string }> {
  return new Promise((resolve, reject) => {
    const r = http.request(
      {
        host: "127.0.0.1",
        port,
        method: "POST",
        path: route,
        headers: { "content-type": "application/json", ...ownerHeaders(STATE) },
      },
      (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => resolve(JSON.parse(data)));
      },
    );
    r.on("error", reject);
    r.end(JSON.stringify(body));
  });
}

before(async () => {
  for (const f of ["austere.js", "chrome/chrome.js"]) {
    if (!fs.existsSync(path.join(ROOT, "dist", f))) {
      skipReason = `dist/${f} missing; run npm run test:browser (it builds first)`;
      return;
    }
  }
  const launched = await launchBrowser();
  if (!launched.browser) {
    skipReason = launched.reason;
    return;
  }
  browser = launched.browser;
  port = await freePort();
  server = spawn(
    process.execPath,
    [path.join(ROOT, "src/cli/main.ts"), "server", "--port", String(port)],
    {
      env: {
        ...process.env,
        AUSTERE_AXI_STATE_DIR: STATE,
        AUSTERE_AXI_NO_TAILSCALE: "1",
        OPENUI_TELEMETRY_DISABLED: "1",
      },
      stdio: "ignore",
    },
  );
  for (let i = 0; i < 100; i++) {
    try {
      await new Promise<void>((resolve, reject) => {
        const r = http.get({ host: "127.0.0.1", port, path: "/api/health" }, (res) => {
          res.resume();
          res.statusCode === 200 ? resolve() : reject(new Error(String(res.statusCode)));
        });
        r.on("error", reject);
      });
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 50));
    }
  }
  throw new Error("server did not start");
});

after(async () => {
  await browser?.close();
  if (server && server.exitCode === null) {
    const exited = new Promise((r) => server.once("exit", r));
    server.kill();
    await exited;
  }
  fs.rmSync(STATE, { recursive: true, force: true });
  fs.rmSync(WORK, { recursive: true, force: true });
});

test("a wide architecture scrolls in a named, focusable region with a cue only while cut, and prints whole", async (t) => {
  if (skipReason) return t.skip(skipReason);
  const file = path.join(WORK, "arch.html");
  fs.writeFileSync(file, htmlPage("Arch", PROGRAM, CDN_RUNTIME_URL));
  const { session } = await api("/api/open", { file });
  for (const width of [360, 1280]) {
    const { code } = await api("/api/login", {});
    const context = await browser.newContext({
      viewport: { width, height: 900 },
    });
    try {
      const page = await context.newPage();
      await page.goto(`http://127.0.0.1:${port}/s/${session.id}?login=${code}`);
      const frame = (await (await page.waitForSelector("iframe.frame")).contentFrame()) as Frame;
      await frame.locator(".austere-arch-scroll").first().waitFor({ timeout: 15_000 });
      await page.waitForTimeout(400);
      assert.equal(await frame.locator(".austere-arch-scroll").count(), 2);
      for (const [index, title] of ["Platform lanes", "Forced chain"].entries()) {
        const scroll = frame.locator(".austere-arch-scroll").nth(index);
        const read = () =>
          scroll.evaluate((el) => ({
            cut: el.scrollLeft + el.clientWidth < el.scrollWidth - 4 || el.scrollLeft > 4,
            end: el.scrollLeft + el.clientWidth < el.scrollWidth - 4,
            start: el.classList.contains("is-cut-start"),
            endClass: el.classList.contains("is-cut-end"),
            cue: !!el.parentElement?.querySelector(".austere-arch-cue"),
            pageOverflow:
              document.documentElement.scrollWidth > document.documentElement.clientWidth,
          }));
        // Layout settles over a few frames, more slowly when the machine is busy.
        for (let i = 0; i < 30; i++) {
          const now = await read();
          if (now.cue === now.cut && now.endClass === now.end) break;
          await page.waitForTimeout(100);
        }
        const before = await read();
        if (width === 360)
          assert.equal(before.end, index === 1, `${title} at 360px: cut only for the forced chain`);
        assert.equal(before.cue, before.cut, `${width}px: cue and hidden content disagree`);
        assert.equal(
          before.endClass,
          before.end,
          `${width}px: end fade and hidden content disagree`,
        );
        assert.equal(before.pageOverflow, false, `${width}px: the page scrolls sideways`);
        assert.equal(await scroll.getAttribute("role"), "region");
        assert.equal(await scroll.getAttribute("aria-label"), title);
        await scroll.focus();
        // The ring must sit inside the masked box, or a cut edge would hide it.
        if (before.end) {
          const ring = await scroll.evaluate((el) => {
            const cs = getComputedStyle(el);
            return {
              style: cs.outlineStyle,
              width: parseFloat(cs.outlineWidth),
              offset: parseFloat(cs.outlineOffset),
              masked: cs.maskImage !== "none",
            };
          });
          assert.equal(ring.masked, true);
          assert.ok(
            ring.style !== "none" && ring.width >= 2 && ring.offset <= 0,
            `${width}px: focus ring is drawn outside the masked box`,
          );
        }
        assert.equal(await scroll.evaluate((el) => el === el.ownerDocument.activeElement), true);
        if (before.end) {
          await scroll.press("ArrowRight");
          await page.waitForTimeout(300);
          assert.ok(
            (await scroll.evaluate((el) => el.scrollLeft)) > 0,
            `${width}px: ArrowRight does not scroll`,
          );
          await scroll.evaluate((el) => (el.scrollLeft = el.scrollWidth));
          await page.waitForTimeout(300);
          const after = await read();
          assert.equal(after.start, true, `${width}px: no start fade after scrolling`);
          assert.equal(after.endClass, false, `${width}px: end fade at the far edge`);
          assert.equal(after.cue, true, `${width}px: cue gone while the start is hidden`);
          await scroll.evaluate((el) => (el.scrollLeft = 0));
          await page.waitForTimeout(300);
        }
        await page.emulateMedia({ media: "print" });
        const print = await scroll.evaluate((el) => {
          const svg = el.querySelector("svg") as SVGSVGElement;
          return {
            hidden: el.scrollWidth - el.clientWidth,
            overflow: getComputedStyle(el).overflowX,
            cue: el.parentElement?.querySelector(".austere-arch-cue")
              ? getComputedStyle(el.parentElement.querySelector(".austere-arch-cue")!).display
              : "none",
            svg: svg.getBoundingClientRect().width,
            box: el.getBoundingClientRect().width,
          };
        });
        assert.equal(print.overflow, "visible");
        assert.equal(print.cue, "none");
        assert.ok(
          print.svg <= print.box + 1,
          `${width}px print: svg ${print.svg} > box ${print.box}`,
        );
        await page.emulateMedia({ media: "screen" });
      }
    } finally {
      await context.close();
    }
  }
});

test("Expand opens the natural-size diagram in a modal dialog: scroll, annotate, Esc returns focus", async (t) => {
  if (skipReason) return t.skip(skipReason);
  const file = path.join(WORK, "arch-expand.html");
  fs.writeFileSync(file, htmlPage("Arch", PROGRAM, CDN_RUNTIME_URL));
  const { session } = await api("/api/open", { file });
  const { code } = await api("/api/login", {});
  const context = await browser.newContext({ viewport: { width: 360, height: 640 } });
  try {
    const page = await context.newPage();
    await page.goto(`http://127.0.0.1:${port}/s/${session.id}?login=${code}`);
    const frame = (await (await page.waitForSelector("iframe.frame")).contentFrame()) as Frame;
    await frame.locator(".austere-arch-expand").first().waitFor({ timeout: 15_000 });
    await page.waitForTimeout(400);
    const buttons = frame.locator(".austere-arch-expand");
    assert.equal(await buttons.count(), 2, "every diagram has an Expand button");
    for (const i of [0, 1]) {
      const box = (await buttons.nth(i).boundingBox()) as { width: number; height: number };
      assert.ok(
        box.width >= 44 && box.height >= 44,
        `Expand button ${i} is ${box.width}x${box.height}`,
      );
    }
    assert.equal(await buttons.first().getAttribute("aria-label"), "Expand Platform lanes");

    await buttons.first().click();
    const dialog = frame.locator("dialog.austere-arch-dialog[open]");
    await dialog.waitFor({ timeout: 5_000 });
    assert.equal(await dialog.getAttribute("aria-label"), "Platform lanes");
    assert.equal(await dialog.evaluate((el) => el.matches(":modal")), true);
    const measure = () =>
      frame.evaluate(() => {
        const d = document.querySelector("dialog[open]") as HTMLElement;
        const r = d.getBoundingClientRect();
        const svg = d.querySelector("svg.austere-arch-svg") as SVGSVGElement;
        const vb = svg.viewBox.baseVal;
        const lanes = [
          ...d.querySelectorAll(".austere-arch-group.is-lane .austere-arch-group-frame"),
        ];
        return {
          dialog: { w: r.width, h: r.height },
          frame: { w: window.innerWidth, h: window.innerHeight },
          svgWidth: svg.getBoundingClientRect().width,
          natural: vb.width,
          columns: new Set(lanes.map((l) => Math.round(l.getBoundingClientRect().left))).size,
          ids: document.querySelectorAll('[data-oui-id="n0"]').length,
        };
      });
    const open = await measure();
    assert.deepEqual(open.dialog, open.frame, "the dialog fills the frame");
    assert.ok(Math.abs(open.svgWidth - open.natural) < 1, "the diagram is not at scale 1.0");
    assert.equal(open.columns, 5, "5 lanes show as 5 columns");
    assert.equal(open.ids, 1, "part ids are duplicated");

    const scroll = dialog.locator(".austere-arch-scroll");
    await scroll.evaluate((el) => (el.scrollLeft = 200));
    await page.waitForTimeout(200);
    assert.ok(
      (await scroll.evaluate((el) => el.scrollLeft)) > 100,
      "the dialog does not scroll sideways",
    );
    // Vertical scroll is native: the box allows it.
    assert.equal(await scroll.evaluate((el) => getComputedStyle(el).overflowY), "auto");

    // Focus stays inside the dialog.
    for (let i = 0; i < 4; i++) {
      await page.keyboard.press("Tab");
      assert.equal(
        await frame.evaluate(() => {
          const a = document.activeElement;
          // Past the last control focus may go to the browser itself (body), never to the page.
          return a === document.body || !!a?.closest("dialog[open]");
        }),
        true,
        "focus left the dialog",
      );
    }

    // Annotate: a tap on a node picks it; the box and note draw above the dialog.
    await scroll.evaluate((el) => {
      el.scrollLeft = 0;
    });
    await dialog.locator('[data-oui-id="n0"] .austere-arch-node-box').click();
    await frame.locator(".austere-pop").waitFor({ state: "visible" });
    const layers = await frame.evaluate(() => {
      const pop = document.querySelector(".austere-pop") as HTMLElement;
      const r = pop.getBoundingClientRect();
      const top = document.elementFromPoint(r.left + r.width / 2, r.top + 20);
      const hover = document.querySelector(".austere-hover") as HTMLElement;
      return {
        popInDialog: !!pop.closest("dialog[open]"),
        popOnTop: !!top?.closest(".austere-pop"),
        hoverInDialog: !!hover.closest("dialog[open]"),
        hoverShown: !hover.hidden,
        path: pop.querySelector(".austere-pop-path")?.textContent ?? "",
      };
    });
    assert.equal(layers.popInDialog, true);
    assert.equal(layers.popOnTop, true, "the note is drawn under the dialog");
    assert.equal(layers.hoverInDialog && layers.hoverShown, true, "no hover box in the dialog");
    assert.match(layers.path, /›n0$/);
    await frame.locator('.austere-pop [data-act="cancel"]').click();

    // Landscape while open: the frame is re-fitted and the layout is unchanged.
    await page.setViewportSize({ width: 640, height: 360 });
    await page.waitForTimeout(400);
    const land = await measure();
    assert.deepEqual(land.dialog, land.frame, "the dialog does not fill the landscape frame");
    assert.equal(land.columns, 5);
    assert.ok(Math.abs(land.svgWidth - land.natural) < 1);
    await page.setViewportSize({ width: 360, height: 640 });
    await page.waitForTimeout(300);

    // Esc closes and focus returns to the Expand button; the annotate layer returns to the page.
    await scroll.focus();
    await page.keyboard.press("Escape");
    await frame.locator("dialog[open]").waitFor({ state: "detached", timeout: 5_000 });
    const after = await frame.evaluate(() => ({
      expand: document.activeElement?.classList.contains("austere-arch-expand"),
      label: document.activeElement?.getAttribute("aria-label"),
      uiInBody: !!document.querySelector("body > .austere-ui"),
      scrolls: document.querySelectorAll(".austere-arch-scroll").length,
    }));
    assert.equal(after.expand, true, "focus did not return to the Expand button");
    assert.equal(after.label, "Expand Platform lanes");
    assert.equal(after.uiInBody, true);
    assert.equal(after.scrolls, 2, "the inline diagram did not come back");

    // The Close button closes too.
    await buttons.first().click();
    await frame.locator("dialog[open]").waitFor();
    await frame.locator("dialog[open] .austere-arch-dialog-bar button").click();
    await frame.locator("dialog[open]").waitFor({ state: "detached", timeout: 5_000 });
    assert.equal(
      await frame.evaluate(() => document.activeElement?.getAttribute("aria-label")),
      "Expand Platform lanes",
    );
  } finally {
    await context.close();
  }
});
