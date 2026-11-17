// Reading parts of pages cheaply (RLM-351): outline, show, find, changes, decisions, on examples/.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { estimateTokens } from "../scripts/lib/plugins.ts";
import { sessionId } from "../src/cli/sessions.ts";
import { ownerHeaders } from "./owner.ts";
import { freePort } from "./port.ts";

interface CliResult {
  code: number | null;
  out: string;
}

const PORT = await freePort();
const STATE = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "austere-extract-state-")));
const WORK = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "austere-extract-work-")));
const EXAMPLES = path.join(import.meta.dirname, "..", "examples");
const ENV: NodeJS.ProcessEnv = {
  ...process.env,
  AUSTERE_AXI_STATE_DIR: STATE,
  AUSTERE_AXI_PORT: String(PORT),
  AUSTERE_AXI_NO_TAILSCALE: "1",
  AUSTERE_AXI_NO_OPEN: "1",
  AUSTERE_AXI_PERSIST: "1",
  OPENUI_TELEMETRY_DISABLED: "1",
};
for (const name of ["PI_SESSION_ID", "PI_SESSION_FILE", "COPILOT_AGENT_SESSION_ID", "DSH_SESSION_ID", "AUSTERE_AXI_RUN_ID"]) delete ENV[name];

function cli(args: string[], input = "", cwd = WORK): Promise<CliResult> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.resolve("src/cli/main.ts"), ...args], { env: ENV, cwd });
    let out = "";
    child.stdout.on("data", (c) => (out += c));
    child.stderr.on("data", (c) => (out += c));
    child.stdin.end(input);
    child.on("close", (code) => resolve({ code, out }));
  });
}

function owner(method: string, route: string, body: unknown): Promise<number | undefined> {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: "127.0.0.1", port: PORT, method, path: route, headers: { "content-type": "application/json", host: `127.0.0.1:${PORT}`, ...ownerHeaders(STATE) } }, (res) => {
      res.resume();
      res.on("end", () => resolve(res.statusCode));
    });
    r.on("error", reject);
    r.end(JSON.stringify(body));
  });
}

const copy = (name: string, as = name): string => {
  const file = path.join(WORK, as);
  fs.copyFileSync(path.join(EXAMPLES, name), file);
  return file;
};

before(() => {
  fs.mkdirSync(path.join(WORK, ".git"), { recursive: true });
});

after(async () => {
  await cli(["stop"]);
  fs.rmSync(STATE, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  fs.rmSync(WORK, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
});

test("outline: the tree from root, a row per named statement; the largest example stays under 600 tokens", async () => {
  const file = copy("session-migration.html");
  const r = await cli(["outline", file]);
  assert.equal(r.code, 0, r.out);
  const rows = r.out.split("outline: |\n")[1].split("\nnext:")[0].split("\n").map((l) => l.replace(/^ {2}/, ""));
  assert.deepEqual(rows.slice(0, 9), [
    "root Stack (8)",
    "  intro Card (1): Session storage migration Move sessions from Redis to…",
    "    introText MarkDownRenderer: Sessions live only in Redis and are lost…",
    "  kpis OverviewCardBlock (3)",
    "    kpiUsers OverviewCardItem: Forced logouts / mo 38,214 last 30 days",
    "    kpiP99 OverviewCardItem: Auth p99 41 ms target ≤ 45 ms",
    "    kpiCost OverviewCardItem: Extra storage $140/mo Postgres, 3 replicas",
    "  flow Card (1): Request path after the change",
    "    flowDiagram Architecture (10): nodes: Client, Edge worker, API, Postgres, Redis Client…",
  ]);
  const longest = rows.reduce((a, b) => Math.max(a, estimateTokens(b)), 0);
  assert.ok(longest <= 40, `a row is about ${longest} tokens`);

  let largest = 0;
  for (const f of fs.readdirSync(EXAMPLES).filter((x) => x.endsWith(".html"))) {
    const out = await cli(["outline", copy(f)]);
    assert.equal(out.code, 0, `${f}: ${out.out}`);
    largest = Math.max(largest, estimateTokens(out.out));
  }
  assert.ok(largest <= 600, `the largest outline (the whole answer) is about ${largest} tokens`);
});

test("show: source, plain text, dependencies; an unknown name lists the page's statements", async () => {
  const file = copy("session-migration.html", "show.html");
  const text = await cli(["show", file, "optionTable", "--text"]);
  assert.match(text.out, /\| Option \| Effort \| Downtime \| Risk \|\n\s+\| --- \| --- \| --- \| --- \|\n\s+\| Big bang \| 2 days \| ~10 min \| high \|\n\s+\| Dual-write \| 5 days \| none \| low \|/);
  assert.match(text.out, /component: Table/);
  const deps = await cli(["show", file, "toApi", "--deps"]);
  assert.match(deps.out, /toApi = Edge\(edge, api\)/);
  assert.match(deps.out, /edge = Node\(/, "--deps brings what the statement references");
  assert.match(deps.out, /api = Node\(/);
  assert.doesNotMatch(deps.out, /pg = Node\(/);
  assert.doesNotMatch((await cli(["show", file, "toApi"])).out, /edge = Node/, "without --deps, only the statement");
  const bad = await cli(["show", file, "nope"]);
  assert.equal(bad.code, 1);
  assert.match(bad.out, /has no statement nope; it has: root, intro, introText/);
});

test("find: words in a page's statements, best first; the last line says how to copy", async () => {
  const file = copy("session-migration.html", "find-plan.html");
  copy("code-review.html", "find-review.html");
  assert.equal((await cli([file])).code, 0);
  assert.equal((await cli([path.join(WORK, "find-review.html")])).code, 0);
  const r = await cli(["find", "rollout"]);
  assert.equal(r.code, 0, r.out);
  const first = r.out.split("results:\n")[1].split("\n  - ")[0];
  assert.match(first, /file: [^\n]*find-plan\.html/);
  assert.match(first, /statement: options\n\s+component: Card\n\s+snippet: Rollout options/, "the section titled Rollout options, which holds the options table");
  assert.match(first, /title: Session storage migration/);
  assert.match(r.out, /\nreuse: [^\n]*austere-axi patch <file> --from [^\n]*find-plan\.html#options[^\n]*\n$/);
  assert.doesNotMatch(r.out, /find-review/, "the other page has no such words");
  const table = await cli(["find", "dual write", "--component", "Table"]);
  assert.match(table.out, /statement: optionTable\n\s+component: Table/);
  const none = await cli(["find", "zzzquux"]);
  assert.match(none.out, /results: none/);
  const bad = await cli(["find"]);
  assert.equal(bad.code, 2);
});

test("changes: both patches come back, each with the note that caused it; the cursor advances", async () => {
  const file = copy("code-review.html", "changes.html");
  assert.equal((await cli([file])).code, 0);
  const start = await cli(["changes", file]);
  const cursor0 = Number(/cursor: (\d+)/.exec(start.out)?.[1]);
  assert.ok(cursor0 > 0, start.out);
  assert.match(start.out, /created: \d+ statements/);

  assert.equal(await owner("POST", `/s/${sessionId(file)}/send`, { items: [{ kind: "message", text: "state the risk plainly" }] }), 200);
  assert.match((await cli(["poll", file, "--timeout-ms", "5000"])).out, /state the risk plainly/);
  const first = await cli(["patch", file], 'why = TextContent("The retry is capped.")');
  assert.equal(first.code, 0, first.out);
  const second = await cli(["patch", file], 'why = TextContent("The retry is capped at three.")');
  assert.equal(second.code, 0, second.out);

  const r = await cli(["changes", file, "--since", String(cursor0)]);
  assert.match(r.out, /rev: 2\n[\s\S]*name: why\n\s+before: "Retries fired back-to-back[^\n]*\n\s+after: The retry is capped\./);
  assert.match(r.out, /rev: 3\n[\s\S]*before: The retry is capped\.\n\s+after: The retry is capped at three\./);
  assert.match(r.out, /owner: state the risk plainly/, "the cause of both: the note was still unanswered");
  const cursor1 = Number(/cursor: (\d+)/.exec(r.out)?.[1]);
  assert.ok(cursor1 > cursor0);
  const again = await cli(["changes", file, "--since", String(cursor1)]);
  assert.match(again.out, /changes: none/);
  assert.match(again.out, new RegExp(`cursor: ${cursor1}\\b`));
  const limited = await cli(["changes", file, "--since", String(cursor0), "--limit", "1"]);
  assert.match(limited.out, /rev: 2/);
  assert.doesNotMatch(limited.out, /rev: 3/);
  assert.match(limited.out, /More: `austere-axi changes [^`]*changes\.html[^`]* --since \d+ --limit 1`/, "the continuation names the page and the limit");
});

test("decisions: a submitted form with its values, and a batch sent with Send & finish", async () => {
  const file = copy("session-migration.html", "decide.html");
  assert.equal((await cli([file])).code, 0);
  const id = sessionId(file);
  assert.equal(await owner("POST", `/s/${id}/send`, { items: [{ kind: "action", message: "Decision: rollout", form: { strategy: "dualwrite", notes: "go slow" } }] }), 200);
  assert.equal(await owner("POST", `/s/${id}/send`, { items: [{ kind: "annotation", target: "optionTable", component: "Table", path: ["root", "optionTable"], note: "this is the one" }], end: true }), 200);
  const r = await cli(["decisions", file]);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /kind: action\n[\s\S]*message: "Decision: rollout"\n\s+form: [^\n]*"strategy":"dualwrite"/);
  assert.match(r.out, /kind: final\n[\s\S]*statement: optionTable\n[\s\S]*message: this is the one/);
  const cursor = Number(/cursor: (\d+)/.exec(r.out)?.[1]);
  assert.match((await cli(["decisions", file, "--since", String(cursor)])).out, /decisions: none/);
});
