// Unit tables for component input parsing. Agents write many near-miss
// shapes; each must parse to what the agent meant, never throw, and never
// invent folders.
import assert from "node:assert/strict";
import test from "node:test";
import { parseUnifiedDiff } from "../src/runtime/components/_diff-parse.js";
import { buildTree, parseEntries, parseEntry, summarize } from "../src/runtime/components/_filetree-parse.js";

const pick = (e) => e && { path: e.path, status: e.status?.key, note: e.note, from: e.from, isDir: e.isDir || undefined };

test("FileTree entries: status codes, notes, renames", () => {
  const cases = [
    ["M src/a.ts", { path: "src/a.ts", status: "modified" }],
    ["A src/new.ts # why", { path: "src/new.ts", status: "added", note: "why" }],
    ["?? src/plan.ts", { path: "src/plan.ts", status: "added" }],
    [" M src/a.ts", { path: "src/a.ts", status: "modified" }],
    ["MM src/a.ts", { path: "src/a.ts", status: "modified" }],
    ["T scripts/deploy.sh", { path: "scripts/deploy.sh", status: "modified" }],
    ["UU src/conflict.ts", { path: "src/conflict.ts", status: "conflict" }],
    ["D old.ts", { path: "old.ts", status: "deleted" }],
    ["R old/a.ts -> new/a.ts", { path: "new/a.ts", status: "renamed", from: "old/a.ts" }],
    ["R100 src/a.ts -> src/b.ts", { path: "src/b.ts", status: "renamed", from: "src/a.ts" }],
    ["src/a.ts -> src/b.ts", { path: "src/b.ts", status: "renamed", from: "src/a.ts" }],
    ["- src/bullet.ts", { path: "src/bullet.ts" }],
    ["* M src/bullet.ts", { path: "src/bullet.ts", status: "modified" }],
    ["m src/lower.ts", { path: "src/lower.ts", status: "modified" }],
    ["modified:   src/long.ts", { path: "src/long.ts", status: "modified" }],
    ["new file:   src/n.ts", { path: "src/n.ts", status: "added" }],
    ["src/x.ts #tight", { path: "src/x.ts", note: "tight" }],
    ["src/x.ts # ", { path: "src/x.ts" }],
    ["C#/Program.cs", { path: "C#/Program.cs" }],
    ["./src/rel.ts", { path: "src/rel.ts" }],
    ["src\\win\\path.ts", { path: "src/win/path.ts" }],
    ["docs/", { path: "docs", isDir: true }],
    ["/etc/nginx/app.conf", { path: "/etc/nginx/app.conf" }],
    ["Makefile", { path: "Makefile" }],
  ];
  for (const [input, want] of cases) {
    const got = pick(parseEntry(input));
    for (const k of Object.keys(got)) if (got[k] === undefined) delete got[k];
    assert.deepEqual(got, want, JSON.stringify(input));
  }
});

test("FileTree entries: junk is ignored, never thrown", () => {
  for (const junk of ["", "   ", null, undefined, 42, {}, [], "# only a note"]) {
    assert.doesNotThrow(() => parseEntry(junk));
  }
  assert.equal(parseEntry(""), null);
  assert.equal(parseEntry(null), null);
  assert.deepEqual(parseEntries(null), []);
});

test("FileTree tree: parts are the paths as written, folders end in /", () => {
  const tree = buildTree(parseEntries(["M /etc/nginx/app.conf", "A src/session/a.ts", "M src/session/b.ts", "src/x.ts"]));
  const parts = [];
  const walk = (n) => n.children.forEach((c) => (parts.push([c.name, c.part]), walk(c)));
  walk(tree);
  assert.deepEqual(parts, [
    ["/etc/nginx", "/etc/nginx/"],
    ["app.conf", "/etc/nginx/app.conf"],
    ["src", "src/"],
    ["session", "src/session/"],
    ["a.ts", "src/session/a.ts"],
    ["b.ts", "src/session/b.ts"],
    ["x.ts", "src/x.ts"],
  ]);
});

test("FileTree: duplicates collapse (last wins) and the summary counts files", () => {
  const tree = buildTree(parseEntries(["M src/a.ts", "A src/a.ts # second", "D src/b.ts", "src/c/"]));
  const a = tree.children.get("src").children.get("a.ts");
  assert.equal(a.status.key, "added");
  assert.equal(a.note, "second");
  assert.deepEqual(summarize(tree), { files: 2, parts: [{ key: "added", count: 1 }, { key: "deleted", count: 1 }] });
});

test("FileTree: a rename within one folder shows only the old name", () => {
  const tree = buildTree(parseEntries(["R src/hooks/useSession.ts -> src/hooks/useSessionStore.ts", "R a/x.ts -> b/x.ts"]));
  const hooks = tree.children.get("src"); // compressed: shown as "src/hooks", keyed by its first segment
  assert.equal(hooks.name, "src/hooks");
  assert.equal(hooks.children.get("useSessionStore.ts").from, "useSession.ts");
  assert.equal(tree.children.get("b").children.get("x.ts").from, "a/x.ts");
});

test("Diff: hunk headers show counts that match the lines given", () => {
  const files = parseUnifiedDiff(
    "--- /dev/null\n+++ b/new.ts\n@@ -0,0 +1,52 @@\n+a\n+b\ndiff --git a/x.ts b/x.ts\n--- a/x.ts\n+++ b/x.ts\n@@ -10,9 +10,15 @@ fn()\n ctx\n-old\n+new\n+new2",
  );
  assert.deepEqual(
    files.map((f) => [f.name, f.rows.filter((r) => r.kind === "hunk").map((r) => r.text)]),
    [
      ["new.ts", ["@@ -0,0 +1,2 @@"]],
      ["x.ts", ["@@ -10,2 +10,3 @@ fn()"]],
    ],
  );
  const x = files[1].rows.filter((r) => r.kind !== "hunk");
  assert.deepEqual(x.map((r) => [r.kind, r.oldNo, r.newNo]), [["ctx", 10, 10], ["del", 11, undefined], ["add", undefined, 11], ["add", undefined, 12]]);
});
