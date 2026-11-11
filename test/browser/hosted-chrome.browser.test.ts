// Opt-in browser test (npm run test:browser; needs Chrome or CHROME_PATH):
// the review chrome in hosted mode, against a tiny stub of the austere-cloud
// reviewer routes (docs/hosted-share-links.md) served with the service's CSP.
// Covers the name prompt, a send carrying the name, a polled reply, the
// "new version" banner, the footer and the report box.
import assert from "node:assert/strict";
import fs from "node:fs";
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { after, before, test } from "node:test";
import type { Browser } from "playwright-core";
import { launchBrowser } from "../../scripts/lib/browser.ts";

const ID = "pg_test";
const BASE = `/p/${ID}`;
const SHELL_CSP =
  "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'";
const FRAME_CSP =
  "sandbox allow-scripts; default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src data:; connect-src 'none'";

/** A reviewer's send as the chrome posts it. */
interface Send {
  name: string;
  items: unknown;
}
interface Note {
  seq: number;
  author: string;
  items: unknown;
  at: number;
}
interface Reply {
  seq: number;
  text: string;
  at: number;
}

// What the stub service has seen and holds.
const svc: { requests: string[]; sends: Send[]; reports: unknown[]; notes: Note[]; replies: Reply[]; publishedAt: number; gone: boolean } = { requests: [], sends: [], reports: [], notes: [], replies: [], publishedAt: 1_000, gone: false };
let stub: http.Server | undefined;
let origin: string;
let browser: Browser;
let skipReason: string | undefined;

function body(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => resolve(data ? JSON.parse(data) : {}));
  });
}

function json(res: ServerResponse, status: number, value: unknown) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(value));
}

function shell() {
  const boot = { id: ID, title: "Plan", viewer: { role: "reviewer", name: "" }, hosted: { base: BASE, report: `${BASE}/report` } };
  return `<!doctype html>
<html lang="en" data-theme="dark"><head><meta charset="utf-8"><title>Plan · austere</title>
<link rel="stylesheet" href="/rt/chrome/chrome.css">
<script type="application/json" id="austere-boot">${JSON.stringify(boot).replace(/</g, "\\u003c")}</script>
<script src="/rt/chrome/chrome.js" defer></script>
</head><body></body></html>`;
}

const ARTIFACT = `<!doctype html><html><head><title>Plan</title><script src="/rt/austere.js"></script></head>
<body><script type="text/openui">
root = Stack([intro])
intro = TextContent("hello")
</script></body></html>`;

async function handle(req: IncomingMessage, res: ServerResponse) {
  const url = new URL(req.url ?? "", origin);
  svc.requests.push(`${req.method} ${url.pathname}${url.search}`);
  if (req.method === "POST" && req.headers.origin && req.headers.origin !== origin) return json(res, 403, { error: "foreign origin" });
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
  if (url.pathname === `${BASE}/conversation` && req.method === "GET") {
    if (svc.gone) return json(res, 410, { error: "gone" });
    const [n, r] = (url.searchParams.get("after") || "0.0").split(".").map(Number);
    return json(res, 200, {
      publishedAt: svc.publishedAt,
      cursor: `${svc.notes.length}.${svc.replies.length}`,
      notes: svc.notes.filter((x) => x.seq > n),
      replies: svc.replies.filter((x) => x.seq > r),
    });
  }
  if (url.pathname === `${BASE}/send` && req.method === "POST") {
    const b = (await body(req)) as Send;
    svc.sends.push(b);
    svc.notes.push({ seq: svc.notes.length + 1, author: b.name, items: b.items, at: Date.now() });
    return json(res, 200, { ok: true });
  }
  if (url.pathname === `${BASE}/report` && req.method === "POST") {
    svc.reports.push(await body(req));
    return json(res, 200, { ok: true });
  }
  res.writeHead(404).end("not found");
}

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
  const server = http.createServer((req, res) => handle(req, res).catch((err) => json(res, 500, { error: String(err) })));
  stub = server;
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  await browser?.close();
  await new Promise<void>((r) => (stub ? stub.close(() => r()) : r()));
});

test("hosted chrome: name prompt, named send, polled reply, new version, footer and report", async (t) => {
  if (skipReason) return t.skip(skipReason);
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  try {
    const page = await ctx.newPage();
    const cspErrors: string[] = [];
    page.on("console", (m) => m.type() === "error" && /Content Security Policy/.test(m.text()) && cspErrors.push(m.text()));
    page.on("pageerror", (err) => cspErrors.push(String(err)));
    await page.goto(`${origin}${BASE}`);
    await page.waitForSelector(".presence.hosted");
    // The artifact renders through the runtime inside the sandboxed frame.
    await page.frameLocator(".frame").locator("text=hello").waitFor();

    // Owner and local-only controls are gone; the footer is there.
    for (const sel of ['[data-cmd="end"]', '[data-cmd="export"]', '[data-cmd="copy-path"]', ".send-end", ".held-bar"]) {
      assert.equal(await page.locator(sel).count(), 0, `${sel} hidden`);
    }
    const made = page.locator(".hosted-foot a");
    assert.equal(await made.innerText(), "Made with austere-axi");
    assert.equal(await made.getAttribute("href"), "https://github.com/MandalorianBatman/austere-axi");

    // The first send asks for a name, then goes out carrying it.
    await page.fill(".composer textarea", "tighten the intro");
    await page.click(".composer .send");
    await page.waitForSelector(".name-ask:not([hidden])");
    assert.equal(svc.sends.length, 0, "nothing sent before a name is given");
    await page.fill(".name-ask input", "  Ana  ");
    await page.press(".name-ask input", "Enter");
    await page.waitForSelector(".msg.user");
    assert.deepEqual(svc.sends, [{ name: "Ana", items: [{ kind: "message", text: "tighten the intro" }] }]);
    assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem("austere:name") as string)), "Ana");
    assert.match(await page.locator(".msg.user .who").innerText(), /^You/);
    assert.match(await page.locator(".composer-hint").innerText(), /Posting as Ana/);
    assert.ok(await page.locator(".name-ask").isHidden());

    // A reply on the service shows up on the next check (focus triggers one) after the last cursor.
    svc.replies.push({ seq: 1, text: "Done, **tightened**.", at: Date.now() });
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await page.waitForSelector(".msg.agent");
    assert.match(await page.locator(".msg.agent .md").innerText(), /Done, tightened\./);
    assert.ok(svc.requests.includes(`GET ${BASE}/conversation?after=1.0`), svc.requests.join("\n"));

    // A republish changes publishedAt: offer a reload.
    assert.ok(await page.locator(".banner").isHidden());
    svc.publishedAt = 2_000;
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await page.waitForSelector(".banner:not([hidden])");
    assert.match(await page.locator(".banner").innerText(), /New version, reload/);

    // Report opens a reason box and posts it to BOOT.hosted.report.
    await page.click(".hosted-foot .report-open");
    await page.fill(".report-box textarea", "phishing page");
    await page.click(".report-box >> text=Send report");
    await page.waitForSelector(".hosted-foot .report-done");
    assert.deepEqual(svc.reports, [{ reason: "phishing page" }]);

    // A second visit remembers the name: sends go straight out.
    await page.reload();
    await page.waitForSelector(".presence.hosted");
    await page.fill(".composer textarea", "and the outro");
    await page.click(".composer .send");
    await page.waitForFunction(() => document.querySelectorAll(".msg.user").length === 2);
    assert.equal(svc.sends[1].name, "Ana");

    // No local-server traffic: no event stream, no bye beacon, nothing under /s/.
    assert.ok(!svc.requests.some((r) => /\/events|\/bye|\/s\//.test(r)), svc.requests.join("\n"));

    // Malformed note items from the service are dropped, not fatal.
    svc.notes.push({ seq: svc.notes.length + 1, author: "Bo", items: [null, 7, { kind: "message", text: "ok from Bo" }], at: Date.now() });
    svc.notes.push({ seq: svc.notes.length + 1, author: "Cy", items: "nope", at: Date.now() });
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await page.waitForSelector("text=ok from Bo");

    // The page is removed (410): presence says so and the composer locks.
    svc.gone = true;
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await page.waitForSelector(".presence.ended");
    assert.match(await page.locator(".presence").innerText(), /Page removed/);
    assert.ok(await page.locator(".composer textarea").isDisabled());
    assert.ok(await page.locator(".composer .send").isDisabled());
    assert.deepEqual(cspErrors, []);
  } finally {
    await ctx.close();
  }
});
