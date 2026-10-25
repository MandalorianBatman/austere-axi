import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { readArtifact, replaceProgram, rewriteRuntime } from "../src/cli/artifact.js";
import { checkHtml, statementLines } from "../src/cli/check.js";

process.env.OPENUI_TELEMETRY_DISABLED = "1";
const page = (program) => `<!doctype html><html><head><title>T &amp; t</title>
<script src="https://cdn.jsdelivr.net/npm/austere-axi@0/dist/austere.js"></script></head>
<body><script type="text/openui">
${program}
</script></body></html>`;

test("examples pass check", () => {
  for (const f of ["examples/session-migration.html", "examples/code-review.html"]) {
    const r = checkHtml(fs.readFileSync(f, "utf8"));
    assert.equal(r.ok, true, `${f}: ${JSON.stringify(r.errors)}`);
    assert.ok(r.statements > 5);
  }
});

test("reports unknown components with the statement and its line", () => {
  const html = page('root = Stack([a, b])\na = TextContent("x")\nb = Sparkline([1, 2])');
  const r = checkHtml(html);
  assert.equal(r.ok, false);
  const e = r.errors.find((x) => x.code === "unknown-component");
  assert.equal(e.statement, "b");
  assert.equal(e.line, statementLines(html).get("b").line);
});

test("reports unresolved references and orphans", () => {
  const r = checkHtml(page('root = Stack([a, missing])\na = TextContent("x")\nlonely = TextContent("y")'));
  assert.ok(r.errors.some((x) => x.code === "unresolved" && x.statement === "missing"));
  assert.ok(r.warnings.some((x) => x.code === "orphaned" && x.statements.includes("lonely")));
});

test("missing program block is an error", () => {
  const r = checkHtml("<html><body>hi</body></html>");
  assert.equal(r.ok, false);
  assert.equal(r.errors[0].code, "no-program");
});

test("reads, replaces the program and rewrites the runtime tag", () => {
  const html = page('root = Stack([a])\na = TextContent("x")');
  const art = readArtifact(html);
  assert.equal(art.title, "T & t");
  assert.match(art.runtimeSrc, /austere\.js$/);
  assert.equal(art.programLine, 3);
  const next = replaceProgram(html, 'root = Stack([b])\nb = TextContent("$& y")');
  assert.match(next, /b = TextContent\("\$& y"\)/);
  assert.equal(readArtifact(next).shell, art.shell);
  const local = rewriteRuntime(html, '<script src="/__austere/austere.js"></script>');
  assert.match(local, /src="\/__austere\/austere\.js"/);
  assert.doesNotMatch(local, /jsdelivr/);
});
