import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Hub } from "../src/cli/hub.ts";
import { SessionStore } from "../src/cli/sessions.ts";

const STATE = fs.mkdtempSync(path.join(os.tmpdir(), "austere-cli-"));
const env = { ...process.env, AUSTERE_AXI_STATE_DIR: STATE, AUSTERE_AXI_NO_OPEN: "1", AUSTERE_AXI_NO_TAILSCALE: "1", AUSTERE_AXI_PORT: "4997" };
const cliWith = (e: NodeJS.ProcessEnv, ...args: string[]) => {
  const r = spawnSync(process.execPath, ["src/cli/main.ts", ...args], { encoding: "utf8", env: e });
  return { code: r.status, out: r.stdout };
};
const cli = (...args: string[]) => cliWith(env, ...args);

test.after(() => fs.rmSync(STATE, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }));

test("an unknown flag is a usage error (exit 2) and the command does not run", () => {
  const r = cli("check", "test/fixtures/action/ok.html", "--bogus");
  assert.equal(r.code, 2);
  assert.match(r.out, /code: USAGE/);
  assert.match(r.out, /unknown flag for check: --bogus; valid: --fix/);
  assert.doesNotMatch(r.out, /statements:/);
});

test("a flag from another command is rejected, a command without flags says so", () => {
  assert.match(cli("check", "test/fixtures/action/ok.html", "--trust").out, /unknown flag for check: --trust/);
  const r = cli("login", "--fix");
  assert.equal(r.code, 2);
  assert.match(r.out, /it takes no flags/);
});

test("removed session verbs and flags exit 2 with their replacement and run nothing", () => {
  const file = "test/fixtures/action/ok.html";
  for (const [args, pointer] of [
    [["end", file], /nothing to end.*continue in chat/],
    [["close", file], /austere-axi archive <file>/],
    [["reopen", file], /austere-axi unarchive <file>/],
    [[file, "--reopen"], /--reopen was removed.*unarchive/],
    [["poll", file, "--takeover"], /--takeover was removed.*newest poll replaces/],
  ] as const) {
    const r = cli(...args);
    assert.equal(r.code, 2, args.join(" "));
    assert.match(r.out, /code: REMOVED/);
    assert.match(r.out, pointer);
  }
});

test("usage errors exit 2; failures while running exit 1", () => {
  assert.equal(cli("nosuchcmd").code, 2);
  assert.equal(cli("check").code, 2);
  assert.equal(cli("poll", "x.html", "--cursor").code, 2);
  assert.equal(cli("spec", "NoSuchGroup").code, 2);
  assert.equal(cli("check", "test/fixtures/action/nope.html").code, 1);
  assert.equal(cli("check", "test/fixtures/action/bad.html").code, 1);
});

test("<command> --help prints that command's usage, flags and example, not the full help", () => {
  for (const args of [["check", "--help"], ["help", "check"]]) {
    const r = cli(...args);
    assert.equal(r.code, 0);
    assert.match(r.out, /^austere-axi check <file> \[--fix\] \[--render\]\n/);
    assert.match(r.out, /--fix/);
    assert.match(r.out, /EXAMPLE\n  austere-axi check plan\.html/);
    assert.doesNotMatch(r.out, /WORKFLOW/);
  }
  assert.match(cli("--help").out, /WORKFLOW/);
});

test("with no arguments, live state comes first and the full help is not printed", () => {
  const r = cli();
  assert.equal(r.code, 0);
  assert.match(r.out, /^bin: austere-axi \S+\n/);
  assert.match(r.out, /\nserver: not running\nopen_sessions: 0\n/);
  assert.doesNotMatch(r.out, /WORKFLOW/);
});

test("hub list and hub notes say when --limit cut the list, and take a number", async () => {
  const work = fs.mkdtempSync(path.join(STATE, "work-"));
  fs.mkdirSync(path.join(work, ".git"));
  const store = await SessionStore.open(STATE);
  try {
    const hub = new Hub(store.db);
    const first = store.ensure(path.join(work, "page-00.html"));
    fs.writeFileSync(first.file, "<!doctype html><title>t</title>");
    for (let i = 1; i < 45; i++) {
      const file = path.join(work, `page-${String(i).padStart(2, "0")}.html`);
      fs.writeFileSync(file, "<!doctype html><title>t</title>");
      hub.register({ id: i.toString(16).padStart(12, "0"), file });
    }
    store.addUserBatch(first, Array.from({ length: 45 }, (_, i) => ({ kind: "message", text: `note ${i}` })));
  } finally {
    store.close();
  }

  let r = cli("hub", "list", "--all", "--project", work);
  assert.equal(r.code, 0);
  assert.match(r.out, /shown: "?40 of 45 pages shown; `--limit n` shows more/);
  assert.equal(r.out.match(/page: page-/g)?.length, 40);
  r = cli("hub", "list", "--all", "--project", work, "--limit", "45");
  assert.doesNotMatch(r.out, /shown:/, "nothing was cut");
  assert.equal(r.out.match(/page: page-/g)?.length, 45);
  r = cli("hub", "list", "--all", "--project", work, "--limit", "2");
  assert.match(r.out, /shown: "?2 of 45 pages shown/);

  r = cli("hub", "notes", "--project", work);
  assert.match(r.out, /shown: "?40 of 45 notes shown; `--limit n` shows more/);
  assert.match(cli("hub", "notes", "--project", work, "--limit", "45").out, /note 44/);
  assert.doesNotMatch(cli("hub", "notes", "--project", work, "--limit", "45").out, /shown:/);

  for (const bad of ["0", "-3", "many", "2.5"]) {
    r = cli("hub", "list", "--limit", bad);
    assert.equal(r.code, 2, bad);
    assert.match(r.out, /--limit takes a whole number of 1 or more/);
  }
});

test("hub open honours AUSTERE_AXI_NO_OPEN: no browser is started and the sign-in hint is printed", { skip: process.platform === "win32" }, async () => {
  // A stand-in for the platform's opener that leaves a mark when it runs.
  const bin = fs.mkdtempSync(path.join(STATE, "bin-"));
  const mark = path.join(bin, "launched");
  for (const name of ["xdg-open", "open"]) {
    fs.writeFileSync(path.join(bin, name), `#!/bin/sh\necho "$1" > "${mark}"\n`, { mode: 0o755 });
  }
  const withOpener = { ...env, PATH: `${bin}${path.delimiter}${process.env.PATH}` };
  try {
    const r = cliWith({ ...withOpener, AUSTERE_AXI_NO_OPEN: "1" }, "hub", "open");
    assert.equal(r.code, 0);
    assert.match(r.out, /status: open the url/);
    assert.match(r.out, /url: http:\/\/127\.0\.0\.1:4997\//);
    assert.match(r.out, /note: "?AUSTERE_AXI_NO_OPEN is set/);
    assert.match(r.out, /sign_in: .*austere-axi login/);
    await new Promise((res) => setTimeout(res, 500));
    assert.equal(fs.existsSync(mark), false, "the opener was not run");

    // Without it the opener runs (so the check above can fail).
    const opened = cliWith({ ...withOpener, AUSTERE_AXI_NO_OPEN: "" }, "hub", "open");
    assert.match(opened.out, /status: opened/);
    for (let i = 0; i < 40 && !fs.existsSync(mark); i++) await new Promise((res) => setTimeout(res, 50));
    assert.equal(fs.existsSync(mark), true, "the opener ran");
  } finally {
    cli("stop");
  }
});
