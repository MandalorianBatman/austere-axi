// Opt-in browser test (npm run test:browser; needs Chrome or CHROME_PATH): a `patch` to one part of
// a diagram type outlines that part and nothing else in the diagram. The array types
// (PolarChart, Waterfall, Treemap, Sankey) have no part statements, so their patch outlines the chart.
import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import type { Browser } from "playwright-core";
import { launchBrowser } from "../../scripts/lib/browser.ts";
import { ROOT, examplePage, htmlPage, loadLibrary } from "../../scripts/lib/plugins.ts";
import { CDN_RUNTIME_URL } from "../../src/cli/artifact.ts";
import { ownerKey } from "../../src/cli/invites.ts";
import { splitStatements } from "../../src/shared/statements.ts";
import { freePort } from "../port.ts";

const STATE = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "austere-dgpatch-state-")));
const WORK = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "austere-dgpatch-work-")));
const CLI = path.join(ROOT, "src/cli/main.ts");
const KEY = ownerKey(STATE);
let port: number;
let server: ChildProcess;
let browser: Browser;
type DOMRectJSON = Pick<DOMRect, "left" | "right" | "top" | "bottom" | "width" | "height">;
type Outlines = { marks: DOMRectJSON[]; parts: DOMRectJSON[] };
let skipReason: string | undefined;
let env: NodeJS.ProcessEnv;

function api<T>(route: string, body: unknown): Promise<T> {
  const { promise, resolve, reject } = Promise.withResolvers<T>();
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
      res.on("end", () => resolve(JSON.parse(data) as T));
    },
  );
  r.on("error", reject);
  r.end(JSON.stringify(body));
  return promise;
}

before(async () => {
  for (const f of ["austere.js", "chrome/chrome.js"]) {
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
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(`http://127.0.0.1:${port}/api/health`)).ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 50));
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
  fs.rmSync(STATE, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  fs.rmSync(WORK, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
});

/**
 * The statement with its label changed: the first string, or the longest when the first is a short
 * id another statement names ("A", "T-1"). Never a keyword or a date.
 */
function edited(text: string): string {
  const literals = [...text.matchAll(/"((?:[^"\\]|\\.)*)"/g)];
  assert.ok(literals.length, `no string to change in: ${text}`);
  const longest = literals.reduce((a, b) => (b[1].length > a[1].length ? b : a));
  const label = literals[0][1].length > 4 ? literals[0] : longest;
  const at = (label.index ?? 0) + 1 + label[1].length;
  return `${text.slice(0, at)} PATCHED${text.slice(at)}`;
}

test(
  "a patch to one part of a diagram outlines that part only; the array types outline the chart",
  { timeout: 300_000 },
  async (t) => {
    if (skipReason) return t.skip(skipReason);
    const lib = await loadLibrary();
    const types = lib.CUSTOM_COMPONENTS.filter((c) => c.group === "Diagrams" && c.example?.length);
    assert.ok(types.length >= 30, `only ${types.length} diagram types have an example`);

    // One page holds the first example of every type; the examples already use distinct names.
    const program = examplePage(types);
    const file = path.join(WORK, "diagrams.html");
    fs.writeFileSync(file, htmlPage("Diagrams", program, CDN_RUNTIME_URL));
    const targets = types.map((c) => {
      const statements = splitStatements(c.example![0]);
      // The last statement is a part (a message, a card, a node); a lone statement is the whole chart.
      // Links carry a keyword, not a label.
      const parts = statements.filter((st) => !/^\w+ = (ClassLink|FlowLink)\(/.test(st.text));
      const target = parts[parts.length - 1];
      return { name: c.name, id: target.id, whole: statements.length === 1, text: target.text };
    });

    const { session } = await api<{ session: { id: string } }>("/api/open", { file });
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const page = await context.newPage();
    const problems: string[] = [];
    page.on("pageerror", (e) => problems.push(`pageerror: ${e.message}`));
    try {
      const { code } = await api<{ code: string }>("/api/login", {});
      await page.goto(`http://127.0.0.1:${port}/s/${session.id}?login=${code}`);
      const frame = page.frameLocator(".frame");
      await frame.locator(`[data-oui-id="${targets[0].id}"]`).first().waitFor({ timeout: 15_000 });

      const frameHandle = await (await page.$(".frame"))!.contentFrame();
      assert.ok(frameHandle);
      for (const [i, target] of targets.entries()) {
        const patched = edited(target.text);
        const r = spawnSync(process.execPath, [CLI, "patch", file], {
          env,
          input: `${patched}\n`,
          encoding: "utf8",
        });
        assert.equal(r.status, 0, `${target.name}: ${r.stdout}${r.stderr}`);
        await frameHandle.waitForFunction(
          (n) => (document.body.textContent?.split("PATCHED").length ?? 1) - 1 >= n,
          i + 1,
          { timeout: 15_000 },
        );
      }

      // The history lists revisions newest first and outlines what one of them changed.
      await page.click(".menu-btn");
      await page.click('[data-cmd="history"]');
      const rows = page.locator(".hist-pick");
      await rows.first().waitFor();
      await page.waitForFunction(
        (n) => document.querySelectorAll(".hist-pick").length === n,
        targets.length + 1,
        { timeout: 10_000 },
      );

      for (const [i, target] of targets.entries()) {
        await rows.nth(targets.length - i - 1).click();
        // Bring the part into view inside any scroller, then read the outline it is given.
        await frameHandle.evaluate((id) => {
          document
            .querySelector(`[data-oui-id="${CSS.escape(id)}"]`)
            ?.scrollIntoView({ block: "center", inline: "center" });
        }, target.id);
        // Every outline must sit on one of the patched statement's own elements (a Group draws a frame and a label).
        const seen: Outlines | null = await frameHandle
          .waitForFunction(
            (id) => {
              const marks = [...document.querySelectorAll(".austere-mark")].map((m) =>
                m.getBoundingClientRect().toJSON(),
              );
              const parts = [...document.querySelectorAll(`[data-oui-id="${CSS.escape(id)}"]`)].map(
                (el) => {
                  // A chart's statement can wrap its drawing in a box-less element: use what it holds.
                  const own = el.getBoundingClientRect();
                  if (own.width && own.height) return own.toJSON();
                  const range = document.createRange();
                  range.selectNodeContents(el);
                  return range.getBoundingClientRect().toJSON();
                },
              );
              if (!parts.length || !marks.length) return null;
              return { marks, parts };
            },
            target.id,
            { timeout: 10_000 },
          )
          .then((h) => h.jsonValue() as Promise<Outlines>)
          .catch(() => null);
        assert.ok(seen, `${target.name}: no outline on ${target.id}`);
        // An outline pads its statement by a few pixels: it may not reach further than that.
        const PAD = 12;
        const fits = (mark: DOMRectJSON, part: DOMRectJSON) =>
          mark.left >= part.left - PAD &&
          mark.right <= part.right + PAD &&
          mark.top >= part.top - PAD &&
          mark.bottom <= part.bottom + PAD &&
          mark.left <= part.left + part.width / 2 &&
          mark.right >= part.left + part.width / 2 &&
          mark.top <= part.top + part.height / 2 &&
          mark.bottom >= part.top + part.height / 2;
        for (const mark of seen.marks) {
          assert.ok(
            seen.parts.some((part) => fits(mark, part)),
            `${target.name}: the outline ${JSON.stringify(mark)} is not on ${target.id} (${JSON.stringify(seen.parts)})${target.whole ? ", a whole chart" : ""}`,
          );
        }
      }
      assert.deepEqual(problems, []);
    } finally {
      await context.close();
    }
  },
);
