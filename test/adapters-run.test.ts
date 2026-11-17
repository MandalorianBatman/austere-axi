// Harness adapters end to end (RLM-344): fake `omp` and `copilot` binaries on PATH record their argv,
// stdin and cwd, change the page with `austere-axi patch` as a dispatched agent would, and print the
// harness's JSON output. Each supported mode runs the built command and reads the session id back.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, afterEach, before, test } from "node:test";
import { capabilitiesFor, copilot, omp, setExtraArgs } from "../src/cli/adapters/index.ts";
import type { Adapter, BuildInput, RunMode, RunResult } from "../src/cli/adapters/index.ts";

const POSIX = process.platform !== "win32";
const PROMPT = "Run `austere-axi feedback page.html`, then patch and reply.\n";
const ID = "01a1e322-390d-7000-8000-000000000001";
const CLI = path.resolve("src/cli/main.ts");
const savedState = process.env.AUSTERE_AXI_STATE_DIR;

let tmp: string;
let binDir: string;
let recordDir: string;
let promptFile: string;
let env: NodeJS.ProcessEnv;

// One script serves both harnesses; it tells them apart by its own name.
const FAKE = `#!${process.execPath}
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const harness = path.basename(process.argv[1]);
const args = process.argv.slice(2);
const stdin = fs.readFileSync(0, "utf8");
fs.writeFileSync(path.join(process.env.FAKE_RECORD, harness + ".json"), JSON.stringify({ args, stdin, cwd: process.cwd() }));
const after = (flag) => (args.includes(flag) ? args[args.indexOf(flag) + 1] : undefined);
const text = "patched by " + harness + " " + args.join(" ");
try {
  execFileSync(process.execPath, [process.env.FAKE_CLI, "patch", process.env.FAKE_PAGE], { input: "why = MarkDownRenderer(" + JSON.stringify(text) + ")\\n", stdio: ["pipe", "ignore", "inherit"] });
} catch {
  process.exit(9);
}
const fresh = "fake-" + harness + "-" + process.pid;
if (harness === "omp") {
  const resume = after("--resume");
  const fork = after("--fork");
  const header = resume ? { type: "session", id: resume } : fork ? { type: "session", id: fresh, parentSession: fork } : { type: "session", id: fresh };
  console.log(JSON.stringify(header));
  console.log(JSON.stringify({ type: "message", text: "done" }));
} else {
  const resume = args.find((a) => a.startsWith("--resume="))?.slice("--resume=".length);
  const id = resume ?? after("--session-id");
  if (!resume) console.log(JSON.stringify({ type: "session.start", data: { sessionId: id, selectedModel: after("--model") } }));
  console.log(JSON.stringify({ type: "assistant.message", data: { content: "done" } }));
  console.log(JSON.stringify({ type: "result", sessionId: id, exitCode: 0 }));
}
`;

before(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "austere-adapters-run-"));
  binDir = path.join(tmp, "bin");
  recordDir = path.join(tmp, "record");
  fs.mkdirSync(binDir);
  fs.mkdirSync(recordDir);
  for (const name of ["omp", "copilot"]) fs.writeFileSync(path.join(binDir, name), FAKE, { mode: 0o755 });
  promptFile = path.join(tmp, "prompt.txt");
  fs.writeFileSync(promptFile, PROMPT, { mode: 0o600 });
  const state = path.join(tmp, "state");
  process.env.AUSTERE_AXI_STATE_DIR = state;
  env = {
    ...process.env,
    PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
    AUSTERE_AXI_STATE_DIR: state,
    AUSTERE_AXI_NO_OPEN: "1",
    AUSTERE_AXI_NO_TAILSCALE: "1",
    FAKE_RECORD: recordDir,
    FAKE_CLI: CLI,
  };
});

afterEach(() => fs.rmSync(path.join(tmp, "state", "adapters.json"), { force: true }));

after(() => {
  if (savedState === undefined) delete process.env.AUSTERE_AXI_STATE_DIR;
  else process.env.AUSTERE_AXI_STATE_DIR = savedState;
  fs.rmSync(tmp, { recursive: true, force: true });
});

interface Run {
  code: number | null;
  result: RunResult;
  record: { args: string[]; stdin: string; cwd: string };
  builtArgs: string[];
  builtSessionId?: string;
  pageText: string;
}

/** Builds the command, runs it the way the dispatcher does (cwd, stdin from the prompt file), reads the result. */
async function run(adapter: Adapter, mode: RunMode, extra: Partial<BuildInput> = {}): Promise<Run> {
  const cwd = fs.mkdtempSync(path.join(tmp, "copy-"));
  const page = path.join(cwd, "page.html");
  fs.copyFileSync("test/fixtures/action/ok.html", page);
  const built = adapter.build({ mode, promptFile, cwd, ...extra });
  const stdinFd = fs.openSync(built.stdin ?? promptFile, "r");
  const child = spawn(built.bin, built.args, { cwd, env: { ...env, FAKE_PAGE: page, ...built.env }, stdio: [stdinFd, "pipe", "inherit"] });
  fs.closeSync(stdinFd);
  let stdout = "";
  child.stdout?.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
  const [code] = (await once(child, "close")) as [number | null];
  const record = JSON.parse(fs.readFileSync(path.join(recordDir, `${adapter.id}.json`), "utf8"));
  assert.equal(fs.realpathSync(record.cwd), fs.realpathSync(cwd));
  return { code, result: adapter.readResult({ stdout, exitCode: code }), record, builtArgs: built.args, builtSessionId: built.sessionId, pageText: fs.readFileSync(page, "utf8") };
}

function assertRan(r: Run, label: string): void {
  assert.equal(r.code, 0, label);
  assert.deepEqual(r.record.args, r.builtArgs, `${label}: the binary got the built argv`);
  assert.equal(r.record.stdin, PROMPT, `${label}: the prompt arrived on stdin`);
  assert.match(r.pageText, /why = MarkDownRenderer\("patched by /, `${label}: the page was patched`);
}

test("the fake binaries are found on PATH, so every supported mode is available", { skip: !POSIX }, () => {
  assert.equal(capabilitiesFor(omp, env).same, true);
  assert.equal(capabilitiesFor(omp, env).fork, true);
  assert.equal(capabilitiesFor(copilot, env).new, true);
});

test("omp same, fork and new run end to end", { skip: !POSIX }, async () => {
  const same = await run(omp, "same", { sessionId: ID, model: "haiku" });
  assertRan(same, "omp same");
  assert.deepEqual(same.result, { sessionId: ID });

  const fork = await run(omp, "fork", { sessionId: ID, model: "haiku", limits: { maxCost: 0.5 } });
  assertRan(fork, "omp fork");
  assert.match(fork.result.sessionId ?? "", /^fake-omp-/);
  assert.equal(fork.result.parentSessionId, ID);

  const fresh = await run(omp, "new");
  assertRan(fresh, "omp new");
  assert.match(fresh.result.sessionId ?? "", /^fake-omp-/);
  assert.equal(fresh.result.parentSessionId, undefined);
});

test("copilot new then same: the minted id is the session, and the next run resumes it", { skip: !POSIX }, async () => {
  const fresh = await run(copilot, "new", { model: "gpt-5" });
  assertRan(fresh, "copilot new");
  assert.ok(fresh.builtSessionId);
  assert.deepEqual(fresh.result, { sessionId: fresh.builtSessionId });

  const same = await run(copilot, "same", { sessionId: fresh.result.sessionId });
  assertRan(same, "copilot same");
  assert.equal(same.record.args[0], `--resume=${fresh.builtSessionId}`);
  assert.deepEqual(same.result, { sessionId: fresh.builtSessionId });
});

test("the owner's grant reaches the binary last; without it nothing grants permissions", { skip: !POSIX }, async () => {
  const bare = await run(omp, "new");
  assert.ok(!bare.record.args.some((a) => /yolo|allow-all/.test(a)));
  setExtraArgs("omp", "--approval-mode yolo", { isTTY: true });
  setExtraArgs("copilot", "--allow-all", { isTTY: true });
  const granted = await run(omp, "new");
  assertRan(granted, "omp new with grant");
  assert.deepEqual(granted.record.args.slice(-2), ["--approval-mode", "yolo"]);
  const copilotGranted = await run(copilot, "new");
  assert.equal(copilotGranted.record.args.at(-1), "--allow-all");
});
