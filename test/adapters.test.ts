// Harness adapters (RLM-344): argv per harness × mode × model, result parsing, caller detection,
// adapters.json in the state dir only, the terminal-only rule, PATH lookup, and a fake omp on PATH.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import {
  AdapterError,
  binaryAvailable,
  capabilitiesFor,
  commandAdapter,
  copilot,
  detectCaller,
  extraArgsFor,
  findBinary,
  getAdapter,
  omp,
  parseSessionOverride,
  readAdaptersConfig,
  setCommand,
  setExtraArgs,
  splitArgs,
  adaptersFile,
} from "../src/cli/adapters/index.ts";
import type { BuildInput, BuiltCommand, RunMode } from "../src/cli/adapters/index.ts";

let tmp: string;
let stateDirPath: string;
let promptFile: string;
const PROMPT = "Reply to the note on page.oui.\nLine two.";
const ID = "01a1e322-390d-7000-8000-000000000001";
const savedState = process.env.AUSTERE_AXI_STATE_DIR;

before(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "austere-adapters-"));
  stateDirPath = path.join(tmp, "state");
  process.env.AUSTERE_AXI_STATE_DIR = stateDirPath;
  promptFile = path.join(tmp, "prompt.txt");
  fs.writeFileSync(promptFile, PROMPT, { mode: 0o600 });
});

after(() => {
  if (savedState === undefined) delete process.env.AUSTERE_AXI_STATE_DIR;
  else process.env.AUSTERE_AXI_STATE_DIR = savedState;
  fs.rmSync(tmp, { recursive: true, force: true });
});

function input(mode: RunMode, extra: Partial<BuildInput> = {}): BuildInput {
  return { mode, sessionId: mode === "new" ? undefined : ID, promptFile, cwd: tmp, ...extra };
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

test("omp argv: every mode, with and without a model; prompt on stdin; no bypass flag", () => {
  const head = ["-p", "--mode", "json", "--wait-async"];
  const cases: [RunMode, string | undefined, string[]][] = [
    ["same", undefined, [...head, "--resume", ID]],
    ["same", "haiku", [...head, "--resume", ID, "--model", "haiku"]],
    ["fork", undefined, [...head, "--fork", ID]],
    ["fork", "haiku", [...head, "--fork", ID, "--model", "haiku"]],
    ["new", undefined, [...head]],
    ["new", "haiku", [...head, "--model", "haiku"]],
  ];
  for (const [mode, model, args] of cases) {
    const built = omp.build(input(mode, { model }));
    assert.deepEqual(built, { bin: "omp", args, env: {}, cwd: tmp, stdin: promptFile }, `${mode} ${model ?? "no model"}`);
    assert.ok(!built.args.some((a) => /yolo|allow-all|max-time/.test(a)));
  }
});

test("omp argv: --max-cost when set, then the owner's extra args last", () => {
  const built = omp.build(input("same", { model: "m", limits: { maxCost: 0.5, maxAiCredits: 9 }, extraArgs: ["--approval-mode", "yolo"] }));
  assert.deepEqual(built.args, ["-p", "--mode", "json", "--wait-async", "--resume", ID, "--model", "m", "--max-cost", "0.5", "--approval-mode", "yolo"]);
});

test("omp same and fork need a session id", () => {
  assert.throws(() => omp.build(input("same", { sessionId: undefined })), (err: unknown) => err instanceof AdapterError && err.code === "bad_input");
  assert.throws(() => omp.build(input("fork", { sessionId: "" })), AdapterError);
});

test("copilot argv: same and new, with and without a model; prompt in argv; always --model", () => {
  const tail = (model: string) => ["--model", model, "--no-ask-user", "--output-format", "json"];
  for (const model of [undefined, "gpt-5"]) {
    const same = copilot.build(input("same", { model }));
    assert.deepEqual(same, { bin: "copilot", args: ["-p", PROMPT, `--resume=${ID}`, ...tail(model ?? "auto")], env: {}, cwd: tmp, sessionId: ID });

    const fresh = copilot.build(input("new", { model }));
    assert.match(fresh.sessionId ?? "", UUID_RE);
    assert.deepEqual(fresh, {
      bin: "copilot",
      args: ["-p", PROMPT, "--session-id", fresh.sessionId, ...tail(model ?? "auto")],
      env: {},
      cwd: tmp,
      sessionId: fresh.sessionId,
    });
    assert.equal(fresh.stdin, undefined);
  }
  assert.notEqual(copilot.build(input("new")).sessionId, copilot.build(input("new")).sessionId);
});

test("copilot argv: --max-ai-credits when set, then extra args last", () => {
  const built = copilot.build(input("same", { limits: { maxCost: 1, maxAiCredits: 20 }, extraArgs: ["--allow-all"] }));
  assert.deepEqual(built.args, ["-p", PROMPT, `--resume=${ID}`, "--model", "auto", "--no-ask-user", "--output-format", "json", "--max-ai-credits", "20", "--allow-all"]);
});

test("copilot fork is rejected with the reason", () => {
  assert.deepEqual(copilot.capabilities.fork, { unavailable: 'Copilot CLI has no fork flag, and -p "/fork" does nothing' });
  assert.throws(
    () => copilot.build(input("fork")),
    (err: unknown) => err instanceof AdapterError && err.code === "unsupported" && /fork flag/.test(err.message),
  );
});

test("command adapter: fixed bin and args, new only, prompt on stdin", () => {
  const cmd = commandAdapter("ingest", { bin: "/usr/bin/wiki", args: ["ingest", "--quiet"] });
  assert.equal(cmd.id, "command:ingest");
  assert.deepEqual(cmd.build(input("new", { model: "x", extraArgs: ["--nope"] })), {
    bin: "/usr/bin/wiki",
    args: ["ingest", "--quiet"],
    env: {},
    cwd: tmp,
    stdin: promptFile,
  });
  assert.throws(() => cmd.build(input("same")), AdapterError);
  assert.throws(() => cmd.build(input("fork")), AdapterError);
  assert.deepEqual(cmd.readResult({ stdout: "", exitCode: 0 }), {});
  assert.deepEqual(cmd.readResult({ stdout: "", exitCode: 2 }), { error: "exit" });
});

test("omp readResult: id from the first JSON line, continuation and fork parents, cost cap", () => {
  const line = (o: object) => JSON.stringify(o);
  assert.deepEqual(omp.readResult({ stdout: `${line({ type: "session", id: ID })}\n${line({ type: "message" })}\n`, exitCode: 0 }), { sessionId: ID });
  // Resumed while open elsewhere: omp continues in a new session (A14).
  const other = "01a1e322-ce00-7000-8000-000000000002";
  assert.deepEqual(omp.readResult({ stdout: `${line({ type: "session", id: other, parentSession: ID, continuationOf: ID })}\n`, exitCode: 0 }), {
    sessionId: other,
    parentSessionId: ID,
  });
  assert.deepEqual(omp.readResult({ stdout: `${line({ type: "session", id: other, parentSession: ID })}\n`, exitCode: 0 }), { sessionId: other, parentSessionId: ID });
  assert.deepEqual(omp.readResult({ stdout: `${line({ type: "session", id: ID })}\n`, exitCode: 3 }), { sessionId: ID, error: "cost_cap" });
  assert.deepEqual(omp.readResult({ stdout: 'Error: Session "nonexist" not found.\n', exitCode: 1 }), { error: "exit" });
  // Only the first JSON line counts.
  assert.deepEqual(omp.readResult({ stdout: `${line({ type: "message", id: "x" })}\n${line({ type: "session", id: ID })}\n`, exitCode: 0 }), {});
});

test("copilot readResult: session.start, result line, minted id, SessionInUseError", () => {
  const start = JSON.stringify({ type: "session.start", data: { sessionId: ID, selectedModel: "auto", alreadyInUse: false } });
  const result = JSON.stringify({ type: "result", sessionId: ID, exitCode: 0 });
  assert.deepEqual(copilot.readResult({ stdout: `${start}\n{"type":"assistant.message"}\n${result}\n`, exitCode: 0 }), { sessionId: ID });
  assert.deepEqual(copilot.readResult({ stdout: `${result}\n`, exitCode: 0 }), { sessionId: ID });
  const built: BuiltCommand = { bin: "copilot", args: [], env: {}, cwd: tmp, sessionId: "minted" };
  assert.deepEqual(copilot.readResult({ stdout: "", exitCode: 0, built }), { sessionId: "minted" });
  const inUse = `Error: Session '${ID}' was found but could not be loaded. SessionInUseError: Session ${ID} is in use by another Copilot process`;
  assert.deepEqual(copilot.readResult({ stdout: "", stderr: inUse, exitCode: 1, built: { ...built, sessionId: ID } }), { sessionId: ID, error: "session_in_use" });
  assert.deepEqual(copilot.readResult({ stdout: inUse, exitCode: 1 }), { error: "session_in_use" });
  assert.deepEqual(copilot.readResult({ stdout: "Execution failed", exitCode: 1 }), { error: "exit" });
});

test("caller detection from the environment and the --session override", () => {
  assert.deepEqual(detectCaller({ PI_SESSION_ID: "p1", PI_SESSION_FILE: "/s/2026_p1.jsonl" }), { harness: "omp", sessionId: "p1", sessionFile: "/s/2026_p1.jsonl" });
  assert.deepEqual(detectCaller({ PI_SESSION_FILE: "/s/2026-11-16T10-00-00_01a1e322.jsonl" }), {
    harness: "omp",
    sessionId: "01a1e322",
    sessionFile: "/s/2026-11-16T10-00-00_01a1e322.jsonl",
  });
  assert.deepEqual(detectCaller({ PI_SESSION_ID: "p1" }), { harness: "omp", sessionId: "p1" });
  assert.deepEqual(detectCaller({ COPILOT_AGENT_SESSION_ID: "c1" }), { harness: "copilot", sessionId: "c1" });
  assert.deepEqual(detectCaller({ DSH_SESSION_ID: "d1" }), { harness: "dsh", sessionId: "d1" });
  assert.equal(detectCaller({ HOME: "/home/x", PI_SESSION_ID: "" }), null);
  assert.deepEqual(detectCaller({ PI_SESSION_ID: "p1" }, "copilot:abc:def"), { harness: "copilot", sessionId: "abc:def" });
  assert.deepEqual(parseSessionOverride("dsh:42"), { harness: "dsh", sessionId: "42" });
  for (const bad of ["omp", "omp:", ":x", "claude:x", "omp:a b"]) assert.throws(() => parseSessionOverride(bad), AdapterError, bad);
});

test("splitArgs splits like a shell without running one", () => {
  assert.deepEqual(splitArgs("--approval-mode yolo"), ["--approval-mode", "yolo"]);
  assert.deepEqual(splitArgs("  --allow-all  "), ["--allow-all"]);
  assert.deepEqual(splitArgs(""), []);
  assert.deepEqual(splitArgs(`--allow-tool='shell(austere-axi:*)' "a b" c\\ d "x\\"y" '$HOME' ""`), ["--allow-tool=shell(austere-axi:*)", "a b", "c d", 'x"y', "$HOME", ""]);
  assert.throws(() => splitArgs("'open"), AdapterError);
  assert.throws(() => splitArgs('"open'), AdapterError);
});

test("adapter set: refused without a terminal; stored 0600 in the state dir; appended to argv", () => {
  assert.throws(
    () => setExtraArgs("omp", "--approval-mode yolo", { isTTY: undefined }),
    (err: unknown) => err instanceof AdapterError && err.code === "no_tty" && /terminal/.test(err.message),
  );
  assert.throws(() => setCommand("ingest", { bin: "wiki", args: [] }, { isTTY: false }), (err: unknown) => err instanceof AdapterError && err.code === "no_tty");
  assert.equal(fs.existsSync(adaptersFile()), false);
  assert.throws(() => setExtraArgs("claude", "--x", { isTTY: true }), AdapterError);

  setExtraArgs("omp", "--approval-mode yolo", { isTTY: true });
  setExtraArgs("copilot", "--allow-all", { isTTY: true });
  setCommand("ingest", { bin: "wiki", args: ["ingest"] }, { isTTY: true });
  const file = adaptersFile();
  assert.equal(path.dirname(file), stateDirPath);
  if (process.platform !== "win32") assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  const config = readAdaptersConfig();
  assert.deepEqual(config, { omp: { extraArgs: ["--approval-mode", "yolo"] }, copilot: { extraArgs: ["--allow-all"] }, commands: { ingest: { bin: "wiki", args: ["ingest"] } } });

  const built = omp.build(input("new", { extraArgs: extraArgsFor(config, "omp") }));
  assert.deepEqual(built.args.slice(-2), ["--approval-mode", "yolo"]);
  assert.deepEqual(copilot.build(input("same", { extraArgs: extraArgsFor(config, "copilot") })).args.at(-1), "--allow-all");
  assert.equal(getAdapter("command:ingest", config)?.bin, "wiki");
  assert.equal(getAdapter("command:missing", config), null);
  assert.equal(getAdapter("dsh"), null);

  setExtraArgs("omp", "", { isTTY: true });
  assert.deepEqual(extraArgsFor(readAdaptersConfig(), "omp"), []);
  fs.rmSync(file);
});

test("an adapters.json in a project or the cwd is ignored", () => {
  const project = path.join(tmp, "project");
  fs.mkdirSync(path.join(project, ".austere-axi"), { recursive: true });
  const grant = JSON.stringify({ omp: { extraArgs: ["--approval-mode", "yolo"] }, commands: { evil: { bin: "sh", args: ["-c", "id"] } } });
  fs.writeFileSync(path.join(project, "adapters.json"), grant);
  fs.writeFileSync(path.join(project, ".austere-axi", "adapters.json"), grant);
  const cwd = process.cwd();
  process.chdir(project);
  try {
    const config = readAdaptersConfig();
    assert.deepEqual(config, { commands: {} });
    assert.deepEqual(omp.build(input("new", { cwd: project, extraArgs: extraArgsFor(config, "omp") })).args, ["-p", "--mode", "json", "--wait-async"]);
  } finally {
    process.chdir(cwd);
  }
});

test("a malformed adapters.json throws, naming the file", () => {
  fs.mkdirSync(stateDirPath, { recursive: true });
  fs.writeFileSync(adaptersFile(), JSON.stringify({ omp: { extraArgs: "--approval-mode yolo" } }));
  try {
    assert.throws(() => readAdaptersConfig(), (err: unknown) => err instanceof AdapterError && err.code === "bad_config" && err.message.includes(adaptersFile()));
  } finally {
    fs.rmSync(adaptersFile());
  }
});

test("missing binary: capabilities unavailable with the reason, never a throw", () => {
  const env = { PATH: path.join(tmp, "empty-bin") };
  assert.equal(binaryAvailable("omp", env), false);
  assert.deepEqual(capabilitiesFor(omp, env), {
    same: { unavailable: "omp is not on PATH" },
    fork: { unavailable: "omp is not on PATH" },
    new: { unavailable: "omp is not on PATH" },
    model: { unavailable: "omp is not on PATH" },
    maxTime: false,
    maxCost: { unavailable: "omp is not on PATH" },
  });
  // A harness's own reason stays.
  assert.deepEqual(capabilitiesFor(copilot, {}).fork, copilot.capabilities.fork);
  assert.equal(binaryAvailable("", env), false);
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

test("fake omp on PATH: the built command runs with the recorded argv and the prompt on stdin", { skip: process.platform === "win32" }, async () => {
  const bin = path.join(tmp, "fakebin");
  const record = path.join(tmp, "omp-record");
  fs.mkdirSync(bin, { recursive: true });
  const continued = "01a1e322-ce00-7000-8000-00000000000f";
  fs.writeFileSync(
    path.join(bin, "omp"),
    [
      "#!/bin/sh",
      `for a in "$@"; do printf '%s\\n' "$a"; done > "${record}.argv"`,
      `cat > "${record}.stdin"`,
      `pwd > "${record}.cwd"`,
      `printf '%s\\n' '{"type":"session","id":"${continued}","parentSession":"${ID}","continuationOf":"${ID}"}'`,
      `printf '%s\\n' '{"type":"message","text":"ok"}'`,
      "",
    ].join("\n"),
    { mode: 0o755 },
  );
  const env = { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}` };
  assert.equal(findBinary("omp", env), path.join(bin, "omp"));
  assert.equal(capabilitiesFor(omp, env).same, true);

  const built = omp.build(input("same", { model: "haiku", limits: { maxCost: 2 }, extraArgs: ["--approval-mode", "yolo"] }));
  const stdinFd = fs.openSync(built.stdin ?? "", "r");
  const { promise, resolve, reject } = Promise.withResolvers<{ code: number | null; stdout: string }>();
  const child = spawn(built.bin, built.args, { cwd: built.cwd, env: { ...env, ...built.env }, stdio: [stdinFd, "pipe", "inherit"] });
  let out = "";
  child.stdout?.setEncoding("utf8").on("data", (chunk: string) => (out += chunk));
  child.on("error", reject);
  child.on("close", (exitCode) => resolve({ code: exitCode, stdout: out }));
  const { code, stdout } = await promise;
  fs.closeSync(stdinFd);

  assert.equal(code, 0);
  assert.deepEqual(fs.readFileSync(`${record}.argv`, "utf8").split("\n").slice(0, -1), [
    "-p",
    "--mode",
    "json",
    "--wait-async",
    "--resume",
    ID,
    "--model",
    "haiku",
    "--max-cost",
    "2",
    "--approval-mode",
    "yolo",
  ]);
  assert.equal(fs.readFileSync(`${record}.stdin`, "utf8"), PROMPT);
  assert.equal(fs.realpathSync(fs.readFileSync(`${record}.cwd`, "utf8").trim()), fs.realpathSync(tmp));
  assert.deepEqual(omp.readResult({ stdout, exitCode: code, built }), { sessionId: continued, parentSessionId: ID });
});
