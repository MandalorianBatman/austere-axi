import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const STATE = fs.mkdtempSync(path.join(os.tmpdir(), "austere-cli-"));
const env = { ...process.env, AUSTERE_AXI_STATE_DIR: STATE, AUSTERE_AXI_NO_OPEN: "1", AUSTERE_AXI_NO_TAILSCALE: "1", AUSTERE_AXI_PORT: "4997" };
const cli = (...args: string[]) => {
  const r = spawnSync(process.execPath, ["src/cli/main.ts", ...args], { encoding: "utf8", env });
  return { code: r.status, out: r.stdout };
};

test.after(() => fs.rmSync(STATE, { recursive: true, force: true }));

test("an unknown flag is a usage error (exit 2) and the command does not run", () => {
  const r = cli("check", "test/fixtures/action/ok.html", "--bogus");
  assert.equal(r.code, 2);
  assert.match(r.out, /code: USAGE/);
  assert.match(r.out, /unknown flag for check: --bogus; valid: --fix/);
  assert.doesNotMatch(r.out, /statements:/);
});

test("a flag from another command is rejected, a command without flags says so", () => {
  assert.match(cli("check", "test/fixtures/action/ok.html", "--trust").out, /unknown flag for check: --trust/);
  const r = cli("end", "test/fixtures/action/ok.html", "--fix");
  assert.equal(r.code, 2);
  assert.match(r.out, /it takes no flags/);
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
    assert.match(r.out, /^austere-axi check <file> \[--fix\]\n/);
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
