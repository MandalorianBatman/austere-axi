// Opt-in browser suite (npm run test:browser; needs Chrome or CHROME_PATH).
// The dashed hover box locked under an open note stays on its statement while
// the page moves under it: a window scroll, and a live update that re-lays out
// the diagram the statement sits in. Inside a statement it outlines the row pointed at.
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import type { Browser, Frame, Page } from "playwright-core";
import { launchBrowser } from "../../scripts/lib/browser.ts";
import { CDN_RUNTIME_URL } from "../../src/cli/artifact.ts";
import { htmlPage } from "../../scripts/lib/plugins.ts";
import { ownerHeaders } from "../owner.ts";
import { freePort } from "../port.ts";

const ROOT = path.resolve(import.meta.dirname, "../..");
const STATE = fs.mkdtempSync(path.join(os.tmpdir(), "austere-hover-state-"));
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), "austere-hover-work-"));
const FILE = path.join(WORK, "hover.html");
let port: number;
let server: ChildProcess;
let browser: Browser;
let skipReason: string | undefined;

// Enough text below the diagram that the window scrolls.
const FILLER = Array.from({ length: 80 }, (_, i) => `Line ${i + 1}.`).join("\\n\\n");

function writePage(withBalancer: boolean) {
  const program = withBalancer
    ? `root = Stack([flow, notes], "column", "l")
flow = Architecture([client, lb, api, pg], [toLb, toApi, toPg], [edge])
client = Node("Client", "external")
lb = Node("Load balancer", "network", "added in a live update")
api = Node("API", "backend", "Node :8080")
pg = Node("Postgres", "database", "sessions table")
toLb = Edge(client, lb, "HTTPS")
toApi = Edge(lb, api, "HTTP")
toPg = Edge(api, pg, "SQL")
edge = Group("Edge", [lb])
notes = MarkDownRenderer("${FILLER}")`
    : `root = Stack([flow, notes], "column", "l")
flow = Architecture([client, api, pg], [toApi, toPg])
client = Node("Client", "external")
api = Node("API", "backend", "Node :8080")
pg = Node("Postgres", "database", "sessions table")
toApi = Edge(client, api, "HTTPS")
toPg = Edge(api, pg, "SQL")
notes = MarkDownRenderer("${FILLER}")`;
  fs.writeFileSync(FILE, htmlPage("Hover box", program, CDN_RUNTIME_URL));
}

function api(route: string, body: unknown): Promise<{ session: { id: string }; code: string }> {
  return new Promise((resolve, reject) => {
    const r = http.request(
      { host: "127.0.0.1", port, method: "POST", path: route, headers: { "content-type": "application/json", ...ownerHeaders(STATE) } },
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
  server = spawn(process.execPath, [path.join(ROOT, "src/cli/main.ts"), "server", "--port", String(port)], {
    env: { ...process.env, AUSTERE_AXI_STATE_DIR: STATE, AUSTERE_AXI_NO_TAILSCALE: "1", OPENUI_TELEMETRY_DISABLED: "1" },
    stdio: "ignore",
  });
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

interface Rect {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** The node's drawn box and the locked hover box, in the frame's viewport. */
function geometry(frame: Frame) {
  return frame.evaluate(() => {
    const rect = (sel: string): Rect | null => {
      const el = document.querySelector(sel);
      if (!el || (el as HTMLElement).hidden) return null;
      const r = el.getBoundingClientRect();
      return { left: r.left, top: r.top, width: r.width, height: r.height };
    };
    return { node: rect('[data-oui-id="pg"] .austere-arch-node-box'), hover: rect(".austere-hover.locked") };
  });
}

// The hover box pads its statement by 4px on every side.
const PAD = 4;
const TOLERANCE = 2;

async function assertOnNode(page: Page, frame: Frame, when: string) {
  let g = await geometry(frame);
  const off = () => {
    if (!g.node || !g.hover) return Infinity;
    const { node, hover } = g;
    return Math.max(
      Math.abs(hover.left + PAD - node.left),
      Math.abs(hover.top + PAD - node.top),
      Math.abs(hover.width - PAD * 2 - node.width),
      Math.abs(hover.height - PAD * 2 - node.height),
    );
  };
  // Re-placing waits for a frame: give it a moment before calling it wrong.
  for (let i = 0; i < 20 && off() > TOLERANCE; i++) {
    await page.waitForTimeout(50);
    g = await geometry(frame);
  }
  assert.ok(g.hover, `${when}: the locked hover box is gone`);
  assert.ok(off() <= TOLERANCE, `${when}: hover box ${JSON.stringify(g.hover)} is off the node ${JSON.stringify(g.node)} by ${off()}px`);
  return g.node as Rect;
}

test("the locked hover box follows its node through a scroll and a live update", async (t) => {
  if (skipReason) return t.skip(skipReason);
  writePage(false);
  const { session } = await api("/api/open", { file: FILE });
  const context = await browser.newContext({ viewport: { width: 1280, height: 700 } });
  try {
    const page = await context.newPage();
    const { code } = await api("/api/login", {});
    await page.goto(`http://127.0.0.1:${port}/s/${session.id}?login=${code}`);
    const frame = (await (await page.waitForSelector("iframe.frame")).contentFrame()) as Frame;
    await frame.waitForSelector('[data-oui-id="pg"] .austere-arch-node-box', { timeout: 15_000 });
    await page.waitForTimeout(400);

    await frame.locator('[data-oui-id="pg"] .austere-arch-node-box').click();
    await frame.locator(".austere-pop").waitFor({ state: "visible" });
    const start = await assertOnNode(page, frame, "on open");

    await frame.evaluate(() => window.scrollBy(0, 120));
    const scrolled = await assertOnNode(page, frame, "after a window scroll");
    assert.ok(start.top - scrolled.top > 100, `the node did not move with the scroll (${start.top} → ${scrolled.top})`);

    writePage(true);
    await frame.waitForSelector('[data-oui-id="lb"]', { timeout: 10_000 });
    assert.ok(await frame.locator(".austere-pop").isVisible(), "the note closed on the live update");
    const moved = await assertOnNode(page, frame, "after a live update");
    assert.ok(Math.abs(moved.left - scrolled.left) + Math.abs(moved.top - scrolled.top) > 20, "the live update did not move the node");
  } finally {
    await context.close();
  }
});

test("a table row is outlined on its own, and the note names that row", async (t) => {
  if (skipReason) return t.skip(skipReason);
  const file = path.join(WORK, "rows.html");
  const program = `root = Stack([intro, plan], "column", "l")
intro = TextContent("Bindings")
plan = Table([Col("Binding", ["PAGES", "DB", "PAGE"]), Col("Kind", ["R2", "D1", "Durable Object"])])`;
  fs.writeFileSync(file, htmlPage("Rows", program, CDN_RUNTIME_URL));
  const { session } = await api("/api/open", { file });
  const context = await browser.newContext({ viewport: { width: 1280, height: 700 } });
  try {
    const page = await context.newPage();
    const { code } = await api("/api/login", {});
    await page.goto(`http://127.0.0.1:${port}/s/${session.id}?login=${code}`);
    await page.evaluate(() => {
      const w = window as unknown as { annotations: unknown[] };
      w.annotations = [];
      window.addEventListener("message", (e) => {
        if (e.data?.type === "annotate") w.annotations.push(e.data.item);
      });
    });
    const frame = (await (await page.waitForSelector("iframe.frame")).contentFrame()) as Frame;
    const cell = frame.locator('[data-oui-id="plan"] tbody tr:nth-child(2) td:nth-child(2)');
    await cell.waitFor({ timeout: 15_000 });
    await page.waitForTimeout(400);
    const boxes = () =>
      frame.evaluate(() => {
        const rect = (el: Element | null) => {
          const r = el?.getBoundingClientRect();
          return r && { left: r.left, top: r.top, width: r.width, height: r.height };
        };
        return {
          row: rect(document.querySelector('[data-oui-id="plan"] tbody tr:nth-child(2)')),
          table: rect(document.querySelector('[data-oui-id="plan"] table')),
          hover: rect(document.querySelector(".austere-hover.locked")),
          label: document.querySelector(".austere-hover-label")?.textContent,
        };
      });
    type Boxes = Awaited<ReturnType<typeof boxes>>;
    const onRow = (b: Boxes) => !!b.hover && !!b.row && near(b.hover, b.row);
    const onRoot = (b: Boxes) => !!b.hover && !!b.table && b.hover.height > b.table.height + PAD * 2 + TOLERANCE;
    const near = (hover: Rect, el: Rect) =>
      Math.max(
        Math.abs(hover.left + PAD - el.left),
        Math.abs(hover.top + PAD - el.top),
        Math.abs(hover.width - PAD * 2 - el.width),
        Math.abs(hover.height - PAD * 2 - el.height),
      ) <= TOLERANCE;
    // The box eases to a new place: give it a moment before calling it wrong.
    const settled = async (ok: (b: Boxes) => boolean) => {
      let b = await boxes();
      for (let i = 0; i < 20 && !ok(b); i++) {
        await page.waitForTimeout(50);
        b = await boxes();
      }
      return b;
    };

    await cell.click();
    await frame.locator(".austere-pop").waitFor({ state: "visible" });
    let b = await settled(onRow);
    assert.ok(onRow(b), `the box ${JSON.stringify(b.hover)} is not on row 2 ${JSON.stringify(b.row)}`);
    assert.equal(b.label, "plan · Table · row 2");

    // Choosing the parent statement moves the box to it; choosing the row's statement again brings it back.
    await frame.locator(".austere-chip", { hasText: "root" }).click();
    b = await settled(onRoot);
    assert.ok(onRoot(b), `the box ${JSON.stringify(b.hover)} did not move to root`);
    await frame.locator(".austere-chip", { hasText: "plan" }).click();
    b = await settled(onRow);
    assert.ok(onRow(b), `the box ${JSON.stringify(b.hover)} did not come back to row 2`);

    await frame.locator(".austere-pop textarea").fill("D1 is the index");
    await frame.locator(".austere-pop textarea").press("Enter");
    await page.waitForFunction(() => (window as unknown as { annotations: unknown[] }).annotations.length > 0);
    const [item] = await page.evaluate(() => (window as unknown as { annotations: { target: string; detail?: { rowIndex?: number } }[] }).annotations);
    assert.equal(item.target, "plan");
    assert.equal(item.detail?.rowIndex, 2);
  } finally {
    await context.close();
  }
});
