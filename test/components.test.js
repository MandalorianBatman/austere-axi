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

// ── Architecture ──
import { buildModel, layoutModel, textWidth, wrapText } from "../src/runtime/components/_architecture-model.js";

const N = (id, label, kind, detail, tag) => ({ statementId: id, props: { label, kind, detail, tag } });
const E = (id, from, to, label, style) => ({ statementId: id, props: { from, to, label, style } });
const G = (id, label, members, kind) => ({ statementId: id, props: { label, members, kind } });
const overlaps = (a, b) => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
const inside = (inner, outer) =>
  inner.x >= outer.x && inner.y >= outer.y && inner.x + inner.width <= outer.x + outer.width && inner.y + inner.height <= outer.y + outer.height;

test("Architecture model: ids are statement names; nodes referenced only by edges or groups are added", () => {
  const api = N("api", "API", "backend");
  const db = N("db", "Postgres", "database");
  const q = N("q", "Queue", "kafka"); // not a kind → backend
  const m = buildModel({
    nodes: [api],
    edges: [E("e1", api, db, "SQL"), E("e1", api, db), { props: { from: api, to: null } }, { props: { from: api, to: q } }],
    groups: [G("vpc", "VPC", [api, db, q]), G("empty", "Empty", [])],
  });
  assert.deepEqual(m.nodes.map((n) => [n.id, n.kind, n.named]), [["api", "backend", true], ["db", "database", true], ["q", "backend", true]]);
  assert.deepEqual(m.edges.map((e) => [e.from, e.to, e.named]), [["api", "db", true], ["api", "q", false]]);
  assert.deepEqual(m.groups.map((g) => g.id), ["vpc"]);
  assert.deepEqual(m.problems, []);
});

test("Architecture model: subset groups nest; overlapping groups are reported", () => {
  const [a, b, c] = ["a", "b", "c"].map((id) => N(id, id));
  const nested = buildModel({ nodes: [a, b, c], edges: [], groups: [G("outer", "Outer", [a, b, c]), G("inner", "Inner", [b, c])] });
  assert.equal(nested.groups.find((g) => g.id === "inner").parent, "outer");
  assert.deepEqual(nested.problems, []);
  const crossed = buildModel({ nodes: [a, b, c], edges: [], groups: [G("left", "Left", [a, b]), G("right", "Right", [b, c])] });
  assert.equal(crossed.problems.length, 1);
  assert.match(crossed.problems[0], /share b but neither contains the other/);
  // az1 sits inside vpcB; vpcB and vpcC cross. Name those two, not az1.
  const deep = buildModel({ nodes: [a, b, c], edges: [], groups: [G("az1", "AZ 1", [a]), G("vpcB", "B", [a, b]), G("vpcC", "C", [a, c])] });
  assert.equal(deep.problems.length, 1);
  assert.match(deep.problems[0], /^Groups vpcB and vpcC share a/);
  const inside3 = buildModel({ nodes: [a, b, c], edges: [], groups: [G("all", "All", [a, b, c]), G("ab", "AB", [a, b]), G("ac", "AC", [a, c])] });
  assert.match(inside3.problems[0], /^Groups ab and ac share a/);
});

test("Architecture layout: nodes never overlap, groups contain their members, self-loops stay by their node", () => {
  const nodes = ["users", "cdn", "lb", "api", "cache", "db", "queue", "worker"].map((id, i) =>
    N(id, `${id} service with a longer name`, ["external", "cloud", "cloud", "backend", "database", "database", "messagebus", "backend"][i], "detail :8080"),
  );
  const [users, cdn, lb, api, cache, db, queue, worker] = nodes;
  const edges = [E("a", users, cdn, "HTTPS"), E("b", cdn, lb), E("c", lb, api), E("d", api, cache, "read"), E("e", api, db, "SQL"), E("f", api, queue), E("g", queue, worker), E("h", api, api, "retry"), E("h2", api, api, "backoff")];
  for (const direction of ["right", "down", "auto"]) {
    const l = layoutModel(buildModel({ nodes, edges, groups: [G("vpc", "VPC", [lb, api, cache, db]), G("sg", "SG", [lb, api], "security")], direction }));
    for (let i = 0; i < l.nodes.length; i++) for (let j = i + 1; j < l.nodes.length; j++) {
      assert.ok(!overlaps(l.nodes[i], l.nodes[j]), `${direction}: ${l.nodes[i].id} overlaps ${l.nodes[j].id}`);
    }
    for (const g of l.groups) for (const m of g.members) {
      assert.ok(inside(l.nodes.find((n) => n.id === m), g), `${direction}: ${m} escapes group ${g.id}`);
    }
    const node = l.nodes.find((n) => n.id === "api");
    const chips = [];
    for (const loop of l.edges.filter((e) => e.from === e.to)) {
      for (const p of loop.points) assert.ok(p.x >= node.x && p.y >= node.y - 12, `${direction}: self-loop point ${JSON.stringify(p)} strays`);
      const chip = { x: loop.labelBox.cx - loop.labelBox.width / 2, y: loop.labelBox.cy - loop.labelBox.height / 2, width: loop.labelBox.width, height: loop.labelBox.height };
      assert.ok(chip.x + chip.width <= l.width && chip.y + chip.height <= l.height, `${direction}: self-loop label is outside the diagram`);
      for (const n of l.nodes) assert.ok(!overlaps(chip, n), `${direction}: ${loop.id} label covers ${n.id}`);
      for (const other of chips) assert.ok(!overlaps(chip, other), `${direction}: two self-loop labels on one node overlap`);
      chips.push(chip);
      // Across, edges leave from the right side, so loops hang below the node.
      if (l.rankdir === "LR") assert.ok(loop.points.every((p) => p.y >= node.y + node.height - 1), `${direction}: loop is not under its node`);
      else assert.ok(loop.points.every((p) => p.x >= node.x + node.width - 1), `${direction}: loop is not right of its node`);
    }
    assert.equal(chips.length, 2);
  }
});

test("Architecture layout: auto runs across with room and down on a phone", () => {
  const chain = ["a", "b", "c", "d", "e", "f"].map((id) => N(id, `${id} service`));
  const edges = chain.slice(1).map((n, i) => E(`e${i}`, chain[i], n));
  const model = buildModel({ nodes: chain, edges });
  assert.equal(layoutModel(model, 2000).rankdir, "LR");
  assert.equal(layoutModel(model, 360).rankdir, "TB");
  assert.equal(layoutModel(buildModel({ nodes: chain, edges, direction: "right" }), 360).rankdir, "LR");
  assert.equal(layoutModel(buildModel({ nodes: [], edges: [] })), null);
});

test("Architecture layout: when neither direction is legible, auto prefers down unless across is clearly larger", () => {
  // The cold-start author's notification-service diagram, verbatim: three zones, long edge labels.
  const app = N("app", "Web and mobile apps", "frontend");
  const monolith = N("monolith", "Monolith", "backend", "orders, accounts");
  const auth = N("auth", "Auth", "security", "sessions, token issuer");
  const kafka = N("kafka", "Kafka", "messagebus", "orders.*, accounts.*");
  const consumer = N("consumer", "Event consumer", "backend", "consumer group", "new");
  const prefsApi = N("prefsApi", "Preferences API", "backend", "REST, user-facing", "new");
  const prefsDb = N("prefsDb", "Preferences DB", "database", "Postgres", "new");
  const ses = N("ses", "Amazon SES", "external", "email");
  const fcm = N("fcm", "Firebase Cloud Messaging", "external", "push");
  const model = buildModel({
    nodes: [app, monolith, auth, kafka, consumer, prefsApi, prefsDb, ses, fcm],
    edges: [
      E("appToPrefs", app, prefsApi, "HTTPS + user token", "security"),
      E("prefsToAuth", prefsApi, auth, "verify token (signing keys)", "security"),
      E("monolithToKafka", monolith, kafka, "publish events", "dashed"),
      E("kafkaToConsumer", kafka, consumer, "consume", "dashed"),
      E("consumerToDb", consumer, prefsDb, "read preferences"),
      E("prefsToDb", prefsApi, prefsDb, "read / write"),
      E("consumerToSes", consumer, ses, "send email", "emphasis"),
      E("consumerToFcm", consumer, fcm, "send push", "emphasis"),
    ],
    groups: [
      G("monolithZone", "Monolith zone (owns auth)", [monolith, auth], "security"),
      G("notifZone", "Notifications zone (owns preferences)", [consumer, prefsApi, prefsDb], "security"),
      G("providers", "Third-party providers", [ses, fcm], "region"),
    ],
  });
  const lr = layoutModel({ ...model, direction: "right" });
  const tb = layoutModel({ ...model, direction: "down" });
  const auto = layoutModel(model, 900);
  // Across does not fit legibly at page width, and it is not clearly bigger than down.
  assert.ok(900 / lr.width < 0.85, `lr=${lr.width}`);
  assert.equal(auto.rankdir, "TB", `lr=${lr.width} tb=${tb.width}`);
});

test("Architecture text: wrapping keeps lines within width and marks a cut", () => {
  const lines = wrapText("SESSIONS_PG_READ_THROUGH_CACHE_TTL_SECONDS_OVERRIDE_FOR_STAGING", 13, 160, 2);
  assert.equal(lines.length, 2);
  assert.ok(lines.every((l) => textWidth(l, 13) <= 160), JSON.stringify(lines));
  assert.ok(lines[1].endsWith("…"));
  assert.deepEqual(wrapText("API", 13, 160, 2), ["API"]);
  assert.deepEqual(wrapText("", 13, 160, 2), [""]);
  // A pasted 20 kB token is cut quickly, and an emoji is never split in half.
  const t0 = performance.now();
  const huge = wrapText("x".repeat(20000), 13, 160, 2);
  assert.ok(performance.now() - t0 < 200, `took ${performance.now() - t0} ms`);
  assert.equal(huge.length, 2);
  const emoji = wrapText("📦".repeat(40), 13, 100, 2);
  assert.ok(emoji.every((l) => !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(l)), JSON.stringify(emoji));
});
