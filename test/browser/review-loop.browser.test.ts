// Opt-in browser suite (npm run test:browser; needs Chrome or CHROME_PATH).
// Drives the real review loop: server + chrome page + artifact iframe.
//   - every custom component example, stress example and examples/*.html page renders at
//     desktop and phone width with no errors, no render issues, no sideways scroll
//   - clicking a component's parts in Annotate mode, then Send, makes `poll`
//     return each one addressed to the right statement with detail.part
import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import net, { type AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import type { Browser, Frame } from "playwright-core";
import { launchBrowser } from "../../scripts/lib/browser.ts";
import { CDN_RUNTIME_URL } from "../../src/cli/artifact.ts";
import { ownerKey } from "../../src/cli/invites.ts";
import { ownerHeaders } from "../owner.ts";
import {
  ROOT,
  examplePage,
  htmlPage,
  loadLibrary,
  type LoadedLibrary,
} from "../../scripts/lib/plugins.ts";

const VIEWPORTS = [
  { name: "desktop", width: 1280, height: 900 },
  { name: "phone", width: 390, height: 844 },
];
const MAX_PARTS_PER_STATEMENT = 3;

let port: number;
let server: ChildProcess;
let browser: Browser;
let skipReason: string | undefined;
let lib: LoadedLibrary;
const STATE = fs.mkdtempSync(path.join(os.tmpdir(), "austere-browser-state-"));
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), "austere-browser-work-"));
const KEY = ownerKey(STATE);

/** A feedback item as `poll` returns it, as far as these tests read it. */
interface PollItem {
  kind?: string;
  text?: string;
  note?: string;
  target?: string;
  detail?: { part?: string };
  statement?: string;
  form?: unknown;
}

/** The fields these tests read from the server's JSON replies. */
interface ApiReply {
  session: { id: string };
  code: string;
  status: string;
  final?: true;
  items: PollItem[];
  cursor: number;
}

/** A frame flag that a reload clears. */
type FlaggedWindow = Window & { __beforeReload?: boolean };

function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, "127.0.0.1", () => {
      const p = (s.address() as AddressInfo).port;
      s.close(() => resolve(p));
    });
  });
}

function api(route: string, body: unknown): Promise<ApiReply> {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
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
        res.on("end", () => resolve(JSON.parse(data) as ApiReply));
      },
    );
    r.on("error", reject);
    r.end(payload);
  });
}

/** Pages to check: galleries of custom component examples and stress examples, plus every example page. */
function pages() {
  const gallery = path.join(WORK, "gallery.html");
  fs.writeFileSync(
    gallery,
    htmlPage("Gallery", examplePage(lib.CUSTOM_COMPONENTS), CDN_RUNTIME_URL),
  );
  const list = [{ name: "gallery", file: gallery }];
  if (lib.CUSTOM_COMPONENTS.some((c) => c.stress)) {
    const stress = path.join(WORK, "stress.html");
    fs.writeFileSync(
      stress,
      htmlPage("Stress", examplePage(lib.CUSTOM_COMPONENTS, "stress"), CDN_RUNTIME_URL),
    );
    list.push({ name: "stress", file: stress });
  }
  for (const f of fs.readdirSync(path.join(ROOT, "examples")).filter((x) => x.endsWith(".html"))) {
    // Copy beside the gallery so the runtime tag is rewritten the same way.
    const dest = path.join(WORK, f);
    fs.copyFileSync(path.join(ROOT, "examples", f), dest);
    list.push({ name: f, file: dest });
  }
  return list;
}

async function openReview(file: string, viewport: { width: number; height: number }) {
  const { session } = await api("/api/open", { file });
  const context = await browser.newContext({
    viewport: { width: viewport.width, height: viewport.height },
  });
  const page = await context.newPage();
  const problems: string[] = [];
  page.on("pageerror", (e) => problems.push(`pageerror: ${e.message}`));
  page.on("console", (m) => {
    if (m.type() === "error") problems.push(`console error: ${m.text()}`);
  });
  // As the CLI does when it opens a browser: a single-use login code signs it in as the owner.
  const { code } = await api("/api/login", {});
  await page.goto(`http://127.0.0.1:${port}/s/${session.id}?login=${code}`);
  const frameEl = await page.waitForSelector("iframe.frame");
  const frame = (await frameEl.contentFrame()) as Frame;
  await frame.waitForSelector("[data-oui-id]", { timeout: 15_000 });
  await page.waitForTimeout(400);
  return { context, page, frame, problems, session };
}

before(async () => {
  lib = await loadLibrary();
  for (const f of ["austere.js", "packs/shadcn/pack.js", "chrome/chrome.js"]) {
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
      // A quiet agent turns stale after 2 s here, not 10 min, so the phone test can see it.
      env: {
        ...process.env,
        AUSTERE_AXI_STATE_DIR: STATE,
        AUSTERE_AXI_NO_TAILSCALE: "1",
        OPENUI_TELEMETRY_DISABLED: "1",
        AUSTERE_AXI_STALE_WORKING_MS: "2000",
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

describe("renders cleanly", () => {
  for (const viewport of VIEWPORTS) {
    test(`every page at ${viewport.name} (${viewport.width}px)`, async (t) => {
      if (skipReason) return t.skip(skipReason);
      for (const p of pages()) {
        const { context, page, frame, problems } = await openReview(p.file, viewport);
        try {
          const state = await frame.evaluate(() => ({
            overflow: document.documentElement.scrollWidth - window.innerWidth,
            renderErrors: Array.from(document.querySelectorAll(".austere-render-error")).map((e) =>
              (e.textContent as string).trim(),
            ),
            statements: document.querySelectorAll("[data-oui-id]").length,
          }));
          const issues = await page.locator(".issues").allInnerTexts();
          const where = `${p.name} @ ${viewport.width}px`;
          assert.ok(state.statements > 0, `${where}: nothing rendered`);
          assert.ok(state.overflow <= 1, `${where}: page scrolls sideways by ${state.overflow}px`);
          assert.deepEqual(state.renderErrors, [], `${where}: render errors`);
          assert.deepEqual(issues, [], `${where}: the review panel reports render issues`);
          assert.deepEqual(problems, [], `${where}: browser errors`);
        } finally {
          await context.close();
        }
      }
    });
  }
});

test("every component part is annotatable end to end", async (t) => {
  if (skipReason) return t.skip(skipReason);
  const gallery = pages()[0];
  const { context, page, frame, problems } = await openReview(gallery.file, VIEWPORTS[0]);
  try {
    // Pick up to N parts per statement: first, middle, last.
    const targets = await frame.evaluate((max) => {
      const by = new Map<string, string[]>();
      for (const el of document.querySelectorAll("[data-austere-part]")) {
        const id = el.closest("[data-oui-id]")?.getAttribute("data-oui-id");
        if (!id) continue;
        if (!by.has(id)) by.set(id, []);
        const v = el.getAttribute("data-austere-part") as string;
        const list = by.get(id) as string[];
        if (!list.includes(v)) list.push(v);
      }
      const out: { id: string; part: string }[] = [];
      for (const [id, parts] of by) {
        const idx = [...new Set([0, Math.floor((parts.length - 1) / 2), parts.length - 1])].slice(
          0,
          max,
        );
        for (const i of idx) out.push({ id, part: parts[i] });
      }
      return out;
    }, MAX_PARTS_PER_STATEMENT);
    // A statement "has parts" when any part sits inside it, even one claimed
    // by a nested statement (an Architecture's parts belong to its Nodes).
    const withParts = new Set(
      await frame.evaluate(() =>
        Array.from(document.querySelectorAll("[data-oui-id]"))
          .filter((el) => el.querySelector("[data-austere-part]"))
          .map((el) => el.getAttribute("data-oui-id")),
      ),
    );
    for (const c of lib.CUSTOM_COMPONENTS) {
      for (const program of c.example || []) {
        // value-only parts have none: their container's example shows them
        const first = (program.match(/^\s*([A-Za-z_]\w*)\s*=/m) as RegExpMatchArray)[1];
        if (!withParts.has(first))
          t.diagnostic(`${c.name} (${first}) has no data-austere-part targets`);
      }
    }
    assert.ok(targets.length > 0, "no data-austere-part targets found");

    for (const { id, part } of targets) {
      const loc = frame
        .locator(`[data-oui-id="${id}"] [data-austere-part="${part.replace(/"/g, '\\"')}"]`)
        .first();
      // An SVG stroke (a diagram edge) is not hit at its bounding-box centre:
      // find a point on the stroke that nothing covers, and click exactly there.
      const point = await loc.evaluate((el: SVGGeometryElement) => {
        if (typeof el.getTotalLength !== "function") return null;
        el.scrollIntoView({ block: "center", inline: "center" });
        const len = el.getTotalLength();
        for (const t of [0.5, 0.3, 0.7, 0.2, 0.8, 0.12, 0.88]) {
          const q = el.getPointAtLength(len * t);
          const p = new DOMPoint(q.x, q.y).matrixTransform(el.getScreenCTM() as DOMMatrix);
          if (el.ownerDocument.elementFromPoint(p.x, p.y) === el) return { x: p.x, y: p.y };
        }
        return null;
      });
      if (point) {
        const origin = await (
          await frame.frameElement()
        ).evaluate((f: HTMLIFrameElement) => {
          const r = f.getBoundingClientRect();
          return { x: r.left + f.clientLeft, y: r.top + f.clientTop };
        });
        await page.mouse.click(origin.x + point.x, origin.y + point.y);
      } else {
        await loc.click();
      }
      const pop = frame.locator(".austere-pop");
      await pop.waitFor({ state: "visible", timeout: 3000 }).catch(() => {
        throw new Error(`clicking part "${part}" in ${id} did not open the annotation popover`);
      });
      const quote = (await frame.locator(".austere-pop-quote").innerText()).trim();
      assert.ok(quote, `part "${part}" in ${id}: the popover shows no quote`);
      await frame.locator(".austere-pop textarea").fill(`check ${id}: ${part}`);
      await frame.locator(".austere-pop textarea").press("Enter");
      await pop.waitFor({ state: "hidden", timeout: 3000 });
    }
    await page.locator(".composer .send").click();
    const res = await api("/api/poll", { file: gallery.file, timeoutMs: 5000 });
    assert.equal(res.status, "feedback", `poll returned ${res.status}`);
    for (const { id, part } of targets) {
      const hit = res.items.find(
        (i) => i.kind === "annotation" && i.note === `check ${id}: ${part}`,
      );
      assert.ok(hit, `part "${part}" in ${id} never reached poll`);
      assert.equal(hit.target, id, `part "${part}" was addressed to ${hit.target}, expected ${id}`);
      assert.equal(
        hit.detail?.part,
        part,
        `part "${part}" in ${id} arrived as ${JSON.stringify(hit.detail)}`,
      );
    }
    assert.deepEqual(problems, [], "browser errors");
  } finally {
    await context.close();
  }
});

test("a page using an installed pack renders it, warns about third-party code, and its parts are annotatable", async (t) => {
  if (skipReason) return t.skip(skipReason);
  const cli = (...args: string[]) => {
    const r = spawnSync(process.execPath, [path.join(ROOT, "src/cli/main.ts"), ...args], {
      env: { ...process.env, AUSTERE_AXI_STATE_DIR: STATE, OPENUI_TELEMETRY_DISABLED: "1" },
      encoding: "utf8",
    });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    return r.stdout;
  };
  const dir = path.join(WORK, "austere-pack-milestones");
  cli("components", "new", dir);
  cli("components", "build", dir);
  cli("components", "add", dir);
  const file = path.join(WORK, "with-pack.html");
  fs.writeFileSync(
    file,
    htmlPage(
      "With a pack",
      'root = Stack([c])\nc = Card([CardHeader("Launch"), launch])\nlaunch = Milestones(["Mon | Freeze | branch cut", "Fri | GA"])',
      CDN_RUNTIME_URL,
    ),
  );
  cli("check", "--fix", file);
  const { context, page, frame, problems } = await openReview(file, VIEWPORTS[1]);
  try {
    await frame.waitForSelector(".pack-milestones li", { timeout: 10_000 });
    assert.match(
      (await page.locator(".notice").textContent()) as string,
      /Third-party pack code runs in this page: check queued items before you send \(austere-pack-milestones@0\.1\.0\)/,
    );
    await frame.locator('[data-austere-part="GA"]').click();
    await frame.locator(".austere-pop textarea").fill("move GA");
    await frame.locator(".austere-pop textarea").press("Enter");
    await page
      .locator(".dock")
      .click()
      .catch(() => {});
    await page.locator(".composer .send").click();
    const res = await api("/api/poll", { file, timeoutMs: 5000 });
    const hit = res.items?.find((i) => i.note === "move GA");
    assert.equal(hit?.target, "launch");
    assert.equal(hit?.detail?.part, "GA");
    assert.deepEqual(problems, [], "browser errors");
  } finally {
    await context.close();
  }
});

test("a diagram copied from another page with patch --from renders, and each of its nodes is annotatable", async (t) => {
  if (skipReason) return t.skip(skipReason);
  const run = (...args: string[]) => {
    const r = spawnSync(process.execPath, [path.join(ROOT, "src/cli/main.ts"), ...args], {
      env: { ...process.env, AUSTERE_AXI_STATE_DIR: STATE, OPENUI_TELEMETRY_DISABLED: "1" },
      input: "",
      encoding: "utf8",
    });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    return r.stdout;
  };
  const source = path.join(WORK, "copy-source.html");
  fs.copyFileSync(path.join(ROOT, "examples", "session-migration.html"), source);
  const file = path.join(WORK, "copy-target.html");
  fs.writeFileSync(
    file,
    htmlPage(
      "Copy target",
      'root = Stack([intro])\nintro = TextContent("a page of its own")',
      CDN_RUNTIME_URL,
    ),
  );
  const patched = spawnSync(
    process.execPath,
    [path.join(ROOT, "src/cli/main.ts"), "patch", file, "--from", `${source}#flowDiagram`],
    {
      env: { ...process.env, AUSTERE_AXI_STATE_DIR: STATE, OPENUI_TELEMETRY_DISABLED: "1" },
      input: "root = Stack([intro, flowDiagram])",
      encoding: "utf8",
    },
  );
  assert.equal(patched.status, 0, patched.stdout + patched.stderr);
  assert.match(run("check", file), /status: ok/);
  const { context, page, frame, problems } = await openReview(file, VIEWPORTS[0]);
  try {
    const nodes = ["client", "edge", "api", "pg", "redis"];
    for (const id of nodes) {
      await frame.locator(`[data-oui-id="${id}"]`).first().waitFor({ timeout: 10_000 });
      await frame.locator(`[data-oui-id="${id}"]`).first().click();
      await frame.locator(".austere-pop").waitFor({ state: "visible", timeout: 3000 });
      await frame.locator(".austere-pop textarea").fill(`check node ${id}`);
      await frame.locator(".austere-pop textarea").press("Enter");
      await frame.locator(".austere-pop").waitFor({ state: "hidden", timeout: 3000 });
    }
    await page.locator(".composer .send").click();
    const res = await api("/api/poll", { file, timeoutMs: 5000 });
    for (const id of nodes)
      assert.equal(
        res.items.find((i) => i.note === `check node ${id}`)?.target,
        id,
        `node ${id} reached poll addressed to itself`,
      );
    assert.deepEqual(problems, [], "browser errors");
  } finally {
    await context.close();
  }
});

test("one press of a Form's button sends every answer, pre-selected ones the reviewer left as they were included", async (t) => {
  if (skipReason) return t.skip(skipReason);
  const file = path.join(WORK, "form-answers.html");
  const program = [
    "root = Stack([ask])",
    'ask = Form("answers", buttons, [db, plan, checks, size])',
    'db = FormControl("Database?", RadioGroup("db", [RadioItem("Postgres", "", "pg"), RadioItem("MySQL", "", "my")], "pg"))',
    'plan = FormControl("Plan?", OptionCards("plan", "single", [OptionCard("a", "Plan A"), OptionCard("b", "Plan B")], {}, "a"))',
    'checks = FormControl("Checks?", CheckBoxGroup("checks", [CheckBoxItem("Lint", "", "lint", true), CheckBoxItem("Fuzz", "", "fuzz")]))',
    'size = FormControl("Batch size", Slider("size", "discrete", 1, 10, 1, [3]))',
    'buttons = Buttons([Button("Send answers", @ToAssistant("Answers"), "primary")])',
  ].join("\n");
  fs.writeFileSync(file, htmlPage("Form answers", program, CDN_RUNTIME_URL));
  const { context, page, frame, problems } = await openReview(file, VIEWPORTS[0]);
  try {
    // The reviewer changes one answer and keeps the other three as the agent pre-selected them.
    await frame.getByText("Plan B", { exact: true }).click();
    await frame.getByText("Send answers", { exact: true }).click();
    await page.locator(".composer .send").click();
    const res = await api("/api/poll", { file, timeoutMs: 5000 });
    const action = res.items.find((i) => i.kind === "action");
    assert.deepEqual(action?.form, {
      answers: { db: "pg", plan: "b", checks: { lint: true, fuzz: false }, size: [3] },
    });
    assert.deepEqual(problems, [], "browser errors");
  } finally {
    await context.close();
  }
});

test("with no agent listening the reviewer can still send; Send & finish and Done mark the batch final; only archiving locks the composer", async (t) => {
  if (skipReason) return t.skip(skipReason);
  const file = path.join(WORK, "archive-lock.html");
  fs.writeFileSync(
    file,
    htmlPage(
      "Archive lock",
      'root = Stack([intro])\nintro = TextContent("hello")',
      CDN_RUNTIME_URL,
    ),
  );
  const { context, page, problems } = await openReview(file, VIEWPORTS[0]);
  const finalLine =
    "You told the agent this was your last note. Notes you add later wait until an agent checks.";
  try {
    await page.waitForSelector(".presence:has-text('Agent not listening')");
    assert.equal(await page.locator(".composer textarea").isDisabled(), false);
    await page.fill(".composer textarea", "one more thing");
    await page.click(".composer .send");
    await page.waitForSelector(".presence:has-text('1 not answered yet')");
    assert.equal(
      await page.locator(".receipt em").textContent(),
      "waiting for the agent (1 not answered yet)",
    );
    const res = await api("/api/poll", { file, timeoutMs: 5000 });
    assert.equal(res.status, "feedback");
    assert.equal(res.items[0].text, "one more thing");
    assert.equal(res.final, undefined);

    await page.fill(".composer textarea", "last words");
    assert.equal(await page.locator(".composer .send-end").textContent(), "Send & finish");
    await page.click(".composer .send-end");
    const last = await api("/api/poll", { file, cursor: res.cursor, timeoutMs: 5000 });
    assert.equal(last.final, true);
    await page.waitForSelector(".composer textarea:not([disabled])"); // the send finished; Send & finish locks nothing
    await page.waitForSelector(`.final-note:has-text("${finalLine}")`);

    // Nothing typed or queued: the button is Done, and it sends an empty final batch.
    const done = page.locator(".composer .send-end");
    assert.equal(await done.textContent(), "Done");
    assert.equal(await done.getAttribute("title"), "Tell the agent you have no more notes");
    await done.click();
    const empty = await api("/api/poll", { file, cursor: last.cursor, timeoutMs: 5000 });
    assert.equal(empty.status, "feedback");
    assert.equal(empty.final, true);
    assert.deepEqual(empty.items, []);
    await page.waitForFunction(() => document.querySelectorAll(".final-note").length === 2);
    assert.equal(
      await page.locator(".log .msg.user").count(),
      2,
      "Done adds the line only, no empty note",
    );
    assert.equal(await done.isDisabled(), true, "Done once is enough");

    // A later note is still accepted.
    await page.fill(".composer textarea", "after all, one more");
    assert.equal(await done.isDisabled(), false);
    await page.click(".composer .send");
    const later = await api("/api/poll", { file, cursor: empty.cursor, timeoutMs: 5000 });
    assert.deepEqual(
      later.items.map((i) => i.text),
      ["after all, one more"],
    );
    assert.equal(later.final, undefined);

    await page.click(".menu-btn");
    await page.click('[data-cmd="archive"]');
    // One copy: the dialog offers no "every copy".
    await page.waitForSelector("[role=dialog].confirm");
    assert.equal(await page.locator("[role=dialog].confirm h2").textContent(), "Archive this page?");
    assert.equal(await page.locator('[role=dialog].confirm [data-archive="every"]').count(), 0);
    await page.click('[role=dialog].confirm [data-archive="this"]');
    await page.waitForSelector(".presence:has-text('Page archived')");
    assert.equal(await page.locator(".composer textarea").isDisabled(), true);
    assert.equal(await page.locator(".archived-note").count(), 1);
    // The frame is in Explore, and the switch shows it: Annotate is off and cannot be picked.
    assert.equal(await page.locator('.seg [data-mode="annotate"]').isDisabled(), true);
    assert.match(
      String(await page.locator('.seg [data-mode="explore"]').getAttribute("class")),
      /\bon\b/,
    );

    await page.click(".menu-btn");
    await page.click('[data-cmd="unarchive"]');
    await page.waitForSelector(".composer textarea:not([disabled])");
    assert.equal(await page.locator(".presence:has-text('Page archived')").count(), 0);
    assert.deepEqual(problems, [], "browser errors");
  } finally {
    await context.close();
  }
});

/** A repository at `<dir>/shop` on main and its worktree `<dir>/shop-feat` on feat, as git lays them out, each with `name`. */
function twoCopies(dir: string, name: string, program: string): { main: string; feat: string } {
  const main = path.join(dir, "shop");
  const wt = path.join(dir, "shop-feat");
  const gitdir = path.join(main, ".git", "worktrees", "shop-feat");
  fs.mkdirSync(gitdir, { recursive: true });
  fs.mkdirSync(wt, { recursive: true });
  fs.writeFileSync(path.join(main, ".git", "HEAD"), "ref: refs/heads/main\n");
  fs.writeFileSync(path.join(gitdir, "commondir"), "../..\n");
  fs.writeFileSync(path.join(gitdir, "HEAD"), "ref: refs/heads/feat\n");
  fs.writeFileSync(path.join(gitdir, "gitdir"), path.join(wt, ".git") + "\n");
  fs.writeFileSync(path.join(wt, ".git"), `gitdir: ${gitdir}\n`);
  const html = htmlPage("Two copies", program, CDN_RUNTIME_URL);
  for (const root of [main, wt]) fs.writeFileSync(path.join(root, name), html);
  return { main: path.join(main, name), feat: path.join(wt, name) };
}

/** Sends a message on a page as its owner, as the composer does. */
function sendNote(id: string, text: string): Promise<number | undefined> {
  return new Promise((resolve, reject) => {
    const r = http.request(
      {
        host: "127.0.0.1",
        port,
        method: "POST",
        path: `/s/${id}/send`,
        headers: { "content-type": "application/json", ...ownerHeaders(STATE) },
      },
      (res) => {
        res.resume();
        res.on("end", () => resolve(res.statusCode));
      },
    );
    r.on("error", reject);
    r.end(JSON.stringify({ items: [{ kind: "message", text }] }));
  });
}

test("a page with two copies: the dialog names this copy, its unanswered notes and the copy that stays; every copy archives both; errors show", async (t) => {
  if (skipReason) return t.skip(skipReason);
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(WORK, "copies-")));
  const { main, feat } = twoCopies(
    dir,
    "plan.html",
    'root = Stack([intro])\nintro = TextContent("hello")',
  );
  const a = (await api("/api/open", { file: main })).session.id;
  const b = (await api("/api/open", { file: feat })).session.id;
  for (const text of ["one", "two", "three"]) assert.equal(await sendNote(a, text), 200);
  assert.equal(await sendNote(b, "on feat"), 200);
  const archived = async (file: string) =>
    ((await api("/api/open", { file })) as ApiReply & { session: { archived: boolean } }).session
      .archived;

  for (const viewport of VIEWPORTS) {
    const { context, page, problems } = await openReview(main, viewport);
    try {
      const ask = async () => {
        await page.click(".menu-btn");
        await page.click('[data-cmd="archive"]');
        await page.waitForSelector("[role=dialog].confirm");
      };
      // The composer locks when the page is archived (at 390 px the presence label is not shown).
      const locked = (on: boolean) =>
        page.waitForFunction(
          (on) =>
            document.querySelector<HTMLTextAreaElement>(".composer textarea")?.disabled === on,
          on,
        );
      await ask();
      const dialog = page.locator("[role=dialog].confirm");
      assert.equal(await dialog.locator("h2").textContent(), "Archive this copy (main)?");
      const text = String(await dialog.textContent());
      assert.match(
        text,
        /3 unanswered notes go with it: they are kept, but leave the hub's counts\./,
      );
      assert.match(text, /This copy stays open:/);
      assert.equal(await dialog.locator("li").textContent(), "feat · 1 unanswered note");
      assert.equal(
        await dialog.locator("li").getAttribute("title"),
        feat,
        "the full path is a hover away",
      );
      const box = await dialog.boundingBox();
      assert.ok(
        box && box.x >= 0 && box.x + box.width <= viewport.width,
        `the dialog fits at ${viewport.width} px`,
      );

      // Cancel archives nothing; Escape neither.
      await dialog.locator("button", { hasText: "Cancel" }).click();
      assert.equal(await page.locator("[role=dialog].confirm").count(), 0);
      await ask();
      await page.keyboard.press("Escape");
      assert.equal(await page.locator("[role=dialog].confirm").count(), 0);
      assert.equal(await archived(main), false);

      // This copy only: the other one stays open.
      await ask();
      await page.click('[role=dialog].confirm [data-archive="this"]');
      await locked(true);
      assert.equal(await archived(main), true);
      assert.equal(await archived(feat), false, "the copy in the other worktree stays open");

      // A failed unarchive says why instead of doing nothing.
      await page.route("**/unarchive", (route) =>
        route.fulfill({
          status: 500,
          contentType: "application/json",
          body: JSON.stringify({ error: "disk full" }),
        }),
      );
      await page.click(".menu-btn");
      await page.click('[data-cmd="unarchive"]');
      await page.waitForSelector(".banner:has-text('Could not unarchive this page: disk full')");
      await page.unroute("**/unarchive");
      await page.click(".menu-btn");
      await page.click('[data-cmd="unarchive"]');
      await locked(false);
      assert.equal(
        await page.locator(".banner:has-text('Could not unarchive')").count(),
        0,
        "a later success clears the error",
      );

      // Every copy.
      await ask();
      await page.click('[role=dialog].confirm [data-archive="every"]');
      await locked(true);
      assert.equal(await archived(feat), true, "every copy is archived");

      // A failed archive says why too.
      await page.click(".menu-btn");
      await page.click('[data-cmd="unarchive"]');
      await locked(false);
      await page.route("**/archive", (route) =>
        route.fulfill({
          status: 404,
          contentType: "application/json",
          body: JSON.stringify({ error: "not in the hub" }),
        }),
      );
      await page.click(".menu-btn");
      await page.click('[data-cmd="archive"]');
      await page.waitForSelector(".banner:has-text('Could not archive this page: not in the hub')");
      await page.unroute("**/archive");
      assert.deepEqual(
        problems.filter((p) => !/status of 40[04]|status of 500/.test(p)),
        [],
        "browser errors",
      );
    } finally {
      await context.close();
    }
    // Back to one open copy each time round.
    for (const file of [main, feat]) await api("/api/unarchive", { file });
  }
});

test("on a phone the dock says what the agent does; with nobody listening the composer says what Send does and the owner can copy the agent prompt", async (t) => {
  if (skipReason) return t.skip(skipReason);
  const file = path.join(WORK, "presence-phone.html");
  fs.writeFileSync(
    file,
    htmlPage("Presence", 'root = Stack([intro])\nintro = TextContent("hello")', CDN_RUNTIME_URL),
  );
  const { context, page, problems } = await openReview(file, VIEWPORTS[1]);
  try {
    const dock = page.locator(".dock .dock-presence");
    await page.waitForSelector(".dock .dock-presence:has-text('Agent not listening')");
    await page.locator(".dock").click();
    const line = page.locator(".composer-presence");
    await line.waitFor({ state: "visible" });
    assert.equal(
      await line.locator("span").textContent(),
      "Saved. The agent gets them the next time it checks.",
    );
    await context.grantPermissions(["clipboard-read", "clipboard-write"], {
      origin: `http://127.0.0.1:${port}`,
    });
    await line.locator(".copy-prompt").click();
    await page.waitForSelector(".banner:not([hidden])");
    assert.ok(
      (await page.evaluate(() => navigator.clipboard.readText())).includes(`File: ${file}`),
    );

    await page.fill(".composer textarea", "tighten the intro");
    await page.click(".composer .send");
    await page.waitForSelector(".dock .dock-presence:has-text('1 not answered yet')");
    const res = await api("/api/poll", { file, timeoutMs: 5000 });
    assert.equal(res.status, "feedback");
    // The poll that took the notes is gone and never replies: working, then stale.
    await page.waitForSelector(".dock .dock-presence:has-text('Agent working')");
    assert.equal(await line.isVisible(), false, "an agent has the notes: no not-listening line");
    await page.waitForSelector(".dock .dock-presence:has-text('Took your notes, no reply yet')", {
      timeout: 15_000,
    });
    assert.equal(
      await dock.evaluate((el) => el.scrollWidth <= el.clientWidth),
      true,
      "the stale label fits the dock at 390 px",
    );

    await api("/api/reply", { file, text: "done", cursor: res.cursor });
    await page.waitForSelector(".dock .dock-presence:has-text('Agent not listening')");
    assert.deepEqual(problems, [], "browser errors");
  } finally {
    await context.close();
  }
});

test("Copy agent prompt under the composer asks again after the prompt could not be fetched", async (t) => {
  if (skipReason) return t.skip(skipReason);
  const file = path.join(WORK, "prompt-retry.html");
  fs.writeFileSync(
    file,
    htmlPage(
      "Prompt retry",
      'root = Stack([intro])\nintro = TextContent("hello")',
      CDN_RUNTIME_URL,
    ),
  );
  const { context, page } = await openReview(file, VIEWPORTS[0]);
  try {
    await context.grantPermissions(["clipboard-read", "clipboard-write"], {
      origin: `http://127.0.0.1:${port}`,
    });
    // Opening the menu fetches the prompt again; here the service does not answer.
    await page.route("**/agent-prompt", (route) => route.abort());
    await page.click(".menu-btn");
    await page.locator(".composer-presence .copy-prompt").click();
    await page.waitForSelector(".banner:has-text('Could not get the agent prompt')");
    // The service is back: the same button must fetch again, not replay the failed answer.
    await page.unroute("**/agent-prompt");
    await page.locator(".composer-presence .copy-prompt").click();
    await page.waitForSelector(".banner:has-text('Agent prompt copied.')");
    assert.ok(
      (await page.evaluate(() => navigator.clipboard.readText())).includes(`File: ${file}`),
    );
  } finally {
    await context.close();
  }
});

test("Explore hides the conversation and gives the page the full width; Annotate brings it back", async (t) => {
  if (skipReason) return t.skip(skipReason);
  const file = path.join(WORK, "explore-panel.html");
  fs.writeFileSync(
    file,
    htmlPage(
      "Explore panel",
      'root = Stack([intro])\nintro = TextContent("hello")',
      CDN_RUNTIME_URL,
    ),
  );
  for (const viewport of VIEWPORTS) {
    const { context, page, problems } = await openReview(file, viewport);
    const conversation = viewport.width > 860 ? ".panel" : ".dock";
    const frameWidth = () =>
      page.locator("iframe.frame").evaluate((el) => el.getBoundingClientRect().width);
    try {
      await page.click('.seg button[data-mode="annotate"]');
      assert.equal(
        await page.locator(conversation).isVisible(),
        true,
        `${viewport.name}: conversation shown in Annotate`,
      );
      const annotateWidth = await frameWidth();

      await page.click('.seg button[data-mode="explore"]');
      assert.equal(
        await page.locator(".panel").isVisible(),
        false,
        `${viewport.name}: panel hidden in Explore`,
      );
      assert.equal(
        await page.locator(".dock").isVisible(),
        false,
        `${viewport.name}: dock hidden in Explore`,
      );
      assert.equal(
        await frameWidth(),
        viewport.width,
        `${viewport.name}: page takes the full width in Explore`,
      );

      // The mode is remembered, and the panel stays hidden after a reload.
      await page.reload();
      await page.waitForSelector("iframe.frame");
      assert.equal(
        await page.locator(".panel").isVisible(),
        false,
        `${viewport.name}: panel hidden after reload in Explore`,
      );

      // Replies that arrive while the conversation is hidden: Annotate shows the latest one.
      const last = `reply ${viewport.name} 24`;
      for (let i = 0; i < 25; i++)
        await api("/api/reply", {
          file,
          text: `reply ${viewport.name} ${i}\n${"line\n".repeat(4)}`,
        });
      await page.waitForSelector(`.log :text("${last}")`, { state: "attached" });

      await page.keyboard.press("ControlOrMeta+i");
      await page.waitForSelector(`${conversation}:visible`);
      assert.equal(
        await frameWidth(),
        annotateWidth,
        `${viewport.name}: layout restored in Annotate`,
      );
      if (viewport.width > 860) {
        const gap = await page
          .locator('.log [data-slot="scroll-area-viewport"]')
          .evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight);
        assert.ok(gap < 2, `${viewport.name}: log scrolled to the latest reply (gap ${gap}px)`);
      }
      assert.deepEqual(problems, [], "browser errors");
    } finally {
      await context.close();
    }
  }
});

test("the queue numbers its notes and brings a new one into view; the Agent panel takes what it covers out of the tab order; the mode buttons say which is on", async (t) => {
  if (skipReason) return t.skip(skipReason);
  const file = path.join(WORK, "queue-panel.html");
  fs.writeFileSync(
    file,
    htmlPage("Queue panel", 'root = Stack([intro])\nintro = TextContent("hello")', CDN_RUNTIME_URL),
  );
  const { context, page, frame, problems } = await openReview(file, { width: 1280, height: 640 });
  const pressed = () =>
    page
      .locator(".seg [data-mode]")
      .evaluateAll((els) =>
        els.map((el) => `${(el as HTMLElement).dataset.mode}:${el.getAttribute("aria-pressed")}`),
      );
  const list = page.locator(".queue-list");
  const numbers = () => list.locator(".q-num").allInnerTexts();
  try {
    assert.deepEqual(await pressed(), ["annotate:true", "explore:false"]);
    for (let i = 1; i <= 6; i++) {
      await frame.locator('[data-oui-id="intro"]').click();
      await frame.fill(".austere-pop textarea", `note ${i}\n${"line\n".repeat(3)}`);
      await frame.click('.austere-pop [data-act="queue"]');
      await page.waitForFunction(
        (n) => document.querySelectorAll(".queue-list .q-item").length === n,
        i,
      );
    }
    assert.equal(await page.locator(".queue-title").textContent(), "Ready to send · 6");
    assert.deepEqual(await numbers(), ["1", "2", "3", "4", "5", "6"]);
    assert.deepEqual(
      await list
        .locator(".q-edit")
        .evaluateAll((els) => els.map((el) => el.getAttribute("aria-label"))),
      [1, 2, 3, 4, 5, 6].map((n) => `Edit note ${n}`),
    );
    // The list scrolls by itself: the note just added is the one in view.
    const scroll = () =>
      list.evaluate((el) => ({
        over: el.scrollHeight - el.clientHeight,
        gap: el.scrollHeight - el.scrollTop - el.clientHeight,
        top: el.scrollTop,
      }));
    const full = await scroll();
    assert.ok(full.over > 0, "six notes are more than the list shows at once");
    assert.ok(full.gap < 2, `the newest note is in view (${full.gap}px below the fold)`);
    // Removing a note renumbers the rest and keeps the list where it was.
    await list.locator('[aria-label="Remove note 5"]').click();
    await page.waitForFunction(() => document.querySelectorAll(".queue-list .q-item").length === 5);
    assert.deepEqual(await numbers(), ["1", "2", "3", "4", "5"]);
    assert.ok((await scroll()).top > 0, "the list did not jump back to its first note");

    // The Agent panel lies over the queue and the composer: they take no focus until Notes is back.
    const inert = () =>
      page
        .locator(".panel > .log, .panel > .queue, .panel > .composer")
        .evaluateAll((els) => els.map((el) => (el as HTMLElement).inert));
    await page.click('.panel-tab[data-tab="agent"]');
    await page.locator(".attach-pop").waitFor({ state: "visible" });
    assert.equal(
      await page.locator('.panel-tab[data-tab="agent"]').getAttribute("aria-current"),
      "true",
    );
    assert.deepEqual(await inert(), [true, true, true]);
    await page.click('.panel-tab[data-tab="notes"]');
    await page.locator(".attach-pop").waitFor({ state: "hidden" });
    assert.equal(
      await page.locator('.panel-tab[data-tab="notes"]').getAttribute("aria-current"),
      "true",
    );
    assert.deepEqual(await inert(), [false, false, false]);

    await page.keyboard.press("ControlOrMeta+i");
    assert.deepEqual(await pressed(), ["annotate:false", "explore:true"]);
    assert.deepEqual(problems, [], "browser errors");
  } finally {
    await context.close();
  }
});

test("an Image shows the whole picture at its own aspect ratio: card-wide, screen-high at most, no band below, side by side, as a thumbnail", async (t) => {
  if (skipReason) return t.skip(skipReason);
  // Inline pictures: the test is about layout, not about how the frame fetches files.
  const svg = (w: number, h: number) =>
    "data:image/svg+xml;base64," +
    Buffer.from(
      `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"><rect width="${w}" height="${h}" fill="#888"/></svg>`,
    ).toString("base64");
  const file = path.join(WORK, "image-ratio.html");
  const program = [
    "root = Stack([card, pair, pick])",
    'card = Card([CardHeader("Pictures"), wide, tall])',
    `wide = Image("A 2:1 picture", "${svg(400, 200)}")`,
    `tall = Image("A 1:4 picture", "${svg(200, 800)}")`,
    'pair = Card([CardHeader("Side by side"), row])',
    'row = Stack([left, right], "row")',
    `left = Image("A 5:1 picture", "${svg(1000, 200)}")`,
    `right = Image("A 2:1 picture", "${svg(400, 200)}")`,
    'pick = Card([CardHeader("Pick one"), opts])',
    'opts = OptionCards("layout", "single", [optA])',
    'optA = OptionCard("a", "Layout A", "Tall thumbnail", thumb)',
    `thumb = Image("A 1:4 thumbnail", "${svg(200, 800)}")`,
  ].join("\n");
  fs.writeFileSync(file, htmlPage("Image ratio", program, CDN_RUNTIME_URL));
  for (const viewport of VIEWPORTS) {
    const { context, frame, problems } = await openReview(file, viewport);
    try {
      await frame.waitForFunction(() =>
        Array.from(document.querySelectorAll("img")).every((i) => i.complete && i.naturalWidth > 0),
      );
      for (const name of ["wide", "tall", "left", "right"]) {
        const box = await frame.locator(`[data-oui-id="${name}"]`).evaluate((node) => {
          const img = node.querySelector("img") as HTMLImageElement;
          const r = img.getBoundingClientRect();
          const card = (node.closest(".openui-card-card") as HTMLElement).getBoundingClientRect();
          // The statement wrapper is display: contents; its first child is the block the Image takes up.
          const block = (node.firstElementChild as HTMLElement).getBoundingClientRect();
          // Ratio from the content box: the 1px border would skew a short picture's ratio.
          return {
            w: r.width,
            h: r.height,
            ratio: img.clientWidth / img.clientHeight,
            right: r.right,
            natural: img.naturalWidth / img.naturalHeight,
            fit: getComputedStyle(img).objectFit,
            block: block.height,
            card: card.width,
            cardRight: card.right,
          };
        });
        const where = `${name} @ ${viewport.name}: ${JSON.stringify(box)}`;
        assert.ok(
          Math.abs(box.ratio / box.natural - 1) < 0.02,
          `${where}: box ratio matches the picture`,
        );
        assert.notEqual(box.fit, "cover", `${where}: never cropped`);
        assert.ok(Math.abs(box.block - box.h) < 1, `${where}: no band below the picture`);
        assert.ok(box.right <= box.cardRight, `${where}: stays inside its card`);
        if (name === "wide") assert.ok(box.w > box.card * 0.8, `${where}: takes the card width`);
        if (name === "tall")
          assert.ok(
            box.h <= viewport.height * 0.8 + 2,
            `${where}: no taller than the screen allows`,
          );
      }
      // An OptionCard thumbnail keeps the stock square tile, filled.
      const tile = await frame.locator('[data-oui-id="thumb"]').evaluate((node) => {
        const img = (node.querySelector("img") as HTMLImageElement).getBoundingClientRect();
        const box = (
          node.closest(".openui-option-card__top--image") as HTMLElement
        ).getBoundingClientRect();
        return { img: [img.width, img.height], tile: [box.width, box.height] };
      });
      assert.deepEqual(tile.img, tile.tile, `thumbnail @ ${viewport.name}: fills its tile`);
      assert.deepEqual(problems, [], "browser errors");
    } finally {
      await context.close();
    }
  }
});

test("the owner's page sends render errors to the agent once per revision, without a click", async (t) => {
  if (skipReason) return t.skip(skipReason);
  const file = path.join(WORK, "render-errors.html");
  fs.writeFileSync(
    file,
    htmlPage(
      "Render errors",
      'root = Stack([intro, broken])\nintro = TextContent("hello")\nbroken = NoSuchThing("x")',
      CDN_RUNTIME_URL,
    ),
  );
  const first = await openReview(file, VIEWPORTS[0]);
  try {
    const res = await api("/api/poll", { file, timeoutMs: 5000 });
    assert.equal(res.status, "feedback", JSON.stringify(res));
    const items = res.items.filter((x) => x.kind === "render-error");
    assert.ok(
      items.some((x) => x.statement === "broken"),
      JSON.stringify(res.items),
    );
    // Once the server confirms, the panel says so and drops "Queue fix".
    await first.page.waitForSelector(".issues-head:has-text('sent to the agent')");
    assert.equal(
      await first.page.locator(".issue .btn").count(),
      0,
      "no Queue fix button: it was sent already",
    );

    // A second tab on the same revision reports the same errors: the agent does not get them twice.
    const second = await openReview(file, VIEWPORTS[1]);
    try {
      await second.page.waitForTimeout(1000);
      const again = await api("/api/poll", { file, cursor: res.cursor, timeoutMs: 1500 });
      assert.equal(again.status, "timeout", JSON.stringify(again));
    } finally {
      await second.context.close();
    }
  } finally {
    await first.context.close();
  }
});

test("the changed button toggles a lasting highlight of the last turn's changes", async (t) => {
  if (skipReason) return t.skip(skipReason);
  const file = path.join(WORK, "toggle-changes.html");
  const write = (a: string, b: string) =>
    fs.writeFileSync(
      file,
      htmlPage(
        "Toggle",
        `root = Stack([a, b])\na = TextContent("${a}")\nb = TextContent("${b}")`,
        CDN_RUNTIME_URL,
      ),
    );
  write("one", "two");
  const { context, page, frame, problems } = await openReview(file, VIEWPORTS[0]);
  const btn = page.locator(".bar .changes");
  // Each mark must sit on the statement it names.
  const marked = () =>
    frame.evaluate(() =>
      Array.from(document.querySelectorAll(".austere-mark")).map((m) => {
        const r = m.getBoundingClientRect();
        const hit = document
          .elementsFromPoint(r.left + r.width / 2, r.top + r.height / 2)
          .find((e) => e.closest("[data-oui-id]"));
        return hit?.closest("[data-oui-id]")!.getAttribute("data-oui-id");
      }),
    );
  // Marks arrive over two postMessage hops: wait for the expected ids, then compare.
  const marksBecome = async (want: string[], what: string) => {
    const deadline = Date.now() + 5000;
    let got = await marked();
    while (JSON.stringify(got) !== JSON.stringify(want) && Date.now() < deadline) {
      await page.waitForTimeout(50);
      got = await marked();
    }
    assert.deepEqual(got, want, what);
  };
  try {
    write("one, edited", "two");
    await btn.waitFor({ state: "visible", timeout: 10_000 });
    assert.equal(await btn.getAttribute("aria-pressed"), "false");
    assert.deepEqual(await marked(), [], "off by default");

    await btn.click();
    assert.equal(await btn.getAttribute("aria-pressed"), "true");
    await marksBecome(["a"], "on marks the last turn's change");
    await page.waitForTimeout(3000); // outlasts a flash: the marks must not fade
    assert.deepEqual(await marked(), ["a"], "marks persist");

    // Reloading the frame keeps the toggle and puts the marks back.
    await frame.evaluate(() => ((window as FlaggedWindow).__beforeReload = true));
    await page.locator(".menu-btn").click();
    await page.locator('[data-cmd="reload"]').click();
    await frame.waitForFunction(
      () => !(window as FlaggedWindow).__beforeReload && document.querySelector("[data-oui-id]"),
      null,
      { timeout: 15_000 },
    );
    await marksBecome(["a"], "marks come back after a frame reload");

    // A new turn replaces the marks while the toggle stays on.
    write("one, edited", "two, edited");
    await frame.waitForSelector("text=two, edited");
    await marksBecome(["b"], "a new turn replaces the marks");
    assert.equal(await btn.getAttribute("aria-pressed"), "true");

    await btn.click();
    assert.equal(await btn.getAttribute("aria-pressed"), "false");
    await marksBecome([], "off clears the marks");
    assert.deepEqual(problems, [], "browser errors");
  } finally {
    await context.close();
  }
});

test("a lasting highlight stays inside a statement's own scroller and never widens the page", async (t) => {
  if (skipReason) return t.skip(skipReason);
  const file = path.join(WORK, "toggle-wide.html");
  const long = "x".repeat(400);
  // The diff shares a row, so no ancestor's edge lines up with its own.
  const write = (line: string) =>
    fs.writeFileSync(
      file,
      htmlPage(
        "Wide",
        `root = Stack([patch, side], "row")\nside = TextContent("notes")\npatch = Diff("diff --git a/a.js b/a.js\n--- a/a.js\n+++ b/a.js\n@@ -1 +1 @@\n-const a = 1;\n+${line}")`,
        CDN_RUNTIME_URL,
      ),
    );
  write("const a = 2;");
  const { context, page, frame, problems } = await openReview(file, VIEWPORTS[0]);
  try {
    write(`const a = '${long}';`);
    const btn = page.locator(".bar .changes");
    await btn.waitFor({ state: "visible", timeout: 10_000 });
    await btn.click();
    const check = async (when: string) => {
      await frame.waitForSelector(".austere-mark");
      await page.waitForTimeout(200); // let the redraw after layout land
      const geo = await frame.evaluate(() => ({
        mark: (document.querySelector(".austere-mark") as Element).getBoundingClientRect().right,
        diff: (document.querySelector(".austere-diff") as Element).getBoundingClientRect().right,
        overflow: document.documentElement.scrollWidth - window.innerWidth,
      }));
      // The mark pads the statement's box by 4px.
      assert.ok(
        geo.mark <= geo.diff + 4.5,
        `${when}: mark ends at ${geo.mark}px, past the diff's own edge at ${geo.diff}px`,
      );
      assert.ok(geo.overflow <= 1, `${when}: page scrolls sideways by ${geo.overflow}px`);
    };
    await check("live update");
    // A fresh render lays the long line out differently: measure the restored mark too.
    await frame.evaluate(() => ((window as FlaggedWindow).__beforeReload = true));
    await page.locator(".menu-btn").click();
    await page.locator('[data-cmd="reload"]').click();
    await frame.waitForFunction(
      () => !(window as FlaggedWindow).__beforeReload && document.querySelector(".austere-diff"),
      null,
      { timeout: 15_000 },
    );
    await check("after reload");
    assert.deepEqual(problems, [], "browser errors");
  } finally {
    await context.close();
  }
});

test("the owner's menu copies an agent prompt that polls this file", async (t) => {
  if (skipReason) return t.skip(skipReason);
  const file = path.join(WORK, "agent-prompt.html");
  fs.writeFileSync(file, htmlPage("Prompt", `root = TextContent("hello")`, CDN_RUNTIME_URL));
  const { context, page, problems } = await openReview(file, VIEWPORTS[0]);
  try {
    await context.grantPermissions(["clipboard-read", "clipboard-write"], {
      origin: `http://127.0.0.1:${port}`,
    });
    await page.locator(".menu-btn").click();
    await page.locator('[data-cmd="copy-agent-prompt"]').click();
    await page.waitForSelector(".banner:not([hidden])");
    const copied = await page.evaluate(() => navigator.clipboard.readText());
    assert.ok(copied.includes(`File: ${file}`) && /Run `austere-axi poll/.test(copied), copied);
    assert.match(await page.locator(".banner").innerText(), /Agent prompt copied/);
    assert.deepEqual(problems, [], "browser errors");
  } finally {
    await context.close();
  }
});

test("the copy items work where navigator.clipboard is missing (a review page opened at an http tailnet address)", async (t) => {
  if (skipReason) return t.skip(skipReason);
  const file = path.join(WORK, "copy-insecure.html");
  fs.writeFileSync(file, htmlPage("Copy", `root = TextContent("hello")`, CDN_RUNTIME_URL));
  const { session } = await api("/api/open", { file });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  // Outside a secure context the browser has no navigator.clipboard at all.
  await context.addInitScript(() =>
    Object.defineProperty(Navigator.prototype, "clipboard", { value: undefined }),
  );
  const page = await context.newPage();
  try {
    const { code } = await api("/api/login", {});
    await page.goto(`http://127.0.0.1:${port}/s/${session.id}?login=${code}`);
    await page.waitForSelector("iframe.frame");
    assert.equal(await page.evaluate(() => typeof navigator.clipboard), "undefined");
    const pasted = async () => {
      await page.evaluate(() => {
        const ta = document.createElement("textarea");
        ta.id = "paste-here";
        document.body.append(ta);
        ta.focus();
      });
      await page.keyboard.press("Control+V");
      const v = await page.inputValue("#paste-here");
      await page.evaluate(() => document.getElementById("paste-here")?.remove());
      return v;
    };
    for (const [cmd, expect] of [
      ["copy-agent-prompt", `File: ${file}`],
      ["copy-path", fs.realpathSync(file)],
    ] as const) {
      await page.locator(".menu-btn").click();
      await page.locator(`[data-cmd="${cmd}"]`).click();
      await page.waitForSelector(".banner:not([hidden])");
      assert.ok((await pasted()).includes(expect), `${cmd} reaches the clipboard`);
    }
  } finally {
    await context.close();
  }
});
