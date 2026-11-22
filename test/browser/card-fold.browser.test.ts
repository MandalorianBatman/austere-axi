// Opt-in browser suite (npm run test:browser; needs Chrome or CHROME_PATH).
// A Card that opens with a titled CardHeader folds to that header for the reviewer:
// the chevron hides and shows the body, a folded card is still annotated by its
// statement name, a reveal unfolds it, and a Card without a header renders as stock.
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
const STATE = fs.mkdtempSync(path.join(os.tmpdir(), "austere-fold-state-"));
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), "austere-fold-work-"));
let port: number;
let server: ChildProcess;
let browser: Browser;
let skipReason: string | undefined;

const PROGRAM = `root = Stack([plan, plain, side], "column", "l")
plan = Card([CardHeader("Rollout plan", "3 steps"), steps, risk])
steps = MarkDownRenderer("1. Ship behind a flag\\n2. Ramp to 10%\\n3. Ramp to 100%")
risk = TextContent("Rollback takes one deploy.")
plain = Card([intro])
intro = TextContent("A card without a header has nothing to fold to.")
side = Card([CardHeader("Side by side"), left, right], "card", "row")
left = TextContent("Left cell")
right = TextContent("Right cell")`;

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

const cardHeight = (frame: Frame, id: string) =>
  frame.evaluate(
    (id) =>
      document.querySelector(`[data-oui-id="${id}"] > .openui-card`)?.getBoundingClientRect()
        .height ?? 0,
    id,
  );

test("a Card folds to its header, and a folded card is still annotated by its statement name", async (t) => {
  if (skipReason) return t.skip(skipReason);
  const file = path.join(WORK, "fold.html");
  fs.writeFileSync(file, htmlPage("Fold", PROGRAM, CDN_RUNTIME_URL));
  const { session } = await api("/api/open", { file });
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
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
    const fold = frame.locator('[data-oui-id="plan"] .austere-card-fold');
    const steps = frame.locator('[data-oui-id="steps"]');
    await fold.waitFor({ timeout: 15_000 });
    await page.waitForTimeout(400);

    // A Card without a header, or a row Card (its header is one cell of the row), renders as
    // the stock Card: its children sit directly in it.
    assert.equal(
      await frame
        .locator(
          '[data-oui-id="plain"] .austere-card-fold, [data-oui-id="plain"] .austere-card-body',
        )
        .count(),
      0,
    );
    assert.equal(await frame.locator('[data-oui-id="side"] .austere-card-fold').count(), 0);
    assert.equal(
      await frame
        .locator(
          '[data-oui-id="plain"] > .openui-card.openui-card-card.openui-card-full > [data-oui-id="intro"]',
        )
        .count(),
      1,
    );

    // Open by default; the chevron folds the body away and brings it back.
    assert.equal(await fold.getAttribute("aria-expanded"), "true");
    assert.equal(await fold.getAttribute("aria-label"), "Rollout plan");
    assert.ok(await steps.isVisible(), "the body is hidden before any click");
    const open = await cardHeight(frame, "plan");
    await fold.click();
    assert.equal(await fold.getAttribute("aria-expanded"), "false");
    assert.equal(
      await frame.locator('[data-oui-id="plan"] .austere-card-body').getAttribute("hidden"),
      "until-found",
    );
    assert.ok(!(await steps.isVisible()), "the body still shows when folded");
    const folded = await cardHeight(frame, "plan");
    assert.ok(
      folded < open - 40,
      `the folded card (${folded}px) is not shorter than the open one (${open}px)`,
    );
    assert.equal(
      await frame.locator(".austere-pop").isVisible(),
      false,
      "the chevron opened a note instead of folding",
    );

    // The folded card's title is annotated as the card, by its statement name.
    await frame.locator('[data-oui-id="plan"] .openui-header-top-left').click();
    await frame.locator(".austere-pop").waitFor({ state: "visible" });
    assert.match((await frame.locator(".austere-hover-label").textContent()) ?? "", /^plan · Card/);
    await frame.locator(".austere-pop textarea").fill("split the ramp");
    await frame.locator(".austere-pop textarea").press("Enter");
    await page.waitForFunction(
      () => (window as unknown as { annotations: unknown[] }).annotations.length > 0,
    );
    const [item] = await page.evaluate(
      () =>
        (window as unknown as { annotations: { target: string; excerpt?: string }[] }).annotations,
    );
    assert.equal(item.target, "plan");
    const excerpt = item.excerpt ?? "";
    assert.ok(
      excerpt.includes("Rollout plan"),
      `the excerpt ${JSON.stringify(item.excerpt)} does not quote the title`,
    );
    assert.ok(
      !excerpt.includes("Ship behind a flag"),
      `the excerpt ${JSON.stringify(item.excerpt)} quotes the folded body`,
    );

    // A changed statement inside a folded card is outlined on the card.
    const post = (msg: object) =>
      page.evaluate(
        (m) =>
          (document.querySelector("iframe.frame") as HTMLIFrameElement).contentWindow?.postMessage(
            { austere: 1, ...m },
            "*",
          ),
        msg,
      );
    await post({ type: "highlight", ids: ["risk"] });
    await frame.locator(".austere-mark").waitFor({ timeout: 5_000 });
    const mark = await frame.locator(".austere-mark").boundingBox();
    assert.ok(
      mark && Math.abs(mark.height - 8 - folded) <= 2,
      `the mark ${JSON.stringify(mark)} is not on the folded card (${folded}px)`,
    );
    await post({ type: "highlight", ids: [] });

    // A reveal (a note in the history, a viewer's focus) of a statement inside unfolds the card.
    await post({ type: "reveal", id: "risk" });
    await frame.locator('[data-oui-id="risk"]').waitFor({ state: "visible", timeout: 5_000 });
    assert.equal(await fold.getAttribute("aria-expanded"), "true");
    assert.ok(await steps.isVisible(), "the reveal did not unfold the card");
  } finally {
    await context.close();
  }
});
