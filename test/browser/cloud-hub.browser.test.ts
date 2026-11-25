// Opt-in browser test (npm run test:browser; needs Chrome or CHROME_PATH): the hub shell in cloud mode (RLM-458,
// boot `mode: "cloud"`), against a stub of austere-cloud's `/hub/api` typed by src/shared/hub-api.ts. Pages grouped by
// project with an Ungrouped group; the Pages and Shared views only (nothing a machine holds is asked for); the People
// dialog (grant, revoke, refusals); the account footer with Sign out; the empty states; a phone. Set CLOUD_HUB_SHOTS
// to a folder to keep screenshots.
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { after, before, test } from "node:test";
import type { Browser, BrowserContext, Page } from "playwright-core";
import { launchBrowser } from "../../scripts/lib/browser.ts";
import type {
  GrantResult,
  GrantsResponse,
  HubBoot,
  PagesResponse,
  ProjectsResponse,
  SearchResponse,
  SharedResponse,
  ShellPage,
  CloudUngrouped,
} from "../../src/shared/hub-api.ts";
import { freePort } from "../port.ts";

const DAY = 86_400_000;
const NOW = Date.now();
const UNGROUPED: CloudUngrouped = "~ungrouped";
const ME = { email: "olga@example.com", name: "Olga Ruiz" };
let port: number;
let server: http.Server;
let browser: Browser;
let skipReason: string | undefined;
/** Every route the shell asked for, "METHOD /path". */
const asked: string[] = [];
let boot: HubBoot;
let owned: ShellPage[];
let grants: Map<string, { email: string; added_at: number }[]>;
let shared: SharedResponse;

function shellPage(
  id: string,
  title: string | null,
  project: string,
  rel: string,
  days: number,
  notes: number,
): ShellPage {
  const ungrouped = project === "";
  return {
    id,
    project_id: ungrouped ? UNGROUPED : project,
    project: ungrouped ? "Ungrouped" : project,
    rel_path: rel,
    title,
    updated_at: NOW,
    activity: NOW,
    open_id: id,
    copies: [],
    unanswered: 0,
    addressed: 0,
    held: 0,
    attach: "off",
    needs_you: false,
    changed: 0,
    failed: 0,
    waiting_on_agent: false,
    taker: null,
    run_active: false,
    group: "quiet",
    cloud: { expires_at: NOW + days * DAY, notes, people: grants.get(id)?.length ?? 0 },
  };
}

function seed(): void {
  boot = { version: "0.test", home: "", sep: "/", mode: "cloud", account: ME };
  grants = new Map([
    ["aaaa11112222", [{ email: "ana@example.com", added_at: NOW - 2 * DAY }]],
    ["cccc33334444", []],
  ]);
  owned = [
    shellPage("aaaa11112222", "Checkout plan", "shop", "docs/plan.html", 29, 4),
    shellPage("bbbb22223333", "Pricing review", "shop", "docs/pricing.html", 2, 0),
    shellPage("cccc33334444", null, "", "", 0.5, 1),
  ];
  shared = {
    pages: [
      {
        id: "dddd44445555",
        title: "Q3 rollout plan",
        owner: "Ana Ruiz",
        expires_at: NOW + 12 * DAY,
      },
    ],
  };
}

function projects(): ProjectsResponse {
  const by = new Map<string, ShellPage[]>();
  for (const p of owned) by.set(p.project_id, [...(by.get(p.project_id) ?? []), p]);
  return {
    projects: [...by].map(([id, list]) => ({
      id,
      name: list[0].project,
      roots: [],
      same_as: null,
      pages: list.length,
      unanswered: 0,
      needs_you: 0,
    })),
  };
}

function send(
  res: http.ServerResponse,
  status: number,
  body: unknown,
  type = "application/json",
): void {
  res.writeHead(status, { "content-type": type, "cache-control": "no-store" });
  res.end(typeof body === "string" || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}

function grantsOf(id: string): GrantsResponse {
  return { owner: ME.email, grants: grants.get(id) ?? [], limit: 100 };
}

function route(req: http.IncomingMessage, res: http.ServerResponse, body: string): void {
  const url = new URL(req.url ?? "/", `http://127.0.0.1:${port}`);
  asked.push(`${req.method} ${url.pathname}`);
  const p = url.pathname;
  if (p === "/favicon.ico") return send(res, 204, "");
  if (p === "/") {
    return send(
      res,
      200,
      `<!doctype html><html lang="en" data-theme="dark"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover"><title>austere cloud</title>
<link rel="stylesheet" href="/__austere/chrome/shell.css"><script>window.__AUSTERE_HUB__=${JSON.stringify(boot)}</script>
<script src="/__austere/chrome/shell.js" defer></script></head><body></body></html>`,
      "text/html",
    );
  }
  const asset = /^\/__austere\/chrome\/(shell\.(?:js|css))$/.exec(p);
  if (asset) {
    const type = asset[1].endsWith(".js") ? "text/javascript" : "text/css";
    return send(res, 200, fs.readFileSync(path_(asset[1])), type);
  }
  if (p === "/hub/api/projects") return send(res, 200, projects());
  if (p === "/hub/api/pages") {
    const want = url.searchParams.get("project") ?? "";
    const list = want ? owned.filter((x) => x.project_id === want || x.project === want) : owned;
    const out: PagesResponse = {
      view: "open",
      project: want
        ? { id: list[0]?.project_id ?? "", name: list[0]?.project ?? want, ref: want }
        : null,
      pages: list,
      counts: { open: list.length, everything: list.length, archived: 0, checked: 0 },
    };
    return send(res, 200, out);
  }
  if (p === "/hub/api/shared") return send(res, 200, shared);
  if (p === "/hub/api/search") {
    const q = (url.searchParams.get("q") ?? "").toLowerCase();
    const out: SearchResponse = {
      q,
      pages: owned.filter((x) => (x.title ?? "").toLowerCase().includes(q)),
      parts: [],
    };
    return send(res, 200, out);
  }
  const g = /^\/hub\/api\/pages\/([^/]+)\/grants(\/remove)?$/.exec(p);
  if (g) {
    if (!owned.some((x) => x.id === g[1])) return send(res, 404, { error: "page not found" });
    if (req.method === "GET") return send(res, 200, grantsOf(g[1]));
    const email = String((JSON.parse(body || "{}") as { email?: unknown }).email ?? "");
    if (!/^[^\s@]+@[^\s@]+$/.test(email))
      return send(res, 400, { error: "email must be an email address" });
    const list = grants.get(g[1]) ?? [];
    let status: GrantResult["status"];
    if (g[2]) {
      grants.set(
        g[1],
        list.filter((x) => x.email !== email),
      );
      status = "revoked";
    } else if (list.some((x) => x.email === email)) status = "exists";
    else {
      grants.set(g[1], [...list, { email, added_at: Date.now() }]);
      status = "granted";
    }
    for (const x of owned) if (x.cloud) x.cloud.people = grants.get(x.id)?.length ?? 0;
    return send(res, 200, { ...grantsOf(g[1]), status } satisfies GrantResult);
  }
  send(res, 404, { error: "not found" });
}

const path_ = (f: string): string => path.join("dist", "chrome", f);

before(async () => {
  for (const f of ["chrome/shell.js", "chrome/shell.css"]) {
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
  server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => route(req, res, body));
  });
  await new Promise<void>((r) => server.listen(port, "127.0.0.1", r));
});

after(async () => {
  await browser?.close();
  server?.close();
});

async function tab(
  width = 1280,
): Promise<{ page: Page; context: BrowserContext; problems: string[] }> {
  seed();
  asked.length = 0;
  const context = await browser.newContext({
    viewport: { width, height: width > 500 ? 900 : 844 },
  });
  const page = await context.newPage();
  const problems: string[] = [];
  page.on("pageerror", (e) => problems.push(`pageerror: ${e.message}`));
  page.on("console", (m) => {
    if (m.type() === "error") problems.push(`console error: ${m.text()}`);
  });
  await page.goto(`http://127.0.0.1:${port}/`);
  await page
    .locator("h1", { hasText: "Pages" })
    .waitFor({ timeout: 10_000 })
    .catch(async (err: Error) => {
      throw new Error(
        `${err.message}\n${problems.join("\n")}\n${(await page.locator("body").innerText()).slice(0, 400)}`,
      );
    });
  return { page, context, problems };
}

async function shot(page: Page, name: string, fullPage = true): Promise<void> {
  if (process.env.CLOUD_HUB_SHOTS) {
    // A dialog fades in.
    if (!fullPage) await page.waitForTimeout(500);
    await page.screenshot({
      path: path.join(process.env.CLOUD_HUB_SHOTS, `${name}.png`),
      fullPage,
    });
  }
}

const noHScroll = (page: Page): Promise<number> =>
  page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

test("pages by project with an Ungrouped group; Pages and Shared only; links go to /p/<id>; nothing a machine holds is asked for", async (t) => {
  if (skipReason) return t.skip(skipReason);
  const { page, context, problems } = await tab();
  try {
    const side = page.getByRole("complementary", { name: "Projects" });
    assert.deepEqual(
      (await side.locator(".proj-link").allInnerTexts()).map((x) => x.trim()),
      ["shop", "Ungrouped"],
    );
    assert.deepEqual(
      (await side.getByRole("list", { name: "Views" }).getByRole("link").allInnerTexts()).map((x) =>
        x.trim(),
      ),
      ["Pages", "Shared"],
      "no Inbox, Notes, Runs or Settings",
    );
    assert.equal(
      await side.getByRole("link", { name: "Pricing review" }).getAttribute("href"),
      "/p/bbbb22223333",
    );
    assert.equal(
      await page.getByRole("link", { name: "Checkout plan" }).first().getAttribute("href"),
      "/p/aaaa11112222",
    );
    // The row table: People count, notes, expiry in words.
    const row = page.locator(".trow", { hasText: "Pricing review" });
    assert.match(await row.innerText(), /No notes yet/);
    assert.match(await row.innerText(), /Expires in 2 days/);
    assert.match(
      await page.locator(".trow", { hasText: "Untitled page" }).innerText(),
      /Expires today/,
    );
    assert.match(await page.locator(".trow", { hasText: "Checkout plan" }).innerText(), /4 notes/);
    assert.match(
      await page.locator(".trow", { hasText: "Checkout plan" }).innerText(),
      /Expires .* · in 29 days/,
    );
    // Account footer: who, and Sign out as a form POST.
    const foot = side.locator(".account");
    assert.match(await foot.innerText(), /Olga Ruiz\s+olga@example\.com/);
    assert.equal(await foot.locator("form").getAttribute("action"), "/auth/logout");
    assert.equal((await foot.locator("form").getAttribute("method"))?.toLowerCase(), "post");
    const local = asked.filter((r) =>
      /\/hub\/api\/(inbox|notes|runs|settings|people|page\/)/.test(r),
    );
    assert.deepEqual(local, [], "no local-only route is read");
    assert.equal(await noHScroll(page), 0);
    await shot(page, "cloud-pages-1280");
    assert.deepEqual(problems, []);
  } finally {
    await context.close();
  }
});

test("a project link narrows to its pages; search reads titles", async (t) => {
  if (skipReason) return t.skip(skipReason);
  const { page, context, problems } = await tab();
  try {
    await page
      .getByRole("complementary", { name: "Projects" })
      .locator(".proj-link", { hasText: "Ungrouped" })
      .click();
    await page.getByText("1 page in 1 project").waitFor();
    assert.equal(await page.locator(".trow").count(), 1);
    await page.getByRole("searchbox").fill("pricing");
    await page.locator("h1", { hasText: "Search" }).waitFor();
    assert.deepEqual(await page.locator(".row-title").allInnerTexts(), ["Pricing review"]);
    assert.deepEqual(problems, []);
  } finally {
    await context.close();
  }
});

test("People: grant, an existing email, a bad email, revoke; the table's count follows", async (t) => {
  if (skipReason) return t.skip(skipReason);
  const { page, context, problems } = await tab();
  try {
    const row = page.locator(".trow", { hasText: "Pricing review" });
    await row.getByRole("button", { name: /People who can open Pricing review/ }).click();
    const dialog = page.getByRole("dialog", { name: "People" });
    await dialog.getByText("No accounts granted.").waitFor();
    assert.equal(await dialog.getByRole("row", { name: /olga@example\.com Owner/ }).count(), 1);
    assert.match(
      await dialog.innerText(),
      /Invite links you make with the CLI are not listed here\./,
    );
    const email = dialog.getByLabel("Grant access by email");
    assert.equal(await email.getAttribute("autocomplete"), "off");
    await email.fill("Bo@Example.com");
    await dialog.getByRole("button", { name: "Grant" }).click();
    await dialog
      .getByRole("status")
      .filter({ hasText: "Access granted. They open the page after they sign in with that email." })
      .waitFor();
    await dialog.getByRole("button", { name: "Revoke access for bo@example.com" }).waitFor();
    await email.fill("bo@example.com");
    await dialog.getByRole("button", { name: "Grant" }).click();
    await dialog
      .getByRole("status")
      .filter({ hasText: "That email already has access." })
      .waitFor();
    await email.fill("not an email");
    await dialog.getByRole("button", { name: "Grant" }).click();
    await dialog
      .getByRole("alert")
      .filter({ hasText: "Enter an email address, like name@example.com." })
      .waitFor();
    assert.equal(await email.getAttribute("aria-invalid"), "true");
    await shot(page, "cloud-people-1280", false);
    await dialog.getByRole("button", { name: "Revoke access for bo@example.com" }).click();
    await dialog
      .getByRole("status")
      .filter({ hasText: "Access revoked. Any tab they have open on this page loses access now." })
      .waitFor();
    assert.equal(await dialog.getByRole("button", { name: /^Revoke access/ }).count(), 0);
    await page.keyboard.press("Escape");
    await dialog.waitFor({ state: "detached" });
    // Focus goes back to the People button.
    await page.waitForFunction(
      () => document.activeElement?.textContent?.startsWith("People"),
      null,
      {
        timeout: 5000,
      },
    );
    assert.deepEqual(problems, []);
  } finally {
    await context.close();
  }
});

test("a page at the grant limit says so", async (t) => {
  if (skipReason) return t.skip(skipReason);
  const { page, context } = await tab();
  try {
    grants.set(
      "bbbb22223333",
      Array.from({ length: 100 }, (_, i) => ({ email: `u${i}@example.com`, added_at: NOW })),
    );
    // The stub refuses the 101st the way the Worker does (a 400); the dialog explains it.
    await page.route("**/hub/api/pages/bbbb22223333/grants", async (r) => {
      if (r.request().method() === "POST")
        return r.fulfill({ status: 400, json: { error: "a page may have at most 100 grants" } });
      return r.continue();
    });
    await page
      .locator(".trow", { hasText: "Pricing review" })
      .getByRole("button", { name: /People/ })
      .click();
    const dialog = page.getByRole("dialog", { name: "People" });
    await dialog.getByRole("button", { name: "Revoke access for u99@example.com" }).waitFor();
    await dialog.getByLabel("Grant access by email").fill("late@example.com");
    await dialog.getByRole("button", { name: "Grant" }).click();
    await dialog
      .getByRole("alert")
      .filter({ hasText: "This page has 100 grants, the most it can have. Revoke one first." })
      .waitFor();
  } finally {
    await context.close();
  }
});

test("Shared with you: title, owner, expiry; its empty text names the account", async (t) => {
  if (skipReason) return t.skip(skipReason);
  const { page, context, problems } = await tab();
  try {
    await page
      .getByRole("complementary", { name: "Projects" })
      .getByRole("link", { name: "Shared" })
      .click();
    await page.locator("h1", { hasText: "Shared with you" }).waitFor();
    const row = page.locator(".trow", { hasText: "Q3 rollout plan" });
    assert.match(await row.innerText(), /Ana Ruiz/);
    assert.match(await row.innerText(), /Expires .* · in 12 days/);
    assert.equal(
      await row.getByRole("link", { name: "Q3 rollout plan" }).getAttribute("href"),
      "/p/dddd44445555",
    );
    shared.pages = [];
    await page.reload();
    await page
      .getByText(
        "Nothing shared with you yet. When an owner grants olga@example.com, the page shows up here.",
      )
      .waitFor();
    assert.deepEqual(problems, []);
  } finally {
    await context.close();
  }
});

test("no pages: the empty state shows the login and publish commands and the install guide", async (t) => {
  if (skipReason) return t.skip(skipReason);
  const { page, context, problems } = await tab();
  try {
    owned = [];
    await page.reload();
    await page.getByRole("heading", { name: "No pages yet." }).waitFor();
    assert.match(
      await page.locator("#content").innerText(),
      /Pages you publish while the CLI is signed in as olga@example\.com show up here\./,
    );
    assert.deepEqual(await page.locator(".cloud-empty code").allInnerTexts(), [
      "austere-axi cloud login",
      "austere-axi publish <file>",
    ]);
    assert.match(
      (await page
        .getByRole("link", { name: "New to austere-axi? Install guide" })
        .getAttribute("href")) ?? "",
      /docs\/install\.md$/,
    );
    await shot(page, "cloud-empty-1280");
    assert.deepEqual(problems, []);
  } finally {
    await context.close();
  }
});

test("below 640px every control the cloud mode adds is at least 44px high", async (t) => {
  if (skipReason) return t.skip(skipReason);
  const { page, context } = await tab(390);
  try {
    const high = async (sel: string, name: string) => {
      const boxes = await page
        .locator(sel)
        .evaluateAll((els) =>
          els
            .filter((e) => (e as HTMLElement).offsetParent !== null)
            .map((e) => e.getBoundingClientRect().height),
        );
      assert.ok(boxes.length, `${name}: none found`);
      for (const h of boxes) assert.ok(h >= 43.5, `${name} is ${h}px`);
    };
    await high(".cloud-table .t-people button", "People button");
    await page.getByRole("button", { name: "Toggle the sidebar" }).click();
    await high(".account-out", "Sign out");
    await page.keyboard.press("Escape");
    await page
      .locator(".trow", { hasText: "Checkout plan" })
      .getByRole("button", { name: /People/ })
      .click();
    const dialog = page.getByRole("dialog", { name: "People" });
    await dialog.getByLabel("Grant access by email").waitFor();
    // The dialog zooms in; measure once it has settled.
    await page.waitForTimeout(500);
    await high("[role=dialog] .people-close", "Close");
    await high("[role=dialog] input", "Grant input");
    await high("[role=dialog] button[type=submit]", "Grant");
    await high("[role=dialog] td button", "Revoke");
    await page.keyboard.press("Escape");
    await page.getByRole("link", { name: "Shared" }).last().click();
    await page.locator(".shared-table .row-title").first().waitFor();
    await high(".shared-table .row-title", "Shared title link");
    shared.pages = [];
    owned = [];
    await page.goto(page.url().replace("view=shared", "view=pages"));
    await page.getByRole("heading", { name: "No pages yet." }).waitFor();
    await high(".cloud-empty a", "Install guide link");
  } finally {
    await context.close();
  }
});

test("a phone: a two-tab bar, the account in the drawer, no sideways scroll", async (t) => {
  if (skipReason) return t.skip(skipReason);
  const { page, context, problems } = await tab(390);
  try {
    const bar = page.getByRole("navigation", { name: "Views" }).last();
    assert.deepEqual(
      (await bar.getByRole("link").allInnerTexts()).map((x) => x.trim()),
      ["Pages", "Shared"],
    );
    assert.equal(await noHScroll(page), 0);
    await shot(page, "cloud-pages-390");
    await page.getByRole("button", { name: "Toggle the sidebar" }).click();
    await page.getByRole("button", { name: "Sign out" }).waitFor();
    await shot(page, "cloud-drawer-390");
    await page.keyboard.press("Escape");
    await page
      .locator(".trow", { hasText: "Checkout plan" })
      .getByRole("button", { name: /People/ })
      .click();
    const dialog = page.getByRole("dialog", { name: "People" });
    await dialog.getByRole("button", { name: /Revoke access for ana@example.com/ }).waitFor();
    assert.equal(await noHScroll(page), 0);
    await shot(page, "cloud-people-390", false);
    assert.deepEqual(problems, []);
  } finally {
    await context.close();
  }
});
