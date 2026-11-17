// Harness adapters (RLM-344): argv per harness × mode × model, result parsing, caller detection,
// adapters.json in the state dir only, the terminal-only rule and PATH lookup.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, afterEach, before, test } from "node:test";
import {
  AdapterError,
  adaptersFile,
  capabilitiesFor,
  commandAdapter,
  copilot,
  findBinary,
  getAdapter,
  listAdapters,
  omp,
  readAdaptersConfig,
  setCommand,
  setExtraArgs,
  splitArgs,
} from "../src/cli/adapters/index.ts";
import type { BuildInput, RunMode } from "../src/cli/adapters/index.ts";

let tmp: string;
let stateDirPath: string;
let promptFile: string;
const PROMPT = "Reply to the note on page.oui.\nLine two.";
const ID = "01a1e322-390d-7000-8000-000000000001";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const savedState = process.env.AUSTERE_AXI_STATE_DIR;
const TTY = { isTTY: true };

before(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "austere-adapters-"));
  stateDirPath = path.join(tmp, "state");
  process.env.AUSTERE_AXI_STATE_DIR = stateDirPath;
  promptFile = path.join(tmp, "prompt.txt");
  fs.writeFileSync(promptFile, PROMPT, { mode: 0o600 });
});

afterEach(() => fs.rmSync(path.join(stateDirPath, "adapters.json"), { force: true }));

after(() => {
  if (savedState === undefined) delete process.env.AUSTERE_AXI_STATE_DIR;
  else process.env.AUSTERE_AXI_STATE_DIR = savedState;
  fs.rmSync(tmp, { recursive: true, force: true });
});

function input(mode: RunMode, extra: Partial<BuildInput> = {}): BuildInput {
  return { mode, sessionId: mode === "new" ? undefined : ID, promptFile, cwd: tmp, ...extra };
}

const isError = (code: string, re?: RegExp) => (err: unknown) => err instanceof AdapterError && err.code === code && (!re || re.test(err.message));

test("omp argv: every mode × model; prompt on stdin; no bypass flag, no --max-time", () => {
  const head = ["-p", "--mode", "json", "--wait-async"];
  const cases: [RunMode, string | undefined, string[]][] = [
    ["same", undefined, [...head, "--resume", ID]],
    ["same", "haiku", [...head, "--resume", ID, "--model", "haiku"]],
    ["fork", undefined, [...head, "--fork", ID]],
    ["fork", "haiku", [...head, "--fork", ID, "--model", "haiku"]],
    ["new", undefined, head],
    ["new", "haiku", [...head, "--model", "haiku"]],
  ];
  for (const [mode, model, args] of cases) {
    const built = omp.build(input(mode, { model }));
    assert.deepEqual(built, { bin: "omp", args, env: {}, stdin: promptFile }, `${mode} ${model ?? "no model"}`);
  }
});

test("copilot argv: same and new × model; --model always (default auto); new mints a fresh UUID", () => {
  const tail = (model: string) => ["--model", model, "--no-ask-user", "--output-format", "json"];
  for (const model of [undefined, "gpt-5"]) {
    const same = copilot.build(input("same", { model }));
    assert.deepEqual(same, { bin: "copilot", args: [`--resume=${ID}`, ...tail(model ?? "auto")], env: {}, stdin: promptFile, sessionId: ID });
    const fresh = copilot.build(input("new", { model }));
    assert.match(fresh.sessionId ?? "", UUID_RE);
    assert.deepEqual(fresh, { bin: "copilot", args: ["--session-id", fresh.sessionId, ...tail(model ?? "auto")], env: {}, stdin: promptFile, sessionId: fresh.sessionId });
  }
  assert.notEqual(copilot.build(input("new")).sessionId, copilot.build(input("new")).sessionId);
});

test("limits: --max-cost for omp, --max-ai-credits for copilot, each only when set", () => {
  const limits = { maxCost: 0.5, maxAiCredits: 20 };
  assert.deepEqual(omp.build(input("new", { limits })).args.slice(-2), ["--max-cost", "0.5"]);
  assert.deepEqual(copilot.build(input("new", { limits })).args.slice(-2), ["--max-ai-credits", "20"]);
  assert.ok(!omp.build(input("new", { limits: { maxAiCredits: 1 } })).args.includes("--max-ai-credits"));
  assert.ok(!copilot.build(input("new", { limits: { maxCost: 1 } })).args.includes("--max-cost"));
});

test("the owner's extra arguments from <state>/adapters.json come last", () => {
  setExtraArgs("omp", "--approval-mode yolo", TTY);
  setExtraArgs("copilot", "--allow-tool='shell(austere-axi:*)'", TTY);
  assert.deepEqual(omp.build(input("fork", { model: "m", limits: { maxCost: 1 } })).args, [
    "-p", "--mode", "json", "--wait-async", "--fork", ID, "--model", "m", "--max-cost", "1", "--approval-mode", "yolo",
  ]);
  assert.deepEqual(copilot.build(input("same", { limits: { maxAiCredits: 3 } })).args, [
    `--resume=${ID}`, "--model", "auto", "--no-ask-user", "--output-format", "json", "--max-ai-credits", "3", "--allow-tool=shell(austere-axi:*)",
  ]);
  setExtraArgs("omp", "", TTY);
  assert.deepEqual(omp.build(input("new")).args, ["-p", "--mode", "json", "--wait-async"]);
});

test("same and fork need a session id", () => {
  assert.throws(() => omp.build(input("same", { sessionId: undefined })), isError("bad_input"));
  assert.throws(() => omp.build(input("fork", { sessionId: "" })), isError("bad_input"));
  assert.throws(() => copilot.build(input("same", { sessionId: undefined })), isError("bad_input"));
});

test("copilot fork is unavailable with the reason, and build refuses it", () => {
  assert.deepEqual(copilot.capabilities.fork, { unavailable: 'Copilot CLI has no fork flag, and -p "/fork" does nothing' });
  assert.throws(() => copilot.build(input("fork")), isError("unsupported", /fork flag/));
});

test("no adapter puts the prompt text in argv", () => {
  setCommand("ingest", "wiki ingest", TTY);
  for (const adapter of listAdapters()) {
    for (const mode of ["same", "fork", "new"] as const) {
      if (adapter.capabilities[mode] !== true) continue;
      const built = adapter.build(input(mode, { model: "m", limits: { maxCost: 1, maxAiCredits: 1 } }));
      assert.equal(built.stdin, promptFile, `${adapter.id} ${mode}`);
      for (const arg of [built.bin, ...built.args]) assert.ok(!arg.includes("Reply to the note"), `${adapter.id} ${mode}: ${arg}`);
    }
  }
});

test("command adapter: fixed bin and args, new only, no model or extra args", () => {
  setExtraArgs("omp", "--approval-mode yolo", TTY);
  const cmd = commandAdapter("ingest", { bin: "/usr/bin/wiki", args: ["ingest", "--quiet"] });
  assert.equal(cmd.id, "command:ingest");
  assert.deepEqual(cmd.build(input("new", { model: "x" })), { bin: "/usr/bin/wiki", args: ["ingest", "--quiet"], env: {}, stdin: promptFile });
  assert.throws(() => cmd.build(input("same")), isError("unsupported"));
  assert.throws(() => cmd.build(input("fork")), isError("unsupported"));
  assert.deepEqual(cmd.readResult({ stdout: "", exitCode: 0 }), {});
  assert.deepEqual(cmd.readResult({ stdout: "", exitCode: 2 }), { error: "exit" });
});

test("omp readResult: id from the first JSON line; continuation and fork parents; cost cap", () => {
  const line = (o: object) => JSON.stringify(o);
  assert.deepEqual(omp.readResult({ stdout: `${line({ type: "session", id: ID })}\n${line({ type: "message" })}\n`, exitCode: 0 }), { sessionId: ID });
  // Resumed while open elsewhere: omp continues in a new session (A14).
  const other = "01a1e322-ce00-7000-8000-000000000002";
  assert.deepEqual(omp.readResult({ stdout: `${line({ type: "session", id: other, parentSession: ID, continuationOf: ID })}\n`, exitCode: 0 }), { sessionId: other, parentSessionId: ID });
  assert.deepEqual(omp.readResult({ stdout: `${line({ type: "session", id: other, parentSession: ID })}\n`, exitCode: 0 }), { sessionId: other, parentSessionId: ID });
  assert.deepEqual(omp.readResult({ stdout: `${line({ type: "session", id: ID })}\n`, exitCode: 3 }), { sessionId: ID, error: "cost_cap" });
  assert.deepEqual(omp.readResult({ stdout: 'Error: Session "nonexist" not found.\n', exitCode: 1 }), { error: "exit" });
  // Only the first JSON line counts: a later session line is not the run's header.
  assert.deepEqual(omp.readResult({ stdout: `${line({ type: "message", id: "x" })}\n${line({ type: "session", id: ID })}\n`, exitCode: 0 }), {});
});

test("copilot readResult: the result line, else session.start; SessionInUseError → session_in_use", () => {
  const start = JSON.stringify({ type: "session.start", data: { sessionId: ID, selectedModel: "auto", alreadyInUse: false } });
  const other = "d260d4ef-0000-4000-8000-000000000003";
  const result = JSON.stringify({ type: "result", sessionId: other, exitCode: 0 });
  assert.deepEqual(copilot.readResult({ stdout: `${start}\n{"type":"assistant.message"}\n${result}\n`, exitCode: 0 }), { sessionId: other });
  assert.deepEqual(copilot.readResult({ stdout: `${start}\n{"type":"assistant.message"}\n`, exitCode: 0 }), { sessionId: ID });
  const inUse = `Error: Session '${ID}' was found but could not be loaded. SessionInUseError: Session ${ID} is in use by another Copilot process`;
  assert.deepEqual(copilot.readResult({ stdout: "", stderr: inUse, exitCode: 1 }), { error: "session_in_use" });
  assert.deepEqual(copilot.readResult({ stdout: inUse, exitCode: 1 }), { error: "session_in_use" });
  assert.deepEqual(copilot.readResult({ stdout: "Execution failed", exitCode: 1 }), { error: "exit" });
});

test("detect: each harness reads only its own variables", () => {
  assert.deepEqual(omp.detect({ PI_SESSION_ID: "p1", PI_SESSION_FILE: "/s/2026_p1.jsonl" }), { harness: "omp", sessionId: "p1", sessionFile: "/s/2026_p1.jsonl" });
  assert.deepEqual(omp.detect({ PI_SESSION_FILE: "/s/2026-11-16T10-00-00_01a1e322.jsonl" }), {
    harness: "omp",
    sessionId: "01a1e322",
    sessionFile: "/s/2026-11-16T10-00-00_01a1e322.jsonl",
  });
  assert.equal(omp.detect({ COPILOT_AGENT_SESSION_ID: "c1", PI_SESSION_ID: "" }), null);
  assert.deepEqual(copilot.detect({ COPILOT_AGENT_SESSION_ID: "c1" }), { harness: "copilot", sessionId: "c1" });
  assert.equal(copilot.detect({ PI_SESSION_ID: "p1" }), null);
});

test("splitArgs splits like a shell without running one", () => {
  assert.deepEqual(splitArgs("--approval-mode yolo"), ["--approval-mode", "yolo"]);
  assert.deepEqual(splitArgs("  --allow-all  "), ["--allow-all"]);
  assert.deepEqual(splitArgs(""), []);
  assert.deepEqual(splitArgs(`--allow-tool='shell(austere-axi:*)' "a b" c\\ d "x\\"y" '$HOME' ""`), ["--allow-tool=shell(austere-axi:*)", "a b", "c d", 'x"y', "$HOME", ""]);
  assert.throws(() => splitArgs("'open"), isError("bad_input"));
  assert.throws(() => splitArgs('"open'), isError("bad_input"));
});

test("adapter set without a terminal changes nothing: library and CLI", () => {
  assert.throws(() => setExtraArgs("omp", "--approval-mode yolo", { isTTY: undefined }), isError("no_tty", /terminal/));
  assert.throws(() => setCommand("ingest", "wiki ingest", { isTTY: false }), isError("no_tty"));
  // The CLI an agent's tool call runs: stdin is a pipe, not a terminal.
  const env = { ...process.env, AUSTERE_AXI_STATE_DIR: stateDirPath };
  for (const args of [["omp", "--extra-args", "--approval-mode yolo"], ["copilot", "--extra-args", "--allow-all"], ["command:x", "--run", "sh -c id"]]) {
    const r = spawnSync(process.execPath, ["src/cli/main.ts", "adapter", "set", ...args], { encoding: "utf8", env, input: "" });
    assert.equal(r.status, 1, args.join(" "));
    assert.match(r.stdout, /needs the user at a terminal and changes nothing/);
  }
  assert.equal(fs.existsSync(adaptersFile()), false);
});

test("adapter set: stored 0600 in the state dir; an empty string clears; unknown harness refused", () => {
  assert.throws(() => setExtraArgs("claude", "--x", TTY), isError("bad_input"));
  assert.throws(() => setCommand("a b", "x", TTY), isError("bad_input"));
  setExtraArgs("omp", "--approval-mode yolo", TTY);
  setExtraArgs("copilot", "--allow-all", TTY);
  setCommand("ingest", "wiki ingest", TTY);
  assert.equal(path.dirname(adaptersFile()), stateDirPath);
  if (process.platform !== "win32") assert.equal(fs.statSync(adaptersFile()).mode & 0o777, 0o600);
  assert.deepEqual(readAdaptersConfig(), {
    commands: { ingest: { bin: "wiki", args: ["ingest"] } },
    omp: { extraArgs: ["--approval-mode", "yolo"] },
    copilot: { extraArgs: ["--allow-all"] },
  });
  assert.equal(getAdapter("command:ingest")?.bin, "wiki");
  assert.equal(getAdapter("command:missing"), null);
  assert.equal(getAdapter("dsh"), null);
  setCommand("ingest", "", TTY);
  assert.equal(getAdapter("command:ingest"), null);
});

test("an adapters.json in a project or the cwd is ignored", () => {
  const project = path.join(tmp, "project");
  fs.mkdirSync(path.join(project, ".austere-axi"), { recursive: true });
  const grant = JSON.stringify({ omp: { extraArgs: ["--approval-mode", "yolo"] }, copilot: { extraArgs: ["--allow-all"] }, commands: { evil: { bin: "sh", args: ["-c", "id"] } } });
  fs.writeFileSync(path.join(project, "adapters.json"), grant);
  fs.writeFileSync(path.join(project, ".austere-axi", "adapters.json"), grant);
  const cwd = process.cwd();
  process.chdir(project);
  try {
    assert.deepEqual(readAdaptersConfig(), { commands: {} });
    assert.deepEqual(omp.build(input("new", { cwd: project })).args, ["-p", "--mode", "json", "--wait-async"]);
    assert.ok(!copilot.build(input("new", { cwd: project })).args.includes("--allow-all"));
    assert.equal(getAdapter("command:evil"), null);
  } finally {
    process.chdir(cwd);
  }
});

test("a malformed adapters.json fails the build, naming the file", () => {
  fs.mkdirSync(stateDirPath, { recursive: true });
  fs.writeFileSync(adaptersFile(), JSON.stringify({ omp: { extraArgs: "--approval-mode yolo" } }));
  const named = (err: unknown) => err instanceof AdapterError && err.code === "bad_config" && err.message.includes(adaptersFile());
  assert.throws(() => readAdaptersConfig(), named);
  assert.throws(() => omp.build(input("new")), named);
});

test("missing binary: capabilities unavailable with the reason, never a throw", () => {
  const env = { PATH: path.join(tmp, "empty-bin") };
  const missing = { unavailable: "omp is not on PATH" };
  assert.deepEqual(capabilitiesFor(omp, env), { same: missing, fork: missing, new: missing, model: missing, maxTime: false, maxCost: missing });
  // A harness's own reason stays.
  assert.deepEqual(capabilitiesFor(copilot, {}).fork, copilot.capabilities.fork);
  assert.deepEqual(capabilitiesFor(copilot, {}).same, { unavailable: "copilot is not on PATH" });
  assert.equal(findBinary("", env), null);
});

test("findBinary: PATH on POSIX needs the execute bit; Windows tries PATHEXT", () => {
  const bin = path.join(tmp, "pathbin");
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(bin, "copilot"), "#!/bin/sh\n", { mode: 0o644 });
  fs.writeFileSync(path.join(bin, "omp.CMD"), "@echo off\r\n");
  if (process.platform !== "win32") {
    assert.equal(findBinary("copilot", { PATH: bin }, "linux"), null);
    fs.chmodSync(path.join(bin, "copilot"), 0o755);
    assert.equal(findBinary("copilot", { PATH: `/nonexistent:${bin}` }, "linux"), path.join(bin, "copilot"));
    assert.equal(findBinary(path.join(bin, "copilot"), {}, "linux"), path.join(bin, "copilot"));
    assert.deepEqual(capabilitiesFor(copilot, { PATH: bin }, "linux"), copilot.capabilities);
  }
  // Windows lookup, run on any OS: the Path variable's case and PATHEXT are honoured.
  assert.ok(findBinary("omp", { Path: bin, PATHEXT: ".EXE;.CMD" }, "win32")?.endsWith("omp.CMD"));
  assert.equal(findBinary("omp", { Path: bin, PATHEXT: ".EXE" }, "win32"), null);
  assert.equal(findBinary("omp", { Path: bin }, "linux"), null);
});
