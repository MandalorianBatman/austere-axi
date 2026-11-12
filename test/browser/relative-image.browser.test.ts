// Opt-in browser test (npm run test:browser; needs Chrome or CHROME_PATH): an Image whose src is a
// path next to the artifact loads in the sandboxed review frame, for the owner and for an invited
// reviewer, and in an exported page opened from another folder.
import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import net, { type AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import type { Browser, Frame } from "playwright-core";
import { launchBrowser } from "../../scripts/lib/browser.ts";
import { ownerKey } from "../../src/cli/invites.ts";

const STATE = fs.mkdtempSync(path.join(os.tmpdir(), "austere-image-state-"));
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), "austere-image-work-"));
const ELSEWHERE = fs.mkdtempSync(path.join(os.tmpdir(), "austere-image-elsewhere-"));
const FILE = path.join(WORK, "story.html");
const KEY = ownerKey(STATE);
const NAMES = ["fossil", "strata"];
let port: number;
let server: ChildProcess;
let browser: Browser;
let skipReason: string | undefined;

interface ApiReply {
  session: { id: string };
  link: string;
}

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
    const r = http.request({ host: "127.0.0.1", port, method: "POST", path: route, headers: { "content-type": "application/json", "x-austere-key": KEY } }, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => resolve(JSON.parse(data) as ApiReply));
    });
    r.on("error", reject);
    r.end(JSON.stringify(body));
  });
}

const svg = (fill: string) => `<svg xmlns="http://www.w3.org/2000/svg" width="40" height="30"><rect width="40" height="30" fill="${fill}"/></svg>`;

/** Every Image in `frame` has decoded: not the broken-image state. */
async function imageWidths(frame: Frame): Promise<number[]> {
  await frame.waitForSelector("img");
  await frame.waitForFunction(() => [...document.images].every((i) => i.complete), null, { timeout: 5000 });
  return frame.evaluate(() => [...document.images].map((i) => i.naturalWidth));
}

before(async () => {
  for (const f of ["austere.js", "chrome/chrome.js", "cli.mjs"]) {
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
  NAMES.forEach((n, i) => fs.writeFileSync(path.join(WORK, `${n}.svg`), svg(["#c33", "#33c"][i])));
  fs.writeFileSync(
    FILE,
    `<!doctype html><html><head><title>Story</title><script src="https://cdn.jsdelivr.net/npm/austere-axi@0/dist/austere.js"></script></head>
<body><script type="text/openui">
root = Stack([a, b])
a = Image("A red square", "fossil.svg")
b = Image("A blue square", "strata.svg")
</script></body></html>`,
  );
  port = await freePort();
  server = spawn(process.execPath, ["src/cli/main.ts", "server", "--port", String(port)], {
    env: { ...process.env, AUSTERE_AXI_STATE_DIR: STATE, AUSTERE_AXI_NO_TAILSCALE: "1", AUSTERE_AXI_LINK_HOST: "127.0.0.1", OPENUI_TELEMETRY_DISABLED: "1" },
    stdio: "ignore",
  });
  for (let i = 0; i < 100; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/api/health`);
      if (r.ok) return;
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
  for (const d of [STATE, WORK, ELSEWHERE]) fs.rmSync(d, { recursive: true, force: true });
});

test("relative images load in the review frame for the owner and for an invited reviewer", async (t) => {
  if (skipReason) return t.skip(skipReason);
  const { session } = await api("/api/open", { file: FILE });
  const invite = await api("/api/share", { file: FILE, name: "Ana" });
  const ownerCtx = await browser.newContext();
  const guestCtx = await browser.newContext();
  try {
    const owner = await ownerCtx.newPage();
    await owner.goto(`http://127.0.0.1:${port}/s/${session.id}?key=${KEY}`);
    const ownerFrame = (await (await owner.waitForSelector("iframe.frame")).contentFrame()) as Frame;
    assert.deepEqual(await imageWidths(ownerFrame), [40, 40], "owner");

    const guest = await guestCtx.newPage();
    await guest.goto(invite.link);
    await guest.click("form[action$='/join'] button");
    const guestFrame = (await (await guest.waitForSelector("iframe.frame")).contentFrame()) as Frame;
    assert.deepEqual(await imageWidths(guestFrame), [40, 40], "reviewer");
  } finally {
    await ownerCtx.close();
    await guestCtx.close();
  }
});

test("an exported page shows its images when opened from another folder", async (t) => {
  if (skipReason) return t.skip(skipReason);
  const out = path.join(ELSEWHERE, "story.export.html");
  const r = spawnSync(process.execPath, ["src/cli/main.ts", "export", FILE, "--out", out], { env: { ...process.env, AUSTERE_AXI_STATE_DIR: STATE }, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  assert.doesNotMatch(r.stdout, /notices/, "nothing was left out");
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    await page.goto(`file://${out}`);
    assert.deepEqual(await imageWidths(page.mainFrame()), [40, 40]);
  } finally {
    await context.close();
  }
});
