// Opt-in browser suite (npm run test:browser; needs Chrome or CHROME_PATH).
// One review panel that throws shows its own fallback; the page, the frame and the other panels keep working.
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import type { Browser } from "playwright-core";
import { launchBrowser } from "../../scripts/lib/browser.ts";
import { CDN_RUNTIME_URL } from "../../src/cli/artifact.ts";
import { htmlPage } from "../../scripts/lib/plugins.ts";
import { ownerHeaders } from "../owner.ts";
import { freePort } from "../port.ts";

const ROOT = path.resolve(import.meta.dirname, "../..");
const STATE = fs.mkdtempSync(path.join(os.tmpdir(), "austere-boundary-state-"));
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), "austere-boundary-work-"));
let port: number;
let server: ChildProcess;
let browser: Browser;
let skipReason: string | undefined;

const PROGRAM = `root = Stack([intro], "column", "l")
intro = TextContent("Boundary page")`;

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

test("a panel that throws shows its fallback; the rest of the chrome keeps working", async (t) => {
  if (skipReason) return t.skip(skipReason);
  const file = path.join(WORK, "boundary.html");
  fs.writeFileSync(file, htmlPage("Boundary", PROGRAM, CDN_RUNTIME_URL));
  const { session } = await api("/api/open", { file });
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  try {
    const page = await context.newPage();
    const problems: string[] = [];
    page.on("pageerror", (e) => problems.push(`pageerror: ${e.message}`));
    // A queue that is not a list: the Ready to send panel throws while it draws, and no other panel reads it that way.
    // (Not in the sandboxed artifact frame, which has no storage.)
    await page.addInitScript(
      (key) => window === window.top && localStorage.setItem(key, '{"broken":true}'),
      `austere:queue:${session.id}`,
    );
    const { code } = await api("/api/login", {});
    await page.goto(`http://127.0.0.1:${port}/s/${session.id}?login=${code}`);

    const fallback = page.locator('[data-boundary="The queue"]');
    await fallback.waitFor({ timeout: 15_000 });
    assert.match(await fallback.innerText(), /The queue could not be drawn/);
    await fallback.getByRole("button", { name: "Try again" }).waitFor();

    // The others still draw and work: the page frame, the title, the note box, the tabs and the ⋯ menu.
    await page.frameLocator(".frame").locator("text=Boundary page").waitFor();
    assert.equal(await page.locator("h1.title").innerText(), "Boundary");
    const note = page.getByRole("textbox", { name: "A note about the whole page" });
    await note.fill("still typing");
    assert.equal(await note.inputValue(), "still typing");
    await page
      .getByRole("tab", { name: /Agent|Notes/ })
      .first()
      .waitFor();
    await page.click(".menu-btn");
    await page.locator('[data-cmd="reload"]').waitFor();
    await page.keyboard.press("Escape");
    assert.equal(await page.locator("[data-boundary]").count(), 1, "only the queue failed");
    assert.deepEqual(problems, []);
  } finally {
    await context.close();
  }
});
