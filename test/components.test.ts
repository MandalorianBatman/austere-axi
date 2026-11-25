// Unit tables for component input parsing. Agents write many near-miss
// shapes; each must parse to what the agent meant, never throw, and never
// invent folders.
import assert from "node:assert/strict";
import test from "node:test";
import { parseUnifiedDiff } from "../src/runtime/components/_diff-parse.ts";
import type { DiffRow } from "../src/runtime/components/_diff-parse.ts";
import {
  buildTree,
  parseEntries,
  parseEntry,
  summarize,
} from "../src/runtime/components/_filetree-parse.ts";
import type { FileEntry, TreeNode } from "../src/runtime/components/_filetree-parse.ts";
import {
  FLOWCHART,
  STATE_MACHINE,
  buildFlow,
  flowNotes,
  layoutFlow,
} from "../src/runtime/components/_flow-model.ts";
import type { FlowLaidOutNode } from "../src/runtime/components/_flow-model.ts";
import { ORG_CHART, TREE } from "../src/runtime/components/_tree-model.ts";
import { parseCardinality, parseField } from "../src/runtime/components/_data-parse.ts";
import { CLASS_DIAGRAM, ER_DIAGRAM } from "../src/runtime/components/_data-model.ts";
import {
  buildBlueprint,
  buildEventModel,
  buildJourney,
  buildKanban,
  buildStoryMap,
} from "../packs/diagrams/src/_board-model.ts";
import {
  buildHeatmap,
  buildPermissions,
  buildTrace,
  buildUnitGrid,
  inkFor,
  luminance,
  parseAccess,
  rampFill,
} from "../packs/diagrams/src/_matrix-model.ts";
import {
  buildGantt,
  buildGitGraph,
  buildSchedule,
  layoutSchedule,
} from "../packs/diagrams/src/_plan-model.ts";
import {
  QUAD,
  buildPyramid,
  buildQuadrant,
  buildVenn,
  buildWardley,
  layoutFishbone,
  layoutLoop,
} from "../packs/diagrams/src/_shape-model.ts";
import {
  buildPolar,
  buildRadar,
  buildSankey,
  buildTreemap,
  buildWaterfall,
  squarify,
} from "../packs/diagrams/src/_quantity-model.ts";
import { LAYER_SPEC, NESTED_SPEC, buildLevels } from "../packs/diagrams/src/_containment-model.ts";

const pick = (e: FileEntry | null): Record<string, unknown> | null =>
  e && {
    path: e.path,
    status: e.status?.key,
    note: e.note,
    from: e.from,
    isDir: e.isDir || undefined,
  };

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
    if (got) for (const k of Object.keys(got)) if (got[k] === undefined) delete got[k];
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
  const tree = buildTree(
    parseEntries(["M /etc/nginx/app.conf", "A src/session/a.ts", "M src/session/b.ts", "src/x.ts"]),
  );
  const parts: [string, string | undefined][] = [];
  const walk = (n: TreeNode) => n.children.forEach((c) => (parts.push([c.name, c.part]), walk(c)));
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
  const tree = buildTree(
    parseEntries(["M src/a.ts", "A src/a.ts # second", "D src/b.ts", "src/c/"]),
  );
  const a = tree.children.get("src")?.children.get("a.ts");
  assert.equal(a?.status?.key, "added");
  assert.equal(a?.note, "second");
  assert.deepEqual(summarize(tree), {
    files: 2,
    parts: [
      { key: "added", count: 1 },
      { key: "deleted", count: 1 },
    ],
  });
});

test("FileTree: a rename within one folder shows only the old name", () => {
  const tree = buildTree(
    parseEntries([
      "R src/hooks/useSession.ts -> src/hooks/useSessionStore.ts",
      "R a/x.ts -> b/x.ts",
    ]),
  );
  const hooks = tree.children.get("src"); // compressed: shown as "src/hooks", keyed by its first segment
  assert.equal(hooks?.name, "src/hooks");
  assert.equal(hooks?.children.get("useSessionStore.ts")?.from, "useSession.ts");
  assert.equal(tree.children.get("b")?.children.get("x.ts")?.from, "a/x.ts");
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
  const x = files[1].rows.filter((r: DiffRow) => r.kind !== "hunk");
  assert.deepEqual(
    x.map((r) => [r.kind, "oldNo" in r ? r.oldNo : undefined, "newNo" in r ? r.newNo : undefined]),
    [
      ["ctx", 10, 10],
      ["del", 11, undefined],
      ["add", undefined, 11],
      ["add", undefined, 12],
    ],
  );
});

// ── Architecture ──
import {
  buildModel,
  layoutModel,
  textWidth,
  wantsWidePage,
  wrapText,
} from "../src/runtime/components/_architecture-model.ts";
import type { Layout, Point } from "../src/runtime/components/_architecture-model.ts";

interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}
interface El {
  statementId?: string;
  props: Record<string, unknown>;
}

/** layoutModel for a diagram that has nodes, so a layout always comes back. */
function laid(...args: Parameters<typeof layoutModel>): Layout {
  const l: Layout | null = layoutModel(...args);
  if (!l) throw new Error("no layout");
  return l;
}

const N = (
  id: string,
  label?: string,
  kind?: string,
  detail?: string,
  tag?: string | null,
  tone?: string,
  row?: number,
): El => ({ statementId: id, props: { label, kind, detail, tag, tone, row } });
const E = (id: string, from: El, to: El, label?: string, style?: string): El => ({
  statementId: id,
  props: { from, to, label, style },
});
const G = (id: string, label: string, members: El[], kind?: string): El => ({
  statementId: id,
  props: { label, members, kind },
});
const overlaps = (a: Box, b: Box) =>
  a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
const inside = (inner: Box, outer: Box) =>
  inner.x >= outer.x &&
  inner.y >= outer.y &&
  inner.x + inner.width <= outer.x + outer.width &&
  inner.y + inner.height <= outer.y + outer.height;

test("Architecture model: ids are statement names; nodes referenced only by edges or groups are added", () => {
  const api = N("api", "API", "backend");
  const db = N("db", "Postgres", "database");
  const q = N("q", "Queue", "kafka"); // not a kind → backend
  const m = buildModel({
    nodes: [api],
    edges: [
      E("e1", api, db, "SQL"),
      E("e1", api, db),
      { props: { from: api, to: null } },
      { props: { from: api, to: q } },
    ],
    groups: [G("vpc", "VPC", [api, db, q]), G("empty", "Empty", [])],
  });
  assert.deepEqual(
    m.nodes.map((n) => [n.id, n.kind, n.named]),
    [
      ["api", "backend", true],
      ["db", "database", true],
      ["q", "backend", true],
    ],
  );
  assert.deepEqual(
    m.edges.map((e) => [e.from, e.to, e.named]),
    [
      ["api", "db", true],
      ["api", "q", false],
    ],
  );
  assert.deepEqual(
    m.groups.map((g) => g.id),
    ["vpc"],
  );
  assert.deepEqual(m.problems, []);
});

test("Architecture model: subset groups nest; overlapping groups are reported", () => {
  const [a, b, c] = ["a", "b", "c"].map((id) => N(id, id));
  const nested = buildModel({
    nodes: [a, b, c],
    edges: [],
    groups: [G("outer", "Outer", [a, b, c]), G("inner", "Inner", [b, c])],
  });
  assert.equal(nested.groups.find((g) => g.id === "inner")?.parent, "outer");
  assert.deepEqual(nested.problems, []);
  const crossed = buildModel({
    nodes: [a, b, c],
    edges: [],
    groups: [G("left", "Left", [a, b]), G("right", "Right", [b, c])],
  });
  assert.equal(crossed.problems.length, 1);
  assert.match(crossed.problems[0], /share b but neither contains the other/);
  // az1 sits inside vpcB; vpcB and vpcC cross. Name those two, not az1.
  const deep = buildModel({
    nodes: [a, b, c],
    edges: [],
    groups: [G("az1", "AZ 1", [a]), G("vpcB", "B", [a, b]), G("vpcC", "C", [a, c])],
  });
  assert.equal(deep.problems.length, 1);
  assert.match(deep.problems[0], /^Groups vpcB and vpcC share a/);
  const inside3 = buildModel({
    nodes: [a, b, c],
    edges: [],
    groups: [G("all", "All", [a, b, c]), G("ab", "AB", [a, b]), G("ac", "AC", [a, c])],
  });
  assert.match(inside3.problems[0], /^Groups ab and ac share a/);
});

test("Architecture layout: nodes never overlap, groups contain their members, self-loops stay by their node", () => {
  const nodes = ["users", "cdn", "lb", "api", "cache", "db", "queue", "worker"].map((id, i) =>
    N(
      id,
      `${id} service with a longer name`,
      ["external", "cloud", "cloud", "backend", "database", "database", "messagebus", "backend"][i],
      "detail :8080",
    ),
  );
  const [users, cdn, lb, api, cache, db, queue, worker] = nodes;
  const edges = [
    E("a", users, cdn, "HTTPS"),
    E("b", cdn, lb),
    E("c", lb, api),
    E("d", api, cache, "read"),
    E("e", api, db, "SQL"),
    E("f", api, queue),
    E("g", queue, worker),
    E("h", api, api, "retry"),
    E("h2", api, api, "backoff"),
  ];
  for (const direction of ["right", "down", "auto"]) {
    const l = laid(
      buildModel({
        nodes,
        edges,
        groups: [G("vpc", "VPC", [lb, api, cache, db]), G("sg", "SG", [lb, api], "security")],
        direction,
      }),
    );
    for (let i = 0; i < l.nodes.length; i++)
      for (let j = i + 1; j < l.nodes.length; j++) {
        assert.ok(
          !overlaps(l.nodes[i], l.nodes[j]),
          `${direction}: ${l.nodes[i].id} overlaps ${l.nodes[j].id}`,
        );
      }
    for (const g of l.groups)
      for (const m of g.members) {
        assert.ok(
          inside(l.nodes.find((n) => n.id === m) ?? assert.fail(m), g),
          `${direction}: ${m} escapes group ${g.id}`,
        );
      }
    const node = l.nodes.find((n) => n.id === "api") ?? assert.fail("api");
    const chips: Box[] = [];
    for (const loop of l.edges.filter((e) => e.from === e.to)) {
      for (const p of loop.points)
        assert.ok(
          p.x >= node.x && p.y >= node.y - 12,
          `${direction}: self-loop point ${JSON.stringify(p)} strays`,
        );
      if (!loop.labelBox) assert.fail(`${direction}: ${loop.id} has no label box`);
      const chip = {
        x: loop.labelBox.cx - loop.labelBox.width / 2,
        y: loop.labelBox.cy - loop.labelBox.height / 2,
        width: loop.labelBox.width,
        height: loop.labelBox.height,
      };
      assert.ok(
        chip.x + chip.width <= l.width && chip.y + chip.height <= l.height,
        `${direction}: self-loop label is outside the diagram`,
      );
      for (const n of l.nodes)
        assert.ok(!overlaps(chip, n), `${direction}: ${loop.id} label covers ${n.id}`);
      for (const other of chips)
        assert.ok(!overlaps(chip, other), `${direction}: two self-loop labels on one node overlap`);
      chips.push(chip);
      // Across, edges leave from the right side, so loops hang below the node.
      if (l.rankdir === "LR")
        assert.ok(
          loop.points.every((p) => p.y >= node.y + node.height - 1),
          `${direction}: loop is not under its node`,
        );
      else
        assert.ok(
          loop.points.every((p) => p.x >= node.x + node.width - 1),
          `${direction}: loop is not right of its node`,
        );
    }
    assert.equal(chips.length, 2);
  }
});

test("Architecture layout: auto runs across with room and down on a phone", () => {
  const chain = ["a", "b", "c", "d", "e", "f"].map((id) => N(id, `${id} service`));
  const edges = chain.slice(1).map((n, i) => E(`e${i}`, chain[i], n));
  const model = buildModel({ nodes: chain, edges });
  assert.equal(laid(model, 2000).rankdir, "LR");
  assert.equal(laid(model, 360).rankdir, "TB");
  assert.equal(laid(buildModel({ nodes: chain, edges, direction: "right" }), 360).rankdir, "LR");
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
      G(
        "notifZone",
        "Notifications zone (owns preferences)",
        [consumer, prefsApi, prefsDb],
        "security",
      ),
      G("providers", "Third-party providers", [ses, fcm], "region"),
    ],
  });
  const lr = laid({ ...model, direction: "right" });
  const tb = laid({ ...model, direction: "down" });
  const auto = laid(model, 900);
  // Across does not fit legibly at page width, and it is not clearly bigger than down.
  assert.ok(900 / lr.width < 0.85, `lr=${lr.width}`);
  assert.equal(auto.rankdir, "TB", `lr=${lr.width} tb=${tb.width}`);
});

test("Architecture text: wrapping keeps lines within width and marks a cut", () => {
  const lines = wrapText(
    "SESSIONS_PG_READ_THROUGH_CACHE_TTL_SECONDS_OVERRIDE_FOR_STAGING",
    13,
    160,
    2,
  );
  assert.equal(lines.length, 2);
  assert.ok(
    lines.every((l) => textWidth(l, 13) <= 160),
    JSON.stringify(lines),
  );
  assert.ok(lines[1].endsWith("…"));
  assert.deepEqual(wrapText("API", 13, 160, 2), ["API"]);
  assert.deepEqual(wrapText("", 13, 160, 2), [""]);
  // A pasted 20 kB token is cut quickly, and an emoji is never split in half.
  const t0 = performance.now();
  const huge = wrapText("x".repeat(20000), 13, 160, 2);
  assert.ok(performance.now() - t0 < 200, `took ${performance.now() - t0} ms`);
  assert.equal(huge.length, 2);
  const emoji = wrapText("📦".repeat(40), 13, 100, 2);
  assert.ok(
    emoji.every((l) => !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(l)),
    JSON.stringify(emoji),
  );
});

// ── Architecture lanes ──

const treasury = (direction = "lanes", pins: Record<string, number> = {}) => {
  const n = (id: string, label: string, kind: string, detail: string, tone?: string) =>
    N(id, label, kind, detail, null, tone, pins[id]);
  const nodes = {
    brokers: n(
      "brokers",
      "~35 brokers / clearers",
      "external",
      "SFTP · email · HTTP\nPDF · CSV · DB",
    ),
    refData: n(
      "refData",
      "Reference data",
      "external",
      "accounts→team→entity\nFX, secmaster, Oracle",
    ),
    scheduler: n("scheduler", "Scheduler (Airflow)", "external", "88 bash entrypoints"),
    cli: n("cli", "MarginPush CLI", "backend", "click"),
    factory: n("factory", "HelperFactory", "backend", "35 ES / 27 PG"),
    adapters: n(
      "adapters",
      "Broker adapters *Helper / *Parser",
      "backend",
      "normalize → enrich → add_aggregates",
    ),
    elasticPush: n("elasticPush", "elastic_push", "backend", "raw frame, full prec\nPROD only"),
    treasuryHelper: n(
      "treasuryHelper",
      "*TreasuryHelper ×27",
      "backend",
      "5 levels, 2dp\nmay overwrite MU",
      "danger",
    ),
    reports: n("reports", "Reports: consolidated, CAF, validation", "backend", "read ES"),
    esMU: n(
      "esMU",
      "ES margin_utilization",
      "database",
      "pt-margin2 · ~2M docs\n35 brokers + ABN_COH",
      "info",
    ),
    pgTreasury: n(
      "pgTreasury",
      "PG treasurydb",
      "database",
      "unencumbered_cash\n27 brokers · 5 levels",
      "success",
    ),
    pgTables: n(
      "pgTables",
      "PG treasury tables",
      "database",
      "abn_coh_summary,\nbroker_level_summary…",
      "success",
    ),
    abnCoh: n("abnCoh", "abn_coh_summary", "backend", "writes ES + PG"),
    collateral: n(
      "collateral",
      "collateral_alert*",
      "backend",
      "trends, gs_us alerts\ntrce_liquidity",
      "danger",
    ),
    fx: n("fx", "FX / financing", "backend", "27 interest procs\nfx_exposure"),
    crypto: n("crypto", "Crypto / India PnL", "backend", "exchange APIs"),
    torstone: n("torstone", "Torstone GL", "backend", "trial balances"),
    slack: n("slack", "Slack / dashboards", "frontend", "operators act", "strong"),
  };
  const x = nodes;
  return buildModel({
    nodes: Object.values(nodes),
    edges: [
      E("e1", x.brokers, x.adapters),
      E("e2", x.refData, x.adapters),
      E("e3", x.scheduler, x.cli),
      E("e4", x.cli, x.factory),
      E("e5", x.factory, x.adapters),
      E("e6", x.adapters, x.elasticPush),
      E("e7", x.adapters, x.treasuryHelper),
      E("bulk", x.elasticPush, x.esMU, "bulk"),
      {
        statementId: "delIns",
        props: { from: x.treasuryHelper, to: x.pgTreasury, label: "del+ins", tone: "danger" },
      },
      {
        statementId: "abn",
        props: { from: x.abnCoh, to: x.esMU, label: "ABN_COH", tone: "danger" },
      },
      E("r1", x.pgTreasury, x.collateral),
      E("r2", x.pgTreasury, x.fx),
      E("w1", x.abnCoh, x.pgTables),
      E("bl", x.fx, x.pgTables, "broker_level"),
      E("al", x.collateral, x.slack),
      E("rep", x.esMU, x.reports, "read", "dashed"),
      E("retry", x.adapters, x.adapters, "retry"),
    ],
    groups: [
      G("external", "EXTERNAL", [x.brokers, x.refData, x.scheduler], "plain"),
      G("margin", "margin-reporting · py3.6", [
        x.cli,
        x.factory,
        x.adapters,
        x.elasticPush,
        x.treasuryHelper,
        x.reports,
      ]),
      G("stores", "STORES", [x.esMU, x.pgTreasury, x.pgTables], "plain"),
      G("pt", "pt-treasury", [x.abnCoh, x.collateral, x.fx, x.crypto, x.torstone, x.slack]),
    ],
    direction,
  });
};

/** Invariants every lanes or stacked layout keeps; returns problems found. */
function laneProblems(l: Layout): string[] {
  const out: string[] = [];
  const box = new Map(l.nodes.map((n) => [n.id, n]));
  const strictlyInside = (p: Point, b: Box) =>
    p.x > b.x + 0.5 && p.x < b.x + b.width - 0.5 && p.y > b.y + 0.5 && p.y < b.y + b.height - 0.5;
  for (let i = 0; i < l.nodes.length; i++) {
    for (let j = i + 1; j < l.nodes.length; j++)
      if (overlaps(l.nodes[i], l.nodes[j])) out.push(`${l.nodes[i].id} overlaps ${l.nodes[j].id}`);
    const n = l.nodes[i];
    if (![n.x, n.y, n.width, n.height].every(Number.isFinite))
      out.push(`${n.id} has a non-finite box`);
  }
  for (const e of l.edges) {
    const pts = e.points;
    if (!pts.every((p) => Number.isFinite(p.x) && Number.isFinite(p.y)))
      out.push(`${e.id} has non-finite points`);
    for (let k = 1; k < pts.length; k++) {
      const a = pts[k - 1];
      const b = pts[k];
      if (a.x !== b.x && a.y !== b.y) out.push(`${e.id} has a slanted segment`);
      // Sample the segment: it never runs through a box.
      for (let t = 0.05; t < 1; t += 0.1) {
        const p = { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
        const hit = l.nodes.find((n) => strictlyInside(p, n));
        if (hit) {
          out.push(`${e.id} runs through ${hit.id}`);
          break;
        }
      }
    }
    if (e.from !== e.to) {
      const onBorder = (p: Point | undefined, b: Box | undefined) =>
        !!p &&
        !!b &&
        (p.x === b.x || p.x === b.x + b.width || p.y === b.y || p.y === b.y + b.height) &&
        p.x >= b.x &&
        p.x <= b.x + b.width &&
        p.y >= b.y &&
        p.y <= b.y + b.height;
      if (!onBorder(pts[0], box.get(e.from))) out.push(`${e.id} does not start on ${e.from}`);
      if (!onBorder(pts.at(-1), box.get(e.to))) out.push(`${e.id} does not end on ${e.to}`);
    }
    if (e.labelBox) {
      const r = {
        x: e.labelBox.cx - e.labelBox.width / 2,
        y: e.labelBox.cy - e.labelBox.height / 2,
        width: e.labelBox.width,
        height: e.labelBox.height,
      };
      const hit = l.nodes.find((n) => overlaps(r, n));
      if (hit) out.push(`${e.id} label covers ${hit.id}`);
    }
  }
  // A node sits in a lane frame (its own lane when groups do not cross).
  const lanes = l.groups.filter((x) => x.lane);
  for (const n of l.nodes) {
    const own = lanes.filter((g) => g.members.includes(n.id));
    if (own.length && !own.some((g) => inside(n, g)))
      out.push(`${n.id} is outside lane ${own[0].id}`);
  }
  return out;
}

test("Architecture lanes: groups become columns in order, rows line up, every line is right-angled and clear of boxes", () => {
  const l = laid(treasury(), 1300);
  assert.equal(l.rankdir, "lanes");
  assert.deepEqual(laneProblems(l), []);
  const lanes = l.groups.filter((g) => g.lane);
  assert.deepEqual(
    lanes.map((g) => g.id),
    ["external", "margin", "stores", "pt"],
  );
  for (let i = 1; i < lanes.length; i++)
    assert.ok(
      lanes[i].x >= lanes[i - 1].x + lanes[i - 1].width,
      `${lanes[i].id} starts inside ${lanes[i - 1].id}`,
    );
  const at = (id: string) => l.nodes.find((n) => n.id === id) ?? assert.fail(id);
  // Inside a lane, edges flow down; a fork sits side by side.
  assert.ok(at("cli").y < at("factory").y && at("factory").y < at("adapters").y);
  assert.equal(
    at("elasticPush").y + at("elasticPush").height / 2,
    at("treasuryHelper").y + at("treasuryHelper").height / 2,
  );
  // Across lanes, linked rows line up so the lines run straight.
  const straight = (id: string) => {
    const p = (l.edges.find((e) => e.id === id) ?? assert.fail(id)).points;
    return p.length === 2 && p[0].y === p[1].y;
  };
  assert.ok(straight("abn"), "ABN_COH runs straight");
  // Boxes in a lane share its width.
  assert.equal(at("cli").width, at("adapters").width);
  // Tones and two-line details come through.
  assert.equal(at("treasuryHelper").tone, "danger");
  assert.equal(at("brokers").detailLines.length, 2);
  assert.equal(l.edges.find((e) => e.id === "abn")?.tone, "danger");
});

test("Architecture lanes: a narrow screen gets the lanes stacked as bands that fit the width", () => {
  const l = laid(treasury(), 360);
  assert.equal(l.rankdir, "stacked");
  assert.deepEqual(laneProblems(l), []);
  // It may shrink to the legible scale to fit, but never scroll.
  assert.ok(l.width <= 360 / 0.85 + 1, `stacked width ${l.width}`);
  const lanes = l.groups.filter((g) => g.lane);
  for (let i = 1; i < lanes.length; i++)
    assert.ok(
      lanes[i].y >= lanes[i - 1].y + lanes[i - 1].height,
      `${lanes[i].id} starts inside ${lanes[i - 1].id}`,
    );
});

test("Architecture lanes: a pinned row is exact, and two pins on one row sit side by side", () => {
  const l = laid(treasury("lanes", { cli: 1, factory: 1, slack: 9 }), 1600);
  assert.deepEqual(laneProblems(l), []);
  const at = (id: string) => l.nodes.find((n) => n.id === id) ?? assert.fail(id);
  assert.equal(at("cli").y, at("factory").y);
  assert.ok(at("factory").x > at("cli").x + at("cli").width - 1);
  assert.ok(
    at("slack").y > Math.max(...["crypto", "torstone", "fx"].map((id) => at(id).y)),
    "slack pinned below the rest",
  );
  // On a phone the bands keep the pinned order too.
  const phone = laid(treasury("lanes", { cli: 3, factory: 1, adapters: 2 }), 360);
  const ph = (id: string) => phone.nodes.find((n) => n.id === id) ?? assert.fail(id);
  assert.equal(phone.rankdir, "stacked");
  assert.ok(
    ph("factory").y < ph("adapters").y && ph("adapters").y < ph("cli").y,
    "pinned order on a phone",
  );
  // Without groups there are no lanes: the usual layout is used.
  const plain = buildModel({
    nodes: [N("a", "A"), N("b", "B")],
    edges: [E("ab", N("a", "A"), N("b", "B"))],
    direction: "lanes",
  });
  assert.notEqual(laid(plain).rankdir, "lanes");
});

test("Architecture lanes: random diagrams lay out without throwing, overlapping or slanting", () => {
  let seed = 7;
  const rand = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  const pick = <T>(arr: readonly T[]): T => arr[Math.floor(rand() * arr.length)];
  const t0 = performance.now();
  for (let round = 0; round < 120; round++) {
    const count = 2 + Math.floor(rand() * 22);
    const nodes = Array.from({ length: count }, (_, i) =>
      N(
        `n${i}`,
        pick(["API", "Worker with a longer name", "支払い", "db", "Queue 📦"]),
        pick(["backend", "database", "external"]),
        rand() < 0.5 ? "detail\ntwo" : undefined,
        rand() < 0.2 ? "new" : undefined,
        pick([undefined, "danger", "strong"]),
        rand() < 0.15 ? 1 + Math.floor(rand() * 6) : undefined,
      ),
    );
    const edges = Array.from({ length: Math.floor(rand() * count * 1.6) }, (_, i) =>
      E(
        `e${i}`,
        pick(nodes),
        pick(nodes),
        rand() < 0.4 ? pick(["read", "writes rows nightly", "x"]) : undefined,
      ),
    );
    const groupCount = 1 + Math.floor(rand() * 4);
    const groups = Array.from({ length: groupCount }, (_, g) =>
      G(
        `g${g}`,
        rand() < 0.8 ? `Group ${g}` : "",
        nodes.filter(() => rand() < 0.4),
        pick(["region", "plain", "security"]),
      ),
    );
    const model = buildModel({ nodes, edges, groups, direction: "lanes" });
    for (const width of [1300, 360]) {
      const l = layoutModel(model, width);
      if (!l || !["lanes", "stacked"].includes(l.rankdir)) continue; // no groups: the usual layout
      const problems = laneProblems(l);
      assert.deepEqual(problems, [], `round ${round} at ${width}: ${problems.join("; ")}`);
    }
  }
  assert.ok(performance.now() - t0 < 20000, `took ${Math.round(performance.now() - t0)} ms`);
});

test("Architecture lanes: a fork of three or more stacks in its column; two sit side by side", () => {
  const src = N("src", "Fulfillment");
  const outs = ["a", "b", "c"].map((id) => N(id, `Carrier ${id}`));
  const two = laid(
    buildModel({
      nodes: [src, ...outs.slice(0, 2)],
      edges: outs.slice(0, 2).map((o, i) => E(`e${i}`, src, o)),
      groups: [G("lane", "Lane", [src, ...outs.slice(0, 2)])],
      direction: "lanes",
    }),
    1300,
  );
  const twoAt = (id: string) => two.nodes.find((n) => n.id === id) ?? assert.fail(id);
  assert.equal(twoAt("a").y, twoAt("b").y);
  const three = laid(
    buildModel({
      nodes: [src, ...outs],
      edges: outs.map((o, i) => E(`e${i}`, src, o)),
      groups: [G("lane", "Lane", [src, ...outs])],
      direction: "lanes",
    }),
    1300,
  );
  const xs = new Set(three.nodes.map((n) => n.x));
  assert.equal(xs.size, 1, "one column");
  assert.deepEqual(laneProblems(three), []);
});

test("Architecture lanes: too wide for the page, columns scroll on a desktop and stack on a narrower screen; the page widens only when needed", () => {
  const lanesOf = (count: number) => {
    const nodes = Array.from({ length: count }, (_, i) =>
      N(`n${i}`, `Service number ${i} with a name`, "backend", "detail"),
    );
    const edges = nodes.slice(1).map((n, i) => E(`e${i}`, nodes[i], n, "a label of some length"));
    return buildModel({
      nodes,
      edges,
      groups: nodes.map((n, i) => G(`g${i}`, `TEAM ${i}`, [n])),
      direction: "lanes",
    });
  };
  const seven = lanesOf(7);
  assert.equal(laid(seven, 1180).rankdir, "lanes");
  assert.equal(laid(seven, 900).rankdir, "stacked");
  assert.equal(wantsWidePage(seven), true);
  const three = lanesOf(3);
  assert.equal(laid(three, 900).rankdir, "lanes");
  assert.equal(wantsWidePage(three), false);
});

test("Architecture lanes: a long path-like label wraps at its separators instead of running under boxes", () => {
  const web = N("web", "Web app", "frontend");
  const api = N("api", "Orders API");
  const bucket = N("bucket", "Receipts", "cloud");
  const model = buildModel({
    nodes: [web, api, bucket],
    edges: [
      E("a", web, api, "POST /api/v2/orders/checkout"),
      E("b", api, bucket, "s3://receipts-bucket/2026/"),
    ],
    groups: [
      G("g1", "CLIENTS", [web], "plain"),
      G("g2", "orders", [api]),
      G("g3", "storage", [bucket]),
    ],
    direction: "lanes",
  });
  const l = laid(model, 1180);
  assert.equal(l.rankdir, "lanes");
  assert.deepEqual(laneProblems(l), []);
});

test("Sequence: an Actor missing from the list is added as the last column with a problem; an empty Branch is dropped", async () => {
  const { buildModel, layoutModel } = await import("../packs/diagrams/src/_sequence-model.ts");
  const actor = (label: string, statementId: string) => ({ props: { label }, statementId });
  const a = actor("A", "a");
  const b = actor("B", "b");
  const ghost = actor("Ghost", "ghost");
  const msg = (from: object, to: object, label: string) => ({
    props: { from, to, label },
    statementId: label,
  });
  const model = buildModel({
    actors: [a, b],
    messages: [
      msg(a, b, "one"),
      msg(b, ghost, "two"),
      { props: { op: "alt", guard: "never", messages: [] }, statementId: "empty" },
      {
        props: {
          op: "alt",
          guard: "ok",
          messages: [msg(b, a, "three")],
          elseMessages: [msg(a, a, "four")],
        },
        statementId: "br",
      },
    ],
  });
  assert.deepEqual(
    model.actors.map((x) => x.id),
    ["a", "b", "ghost"],
  );
  assert.equal(model.problems.length, 2);
  assert.match(model.problems[0], /ghost, which is not in the actors list/);
  assert.match(model.problems[1], /Branch empty has no Messages/);
  assert.deepEqual(
    model.items.map((i) => i.type),
    ["message", "message", "branch"],
  );
  const layout = layoutModel(model);
  const ys = layout.messages.map((m) => m.y);
  assert.deepEqual(
    ys,
    [...ys].sort((p, q) => p - q),
    "messages draw top to bottom in list order",
  );
  const [branch] = layout.branches;
  assert.ok(branch.dividerY !== null && branch.dividerY > layout.messages[2].y);
  assert.ok(
    branch.x >= 0 && branch.x + branch.width <= layout.width,
    "the frame stays inside the diagram",
  );
});

test("Flowchart: edges attach to the diamond's own outline, a missing step is added with a problem, check flags a bare or 4th exit", async () => {
  const step = (label: string, statementId: string, kind?: string) => ({
    props: { label, kind },
    statementId,
  });
  const start = step("Start", "start", "start");
  const ask = step("Ready?", "ask", "decision");
  const [a, b, c, d] = ["a", "b", "c", "d"].map((x) => step(x, x));
  const ghost = step("Ghost", "ghost");
  const link = (from: object, to: object, label: string | undefined, id: string) => ({
    props: { from, to, label },
    statementId: id,
  });
  const props = {
    steps: [start, ask, a, b, c, d],
    links: [
      link(start, ask, undefined, "l0"),
      link(ask, a, "yes", "l1"),
      link(ask, b, "no", "l2"),
      link(ask, c, undefined, "l3"),
      link(ask, d, "maybe", "l4"),
      link(d, ghost, undefined, "l5"),
    ],
  };
  const model = buildFlow(props, FLOWCHART);
  assert.equal(model.direction, "down", "a flowchart runs top to bottom unless told otherwise");
  assert.deepEqual(model.nodes.map((n) => [n.id, n.shape]).slice(-1), [["ghost", "step"]]);
  assert.match(model.problems[0], /FlowLink l5 uses ghost, which is not in the Flowchart list/);
  const messages = flowNotes(props, FLOWCHART).map((n) => n.message);
  assert.ok(messages.some((m) => /"Ready\?" has 4 exits, over 3/.test(m)));
  assert.ok(messages.some((m) => /"Ready\?" has an exit with no label/.test(m)));

  const layout = layoutFlow(model);
  assert.ok(layout);
  const diamond = layout.nodes.find((n) => n.id === "ask");
  assert.ok(diamond);
  const cx = diamond.x + diamond.width / 2;
  const cy = diamond.y + diamond.height / 2;
  for (const e of layout.edges.filter((x) => x.from === "ask" || x.to === "ask")) {
    const p = e.from === "ask" ? e.points[0] : e.points[e.points.length - 1];
    const inside: number =
      Math.abs(p.x - cx) / (diamond.width / 2) + Math.abs(p.y - cy) / (diamond.height / 2);
    assert.ok(Math.abs(inside - 1) < 0.01, `${e.id} meets the diamond outline (${inside})`);
  }
  // Every line starts and ends on the box of the shape it joins, not in space or inside it.
  const gap = (n: FlowLaidOutNode, p: { x: number; y: number }): number =>
    Math.max(n.x - p.x, p.x - (n.x + n.width), n.y - p.y, p.y - (n.y + n.height));
  for (const e of layout.edges) {
    const from: FlowLaidOutNode | undefined = layout.nodes.find((n) => n.id === e.from);
    const to: FlowLaidOutNode | undefined = layout.nodes.find((n) => n.id === e.to);
    assert.ok(from && to);
    assert.ok(Math.abs(gap(from, e.points[0])) <= 1 || from.shape === "decision", `${e.id} start`);
    assert.ok(
      Math.abs(gap(to, e.points[e.points.length - 1])) <= 1 || to.shape === "decision",
      `${e.id} end`,
    );
  }
});

test("StateMachine: the label reads event [guard] / action, and check flags a transition with no event except from an initial or into a final state", async () => {
  const state = (label: string, statementId: string, kind?: string) => ({
    props: { label, kind },
    statementId,
  });
  const init = state("Start", "init", "initial");
  const idle = state("Idle", "idle");
  const busy = state("Busy", "busy");
  const tr = (
    from: object,
    to: object,
    id: string,
    event?: string,
    guard?: string,
    action?: string,
  ) => ({
    props: { from, to, event, guard, action },
    statementId: id,
  });
  const props = {
    states: [init, idle, busy],
    transitions: [
      tr(init, idle, "t0"),
      tr(idle, busy, "t1", "job", "queue > 0", "lock"),
      tr(busy, busy, "t2", "tick"),
      tr(busy, idle, "t3"),
    ],
  };
  const model = buildFlow(props, STATE_MACHINE);
  assert.equal(model.edges[1].label, "job [queue > 0] / lock");
  assert.equal(model.edges[0].label, "");
  const notes = flowNotes(props, STATE_MACHINE).map((n) => n.message);
  assert.equal(notes.length, 1);
  assert.match(notes[0], /1 transition with no event \(Busy → Idle\)/);
  const layout = layoutFlow(model);
  assert.ok(layout);
  assert.ok(layout.edges.every((e) => e.points.length >= 2));
  assert.ok(layout.edges.find((e) => e.id === "t2")?.labelBox, "a self-transition keeps its label");
});

test("Flowchart: the id of an unnamed step cannot collide with a named one", () => {
  const named = { props: { label: "Named" }, statementId: "_node0" };
  const inline = { props: { label: "Inline" } };
  const toInline = { props: { from: named, to: inline }, statementId: "link" };
  const model = buildFlow({ steps: [inline, named], links: [toInline] }, FLOWCHART);
  assert.equal(model.nodes.length, 2, "both steps are drawn");
  assert.deepEqual(
    model.nodes.map((n) => [n.label, n.named]),
    [
      ["Inline", false],
      ["Named", true],
    ],
  );
  assert.equal(model.edges.length, 1);
  assert.notEqual(model.edges[0].from, model.edges[0].to);
  // An unnamed link does not drop a named one called _edge0.
  const a = { props: { label: "A" }, statementId: "a" };
  const b = { props: { label: "B" }, statementId: "b" };
  const links = [
    { props: { from: a, to: b } },
    { props: { from: b, to: a }, statementId: "_edge0" },
  ];
  assert.equal(buildFlow({ steps: [a, b], links }, FLOWCHART).edges.length, 2);
});

test("Tree: a node names its parent; a missing parent is added, a loop is cut, check flags a second root, depth and breadth", () => {
  const node = (label: string, statementId: string, parent?: object) => ({
    props: { label, parent },
    statementId,
  });
  const root = node("Root", "root");
  const kids = ["a", "b", "c", "d", "e", "f"].map((k) => node(k, k, root));
  const deep = node("deep", "deep", node("mid", "mid", kids[0]));
  const ghost = node("Ghost", "ghost");
  const orphan = node("Orphan", "orphan", ghost);
  const lone = node("Lone", "lone");
  const loopA = node("Loop A", "loopA");
  const loopB = node("Loop B", "loopB", loopA);
  loopA.props.parent = loopB;
  const props = {
    nodes: [root, ...kids, deep, node("deeper", "deeper", deep), orphan, lone, loopA, loopB],
  };
  const model = buildFlow(props, TREE);
  assert.equal(model.direction, "auto");
  assert.ok(
    model.nodes.some((n) => n.id === "ghost"),
    "the parent the list left out is drawn",
  );
  assert.ok(
    model.problems.some((m) => /orphan names ghost as its parent.*not in the Tree list/.test(m)),
  );
  assert.ok(
    model.problems.some((m) => /is its own ancestor/.test(m)),
    "a parent loop is cut",
  );
  assert.ok(
    model.edges.every((e) => !e.named),
    "parent links are not click targets",
  );
  assert.equal(
    model.edges.find((e) => e.to === "a")?.from,
    "root",
    "the edge runs from parent to child",
  );
  const messages = flowNotes(props, TREE).map((n) => n.message);
  assert.ok(messages.some((m) => /nodes have no parent .* A tree has one root/.test(m)));
  assert.ok(messages.some((m) => /Level 2 has 8 nodes, over 5/.test(m)));
  assert.ok(messages.some((m) => /5 levels deep, over 4/.test(m)));
  const layout = layoutFlow(model);
  assert.ok(layout);
  assert.equal(layout.edges.length, model.edges.length);
  // A parent that is not a statement is reported, not drawn.
  const bad = buildFlow(
    { nodes: [{ props: { label: "X", parent: "Root" }, statementId: "x" }] },
    TREE,
  );
  assert.match(bad.problems[0], /parent must be the name of a TreeNode statement, not "Root"/);
  assert.equal(bad.edges.length, 0);
});

test("OrgChart: reportsTo and dotted links, the kind of a person, and the limits check reports", () => {
  const person = (name: string, statementId: string, extra: Record<string, unknown> = {}) => ({
    props: { name, ...extra },
    statementId,
  });
  const boss = person("Boss", "boss", { tone: "strong" });
  const bot = person("Bot", "bot", { reportsTo: boss, kind: "agent", role: "triage" });
  const peer = person("Peer", "peer", { reportsTo: boss, dotted: bot, kind: "robot" });
  const reports = ["r1", "r2", "r3", "r4", "r5", "r6"].map((r) => person(r, r, { reportsTo: bot }));
  const props = { people: [boss, bot, peer, ...reports] };
  const model = buildFlow(props, ORG_CHART);
  assert.equal(model.direction, "down");
  assert.equal(model.nodes.find((n) => n.id === "bot")?.shape, "agent");
  assert.equal(model.nodes.find((n) => n.id === "bot")?.detail, "triage");
  assert.equal(
    model.nodes.find((n) => n.id === "peer")?.shape,
    "person",
    "an unknown kind is a person",
  );
  const dotted = model.edges.find((e) => e.style === "dashed");
  assert.deepEqual(
    [dotted?.from, dotted?.to],
    ["bot", "peer"],
    "a dotted line runs from the second manager down",
  );
  const messages = flowNotes(props, ORG_CHART).map((n) => n.message);
  assert.ok(messages.some((m) => /Bot has 6 direct reports, over 5/.test(m)));
  assert.equal(messages.length, 1, "one strong node, one root, three levels: nothing else to say");
  assert.ok(
    flowNotes({ people: [boss, person("Two", "two", { tone: "strong" })] }, ORG_CHART).some((n) =>
      /2 people report to no one/.test(n.message),
    ),
  );
  assert.ok(layoutFlow(model));
});

test("Nested and LayerStack: levels keep their order, a level listed twice is drawn once, an unnamed one cannot take a statement's id", () => {
  const level = (label: string, statementId?: string, extra: Record<string, unknown> = {}) => ({
    props: { label, ...extra },
    statementId,
  });
  const outer = level("Outer", "_level0");
  const inner = level("Inner", undefined, { note: " aside ", tone: "strong" });
  const nested = buildLevels([outer, inner, outer, "junk"], NESTED_SPEC);
  assert.deepEqual(
    nested.levels.map((l) => [l.label, l.named]),
    [
      ["Outer", true],
      ["Inner", false],
    ],
  );
  assert.equal(nested.levels[1].note, "aside");
  assert.equal(nested.levels[1].tone, "strong");
  assert.notEqual(nested.levels[0].id, nested.levels[1].id);
  assert.match(nested.problems[0], /NestedLevel _level0 is listed twice in Nested/);
  const stack = buildLevels(
    [
      {
        props: { name: "App", tag: "L7", items: ["HTTP", " ", 3], tone: "plaid" },
        statementId: "app",
      },
    ],
    LAYER_SPEC,
  );
  assert.deepEqual(stack.levels[0].items, ["HTTP", "3"]);
  assert.equal(stack.levels[0].note, "L7");
  assert.equal(stack.levels[0].tone, "");
  assert.deepEqual(buildLevels(undefined, LAYER_SPEC).levels, []);
});

test("Tree and OrgChart: siblings draw in list order, left to right going down and top to bottom going across", () => {
  const node = (label: string, parent?: object) => ({
    props: { label, parent },
    statementId: label,
  });
  const root = node("r");
  const props = { nodes: [root, ...["a", "b", "c"].map((k) => node(k, root))] };
  for (const [direction, axis] of [
    ["down", "x"],
    ["right", "y"],
  ] as const) {
    const layout = layoutFlow(buildFlow({ ...props, direction }, TREE));
    assert.ok(layout);
    const at = (id: string) => layout.nodes.find((n) => n.id === id)?.[axis] ?? NaN;
    assert.ok(at("a") < at("b") && at("b") < at("c"), `${direction}: a, b, c in order`);
  }
  const person = (name: string, reportsTo?: object) => ({
    props: { name, reportsTo },
    statementId: name,
  });
  const boss = person("boss");
  const org = layoutFlow(
    buildFlow({ people: [boss, ...["a", "b", "c"].map((k) => person(k, boss))] }, ORG_CHART),
  );
  assert.ok(org);
  const x = (id: string) => org.nodes.find((n) => n.id === id)?.x ?? NaN;
  assert.ok(x("a") < x("b") && x("b") < x("c"));
});

test("ER fields: the lines agents write parse to name, type and marks", () => {
  const cases: [string, ReturnType<typeof parseField>][] = [
    ["id uuid pk", { name: "id", type: "uuid", marks: ["PK"] }],
    ["email text unique", { name: "email", type: "text", marks: ["UQ"] }],
    ["user_id uuid fk users.id", { name: "user_id", type: "uuid", marks: ["FK users.id"] }],
    ["- bullet text NOT NULL", { name: "bullet", type: "text", marks: ["NN"] }],
    ["id uuid PRIMARY KEY", { name: "id", type: "uuid", marks: ["PK"] }],
    [
      "total numeric(12, 2) nn idx",
      { name: "total", type: "numeric(12, 2)", marks: ["NN", "IDX"] },
    ],
    [
      "created_at timestamp with time zone",
      { name: "created_at", type: "timestamp with time zone", marks: [] },
    ],
    ["order_id uuid pk, fk", { name: "order_id", type: "uuid", marks: ["PK", "FK"] }],
    ["notes", { name: "notes", type: "", marks: [] }],
    ["", { name: "", type: "", marks: [] }],
  ];
  for (const [line, want] of cases) assert.deepEqual(parseField(line), want, line);
});

test("ER cardinality: 1:N reads from the first entity to the second; junk reads as null", () => {
  assert.deepEqual(parseCardinality("1:N"), { from: "one", to: "many" });
  assert.deepEqual(parseCardinality(" n : m "), { from: "many", to: "many" });
  assert.deepEqual(parseCardinality("0..1:1..*"), { from: "zero-one", to: "one-many" });
  assert.deepEqual(parseCardinality("1:0..*"), { from: "one", to: "zero-many" });
  assert.deepEqual(parseCardinality("1-N"), { from: "one", to: "many" });
  assert.deepEqual(parseCardinality("1 to many"), { from: "one", to: "many" });
  for (const junk of ["", "lots", "1:2:3", "1:", "?"])
    assert.equal(parseCardinality(junk), null, junk);
});

test("ERDiagram: relation marks, part names, missing cardinality and unreadable cardinality", () => {
  const entity = (name: string, fields?: unknown[]) => ({
    props: { name, fields },
    statementId: name,
  });
  const a = entity("A", ["id uuid pk", 7, "x text"]);
  const b = entity("B");
  const rel = (cardinality: unknown, label?: string) => ({
    props: { from: a, to: b, cardinality, label },
    statementId: `r${String(cardinality)}`,
  });
  const model = buildFlow(
    { entities: [a, b], relations: [rel("1:N", "has"), rel(undefined), rel("lots")] },
    ER_DIAGRAM,
  );
  assert.deepEqual(model.nodes[0].lines, ["id uuid pk", "x text"]);
  assert.equal(model.nodes[0].shape, "entity");
  assert.deepEqual(
    model.edges.map((e) => [e.ends?.fromMark, e.ends?.toMark, e.ends?.part]),
    [
      ["one", "many", "A → B (has)"],
      ["", "", "A → B"],
      ["", "", "A → B"],
    ],
  );
  assert.match(model.problems.join("\n"), /Relation rlots: cardinality "lots" is not one of/);
  const notes = flowNotes(
    { entities: [a, b], relations: [rel("1:N"), rel(undefined)] },
    ER_DIAGRAM,
  );
  assert.match(notes.map((n) => n.message).join("\n"), /1 relation with no cardinality \(A → B\)/);
  // An unreadable cardinality is reported once, as itself.
  const unreadable = flowNotes({ entities: [a, b], relations: [rel("lots")] }, ER_DIAGRAM).map(
    (n) => n.message,
  );
  assert.equal(unreadable.length, 1);
  assert.match(unreadable[0], /cardinality "lots"/);
  // A long field list and a self relation lay out without throwing.
  const wide = entity(
    "W",
    Array.from({ length: 40 }, (_, i) => `field_${i}_${"x".repeat(i * 3)} text pk`),
  );
  const self = { props: { from: wide, to: wide, cardinality: "1:N" }, statementId: "self" };
  const layout = layoutFlow(buildFlow({ entities: [wide, a], relations: [self] }, ER_DIAGRAM));
  assert.ok(layout);
  const box = layout.nodes.find((n) => n.id === "W");
  assert.ok(box && box.width <= 360 && box.data?.rows.length === 40);
});

test("ClassDiagram: inheritance runs parent-first so the parent sits above; multiplicities follow their ends", () => {
  const box = (name: string, members?: string[], kind?: string) => ({
    props: { name, members, kind },
    statementId: name,
  });
  const shape = box("Shape", ["+area(): float"], "interface");
  const circle = box("Circle", ["-radius: float", "+area(): float"]);
  const link = (
    from: object,
    to: object,
    kind: string,
    label?: string,
    fm?: string,
    tm?: string,
  ) => ({
    props: { from, to, kind, label, fromMultiplicity: fm, toMultiplicity: tm },
    statementId: `${kind}${fm ?? ""}`,
  });
  const props = {
    classes: [shape, circle],
    links: [link(circle, shape, "inheritance", "", "0..*", "1")],
  };
  const model = buildFlow(props, CLASS_DIAGRAM);
  assert.equal(model.nodes[0].shape, "interface");
  const [edge] = model.edges;
  assert.deepEqual([edge.from, edge.to], ["Shape", "Circle"]);
  assert.equal(edge.ends?.fromMark, "triangle");
  assert.deepEqual([edge.ends?.fromText, edge.ends?.toText], ["1", "0..*"]);
  assert.equal(edge.ends?.part, "Circle extends Shape");
  const layout = layoutFlow(buildFlow({ ...props, direction: "down" }, CLASS_DIAGRAM));
  const y = (id: string) => layout?.nodes.find((n) => n.id === id)?.y ?? NaN;
  assert.ok(y("Shape") < y("Circle"), "the parent is above");
  const boxLayout = layout?.nodes.find((n) => n.id === "Circle")?.data;
  assert.deepEqual(
    boxLayout?.rows.map((r) => [r.part, r.divider]),
    [
      ["-radius: float", false],
      ["+area(): float", true],
    ],
  );
});

test("ClassDiagram notes: members over 5, accessors, bare associations, and a class diagram that is a data model", () => {
  const box = (name: string, members: string[], kind?: string) => ({
    props: { name, members, kind },
    statementId: name,
  });
  const many = box("Many", [
    ...Array.from({ length: 6 }, (_, i) => `-a${i}: int`),
    "+getName(): string",
    "+setName(n): void",
  ]);
  const other = box("Other", ["-id: int"]);
  const assoc = (from: object, to: object, fm?: string) => ({
    props: { from, to, kind: "association", fromMultiplicity: fm },
    statementId: `assoc${fm ?? ""}`,
  });
  const notes = (props: Record<string, unknown>) =>
    flowNotes(props, CLASS_DIAGRAM)
      .map((n) => n.message)
      .join("\n");
  const text = notes({ classes: [many, other], links: [assoc(many, other)] });
  assert.match(text, /Class "Many" has 6 attributes, over 5/);
  assert.match(text, /lists getters or setters \(\+getName\(\): string\)/);
  assert.match(text, /1 association with no multiplicity/);
  assert.match(notes({ classes: [other], links: [] }), /No inheritance and no operations/);
  assert.doesNotMatch(
    notes({ classes: [many, other], links: [assoc(many, other, "1")] }),
    /no multiplicity/,
  );
  assert.doesNotMatch(notes({ classes: [box("A", ["+run(): void"])], links: [] }), /data model/);
});

const part = (props: Record<string, unknown>, statementId?: string) => ({ props, statementId });

test("Kanban: a column over its limit is marked, an unlisted column is added and reported, a card listed twice is drawn once", () => {
  const a = part({ title: "A", column: "doing" }, "a");
  const board = buildKanban({
    columns: ["Todo", "Doing", "Done"],
    limits: [0, 1, 3],
    cards: [
      a,
      part({ title: "B", column: " Doing ", state: "blocked" }),
      a,
      part({ title: "C", column: "Lost" }),
    ],
  });
  assert.deepEqual(
    board.columns.map((c) => [c.label, c.chip, c.over]),
    [
      ["Todo", "0", false],
      ["Doing", "2/1", true],
      ["Done", "0/3", false],
      ["Lost", "1", false],
    ],
    "Lost is added",
  );
  assert.equal(board.cards.length, 3);
  assert.deepEqual(
    board.cards.map((c) => [c.title, c.col, c.state]),
    [
      ["A", 1, ""],
      ["B", 1, "blocked"],
      ["C", 3, ""],
    ],
  );
  assert.ok(
    board.problems.some((p) =>
      /KanbanCard "C" has column "Lost", which Kanban does not list/.test(p),
    ),
  );
  assert.ok(board.problems.some((p) => /KanbanCard a is listed twice in Kanban/.test(p)));
  assert.equal(buildKanban(undefined).columns.length, 0);
});

test("StoryMap: the cut runs under the first slice, a story with no slice goes in it, no slices means no cut", () => {
  const props = {
    activities: ["Find", "Buy"],
    slices: ["MVP", "Later"],
    stories: [
      part({ title: "S", activity: "find", risk: true }),
      part({ title: "T", activity: "Buy", slice: "later" }),
    ],
  };
  const map = buildStoryMap(props);
  assert.deepEqual(map.lines, [{ after: 0, kind: "cut", label: "Release cut" }]);
  assert.deepEqual(
    map.cards.map((c) => [c.row, c.col, c.state]),
    [
      [0, 0, "risk"],
      [1, 1, ""],
    ],
  );
  assert.equal(buildStoryMap({ ...props, cut: 2 }).lines.length, 0, "nothing lies under the cut");
  const bare = buildStoryMap({ activities: ["Find"], stories: [] });
  assert.equal(bare.lines.length, 0);
  assert.ok(bare.problems.some((p) => /no slices/.test(p)));
});

test("UserJourney: the curve meets between stages, the lowest stage is the trough, a stage with no score breaks the curve", () => {
  const step = (stage: string, score?: number) => part({ action: stage, stage, score });
  const journey = buildJourney({
    stages: ["A", "B", "C", "D"],
    steps: [step("A", 5), step("B", 1), step("C", 9), step("D")],
  });
  const [a, b, c, d] = journey.cards;
  assert.equal(a.curve?.y, 0);
  assert.equal(a.curve?.left, null);
  assert.equal(a.curve?.right, 0.5, "halfway between 5 and 1");
  assert.equal(b.curve?.left, 0.5, "the same point from the other side");
  assert.equal(c.curve?.score, 5, "scores clamp to 1..5");
  assert.equal(c.curve?.right, null, "D has no score");
  assert.equal(d.curve, null);
  assert.deepEqual(
    journey.cards.map((k) => k.trough),
    [false, true, false, false],
  );
  assert.ok(journey.problems.some((p) => /Stage "D" has no score/.test(p)));
  const flat = buildJourney({ stages: ["A", "B"], steps: [step("A", 3), step("B", 3)] });
  assert.ok(
    flat.cards.every((k) => !k.trough),
    "a flat curve has no trough",
  );
});

test("ServiceBlueprint and EventModel: fixed rows, the line of visibility between front and back", () => {
  const step = (layer: string, stage = "S") => part({ action: layer, stage, layer });
  const blueprint = buildBlueprint({
    stages: ["S"],
    steps: [step("customer"), step("backstage"), step("plaid")],
  });
  assert.deepEqual(
    blueprint.rows.map((r) => r.key),
    ["customer", "frontstage", "backstage"],
  );
  assert.deepEqual(
    blueprint.lines.map((l) => [l.after, l.kind]),
    [
      [0, "interaction"],
      [1, "visibility"],
    ],
  );
  assert.ok(blueprint.problems.some((p) => /layer "plaid"/.test(p)));
  const withSupport = buildBlueprint({ stages: ["S"], steps: [step("support"), step("evidence")] });
  assert.deepEqual(
    withSupport.rows.map((r) => r.key),
    ["evidence", "customer", "frontstage", "backstage", "support"],
  );
  assert.deepEqual(
    withSupport.lines.map((l) => l.after),
    [1, 2, 3],
  );
  const events = buildEventModel({
    stages: ["One"],
    items: [
      part({ name: "Place", stage: "One", kind: "command" }),
      part({ name: "List", stage: "one", kind: "read-model" }),
    ],
  });
  assert.deepEqual(
    events.rows.map((r) => r.key),
    ["command", "event", "read-model"],
  );
  assert.deepEqual(
    events.cards.map((c) => [c.row, c.col]),
    [
      [0, 0],
      [2, 0],
    ],
  );
  assert.equal(events.problems.length, 0);
});

test("Heatmap: every cell reads at 4.5:1 on its fill, the focal cell is outside the scale, a missing value takes no fill", () => {
  const ratio = (fill: [number, number, number], ink: "light" | "dark") => {
    const l = luminance(fill);
    return ink === "light" ? 1.05 / (l + 0.05) : (l + 0.05) / 0.05;
  };
  for (let t = 0; t <= 1; t += 0.01) {
    const { fill, ink } = rampFill(t);
    const c = fill.match(/\d+/g)!.map(Number) as [number, number, number];
    assert.ok(ratio(c, ink) >= 4.5, `t=${t.toFixed(2)} ${fill} ${ink}`);
    assert.equal(inkFor(c), ink);
  }
  const heat = buildHeatmap({
    columns: ["A", "B", "C"],
    unit: "%",
    rows: [
      part({ label: "r1", values: [1, 3, 1000], focus: " c " }, "r1"),
      part({ label: "r2", values: [2, "n/a", "1,2"] }),
    ],
  });
  assert.deepEqual(
    heat.rows.map((r) => r.cells.map((c) => c.text)),
    [
      ["1%", "3%", "1000%"],
      ["2%", "–", "12%"],
    ],
  );
  assert.deepEqual(
    [heat.low, heat.high],
    ["1%", "12%"],
    "1000 is focal: it does not set the scale",
  );
  assert.equal(heat.rows[0].cells[2].focal, true);
  assert.equal(heat.rows[1].cells[1].fill, "", "a missing value has no fill");
  assert.equal(heat.problems.length, 0);
  const bad = buildHeatmap({
    columns: ["A", "B"],
    rows: [part({ label: "x", values: [1], focus: "Z" })],
  });
  assert.ok(bad.problems.some((p) => /1 values for 2 columns/.test(p)));
  assert.ok(bad.problems.some((p) => /focus "Z", which is not a column/.test(p)));
});

test("PermissionMatrix: near words map to a level, an unknown word is printed as written, a short row is reported", () => {
  assert.deepEqual(["R/W", "SELECT", " Full ", "-", "", "break-glass"].map(parseAccess), [
    "write",
    "read",
    "admin",
    "none",
    "none",
    null,
  ]);
  const matrix = buildPermissions({
    roles: ["Admins", "Analysts"],
    rows: [
      part({ resource: "Raw", grants: ["admin", "break-glass"], focus: "analysts" }),
      part({ resource: "Agg", grants: ["write"] }),
    ],
  });
  assert.deepEqual(
    matrix.rows.map((r) => r.cells.map((c) => [c.text, c.level, c.focal])),
    [
      [
        ["Admin", "admin", false],
        ["break-glass", null, true],
      ],
      [
        ["Write", "write", false],
        ["None", "none", false],
      ],
    ],
  );
  assert.deepEqual(matrix.used, ["none", "write", "admin"]);
  assert.ok(matrix.problems.some((p) => /AccessRow "Agg" has 1 grants for 2 roles/.test(p)));
});

test("UnitGrid: 100 squares in reading order, a fraction is rounded and said so, counts over 100 are cut", () => {
  const grid = buildUnitGrid({
    parts: [part({ name: "A", count: 63.4 }), part({ name: "B", count: 10 })],
    unit: "check",
  });
  assert.equal(grid.cells.length, 100);
  assert.deepEqual([grid.parts[0].count, grid.parts[0].asked], [63, "63.4"]);
  assert.equal(grid.remaining, 27);
  assert.deepEqual(
    [grid.cells[0], grid.cells[62], grid.cells[63], grid.cells[72], grid.cells[73]],
    [0, 0, 1, 1, -1],
  );
  const over = buildUnitGrid({
    parts: [part({ name: "A", count: 80 }), part({ name: "B", count: 40 })],
  });
  assert.deepEqual(
    over.parts.map((p) => p.count),
    [80, 20],
  );
  assert.equal(over.remaining, 0);
  assert.ok(over.problems.some((p) => /B is cut to 20/.test(p)));
  const bad = buildUnitGrid({ parts: [part({ name: "A", count: -4 })] });
  assert.equal(bad.parts[0].count, 0);
  assert.equal(bad.problems.length, 1);
});

test("Traceability: items link to requirements by ID, a requirement with no design or test is a gap, a stray link is reported", () => {
  const trace = buildTrace({
    requirements: [
      part({ id: "REQ-1", text: "One", source: "Policy 3" }, "r1"),
      part({ id: "REQ-2", text: "Two" }, "r2"),
      part({ id: "req-1", text: "Dup" }),
    ],
    items: [
      part(
        { id: "D-1", name: "Design", kind: "design", covers: ["req-1", "REQ-2", "REQ-9"] },
        "d1",
      ),
      part({ id: "T-1", name: "Test", kind: "test", covers: ["REQ-1"] }, "t1"),
      part({ id: "T-2", name: "Orphan", kind: "test", covers: [] }),
      part({ id: "X-1", name: "Odd", kind: "doc", covers: ["REQ-1"] }),
    ],
  });
  assert.deepEqual(
    trace.rows.map((r) => [r.code, r.design.map((l) => l.id), r.tests.map((l) => l.id)]),
    [
      ["REQ-1", ["d1"], ["t1"]],
      ["REQ-2", ["d1"], []],
    ],
  );
  assert.deepEqual([trace.gaps, trace.sourced], [{ noDesign: [], noTest: ["REQ-2"] }, true]);
  for (const re of [
    /"req-1" is used twice|Requirement id "req-1" is used twice/,
    /covers "REQ-9"/,
    /"T-2" covers no requirement/,
    /"X-1" has kind "doc"/,
  ]) {
    assert.ok(
      trace.problems.some((p) => re.test(p)),
      String(re),
    );
  }
});

test("Gantt: dates are inclusive UTC days, no end is a milestone, a bad row keeps its place with its error", () => {
  const plan = buildGantt({
    tasks: [
      part({ name: "A", start: "2026-11-02", end: "2026-11-03", progress: 250 }),
      part({ name: "M", start: "2026-11-04" }),
      part({ name: "Typo", start: "next tuesday" }),
      part({ name: "Back", start: "2026-11-04", end: "2026-11-01" }),
      part({ name: "Feb", start: "2026-02-31" }),
    ],
  });
  assert.deepEqual(
    plan.rows.map((r) => [r.name, r.milestone, r.progress, Boolean(r.error)]),
    [
      ["A", false, 100, false],
      ["M", true, 0, false],
      ["Typo", true, 0, true],
      ["Back", false, 0, true],
      ["Feb", true, 0, true],
    ],
  );
  assert.equal(plan.axis?.span, 3, "Nov 2 to Nov 4");
  assert.equal(plan.rows[0].width, (2 / 3) * 100, "end is inclusive");
  assert.deepEqual(
    plan.problems,
    [],
    "a bad row shows its error in its row, not in the review panel",
  );
  const started = Date.now();
  const wide = buildGantt({
    tasks: [part({ name: "Typo year", start: "0100-01-01", end: "9999-12-31" })],
  });
  assert.ok(wide.axis && wide.axis.ticks.length <= 8, "month ticks, thinned");
  assert.ok(Date.now() - started < 500, "a typo year does not build a day list");
  const none = buildGantt({ tasks: [part({ name: "Typo", start: "x" })] });
  assert.equal(none.axis, null);
  assert.match(none.rows[0].error ?? "", /not YYYY-MM-DD/);
});

test("GitGraph: a commit follows its lane, a lane's first commit is cut from branchFrom, mergeFrom adds the second parent", () => {
  const g = buildGitGraph({
    lanes: ["main", "feat", "main"],
    commits: [
      part({ message: "c0", lane: "main" }, "c0"),
      part({ message: "c1", lane: "feat", branchFrom: "main" }, "c1"),
      part({ message: "c2", lane: "feat" }, "c2"),
      part({ message: "m", lane: "main", mergeFrom: "feat", tag: "v1", focus: true }, "m"),
      part({ message: "x", lane: "hot", branchFrom: "ghost" }),
      part({ message: "self", lane: "main", mergeFrom: "main" }),
    ],
  });
  assert.deepEqual(g.lanes, ["main", "feat", "hot"]);
  const [c0, c1, c2, m, x, self] = g.commits;
  assert.equal(c0.parent, null);
  assert.deepEqual(c1.parent, { column: 0, lane: 0 });
  assert.deepEqual(c2.parent, { column: 1, lane: 1 });
  assert.deepEqual(
    [m.parent, m.merged],
    [
      { column: 0, lane: 0 },
      { column: 2, lane: 1 },
    ],
  );
  assert.deepEqual([m.tag, m.focal], ["v1", true]);
  assert.deepEqual([x.parent, self.merged], [null, null]);
  for (const re of [
    /listed twice/,
    /lane "hot", which GitGraph does not list/,
    /"ghost", which has no commit yet/,
    /merges its own lane/,
  ]) {
    assert.ok(
      g.problems.some((p) => re.test(p)),
      String(re),
    );
  }
});

test("ScheduleNetwork: ES/EF/LS/LF/float, ties keep every critical path, a shortcut between critical tasks is not a critical link", () => {
  const net = buildSchedule({
    tasks: [
      part({ id: "a", name: "Scope", duration: 2 }),
      part({ id: "B", name: "Build", duration: 5, after: ["A"] }),
      part({ id: "C", name: "Docs", duration: 3, after: ["A"] }),
      part({ id: "D", name: "Ship", duration: 2, after: ["B", "C"] }),
    ],
  });
  const by = Object.fromEntries(net.tasks.map((t) => [t.key, t]));
  assert.equal(net.finish, 9);
  assert.deepEqual(
    [by.C.es, by.C.ef, by.C.ls, by.C.lf, by.C.tf, by.C.critical],
    [2, 5, 4, 7, 2, false],
  );
  assert.deepEqual(net.path, ["A", "B", "D"]);
  assert.deepEqual(
    net.links.map((l) => `${l.from}${l.to}${l.critical ? "!" : ""}`),
    ["AB!", "AC", "BD!", "CD"],
  );
  const tie = buildSchedule({
    tasks: [
      part({ id: "A", name: "a", duration: 1 }),
      part({ id: "B", name: "b", duration: 2, after: ["A"] }),
      part({ id: "C", name: "c", duration: 2, after: ["A"] }),
      part({ id: "D", name: "d", duration: 1, after: ["B", "C"] }),
      part({ id: "E", name: "e", duration: 0.1, after: ["A", "D"] }),
    ],
  });
  assert.deepEqual(tie.path, ["A", "B", "C", "D", "E"], "both tied branches are critical");
  assert.equal(tie.finish, 4.1);
  assert.equal(tie.links.find((l) => l.from === "A" && l.to === "E")?.critical, false);
  const L = layoutSchedule(tie);
  assert.equal(L.boxes.length, 5);
  assert.ok(
    L.links.every((l) => /^M[\d.,H V-]+$/.test(l.d)),
    "orthogonal routes only",
  );
});

test("ScheduleNetwork: unknown ids, self links, cycles, duplicates and zero durations are dropped and reported, never thrown", () => {
  const net = buildSchedule({
    tasks: [
      part({ id: "A", name: "a", duration: 1, after: ["A", "GHOST"] }),
      part({ id: "B", name: "b", duration: 1, after: ["C"] }),
      part({ id: "C", name: "c", duration: 1, after: ["B"] }),
      part({ id: "A", name: "again", duration: 1 }),
      part({ id: "Z", name: "zero", duration: 0 }),
      part({ id: "", name: "none", duration: 1 }),
    ],
  });
  assert.deepEqual(
    net.tasks.map((t) => t.key),
    ["A", "B", "C"],
  );
  assert.equal(net.links.length, 1, "of B after C and C after B, one remains");
  for (const re of [
    /comes after itself/,
    /"GHOST", which is not a task id|GHOST, which is not a task id/,
    /closes a cycle/,
    /used twice/,
    /duration must be a number above 0/,
    /has no id/,
  ]) {
    assert.ok(
      net.problems.some((p) => re.test(p)),
      String(re),
    );
  }
  assert.doesNotThrow(() => layoutSchedule(buildSchedule(undefined)));
});

test("Quadrant: no label overlaps another or crosses an axis; an item on an axis, out of range or missing x is reported", () => {
  const q = buildQuadrant({
    xAxis: "Effort",
    yAxis: "Impact",
    items: [
      part({ label: "Alpha item", x: 20, y: 80 }, "a"),
      part({ label: "Beta item", x: 22, y: 79 }, "b"),
      part({ label: "Gamma item", x: 24, y: 78 }, "c"),
      part({ label: "On the axis", x: 50, y: 10 }, "d"),
      part({ label: "Outside", x: 140, y: 5 }, "e"),
      part({ label: "No y", x: 5 }, "f"),
    ],
  });
  assert.equal(q.items.length, 5, "the item with no y is dropped");
  assert.equal(q.items[4].x, 100, "out of range is clamped");
  for (const re of [/on an axis line/, /outside 0 to 100/, /needs x and y/]) {
    assert.ok(
      q.problems.some((p) => re.test(p)),
      String(re),
    );
  }
  const box = (i: (typeof q.items)[number]) => {
    const w = i.shown.length * 6.96;
    const x0 = i.anchor === "start" ? i.lx : i.anchor === "end" ? i.lx - w : i.lx - w / 2;
    return { x0, x1: x0 + w, y0: i.ly - 11, y1: i.ly + 4 };
  };
  const boxes = q.items.slice(0, 3).map(box);
  for (let a = 0; a < boxes.length; a++) {
    for (let b = a + 1; b < boxes.length; b++) {
      const A = boxes[a];
      const B = boxes[b];
      assert.ok(
        A.x1 <= B.x0 || B.x1 <= A.x0 || A.y1 <= B.y0 || B.y1 <= A.y0,
        `labels ${a} and ${b} do not overlap`,
      );
    }
    const cx = (QUAD.x0 + QUAD.x1) / 2;
    assert.ok(boxes[a].x1 <= cx || boxes[a].x0 >= cx, "a label does not cross the vertical axis");
  }
});

test("Venn: a pair names the sets it joins, an unknown or repeated overlap is dropped and reported, a fourth set is not drawn", () => {
  const sets = [
    part({ name: "A" }, "sa"),
    part({ name: "B" }, "sb"),
    part({ name: "C" }, "sc"),
    part({ name: "D" }, "sd"),
  ];
  const v = buildVenn({
    sets,
    overlaps: [
      part({ label: "AB", of: ["a", "B"] }, "o1"),
      part({ label: "ABC", of: ["A", "B", "C"], focus: true }, "o2"),
      part({ label: "Again", of: ["B", "A"] }, "o3"),
      part({ label: "Ghost", of: ["A", "Z"] }, "o4"),
    ],
  });
  assert.equal(v.sets.length, 3);
  assert.deepEqual(
    v.overlaps.map((o) => [o.label, o.of]),
    [
      ["AB", [0, 1]],
      ["ABC", [0, 1, 2]],
    ],
  );
  assert.ok(
    v.overlaps.every((o) => o.text),
    "every overlap has room for its label",
  );
  for (const re of [/not drawn/, /same sets/, /"Z", which is not a set/]) {
    assert.ok(
      v.problems.some((p) => re.test(p)),
      String(re),
    );
  }
  const sized = buildVenn({
    sets: [part({ name: "Big", size: 400 }), part({ name: "Small", size: 100 })],
  });
  assert.ok(
    Math.abs(sized.sets[1].r / sized.sets[0].r - 0.5) < 1e-9,
    "area follows size: radius goes with its square root",
  );
  assert.equal(buildVenn({ sets: [part({ name: "Only" })] }).sets.length, 0);
});

test("Pyramid: a funnel is as wide as its values and prints the drop; without values it says it is not to scale", () => {
  const f = buildPyramid({
    shape: "funnel",
    layers: [
      part({ name: "Visit", value: 1000 }),
      part({ name: "Join", value: 250 }),
      part({ name: "Pay", value: 50 }),
    ],
  });
  assert.ok(f.toScale);
  const width = (i: number) => f.layers[i].points[1][0] - f.layers[i].points[0][0];
  assert.ok(Math.abs(width(1) / width(0) - 0.25) < 1e-9);
  assert.ok(Math.abs(width(2) / width(0) - 0.05) < 1e-9);
  assert.deepEqual(
    f.layers.map((l) => l.drop),
    ["", "−75%", "−80%"],
  );
  const loose = buildPyramid({
    shape: "funnel",
    layers: [part({ name: "A", value: 5 }), part({ name: "B" })],
  });
  assert.equal(loose.toScale, false);
  assert.ok(loose.problems.some((p) => /not to scale/.test(p)));
  const p = buildPyramid({
    layers: [part({ name: "Top" }), part({ name: "Mid" }), part({ name: "Base" })],
  });
  assert.equal(p.layers[0].points[0][0], p.layers[0].points[1][0], "the apex is a point");
  assert.ok(p.layers[2].points[1][0] > p.layers[1].points[1][0]);
});

test("Loop: the last step leads back to the first, every arc is on one circle, a spoke leaves each step when there is a hub", () => {
  const steps = ["a", "b", "c", "d", "e"].map((n) => part({ name: n, writes: n }, n));
  const lay = layoutLoop({ steps, hub: part({ name: "Hub" }, "h") });
  assert.equal(lay.arcs.length, 5);
  assert.equal(lay.spokes.length, 5);
  const radii = new Set(lay.arcs.map((a) => a.d.match(/A([\d.]+) /)?.[1]));
  assert.equal(radii.size, 1, "one radius");
  assert.equal(layoutLoop({ steps }).spokes.length, 0);
  const many = layoutLoop({ steps: Array.from({ length: 10 }, (_, i) => part({ name: `s${i}` })) });
  assert.equal(many.steps.length, 8);
  assert.ok(many.problems.some((p) => /8 steps at most/.test(p)));
});

test("Fishbone: bones alternate above and below in order of first use, one root only, a cause with no category is filed under Other", () => {
  const fb = layoutFishbone({
    effect: "Slow",
    causes: [
      part({ text: "one", category: "Data", root: true }, "c1"),
      part({ text: "two", category: "Deploy" }, "c2"),
      part({ text: "three", category: "data" }, "c3"),
      part({ text: "four", category: "", root: true }, "c4"),
    ],
  });
  assert.deepEqual(
    fb.bones.map((b) => [b.category, b.above, b.causes.length, b.root]),
    [
      ["Data", true, 2, true],
      ["Deploy", false, 1, false],
      ["Other", true, 1, false],
    ],
  );
  assert.ok(fb.problems.some((p) => /no category/.test(p)));
  assert.ok(fb.problems.some((p) => /root cause/.test(p)));
  assert.ok(
    fb.bones.every((b) => b.causes.every((c) => c.box.x0 >= fb.x)),
    "every label is inside the view",
  );
});

test("WardleyMap: the stage is a band, links go by name, a part in the same band is nudged aside, a commodity cannot move, a third arrow is not drawn", () => {
  const m = buildWardley({
    parts: [
      part(
        { name: "User need", stage: "Custom-built", visibility: 90, needs: ["Core", "Ghost"] },
        "p1",
      ),
      part(
        { name: "Core", stage: "product", visibility: 50, needs: ["Core"], evolving: true },
        "p2",
      ),
      part({ name: "Core 2", stage: "Product", visibility: 50, evolving: true }, "p3"),
      part({ name: "Utility", stage: "commodity", visibility: 5, evolving: true }, "p4"),
      part({ name: "Third", stage: "genesis", visibility: 40, evolving: true }, "p5"),
      part({ name: "Lost", stage: "someday", visibility: 40 }, "p6"),
    ],
  });
  assert.equal(m.parts.length, 5, "an unknown stage is dropped");
  assert.deepEqual(
    m.parts.map((p) => p.stage),
    [1, 2, 2, 3, 0],
  );
  assert.deepEqual(m.links, [{ from: 0, to: 1 }]);
  assert.notEqual(m.parts[1].px, m.parts[2].px, "same band and height: apart");
  assert.deepEqual(
    m.parts.map((p) => p.arrowTo !== null),
    [false, true, true, false, false],
  );
  for (const re of [
    /"Ghost", which is not a part/,
    /needs itself/,
    /commodity/,
    /2 movement arrows at most/,
    /needs a stage/,
  ]) {
    assert.ok(
      m.problems.some((p) => re.test(p)),
      String(re),
    );
  }
});

test("Venn: with honest sizes every label lies inside its own region and no two label boxes overlap", () => {
  const cases = [
    {
      sets: [
        part({ name: "Customers", size: 100 }),
        part({ name: "Partners", size: 40 }),
        part({ name: "Staff", size: 15 }),
      ],
      overlaps: [
        part({ label: "Resellers", of: ["Customers", "Partners"] }),
        part({ label: "Contractors", of: ["Partners", "Staff"] }),
        part({ label: "Champions", of: ["Customers", "Staff"] }),
        part({ label: "Core", of: ["Customers", "Partners", "Staff"] }),
      ],
    },
    {
      sets: [part({ name: "Backend", size: 90 }), part({ name: "Frontend", size: 20 })],
      overlaps: [part({ label: "Full stack", of: ["Backend", "Frontend"] })],
    },
    {
      sets: [
        part({ name: "A", size: 1000 }),
        part({ name: "B", size: 400 }),
        part({ name: "C", size: 120 }),
      ],
      overlaps: [
        part({ label: "AB", of: ["A", "B"] }),
        part({ label: "ABC", of: ["A", "B", "C"] }),
      ],
    },
  ];
  for (const c of cases) {
    const v = buildVenn(c);
    const boxes = [...v.setLabels, ...v.overlaps.map((o) => o.text)].flatMap((l) =>
      l ? [l.box] : [],
    );
    for (let a = 0; a < boxes.length; a++) {
      for (let b = a + 1; b < boxes.length; b++) {
        const A = boxes[a];
        const B = boxes[b];
        assert.ok(
          A.x1 <= B.x0 || B.x1 <= A.x0 || A.y1 <= B.y0 || B.y1 <= A.y0,
          `boxes ${a} and ${b} overlap`,
        );
      }
    }
    const unplaced =
      v.setLabels.filter((l) => !l).length + v.overlaps.filter((o) => !o.text).length;
    assert.equal(
      unplaced === 0,
      !v.problems.some((p) => /no room/.test(p)),
      "a label with no room is reported",
    );
  }
});

test("Venn: a label that does not fit is wrapped at spaces and cut with …, never inside a word", () => {
  const long = "Resellers and distributors";
  const v = buildVenn({
    sets: [part({ name: "Backend teams", size: 100 }, "a"), part({ name: "Small", size: 30 }, "b")],
    overlaps: [part({ label: long, of: ["Backend teams", "Small"] }, "o")],
  });
  const text = v.overlaps[0].text?.lines.map((l) => l.text) ?? [];
  assert.ok(text.length > 0, "the label is placed");
  for (const line of text) {
    for (const word of line.replace(/…$/, "").split(" ")) {
      assert.ok(long.includes(word), `"${word}" is a whole word of the label or a cut one`);
    }
  }
  const cjk = buildVenn({
    sets: [part({ name: "A", size: 100 }, "a"), part({ name: "B", size: 40 }, "b")],
    overlaps: [part({ label: "支払いの確認", of: ["A", "B"] }, "o")],
  });
  const shown = cjk.overlaps[0].text?.lines.map((l) => l.text).join("") ?? "";
  assert.ok(shown.startsWith("支払") || shown === "支払いの確認", `cut at the end: ${shown}`);
});

test("Waterfall: steps carry the running total; a total that does not add up is reported and drawn where it was given", () => {
  const ok = buildWaterfall({
    labels: ["Start", "Up", "Down", "End"],
    values: [240, 64, -38, 266],
  });
  assert.deepEqual(ok.problems, []);
  assert.deepEqual(
    ok.bars.map((b) => [b.kind, b.from, b.to]),
    [
      ["total", 0, 240],
      ["up", 240, 304],
      ["down", 304, 266],
      ["total", 0, 266],
    ],
  );
  const bad = buildWaterfall({
    labels: ["Start", "Up", "Zero", "End"],
    values: [100, 20, 0, 500],
  });
  for (const re of [/is 0. A zero step is not drawn/, /does not add up/]) {
    assert.ok(
      bad.problems.some((p) => re.test(p)),
      String(re),
    );
  }
  assert.equal(bad.bars.length, 3, "the zero step is dropped");
  assert.equal(bad.bars[2].to, 500, "the end total is drawn at the value given");
  assert.equal(buildWaterfall({ labels: ["Only"], values: [1] }).bars.length, 0);
  const pennies = buildWaterfall({ labels: ["S", "a", "b", "E"], values: [0.1, 0.2, 0.3, 0.6] });
  assert.deepEqual(pennies.problems, [], "decimal sums do not trip on float error");
});

test("Treemap: areas follow the values and tile the plot; a part with no value above 0 is reported", () => {
  const values = [412, 268, 96, 74, 31];
  const rects = squarify(values, { x: 0, y: 0, w: 640, h: 400 });
  const total = values.reduce((a, b) => a + b, 0);
  rects.forEach((r, i) => {
    assert.ok(Math.abs((r.w * r.h) / (640 * 400) - values[i] / total) < 1e-9);
  });
  const t = buildTreemap({
    labels: ["a", "b", "zero", "gap"],
    values: [5, 3, 0, null],
    unit: "KB",
  });
  assert.equal(t.cells.length, 2);
  assert.equal(t.problems.length, 2);
  assert.ok(t.cells.every((c) => c.part.includes("KB")));
  const two = buildTreemap({
    labels: ["a", "b", "c"],
    values: [4, 3, 3],
    groups: ["X", "X", "Y"],
  });
  assert.deepEqual(
    two.groups.map((g) => [g.name, g.value]),
    [
      ["X", 7],
      ["Y", 3],
    ],
  );
});

test("Sankey: stages follow the flows, a loop is dropped and reported, an unbalanced node is reported", () => {
  const s = buildSankey({
    sources: ["In", "In", "Mid"],
    targets: ["Mid", "Out B", "Out A"],
    values: [60, 40, 50],
  });
  assert.equal(s.layers, 3);
  assert.deepEqual(s.nodes.map((n) => [n.name, n.layer]).sort(), [
    ["In", 0],
    ["Mid", 1],
    ["Out A", 2],
    ["Out B", 1],
  ]);
  assert.ok(s.problems.some((p) => /Mid: 60 flows in and 50 flows out/.test(p)));
  const bar = (name: string) => (s.nodes.find((n) => n.name === name) as { h: number }).h;
  assert.ok(Math.abs(bar("In") - (bar("Mid") + bar("Out B"))) < 1e-9, "one scale for every bar");
  const loop = buildSankey({
    sources: ["A", "B", "Src"],
    targets: ["B", "A", "Out"],
    values: [1, 1, 8],
  });
  assert.ok(loop.problems.some((p) => /B → A flows back/.test(p)));
  assert.equal(loop.flows.length, 2, "only the flow back is dropped");
  const retry = buildSankey({
    sources: ["Start", "Run", "Run", "Retry"],
    targets: ["Run", "Pass", "Retry", "Run"],
    values: [10, 8, 2, 2],
  });
  assert.deepEqual(retry.flows.map((f) => f.part).sort(), [
    "Run → Pass: 8",
    "Run → Retry: 2",
    "Start → Run: 10",
  ]);
  assert.ok(retry.problems.some((p) => /Retry → Run flows back/.test(p)));
  assert.equal(buildSankey({ sources: ["A"], targets: ["A"], values: [1] }).flows.length, 0);
});

test("PolarChart: a missing value is reported and not drawn as 0, a negative is dropped, max follows the data", () => {
  const p = buildPolar({
    labels: ["a", "b", "c", "d"],
    values: [3, null, -2, 12],
    focus: "d",
  });
  assert.equal(p.max, 20);
  assert.equal(p.problems.length, 2);
  assert.deepEqual(
    p.categories.map((c) => c.valueText),
    ["3", "–", "–", "12"],
  );
  assert.ok(p.categories[3].focus);
  const raised = buildPolar({ labels: ["a", "b", "c"], values: [5, 9, 1], max: 4 });
  assert.ok(raised.problems.some((m) => /max is raised/.test(m)));
});

test("Radar: a score is scaled to the largest on one ring, a short or bad list is padded with 0 and reported, one focus only", () => {
  const r = buildRadar({
    labels: ["Speed", "Cost", "Ops"],
    series: [
      part({ name: "A", values: [10, 5, 0], focus: true }, "a"),
      part({ name: "B", values: [4, "n/a"], focus: true }, "b"),
    ],
  });
  assert.equal(r.max, 10);
  assert.deepEqual(r.series[1].values, [4, 0, 0]);
  for (const re of [
    /has 2 values for 3 labels/,
    /no number for Cost/,
    /More than one RadarSeries has focus/,
  ]) {
    assert.ok(
      r.problems.some((p) => re.test(p)),
      String(re),
    );
  }
  assert.ok(r.series[0].focus && !r.series[1].focus);
  const [x, y] = r.series[0].points[0];
  assert.ok(
    Math.abs(x - 320) < 1e-9 && y < 244,
    "the first axis points up, full score on the outer ring",
  );
  assert.equal(buildRadar({ labels: ["a", "b"], series: [] }).axes.length, 2);
});
