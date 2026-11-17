// Opt-in browser test (npm run test:browser; needs Chrome or CHROME_PATH): history in the review page
// (RLM-352). The owner sees what changed while the tab was away, how a part got to its text, and puts
// a part back; a reviewer sees none of it and the routes answer 403.
import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import type { Browser, Page } from "playwright-core";
import { launchBrowser } from "../../scripts/lib/browser.ts";
import { ownerKey } from "../../src/cli/invites.ts";
import { freePort } from "../port.ts";

const STATE = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "austere-history-browser-state-")));
const WORK = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "austere-history-browser-work-")));
const CLI = path.resolve("src/cli/main.ts");
const KEY = ownerKey(STATE);
let port: number;
let server: ChildProcess;
let browser: Browser;
let skipReason: string | undefined;
let env: NodeJS.ProcessEnv;

function api<T>(route: string, body: unknown): Promise<T> {
  const { promise, resolve, reject } = Promise.withResolvers<T>();
  const r = http.request({ host: "127.0.0.1", port, method: "POST", path: route, headers: { "content-type": "application/json", "x-austere-key": KEY } }, (res) => {
    let data = "";
    res.on("data", (c) => (data += c));
    res.on("end", () => resolve(JSON.parse(data) as T));
  });
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

/** Screenshots for the pull request: set HISTORY_SHOTS to a folder to keep them. */
async function shot(page: Page, name: string) {
  if (process.env.HISTORY_SHOTS) await page.screenshot({ path: path.join(process.env.HISTORY_SHOTS, `${name}.png`) });
}

/** Run the CLI against the test server, as an agent would. */
function cli(args: string[], input = ""): string {
  const r = spawnSync(process.execPath, [CLI, ...args], { env, input, encoding: "utf8" });
  assert.equal(r.status, 0, `${args.join(" ")}: ${r.stdout}${r.stderr}`);
  return r.stdout;
}

/** The tab is hidden or shown, as a browser reports it. */
async function setVisible(page: Page, visible: boolean) {
  await page.evaluate((v) => {
    Object.defineProperty(document, "visibilityState", { get: () => (v ? "visible" : "hidden"), configurable: true });
    document.dispatchEvent(new Event("visibilitychange"));
  }, visible);
}

async function ownerPage(file: string, width = 1280) {
  const { session } = await api<{ session: { id: string } }>("/api/open", { file });
  const context = await browser.newContext({ viewport: { width, height: width > 500 ? 900 : 844 } });
  const page = await context.newPage();
  const problems: string[] = [];
  page.on("pageerror", (e) => problems.push(`pageerror: ${e.message}`));
  page.on("console", (m) => {
    if (m.type() === "error") problems.push(`console error: ${m.text()}`);
  });
  const { code } = await api<{ code: string }>("/api/login", {});
  // The page tells the server it was seen: until that is answered, hiding the tab would leave nothing to compare with.
  const seen = page.waitForResponse((r) => r.url().endsWith("/viewed") && r.request().method() === "POST" && r.ok());
  await page.goto(`http://127.0.0.1:${port}/s/${session.id}?login=${code}`);
  await page.frameLocator(".frame").locator('[data-oui-id="intro"]').waitFor({ timeout: 15_000 });
  await seen;
  return { page, id: session.id, problems, context };
}

/** Waits until the frame outlines exactly these statements: the ones whose text sits inside a mark. */
async function outlinedIs(page: Page, want: string[]) {
  const frame = (await (await page.$(".frame"))!.contentFrame())!;
  await frame.waitForFunction((ids) => {
    const marks = [...document.querySelectorAll(".austere-mark")].map((m) => m.getBoundingClientRect());
    const on = [...document.querySelectorAll("[data-oui-id]")]
      .filter((el) => {
        const range = document.createRange();
        range.selectNodeContents(el);
        const r = range.getBoundingClientRect();
        const x = r.left + r.width / 2;
        const y = r.top + r.height / 2;
        // The page is a stack of TextContent statements; `root` has no box of its own.
        return el.getAttribute("data-oui-c") === "TextContent" && marks.some((m) => x >= m.left && x <= m.right && y >= m.top && y <= m.bottom);
      })
      .map((el) => el.getAttribute("data-oui-id"));
    return JSON.stringify(on.sort()) === ids;
  }, JSON.stringify([...want].sort()));
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
  for (const name of ["PI_SESSION_ID", "PI_SESSION_FILE", "COPILOT_AGENT_SESSION_ID", "DSH_SESSION_ID"]) delete env[name];
  server = spawn(process.execPath, [CLI, "server", "--port", String(port)], { env, stdio: "ignore" });
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

test("two patches while the tab is hidden: '2 revisions since you last looked', outlined; a part's history and Restore", async (t) => {
  if (skipReason) return t.skip(skipReason);
  const file = writePage("plan");
  const { page, id, problems, context } = await ownerPage(file);
  const frame = page.frameLocator(".frame");
  try {
    // Opened and in view: nothing is new.
    assert.ok(await page.locator(".since").isHidden());
    await setVisible(page, false);
    cli(["patch", file], 'intro = TextContent("hello, second")\n');
    await frame.getByText("hello, second").waitFor();
    cli(["patch", file], 'more = TextContent("changed too")\n');
    await frame.getByText("changed too").waitFor();

    await setVisible(page, true);
    await page.locator(".since").waitFor({ state: "visible" });
    assert.equal((await page.locator(".since-text").innerText()).trim(), "2 revisions since you last looked");
    assert.equal((await page.locator(".changes").innerText()).trim(), "2 changed");
    await shot(page, "since");
    await page.locator('.since [data-since="show"]').click();
    await page.waitForFunction(() => document.querySelector(".changes")?.getAttribute("aria-pressed") === "true");
    await outlinedIs(page, ["intro", "more"]);

    // The history lists the revisions, newest first, and outlines what one of them changed.
    await page.click(".menu-btn");
    await page.click('[data-cmd="history"]');
    const rows = page.locator(".hist-pick");
    await rows.first().waitFor();
    assert.equal(await rows.count(), 3);
    assert.match(await rows.nth(0).innerText(), /^Now · Revision 3 .*patched\s+more/s);
    assert.match(await rows.nth(1).innerText(), /Revision 2 .*patched\s+intro/s);
    assert.match(await rows.nth(2).innerText(), /Revision 1 .*3 statements? at the start|statements at the start/s);
    await shot(page, "history-1280");
    await rows.nth(1).click();
    await outlinedIs(page, ["intro"]);
    await page.click(".hist-close");

    // A part: History (n) in its annotate popover shows both texts; Restore puts the first back in place.
    await page.click('[data-mode="annotate"]');
    await frame.locator('[data-oui-id="intro"]').click();
    const hist = frame.locator('.austere-pop [data-act="history"]');
    await hist.waitFor({ state: "visible" });
    assert.equal((await hist.innerText()).trim(), "History (2)");
    await hist.click();
    await page.locator(".hist-text").first().waitFor();
    const texts = await page.locator(".hist-text").allInnerTexts();
    assert.deepEqual(texts, ["hello, second", "hello"]);
    await shot(page, "part-1280");
    await page.locator(".restore").click();
    await frame.getByText("hello", { exact: true }).waitFor();
    assert.match(fs.readFileSync(file, "utf8"), /intro = TextContent\("hello"\)/);
    assert.match(fs.readFileSync(file, "utf8"), /more = TextContent\("changed too"\)/, "only the part went back");
    const log = cli(["history", file]);
    assert.match(log, /rev: 4\n\s+at: [^\n]+\n\s+source: restore\n\s+changed: \[intro\]/);

    const rest = await fetch(`http://127.0.0.1:${port}/s/${id}/history`, { headers: { cookie: (await context.cookies()).map((c) => `${c.name}=${c.value}`).join("; ") } });
    assert.equal(rest.status, 200);
    assert.deepEqual(problems, []);
  } finally {
    await context.close();
  }
});

test("at 390 px the strip and the history fit the screen", async (t) => {
  if (skipReason) return t.skip(skipReason);
  const file = writePage("phone");
  const { page, problems, context } = await ownerPage(file, 390);
  const frame = page.frameLocator(".frame");
  try {
    await setVisible(page, false);
    cli(["patch", file], 'intro = TextContent("hello, phone")\n');
    await frame.getByText("hello, phone").waitFor();
    await setVisible(page, true);
    await page.locator(".since").waitFor({ state: "visible" });
    assert.equal((await page.locator(".since-text").innerText()).trim(), "1 revision since you last looked");
    await page.locator('.since [data-since="history"]').click();
    await page.locator(".hist-pick").first().waitFor();
    const box = await page.locator(".hist").boundingBox();
    assert.ok(box && box.x >= 0 && box.x + box.width <= 390, `the history is inside the screen: ${JSON.stringify(box)}`);
    assert.ok((await page.evaluate(() => document.documentElement.scrollWidth)) <= 390, "no sideways scroll");
    await shot(page, "history-390");
    assert.deepEqual(problems, []);
  } finally {
    await context.close();
  }
});

test("a reviewer sees changes, not history or Restore; the routes answer 403", async (t) => {
  if (skipReason) return t.skip(skipReason);
  const file = writePage("shared");
  const { session } = await api<{ session: { id: string } }>("/api/open", { file });
  const invite = await api<{ link: string }>("/api/share", { file, name: "Ana" });
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  try {
    const guest = await ctx.newPage();
    await guest.goto(invite.link);
    await guest.click("form[action$='/join'] button");
    await guest.waitForSelector(".composer textarea");
    assert.equal(await guest.locator('[data-cmd="history"]').count(), 0);
    assert.equal(await guest.locator(".since, .hist, .restore").count(), 0);
    const base = `http://127.0.0.1:${port}/s/${session.id}`;
    const origin = { origin: `http://127.0.0.1:${port}` };
    const call = (route: string, init: RequestInit = {}) => guest.evaluate(async ([url, i]) => (await fetch(url as string, i as RequestInit)).status, [`${base}${route}`, { ...init, headers: { "content-type": "application/json", ...origin } }] as const);
    assert.equal(await call("/history"), 403);
    assert.equal(await call("/history?statement=intro"), 403);
    assert.equal(await call("/restore", { method: "POST", body: JSON.stringify({ rev: 1 }) }), 403);
    assert.equal(await call("/viewed", { method: "POST", body: JSON.stringify({ rev: 1 }) }), 403);
    // The owner's key from a foreign Origin is refused too.
    const foreign = await fetch(`${base}/history`, { headers: { "x-austere-key": KEY, origin: "http://evil.example" } });
    assert.equal(foreign.status, 403);
  } finally {
    await ctx.close();
  }
});
