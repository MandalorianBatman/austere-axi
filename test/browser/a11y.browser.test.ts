// Opt-in browser test (npm run test:browser; needs Chrome or CHROME_PATH): the owner's review page by keyboard and
// by axe (RLM-440): Enter opens the Agent panel and puts focus in it, the tabs name no missing element, dialogs and
// History give focus back to what opened them, the Agent popover leaves the Notes tab free.
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import type { Browser, Page } from "playwright-core";
import { launchBrowser } from "../../scripts/lib/browser.ts";
import { ownerKey } from "../../src/cli/invites.ts";
import { freePort } from "../port.ts";

const STATE = fs.realpathSync(
  fs.mkdtempSync(path.join(os.tmpdir(), "austere-a11y-browser-state-")),
);
const WORK = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "austere-a11y-browser-work-")));
const CLI = path.resolve("src/cli/main.ts");
const KEY = ownerKey(STATE);
let port: number;
let server: ChildProcess;
let browser: Browser;
let skipReason: string | undefined;
let env: NodeJS.ProcessEnv;
const AXE = path.resolve("node_modules/axe-core/axe.min.js");

function api<T>(route: string, body: unknown): Promise<T> {
  const { promise, resolve, reject } = Promise.withResolvers<T>();
  const r = http.request(
    {
      host: "127.0.0.1",
      port,
      method: "POST",
      path: route,
      headers: { "content-type": "application/json", "x-austere-key": KEY },
    },
    (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => resolve(JSON.parse(data) as T));
    },
  );
  r.on("error", reject);
  r.end(JSON.stringify(body));
  return promise;
}

function writePage(name: string): string {
  const file = path.join(WORK, `${name}.html`);
  fs.writeFileSync(
    file,
    `<!doctype html><html><head><title>${name}</title><script src="https://cdn.jsdelivr.net/npm/austere-axi@0/dist/austere.js"></script></head>
<body><script type="text/openui">
root = Stack([intro, more, third])
intro = TextContent("hello")
more = TextContent("unchanged")
third = TextContent("steady")
</script></body></html>`,
  );
  return file;
}

before(async () => {
  for (const f of ["austere.js", "chrome/chrome.js"]) {
    if (!fs.existsSync(path.join("dist", f))) {
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
  env = {
    ...process.env,
    AUSTERE_AXI_STATE_DIR: STATE,
    AUSTERE_AXI_PORT: String(port),
    AUSTERE_AXI_NO_TAILSCALE: "1",
    AUSTERE_AXI_LINK_HOST: "127.0.0.1",
    AUSTERE_AXI_CLOUD_URL: "http://127.0.0.1:9",
    AUSTERE_AXI_NO_OPEN: "1",
    OPENUI_TELEMETRY_DISABLED: "1",
  };
  // The test may itself run inside a harness: its session must not become a page's author.
  for (const name of [
    "PI_SESSION_ID",
    "PI_SESSION_FILE",
    "COPILOT_AGENT_SESSION_ID",
    "DSH_SESSION_ID",
  ])
    delete env[name];
  server = spawn(process.execPath, [CLI, "server", "--port", String(port)], {
    env,
    stdio: "ignore",
  });
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(`http://127.0.0.1:${port}/api/health`)).ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 50));
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
  fs.rmSync(STATE, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  fs.rmSync(WORK, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
});

async function ownerPage(file: string, width = 1280) {
  const { session } = await api<{ session: { id: string } }>("/api/open", { file });
  const context = await browser.newContext({ viewport: { width, height: 900 } });
  const page = await context.newPage();
  const problems: string[] = [];
  page.on("pageerror", (e) => problems.push(`pageerror: ${e.message}`));
  const { code } = await api<{ code: string }>("/api/login", {});
  await page.goto(`http://127.0.0.1:${port}/s/${session.id}?login=${code}`);
  await page.frameLocator(".frame").locator('[data-oui-id="intro"]').waitFor({ timeout: 15_000 });
  await page.waitForSelector(".panel-tab[data-tab=agent]");
  return { page, context, problems };
}

/** What has focus: the class of the element, and whether it sits inside `inside`. */
const focusIn = (page: Page, inside: string) =>
  page.evaluate((sel) => !!document.activeElement?.closest(sel), inside);

async function criticalViolations(page: Page): Promise<string[]> {
  await page.addScriptTag({ path: AXE });
  return page.evaluate(async () => {
    const r = await (
      window as unknown as {
        axe: { run(): Promise<{ violations: { id: string; impact: string }[] }> };
      }
    ).axe.run();
    return r.violations.filter((v) => v.impact === "critical").map((v) => v.id);
  });
}

test("Enter on the Agent tab opens the popover and focus lands inside it", async (t) => {
  if (skipReason) return t.skip(skipReason);
  const { page, context, problems } = await ownerPage(writePage("enter"));
  try {
    await page.focus('.panel-tab[data-tab="agent"]');
    await page.keyboard.press("Enter");
    await page.locator(".attach-pop").waitFor({ state: "visible" });
    // Focus moves in once the key is released; the key's own click must not have closed the popover by then.
    await page.waitForFunction(() => !!document.activeElement?.closest(".attach-pop"));
    assert.ok(await page.locator(".attach-pop").isVisible(), "the popover stays open");
    assert.equal(
      await page.locator('.panel-tab[data-tab="agent"]').getAttribute("aria-selected"),
      "true",
    );
    assert.ok(await focusIn(page, ".attach-pop"), "focus is inside the popover");
    await page.keyboard.press("Escape");
    await page.locator(".attach-pop").waitFor({ state: "hidden" });
    assert.deepEqual(problems, []);
  } finally {
    await context.close();
  }
});

test("axe finds nothing critical with Notes, Agent and History showing", async (t) => {
  if (skipReason) return t.skip(skipReason);
  const { page, context } = await ownerPage(writePage("axe"));
  try {
    assert.deepEqual(await criticalViolations(page), [], "Notes");
    await page.click('.panel-tab[data-tab="agent"]');
    await page.locator(".attach-pop").waitFor({ state: "visible" });
    assert.deepEqual(await criticalViolations(page), [], "Agent");
    await page.keyboard.press("Escape");
    await page.click('.panel-tab[data-tab="history"]');
    await page.locator(".hist-pick").first().waitFor();
    assert.deepEqual(await criticalViolations(page), [], "History");
  } finally {
    await context.close();
  }
});

test("Share and History give focus back to what opened them", async (t) => {
  if (skipReason) return t.skip(skipReason);
  const { page, context } = await ownerPage(writePage("focus"));
  // Focus comes back as the dialog finishes closing: wait for it, bounded.
  const focusIs = async (want: RegExp, why = "") => {
    const ok = await page
      .waitForFunction(
        (src) => new RegExp(src).test(String(document.activeElement?.className)),
        want.source,
        { timeout: 3000 },
      )
      .then(
        () => true,
        () => false,
      );
    assert.ok(
      ok,
      `${why}: focus is on ${await page.evaluate(() => String(document.activeElement?.className).slice(-40))}`,
    );
  };
  try {
    // Share from the bar's button: Esc and Done both return there.
    await page.focus(".share-btn");
    await page.keyboard.press("Enter");
    await page.locator("[role=dialog].share").waitFor();
    await page.keyboard.press("Escape");
    await page.locator("[role=dialog].share").waitFor({ state: "hidden" });
    await focusIs(/share-btn/, "Esc");
    await page.click(".share-btn");
    await page.fill("[role=dialog].share input[name=name]", "Ida");
    await page.click("[role=dialog].share button[type=submit]");
    await page.locator("[role=dialog].share .share-link").waitFor();
    await focusIs(/share-link/, "the link is focused, for Ctrl+C");
    await page.click("[role=dialog].share >> text=Done");
    await page.locator("[role=dialog].share").waitFor({ state: "hidden" });
    await focusIs(/share-btn/, "Done");
    // From the menu the item has gone: the menu's button.
    await page.click(".menu-btn");
    await page.click('[data-cmd="share"]');
    await page.locator("[role=dialog].share").waitFor();
    await page.keyboard.press("Escape");
    await page.locator("[role=dialog].share").waitFor({ state: "hidden" });
    await focusIs(/menu-btn/, "menu");

    // History: Esc closes it and focus returns to the tab that opened it, or to the bar's button.
    await page.click('.panel-tab[data-tab="history"]');
    await page.locator(".hist-pick").first().waitFor();
    await page.keyboard.press("Escape");
    await page.locator(".hist").waitFor({ state: "hidden" });
    assert.equal(
      await page.evaluate(() => (document.activeElement as HTMLElement)?.dataset.tab),
      "history",
    );
    await page.click(".hist-btn");
    await page.locator(".hist-pick").first().waitFor();
    await page.click(".hist-close");
    await page.locator(".hist").waitFor({ state: "hidden" });
    await focusIs(/hist-btn/);
  } finally {
    await context.close();
  }
});

test("at 1280 px the Agent popover leaves the Notes, Agent and History tabs free", async (t) => {
  if (skipReason) return t.skip(skipReason);
  const { page, context } = await ownerPage(writePage("place"));
  try {
    await page.click(".attach-pill");
    await page.locator(".attach-pop").waitFor({ state: "visible" });
    await page.waitForTimeout(200);
    const pop = (await page.locator(".attach-pop").boundingBox())!;
    for (const tab of ["notes", "agent", "history"]) {
      const b = (await page.locator(`.panel-tab[data-tab="${tab}"]`).boundingBox())!;
      const overlap =
        b.x < pop.x + pop.width &&
        b.x + b.width > pop.x &&
        b.y < pop.y + pop.height &&
        b.y + b.height > pop.y;
      assert.ok(!overlap, `${tab} tab ${JSON.stringify(b)} under popover ${JSON.stringify(pop)}`);
    }
  } finally {
    await context.close();
  }
});

test("at 390 px Send and Done are at least 44 px high", async (t) => {
  if (skipReason) return t.skip(skipReason);
  const { page, context } = await ownerPage(writePage("touch"), 390);
  try {
    for (const sel of [".composer .send", ".composer .send-end"]) {
      await page.locator(sel).waitFor({ state: "attached" });
      const box = await page.locator(sel).evaluate((el) => el.getBoundingClientRect().height);
      assert.ok(box >= 44, `${sel} is ${box}px high`);
    }
    const copy = await page
      .locator(".copy-prompt")
      .evaluate((el) => el.getBoundingClientRect().height);
    assert.ok(copy >= 32, `Copy agent prompt is ${copy}px high`);
    const note = await page
      .locator(".composer textarea")
      .evaluate((el) => el.getBoundingClientRect().height);
    assert.ok(note >= 66, `the note box is ${note}px high`);
  } finally {
    await context.close();
  }
});
