// Opt-in browser test (npm run test:browser; needs Chrome or CHROME_PATH): the hub shell (RLM-357)
// and the owner's way between the hub and review pages (RLM-358), on a seeded state dir. The inbox
// groups pages by what they need; archive takes a row away; search opens a page at a part; a worktree
// chip opens its copy; the review header has a breadcrumb, a copy switcher, a quick switcher and
// "Next unanswered page"; a reviewer sees none of it. Set HUB_SHOTS to a folder to keep screenshots.
import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
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

/** The breadcrumb's link to the hub, by the name it shows (on a phone, a back arrow whose text is that name). */
const crumbLink = (page: Page, name: string) =>
  page.getByRole("navigation", { name: "Breadcrumb" }).getByRole("link", { name });
const group = (page: Page, name: string) =>
  page.locator("section.inbox-group", { has: page.locator("h2", { hasText: name }) });
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
    await crumbLink(page, "shop").waitFor();
    await page.goto(`http://127.0.0.1:${port}/s/${ids.plan}`);
    await page.frameLocator(".frame").locator('[data-oui-id="intro"]').waitFor();
    const crumb = crumbLink(page, "shop");
    await crumb.waitFor();
    assert.equal(
      await crumb.locator("svg").isVisible(),
      false,
      "the back arrow is the phone's breadcrumb",
    );
    // The copy switcher lists both worktrees; the other one has the same rel_path.
    await page.getByRole("button", { name: /^Worktree copy: / }).click();
    assert.deepEqual((await page.getByRole("menuitemradio").allInnerTexts()).sort(), [
      "feat",
      "main",
    ]);
    await shot(page, "review-header-1280");
    await page.getByRole("menuitemradio", { name: "feat" }).click();
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
    const switcher = page.getByRole("dialog", { name: "Go to page" });
    await switcher.waitFor();
    const options = switcher.getByRole("option");
    await options.first().waitFor();
    assert.equal(await options.count(), 1, "the page opened before; this page is left out");
    assert.match(await options.first().innerText(), /Quiet page/);
    // A modal: Tab stays in it, and reaches its one link.
    const focused = (): Promise<string | undefined> =>
      page.evaluate(
        () =>
          document.activeElement?.textContent?.trim() ||
          document.activeElement?.getAttribute("aria-label") ||
          "",
      );
    assert.equal(await focused(), "Search pages and parts");
    await page.keyboard.press("Tab");
    assert.equal(await focused(), "Open the hub");
    await page.keyboard.press("Tab");
    assert.equal(await focused(), "Search pages and parts");
    await switcher.getByRole("combobox").fill("Waiting");
    await options.filter({ hasText: "Waiting page" }).first().waitFor();
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

test("the quick switcher gives focus back where it was: a button, the frame, the ⋯ menu", async (t) => {
  if (skipReason) return t.skip(skipReason);
  const { page, context, problems } = await ownerTab();
  try {
    await page.goto(`http://127.0.0.1:${port}/s/${ids.plan}`);
    await page.frameLocator(".frame").locator('[data-oui-id="intro"]').waitFor();
    const switcher = page.getByRole("dialog", { name: "Go to page" });
    const active = () =>
      page.evaluate(
        () =>
          document.activeElement?.getAttribute("aria-label") ||
          document.activeElement?.className ||
          document.activeElement?.tagName,
      );
    const roundTrip = async (open: () => Promise<void>): Promise<string | undefined> => {
      await open();
      await switcher.waitFor();
      await page.keyboard.press("Escape");
      await switcher.waitFor({ state: "detached" });
      // Focus comes back a tick after the dialog has gone.
      await page.waitForFunction(() => document.activeElement !== document.body);
      return active();
    };

    // A button.
    await page.locator(".goto-btn").focus();
    assert.match(String(await roundTrip(() => page.keyboard.press("Control+k"))), /Go to page/);

    // The frame.
    await page
      .frameLocator(".frame")
      .locator("body")
      .click({ position: { x: 5, y: 5 } });
    assert.equal(
      await page.evaluate(() => document.activeElement?.tagName),
      "IFRAME",
      "focus is in the frame",
    );
    await roundTrip(() => page.keyboard.press("Control+k"));
    assert.equal(await page.evaluate(() => document.activeElement?.tagName), "IFRAME");

    // The ⋯ menu's Go to page…: focus returns to the ⋯ button the menu had given it back to.
    const opened = async () => {
      await page.click(".menu-btn");
      await page.click('[data-cmd="goto"]');
    };
    assert.equal(await roundTrip(opened), "More");
    assert.deepEqual(problems, []);
  } finally {
    await context.close();
  }
});

test("review page: the projects sidebar marks this page, collapses, stays collapsed, and is shared with the hub", async (t) => {
  if (skipReason) return t.skip(skipReason);
  const { page, context, problems } = await ownerTab();
  try {
    await page.goto(`http://127.0.0.1:${port}/s/${ids.plan}`);
    await page.frameLocator(".frame").locator('[data-oui-id="intro"]').waitFor();
    const side = page.locator('[data-slot="sidebar"]');
    const trigger = page.getByRole("button", {
      name: /Toggle the projects sidebar/,
    });
    // The artifact is what the owner came for: with no saved choice the sidebar starts folded.
    assert.equal(await side.getAttribute("data-state"), "collapsed");
    assert.equal(await page.evaluate(() => localStorage.getItem("austere:sidebar-open")), null);
    // Folded, it is off screen and takes no Tab stop; the skip link is the first stop.
    const tabStops = async (n: number): Promise<{ skip: boolean; inSidebar: boolean }[]> => {
      await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
      const stops = [];
      for (let i = 0; i < n; i++) {
        await page.keyboard.press("Tab");
        stops.push(
          await page.evaluate(() => ({
            skip: !!document.activeElement?.classList.contains("skip-link"),
            inSidebar: !!document.activeElement?.closest('[data-slot="sidebar-container"]'),
          })),
        );
      }
      return stops;
    };
    let stops = await tabStops(14);
    assert.equal(stops[0].skip, true, "the skip link is the first Tab stop");
    assert.equal(
      stops.some((s) => s.inSidebar),
      false,
      "no Tab stop in the folded sidebar",
    );
    await trigger.click();
    await page
      .locator('[data-slot="sidebar"][data-state="expanded"]')
      .waitFor({ state: "attached" });
    await side.getByRole("link", { name: "Waiting page" }).waitFor();
    // The open state is saved: on a fresh load it is open, and Tab still starts at the skip link.
    await page.reload();
    await side.getByRole("link", { name: "Waiting page" }).waitFor();
    assert.equal(await side.getAttribute("data-state"), "expanded");
    stops = await tabStops(1);
    assert.equal(stops[0].skip, true, "the skip link is first with the sidebar open too");
    assert.match(
      await side.locator('a[aria-current="page"]').innerText(),
      /Checkout plan/,
      "this page is marked",
    );
    await shot(page, "review-sidebar-1280");

    // Wide: the sidebar pushes the page, and the artifact frame takes the room back.
    const width = (): Promise<number> =>
      page.locator(".frame").evaluate((f) => f.getBoundingClientRect().width);
    const open = await width();
    await trigger.click();
    await page
      .locator('[data-slot="sidebar"][data-state="collapsed"]')
      .waitFor({ state: "attached" });
    await page.waitForFunction(
      (w) => document.querySelector<HTMLElement>(".frame")!.getBoundingClientRect().width > w + 200,
      open,
    );
    assert.equal(await page.evaluate(() => localStorage.getItem("austere:sidebar-open")), "false");
    await shot(page, "review-sidebar-collapsed-1280");

    // The choice holds across a reload, and on the hub.
    await page.reload();
    await page.frameLocator(".frame").locator('[data-oui-id="intro"]').waitFor();
    await page
      .locator('[data-slot="sidebar"][data-state="collapsed"]')
      .waitFor({ state: "attached" });
    await page.goto(`http://127.0.0.1:${port}/?view=inbox`);
    await page
      .locator('[data-slot="sidebar"][data-state="collapsed"]')
      .waitFor({ state: "attached" });
    await page.goto(`http://127.0.0.1:${port}/s/${ids.plan}`);
    await page.frameLocator(".frame").locator('[data-oui-id="intro"]').waitFor();

    // Ctrl+B, with the frame focused (the frame hands the key over), opens it again; Ctrl+B on the page closes it.
    await page
      .frameLocator(".frame")
      .locator("body")
      .click({ position: { x: 5, y: 5 } });
    await page.keyboard.press("Control+b");
    await page
      .locator('[data-slot="sidebar"][data-state="expanded"]')
      .waitFor({ state: "attached" });
    await page.keyboard.press("Control+b");
    await page
      .locator('[data-slot="sidebar"][data-state="collapsed"]')
      .waitFor({ state: "attached" });
    await trigger.click();
    await page
      .locator('[data-slot="sidebar"][data-state="expanded"]')
      .waitFor({ state: "attached" });
    assert.equal(
      await page.evaluate(() => document.cookie.includes("sidebar_state")),
      false,
      "no shadcn cookie",
    );

    // Another page opens from the list.
    await side.getByRole("link", { name: "Waiting page" }).click();
    await page.waitForURL(`**/s/${ids.waiting}`);
    assert.deepEqual(problems, []);
  } finally {
    await context.close();
  }
});

test("review page at 1024 px: the sidebar is a sheet over the page, not a column; the hub keeps its column", async (t) => {
  if (skipReason) return t.skip(skipReason);
  const { page, context, problems } = await ownerTab(1024);
  try {
    // Saved open on both pages: the review page still has no room for a column.
    await page.evaluate(() => localStorage.setItem("austere:sidebar-open", "true"));
    await page.reload();
    await page.locator('[data-slot="sidebar-gap"]').waitFor({ state: "attached" });
    await page.goto(`http://127.0.0.1:${port}/s/${ids.plan}`);
    await page.frameLocator(".frame").locator('[data-oui-id="intro"]').waitFor();
    assert.equal(await page.locator('[data-slot="sidebar-gap"]').count(), 0, "no column");
    const frame = (): Promise<number> =>
      page.locator(".frame").evaluate((f) => f.getBoundingClientRect().width);
    const before = await frame();
    await page.getByRole("button", { name: /Toggle the projects sidebar/ }).click();
    const sheet = page.locator('[data-sidebar="sidebar"][data-mobile="true"]');
    await sheet.getByRole("link", { name: "Waiting page" }).waitFor();
    assert.equal(await frame(), before, "the page keeps its width under the sheet");
    await page.keyboard.press("Escape");
    await sheet.waitFor({ state: "detached" });
    assert.deepEqual(problems, []);
  } finally {
    await context.close();
  }
});

test("review page, phone width: the sidebar is a sheet with a scrim; Escape closes it", async (t) => {
  if (skipReason) return t.skip(skipReason);
  const { page, context, problems } = await ownerTab(390);
  try {
    await page.goto(`http://127.0.0.1:${port}/s/${ids.plan}`);
    await page.frameLocator(".frame").locator('[data-oui-id="intro"]').waitFor();
    const sheet = page.locator('[data-sidebar="sidebar"][data-mobile="true"]');
    assert.equal(await sheet.count(), 0, "starts closed whatever the saved choice");
    const trigger = page.getByRole("button", { name: /Toggle the projects sidebar/ });
    await trigger.focus();
    await page.keyboard.press("Enter");
    await sheet.waitFor();
    await sheet.getByRole("link", { name: "Waiting page" }).waitFor();
    assert.equal(await page.locator('[data-slot="sheet-overlay"]').count(), 1, "a scrim");
    await shot(page, "review-sidebar-390");
    await page.keyboard.press("Escape");
    await sheet.waitFor({ state: "detached" });
    // Keyboard: focus goes back to the trigger the sheet was opened from, not to <body>.
    await page.waitForFunction(() => document.activeElement?.matches('[data-sidebar="trigger"]'));
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
  const context = await browser.newContext({
    viewport: { width: 1280, height: 900 },
  });
  try {
    const [name, value] = cookie.split("=");
    await context.addCookies([{ name, value, domain: "127.0.0.1", path: "/" }]);
    const page = await context.newPage();
    await page.goto(`http://127.0.0.1:${port}/s/${ids.waiting}`);
    await page.frameLocator(".frame").locator('[data-oui-id="intro"]').waitFor();
    for (const sel of [
      '[aria-label="Breadcrumb"]',
      '[aria-label^="Worktree copy: "]',
      '[aria-label="Go to page (Ctrl K)"]',
      '[data-cmd="goto"]',
      '[data-cmd="next-unanswered"]',
      '[data-slot="sidebar-wrapper"]',
      ".side-toggle",
    ])
      assert.equal(await page.locator(sel).count(), 0, sel);
    await page.keyboard.press("Control+k");
    assert.equal(await page.getByRole("dialog").count(), 0);
    await page.keyboard.press("Control+b");
    assert.equal(await page.getByRole("dialog").count(), 0, "no sidebar sheet either");
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
    await crumbLink(page, "shop").waitFor({ state: "attached" });
    assert.ok(await page.getByRole("navigation", { name: "Breadcrumb" }).isVisible());
    assert.ok(
      await crumbLink(page, "shop").locator("svg").isVisible(),
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

// The hosted chrome's CSP, as austere-cloud's shell sends it (src/serve.ts `shell()`, read off the Worker's real answer for
// RLM-442): only the hash differs, because the boot script is the page's own. Nothing allows eval or inline script; style-src
// allows 'unsafe-inline', which is what Radix (popper, portals) and Sonner need for their inline `style`.
const HOSTED_CSP = (hashes: string[]): string =>
  `default-src 'none'; script-src 'self' ${hashes.map((h) => `'sha256-${h}'`).join(" ")}; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src data:; connect-src 'self'; frame-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'`;

/** Serves the page at `where` with that CSP (the page's inline scripts allowed by hash, as the shell does); reports violations. */
async function underHostedCsp(
  context: BrowserContext,
  where: (pathname: string) => boolean,
): Promise<{ page: Page; problems: string[] }> {
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
    (url) => where(url.pathname),
    async (route) => {
      if (route.request().resourceType() !== "document") return route.continue();
      const res = await route.fetch();
      const body = await res.text();
      const hashes = [...body.matchAll(/<script(?![^>]*\ssrc=)[^>]*>([\s\S]*?)<\/script>/g)].map(
        (m) => createHash("sha256").update(m[1]).digest("base64"),
      );
      await route.fulfill({
        response: res,
        body,
        headers: {
          ...res.headers(),
          "content-security-policy": HOSTED_CSP(hashes),
        },
      });
    },
  );
  return { page, problems };
}

test("the hub under the hosted chrome's CSP: toast, select, tabs and tooltips draw with no violation", async (t) => {
  if (skipReason) return t.skip(skipReason);
  const context = await browser.newContext({
    viewport: { width: 1280, height: 900 },
  });
  const { page, problems } = await underHostedCsp(context, (p) => p === "/");
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
    await page
      .locator("[data-sonner-toast]", { hasText: "Archived Quiet page." })
      .waitFor({ state: "detached" });
    assert.deepEqual(problems, []);
  } finally {
    await context.close();
  }
});

test("the review page under the hosted chrome's CSP: ⋯ menu, Share dialog, sidebar and its sheet draw in place, no violation", async (t) => {
  if (skipReason) return t.skip(skipReason);
  for (const width of [1280, 390]) {
    const { data } = await call<{ code: string }>("POST", "/api/login", {});
    const context = await browser.newContext({
      viewport: { width, height: width > 500 ? 900 : 844 },
    });
    const { page, problems } = await underHostedCsp(context, (p) => p === `/s/${ids.plan}`);
    try {
      await page.goto(`http://127.0.0.1:${port}/?view=inbox&login=${data.code}`);
      await page.goto(`http://127.0.0.1:${port}/s/${ids.plan}`);
      await page.frameLocator(".frame").locator('[data-oui-id="intro"]').waitFor();
      const view = page.viewportSize()!;
      /** Popper's inline transform put the content beside its trigger, not at the page's corner (where CSS alone leaves it). */
      const nearTrigger = async (trigger: string, content: string): Promise<void> => {
        const t = (await page.locator(trigger).boundingBox())!;
        const c = (await page.locator(content).boundingBox())!;
        assert.ok(
          c.y >= t.y + t.height - 8 && c.y < t.y + t.height + 40,
          `${content} sits under ${trigger}: ${JSON.stringify({ t, c })}`,
        );
        assert.ok(
          c.x >= 0 && c.x + c.width <= view.width + 1,
          `${content} is on screen: ${JSON.stringify(c)}`,
        );
      };
      // The ⋯ menu.
      await page.click(".menu-btn");
      await page.getByRole("menu").waitFor();
      await nearTrigger(".menu-btn", '[role="menu"]');
      await page.keyboard.press("Escape");
      await page.getByRole("menu").waitFor({ state: "detached" });

      if (width > 500) {
        // The Share dialog (owner's, local server).
        await page.getByRole("button", { name: "Share" }).click();
        const dialog = page.getByRole("dialog", {
          name: "Share with one person",
        });
        await dialog.waitFor();
        const box = (await dialog.boundingBox())!;
        assert.ok(Math.abs(box.x + box.width / 2 - view.width / 2) < 2, "the dialog is centred");
        await page.keyboard.press("Escape");
        await dialog.waitFor({ state: "detached" });
        // The sidebar, wide: it collapses and opens again, the page follows.
        const side = page.locator('[data-slot="sidebar"]');
        const toggle = page.getByRole("button", { name: /Toggle the projects sidebar/ });
        await toggle.click();
        await page
          .locator('[data-slot="sidebar"][data-state="expanded"]')
          .waitFor({ state: "attached" });
        await side.getByRole("link", { name: "Waiting page" }).waitFor();
        await toggle.click();
        await page
          .locator('[data-slot="sidebar"][data-state="collapsed"]')
          .waitFor({ state: "attached" });
      } else {
        // The sidebar, narrow: a sheet at the left edge, full height, over a scrim.
        await page.getByRole("button", { name: /Toggle the projects sidebar/ }).click();
        const sheet = page.locator('[data-sidebar="sidebar"][data-mobile="true"]');
        await sheet.getByRole("link", { name: "Waiting page" }).waitFor();
        await page.waitForFunction(
          () => document.querySelector('[data-mobile="true"]')!.getBoundingClientRect().x === 0,
        );
        const box = (await sheet.boundingBox())!;
        assert.ok(
          box.x === 0 && box.height >= view.height - 1,
          `the sheet is at the edge: ${JSON.stringify(box)}`,
        );
        await page.keyboard.press("Escape");
        await sheet.waitFor({ state: "detached" });
      }
      assert.deepEqual(problems, [], `at ${width}px`);
    } finally {
      await context.close();
    }
  }
});

test("phone: every text field is at least 16 px, so iOS does not zoom on focus", async (t) => {
  if (skipReason) return t.skip(skipReason);
  const { page, context } = await ownerTab(390);
  let seen = 0;
  try {
    for (const url of ["/?view=notes", "/?view=settings", `/s/${ids.waiting}`]) {
      await page.goto(`http://127.0.0.1:${port}${url}`);
      await page.waitForTimeout(1200);
      if (url.startsWith("/s/")) await page.click(".dock");
      await page.locator("input:visible, textarea:visible").first().waitFor();
      const fields = await page.evaluate(() =>
        [...document.querySelectorAll<HTMLElement>("input:not([type=hidden]), textarea")]
          .filter((e) => e.getBoundingClientRect().width > 0)
          .map((e) => ({
            el: `${e.tagName.toLowerCase()}#${e.id || e.className}`.slice(0, 50),
            px: parseFloat(getComputedStyle(e).fontSize),
          })),
      );
      seen += fields.length;
      assert.deepEqual(
        fields.filter((f) => f.px < 16),
        [],
        `fields under 16 px on ${url}`,
      );
    }
    assert.ok(seen >= 3, "the test found the fields");
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
    // The views live in the tab bar on a phone: the drawer's own links are the projects.
    await drawer.locator(".proj-link").click();
    await page.waitForURL(/project=/);
    await drawer.waitFor({ state: "detached" });
    const onToggle = () =>
      page.evaluate(() => document.activeElement?.classList.contains("side-toggle"));
    await page.waitForFunction(() => document.activeElement?.classList.contains("side-toggle"));
    // Esc: focus goes back to the toggle once the sheet is gone.
    await page.click(".side-toggle");
    await drawer.waitFor();
    await page.keyboard.press("Escape");
    await drawer.waitFor({ state: "detached" });
    await page.waitForFunction(() => document.activeElement?.classList.contains("side-toggle"));
    // Keyboard pick: focus the "All" link in the drawer, Enter.
    await page.keyboard.press("Enter");
    await drawer.waitFor();
    await drawer.locator(".all-projects").focus();
    await page.keyboard.press("Enter");
    await page.waitForURL((u) => !u.search.includes("project="));
    await drawer.waitFor({ state: "detached" });
    await page.waitForFunction(() => document.activeElement?.classList.contains("side-toggle"));
    assert.ok(await onToggle());

    // Dialog: Esc gives focus back to the button that asked.
    await page.goto(`http://127.0.0.1:${port}/?view=settings`);
    const rename = page.getByRole("button", { name: "Rename shop" });
    await rename.waitFor();
    await rename.focus();
    await page.keyboard.press("Enter");
    await page.getByRole("dialog").waitFor();
    await page.keyboard.press("Escape");
    await page.getByRole("dialog").waitFor({ state: "detached" });
    await page.waitForFunction(
      () => document.activeElement?.getAttribute("aria-label") === "Rename shop",
    );
    assert.deepEqual(problems, []);
  } finally {
    await context.close();
  }
});

test("Pages: the three filter tabs sit on one line, at desktop and tablet width", async (t) => {
  if (skipReason) return t.skip(skipReason);
  for (const width of [1280, 768]) {
    const { page, context, problems } = await ownerTab(width);
    try {
      await page.goto(`http://127.0.0.1:${port}/?view=pages`);
      await page.getByRole("tablist", { name: "Which pages" }).waitFor();
      const ys = await page
        .getByRole("tab")
        .evaluateAll((els) => els.map((e) => Math.round(e.getBoundingClientRect().top)));
      await shot(page, `hub-pages-${width}`);
      assert.equal(ys.length, 3);
      assert.equal(new Set(ys).size, 1, `tabs share one y at ${width}px: ${ys}`);
      assert.deepEqual(problems, []);
    } finally {
      await context.close();
    }
  }
});

test("stale reads: choosing the shown tab again wins; a search typed before a click does not replace the view; one Undo keeps another's", async (t) => {
  if (skipReason) return t.skip(skipReason);
  const { page, context, problems } = await ownerTab();
  try {
    // Pages: Everything (slow), then Open again before it answers. The last choice is what shows.
    await page.goto(`http://127.0.0.1:${port}/?view=pages`);
    await page.getByRole("tablist", { name: "Which pages" }).waitFor();
    await page.route(
      (url) => url.pathname === "/hub/api/pages" && url.searchParams.get("view") === "all",
      async (route) => {
        await new Promise((r) => setTimeout(r, 700));
        await route.continue();
      },
    );
    await page.getByRole("tab", { name: /Everything/ }).click();
    await page.getByRole("tab", { name: /Open/ }).click();
    await page.waitForTimeout(1200);
    assert.equal(
      (await page.locator("[role=tab][data-state=active]").innerText()).trim().split(/\s+/)[0],
      "Open",
    );
    assert.doesNotMatch(page.url(), /all=1/);

    // Search: type, then click Pages inside the 200 ms pause. Pages stays.
    await page.goto(`http://127.0.0.1:${port}/?view=inbox`);
    await group(page, "Quiet").waitFor();
    await page.getByRole("searchbox", { name: "Search pages and parts" }).fill("plan");
    await page.locator(".views a[data-view=pages]").click();
    await page.waitForTimeout(600);
    assert.match(page.url(), /view=pages/);
    assert.doesNotMatch(page.url(), /view=search/);

    // Undo: archive one page, start its slow Undo, archive another meanwhile. The second Undo stays.
    await page.goto(`http://127.0.0.1:${port}/?view=inbox`);
    await group(page, "Quiet").waitFor();
    await page.getByRole("button", { name: "Archive Quiet page" }).click();
    await page.locator("[data-sonner-toast]", { hasText: "Archived Quiet page." }).waitFor();
    await page.route("**/hub/api/page/*/unarchive", async (route) => {
      await new Promise((r) => setTimeout(r, 700));
      await route.continue();
    });
    await page.locator("[data-sonner-toast]").getByRole("button", { name: "Undo" }).click();
    await page.getByRole("button", { name: "Archive Waiting page" }).click();
    await page.locator("[data-sonner-toast]", { hasText: "Archived Waiting page." }).waitFor();
    await page.waitForTimeout(1200);
    assert.ok(
      await page
        .locator("[data-sonner-toast]", { hasText: "Archived Waiting page." })
        .getByRole("button", { name: "Undo" })
        .isVisible(),
      "the second page's Undo is still there",
    );
    // Put the state back for the tests after this one.
    await page.locator("[data-sonner-toast]").getByRole("button", { name: "Undo" }).click();
    await page.getByRole("link", { name: "Waiting page" }).first().waitFor();
    assert.deepEqual(problems, []);
  } finally {
    await context.close();
  }
});
