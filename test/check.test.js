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

test("a bad statement referenced several times is reported once", () => {
  const r = checkHtml(
    page(`root = Stack([diagram])
diagram = Architecture([api, db], [toDb], [zone])
api = Node("API", "kafka")
db = Node("DB", "database")
toDb = Edge(api, db)
zone = Group("Zone", [api, db])`),
  );
  const bad = r.errors.filter((e) => e.statement === "api");
  assert.equal(bad.length, 1, JSON.stringify(r.errors));
});

test("check warns when a diagram will not lay out as written: crossing groups, too many lanes, forced direction too wide", () => {
  const lanes = (n) => {
    const nodes = Array.from({ length: n }, (_, i) => `n${i} = Node("Service number ${i} with a name", "backend", "detail")`);
    const groups = Array.from({ length: n }, (_, i) => `g${i} = Group("TEAM ${i}", [n${i}])`);
    const edges = Array.from({ length: n - 1 }, (_, i) => `e${i} = Edge(n${i}, n${i + 1}, "a label of some length")`);
    return page(
      [`root = Stack([d])`, `d = Architecture([${nodes.map((_, i) => `n${i}`)}], [${edges.map((_, i) => `e${i}`)}], [${groups.map((_, i) => `g${i}`)}], "lanes")`, ...nodes, ...groups, ...edges].join("\n"),
    );
  };
  assert.deepEqual(checkHtml(lanes(3)).warnings, []);
  const wide = checkHtml(lanes(7)).warnings.find((w) => w.code === "architecture-layout");
  assert.ok(wide, "seven lanes should warn");
  assert.equal(wide.statement, "d");
  assert.match(wide.message, /scroll sideways/);

  const crossed = checkHtml(page('root = Stack([d])\nd = Architecture([a, b, c], [], [l, r])\na = Node("A")\nb = Node("B")\nc = Node("C")\nl = Group("L", [a, b])\nr = Group("R", [b, c])'));
  assert.ok(crossed.warnings.some((w) => w.code === "architecture" && /neither contains the other/.test(w.message)));

  const chain = Array.from({ length: 14 }, (_, i) => `n${i} = Node("Step ${i} of the pipeline")`);
  const steps = Array.from({ length: 13 }, (_, i) => `e${i} = Edge(n${i}, n${i + 1})`);
  const right = checkHtml(page([`root = Stack([d])`, `d = Architecture([${chain.map((_, i) => `n${i}`)}], [${steps.map((_, i) => `e${i}`)}], null, "right")`, ...chain, ...steps].join("\n")));
  assert.ok(right.warnings.some((w) => w.code === "architecture-layout" && /scrolls sideways/.test(w.message)));
});

test("check suggests auto only when auto fits, and warns once for a diagram shown twice", () => {
  const chain = (n, label) => Array.from({ length: n }, (_, i) => `n${i} = Node("${label} ${i}")`);
  const steps = (n) => Array.from({ length: n - 1 }, (_, i) => `e${i} = Edge(n${i}, n${i + 1})`);
  const diagram = (n, label, direction) =>
    `d = Architecture([${Array.from({ length: n }, (_, i) => `n${i}`)}], [${Array.from({ length: n - 1 }, (_, i) => `e${i}`)}], null, "${direction}")\n${[...chain(n, label), ...steps(n)].join("\n")}`;
  // Forced across, but auto (down) fits: suggest auto.
  const fits = checkHtml(page(`root = Stack([d])\n${diagram(9, "Step", "right")}`)).warnings.find((w) => w.code === "architecture-layout");
  assert.match(fits.message, /Leave direction out/);
  // A long chain ending in a wide fan-out fits neither across nor down: never suggest auto.
  const ids = [...Array.from({ length: 9 }, (_, i) => `c${i}`), ...Array.from({ length: 12 }, (_, i) => `f${i}`)];
  const defs = ids.map((id) => `${id} = Node("Service ${id} with a long name")`);
  const links = [...Array.from({ length: 8 }, (_, i) => `l${i} = Edge(c${i}, c${i + 1})`), ...Array.from({ length: 12 }, (_, i) => `k${i} = Edge(c8, f${i})`)];
  const linkIds = links.map((l) => l.split(" ")[0]);
  const wide = checkHtml(page(`root = Stack([d])\nd = Architecture([${ids}], [${linkIds}], null, "down")\n${defs.join("\n")}\n${links.join("\n")}`)).warnings.find(
    (w) => w.code === "architecture-layout",
  );
  assert.ok(wide, "a 12-way fan-out does not fit");
  assert.doesNotMatch(wide.message, /Leave direction out/);
  // One diagram in two tabs: one warning.
  const twice = checkHtml(page(`root = Stack([tabs])\ntabs = Tabs([t1, t2])\nt1 = TabItem("a", "A", [d])\nt2 = TabItem("b", "B", [d])\n${diagram(9, "Step", "right")}`));
  assert.equal(twice.warnings.filter((w) => w.code === "architecture-layout").length, 1);
});
