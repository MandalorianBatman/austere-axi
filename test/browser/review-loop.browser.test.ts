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
import { ROOT, examplePage, htmlPage, loadLibrary, type LoadedLibrary } from "../../scripts/lib/plugins.ts";

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
}

/** The fields these tests read from the server's JSON replies. */
interface ApiReply {
  session: { id: string };
  code: string;
  status: string;
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
      { host: "127.0.0.1", port, method: "POST", path: route, headers: { "content-type": "application/json", "x-austere-key": KEY } },
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
  fs.writeFileSync(gallery, htmlPage("Gallery", examplePage(lib.CUSTOM_COMPONENTS), CDN_RUNTIME_URL));
  const list = [{ name: "gallery", file: gallery }];
  if (lib.CUSTOM_COMPONENTS.some((c) => c.stress)) {
    const stress = path.join(WORK, "stress.html");
    fs.writeFileSync(stress, htmlPage("Stress", examplePage(lib.CUSTOM_COMPONENTS, "stress"), CDN_RUNTIME_URL));
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
  const context = await browser.newContext({ viewport: { width: viewport.width, height: viewport.height } });
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
  if (await frame.locator(".austere-mermaid").count()) {
    await frame.waitForSelector(".austere-mermaid-svg svg, .austere-render-error", { timeout: 15_000 });
  }
  await page.waitForTimeout(400);
  return { context, page, frame, problems, session };
}

before(async () => {
  lib = await loadLibrary();
  for (const f of ["austere.js", "mermaid.min.js", "packs/mermaid/pack.js", "chrome/chrome.js"]) {
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

describe("renders cleanly", () => {
  for (const viewport of VIEWPORTS) {
    test(`every page at ${viewport.name} (${viewport.width}px)`, async (t) => {
      if (skipReason) return t.skip(skipReason);
      for (const p of pages()) {
        const { context, page, frame, problems } = await openReview(p.file, viewport);
        try {
          const state = await frame.evaluate(() => ({
            overflow: document.documentElement.scrollWidth - window.innerWidth,
            renderErrors: Array.from(document.querySelectorAll(".austere-render-error")).map((e) => (e.textContent as string).trim()),
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
        const idx = [...new Set([0, Math.floor((parts.length - 1) / 2), parts.length - 1])].slice(0, max);
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
        if (!withParts.has(first)) t.diagnostic(`${c.name} (${first}) has no data-austere-part targets`);
      }
    }
    assert.ok(targets.length > 0, "no data-austere-part targets found");

    for (const { id, part } of targets) {
      const loc = frame.locator(`[data-oui-id="${id}"] [data-austere-part="${part.replace(/"/g, '\\"')}"]`).first();
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
        const origin = await (await frame.frameElement()).evaluate((f: HTMLIFrameElement) => {
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
      const hit = res.items.find((i) => i.kind === "annotation" && i.note === `check ${id}: ${part}`);
      assert.ok(hit, `part "${part}" in ${id} never reached poll`);
      assert.equal(hit.target, id, `part "${part}" was addressed to ${hit.target}, expected ${id}`);
      assert.equal(hit.detail?.part, part, `part "${part}" in ${id} arrived as ${JSON.stringify(hit.detail)}`);
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
    htmlPage("With a pack", 'root = Stack([c])\nc = Card([CardHeader("Launch"), launch])\nlaunch = Milestones(["Mon | Freeze | branch cut", "Fri | GA"])', CDN_RUNTIME_URL),
  );
  cli("check", "--fix", file);
  const { context, page, frame, problems } = await openReview(file, VIEWPORTS[1]);
  try {
    await frame.waitForSelector(".pack-milestones li", { timeout: 10_000 });
    assert.match((await page.locator(".notice").textContent()) as string, /Third-party pack code runs in this page: check queued items before you send \(austere-pack-milestones@0\.1\.0\)/);
    await frame.locator('[data-austere-part="GA"]').click();
    await frame.locator(".austere-pop textarea").fill("move GA");
    await frame.locator(".austere-pop textarea").press("Enter");
    await page.locator(".dock").click().catch(() => {});
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

test("after the agent ends the review the reviewer can still send; only closing locks the composer", async (t) => {
  if (skipReason) return t.skip(skipReason);
  const file = path.join(WORK, "after-end.html");
  fs.writeFileSync(file, htmlPage("After end", 'root = Stack([intro])\nintro = TextContent("hello")', CDN_RUNTIME_URL));
  const { context, page, problems } = await openReview(file, VIEWPORTS[0]);
  try {
    await api("/api/end", { file });
    await page.waitForSelector(".presence:has-text('Agent stopped')");
    assert.equal(await page.locator(".composer textarea").isDisabled(), false);
    await page.fill(".composer textarea", "one more thing");
    await page.click(".composer .send");
    await page.waitForSelector(".presence:has-text('1 waiting')");
    const res = await api("/api/poll", { file, timeoutMs: 5000 });
    assert.equal(res.status, "feedback");
    assert.equal(res.items[0].text, "one more thing");

    await api("/api/close", { file });
    await page.waitForSelector(".presence:has-text('Review closed')");
    assert.equal(await page.locator(".composer textarea").isDisabled(), true);
    assert.deepEqual(problems, [], "browser errors");
  } finally {
    await context.close();
  }
});

test("the owner's page sends render errors to the agent once per revision, without a click", async (t) => {
  if (skipReason) return t.skip(skipReason);
  const file = path.join(WORK, "render-errors.html");
  fs.writeFileSync(file, htmlPage("Render errors", 'root = Stack([intro, broken])\nintro = TextContent("hello")\nbroken = NoSuchThing("x")', CDN_RUNTIME_URL));
  const first = await openReview(file, VIEWPORTS[0]);
  try {
    const res = await api("/api/poll", { file, timeoutMs: 5000 });
    assert.equal(res.status, "feedback", JSON.stringify(res));
    const items = res.items.filter((x) => x.kind === "render-error");
    assert.ok(items.some((x) => x.statement === "broken"), JSON.stringify(res.items));
    // Once the server confirms, the panel says so and drops "Queue fix".
    await first.page.waitForSelector(".issues-head:has-text('sent to the agent')");
    assert.equal(await first.page.locator(".issue .btn").count(), 0, "no Queue fix button: it was sent already");

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
  const write = (a: string, b: string) => fs.writeFileSync(file, htmlPage("Toggle", `root = Stack([a, b])\na = TextContent("${a}")\nb = TextContent("${b}")`, CDN_RUNTIME_URL));
  write("one", "two");
  const { context, page, frame, problems } = await openReview(file, VIEWPORTS[0]);
  const btn = page.locator(".bar .changes");
  // Each mark must sit on the statement it names.
  const marked = () =>
    frame.evaluate(() =>
      Array.from(document.querySelectorAll(".austere-mark")).map((m) => {
        const r = m.getBoundingClientRect();
        const hit = document.elementsFromPoint(r.left + r.width / 2, r.top + r.height / 2).find((e) => e.closest("[data-oui-id]"));
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
    await frame.waitForFunction(() => !(window as FlaggedWindow).__beforeReload && document.querySelector("[data-oui-id]"), null, { timeout: 15_000 });
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
      htmlPage("Wide", `root = Stack([patch, side], "row")\nside = TextContent("notes")\npatch = Diff("diff --git a/a.js b/a.js\n--- a/a.js\n+++ b/a.js\n@@ -1 +1 @@\n-const a = 1;\n+${line}")`, CDN_RUNTIME_URL),
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
      assert.ok(geo.mark <= geo.diff + 4.5, `${when}: mark ends at ${geo.mark}px, past the diff's own edge at ${geo.diff}px`);
      assert.ok(geo.overflow <= 1, `${when}: page scrolls sideways by ${geo.overflow}px`);
    };
    await check("live update");
    // A fresh render lays the long line out differently: measure the restored mark too.
    await frame.evaluate(() => ((window as FlaggedWindow).__beforeReload = true));
    await page.locator(".menu-btn").click();
    await page.locator('[data-cmd="reload"]').click();
    await frame.waitForFunction(() => !(window as FlaggedWindow).__beforeReload && document.querySelector(".austere-diff"), null, { timeout: 15_000 });
    await check("after reload");
    assert.deepEqual(problems, [], "browser errors");
  } finally {
    await context.close();
  }
});
