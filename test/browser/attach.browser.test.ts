// Opt-in browser test (npm run test:browser; needs Chrome or CHROME_PATH): the owner's Agent pill.
// A fake `omp` and `copilot` on the server's PATH stand in for the harnesses: they read
// the prompt on stdin and drive the real CLI (feedback, patch, reply), sleep, or fail, as a
// marker file beside them says.
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import type { Browser, Page } from "playwright-core";
import { launchBrowser } from "../../scripts/lib/browser.ts";
import { ownerKey } from "../../src/cli/invites.ts";
import { freePort } from "../port.ts";

const STATE = fs.realpathSync(
  fs.mkdtempSync(path.join(os.tmpdir(), "austere-attach-browser-state-")),
);
const WORK = fs.realpathSync(
  fs.mkdtempSync(path.join(os.tmpdir(), "austere-attach-browser-work-")),
);
const BIN = path.join(WORK, "bin");
const CTL = path.join(WORK, "ctl");
const PROJECT = path.join(WORK, "site");
const CLI = path.resolve("src/cli/main.ts");
const KEY = ownerKey(STATE);
const posixOnly = process.platform === "win32" && "the fake harnesses are POSIX shell scripts";
let port: number;
let server: ChildProcess;
let browser: Browser;
let skipReason: string | undefined;

/** Stands in for omp and copilot: `models` lists two; a run does what `<page>.mode` says (ok, sleep, exit1). */
const FAKE = `import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
const harness = path.basename(path.dirname(process.argv[1]));
const args = process.argv.slice(2);
if (args[0] === "models") {
  console.log(JSON.stringify({ models: [{ selector: "anthropic/claude-haiku-4-5", kind: "chat" }, { selector: "anthropic/claude-sonnet-4-5", kind: "chat" }] }));
  process.exit(0);
}
const prompt = fs.readFileSync(0, "utf8");
const file = /^Page file: (.+)$/m.exec(prompt)[1];
const cursor = /--cursor (\\d+)/.exec(prompt)[1];
const name = path.basename(file, ".html");
let mode = "ok";
try { mode = fs.readFileSync(path.join(process.env.FAKE_CTL, name + ".mode"), "utf8").trim(); } catch {}
const id = harness === "omp" ? crypto.randomUUID() : args[args.indexOf("--session-id") + 1];
if (harness === "omp") console.log(JSON.stringify({ type: "session", id }));
const cli = (input, ...a) => process.stdout.write(spawnSync(process.execPath, [process.env.FAKE_CLI, ...a], { input, encoding: "utf8" }).stdout);
if (mode === "exit1") { console.error("boom: failing on purpose"); process.exit(1); }
if (mode === "sleep") setInterval(() => {}, 1000);
else {
  cli("", "feedback", file);
  cli('intro = TextContent("patched by the agent")\\n', "patch", file);
  cli("", "reply", file, "--cursor", cursor, "--agent-reply", "Patched it.");
  if (harness === "copilot") console.log(JSON.stringify({ type: "result", sessionId: id, exitCode: 0 }));
}
`;

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

function writePage(name: string): string {
  const file = path.join(PROJECT, `${name}.html`);
  fs.writeFileSync(
    file,
    `<!doctype html><html><head><title>${name}</title><script src="https://cdn.jsdelivr.net/npm/austere-axi@0/dist/austere.js"></script></head>
<body><script type="text/openui">
root = Stack([intro, more])
intro = TextContent("hello")
more = TextContent("unchanged")
</script></body></html>`,
  );
  return file;
}

const fakeMode = (name: string, mode: string) =>
  fs.writeFileSync(path.join(CTL, `${name}.mode`), mode);

/** The page opened for review and the owner signed in, at desktop or phone width. */
async function ownerPage(
  file: string,
  width = 1280,
): Promise<{ page: Page; id: string; problems: string[]; close: () => Promise<void> }> {
  const { session } = await api<{ session: { id: string } }>("/api/open", { file });
  const context = await browser.newContext({
    viewport: { width, height: width > 500 ? 900 : 844 },
  });
  // A DOM method that hands back a value (some browsers do) must not break a component: React takes what an effect
  // returns for its cleanup. Made to return one here, so a one-line effect body that leaks it fails on any Chrome.
  await context.addInitScript(() => {
    Element.prototype.scrollIntoView = function () {
      return {} as unknown as undefined;
    };
    HTMLElement.prototype.focus = function () {
      return {} as unknown as undefined;
    };
  });
  const page = await context.newPage();
  const problems: string[] = [];
  page.on("pageerror", (e) => problems.push(`pageerror: ${e.stack ?? e.message}`));
  page.on("console", (m) => {
    if (m.type() === "error") problems.push(`console error: ${m.text()}`);
  });
  const { code } = await api<{ code: string }>("/api/login", {});
  await page.goto(`http://127.0.0.1:${port}/s/${session.id}?login=${code}`);
  await page.frameLocator(".frame").locator('[data-oui-id="intro"]').waitFor({ timeout: 15_000 });
  return { page, id: session.id, problems, close: () => context.close() };
}

/** Open the popover and press one of On / Off / Use project default; resolves once the server answered. */
async function setState(page: Page, state: "on" | "off" | "inherit") {
  if (await page.locator(".attach-pop").isHidden()) await page.click(".attach-pill");
  const answered = page.waitForResponse(
    (r) => r.url().endsWith("/attach") && r.request().method() === "POST",
  );
  await page.click(`[data-attach="${state}"]`);
  assert.equal((await answered).status(), 200);
}

async function send(page: Page, text: string) {
  await page.keyboard.press("Escape");
  await page.fill(".composer textarea", text);
  await page.click(".composer .send");
}

before(async () => {
  if (posixOnly) return;
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
  fs.mkdirSync(path.join(PROJECT, ".git"), { recursive: true });
  fs.mkdirSync(CTL);
  fs.mkdirSync(BIN);
  for (const harness of ["omp", "copilot"]) {
    const script = path.join(WORK, "fakes", harness, "fake.mjs");
    fs.mkdirSync(path.dirname(script), { recursive: true });
    fs.writeFileSync(script, FAKE);
    fs.writeFileSync(
      path.join(BIN, harness),
      `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`,
      { mode: 0o755 },
    );
  }
  // Fast runs; the owner granted omp the right to write.
  fs.writeFileSync(
    path.join(STATE, "attach.json"),
    JSON.stringify({ debounceMs: 200, recheckMs: 200, maxMinutes: 1 }),
  );
  fs.writeFileSync(
    path.join(STATE, "adapters.json"),
    JSON.stringify({ format: 1, extraArgs: { omp: ["--approval-mode", "yolo"] } }),
    { mode: 0o600 },
  );
  port = await freePort();
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: `${BIN}${path.delimiter}${process.env.PATH}`,
    AUSTERE_AXI_STATE_DIR: STATE,
    AUSTERE_AXI_PORT: String(port),
    AUSTERE_AXI_NO_TAILSCALE: "1",
    AUSTERE_AXI_LINK_HOST: "127.0.0.1",
    AUSTERE_AXI_CLOUD_URL: "http://127.0.0.1:9",
    OPENUI_TELEMETRY_DISABLED: "1",
    FAKE_CTL: CTL,
    FAKE_CLI: CLI,
  };
  // The test may itself run inside a harness: its session must not become a page's author.
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

test(
  "the owner turns the agent on from the pill; a note runs it: the page patches and flashes, the reply shows",
  { skip: posixOnly },
  async (t) => {
    if (skipReason) return t.skip(skipReason);
    const file = writePage("alpha");
    const { page, problems, close } = await ownerPage(file);
    try {
      const pill = page.locator(".attach-pill");
      assert.equal((await pill.innerText()).trim(), "Agent: Off");
      await setState(page, "on");
      await page.waitForSelector(".attach-pill.on");
      assert.match(await pill.innerText(), /Agent: omp · same/);
      // The model list comes from `omp models`; omp has the grant, so no warning.
      assert.equal(await page.locator("#attach-models option").count(), 2);
      assert.equal(await page.locator(".attach-grant").count(), 0);
      await page.fill(".attach-input", "anthropic/claude-haiku-4-5");
      await page.press(".attach-input", "Enter");
      await page.waitForFunction(() =>
        document.querySelector(".attach-pill")?.textContent?.includes("claude-haiku"),
      );

      await send(page, "make it shorter");
      await page.locator(".run-mark.start").waitFor({ timeout: 15_000 });
      await page
        .frameLocator(".frame")
        .locator(".austere-flash")
        .first()
        .waitFor({ state: "attached", timeout: 15_000 });
      await page.frameLocator(".frame").getByText("patched by the agent").waitFor();
      await page.locator(".msg.agent", { hasText: "Patched it." }).waitFor();
      await page.locator(".run-mark.done").waitFor();
      assert.ok(
        await page.locator(".run-state").isHidden(),
        "nothing to show beside the pill once the run is done",
      );
      assert.deepEqual(problems, []);
    } finally {
      await close();
    }
  },
);

test("Stop ends a running run and everything it started", { skip: posixOnly }, async (t) => {
  if (skipReason) return t.skip(skipReason);
  const file = writePage("bravo");
  fakeMode("bravo", "sleep");
  const { page, problems, close } = await ownerPage(file);
  try {
    await setState(page, "on");
    await send(page, "take your time");
    await page.locator(".run-state.running .run-elapsed").waitFor({ timeout: 15_000 });
    await page.click(".run-state .run-stop");
    await page.locator(".run-mark.stopped").waitFor({ timeout: 15_000 });
    assert.ok(await page.locator(".run-state").isHidden());
    assert.deepEqual(problems, []);
  } finally {
    await close();
  }
});

test(
  "a failed run shows its state with View log and Retry; Retry runs the notes again",
  { skip: posixOnly },
  async (t) => {
    if (skipReason) return t.skip(skipReason);
    const file = writePage("charlie");
    fakeMode("charlie", "exit1");
    const { page, problems, close } = await ownerPage(file);
    try {
      await setState(page, "on");
      await send(page, "this will fail");
      await page.locator(".run-state.failed").waitFor({ timeout: 15_000 });
      assert.match(
        await page.locator(".run-mark.failed").innerText(),
        /failed: The harness exited with 1/,
      );
      await page.click(".run-state .run-log");
      await page.locator(".attach-log", { hasText: "boom: failing on purpose" }).waitFor();

      fakeMode("charlie", "ok");
      await page.click(".attach-run .run-retry");
      try {
        await page.locator(".msg.agent", { hasText: "Patched it." }).waitFor({ timeout: 15_000 });
      } catch (err) {
        // Say what the page showed: a CI-only failure leaves nothing else to go on.
        const seen = await page
          .evaluate(() => ({
            html: document.documentElement.className,
            log: document.querySelector(".log")?.textContent?.slice(0, 600),
            run: document.querySelector(".run-state")?.textContent,
            popover: !!document.querySelector(".attach-pop"),
            body: document.body.children.length,
          }))
          .catch((e) => String(e));
        throw new Error(
          `${(err as Error).message}\npage: ${JSON.stringify(seen)}\nproblems: ${JSON.stringify(problems)}`,
        );
      }
      await page.locator(".run-mark.done").waitFor();
      assert.equal(await page.locator(".run-mark.start").count(), 2);
      assert.deepEqual(problems, []);
    } finally {
      await close();
    }
  },
);

test("a reviewer's link shows no pill and no run state", { skip: posixOnly }, async (t) => {
  if (skipReason) return t.skip(skipReason);
  const file = writePage("delta");
  await api("/api/open", { file });
  const invite = await api<{ link: string }>("/api/share", { file, name: "Ana" });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  try {
    const guest = await context.newPage();
    await guest.goto(invite.link);
    await guest.click("form[action$='/join'] button");
    await guest
      .frameLocator(".frame")
      .locator('[data-oui-id="intro"]')
      .waitFor({ timeout: 15_000 });
    assert.equal(await guest.locator(".attach, .attach-pill, .run-state").count(), 0);
    const r = await guest.evaluate(async () => (await fetch(`${location.pathname}/attach`)).status);
    assert.equal(r, 403);
  } finally {
    await context.close();
    await api("/api/share/revoke", { key: "Ana" });
  }
});

test("a Copilot page shows fork disabled with its reason", { skip: posixOnly }, async (t) => {
  if (skipReason) return t.skip(skipReason);
  const file = writePage("echo");
  const { page, problems, close } = await ownerPage(file);
  try {
    await setState(page, "off");
    const answered = page.waitForResponse(
      (r) => r.url().endsWith("/attach") && r.request().method() === "POST",
    );
    await page.click(".attach-select");
    await page.getByRole("option", { name: "copilot" }).click();
    assert.equal((await answered).status(), 200);
    const fork = page.locator('[role=radio][value="fork"]');
    assert.ok(await fork.isDisabled(), "fork is disabled");
    assert.match(
      // The reason is text beside the option now, not a hover title.
      await fork.locator("xpath=..").innerText(),
      /Copilot CLI has no fork/,
    );
    assert.match(await page.locator(".attach-reason").innerText(), /Fork: Copilot CLI has no fork/);
    assert.ok(await page.locator('[role=radio][value="same"]').isEnabled());
    // Copilot has no grant here: the popover names the command that gives it.
    assert.match(
      await page.locator(".attach-grant code").innerText(),
      /austere-axi adapter set copilot --extra-args "--allow-all"/,
    );
    assert.deepEqual(problems, []);
  } finally {
    await close();
  }
});

test(
  "at phone width the pill fits the header and the popover spans the screen",
  { skip: posixOnly },
  async (t) => {
    if (skipReason) return t.skip(skipReason);
    const file = writePage("foxtrot");
    const { page, problems, close } = await ownerPage(file, 390);
    try {
      await setState(page, "on");
      const pop = await page.locator(".attach-pop").boundingBox();
      assert.ok(
        pop && pop.x >= 0 && pop.x + pop.width <= 390 && pop.width >= 360,
        `popover ${JSON.stringify(pop)}`,
      );
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - window.innerWidth,
      );
      assert.ok(overflow <= 1, `the page scrolls sideways by ${overflow}px`);
      const bar = await page.locator(".bar").boundingBox();
      const pill = await page.locator(".attach-pill").boundingBox();
      assert.ok(
        bar &&
          pill &&
          pill.y >= bar.y &&
          pill.y + pill.height <= bar.y + bar.height &&
          pill.x + pill.width <= 390,
        `pill ${JSON.stringify(pill)} in bar ${JSON.stringify(bar)}`,
      );
      assert.equal((await page.locator(".attach-pill").innerText()).trim(), "Agent: On");
      assert.deepEqual(problems, []);
    } finally {
      await close();
    }
  },
);
