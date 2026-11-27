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
import { format } from "../src/cli/output.ts";
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
const page = (
  program: string,
) => `<!doctype html><html><head><title>Plan</title><script src="https://cdn.jsdelivr.net/npm/austere-axi@0/dist/austere.js"></script></head>
<body><script type="text/openui">
${program}
</script></body></html>`;

interface ToolResult {
  isError: boolean;
  content: { type: string; text: string }[];
}
interface RpcMessage {
  id?: number | null;
  result: {
    protocolVersion: string;
    serverInfo: { name: string };
    capabilities: { tools?: unknown };
    tools: {
      name: string;
      inputSchema: { type: string; properties: Record<string, { enum?: string[] }> };
    }[];
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

const call = (name: string, args: Record<string, unknown>) =>
  rpc("tools/call", { name, arguments: args }).then((r): ToolResult => r.result);

function api(method: string, route: string, body?: unknown, headers: Record<string, string> = {}) {
  return new Promise<{ status: number | undefined; data: unknown }>((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const r = http.request(
      {
        host: "127.0.0.1",
        port: PORT,
        method,
        path: route,
        headers: { "content-type": "application/json", ...ownerHeaders(STATE), ...headers },
      },
      (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () =>
          resolve({ status: res.statusCode, data: data ? JSON.parse(data) : null }),
        );
      },
    );
    r.on("error", reject);
    if (payload) r.write(payload);
    r.end();
  });
}

before(() => {
  fs.writeFileSync(GOOD, page('root = Stack([intro])\nintro = TextContent("hello")'));
  fs.writeFileSync(BAD, page('root = Stack([intro, missing])\nintro = TextContent("hello")'));
  // The server runs in WORK, as a client starts it in the user's project: a poll with no file or project covers WORK's pages.
  mcp = spawn(process.execPath, [path.resolve("src/cli/main.ts"), "mcp"], {
    cwd: WORK,
    env: ENV,
    stdio: ["pipe", "pipe", "inherit"],
  });
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
  // The server runs in WORK, and Windows refuses to remove a live process's working directory:
  // /api/shutdown answers before the server exits, `stop` returns once it has.
  const stop = spawn(process.execPath, [path.resolve("src/cli/main.ts"), "stop"], { env: ENV, stdio: "ignore" });
  await new Promise((r) => stop.once("exit", r));
  fs.rmSync(WORK, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  fs.rmSync(STATE, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
});

test("initializes and lists the review tools", async () => {
  const init = await rpc("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "test", version: "0" },
  });
  assert.equal(init.result.protocolVersion, "2025-06-18");
  assert.equal(init.result.serverInfo.name, "austere-axi");
  assert.ok(init.result.capabilities.tools);
  mcp.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");

  const list = await rpc("tools/list", {});
  assert.deepEqual(
    list.result.tools.map((t) => t.name),
    [
      "spec",
      "check",
      "open",
      "poll",
      "reply",
      "patch",
      "find",
      "outline",
      "show",
      "history",
      "restore",
      "changes",
      "decisions",
      "components",
      "sessions_list",
      "run_list",
      "run_log",
      "attach_status",
    ],
  );
  for (const t of list.result.tools) assert.equal(t.inputSchema.type, "object");
  const components = list.result.tools.find((t) => t.name === "components")!;
  assert.deepEqual(Object.keys(components.inputSchema.properties), [
    "command",
    "args",
    "pack",
    "group",
  ]);
  assert.doesNotMatch(
    JSON.stringify(components.inputSchema),
    /trust/i,
    "the MCP surface cannot pass --trust",
  );
  assert.deepEqual(components.inputSchema.properties.command.enum, [
    "search",
    "show",
    "list",
    "add",
  ]);

  const unknown = await rpc("tools/frobnicate", {});
  assert.equal(unknown.error.code, -32601);
});

test("answers no notification, rejects batches, and does not offer the batch protocol", async () => {
  for (const method of ["tools/list", "ping", "tools/frobnicate", "notifications/cancelled"])
    mcp.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params: {} }) + "\n");
  await rpc("ping", {});
  assert.deepEqual(unexpected, []);

  const batch = new Promise<RpcMessage>((resolve) => waiting.set(null, resolve));
  mcp.stdin.write(JSON.stringify([{ jsonrpc: "2.0", id: nextId++, method: "ping" }]) + "\n");
  const rejected = await batch;
  assert.equal(rejected.error.code, -32600);

  const init = await rpc("initialize", {
    protocolVersion: "2025-03-26",
    capabilities: {},
    clientInfo: { name: "test", version: "0" },
  });
  assert.equal(init.result.protocolVersion, "2025-11-25");
});

test("the removed end tool answers with what replaces it; another unknown tool is unknown", async () => {
  const end = await rpc("tools/call", { name: "end", arguments: {} });
  assert.equal(end.error.code, -32602);
  assert.match(
    end.error.message,
    /^end was removed in 0\.12: .*stop polling and continue in chat$/,
  );
  assert.equal(
    (await rpc("tools/call", { name: "frobnicate", arguments: {} })).error.message,
    "unknown tool: frobnicate",
  );
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

test("open, poll for feedback, reply through the poll", async () => {
  const open = await call("open", { file: GOOD, no_open: true });
  assert.equal(open.isError, false, open.content[0].text);
  assert.match(open.content[0].text, /^status: registered/m);
  const id = /\/s\/(\w+)/.exec(open.content[0].text)?.[1];
  assert.ok(id, open.content[0].text);

  const empty = await call("poll", { file: GOOD, timeout_ms: 200 });
  assert.match(empty.content[0].text, /^status: timeout/m);

  const pollP = call("poll", { file: GOOD });
  // Feedback arrives while the poll listens.
  await new Promise((r) => setTimeout(r, 500));
  const sent = await api(
    "POST",
    `/s/${id}/send`,
    { items: [{ kind: "annotation", target: "intro", component: "TextContent", note: "louder" }] },
    { host: `127.0.0.1:${PORT}` },
  );
  assert.equal(sent.status, 200);
  const poll = await pollP;
  assert.equal(poll.isError, false);
  assert.match(poll.content[0].text, /^status: feedback/m);
  assert.match(poll.content[0].text, /annotation: intro \(TextContent\)/);
  assert.match(poll.content[0].text, /note: louder/);

  const patched = await call("patch", { file: GOOD, statements: 'intro = TextContent("HELLO")' });
  assert.match(patched.content[0].text, /^status: patched/m);
  assert.match(fs.readFileSync(GOOD, "utf8"), /TextContent\("HELLO"\)/);

  const replied = await call("poll", {
    file: GOOD,
    agent_reply: "Made it louder.",
    timeout_ms: 200,
  });
  assert.match(replied.content[0].text, /^status: timeout/m);
});

test("find, outline, show, history, restore, changes, decisions and patch's from map to the CLI commands", async () => {
  const src = path.join(WORK, "from-src.html");
  const dest = path.join(WORK, "from-dest.html");
  fs.writeFileSync(
    src,
    page(
      'root = Stack([note, table])\nnote = TextContent("rollout checklist")\ntable = Table([Col("Step", ["freeze", "ship"])])',
    ),
  );
  fs.writeFileSync(dest, page('root = Stack([intro])\nintro = TextContent("hello")'));
  assert.equal((await call("open", { file: src, no_open: true })).isError, false);
  assert.equal((await call("open", { file: dest, no_open: true })).isError, false);

  const outline = await call("outline", { file: src });
  assert.match(outline.content[0].text, /root Stack \(2\)\n\s+note TextContent: rollout checklist/);
  const text = await call("show", { file: src, names: ["table"], plain_text: true });
  assert.match(text.content[0].text, /\| Step \|\n\s+\| --- \|\n\s+\| freeze \|\n\s+\| ship \|/);
  assert.match(
    (await call("show", { file: src, names: ["note"] })).content[0].text,
    /note = TextContent/,
  );
  assert.equal((await call("show", { file: src, names: ["nope"] })).isError, true);

  const found = await call("find", { words: "rollout checklist", project: WORK });
  assert.match(found.content[0].text, /statement: note/);
  assert.match(found.content[0].text, /^reuse: [^\n]*austere-axi patch <file> --from /m);
  assert.equal((await call("find", { words: "   " })).isError, true, "no words");

  const copied = await call("patch", {
    file: dest,
    statements: "root = Stack([intro, note, table])",
    from: [`${src}#note,table`],
  });
  assert.equal(copied.isError, false, copied.content[0].text);
  assert.match(copied.content[0].text, /copied: \[note, table\]/);
  assert.match(fs.readFileSync(dest, "utf8"), /note = TextContent\("rollout checklist"\)/);
  const rev = await call("patch", { file: dest, statements: "root = Stack([intro])", rev: 1 });
  assert.equal(rev.isError, true, "rev is for from");
  assert.match(rev.content[0].text, /rev is for from/);

  const history = await call("history", { file: dest });
  assert.match(history.content[0].text, /rev: 2\n[\s\S]*source: patch[\s\S]*copied:/);
  assert.match(
    (await call("history", { file: dest, statement: "note", since: 0 })).content[0].text,
    /rev: 2/,
  );
  const changes = await call("changes", { file: dest });
  assert.match(changes.content[0].text, /rev: 2/);
  assert.match(changes.content[0].text, /^cursor: \d+$/m);
  assert.match(
    (await call("changes", { project: WORK, since: 9999, limit: 5 })).content[0].text,
    /changes: none/,
  );
  assert.match((await call("decisions", { file: dest })).content[0].text, /decisions: none/);
  assert.equal(
    (await call("decisions", { file: dest, project: WORK })).isError,
    true,
    "a file or a project, not both",
  );

  const restored = await call("restore", { file: dest, rev: 1 });
  assert.equal(restored.isError, false, restored.content[0].text);
  assert.match(restored.content[0].text, /^status: restored/m);
  assert.doesNotMatch(fs.readFileSync(dest, "utf8"), /rollout checklist/);
  assert.equal((await call("restore", { file: dest })).isError, true, "rev is required");
});

test("poll with no file waits on the project of the server's folder; batches name their file, and bad combinations are refused", async () => {
  const open = await call("open", { file: GOOD, no_open: true });
  const id = /\/s\/(\w+)/.exec(open.content[0].text)?.[1];
  assert.ok(id, open.content[0].text);
  assert.match(
    open.content[0].text,
    /^next: "Run `austere-axi poll`;/m,
    "open names the bare poll, which is `poll {}` here",
  );

  const idle = await call("poll", { timeout_ms: 200 });
  assert.equal(idle.isError, false, idle.content[0].text);
  assert.match(idle.content[0].text, /^status: timeout/m);
  assert.match(idle.content[0].text, new RegExp(`^project: ${path.basename(WORK)}$`, "m"));

  const pollP = call("poll", {});
  await new Promise((r) => setTimeout(r, 500));
  await api(
    "POST",
    `/s/${id}/send`,
    { items: [{ kind: "message", text: "for the whole project" }] },
    { host: `127.0.0.1:${PORT}` },
  );
  const got = (await pollP).content[0].text;
  assert.match(got, /^status: feedback/m);
  assert.ok(got.includes(format({ file: GOOD })), got);
  assert.match(got, /message: for the whole project/);
  const cursor = Number((/^cursor: (\d+)$/m.exec(got) as RegExpExecArray)[1]);
  assert.match(
    (await call("poll", { project: WORK, cursor, timeout_ms: 200 })).content[0].text,
    /^status: timeout/m,
    "--project names the same project",
  );

  for (const [args, message] of [
    [{ file: GOOD, project: WORK }, /not both/],
    [{ project: WORK, agent_reply: "done" }, /use the reply tool/],
    [{ agent_reply: "done" }, /use the reply tool/],
  ] as const) {
    const r = await call("poll", args);
    assert.equal(r.isError, true);
    assert.match(r.content[0].text, message);
  }
});

test("components searches locally and refuses paths and untrusted packs", async () => {
  const found = await call("components", { command: "search", args: ["bar", "chart"] });
  assert.equal(found.isError, false, found.content[0].text);
  assert.match(found.content[0].text, /BarChart\(/);
  assert.match(found.content[0].text, /remote: .*unavailable/);

  const shown = await call("components", { command: "show", args: ["BarChart"] });
  assert.equal(shown.isError, false, shown.content[0].text);
  assert.match(shown.content[0].text, /BarChart\(/);
  const inCore = await call("components", { command: "show", args: ["BarChart"], pack: "core" });
  assert.equal(inCore.isError, false, inCore.content[0].text);
  assert.match(inCore.content[0].text, /BarChart\(/);
  assert.match(inCore.content[0].text, /from: core/);
  const inOther = await call("components", {
    command: "show",
    args: ["BarChart"],
    pack: "austere-pack-orbit",
  });
  assert.equal(inOther.isError, true, "show looks only in the named pack");
  assert.match(inOther.content[0].text, /unknown/);
  for (const command of ["search", "list", "add"]) {
    const packElsewhere = await call("components", { command, args: ["BarChart"], pack: "core" });
    assert.equal(packElsewhere.isError, true, command);
    assert.match(packElsewhere.content[0].text, /pack is only for show/, command);
  }
  const badPack = await call("components", { command: "show", args: ["BarChart"], pack: "../x" });
  assert.match(badPack.content[0].text, /pack must be core or an npm package name/);

  for (const spec of ["./my-pack", "C:\\packs\\x", "pack.tgz", "foo@../bar", "--trust"]) {
    const refused = await call("components", { command: "add", args: [spec] });
    assert.equal(refused.isError, true, spec);
    assert.match(refused.content[0].text, /add takes an npm package name.*folders and \.tgz/, spec);
  }
  const smuggled = await call("components", {
    command: "add",
    args: ["austere-pack-orbit", "--trust"],
  });
  assert.match(smuggled.content[0].text, /add takes exactly one npm package name/);
  const trustCommand = await call("components", {
    command: "trust",
    args: ["add", "austere-pack-orbit"],
  });
  assert.match(trustCommand.content[0].text, /command must be one of/);

  const untrusted = await call("components", { command: "add", args: ["austere-pack-orbit"] });
  assert.equal(untrusted.isError, true);
  assert.match(untrusted.content[0].text, /status: needs --trust/);
  assert.match(
    untrusted.content[0].text,
    /austere-pack-orbit is third-party and not on the user's trust list.*Ask the user/,
  );
  assert.doesNotMatch(untrusted.content[0].text, /rerun with --trust/);
  assert.ok(!fs.existsSync(path.join(STATE, "packs.json")), "nothing installed");
});
