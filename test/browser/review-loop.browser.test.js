// Opt-in browser suite (npm run test:browser; needs Chrome or CHROME_PATH).
// Drives the real review loop: server + chrome page + artifact iframe.
//   - every custom component example, stress example and examples/*.html page renders at
//     desktop and phone width with no errors, no render issues, no sideways scroll
//   - clicking a component's parts in Annotate mode, then Send, makes `poll`
//     return each one addressed to the right statement with detail.part
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { launchBrowser } from "../../scripts/lib/browser.mjs";
import { CDN_RUNTIME_URL } from "../../src/cli/artifact.js";
import { ROOT, examplePage, htmlPage, loadLibrary } from "../../scripts/lib/plugins.mjs";

const VIEWPORTS = [
  { name: "desktop", width: 1280, height: 900 },
  { name: "phone", width: 390, height: 844 },
];
const MAX_PARTS_PER_STATEMENT = 3;

let port;
let server;
let browser;
let skipReason;
let lib;
const STATE = fs.mkdtempSync(path.join(os.tmpdir(), "austere-browser-state-"));
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), "austere-browser-work-"));

function freePort() {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, "127.0.0.1", () => {
      const p = s.address().port;
      s.close(() => resolve(p));
    });
  });
}

function api(route, body) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const r = http.request(
      { host: "127.0.0.1", port, method: "POST", path: route, headers: { "content-type": "application/json" } },
      (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => resolve(JSON.parse(data)));
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

async function openReview(file, viewport) {
  const { session } = await api("/api/open", { file });
  const context = await browser.newContext({ viewport: { width: viewport.width, height: viewport.height } });
  const page = await context.newPage();
  const problems = [];
  page.on("pageerror", (e) => problems.push(`pageerror: ${e.message}`));
  page.on("console", (m) => {
    if (m.type() === "error") problems.push(`console error: ${m.text()}`);
  });
  await page.goto(`http://127.0.0.1:${port}/s/${session.id}`);
  const frameEl = await page.waitForSelector("iframe.frame");
  const frame = await frameEl.contentFrame();
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
  server = spawn(process.execPath, [path.join(ROOT, "src/cli/main.js"), "server", "--port", String(port)], {
    env: { ...process.env, AUSTERE_AXI_STATE_DIR: STATE, AUSTERE_AXI_NO_TAILSCALE: "1", OPENUI_TELEMETRY_DISABLED: "1" },
    stdio: "ignore",
  });
  for (let i = 0; i < 100; i++) {
    try {
      await new Promise((resolve, reject) => {
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
            renderErrors: Array.from(document.querySelectorAll(".austere-render-error")).map((e) => e.textContent.trim()),
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
      const by = new Map();
      for (const el of document.querySelectorAll("[data-austere-part]")) {
        const id = el.closest("[data-oui-id]")?.getAttribute("data-oui-id");
        if (!id) continue;
        if (!by.has(id)) by.set(id, []);
        const v = el.getAttribute("data-austere-part");
        if (!by.get(id).includes(v)) by.get(id).push(v);
      }
      const out = [];
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
        const first = program.match(/^\s*([A-Za-z_]\w*)\s*=/m)[1];
        if (!withParts.has(first)) t.diagnostic(`${c.name} (${first}) has no data-austere-part targets`);
      }
    }
    assert.ok(targets.length > 0, "no data-austere-part targets found");

    for (const { id, part } of targets) {
      const loc = frame.locator(`[data-oui-id="${id}"] [data-austere-part="${part.replace(/"/g, '\\"')}"]`).first();
      // An SVG stroke (a diagram edge) is not hit at its bounding-box centre:
      // find a point on the stroke that nothing covers, and click exactly there.
      const point = await loc.evaluate((el) => {
        if (typeof el.getTotalLength !== "function") return null;
        el.scrollIntoView({ block: "center", inline: "center" });
        const len = el.getTotalLength();
        for (const t of [0.5, 0.3, 0.7, 0.2, 0.8, 0.12, 0.88]) {
          const q = el.getPointAtLength(len * t);
          const p = new DOMPoint(q.x, q.y).matrixTransform(el.getScreenCTM());
          if (el.ownerDocument.elementFromPoint(p.x, p.y) === el) return { x: p.x, y: p.y };
        }
        return null;
      });
      if (point) {
        const origin = await (await frame.frameElement()).evaluate((f) => {
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
  const cli = (...args) => {
    const r = spawnSync(process.execPath, [path.join(ROOT, "src/cli/main.js"), ...args], {
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
    assert.match(await page.locator(".notice").textContent(), /Third-party pack code runs in this page: check queued items before you send \(austere-pack-milestones@0\.1\.0\)/);
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
