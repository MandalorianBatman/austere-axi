// `check --render` (npm run test:browser; needs Chrome or CHROME_PATH): the page renders in headless
// Chrome and the agent gets, as text, what only rendering shows.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { CDN_RUNTIME_URL } from "../../src/cli/artifact.ts";
import { findChrome, renderCheck } from "../../src/cli/render-check.ts";
import { ROOT, htmlPage } from "../../scripts/lib/plugins.ts";

const CLI = path.join(ROOT, "src/cli/main.ts");

const STATE = fs.mkdtempSync(path.join(os.tmpdir(), "austere-render-state-"));
const ENV = { ...process.env, AUSTERE_AXI_STATE_DIR: STATE, AUSTERE_AXI_NO_TAILSCALE: "1", OPENUI_TELEMETRY_DISABLED: "1" };
const skip = findChrome() ? false : "no Chrome; set CHROME_PATH";

test("a Mermaid syntax error fails check --render, named by its statement", { skip }, () => {
  const file = path.join(STATE, "mermaid.html");
  fs.writeFileSync(file, htmlPage("Mermaid", 'root = Stack([intro, diag])\nintro = TextContent("hi")\ndiag = Mermaid("graph TD\\n A--> -->> ((")', CDN_RUNTIME_URL));
  const plain = spawnSync(process.execPath, [CLI, "check", file], { env: ENV, encoding: "utf8" });
  assert.equal(plain.status, 0, "the static check cannot see Mermaid syntax");
  const r = spawnSync(process.execPath, [CLI, "check", "--render", file], { env: ENV, encoding: "utf8" });
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stdout, /status: errors/);
  assert.match(r.stdout, /statement: diag/);
});

test("a clean page reports nothing; a row too wide for a phone names the statements past the edge", { skip }, async () => {
  const clean = await renderCheck(htmlPage("Clean", 'root = Stack([intro])\nintro = Card([CardHeader("Title", "Sub"), t])\nt = MarkDownRenderer("hello")', CDN_RUNTIME_URL));
  assert.equal(clean.status, "ok", JSON.stringify(clean));
  assert.deepEqual(clean.errors, []);
  assert.deepEqual(clean.overflow, []);

  const cards = Array.from({ length: 12 }, (_, i) => `c${i}`);
  const program = [`root = Stack([row])`, `row = Stack([${cards.join(", ")}], "row")`, ...cards.map((c) => `${c} = Card([CardHeader("Header ${c} is wide", "sub")])`)].join("\n");
  const wide = await renderCheck(htmlPage("Wide", program, CDN_RUNTIME_URL));
  assert.equal(wide.status, "ok", JSON.stringify(wide));
  assert.equal(wide.overflow.length, 1, JSON.stringify(wide.overflow));
  assert.equal(wide.overflow[0].width, 390);
  assert.ok(wide.overflow[0].statements.length > 0 && wide.overflow[0].statements.every((s) => cards.includes(s)), JSON.stringify(wide.overflow));
});

test("a Mermaid flowchart too wide to shrink legibly is named with a fix, even in an inner tab of a tab not open by default", { skip }, async () => {
  const chain = Array.from({ length: 10 }, (_, i) => `n${i}[Step ${i} of the long chain] --> n${i + 1}`).join("\\n  ");
  const program = [
    `root = Stack([small, tabs])`,
    `small = Mermaid("flowchart LR\\n  a[Client] --> b[API]")`,
    `tabs = Tabs([first, second])`,
    `first = TabItem("first", "First", [TextContent("hi")])`,
    `second = TabItem("second", "Second", [inner])`,
    `inner = Tabs([innerFirst, innerSecond])`,
    `innerFirst = TabItem("a", "Inner first", [TextContent("inner")])`,
    `innerSecond = TabItem("b", "Inner second", [chain])`,
    `chain = Mermaid("flowchart LR\\n  ${chain}")`,
  ].join("\n");
  const r = await renderCheck(htmlPage("Wide Mermaid", program, CDN_RUNTIME_URL));
  assert.equal(r.status, "ok", JSON.stringify(r));
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.overflow, [], "the diagram scrolls in its own box, not the page");
  assert.deepEqual(r.wide.map((w) => w.statement), ["chain"]);
  assert.match(r.wide[0].message, /^Mermaid chain is \d+px wide .* at 1280px, so it scrolls sideways; use `flowchart TD` or split it\.$/);
});
