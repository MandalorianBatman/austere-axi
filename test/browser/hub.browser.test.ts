// Opt-in browser test (npm run test:browser; needs Chrome or CHROME_PATH): the hub shell (RLM-357)
// and the owner's way between the hub and review pages (RLM-358), on a seeded state dir. The inbox
// groups pages by what they need; archive takes a row away; search opens a page at a part; a worktree
// chip opens its copy; the review header has a breadcrumb, a copy switcher, a quick switcher and
// "Next unanswered page"; a reviewer sees none of it. Set HUB_SHOTS to a folder to keep screenshots.
import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
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

const STATE = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "austere-hub-browser-state-")));
const WORK = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "austere-hub-browser-work-")));
const CLI = path.resolve("src/cli/main.ts");
const KEY = ownerKey(STATE);
const MAIN = path.join(WORK, "shop");
const FEAT = path.join(WORK, "shop-feat");
let port: number;
let server: ChildProcess;
let browser: Browser;
let skipReason: string | undefined;
let env: NodeJS.ProcessEnv;
const ids: Record<string, string> = {};

function call<T>(
  method: string,
  route: string,
  body?: unknown,
  headers: Record<string, string> = { "x-austere-key": KEY },
): Promise<{ status: number; data: T }> {
  const { promise, resolve, reject } = Promise.withResolvers<{ status: number; data: T }>();
  const r = http.request(
    {
      host: "127.0.0.1",
      port,
      method,
      path: route,
      headers: { "content-type": "application/json", host: `127.0.0.1:${port}`, ...headers },
    },
    (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () =>
        resolve({
          status: res.statusCode ?? 0,
          data: (data.startsWith("{") ? JSON.parse(data) : data) as T,
        }),
      );
    },
  );
  r.on("error", reject);
  r.end(body === undefined ? undefined : JSON.stringify(body));
  return promise;
}

/** As the owner's browser does: the cookie and a same-origin Origin. */
const asOwner = (): Record<string, string> => ({
  cookie: ownerHeaders(STATE).cookie,
  origin: `http://127.0.0.1:${port}`,
});

function cli(args: string[], input = ""): string {
  const r = spawnSync(process.execPath, [CLI, ...args], { env, input, encoding: "utf8" });
  assert.equal(r.status, 0, `${args.join(" ")}: ${r.stdout}${r.stderr}`);
  return r.stdout;
}

function writePage(file: string, title: string, text: string): string {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(
    file,
    `<!doctype html><html><head><title>${title}</title><script src="https://cdn.jsdelivr.net/npm/austere-axi@0/dist/austere.js"></script></head>
<body><script type="text/openui">
root = Stack([intro, detail])
intro = TextContent("${title}")
detail = TextContent("${text}")
</script></body></html>`,
  );
  return file;
}

async function open(file: string): Promise<string> {
  const r = await call<{ session: { id: string } }>("POST", "/api/open", { file });
  return r.data.session.id;
}

async function shot(page: Page, name: string) {
  if (process.env.HUB_SHOTS)
    await page.screenshot({
      path: path.join(process.env.HUB_SHOTS, `${name}.png`),
      fullPage: true,
    });
}

/** A signed-in owner tab at `width`, collecting page errors. */
async function ownerTab(
  width = 1280,
): Promise<{ page: Page; context: BrowserContext; problems: string[] }> {
  const context = await browser.newContext({
    viewport: { width, height: width > 500 ? 900 : 844 },
  });
  const page = await context.newPage();
  const problems: string[] = [];
  page.on("pageerror", (e) => problems.push(`pageerror: ${e.message}`));
  page.on("console", (m) => {
    if (m.type() === "error") problems.push(`console error: ${m.text()}`);
  });
  const { data } = await call<{ code: string }>("POST", "/api/login", {});
  await page.goto(`http://127.0.0.1:${port}/?view=inbox&login=${data.code}`);
  return { page, context, problems };
}

const group = (page: Page, name: string) =>
  page.locator("section.group", { has: page.locator("h2", { hasText: name }) });
const rowTitles = async (page: Page, name: string): Promise<string[]> =>
  (await group(page, name).locator(".row-title").allInnerTexts()).map((t) => t.trim());

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
  for (
    let i = 0;
    i < 100 &&
    !(await fetch(`http://127.0.0.1:${port}/api/health`).then(
      (r) => r.ok,
      () => false,
    ));
    i++
  )
    await new Promise((r) => setTimeout(r, 50));

  // A repository on main and its worktree on feat, laid out as git does it (never run here).
  const gitdir = path.join(MAIN, ".git", "worktrees", "shop-feat");
  fs.mkdirSync(gitdir, { recursive: true });
  fs.writeFileSync(path.join(MAIN, ".git", "HEAD"), "ref: refs/heads/main\n");
  fs.writeFileSync(path.join(gitdir, "commondir"), "../..\n");
  fs.writeFileSync(path.join(gitdir, "HEAD"), "ref: refs/heads/feat\n");
  fs.writeFileSync(path.join(gitdir, "gitdir"), path.join(FEAT, ".git") + "\n");
  fs.mkdirSync(FEAT, { recursive: true });
  fs.writeFileSync(path.join(FEAT, ".git"), `gitdir: ${gitdir}\n`);

  ids.plan = await open(
    writePage(path.join(MAIN, "docs", "plan.html"), "Checkout plan", "two steps"),
  );
  ids.planFeat = await open(
    writePage(path.join(FEAT, "docs", "plan.html"), "Checkout plan", "three steps on feat"),
  );
  ids.quiet = await open(
    writePage(path.join(MAIN, "docs", "quiet.html"), "Quiet page", "nothing to do"),
  );
  ids.waiting = await open(
    writePage(path.join(MAIN, "docs", "waiting.html"), "Waiting page", "steady as she goes"),
  );
  ids.changed = await open(
    writePage(path.join(MAIN, "docs", "changed.html"), "Changed page", "first draft"),
  );
  // The owner saw the first revision; the agent patched it overnight.
  assert.equal((await call("POST", `/s/${ids.changed}/viewed`, { rev: 1 }, asOwner())).status, 200);
  cli(
    ["patch", path.join(MAIN, "docs", "changed.html")],
    'detail = TextContent("second draft, by the agent")\n',
  );
  // Unanswered notes: on the waiting page, and on the feat copy of the plan.
  for (const id of [ids.waiting, ids.planFeat]) {
    assert.equal(
      (
        await call(
          "POST",
          `/s/${id}/send`,
          {
            items: [
              { kind: "annotation", target: "detail", component: "TextContent", note: "say more" },
            ],
          },
          asOwner(),
        )
      ).status,
      200,
    );
  }
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

test("the inbox: needs you, waiting on agent, quiet; archive and undo; a chip opens its copy; keyboard", async (t) => {
  if (skipReason) return t.skip(skipReason);
  const { page, context, problems } = await ownerTab();
  try {
    await group(page, "Quiet").waitFor();
    assert.deepEqual(
      await rowTitles(page, "Needs you"),
      ["Changed page"],
      "the page the agent changed since the owner looked",
    );
    assert.deepEqual((await rowTitles(page, "Waiting on agent")).sort(), [
      "Checkout plan",
      "Waiting page",
    ]);
    assert.deepEqual(await rowTitles(page, "Quiet"), ["Quiet page"]);
    const needs = group(page, "Needs you").locator(".row").first();
    assert.match(await needs.locator(".why").innerText(), /Changed since you looked: 1 revision/);
    const waiting = group(page, "Waiting on agent").locator(".row", { hasText: "Waiting page" });
    assert.match(
      await waiting.locator(".why").innerText(),
      /1 unanswered note · nobody is taking them/,
    );
    assert.equal(
      await waiting.getByRole("link", { name: "Turn agent on" }).getAttribute("href"),
      `/hub/open/${ids.waiting}?attach=1`,
    );
    assert.match(await waiting.locator(".previews").innerText(), /say more/);
    // The sidebar: the project and its pages.
    assert.equal((await page.locator(".proj-link").innerText()).trim(), "shop");
    await shot(page, "hub-inbox-1280");

    // Archive takes the row away; Undo brings it back.
    await group(page, "Quiet").getByRole("button", { name: "Archive Quiet page" }).click();
    await page.locator("[data-sonner-toast]", { hasText: "Archived Quiet page." }).waitFor();
    // The view is read again after the archive: wait for that, not for the status line.
    await group(page, "Quiet")
      .locator(".row-title", { hasText: "Quiet page" })
      .waitFor({ state: "detached" });
    const listed = await call<{ pages: { title: string }[] }>(
      "GET",
      "/hub/api/pages",
      undefined,
      asOwner(),
    );
    assert.ok(!listed.data.pages.some((p) => p.title === "Quiet page"), "archived in hub.db");
    // A failed Undo keeps the button beside the error; the retry brings the row back.
    await page.route("**/hub/api/page/*/unarchive", (route) => route.abort(), { times: 1 });
    await page.locator("[data-sonner-toast]").getByRole("button", { name: "Undo" }).click();
    await page.locator("[data-sonner-toast]", { hasText: "Could not undo." }).waitFor();
    // The browser logs the aborted request it was told to fail: expected, not a page error.
    problems.splice(
      0,
      problems.length,
      ...problems.filter((p) => !p.includes("Failed to load resource")),
    );
    // The toast that first said "Archived" may still be fading out: take the one that carries the error.
    await page
      .locator("[data-sonner-toast]", { hasText: "Could not undo." })
      .getByRole("button", { name: "Undo" })
      .click();
    await group(page, "Quiet").locator(".row-title", { hasText: "Quiet page" }).waitFor();

    // Keyboard: Tab reaches the views, Enter opens one, focus is visible.
    await page.locator(".views a[data-view=inbox]").focus();
    await page.keyboard.press("Tab");
    assert.equal(
      await page.evaluate(() => (document.activeElement as HTMLElement).dataset.view),
      "pages",
    );
    assert.notEqual(
      await page.evaluate(() => getComputedStyle(document.activeElement as Element).outlineStyle),
      "none",
      "focus is visible",
    );
    await page.keyboard.press("Enter");
    await page.locator("h1", { hasText: "Pages" }).waitFor();
    assert.match(page.url(), /view=pages/);

    // A worktree chip opens that copy.
    const plan = page.locator(".row", { hasText: "Checkout plan" });
    assert.deepEqual(
      (await plan.locator(".chips .chip").allInnerTexts()).map((t) => t.split(/\s/)[0]),
      ["feat", "main"],
      "the copy with the note first",
    );
    await plan.locator(`.chip[data-copy="${ids.planFeat}"]`).click();
    await page.waitForURL(`**/s/${ids.planFeat}`);
    assert.deepEqual(problems, []);
  } finally {
    await context.close();
  }
});

test("search finds a part and opens its page there; the hub remembers its last view", async (t) => {
  if (skipReason) return t.skip(skipReason);
  const { page, context, problems } = await ownerTab();
  try {
    await page.locator(".search input").fill("steady");
    await page
      .locator("section", { has: page.locator("h2", { hasText: "Parts" }) })
      .locator(".part")
      .first()
      .waitFor();
    const hit = page.locator(".part a").first();
    assert.match(await hit.innerText(), /Waiting page · detail[\s\S]*steady as she goes/);
    await shot(page, "hub-search-1280");
    await hit.click();
    await page.waitForURL(`**/s/${ids.waiting}`);
    // The part is outlined in the frame, and the fragment is gone from the address bar.
    const frame = page.frameLocator(".frame");
    await frame.locator('[data-oui-id="detail"]').waitFor();
    await (await page.$(".frame"))!.contentFrame().then((f) => f!.waitForSelector(".austere-mark"));
    assert.equal(new URL(page.url()).hash, "");

    // Runs, then back to the hub with no view named: the hub opens on Runs.
    await page.goto(`http://127.0.0.1:${port}/?view=runs`);
    await page.locator("h1", { hasText: "Runs" }).waitFor();
    await page.goto(`http://127.0.0.1:${port}/`);
    await page.locator("h1", { hasText: "Runs" }).waitFor();
    await page.goto(`http://127.0.0.1:${port}/?view=inbox`);
    await page.locator("h1", { hasText: "Inbox" }).waitFor();
    assert.deepEqual(problems, []);
  } finally {
    await context.close();
  }
});

test("the Pages table keeps its columns or stacks its rows: at no width is a row cut", async (t) => {
  if (skipReason) return t.skip(skipReason);
  const { page, context, problems } = await ownerTab();
  assert.equal(
    (await call("POST", `/hub/api/page/${ids.quiet}/archive`, {}, asOwner())).status,
    200,
  );
  try {
    for (const query of ["view=pages", "view=pages&archived=1"]) {
      // The widths where the table is near its columns' least widths: below the sidebar's breakpoint, and beside the sidebar.
      for (const width of [800, 830, 860, 1080, 1110, 1140, 1170]) {
        await page.setViewportSize({ width, height: 900 });
        await page.goto(`http://127.0.0.1:${port}/?${query}`);
        await page.locator(".table .trow").first().waitFor();
        const m = await page.locator(".table").evaluate((table) => {
          const row = table.querySelector(".trow") as HTMLElement;
          const edge =
            row.getBoundingClientRect().right - parseFloat(getComputedStyle(row).paddingRight);
          return {
            stacked: getComputedStyle(row).display === "flex",
            head: getComputedStyle(table.querySelector(".thead") as HTMLElement).display,
            over: Math.max(
              ...[...row.children].map((c) => Math.round(c.getBoundingClientRect().right - edge)),
            ),
          };
        });
        assert.ok(m.over <= 0, `${query} at ${width}px: a cell ends ${m.over}px past its row`);
        assert.equal(
          m.head,
          m.stacked ? "none" : "grid",
          `${query} at ${width}px: the column names show with the columns only`,
        );
      }
    }
    assert.deepEqual(problems, []);
  } finally {
    await call("POST", `/hub/api/page/${ids.quiet}/unarchive`, {}, asOwner());
    await context.close();
  }
});

test("review header: breadcrumb to the hub, copy switcher keeps the path, Ctrl+K opens another page, next unanswered", async (t) => {
  if (skipReason) return t.skip(skipReason);
  const { page, context, problems } = await ownerTab();
  try {
    await page.goto(`http://127.0.0.1:${port}/s/${ids.quiet}`);
    await page.locator(".crumbs a", { hasText: "shop" }).waitFor();
    await page.goto(`http://127.0.0.1:${port}/s/${ids.plan}`);
    await page.frameLocator(".frame").locator('[data-oui-id="intro"]').waitFor();
    const crumb = page.locator(".crumbs a");
    await page.locator(".crumbs a", { hasText: "shop" }).waitFor();
    assert.equal(
      await page.locator(".crumb .crumb-back").isVisible(),
      false,
      "the back arrow is the phone's breadcrumb",
    );
    // The copy switcher lists both worktrees; the other one has the same rel_path.
    const select = page.locator(".copy-switch");
    assert.deepEqual((await select.locator("option").allInnerTexts()).sort(), ["feat", "main"]);
    await shot(page, "review-header-1280");
    await select.selectOption(ids.planFeat);
    await page.waitForURL(`**/s/${ids.planFeat}`);
    const a = await call<{ rel_path: string }>(
      "GET",
      `/hub/api/page/${ids.plan}`,
      undefined,
      asOwner(),
    );
    const b = await call<{ rel_path: string }>(
      "GET",
      `/hub/api/page/${ids.planFeat}`,
      undefined,
      asOwner(),
    );
    assert.equal(b.data.rel_path, a.data.rel_path);

    // Ctrl+K, pressed with the artifact frame focused (the frame hands it to the chrome): pages opened lately first
    // (one entry a page, whichever copy); type to find another page, Enter opens it.
    await page.frameLocator(".frame").locator('[data-oui-id="intro"]').waitFor();
    await page
      .frameLocator(".frame")
      .locator("body")
      .click({ position: { x: 5, y: 5 } });
    await page.keyboard.press("Control+k");
    await page.locator(".qs").waitFor();
    assert.deepEqual(
      (await page.locator(".qs-item .qs-title").allInnerTexts()).map((s) => s.trim()),
      ["Quiet page"],
      "the page opened before; this page is left out",
    );
    // A modal: Tab stays in it, and reaches its one link.
    await page.keyboard.press("Tab");
    assert.equal(await page.evaluate(() => document.activeElement?.className), "qs-hub");
    await page.keyboard.press("Tab");
    assert.equal(await page.evaluate(() => document.activeElement?.className), "qs-input");
    await page.locator(".qs-input").fill("Waiting");
    await page.locator(".qs-item", { hasText: "Waiting page" }).first().waitFor();
    await shot(page, "quick-switcher-1280");
    await page.keyboard.press("Enter");
    await page.waitForURL(`**/s/${ids.waiting}`);

    // Next unanswered: the next page in the inbox with notes no agent answered, at the copy that has them.
    await page.frameLocator(".frame").locator('[data-oui-id="intro"]').waitFor();
    await page.click(".menu-btn");
    await page.click('[data-cmd="next-unanswered"]');
    await page.waitForURL(`**/s/${ids.planFeat}`);

    // The breadcrumb goes back to the hub, filtered to the project.
    await page.frameLocator(".frame").locator('[data-oui-id="intro"]').waitFor();
    await crumb.click();
    await page.waitForURL(/\/\?.*project=/);
    await page.locator(".content h1").waitFor();
    assert.deepEqual(problems, []);
  } finally {
    await context.close();
  }
});

test("a reviewer's page shows none of it, and the hub refuses the reviewer", async (t) => {
  if (skipReason) return t.skip(skipReason);
  const made = await call<{ link: string }>("POST", "/api/share", {
    file: path.join(MAIN, "docs", "waiting.html"),
    name: "Ana",
  });
  const cookie = await claimLink(port, made.data.link);
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  try {
    const [name, value] = cookie.split("=");
    await context.addCookies([{ name, value, domain: "127.0.0.1", path: "/" }]);
    const page = await context.newPage();
    await page.goto(`http://127.0.0.1:${port}/s/${ids.waiting}`);
    await page.frameLocator(".frame").locator('[data-oui-id="intro"]').waitFor();
    for (const sel of [
      ".crumbs",
      ".copy-switch",
      ".qs",
      '[data-cmd="goto"]',
      '[data-cmd="next-unanswered"]',
    ])
      assert.equal(await page.locator(sel).count(), 0, sel);
    await page.keyboard.press("Control+k");
    assert.equal(await page.locator(".qs").count(), 0);
    for (const route of [
      "/",
      "/hub/api/inbox",
      "/hub/api/search?q=steady",
      `/hub/api/page/${ids.waiting}`,
    ]) {
      assert.equal(
        (await page.request.get(`http://127.0.0.1:${port}${route}`)).status(),
        403,
        route,
      );
    }
  } finally {
    await context.close();
  }
});

test("phone width: the sidebar is a drawer; the review header keeps the breadcrumb", async (t) => {
  if (skipReason) return t.skip(skipReason);
  const { page, context, problems } = await ownerTab(390);
  try {
    await group(page, "Quiet").waitFor();
    const drawer = page.locator('[data-sidebar="sidebar"][data-mobile="true"]');
    assert.equal(await drawer.count(), 0, "the drawer starts closed");
    await shot(page, "hub-inbox-390");
    await page.click(".side-toggle");
    await drawer.waitFor();
    await shot(page, "hub-sidebar-390");
    await page.keyboard.press("Escape");
    await drawer.waitFor({ state: "detached" });
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    assert.ok(overflow <= 0, `no sideways scroll (${overflow}px)`);

    await page.goto(`http://127.0.0.1:${port}/s/${ids.plan}`);
    await page.frameLocator(".frame").locator('[data-oui-id="intro"]').waitFor();
    await page.locator(".crumbs a", { hasText: "shop" }).waitFor();
    assert.ok(await page.locator(".crumbs").isVisible());
    assert.ok(
      await page.locator(".crumb .crumb-back").isVisible(),
      "a back arrow stands for the project's name",
    );
    await shot(page, "review-header-390");
    assert.deepEqual(problems, []);
  } finally {
    await context.close();
  }
});

test("a refresh keeps focus and scroll; a slow answer to an older request never replaces a newer view", async (t) => {
  if (skipReason) return t.skip(skipReason);
  const { page, context, problems } = await ownerTab();
  try {
    await group(page, "Quiet").waitFor();
    // The tab coming back reads the inbox again: the row the owner stands on is the same element after it.
    const button = page.getByRole("button", { name: "Archive Waiting page" });
    await button.focus();
    await page.evaluate(() => {
      const row = document.querySelector<HTMLElement>("button[aria-label='Archive Waiting page']")!;
      (window as unknown as { __row: HTMLElement }).__row = row;
      document.body.style.minHeight = "4000px";
      window.scrollTo(0, 300);
    });
    const read = page.waitForResponse((r) => r.url().includes("/hub/api/inbox"));
    await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
    await read;
    await page.waitForTimeout(100);
    assert.deepEqual(
      await page.evaluate(() => ({
        same: document.activeElement === (window as unknown as { __row: HTMLElement }).__row,
        y: Math.round(window.scrollY),
      })),
      { same: true, y: 300 },
    );

    // Pages → Everything is slow, Archived is quick: the last choice wins, whatever order the answers come in.
    await page.locator(".views a[data-view=pages]").click();
    await page.getByRole("tablist", { name: "Which pages" }).waitFor();
    await page.route(
      (url) => url.pathname === "/hub/api/pages" && url.searchParams.get("view") === "all",
      async (route) => {
        await new Promise((r) => setTimeout(r, 700));
        await route.continue();
      },
    );
    await page.getByRole("tab", { name: /Everything/ }).click();
    await page.getByRole("tab", { name: /Archived/ }).click();
    await page.waitForTimeout(1200);
    assert.equal(
      (await page.locator("[role=tab][data-state=active]").innerText()).trim().split(/\s+/)[0],
      "Archived",
    );
    assert.match(page.url(), /archived=1/);
    assert.deepEqual(problems, []);
  } finally {
    await context.close();
  }
});

// The hosted chrome's CSP (austere-cloud src/serve.ts): style-src allows 'unsafe-inline', nothing allows eval.
// The shadcn primitives (Radix, Sonner) add inline styles; under this policy they must draw and report nothing.
test("the hub under the hosted chrome's CSP: toast, select, tabs and tooltips draw with no violation", async (t) => {
  if (skipReason) return t.skip(skipReason);
  const CSP =
    "default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src data:; connect-src 'self'; frame-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'";
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  const problems: string[] = [];
  page.on("pageerror", (e) => problems.push(`pageerror: ${e.message}`));
  page.on("console", (m) => {
    if (m.type() === "error") problems.push(`console error: ${m.text()}`);
  });
  await page.addInitScript(() => {
    document.addEventListener("securitypolicyviolation", (e) =>
      console.error(`CSP ${e.violatedDirective}: ${e.blockedURI} ${e.sample}`),
    );
  });
  await page.route(
    (url) => url.pathname === "/",
    async (route) => {
      const res = await route.fetch();
      await route.fulfill({
        response: res,
        headers: { ...res.headers(), "content-security-policy": CSP },
      });
    },
  );
  try {
    const { data } = await call<{ code: string }>("POST", "/api/login", {});
    await page.goto(`http://127.0.0.1:${port}/?view=notes&login=${data.code}`);
    await page.getByRole("combobox", { name: "Status" }).click();
    await page.getByRole("option", { name: "Unanswered" }).click();
    await page.getByRole("button", { name: "Filter" }).click();
    await page.waitForURL(/status=unanswered/);
    await page.getByRole("link", { name: "Pages" }).first().click();
    await page.getByRole("tab", { name: /Everything/ }).click();
    await page.getByRole("button", { name: /^Archive Quiet page/ }).hover();
    await page.getByRole("tooltip").first().waitFor();
    await page.getByRole("button", { name: /^Archive Quiet page/ }).click();
    await page.locator("[data-sonner-toast]", { hasText: "Archived Quiet page." }).waitFor();
    await page.locator("[data-sonner-toast]").getByRole("button", { name: "Undo" }).click();
    await page.locator("[data-sonner-toast]", { hasText: "Archived Quiet page." }).waitFor({
      state: "detached",
    });
    assert.deepEqual(problems, []);
  } finally {
    await context.close();
  }
});

test("phone: Pages does not scroll sideways, the drawer closes after a pick, a dialog returns focus", async (t) => {
  if (skipReason) return t.skip(skipReason);
  const { page, context, problems } = await ownerTab(390);
  try {
    await page.goto(`http://127.0.0.1:${port}/?view=pages`);
    await page.getByRole("tablist", { name: "Which pages" }).waitFor();
    const wide = () =>
      page.evaluate(() => {
        const w = document.documentElement.clientWidth;
        const el = [...document.querySelectorAll("body *")].find(
          (e) =>
            e.getBoundingClientRect().right > w + 1 && getComputedStyle(e).position !== "fixed",
        );
        return {
          over: document.documentElement.scrollWidth - w,
          el: el ? `${el.tagName.toLowerCase()}.${String(el.className).slice(0, 60)}` : "",
        };
      });
    const w = await wide();
    assert.ok(w.over <= 0, `no sideways scroll on Pages (${w.over}px): ${w.el}`);
    // The tabs control a panel that exists.
    const panel = await page.getByRole("tab", { selected: true }).getAttribute("aria-controls");
    assert.equal(
      await page.locator(`[id="${panel}"]`).count(),
      1,
      "aria-controls points at a panel",
    );

    // Drawer: open it, pick Notes; the URL moves and the sheet closes.
    await page.click(".side-toggle");
    const drawer = page.locator('[data-sidebar="sidebar"][data-mobile="true"]');
    await drawer.waitFor();
    await drawer.locator('a[data-view="notes"]').click();
    await page.waitForURL(/view=notes/);
    await drawer.waitFor({ state: "detached" });

    // Dialog: Esc gives focus back to the button that asked.
    await page.goto(`http://127.0.0.1:${port}/?view=settings`);
    const rename = page.getByRole("button", { name: "Rename shop" });
    await rename.waitFor();
    await rename.focus();
    await page.keyboard.press("Enter");
    await page.getByRole("dialog").waitFor();
    await page.keyboard.press("Escape");
    await page.getByRole("dialog").waitFor({ state: "detached" });
    assert.equal(
      await page.evaluate(() => document.activeElement?.getAttribute("aria-label")),
      "Rename shop",
    );
    assert.deepEqual(problems, []);
  } finally {
    await context.close();
  }
});
