// A build run from a checkout keeps off the owner's state dir and port (RLM-376); an installed
// build uses them. And no test or script runs the CLI without its own AUSTERE_AXI_STATE_DIR.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { REAL_PORT, applyDevDefaults, devCheckout, devPort } from "../src/cli/paths.ts";

const ROOT = path.resolve(import.meta.dirname, "..");

test("an unbundled CLI with no variables uses <checkout>/.dev/state and the checkout's own port, and says so", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "austere-devhome-"));
  try {
    const { AUSTERE_AXI_STATE_DIR, AUSTERE_AXI_PORT, ...rest } = process.env;
    const r = spawnSync(process.execPath, ["src/cli/main.ts", "help"], { cwd: ROOT, env: { ...rest, HOME: home, USERPROFILE: home }, encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    const state = path.join(ROOT, ".dev", "state");
    const lines = r.stderr.split("\n").filter(Boolean);
    assert.equal(lines.length, 1, r.stderr);
    assert.ok(lines[0].includes(`state dir ${state}, port ${devPort(ROOT)}`), lines[0]);
    assert.equal(fs.existsSync(path.join(home, ".austere-axi")), false, "the real state dir is left alone");
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("dev defaults: sources and dist/ in a git checkout get them; an explicit AUSTERE_AXI_STATE_DIR opts out", () => {
  assert.equal(devCheckout(false, path.join(ROOT, "src", "cli")), ROOT);
  const checkout = fs.mkdtempSync(path.join(os.tmpdir(), "austere-checkout-"));
  try {
    fs.mkdirSync(path.join(checkout, "dist"));
    assert.equal(devCheckout(true, path.join(checkout, "dist")), null, "dist/ outside a git checkout");
    // A worktree's .git is a file.
    fs.writeFileSync(path.join(checkout, ".git"), "gitdir: /elsewhere\n");
    assert.equal(devCheckout(true, path.join(checkout, "dist")), checkout);
  } finally {
    fs.rmSync(checkout, { recursive: true, force: true });
  }

  const env: NodeJS.ProcessEnv = {};
  assert.match(applyDevDefaults(env, ROOT) ?? "", /a build from a checkout/);
  assert.equal(env.AUSTERE_AXI_STATE_DIR, path.join(ROOT, ".dev", "state"));
  assert.equal(env.AUSTERE_AXI_PORT, String(devPort(ROOT)));
  assert.notEqual(devPort(ROOT), REAL_PORT);

  const chosenPort: NodeJS.ProcessEnv = { AUSTERE_AXI_PORT: "5000" };
  applyDevDefaults(chosenPort, ROOT);
  assert.equal(chosenPort.AUSTERE_AXI_PORT, "5000", "a port set on its own is kept");

  const explicit: NodeJS.ProcessEnv = { AUSTERE_AXI_STATE_DIR: "/real" };
  assert.equal(applyDevDefaults(explicit, ROOT), null);
  assert.deepEqual(explicit, { AUSTERE_AXI_STATE_DIR: "/real" }, "the port stays the real default too");
});

test("the packed npm build uses ~/.austere-axi and port 4388", () => {
  // npm installs dist/ under node_modules/austere-axi/, with no .git beside it, even inside a git repository.
  const project = fs.mkdtempSync(path.join(os.tmpdir(), "austere-installed-"));
  try {
    fs.mkdirSync(path.join(project, ".git"));
    const dist = path.join(project, "node_modules", "austere-axi", "dist");
    fs.mkdirSync(dist, { recursive: true });
    const root = devCheckout(true, dist);
    assert.equal(root, null);
    const env: NodeJS.ProcessEnv = {};
    assert.equal(applyDevDefaults(env, root), null);
    assert.deepEqual(env, {}, "stateDir() and port() fall back to ~/.austere-axi and 4388");
  } finally {
    fs.rmSync(project, { recursive: true, force: true });
  }
});

test("every test and script that runs the CLI or the server sets AUSTERE_AXI_STATE_DIR", () => {
  const files: string[] = [];
  const walk = (dir: string): void => {
    for (const e of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
      if (e.isDirectory() && e.name !== "node_modules") walk(path.join(dir, e.name));
      else if (e.isFile() && /\.(ts|mjs|js)$/.test(e.name)) files.push(path.join(dir, e.name));
    }
  };
  for (const dir of ["test", "scripts", "bench"]) walk(dir);
  const missing = files.filter((f) => {
    const text = fs.readFileSync(path.join(ROOT, f), "utf8");
    const runsCli = /\b(spawn|spawnSync|execFile|execFileSync|fork)\(/.test(text) && /src\/cli\/main\.ts|dist\/cli\.mjs|runServer/.test(text);
    return runsCli && !text.includes("AUSTERE_AXI_STATE_DIR");
  });
  assert.deepEqual(missing, [], "these run the CLI on the owner's state dir: set AUSTERE_AXI_STATE_DIR to a scratch dir");
});
