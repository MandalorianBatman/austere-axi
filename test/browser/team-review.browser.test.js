// Opt-in browser test (npm run test:browser; needs Chrome or CHROME_PATH):
// a teammate opens an invite link and leaves a note; it is held in the owner's
// panel; the owner sends it on and the agent's poll returns it with the author.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { launchBrowser } from "../../scripts/lib/browser.mjs";

const STATE = fs.mkdtempSync(path.join(os.tmpdir(), "austere-team-browser-state-"));
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), "austere-team-browser-work-"));
const FILE = path.join(WORK, "plan.html");
let port;
let server;
let browser;
let skipReason;

function freePort() {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, "127.0.0.1", () => {
      const p = s.address().port;
      s.close(() => resolve(p));
    });
  });
}

function api(route, body, timeoutMs = 0) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const r = http.request({ host: "127.0.0.1", port, method: "POST", path: route, headers: { "content-type": "application/json" } }, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => resolve(JSON.parse(data)));
    });
    r.on("error", reject);
    if (timeoutMs) r.setTimeout(timeoutMs, () => r.destroy(new Error("timeout")));
    r.end(payload);
  });
}

before(async () => {
  for (const f of ["austere.js", "chrome/chrome.js"]) {
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
  fs.writeFileSync(
    FILE,
    `<!doctype html><html><head><title>Plan</title><script src="https://cdn.jsdelivr.net/npm/austere-axi@0/dist/austere.js"></script></head>
<body><script type="text/openui">
root = Stack([intro])
intro = TextContent("hello")
</script></body></html>`,
  );
  port = await freePort();
  server = spawn(process.execPath, ["src/cli/main.js", "server", "--port", String(port)], {
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
  fs.rmSync(STATE, { recursive: true, force: true });
  fs.rmSync(WORK, { recursive: true, force: true });
});

test("a teammate's note is held, then the owner sends it on", async (t) => {
  if (skipReason) return t.skip(skipReason);
  const { session } = await api("/api/open", { file: FILE });
  const invite = await api("/api/share", { file: FILE, name: "Ana" });
  assert.ok(invite.link, JSON.stringify(invite));

  const ownerCtx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const guestCtx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  try {
    const owner = await ownerCtx.newPage();
    await owner.goto(`http://127.0.0.1:${port}/s/${session.id}`);
    await owner.waitForSelector(".composer textarea");

    // The teammate follows the link; the token leaves the address bar.
    const guest = await guestCtx.newPage();
    await guest.goto(invite.link);
    await guest.waitForSelector(".composer textarea");
    assert.ok(!guest.url().includes("invite="), "token dropped from the URL");
    assert.equal(await guest.locator('[data-cmd="end"]').count(), 0, "no End review for a reviewer");
    assert.equal(await guest.locator(".send-end").count(), 0);

    await guest.fill(".composer textarea", "tighten the intro");
    await guest.click(".composer .send");
    await guest.waitForSelector(".msg.user.held");
    assert.match(await guest.locator(".msg.user .who").first().innerText(), /^You/);
    assert.match(await guest.locator(".receipt.held").innerText(), /Waiting for the owner/);

    // The owner sees it held, with the author, and the agent sees nothing.
    await owner.waitForSelector(".held-bar");
    assert.match(await owner.locator(".msg.user .who").first().innerText(), /^Ana/);
    const none = await api("/api/poll", { file: FILE, timeoutMs: 300 });
    assert.equal(none.status, "timeout");

    const polled = api("/api/poll", { file: FILE }, 15_000);
    await owner.click(".held-bar >> text=Send all");
    const got = await polled;
    assert.equal(got.status, "feedback");
    assert.equal(got.items[0].text, "tighten the intro");
    assert.equal(got.items[0].author, "Ana");

    // Held is gone from both panels.
    await owner.waitForSelector(".held-bar", { state: "detached" });
    await guest.waitForSelector(".msg.user.held", { state: "detached" });

    // Revoking closes the teammate's page.
    await api("/api/share/revoke", { key: "Ana" });
    await guest.waitForSelector(".banner:not([hidden])");
    assert.match(await guest.locator(".banner").innerText(), /revoked/);
  } finally {
    await ownerCtx.close();
    await guestCtx.close();
  }
});
