// Opt-in browser test (npm run test:browser; needs Chrome or CHROME_PATH): the hub's Settings (RLM-396) on a
// seeded state dir. Each section loads; a request is approved, a link made and a device revoked from the page;
// the default for new reviewers' notes is saved; a project is renamed; a reviewer gets 403 and another site's
// POST is refused. Set HUB_SHOTS to a folder to keep screenshots at 1280 and 390 px.
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import type { Browser, BrowserContext, Page } from "playwright-core";
import { launchBrowser } from "../../scripts/lib/browser.ts";
import { ownerKey } from "../../src/cli/invites.ts";
import { claimLink, ownerHeaders } from "../owner.ts";
import { freePort } from "../port.ts";

const STATE = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "austere-settings-browser-state-")));
const WORK = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "austere-settings-browser-work-")));
const CLI = path.resolve("src/cli/main.ts");
const KEY = ownerKey(STATE);
const SHOP = path.join(WORK, "shop");
let port: number;
let server: ChildProcess;
let browser: Browser;
let skipReason: string | undefined;
const ids: Record<string, string> = {};

function call<T>(method: string, route: string, body?: unknown, headers: Record<string, string> = { "x-austere-key": KEY }): Promise<{ status: number; data: T }> {
  const { promise, resolve, reject } = Promise.withResolvers<{ status: number; data: T }>();
  const r = http.request({ host: "127.0.0.1", port, method, path: route, headers: { "content-type": "application/json", host: `127.0.0.1:${port}`, ...headers } }, (res) => {
    let data = "";
    res.on("data", (c) => (data += c));
    res.on("end", () => resolve({ status: res.statusCode ?? 0, data: (data.startsWith("{") ? JSON.parse(data) : data) as T }));
  });
  r.on("error", reject);
  r.end(body === undefined ? undefined : JSON.stringify(body));
  return promise;
}

function writePage(file: string, title: string): string {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(
    file,
    `<!doctype html><html><head><title>${title}</title><script src="https://cdn.jsdelivr.net/npm/austere-axi@0/dist/austere.js"></script></head>
<body><script type="text/openui">
root = Stack([intro])
intro = TextContent("${title}")
</script></body></html>`,
  );
  return file;
}

async function shot(page: Page, name: string) {
  if (process.env.HUB_SHOTS) await page.screenshot({ path: path.join(process.env.HUB_SHOTS, `${name}.png`), fullPage: true });
}

/** A signed-in owner tab on Settings at `width`, collecting page errors; dialogs (confirm, prompt) answer `answer`. */
async function ownerTab(width = 1280, answer = ""): Promise<{ page: Page; context: BrowserContext; problems: string[] }> {
  const context = await browser.newContext({ viewport: { width, height: width > 500 ? 900 : 844 } });
  const page = await context.newPage();
  const problems: string[] = [];
  page.on("pageerror", (e) => problems.push(`pageerror: ${e.message}`));
  page.on("console", (m) => {
    if (m.type() === "error") problems.push(`console error: ${m.text()}`);
  });
  page.on("dialog", (d) => void d.accept(answer || undefined));
  const { data } = await call<{ code: string }>("POST", "/api/login", {});
  await page.goto(`http://127.0.0.1:${port}/?view=settings&login=${data.code}`);
  await page.locator("h1", { hasText: "Settings" }).waitFor();
  return { page, context, problems };
}

const part = (page: Page, id: string) => page.locator(`#set-${id}`);

before(async () => {
  for (const f of ["austere.js", "chrome/chrome.js", "chrome/shell.js"]) {
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
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    AUSTERE_AXI_STATE_DIR: STATE,
    AUSTERE_AXI_PORT: String(port),
    AUSTERE_AXI_NO_TAILSCALE: "1",
    AUSTERE_AXI_LINK_HOST: "127.0.0.1",
    AUSTERE_AXI_CLOUD_URL: "http://127.0.0.1:9",
    AUSTERE_AXI_NO_OPEN: "1",
    OPENUI_TELEMETRY_DISABLED: "1",
  };
  for (const name of ["PI_SESSION_ID", "PI_SESSION_FILE", "COPILOT_AGENT_SESSION_ID", "DSH_SESSION_ID"]) delete env[name];
  server = spawn(process.execPath, [CLI, "server", "--port", String(port)], { env, stdio: "ignore" });
  for (let i = 0; i < 100 && !(await fetch(`http://127.0.0.1:${port}/api/health`).then((r) => r.ok, () => false)); i++) await new Promise((r) => setTimeout(r, 50));

  fs.mkdirSync(path.join(SHOP, ".git"), { recursive: true });
  for (const [key, name] of [
    ["plan", "plan"],
    ["notes", "notes"],
  ]) {
    const r = await call<{ session: { id: string } }>("POST", "/api/open", { file: writePage(path.join(SHOP, "docs", `${name}.html`), `Checkout ${name}`) });
    ids[key] = r.data.session.id;
  }
  // A device (Ana, by link) and a browser asking for access (Bo).
  const shared = await call<{ link: string }>("POST", "/api/share", { file: path.join(SHOP, "docs", "plan.html"), name: "Ana" });
  ids.anaCookie = await claimLink(port, shared.data.link);
  assert.equal((await call("POST", "/api/share/requests", { on: true })).status, 200);
  // From another address than the owner's 127.0.0.1, as requests.test.ts asks.
  const { promise, resolve, reject } = Promise.withResolvers<number>();
  const ask = http.request(
    { host: "127.0.0.1", port, method: "POST", path: `/s/${ids.notes}/request`, localAddress: "127.0.0.2", headers: { host: `127.0.0.1:${port}`, origin: `http://127.0.0.1:${port}`, "content-type": "application/x-www-form-urlencoded", "user-agent": "Mozilla/5.0 (X11; Linux x86_64) Chrome/120.0" } },
    (res) => resolve((res.resume(), res.statusCode ?? 0)),
  );
  ask.on("error", reject);
  ask.end(new URLSearchParams({ name: "Bo" }).toString());
  assert.ok((await promise) < 400, "Bo asks");
});

after(async () => {
  await browser?.close();
  if (server && server.exitCode === null) {
    const exited = once(server, "exit");
    server.kill();
    await exited;
  }
  fs.rmSync(STATE, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  fs.rmSync(WORK, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
});

test("settings: every section loads; a request is approved; a link is made; the default for notes is saved", async (t) => {
  if (skipReason) return t.skip(skipReason);
  const { page, context, problems } = await ownerTab();
  try {
    for (const id of ["people", "network", "review", "cloud", "projects", "about"]) assert.ok(await part(page, id).isVisible(), id);
    assert.equal((await page.locator('.views a[data-view="settings"] .count').innerText()).trim(), "1", "one person waits");
    // Network: this computer, the address to share, always on, Tailscale names and the local-network switch.
    const net = part(page, "network");
    assert.match(await net.locator('[data-kind="this_computer"]').innerText(), new RegExp(`http://127\\.0\\.0\\.1:${port}`));
    assert.match(await net.locator(".share-addr").innerText(), new RegExp(`http://127\\.0\\.0\\.1:${port}[\\s\\S]*AUSTERE_AXI_LINK_HOST`));
    assert.match(await net.locator("[data-always]").innerText(), /stops after 30 minutes without use[\s\S]*server install/);
    assert.equal(await net.locator('[data-slot="tailscale-identity"] form').count(), 1, "a Tailscale login can be let in");
    const lan = net.locator('[data-slot="local-network"]');
    assert.equal(await lan.locator("input[type=checkbox]").isChecked(), false, "the local network is off by default");
    assert.match(await lan.innerText(), /Traffic on this network is not encrypted\. Others on the same network could read pages, notes and reviewers' access\./);
    assert.match(await part(page, "about").innerText(), new RegExp(`State folder\\s+${STATE.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
    await shot(page, "settings-1280");

    // People: Bo waits; approve for the project.
    const bo = page.locator("[data-request]", { hasText: "Bo" });
    await bo.locator('select[name="scope"]').selectOption({ label: "Every page in shop" });
    await bo.getByRole("button", { name: "Approve" }).click();
    await page.locator(".status", { hasText: "Bo is in: project shop" }).waitFor();
    await page.locator("[data-device]", { hasText: "Bo" }).waitFor();
    assert.equal(await page.locator('.views a[data-view="settings"] .count').count(), 0, "nobody waits now");

    // A new link from Settings: listed under the links nobody has opened.
    await page.locator(".new-link input[name=name]").fill("Cy");
    await page.locator(".new-link select[name=page]").selectOption(ids.plan);
    await page.locator(".new-link").getByRole("button", { name: "Create link" }).click();
    await page.locator(".status", { hasText: "Link for Cy" }).waitFor();
    await page.locator("[data-link]", { hasText: "Cy" }).waitFor();

    // Review defaults: straight to the agent, then a share that does not say takes it.
    await part(page, "review").getByLabel("Send them straight to the agent").check();
    await page.locator(".status", { hasText: "go straight to the agent" }).waitFor();
    const made = await call<{ auto: boolean }>("POST", "/api/share", { file: path.join(SHOP, "docs", "plan.html"), name: "Di" });
    assert.equal(made.data.auto, true, "the default applies");
    const held = await call<{ auto: boolean }>("POST", "/api/share", { file: path.join(SHOP, "docs", "plan.html"), name: "Ed", auto: false });
    assert.equal(held.data.auto, false, "a share that says keeps its own");

    // Cloud: off by default; the switch turns it on and off, and settings.json follows.
    const cloudSwitch = part(page, "cloud").locator('[data-slot="cloud"] input[type=checkbox]');
    assert.equal(await cloudSwitch.isChecked(), false, "cloud features are off by default");
    assert.match(await part(page, "cloud").innerText(), /Off: only local features work/);
    await cloudSwitch.check();
    await page.locator(".status", { hasText: "Cloud features are on" }).waitFor();
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(STATE, "settings.json"), "utf8")), { cloud: true });
    await part(page, "cloud").locator('[data-slot="cloud"] input[type=checkbox]').uncheck();
    await page.locator(".status", { hasText: "Cloud features are off" }).waitFor();
    assert.equal((await call<{ on: boolean }>("GET", "/api/settings/cloud")).data.on, false);
    assert.deepEqual(problems, []);
  } finally {
    await context.close();
  }
});

test("settings: revoke a device, rename a project; a reviewer gets 403; another site's POST is refused", async (t) => {
  if (skipReason) return t.skip(skipReason);
  const { page, context, problems } = await ownerTab(1280, "storefront");
  try {
    const ana = page.locator("[data-device]", { hasText: "Ana" });
    await ana.getByRole("button", { name: "Revoke Ana" }).click();
    await page.locator(".status", { hasText: "Revoked Ana" }).waitFor();
    await page.locator("[data-device]", { hasText: "Ana" }).waitFor({ state: "detached" });
    assert.equal((await call("GET", `/s/${ids.plan}`, undefined, { cookie: ids.anaCookie })).status, 403, "Ana is cut off");

    await part(page, "projects").getByRole("button", { name: "Rename shop" }).click();
    await page.locator(".status", { hasText: "Renamed shop to storefront." }).waitFor();
    await page.locator(".proj-link", { hasText: "storefront" }).waitFor();
    assert.deepEqual(problems, []);
  } finally {
    await context.close();
  }

  // A reviewer's device: refused, page and API.
  const shared = await call<{ link: string }>("POST", "/api/share", { file: path.join(SHOP, "docs", "plan.html"), name: "Fy" });
  const cookie = await claimLink(port, shared.data.link);
  const reviewer = { cookie, origin: `http://127.0.0.1:${port}` };
  for (const route of ["/?view=settings", "/hub/api/settings", "/hub/api/people", "/hub/api/people/requests"]) assert.equal((await call("GET", route, undefined, reviewer)).status, 403, route);
  for (const route of ["/hub/api/settings/review", "/hub/api/settings/cloud", "/hub/api/people/share", "/hub/api/projects/archive-missing"]) assert.equal((await call("POST", route, { auto: true, on: true }, reviewer)).status, 403, route);
  // The owner's cookie from another site's page: refused.
  const foreign = { cookie: ownerHeaders(STATE).cookie, origin: "https://evil.example" };
  for (const route of ["/hub/api/settings/review", "/hub/api/settings/cloud", "/hub/api/people/share", "/hub/api/projects/archive-missing"]) assert.equal((await call("POST", route, { auto: true, on: true }, foreign)).status, 403, route);
  assert.equal((await call("GET", "/hub/api/settings", undefined, foreign)).status, 403);
});

test("settings at phone width: one column, no sideways scroll", async (t) => {
  if (skipReason) return t.skip(skipReason);
  const { page, context, problems } = await ownerTab(390);
  try {
    await part(page, "about").waitFor();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    // The element sticking out, for the failure message.
    const wide = await page.evaluate(() => {
      const el = [...document.querySelectorAll(".content *")].find((e) => e.getBoundingClientRect().right > document.documentElement.clientWidth);
      return el ? `${el.tagName.toLowerCase()}.${el.className} "${(el.textContent || "").slice(0, 40)}"` : "";
    });
    assert.ok(overflow <= 0, `no sideways scroll (${overflow}px): ${wide}`);
    await shot(page, "settings-390");
    await page.locator(".set-nav a", { hasText: "Network" }).click();
    await page.waitForFunction(() => Math.abs(document.getElementById("set-network")!.getBoundingClientRect().top) < 40);
    assert.match(page.url(), /view=settings$/, "the jump leaves the address as it is");
    assert.deepEqual(problems, []);
  } finally {
    await context.close();
  }
});

test("the page's Share with the default auto and attach on: untouched it holds the notes; choosing auto again is refused", async (t) => {
  if (skipReason) return t.skip(skipReason);
  const owner = { cookie: ownerHeaders(STATE).cookie, origin: `http://127.0.0.1:${port}` };
  const file = writePage(path.join(SHOP, "docs", "attached.html"), "Attached page");
  const id = (await call<{ session: { id: string } }>("POST", "/api/open", { file })).data.session.id;
  assert.equal((await call("POST", "/api/share/default", { auto: true })).status, 200);
  const on = await call("POST", `/s/${id}/attach`, { state: "on" }, owner);
  assert.equal(on.status, 200, JSON.stringify(on.data));
  const { page, context, problems } = await ownerTab();
  const share = async (name: string) => {
    await page.goto(`http://127.0.0.1:${port}/s/${id}`);
    await page.waitForSelector(".composer textarea");
    await page.click(".menu-btn");
    await page.click('[data-cmd="share"]');
    await page.waitForSelector("dialog.share[open]");
    assert.ok(await page.locator('dialog.share input[name=mode][value=auto]').isChecked(), "the dialog starts at the default");
    await page.fill("dialog.share input[name=name]", name);
  };
  try {
    await share("Gil");
    await page.click("dialog.share button[type=submit]");
    await page.locator("dialog.share", { hasText: "Their notes wait for you." }).waitFor();

    await share("Hal");
    await page.locator("dialog.share label", { hasText: "Go straight to the agent" }).click();
    await page.click("dialog.share button[type=submit]");
    await page.locator("dialog.share .share-error:not([hidden])").waitFor();
    assert.match(await page.locator("dialog.share .share-error:not([hidden])").innerText(), /attach/i);
    assert.deepEqual(problems.filter((p) => !/409/.test(p)), []);
  } finally {
    await context.close();
    await call("POST", "/api/share/default", { auto: false });
  }
});
