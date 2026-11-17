// Agent presence on a page tells the truth over time (RLM-385): a poll that took the notes and
// then went quiet turns "working" into "stale" after STALE_WORKING_MS, and the owner's open page
// hears it without a request of its own. The server runs in a child process under a fake clock
// (node:test mock timers on Date and setTimeout), moved forward over IPC.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { after, before, test } from "node:test";
import { STALE_WORKING_MS } from "../src/cli/server.ts";
import { ownerHeaders } from "./owner.ts";
import { freePort } from "./port.ts";

const STATE = fs.mkdtempSync(path.join(os.tmpdir(), "austere-presence-state-"));
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), "austere-presence-work-"));
const FILE = path.join(WORK, "plan.html");
const OWNER = ownerHeaders(STATE);
let port = 0;
let child: ChildProcess;

const page = (text: string) => `<!doctype html><html><head><title>Plan</title><script src="https://cdn.jsdelivr.net/npm/austere-axi@0/dist/austere.js"></script></head>
<body><script type="text/openui">
root = Stack([intro])
intro = TextContent(${JSON.stringify(text)})
</script></body></html>`;

interface Body {
  session: { id: string };
  status: string;
  cursor: number;
  sessions: { id: string; presence: string }[];
}

interface Target {
  port: number;
  owner: Record<string, string>;
}

function request(method: string, route: string, body?: unknown, at: Target = { port, owner: OWNER }): Promise<Body> {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    // /api/* is the CLI's (no Origin); a page route takes the browser's own Origin.
    const origin: Record<string, string> = route.startsWith("/s/") ? { origin: `http://127.0.0.1:${at.port}` } : {};
    const r = http.request(
      { host: "127.0.0.1", port: at.port, method, path: route, headers: { "content-type": "application/json", ...origin, ...at.owner } },
      (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => resolve(JSON.parse(data) as Body));
      },
    );
    r.on("error", reject);
    r.end(payload);
  });
}

/** Moves the server's clock forward and runs the timers that fall due. */
function tick(ms: number): Promise<void> {
  return new Promise((resolve) => {
    child.once("message", () => resolve());
    child.send({ tick: ms });
  });
}

/** The owner's review page: its `presence` events as they come. */
function events(id: string) {
  const seen: { presence: string; since?: number }[] = [];
  const r = http.get({ host: "127.0.0.1", port, path: `/s/${id}/events`, headers: OWNER }, (res) => {
    let buf = "";
    res.setEncoding("utf8");
    res.on("data", (c: string) => {
      buf += c;
      let i;
      while ((i = buf.indexOf("\n\n")) >= 0) {
        const block = buf.slice(0, i);
        buf = buf.slice(i + 2);
        const name = /^event: (.*)$/m.exec(block)?.[1];
        const data = /^data: (.*)$/m.exec(block)?.[1];
        if (data && (name === "presence" || name === "snapshot")) seen.push(JSON.parse(data));
      }
    });
  });
  r.on("error", () => {});
  return { seen, last: () => seen[seen.length - 1]?.presence, close: () => r.destroy() };
}

async function until(what: string, ok: () => boolean | Promise<boolean>) {
  for (let i = 0; i < 100; i++) {
    if (await ok()) return;
    await new Promise((r) => setTimeout(r, 30));
  }
  assert.fail(`timed out waiting for ${what}`);
}

const presence = async (id: string, at?: Target) => (await request("GET", "/api/sessions", undefined, at)).sessions.find((s) => s.id === id)?.presence;

before(async () => {
  fs.writeFileSync(FILE, page("hello"));
  port = await freePort();
  const script = path.join(WORK, "fake-clock-server.mjs");
  const server = pathToFileURL(path.resolve("src/cli/server.ts")).href;
  fs.writeFileSync(
    script,
    `import { mock } from "node:test";
mock.timers.enable({ apis: ["Date", "setTimeout"], now: Date.now() });
process.on("message", (m) => { mock.timers.tick(m.tick); process.send("ticked"); });
// Imported after the clock is faked, so the server's module-level timers use it too.
const { runServer } = await import(${JSON.stringify(server)});
await runServer({ port: Number(process.env.TEST_PORT), unit: null });
`,
  );
  child = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", script], {
    env: { ...process.env, AUSTERE_AXI_STATE_DIR: STATE, TEST_PORT: String(port), AUSTERE_AXI_NO_TAILSCALE: "1", OPENUI_TELEMETRY_DISABLED: "1" },
    stdio: ["ignore", "ignore", "inherit", "ipc"],
  });
  await until("the server", async () => {
    try {
      return Boolean(await request("GET", "/api/health"));
    } catch {
      return false;
    }
  });
});

after(async () => {
  if (child && child.exitCode === null && child.signalCode === null) {
    const exited = new Promise((r) => child.once("exit", r));
    child.kill("SIGKILL");
    await exited;
  }
  for (const d of [STATE, WORK]) fs.rmSync(d, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
});

test("a poll that took the notes and went quiet reads stale after STALE_WORKING_MS; page changes and replies count as activity", async () => {
  const { id } = (await request("POST", "/api/open", { file: FILE })).session;
  const tab = events(id);
  try {
    await until("the snapshot", () => tab.seen.length > 0);
    assert.equal(tab.last(), "idle");

    await request("POST", `/s/${id}/send`, { items: [{ kind: "message", text: "tighten the intro" }] });
    const got = await request("POST", "/api/poll", { file: FILE });
    assert.equal(got.status, "feedback");
    // The poll that took them is gone: nothing listens, and the agent has the batch.
    await until("working", () => tab.last() === "working");
    assert.equal(await presence(id), "working");
    assert.equal(typeof tab.seen[tab.seen.length - 1].since, "number", "the page learns when the agent took the notes");

    await tick(STALE_WORKING_MS - 1000);
    assert.equal(await presence(id), "working", "not stale before the threshold");
    await tick(1000);
    assert.equal(await presence(id), "stale");
    await until("the page told without asking", () => tab.last() === "stale");

    // The agent patches the page: it is alive, so working again, and the threshold restarts.
    fs.writeFileSync(FILE, page("hello, tightened"));
    await until("the change seen", async () => {
      await tick(200);
      return (await presence(id)) === "working";
    });
    await until("the page told", () => tab.last() === "working");
    await tick(STALE_WORKING_MS - 1000);
    assert.equal(await presence(id), "working");
    await tick(1000);
    assert.equal(await presence(id), "stale");

    // A reply ends it.
    await request("POST", "/api/reply", { file: FILE, text: "done", cursor: got.cursor });
    assert.equal(await presence(id), "idle");
    await until("the page told", () => tab.last() === "idle");
  } finally {
    tab.close();
  }
});

test("a threshold past setTimeout's 32-bit limit is armed in steps: no overflow warning, no spinning timer", async () => {
  const state = fs.mkdtempSync(path.join(os.tmpdir(), "austere-presence-long-"));
  const at: Target = { port: await freePort(), owner: ownerHeaders(state) };
  let stderr = "";
  const server = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", path.resolve("src/cli/main.ts"), "server", "--port", String(at.port)], {
    env: { ...process.env, AUSTERE_AXI_STATE_DIR: state, AUSTERE_AXI_NO_TAILSCALE: "1", OPENUI_TELEMETRY_DISABLED: "1", AUSTERE_AXI_STALE_WORKING_MS: String(30 * 24 * 60 * 60_000) },
    stdio: ["ignore", "ignore", "pipe"],
  });
  server.stderr.setEncoding("utf8");
  server.stderr.on("data", (c: string) => (stderr += c));
  try {
    await until("the server", async () => {
      try {
        return Boolean(await request("GET", "/api/health", undefined, at));
      } catch {
        return false;
      }
    });
    const { id } = (await request("POST", "/api/open", { file: FILE }, at)).session;
    await request("POST", `/s/${id}/send`, { items: [{ kind: "message", text: "tighten the intro" }] }, at);
    assert.equal((await request("POST", "/api/poll", { file: FILE }, at)).status, "feedback");
    // A real clock on purpose: the fake one never overflows. Node turns a longer delay into 1 ms and warns; a callback that re-arms the same delay would do so in a loop.
    await new Promise((r) => setTimeout(r, 500));
    assert.doesNotMatch(stderr, /TimeoutOverflowWarning/);
    assert.equal(await presence(id, at), "working");
  } finally {
    const exited = new Promise((r) => server.once("exit", r));
    server.kill("SIGKILL");
    await exited;
    fs.rmSync(state, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  }
});
