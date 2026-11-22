// Push delivery (RLM-447): the server's wake-poll and wake-ack routes, and the omp extension's
// client against a real server with a fake harness (idle or busy, and what it was sent).
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { WakeClient } from "../src/harness/omp.ts";
import type { HostApi, HostContext } from "../src/harness/omp.ts";
import { ownerHeaders } from "./owner.ts";
import { freePort } from "./port.ts";

const PORT = await freePort();
const STATE = fs.mkdtempSync(path.join(os.tmpdir(), "austere-wake-state-"));
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), "austere-wake-work-"));
const OWNER = ownerHeaders(STATE);
const ENV = { AUSTERE_AXI_STATE_DIR: STATE, AUSTERE_AXI_PORT: String(PORT) };
let server: ChildProcess | undefined;

interface Answer {
  status: string;
  claim?: string;
  prompt?: string;
  pages?: { file: string; notes: number; cursor: number }[];
  delivered?: number;
  name?: string;
  session?: { id: string };
  entries?: { status: string }[];
}

function req(route: string, body: unknown, headers: Record<string, string> = {}): Promise<Answer> {
  const { promise, resolve, reject } = Promise.withResolvers<Answer>();
  const r = http.request(
    {
      host: "127.0.0.1",
      port: PORT,
      method: "POST",
      path: route,
      headers: { "content-type": "application/json", ...OWNER, ...headers },
    },
    (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => resolve(JSON.parse(data) as Answer));
    },
  );
  r.on("error", reject);
  r.end(JSON.stringify(body));
  return promise;
}

const wakePoll = (id: string, client: string, timeoutMs = 0) =>
  req(`/api/sessions/omp:${id}/wake-poll`, { client, timeoutMs });
const wakeAck = (id: string, client: string, claim: string, outcome: string) =>
  req(`/api/sessions/omp:${id}/wake-ack`, { client, claim, outcome });

function page(name: string): string {
  const file = path.join(WORK, name);
  fs.writeFileSync(
    file,
    `<!doctype html><html><head><title>Plan</title></head><body><script type="text/openui">
root = Stack([intro])
intro = TextContent("hello")
</script></body></html>`,
  );
  return file;
}

/** `open` from an omp session: the session becomes the page's author. */
async function openAs(file: string, sessionId: string): Promise<string> {
  const r = await req("/api/open", { file, session: { harness: "omp", sessionId } });
  return r.session?.id ?? "";
}

/** The owner presses Send on the review page. */
const send = (id: string, text: string) =>
  req(
    `/s/${id}/send`,
    { items: [{ kind: "message", text }] },
    { host: `127.0.0.1:${PORT}`, origin: `http://127.0.0.1:${PORT}` },
  );

async function until(what: string, ok: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!ok()) {
    if (Date.now() > deadline) assert.fail(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

before(async () => {
  server = spawn(process.execPath, ["src/cli/main.ts", "server", "--port", String(PORT)], {
    env: {
      ...process.env,
      AUSTERE_AXI_STATE_DIR: STATE,
      AUSTERE_AXI_NO_TAILSCALE: "1",
      OPENUI_TELEMETRY_DISABLED: "1",
    },
    stdio: "ignore",
  });
  for (let i = 0; i < 200; i++) {
    try {
      if ((await req("/api/health", {})).name === "austere-axi") return;
    } catch {}
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error("server did not start");
});

after(async () => {
  if (server && server.exitCode === null) {
    const child = server;
    const exited = new Promise((r) => child.once("exit", r));
    child.kill();
    await exited;
  }
  fs.rmSync(STATE, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  fs.rmSync(WORK, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
});

test("a session with no page role gets no_role at once", async () => {
  assert.equal((await wakePoll("no-page-session", "client-aaaa", 30_000)).status, "no_role");
});

test("the owner's note wakes one waiting client of the author session, once, with a pointer only", async () => {
  const file = page("plan.html");
  const id = await openAs(file, "author-1");
  assert.equal((await wakePoll("author-1", "client-aaaa")).status, "idle");

  // Two processes on one session wait; only one gets the claim.
  const a = wakePoll("author-1", "client-aaaa", 20_000);
  const b = wakePoll("author-1", "client-bbbb", 2_000);
  await new Promise((r) => setTimeout(r, 100));
  await send(id, "SECRET-NOTE-TEXT make it louder");
  const got = await a;
  assert.equal(got.status, "wake");
  assert.deepEqual(got.pages, [{ file, notes: 1, cursor: got.pages?.[0].cursor }]);
  assert.match(got.prompt ?? "", /austere-axi feedback/);
  assert.doesNotMatch(got.prompt ?? "", /SECRET-NOTE-TEXT/, "the prompt never carries note text");
  assert.equal((await b).status, "timeout", "the claim holds the page for one client");

  // Another session's ack changes nothing; the right one marks the note delivered.
  assert.equal((await wakeAck("other", "client-aaaa", got.claim ?? "", "delivered")).delivered, 0);
  assert.equal(
    (await wakeAck("author-1", "client-aaaa", got.claim ?? "", "delivered")).delivered,
    1,
  );
  assert.equal((await wakePoll("author-1", "client-bbbb")).status, "idle", "never twice");
});

test("a busy session releases its claim, and the note waits for the next idle poll", async () => {
  const file = page("busy.html");
  const id = await openAs(file, "author-2");
  await send(id, "one");
  const first = await wakePoll("author-2", "client-aaaa");
  assert.equal(first.status, "wake");
  assert.equal((await wakePoll("author-2", "client-bbbb")).status, "idle", "claimed");
  await wakeAck("author-2", "client-aaaa", first.claim ?? "", "released");
  const again = await wakePoll("author-2", "client-bbbb");
  assert.equal(again.status, "wake");
  await wakeAck("author-2", "client-bbbb", again.claim ?? "", "delivered");
});

test("a page an agent polls is the poll's: no wake", async () => {
  const file = page("polled.html");
  const id = await openAs(file, "author-3");
  const poll = req("/api/poll", { file, timeoutMs: 5_000 });
  await new Promise((r) => setTimeout(r, 100));
  await send(id, "for the poll");
  assert.equal((await poll).status, "feedback");
  assert.equal((await wakePoll("author-3", "client-aaaa")).status, "idle");
});

/** A fake omp session: idle or busy, and the turns the extension started. */
function fakeHarness(sessionId: string) {
  const sent: string[] = [];
  const host = { busy: false };
  const ctx: HostContext = {
    isIdle: () => !host.busy,
    hasPendingMessages: () => false,
    sessionManager: { getSessionId: () => sessionId },
  };
  const api: HostApi = { on: () => {}, sendUserMessage: (t) => sent.push(t) };
  return { sent, host, ctx, client: new WakeClient(api, ENV) };
}

test("the omp extension stays inert without a role, and wakes its idle session once a page has it", async () => {
  const h = fakeHarness("ext-1");
  await h.client.check(h.ctx);
  assert.equal(h.client.active, false, "no role: inert after one check");

  const file = page("ext.html");
  const id = await openAs(file, "ext-1");
  // A turn that ran austere-axi makes the next turn end check again.
  h.client.toolResult({ toolName: "bash", input: { command: `austere-axi ${file}` } });
  h.client.agentEnd(h.ctx);
  await until("the client to activate", () => h.client.active);

  try {
    // Busy: nothing is sent.
    h.host.busy = true;
    await send(id, "busy note");
    // Real time: the absence of a turn is the point, over more than two of the client's 1 s ticks.
    await new Promise((r) => setTimeout(r, 2500));
    assert.equal(h.sent.length, 0, "never folds into a running turn");
    // The turn ends: the note arrives within ~3 s, once.
    const idleAt = Date.now();
    h.host.busy = false;
    await until("the wake", () => h.sent.length > 0, 8_000);
    assert.ok(Date.now() - idleAt < 4000, `woken ${Date.now() - idleAt} ms after idle`);
    assert.match(h.sent[0], new RegExp(`austere-axi feedback ${file.replace(/[/.]/g, "\\$&")}`));
    // As above: a second turn would come within two ticks.
    await new Promise((r) => setTimeout(r, 2500));
    assert.equal(h.sent.length, 1, "delivered once");
    const fb = await req("/api/feedback", { file, peek: true });
    assert.equal(fb.entries?.[0].status, "open", "delivered, not yet read by the agent");
  } finally {
    h.client.stop();
  }
});
