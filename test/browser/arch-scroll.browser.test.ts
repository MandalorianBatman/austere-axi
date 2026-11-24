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
