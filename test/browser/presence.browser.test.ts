// Opt-in browser test (npm run test:browser; needs Chrome or CHROME_PATH): presence in the
// hosted chrome (docs/hosted-share-links.md, "Presence (Q17)") against a stub page socket that
// records the chrome's presence frames and plays the server's. Covers hello with the prompt name,
// roster chips with status, other viewers' focus outlined and labelled in the frame, chip click,
// this viewer's focus and writing status, bye, and a closed socket clearing the roster.
import assert from "node:assert/strict";
import fs from "node:fs";
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { after, before, test } from "node:test";
import type { Browser, Page } from "playwright-core";
import { WebSocketServer } from "ws";
import type { WebSocket } from "ws";
import { SUBPROTOCOL } from "../../src/shared/sync.ts";
import type { ClientPresence, ServerPresence } from "../../src/shared/sync.ts";
import { launchBrowser } from "../../scripts/lib/browser.ts";

const ID = "pg_presence";
const BASE = `/p/${ID}`;
const SHELL_CSP =
  "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'";
const FRAME_CSP =
  "sandbox allow-scripts; default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src data:; connect-src 'none'";

const ARTIFACT = `<!doctype html><html><head><title>Plan</title><script src="/rt/austere.js"></script></head>
<body><script type="text/openui">
root = Stack([intro, plan])
intro = TextContent("Intro paragraph")
plan = TextContent("Plan paragraph")
</script></body></html>`;

let server: http.Server | undefined;
let origin: string;
let browser: Browser;
let skipReason: string | undefined;
/** The chrome's socket, the presence frames it sent, and who waits for the next one. */
let socket: WebSocket | null = null;
const received: ClientPresence[] = [];
let wake: (() => void) | null = null;

function shell() {
  const boot = { id: ID, title: "Plan", viewer: { role: "reviewer", name: "" }, hosted: { base: BASE } };
  return `<!doctype html>
<html lang="en" data-theme="dark"><head><meta charset="utf-8"><title>Plan · austere</title>
<link rel="stylesheet" href="/rt/chrome/chrome.css">
<script type="application/json" id="austere-boot">${JSON.stringify(boot).replace(/</g, "\\u003c")}</script>
<script src="/rt/chrome/chrome.js" defer></script>
</head><body></body></html>`;
}

function handle(req: IncomingMessage, res: ServerResponse) {
  const url = new URL(req.url ?? "", origin);
  if (url.pathname === BASE) {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "content-security-policy": SHELL_CSP });
    return res.end(shell());
  }
  if (url.pathname === `${BASE}/a/`) {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "content-security-policy": FRAME_CSP });
    return res.end(ARTIFACT);
  }
  const asset = ({ "/rt/chrome/chrome.js": "dist/chrome/chrome.js", "/rt/chrome/chrome.css": "dist/chrome/chrome.css", "/rt/austere.js": "dist/austere.js" } as Record<string, string | undefined>)[url.pathname];
  if (asset) {
    res.writeHead(200, { "content-type": asset.endsWith(".css") ? "text/css" : "text/javascript" });
    return res.end(fs.readFileSync(asset));
  }
  // The chrome still polls the conversation; an empty one keeps it quiet.
  if (url.pathname === `${BASE}/conversation`) {
    res.writeHead(200, { "content-type": "application/json" });
    return res.end(JSON.stringify({ publishedAt: 1, cursor: "0.0", notes: [], replies: [] }));
  }
  res.writeHead(404).end("not found");
}

/** The first frame of type `t` the chrome sent, removed from the buffer. */
async function frameFrom(t: ClientPresence["t"], ms = 5000): Promise<ClientPresence> {
  const deadline = Date.now() + ms;
  for (;;) {
    const i = received.findIndex((f) => f.t === t);
    if (i >= 0) return received.splice(i, 1)[0];
    const left = deadline - Date.now();
    if (left <= 0) throw new Error(`no ${t} frame; got ${JSON.stringify(received)}`);
    const { promise, resolve } = Promise.withResolvers<void>();
    wake = resolve;
    // The guard of a test that waits for a frame, not a delay.
    const guard = setTimeout(resolve, left);
    await promise;
    clearTimeout(guard);
  }
}

function play(frame: ServerPresence) {
  socket?.send(JSON.stringify(frame));
}

const BO = { id: "v-bo", name: "Bo", colour: "#0090ff", role: "reviewer" as const };
const OWNER = { id: "v-owner", name: "Owner", colour: "#e5484d", role: "owner" as const };

before(async () => {
  for (const f of ["austere.js", "chrome/chrome.js", "chrome/chrome.css"]) {
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
  server = http.createServer(handle);
  const wss = new WebSocketServer({ noServer: true, handleProtocols: (protocols) => (protocols.has(SUBPROTOCOL) ? SUBPROTOCOL : false) });
  server.on("upgrade", (req, sock, head) => {
    if (req.url !== `${BASE}/sync`) return sock.destroy();
    wss.handleUpgrade(req, sock, head, (ws) => {
      socket = ws;
      ws.on("message", (data) => {
        received.push(JSON.parse(String(data)));
        wake?.();
      });
    });
  });
  await new Promise<void>((r) => server!.listen(0, "127.0.0.1", r));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  await browser?.close();
  socket?.terminate();
  await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
});

/** Waits until the frame's focus outlines carry exactly these name tags, outline by outline. */
async function outlinesAre(page: Page, names: string[][]) {
  const frame = await (await page.$(".frame"))!.contentFrame();
  await frame!.waitForFunction(
    (want) => JSON.stringify([...document.querySelectorAll(".austere-focus")].map((el) => [...el.querySelectorAll(".austere-focus-names > span")].map((s) => s.textContent))) === want,
    JSON.stringify(names),
  );
}

test("hosted chrome presence: roster chips, focus outlines, own focus and status", async (t) => {
  if (skipReason) return t.skip(skipReason);
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  // The name prompt answered on an earlier visit.
  await ctx.addInitScript(() => {
    // Not in the sandboxed frame, which has no storage.
    if (window === window.top) localStorage.setItem("austere:name", JSON.stringify("Ana"));
  });
  try {
    const page = await ctx.newPage();
    const errors: string[] = [];
    page.on("pageerror", (err) => errors.push(String(err)));
    page.on("console", (m) => m.type() === "error" && /Content Security Policy/.test(m.text()) && errors.push(m.text()));
    await page.goto(`${origin}${BASE}`);
    await page.frameLocator(".frame").locator("text=Intro paragraph").waitFor();

    // Joins with the prompt name.
    assert.deepEqual(await frameFrom("hello"), { v: 1, t: "hello", status: "viewing", name: "Ana" });
    assert.ok(await page.locator(".viewers").isHidden(), "no chips before the roster");

    // The roster: Bo (focused on plan) and the owner, then this viewer (self, no chip).
    play({ v: 1, t: "hello", viewer: BO, status: "viewing", focus: "plan", self: false });
    play({ v: 1, t: "hello", viewer: OWNER, status: "away", focus: null, self: false });
    play({ v: 1, t: "hello", viewer: { id: "v-ana", name: "Ana", colour: "#46a758", role: "reviewer" }, status: "viewing", focus: null, self: true });
    await page.waitForFunction(() => document.querySelectorAll(".viewers .viewer").length === 2);
    const chips = page.locator(".viewers .viewer");
    assert.equal(await chips.nth(0).innerText(), "B");
    assert.match((await chips.nth(0).getAttribute("title")) ?? "", /^Bo · viewing · click to see where$/);
    assert.match((await chips.nth(1).getAttribute("class")) ?? "", /\baway\b/);
    assert.ok(await chips.nth(1).isDisabled(), "no focus, nothing to scroll to");
    await outlinesAre(page, [["Bo"]]);
    const box = page.frameLocator(".frame").locator(".austere-focus");
    assert.equal(await box.evaluate((el) => getComputedStyle(el).borderTopColor), "rgb(0, 144, 255)");

    // Status and focus deltas; two viewers on one statement share an outline.
    play({ v: 1, t: "status", viewer: "v-bo", status: "writing" });
    await page.waitForSelector(".viewers .viewer.writing");
    play({ v: 1, t: "focus", viewer: "v-owner", statement: "plan" });
    await outlinesAre(page, [["Bo", "Owner"]]);
    assert.ok(!(await chips.nth(1).isDisabled()));
    play({ v: 1, t: "focus", viewer: "v-bo", statement: "intro" });
    await outlinesAre(page, [["Bo"], ["Owner"]]);
    play({ v: 1, t: "focus", viewer: "v-bo", statement: null });
    await outlinesAre(page, [["Owner"]]);

    // A chip with a focus scrolls the frame to it (the frame flashes the statement).
    await chips.nth(1).click();
    await page.frameLocator(".frame").locator(".austere-flash").first().waitFor();

    // This viewer's click in Annotate mode is its focus; the composer open is "writing".
    await page.click('[data-mode="annotate"]');
    await page.frameLocator(".frame").locator("text=Intro paragraph").click();
    assert.deepEqual(await frameFrom("focus"), { v: 1, t: "focus", statement: "intro" });
    await page.keyboard.press("Escape");
    await page.focus(".composer textarea");
    assert.deepEqual(await frameFrom("status"), { v: 1, t: "status", status: "writing" });
    await page.locator(".composer textarea").blur();
    assert.deepEqual(await frameFrom("status"), { v: 1, t: "status", status: "viewing" });

    // bye removes the chip and its outline.
    play({ v: 1, t: "bye", viewer: "v-owner" });
    await page.waitForFunction(() => document.querySelectorAll(".viewers .viewer").length === 1);
    await outlinesAre(page, []);

    // A dropped socket clears the roster; the reconnect joins again with the current focus.
    received.length = 0;
    socket?.terminate();
    await page.waitForSelector(".viewers", { state: "hidden" });
    assert.deepEqual(await frameFrom("hello", 10_000), { v: 1, t: "hello", status: "viewing", name: "Ana" });
    assert.deepEqual(await frameFrom("focus"), { v: 1, t: "focus", statement: "intro" });
    assert.deepEqual(errors, []);
  } finally {
    await ctx.close();
  }
});
