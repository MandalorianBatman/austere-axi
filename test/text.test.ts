// The plain-text projection of a statement: what the content index stores and `find` searches.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { readArtifact } from "../src/cli/artifact.ts";
import { parseArtifact } from "../src/cli/check.ts";
import { Hub, openDatabase } from "../src/cli/hub.ts";
import { findStatements, recordRevision, reindex, revisionLog } from "../src/cli/history.ts";
import { programText, statementText } from "../src/shared/text.ts";
import type { TextSpec } from "../src/shared/text.ts";

const html = (
  program: string,
  title = "Plan",
) => `<!doctype html><html><head><title>${title}</title><script src="https://cdn.jsdelivr.net/npm/austere-axi@0/dist/austere.js"></script></head>
<body><script type="text/openui">
${program}
</script></body></html>
`;

/** Statement name → text, as the index stores it. */
function textsOf(program: string): Map<string, { component: string; text: string }> {
  const page = html(program);
  const art = readArtifact(page);
  const parsed = parseArtifact(page);
  assert.ok(parsed, "the program parses");
  return new Map(
    programText(art.program as string, parsed.root, parsed.spec).map((t) => [
      t.name,
      { component: t.component, text: t.text },
    ]),
  );
}

test("a table is a Markdown table; a markdown block is its Markdown", () => {
  const t = textsOf(`root = Stack([intro, grid])
intro = MarkDownRenderer("Pick **one**:\\n\\n- fast\\n- safe")
grid = Table([Col("Option", ["Big bang", "Dual|write"]), Col("Days", [2, 5]), Col("Risk", [riskHigh, "low"])])
riskHigh = Tag("high", null, "sm", "danger")`);
  assert.deepEqual(t.get("intro"), {
    component: "MarkDownRenderer",
    text: "Pick **one**:\n\n- fast\n- safe",
  });
  assert.deepEqual(t.get("grid"), {
    component: "Table",
    text: "| Option | Days | Risk |\n| --- | --- | --- |\n| Big bang | 2 | high |\n| Dual\\|write | 5 | low |",
  });
  assert.equal(t.get("riskHigh")?.text, "high", "an enumeration (variant, size) is not text");
});

test("a diagram is its nodes, then one line per edge; a node, an edge and a group read on their own", () => {
  const t = textsOf(`root = Stack([flow])
flow = Architecture([web, api, db], [toApi, toDb], [zone])
web = Node("Web app", "frontend", "React")
api = Node("API", "backend")
db = Node("Postgres", "database", "sessions", "new")
toApi = Edge(web, api, "HTTPS")
toDb = Edge(api, db)
zone = Group("Platform", [api, db])`);
  assert.equal(
    t.get("flow")?.text,
    "nodes: Web app, API, Postgres\nWeb app → API (HTTPS)\nAPI → Postgres",
  );
  assert.equal(t.get("web")?.text, "Web app\nReact", "kind is an enumeration");
  assert.equal(t.get("toApi")?.text, "Web app → API (HTTPS)");
  assert.equal(t.get("zone")?.text, "Platform\nmembers: API, Postgres");
});

test("a diff is its file names with + and − counts, not its body", () => {
  const patch =
    "diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1,2 +1,3 @@\n-old\n+new\n+newer\n keep\ndiff --git a/src/b.ts b/src/b.ts\n--- a/src/b.ts\n+++ b/src/b.ts\n@@ -1 +0,0 @@\n-gone";
  const t = textsOf(
    `root = Stack([change])\nchange = Diff(${JSON.stringify(patch)}, "Retry loop")`,
  );
  assert.equal(t.get("change")?.text, "Retry loop\nsrc/a.ts +2 −1\nsrc/b.ts +0 −1");
  assert.doesNotMatch(t.get("change")?.text ?? "", /newer|gone/);
});

test("a form is its labels and options, with no field ids; a button is its label", () => {
  const t = textsOf(`root = Stack([ask])
ask = Form("rollout", buttons, [strategy, notes])
buttons = Buttons([Button("Send decision", Action([@ToAssistant("Decision: rollout")]))])
strategy = FormControl("Rollout", RadioGroup("strategy", [RadioItem("Big bang", "One deploy", "bigbang"), RadioItem("Dual-write", "Two weeks", "dual")]))
notes = FormControl("Notes", TextArea("notes", "Anything to change?"))`);
  const form = t.get("ask")?.text ?? "";
  for (const want of [
    "Send decision",
    "Rollout",
    "Big bang",
    "One deploy",
    "Dual-write",
    "Two weeks",
    "Notes",
    "Anything to change?",
  ])
    assert.ok(form.includes(want), `${want} is in the form's text: ${form}`);
  assert.doesNotMatch(form, /^rollout$/m, "the form's own name is an id");
  assert.equal(t.get("notes")?.text, "Notes\nAnything to change?");
});

test("a chart is its labels, series names and axis titles, not its numbers", () => {
  const t = textsOf(`root = Stack([latency])
latency = BarChart(["p50", "p99"], [redis, pg], "grouped", "Percentile", "ms")
redis = Series("Redis", [4, 38])
pg = Series("Postgres", [6, 44])`);
  assert.equal(t.get("latency")?.text, "p50\np99\nRedis\nPostgres\nPercentile\nms");
  assert.equal(t.get("redis")?.text, "Redis");
});

test("a pack component reads by the generic rule: its string props in signature order, enumerations left out", () => {
  const spec: TextSpec = {
    $defs: {
      Tooltip: {
        properties: {
          text: { type: "string" },
          tip: { type: "string" },
          side: { type: "string", enum: ["top", "bottom"] },
        },
      },
    },
  };
  const root = {
    type: "element",
    typeName: "Tooltip",
    props: { text: "idempotent", tip: "Safe to run twice.", side: "top" },
    statementId: "hint",
  };
  assert.deepEqual(
    statementText(root, "hint", 'hint = Tooltip("idempotent", "Safe to run twice.", "top")', spec),
    { name: "hint", component: "Tooltip", text: "idempotent\nSafe to run twice." },
  );
});

test("a statement the tree does not hold reads as the strings in its source", () => {
  const t = textsOf(`root = Stack([intro])
intro = TextContent("shown")
spare = TextContent("never shown", "ignored enum")`);
  assert.deepEqual(t.get("spare"), { component: "TextContent", text: "never shown\nignored enum" });
  const plain = textsOf(
    `root = Stack([intro])\nintro = TextContent(label)\nlabel = "just a string"`,
  );
  assert.deepEqual(plain.get("label"), { component: "", text: "just a string" });
});

test("every example page: every statement reads as text, and only containers and shapes read as nothing", () => {
  const examples = path.join(import.meta.dirname, "..", "examples");
  const mayBeEmpty = new Set([
    "Stack",
    "Card",
    "OverviewCardBlock",
    "Tabs",
    "Timeline",
    "Breadcrumb",
    "AvatarGroup",
    "Skeleton",
    // A diagram holds its parts by reference, and each part has a row of its own.
    "Flowchart",
    "StateMachine",
    "Sequence",
    "OrgChart",
    "Tree",
    "Nested",
    "LayerStack",
    "ClassDiagram",
    "ERDiagram",
    "Traceability",
    "ScheduleNetwork",
    "Venn",
    "Pyramid",
    "Loop",
    "WardleyMap",
    // A link with no label carries only its style.
    "FlowLink",
    "Transition",
    "ClassLink",
  ]);
  for (const f of fs.readdirSync(examples).filter((x) => x.endsWith(".html"))) {
    const page = fs.readFileSync(path.join(examples, f), "utf8");
    const art = readArtifact(page);
    const parsed = parseArtifact(page);
    const rows = programText(art.program as string, parsed?.root ?? null, parsed?.spec);
    assert.ok(rows.length > 5, f);
    for (const r of rows)
      assert.ok(
        r.text.trim() || mayBeEmpty.has(r.component),
        `${f}: ${r.name} (${r.component}) reads as nothing`,
      );
  }
});

test("the index follows a patch: a changed, an added and a deleted statement; reindex rebuilds it", async () => {
  const db = await openDatabase(":memory:");
  try {
    const hub = new Hub(db);
    const file = "/work/plan.html";
    hub.register({ id: "aaaaaaaaaaaa", file, title: "Plan" });
    const base = `root = Stack([intro, gone])\nintro = TextContent("hello rollout")\ngone = TextContent("to be deleted")`;
    recordRevision(db, "aaaaaaaaaaaa", html(base), { source: "patch" });
    const rows = () =>
      (
        db
          .prepare(
            "SELECT name, text, rev FROM statements WHERE artifact_id = 'aaaaaaaaaaaa' ORDER BY name",
          )
          .all() as { name: string; text: string; rev: number }[]
      ).map((r) => [r.name, r.text, r.rev]);
    assert.deepEqual(rows(), [
      ["gone", "to be deleted", 1],
      ["intro", "hello rollout", 1],
      ["root", "", 1],
    ]);

    const next = `root = Stack([intro, added])\nintro = TextContent("hello cutover")\nadded = TextContent("brand new")`;
    recordRevision(db, "aaaaaaaaaaaa", html(next), { source: "patch" });
    assert.deepEqual(rows(), [
      ["added", "brand new", 2],
      ["intro", "hello cutover", 2],
      ["root", "", 2],
    ]);
    assert.equal(
      findStatements(db, "rollout", { all: true }).hits.length,
      0,
      "the changed statement is no longer found by its old words",
    );
    assert.deepEqual(
      findStatements(db, "cutover", { all: true }).hits.map((h) => h.statement),
      ["intro"],
    );
    assert.deepEqual(
      findStatements(db, "deleted", { all: true }).hits,
      [],
      "a deleted statement leaves the index",
    );

    // The index is rebuilt from the file; this copy's file does not exist here, so it has no rows after.
    const r = reindex(db);
    assert.equal(r.missing, 1);
    assert.deepEqual(rows(), []);
  } finally {
    db.close();
  }
});

test("without FTS5 the index falls back to LIKE and says so", async () => {
  const db = await openDatabase(":memory:", { fts: false });
  try {
    assert.equal(
      db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'statements_fts'").get(),
      undefined,
      "no FTS table was made",
    );
    const hub = new Hub(db);
    hub.register({ id: "bbbbbbbbbbbb", file: "/work/plan.html", title: "Plan" });
    recordRevision(
      db,
      "bbbbbbbbbbbb",
      html(`root = Stack([intro])\nintro = TextContent("session migration rollout")`),
      { source: "patch" },
    );
    const found = findStatements(db, "migration rollout", { all: true });
    assert.equal(found.fts, false);
    assert.deepEqual(
      found.hits.map((h) => h.statement),
      ["intro"],
    );
  } finally {
    db.close();
  }
});

test("find: a copy whose file is gone does not hide the same statement in a copy that is there", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "austere-find-"));
  const db = await openDatabase(":memory:");
  try {
    const live = path.join(dir, "live.html");
    const gone = path.join(dir, "gone.html");
    fs.writeFileSync(live, html('root = Stack([a])\na = TextContent("shared rollout words")'));
    const hub = new Hub(db);
    hub.register({ id: "cccccccccccc", file: live, title: "Plan", at: 1 });
    hub.register({ id: "dddddddddddd", file: gone, title: "Plan", at: 2 });
    // One page, two copies; the newer one's file was deleted.
    db.exec("UPDATE artifacts SET page_id = 'p1'");
    for (const id of ["cccccccccccc", "dddddddddddd"])
      recordRevision(db, id, html('root = Stack([a])\na = TextContent("shared rollout words")'), {
        source: "patch",
      });
    assert.deepEqual(
      findStatements(db, "rollout").hits.map((h) => [h.file, h.statement]),
      [[live, "a"]],
    );
    assert.deepEqual(
      findStatements(db, "rollout", { all: true }).hits.map((h) => h.missing),
      [true],
      "with --all the page is one hit, the newest copy",
    );
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a value's own spaces are part of the statement: a change inside a string is a change", async () => {
  const db = await openDatabase(":memory:");
  try {
    const hub = new Hub(db);
    hub.register({ id: "eeeeeeeeeeee", file: "/work/plan.html", title: "Plan" });
    recordRevision(db, "eeeeeeeeeeee", html('root = Stack([a])\na = TextContent("a  b")'), {
      source: "patch",
    });
    recordRevision(db, "eeeeeeeeeeee", html('root = Stack([a])\na = TextContent("a b")'), {
      source: "patch",
    });
    recordRevision(db, "eeeeeeeeeeee", html('root = Stack([a])\na   =   TextContent("a b")'), {
      source: "patch",
    });
    // A quote in a comment opens no string.
    recordRevision(
      db,
      "eeeeeeeeeeee",
      html('root = Stack([c])\nc = TextContent(\n// "\n"a  b"\n)'),
      { source: "patch" },
    );
    recordRevision(
      db,
      "eeeeeeeeeeee",
      html('root = Stack([c])\nc = TextContent(\n// "\n"a b"\n)'),
      { source: "patch" },
    );
    assert.deepEqual(
      revisionLog(db, "eeeeeeeeeeee", { statement: "c" }).map((r) => r.rev),
      [5, 4],
    );
    const log = revisionLog(db, "eeeeeeeeeeee", { statement: "a" });
    assert.deepEqual(
      log.map((r) => r.rev),
      [4, 2, 1],
      "spacing inside the string is a change, spacing around it is not (4: the statement is deleted)",
    );
  } finally {
    db.close();
  }
});

test("find keeps looking past a page that fills the first candidates", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "austere-find-many-"));
  const db = await openDatabase(":memory:");
  try {
    const hub = new Hub(db);
    // One page with 80 matching statements, newer than 3 other pages that match once each.
    const rows = (n: number) =>
      Array.from({ length: n }, (_, i) => `s${i} = TextContent("rollout ${i}")`).join("\n");
    const make = (id: string, name: string, program: string, at: number) => {
      const file = path.join(dir, `${name}.html`);
      fs.writeFileSync(file, html(program));
      hub.register({ id, file, title: name, at });
      recordRevision(db, id, html(program), { source: "patch" });
    };
    make("111111111111", "old-a", 'root = Stack([a])\na = TextContent("rollout plan")', 1);
    make("222222222222", "old-b", 'root = Stack([a])\na = TextContent("rollout plan")', 2);
    make("333333333333", "old-c", 'root = Stack([a])\na = TextContent("rollout plan")', 3);
    make(
      "444444444444",
      "big",
      `root = Stack([${Array.from({ length: 80 }, (_, i) => `s${i}`).join(", ")}])\n${rows(80)}`,
      4,
    );
    const hits = findStatements(db, "rollout", { limit: 8 }).hits;
    assert.deepEqual(
      [...new Set(hits.map((h) => path.basename(h.file)))].sort(),
      ["big.html", "old-a.html", "old-b.html", "old-c.html"],
      "every page is found, the big one at most 3 times",
    );
    assert.equal(hits.filter((h) => h.file.endsWith("big.html")).length, 3);
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a database that ran without FTS5 gets its existing statements indexed when FTS is first available", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "austere-fts-late-"));
  const file = path.join(dir, "hub.db");
  try {
    const db = await openDatabase(file, { fts: false });
    new Hub(db).register({ id: "555555555555", file: "/work/plan.html", title: "Plan" });
    recordRevision(
      db,
      "555555555555",
      html('root = Stack([a])\na = TextContent("session migration")'),
      { source: "patch" },
    );
    db.close();
    const later = await openDatabase(file);
    try {
      const found = findStatements(later, "migration", { all: true });
      assert.equal(found.fts, true);
      assert.deepEqual(
        found.hits.map((h) => h.statement),
        ["a"],
        "found without a reindex",
      );
    } finally {
      later.close();
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
