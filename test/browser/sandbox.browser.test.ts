// Opt-in browser suite (npm run test:browser; needs Chrome or CHROME_PATH).
// Artifact code (an installed pack, an inline script) must never run at the
// server's origin: a popup it opens on its own URL stays sandboxed, so it
// cannot act as the owner, and the chrome opens only external links for it.
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import type { Browser, Frame, Page } from "playwright-core";
import { launchBrowser } from "../../scripts/lib/browser.ts";
import { ownerKey } from "../../src/cli/invites.ts";
import { ownerHeaders } from "../owner.ts";
import { freePort } from "../port.ts";

const ROOT = path.resolve(import.meta.dirname, "../..");
const STATE = fs.mkdtempSync(path.join(os.tmpdir(), "austere-sandbox-state-"));
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), "austere-sandbox-work-"));
const FILE = path.join(WORK, "escape.html");
const LINKS_FILE = path.join(WORK, "links.html");
let port: number;
let server: ChildProcess;
let browser: Browser;
let skipReason: string | undefined;

/** The fields these tests read from the server's JSON replies. */
interface ApiReply {
  session: { id: string };
  entries: unknown;
}

// Stands in for pack code: from the frame, open our own URL on the first
// click; from a window of its own, try to send a message as the owner.
const ARTIFACT = `<!doctype html><html><head><title>Escape</title></head><body>
<p id="target" style="height:400px">click me</p>
<script>
if (window.parent === window) {
  document.title = "origin:" + self.origin;
  fetch(location.pathname.replace(/\\/a\\/.*$/, "/send"), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ items: [{ kind: "message", text: "DUMMY" }] }),
  }).then((r) => (document.title += " send:" + r.status), () => (document.title += " send:blocked"));
} else {
  addEventListener("pointerdown", () => window.open(location.pathname), true);
}
</script></body></html>`;

// A new-window link (as Markdown and URL cells render) and a popup on the
// page's own URL. A popup reports its origin in its title.
const LINKS = `<!doctype html><html><head><title>Links</title></head><body>
<a id="ext" href="https://example.com/x" target="_blank">external</a>
<button id="self">self</button>
<script>
if (window.opener) document.title = "origin:" + self.origin;
document.getElementById("self").addEventListener("click", () => window.open(location.pathname));
</script></body></html>`;
const ORIGIN_PAGE = { status: 200, contentType: "text/html", body: "<script>document.title = self.origin</script>" };

function api(route: string, body: unknown): Promise<ApiReply> {
  return new Promise((resolve, reject) => {
    const r = http.request(
      { host: "127.0.0.1", port, method: "POST", path: route, headers: { "content-type": "application/json", ...ownerHeaders(STATE) } },
      (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => resolve(JSON.parse(data) as ApiReply));
      },
    );
    r.on("error", reject);
    r.end(JSON.stringify(body));
  });
}

before(async () => {
  if (!fs.existsSync(path.join(ROOT, "dist/chrome/chrome.js"))) {
    skipReason = "dist/chrome/chrome.js missing; run npm run test:browser (it builds first)";
    return;
  }
  const launched = await launchBrowser();
  if (!launched.browser) {
    skipReason = launched.reason;
    return;
  }
  browser = launched.browser;
  fs.writeFileSync(FILE, ARTIFACT);
  fs.writeFileSync(LINKS_FILE, LINKS);
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

test("a popup opened by artifact code keeps the sandbox and cannot act as the owner", async (t) => {
  if (skipReason) return t.skip(skipReason);
  const { session } = await api("/api/open", { file: FILE });
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    await page.goto(`http://127.0.0.1:${port}/s/${session.id}?key=${ownerKey(STATE)}`);
    const frame = (await (await page.waitForSelector("iframe.frame")).contentFrame()) as Frame;
    await frame.waitForSelector("#target");
    const popupP = context.waitForEvent("page", { timeout: 5000 });
    await frame.click("#target");
    const popup = await popupP;
    await popup.waitForFunction(() => /send:/.test(document.title), null, { timeout: 5000 });
    const title = await popup.title();
    assert.match(title, /^origin:null /, `popup runs at the server origin: ${title}`);
    assert.doesNotMatch(title, /send:2\d\d/, `popup sent as the owner: ${title}`);
    const { entries } = await api("/api/feedback", { file: FILE, peek: true, all: true });
    assert.ok(!JSON.stringify(entries).includes("DUMMY"), "the popup's message reached the agent");
  } finally {
    await context.close();
  }
});

test("the chrome opens external links for the frame, never its own origin", async (t) => {
  if (skipReason) return t.skip(skipReason);
  const { session } = await api("/api/open", { file: FILE });
  const context = await browser.newContext();
  await context.route("https://example.com/**", (r) => r.fulfill({ status: 200, body: "ok" }));
  try {
    const page = await context.newPage();
    await page.goto(`http://127.0.0.1:${port}/s/${session.id}?key=${ownerKey(STATE)}`);
    const frame = (await (await page.waitForSelector("iframe.frame")).contentFrame()) as Frame;
    await frame.waitForSelector("#target");
    const opened: Page[] = [];
    context.on("page", (p) => opened.push(p));
    const send = (url: string) => frame.evaluate((u) => parent.postMessage({ austere: 1, type: "open-url", url: u }, "*"), url);
    await send(`http://127.0.0.1:${port}/s/${session.id}/a/escape.html`);
    await send("javascript:alert(1)");
    await page.waitForTimeout(300);
    assert.equal(opened.length, 0, "the chrome opened a same-origin or non-web URL");
    const popupP = context.waitForEvent("page", { timeout: 5000 });
    await send("https://example.com/docs");
    const popup = await popupP;
    await popup.waitForURL("https://example.com/docs");
  } finally {
    await context.close();
  }
});

test("a new-window link in the frame opens through the chrome, outside the sandbox", async (t) => {
  if (skipReason) return t.skip(skipReason);
  const { session } = await api("/api/open", { file: LINKS_FILE });
  const context = await browser.newContext();
  await context.route("https://example.com/**", (r) => r.fulfill(ORIGIN_PAGE));
  try {
    const page = await context.newPage();
    await page.goto(`http://127.0.0.1:${port}/s/${session.id}?key=${ownerKey(STATE)}`);
    const frame = (await (await page.waitForSelector("iframe.frame")).contentFrame()) as Frame;
    await frame.waitForSelector("#ext");
    await page.click('.seg button[data-mode="explore"]');
    const popupP = context.waitForEvent("page", { timeout: 5000 });
    await frame.click("#ext");
    const popup = await popupP;
    await popup.waitForURL("https://example.com/x");
    await popup.waitForFunction(() => document.title !== "", null, { timeout: 5000 });
    assert.equal(await popup.title(), "https://example.com", "the link opened in a sandboxed popup");
  } finally {
    await context.close();
  }
});

test("a page opened on its own lets external popups escape, but its own URL stays sandboxed", async (t) => {
  if (skipReason) return t.skip(skipReason);
  const { session } = await api("/api/open", { file: LINKS_FILE });
  const context = await browser.newContext();
  await context.route("https://example.com/**", (r) => r.fulfill(ORIGIN_PAGE));
  try {
    const page = await context.newPage();
    await page.goto(`http://127.0.0.1:${port}/s/${session.id}?key=${ownerKey(STATE)}`);
    await page.goto(`http://127.0.0.1:${port}/s/${session.id}/a/links.html`);
    await page.waitForSelector("#self");
    let popupP = context.waitForEvent("page", { timeout: 5000 });
    await page.click("#self");
    let popup = await popupP;
    await popup.waitForFunction(() => /^origin:/.test(document.title), null, { timeout: 5000 });
    assert.equal(await popup.title(), "origin:null", "a popup on the artifact URL left the sandbox");
    popupP = context.waitForEvent("page", { timeout: 5000 });
    await page.click("#ext");
    popup = await popupP;
    await popup.waitForURL("https://example.com/x");
    await popup.waitForFunction(() => document.title !== "", null, { timeout: 5000 });
    assert.equal(await popup.title(), "https://example.com", "an external link opened sandboxed");
  } finally {
    await context.close();
  }
});
