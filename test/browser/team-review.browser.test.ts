// Opt-in browser test (npm run test:browser; needs Chrome or CHROME_PATH):
// a teammate opens an invite link and leaves a note; it is held in the owner's
// panel; the owner sends it on and the agent's poll returns it with the author.
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import net, { type AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import type { Browser } from "playwright-core";
import { launchBrowser } from "../../scripts/lib/browser.ts";
import { ownerKey } from "../../src/cli/invites.ts";

const STATE = fs.mkdtempSync(path.join(os.tmpdir(), "austere-team-browser-state-"));
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), "austere-team-browser-work-"));
const FILE = path.join(WORK, "plan.html");
const KEY = ownerKey(STATE);
let port: number;
let server: ChildProcess;
let browser: Browser;
let skipReason: string | undefined;

/** The fields these tests read from the server's JSON replies. */
interface ApiReply {
  session: { id: string };
  link: string;
  status: string;
  code: string;
  items: { text: string; author?: string }[];
  /** /api/share/approve: the device the approval made. */
  device?: { name: string };
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

function api(route: string, body: unknown, timeoutMs = 0): Promise<ApiReply> {
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
  server = spawn(process.execPath, ["src/cli/main.ts", "server", "--port", String(port)], {
    env: {
      ...process.env,
      AUSTERE_AXI_STATE_DIR: STATE,
      AUSTERE_AXI_NO_TAILSCALE: "1",
      AUSTERE_AXI_LINK_HOST: "127.0.0.1",
      OPENUI_TELEMETRY_DISABLED: "1",
    },
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
    await owner.goto(`http://127.0.0.1:${port}/s/${session.id}?key=${KEY}`);
    await owner.waitForSelector(".composer textarea");

    // The teammate follows the link; the token leaves the address bar.
    const guest = await guestCtx.newPage();
    await guest.goto(invite.link);
    await guest.click("form[action$='/join'] button");
    await guest.waitForSelector(".composer textarea");
    assert.ok(!guest.url().includes("invite="), "token dropped from the URL");
    assert.equal(
      await guest.locator('[data-cmd="end"]').count(),
      0,
      "no End review for a reviewer",
    );
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

test("a teammate without a link asks from the page's address; the waiting page opens by itself once the owner approves; a second browser with the same name stays out", async (t) => {
  if (skipReason) return t.skip(skipReason);
  const { session } = await api("/api/open", { file: FILE });
  await api("/api/share/requests", { on: true });
  const guestCtx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const otherCtx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const waiting = async () => {
    const r = await fetch(`http://127.0.0.1:${port}/api/share/requests`, {
      headers: { "x-austere-key": KEY },
    });
    return ((await r.json()) as { waiting: { id: string; name: string }[] }).waiting;
  };
  try {
    const guest = await guestCtx.newPage();
    await guest.goto(`http://127.0.0.1:${port}/s/${session.id}`);
    assert.equal(await guest.title(), "Ask for access", "the page's title stays hidden");
    assert.doesNotMatch(await guest.content(), /hello|plan\.html/, "nothing of the page");
    await guest.fill("input[name=name]", "Fay");
    await guest.click("form[action$='/request'] button");
    await guest.waitForSelector("text=Waiting for the owner");

    const other = await otherCtx.newPage();
    await other.goto(`http://127.0.0.1:${port}/s/${session.id}`);
    await other.fill("input[name=name]", "Fay");
    await other.click("form[action$='/request'] button");
    await other.waitForSelector("text=Waiting for the owner");

    const asked = await waiting();
    assert.deepEqual(
      asked.map((r) => r.name),
      ["Fay", "Fay"],
    );
    const approved = await api("/api/share/approve", { id: asked[0].id });
    assert.equal(approved.device?.name, "Fay", JSON.stringify(approved));

    // The first browser's waiting page lets it in by itself.
    await guest.waitForSelector(".composer textarea", { timeout: 10_000 });
    assert.match(await guest.title(), /^Plan/);
    await guest.fill(".composer textarea", "asked, then let in");
    await guest.click(".composer .send");
    await guest.waitForSelector(".msg.user.held");

    // The second browser with the same name still waits; denied, its page says so by itself.
    await other.reload();
    await other.waitForSelector("text=Waiting for the owner");
    assert.equal(await other.locator(".composer textarea").count(), 0);
    await api("/api/share/deny", { id: asked[1].id });
    await other.waitForSelector("text=declined your last request");
  } finally {
    await guestCtx.close();
    await otherCtx.close();
    await api("/api/share/revoke", { key: "Fay" });
    await api("/api/share/requests", { on: false });
  }
});

test("Share from the page menu: copy the link, open it in a second browser, and the note arrives under that name, held", async (t) => {
  if (skipReason) return t.skip(skipReason);
  const { session } = await api("/api/open", { file: FILE });
  const ownerCtx = await browser.newContext({
    viewport: { width: 1280, height: 900 },
    permissions: ["clipboard-read", "clipboard-write"],
  });
  const guestCtx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const thirdCtx = await browser.newContext();
  try {
    const owner = await ownerCtx.newPage();
    await owner.goto(`http://127.0.0.1:${port}/s/${session.id}?key=${KEY}`);
    await owner.waitForSelector(".composer textarea");
    await owner.click(".menu-btn");
    await owner.click('[data-cmd="share"]');
    await owner.waitForSelector("dialog.share[open]");
    await owner.fill("dialog.share input[name=name]", "Cleo");
    await owner.click("dialog.share button[type=submit]");
    await owner.waitForSelector("dialog.share .share-link");
    await owner.click('dialog.share [data-share="copy"]');
    await owner.waitForSelector(".banner:has-text('Link copied.')");
    const link = await owner.evaluate(() => navigator.clipboard.readText());
    assert.match(link, new RegExp(`/s/${session.id}\\?invite=[A-Za-z0-9_-]{32,}$`));
    assert.equal(
      await owner.inputValue("dialog.share .share-link"),
      link,
      "the dialog shows the link it copied",
    );

    const guest = await guestCtx.newPage();
    await guest.goto(link);
    await guest.click("form[action$='/join'] button");
    await guest.waitForSelector(".composer textarea");
    await guest.fill(".composer textarea", "from the menu link");
    await guest.click(".composer .send");
    await guest.waitForSelector(".msg.user.held");

    await owner.click("dialog.share >> text=Done");
    await owner.waitForSelector(".held-bar");
    assert.match(await owner.locator(".msg.user.held .who").last().innerText(), /^Cleo/);

    // The link was claimed: a third browser is refused.
    const third = await (await thirdCtx.newPage()).goto(link);
    assert.equal(third?.status(), 403);
    await owner.click(".held-bar >> text=Discard all");

    // A second link claimed in the same browser adds a device; the first one keeps working.
    const second = path.join(path.dirname(FILE), "second.html");
    fs.writeFileSync(second, fs.readFileSync(FILE, "utf8"));
    const other = await api("/api/open", { file: second });
    const more = await api("/api/share", { file: second, name: "Cleo" });
    await guest.goto(more.link);
    await guest.click("form[action$='/join'] button");
    await guest.waitForSelector(".composer textarea");
    assert.equal(
      (await guestCtx.cookies()).filter((c) => c.name.startsWith("austere_rv_")).length,
      2,
      "one cookie per device",
    );
    for (const sid of [session.id, other.session.id]) {
      const res = await guest.goto(`http://127.0.0.1:${port}/s/${sid}`);
      assert.equal(res?.status(), 200, sid);
    }
  } finally {
    await ownerCtx.close();
    await guestCtx.close();
    await thirdCtx.close();
    await api("/api/share/revoke", { key: "Cleo" });
  }
});

test("a login code from the CLI signs the browser in as the owner, once", async (t) => {
  if (skipReason) return t.skip(skipReason);
  const { session } = await api("/api/open", { file: FILE });
  const { code } = await api("/api/login", {});
  const ctx = await browser.newContext();
  const other = await browser.newContext();
  try {
    const page = await ctx.newPage();
    await page.goto(`http://127.0.0.1:${port}/s/${session.id}?login=${code}`);
    await page.waitForURL(`http://127.0.0.1:${port}/s/${session.id}`);
    await page.waitForSelector(".composer textarea");
    const cookie = (await ctx.cookies()).find((c) => c.name === "austere_owner");
    assert.ok(
      cookie && cookie.value !== KEY,
      "the browser holds a cookie derived from the key, not the key",
    );
    const again = await (
      await other.newPage()
    ).goto(`http://127.0.0.1:${port}/s/${session.id}?login=${code}`);
    assert.equal(again?.status(), 403, "the code is used up");
  } finally {
    await ctx.close();
    await other.close();
  }
});

test("the owner's held view shows what the agent would receive, and a bad note cannot break the panel", async (t) => {
  if (skipReason) return t.skip(skipReason);
  const { session } = await api("/api/open", { file: FILE });
  const invite = await api("/api/share", { file: FILE, name: "Bo" });
  const ownerCtx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const guestCtx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  try {
    const guest = await guestCtx.newPage();
    await guest.goto(invite.link);
    await guest.click("form[action$='/join'] button");
    await guest.waitForSelector(".composer textarea");
    const send = (items: unknown[]) =>
      guest.evaluate(
        ({ id, items }: { id: string; items: unknown[] }) =>
          fetch(`/s/${id}/send`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ items }),
          }).then((r) => r.status),
        { id: session.id, items },
      );
    const long = "q".repeat(300) + " TAIL-PAST-CUT";
    assert.equal(
      await send([
        {
          kind: "annotation",
          target: "intro",
          component: "TextContent",
          path: ["root", "HiddenWithin", "intro"],
          selection: long,
          note: "n1",
        },
        {
          kind: "annotation",
          target: "intro",
          component: "TextContent",
          selection: { length: 999 },
          note: "POISON",
        },
        { kind: "message", text: "LATER-NOTE" },
      ]),
      200,
    );
    const owner = await ownerCtx.newPage();
    await owner.goto(`http://127.0.0.1:${port}/s/${session.id}?key=${KEY}`);
    await owner.waitForSelector(".held-bar");
    const text = await owner.locator(".msg.user.held").innerText();
    assert.match(text, /within HiddenWithin/, "the path the agent sees");
    assert.match(text, /TAIL-PAST-CUT/, "the whole quote, not the first 260 characters");
    assert.match(text, /LATER-NOTE/, "a malformed field did not stop later notes rendering");
    await owner.click(".held-bar >> text=Discard all");
    await owner.waitForSelector(".held-bar", { state: "detached" });
  } finally {
    await ownerCtx.close();
    await guestCtx.close();
    await api("/api/share/revoke", { key: "Bo" });
  }
});
