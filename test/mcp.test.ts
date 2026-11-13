import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import type { ChildProcessByStdio } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import type { Readable, Writable } from "node:stream";
import { after, before, test } from "node:test";
import { ownerHeaders } from "./owner.ts";
import { freePort } from "./port.ts";

const PORT = await freePort();
const STATE = fs.mkdtempSync(path.join(os.tmpdir(), "austere-mcp-state-"));
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), "austere-mcp-work-"));
const GOOD = path.join(WORK, "plan.html");
const BAD = path.join(WORK, "broken.html");
const ENV = {
  ...process.env,
  AUSTERE_AXI_STATE_DIR: STATE,
  AUSTERE_AXI_PORT: String(PORT),
  AUSTERE_AXI_NO_TAILSCALE: "1",
  AUSTERE_AXI_NO_OPEN: "1",
  OPENUI_TELEMETRY_DISABLED: "1",
  // Nothing listens here: components search and show stay local, and no test reaches npmjs.
  AUSTERE_AXI_NPM_REGISTRY: `http://127.0.0.1:${await freePort()}/`,
};
const page = (program: string) => `<!doctype html><html><head><title>Plan</title><script src="https://cdn.jsdelivr.net/npm/austere-axi@0/dist/austere.js"></script></head>
<body><script type="text/openui">
${program}
</script></body></html>`;

interface ToolResult { isError: boolean; content: { type: string; text: string }[] }
interface RpcMessage {
  id?: number | null;
  result: {
    protocolVersion: string;
    serverInfo: { name: string };
    capabilities: { tools?: unknown };
    tools: { name: string; inputSchema: { type: string; properties: Record<string, { enum?: string[] }> } }[];
  } & ToolResult;
  error: { code: number; message: string };
}

let mcp: ChildProcessByStdio<Writable, Readable, null>;
let nextId = 1;
const waiting = new Map<number | null | undefined, (msg: RpcMessage) => void>();
/** Lines no pending request was waiting for. */
const unexpected: RpcMessage[] = [];

function rpc(method: string, params: Record<string, unknown>) {
  const id = nextId++;
  mcp.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  return new Promise<RpcMessage>((resolve) => waiting.set(id, resolve));
}

const call = (name: string, args: Record<string, unknown>) => rpc("tools/call", { name, arguments: args }).then((r): ToolResult => r.result);

function api(method: string, route: string, body?: unknown, headers: Record<string, string> = {}) {
  return new Promise<{ status: number | undefined; data: unknown }>((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const r = http.request({ host: "127.0.0.1", port: PORT, method, path: route, headers: { "content-type": "application/json", ...ownerHeaders(STATE), ...headers } }, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => resolve({ status: res.statusCode, data: data ? JSON.parse(data) : null }));
    });
    r.on("error", reject);
    if (payload) r.write(payload);
    r.end();
  });
}

before(() => {
  fs.writeFileSync(GOOD, page('root = Stack([intro])\nintro = TextContent("hello")'));
  fs.writeFileSync(BAD, page('root = Stack([intro, missing])\nintro = TextContent("hello")'));
  mcp = spawn(process.execPath, ["src/cli/main.ts", "mcp"], { env: ENV, stdio: ["pipe", "pipe", "inherit"] });
  readline.createInterface({ input: mcp.stdout }).on("line", (line) => {
    const msg = JSON.parse(line) as RpcMessage;
    if (!waiting.has(msg.id)) return unexpected.push(msg);
    waiting.get(msg.id)?.(msg);
    waiting.delete(msg.id);
  });
});

after(async () => {
  const exited = new Promise((r) => mcp.once("exit", r));
  mcp.stdin.end();
  await exited;
  await api("POST", "/api/shutdown", {}).catch(() => {});
  fs.rmSync(WORK, { recursive: true, force: true });
  // The server may still be flushing its state when it acknowledges shutdown.
  await new Promise((r) => setTimeout(r, 300));
  fs.rmSync(STATE, { recursive: true, force: true });
});

test("initializes and lists the review tools", async () => {
  const init = await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "0" } });
  assert.equal(init.result.protocolVersion, "2025-06-18");
  assert.equal(init.result.serverInfo.name, "austere-axi");
  assert.ok(init.result.capabilities.tools);
  mcp.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");

  const list = await rpc("tools/list", {});
  assert.deepEqual(
    list.result.tools.map((t) => t.name),
    ["spec", "check", "open", "poll", "reply", "patch", "end", "components"],
  );
  for (const t of list.result.tools) assert.equal(t.inputSchema.type, "object");
  const components = list.result.tools.find((t) => t.name === "components")!;
  assert.deepEqual(Object.keys(components.inputSchema.properties), ["command", "args"]);
  assert.doesNotMatch(JSON.stringify(components.inputSchema), /trust/i, "the MCP surface cannot pass --trust");
  assert.deepEqual(components.inputSchema.properties.command.enum, ["search", "show", "list", "add"]);

  const unknown = await rpc("tools/frobnicate", {});
  assert.equal(unknown.error.code, -32601);
});

test("answers no notification, rejects batches, and does not offer the batch protocol", async () => {
  for (const method of ["tools/list", "ping", "tools/frobnicate", "notifications/cancelled"]) mcp.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params: {} }) + "\n");
  await rpc("ping", {});
  assert.deepEqual(unexpected, []);

  const batch = new Promise<RpcMessage>((resolve) => waiting.set(null, resolve));
  mcp.stdin.write(JSON.stringify([{ jsonrpc: "2.0", id: nextId++, method: "ping" }]) + "\n");
  const rejected = await batch;
  assert.equal(rejected.error.code, -32600);

  const init = await rpc("initialize", { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "test", version: "0" } });
  assert.equal(init.result.protocolVersion, "2025-11-25");
});

test("check reports errors as a tool error and passes a valid page", async () => {
  const ok = await call("check", { file: GOOD });
  assert.equal(ok.isError, false);
  assert.match(ok.content[0].text, /^status: ok/m);

  const bad = await call("check", { file: BAD });
  assert.equal(bad.isError, true);
  assert.match(bad.content[0].text, /^status: errors/m);
  assert.match(bad.content[0].text, /missing/);

  const noFile = await call("check", {});
  assert.equal(noFile.isError, true);
  assert.match(noFile.content[0].text, /file is required/);
});

test("open, poll for feedback, reply through the poll, end", async () => {
  const open = await call("open", { file: GOOD, no_open: true });
  assert.equal(open.isError, false, open.content[0].text);
  assert.match(open.content[0].text, /^status: open/m);
  const id = /\/s\/(\w+)/.exec(open.content[0].text)?.[1];
  assert.ok(id, open.content[0].text);

  const empty = await call("poll", { file: GOOD, timeout_ms: 200 });
  assert.match(empty.content[0].text, /^status: timeout/m);

  const pollP = call("poll", { file: GOOD });
  // Feedback arrives while the poll listens.
  await new Promise((r) => setTimeout(r, 500));
  const sent = await api("POST", `/s/${id}/send`, { items: [{ kind: "annotation", target: "intro", component: "TextContent", note: "louder" }] }, { host: `127.0.0.1:${PORT}` });
  assert.equal(sent.status, 200);
  const poll = await pollP;
  assert.equal(poll.isError, false);
  assert.match(poll.content[0].text, /^status: feedback/m);
  assert.match(poll.content[0].text, /annotation: intro \(TextContent\)/);
  assert.match(poll.content[0].text, /note: louder/);

  const patched = await call("patch", { file: GOOD, statements: 'intro = TextContent("HELLO")' });
  assert.match(patched.content[0].text, /^status: patched/m);
  assert.match(fs.readFileSync(GOOD, "utf8"), /TextContent\("HELLO"\)/);

  const replied = await call("poll", { file: GOOD, agent_reply: "Made it louder.", timeout_ms: 200 });
  assert.match(replied.content[0].text, /^status: timeout/m);

  const ended = await call("end", { file: GOOD });
  assert.match(ended.content[0].text, /^status: ended/m);
});

test("components searches locally and refuses paths and untrusted packs", async () => {
  const found = await call("components", { command: "search", args: ["bar", "chart"] });
  assert.equal(found.isError, false, found.content[0].text);
  assert.match(found.content[0].text, /BarChart\(/);
  assert.match(found.content[0].text, /remote: .*unavailable/);

  const shown = await call("components", { command: "show", args: ["BarChart"] });
  assert.equal(shown.isError, false, shown.content[0].text);
  assert.match(shown.content[0].text, /BarChart\(/);

  for (const spec of ["./my-pack", "C:\\packs\\x", "pack.tgz", "foo@../bar", "--trust"]) {
    const refused = await call("components", { command: "add", args: [spec] });
    assert.equal(refused.isError, true, spec);
    assert.match(refused.content[0].text, /add takes an npm package name.*folders and \.tgz/, spec);
  }
  const smuggled = await call("components", { command: "add", args: ["austere-pack-orbit", "--trust"] });
  assert.match(smuggled.content[0].text, /add takes exactly one npm package name/);
  const trustCommand = await call("components", { command: "trust", args: ["add", "austere-pack-orbit"] });
  assert.match(trustCommand.content[0].text, /command must be one of/);

  const untrusted = await call("components", { command: "add", args: ["austere-pack-orbit"] });
  assert.equal(untrusted.isError, true);
  assert.match(untrusted.content[0].text, /status: needs --trust/);
  assert.match(untrusted.content[0].text, /austere-pack-orbit is a third-party pack/);
  assert.ok(!fs.existsSync(path.join(STATE, "packs.json")), "nothing installed");
});
