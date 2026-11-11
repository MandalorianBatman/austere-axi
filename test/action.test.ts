import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import test from "node:test";
import { escapeMd, expandPages, marker, parseCheck, renderComment, resolveCli, upsertComment } from "../action/lib.ts";

const cli = (...args: string[]) => spawnSync(process.execPath, ["src/cli/main.ts", ...args], { encoding: "utf8" }).stdout;

test("parseCheck reads real `check` output: errors with statement, line and message", () => {
  const r = parseCheck(cli("check", "test/fixtures/action/bad.html"));
  assert.equal(r.status, "errors");
  assert.equal(r.statements, 2);
  assert.equal(r.errors.length, 1);
  assert.equal(r.errors[0].statement, "summary");
  assert.equal(r.errors[0].line, "11");
  assert.match(r.errors[0].message ?? "", /^Unknown component "NoSuchComponent"/);
});

test("parseCheck counts warnings and reads a passing page", () => {
  const ok = parseCheck(cli("check", "test/fixtures/action/ok.html"));
  assert.deepEqual([ok.status, ok.statements, ok.errors.length, ok.warnings], ["ok", 4, 0, 0]);
  const warned = parseCheck("status: ok\nstatements: 2\nwarnings:\n  - code: a\n    message: x\n  - code: b\n    message: y\n");
  assert.equal(warned.warnings, 2);
  assert.equal(parseCheck(cli("check", "test/fixtures/action/missing.html")).status, "error");
});

test("expandPages: globs and literal paths, one per line, unique and sorted; no match is empty", () => {
  const pages = expandPages("test/fixtures/action/*.html\ntest/fixtures/action/ok.html\n\n", process.cwd());
  assert.deepEqual(pages, ["test/fixtures/action/bad.html", "test/fixtures/action/ok.html"]);
  assert.deepEqual(expandPages("nope/*.html", process.cwd()), []);
});

test("escapeMd: PR-controlled text cannot inject links, HTML, mentions or table cells", () => {
  const s = escapeMd("<img src=x> [a](http://evil) @maintainer | `code`\nline2");
  assert.doesNotMatch(s, /[<>[\]|`@\n]/);
});

interface PageResult { page: string; title: string; ok: boolean; statements: number; warnings: number; errors: { statement: string; line: number; message: string }[]; exported: string | undefined }
const page = (over: Partial<PageResult> = {}): PageResult => ({ page: "a.html", title: "A", ok: true, statements: 5, warnings: 0, errors: [], exported: "a.html", ...over });

test("renderComment: marker first, attribution link, artifact link; failures list their errors", () => {
  const pass = renderComment([page()], { tag: "t", artifactUrl: "https://example.test/art/1" });
  assert.ok(pass.startsWith(marker("t")));
  assert.match(pass, /\[Download the review page\]\(https:\/\/example\.test\/art\/1\)/);
  assert.match(pass, /made with \[austere-axi\]\(https:\/\/github\.com\/MandalorianBatman\/austere-axi\)/);

  const fail = renderComment(
    [page({ ok: false, exported: undefined, errors: [{ statement: "root", line: 3, message: "Unknown component" }] })],
    { tag: "t", runUrl: "https://example.test/run/9" },
  );
  assert.match(fail, /1 of 1 page failed/);
  assert.match(fail, /root.*Unknown component/);
  assert.match(fail, /\[the job log\]\(https:\/\/example\.test\/run\/9\)/);
  assert.doesNotMatch(fail, /Download/);
});

test("renderComment: a title cannot break out of the table", () => {
  const c = renderComment([page({ title: "x | <script>alert(1)</script>\n| y" })], { tag: "t" });
  assert.doesNotMatch(c, /<script>/);
  assert.equal(c.split("\n").filter((l) => l.startsWith("| `a.html`")).length, 1);
});

/** `login` set: a user token that may call GET /user. Unset: the workflow token, which gets a 403 there. */
interface Comment { id: number; body: string; user: { login: string; type: string } }
function fakeGitHub(comments: Comment[], login?: string) {
  const calls: [string | undefined, string][] = [];
  const f = async (url: string, init: RequestInit) => {
    calls.push([init.method, url.replace("https://api.test", "")]);
    const json = (v: unknown) => ({ ok: true, status: 200, json: async () => v, text: async () => "" });
    if (url.endsWith("/user")) return login ? json({ login }) : { ok: false, status: 403, text: async () => "Resource not accessible by integration" };
    if (init.method === "GET") return json(comments);
    return json({ html_url: "https://example.test/c", id: 7 });
  };
  return { f: f as unknown as typeof fetch, calls };
}

const bot = { login: "github-actions[bot]", type: "Bot" };

test("upsertComment: updates the comment that carries this tag's marker, else creates", async () => {
  const mine = { id: 42, body: `${marker("t")}\nold`, user: bot };
  const other = { id: 43, body: `${marker("other")}\nold`, user: bot };
  const args = { api: "https://api.test", repo: "o/r", pr: 5, token: "x", body: `${marker("t")}\nnew`, tag: "t" };

  let gh = fakeGitHub([other, mine]);
  assert.equal((await upsertComment({ ...args, fetch: gh.f })).action, "updated");
  assert.deepEqual(gh.calls.at(-1), ["PATCH", "/repos/o/r/issues/comments/42"]);

  gh = fakeGitHub([other, { id: 1, body: "unrelated", user: bot }]);
  assert.equal((await upsertComment({ ...args, fetch: gh.f })).action, "created");
  assert.deepEqual(gh.calls.at(-1), ["POST", "/repos/o/r/issues/5/comments"]);
});

test("upsertComment: a marked comment by someone else is never taken over", async () => {
  const args = { api: "https://api.test", repo: "o/r", pr: 5, token: "x", body: `${marker("t")}\nnew`, tag: "t" };
  const human = { id: 50, body: `${marker("t")}\nplanted`, user: { login: "mallory", type: "User" } };

  let gh = fakeGitHub([human]);
  assert.equal((await upsertComment({ ...args, fetch: gh.f })).action, "created");
  assert.deepEqual(gh.calls.at(-1), ["POST", "/repos/o/r/issues/5/comments"]);

  // A user token updates its own account's comment, not a bot's or another user's.
  const own = { id: 51, body: `${marker("t")}\nold`, user: { login: "alice", type: "User" } };
  gh = fakeGitHub([human, { ...own, id: 52, user: bot }, own], "alice");
  assert.equal((await upsertComment({ ...args, fetch: gh.f })).action, "updated");
  assert.deepEqual(gh.calls.at(-1), ["PATCH", "/repos/o/r/issues/comments/51"]);
});

test("resolveCli: on Windows npx runs as node npx-cli.js, since a shell would re-parse PR-controlled paths", () => {
  const execPath = "C:\\node\\node.exe";
  const files = new Set<fs.PathLike>(["C:\\npm\\npx.cmd", "C:\\npm\\node_modules\\npm\\bin\\npx-cli.js", "C:\\node\\node_modules\\npm\\bin\\npx-cli.js"]);
  const o = { platform: "win32" as NodeJS.Platform, execPath, exists: (p: fs.PathLike) => files.has(p) };
  assert.deepEqual(resolveCli(["npx", "-y", "austere-axi@1"], { ...o, env: { PATH: "C:\\Windows;\"C:\\npm\"" } }), [execPath, "C:\\npm\\node_modules\\npm\\bin\\npx-cli.js", "-y", "austere-axi@1"]);
  assert.deepEqual(resolveCli(["npx", "-y", "austere-axi@1"], { ...o, env: { PATH: "C:\\Windows" } }), [execPath, "C:\\node\\node_modules\\npm\\bin\\npx-cli.js", "-y", "austere-axi@1"]);
  assert.deepEqual(resolveCli(["node", "dist/cli.mjs"], o), ["node", "dist/cli.mjs"]);
  assert.deepEqual(resolveCli(["npx", "-y", "austere-axi@1"], { ...o, platform: "linux" }), ["npx", "-y", "austere-axi@1"]);
});

test("upsertComment: a 403 rejects with the status so the action can warn instead of fail", async () => {
  const f = (async () => ({ ok: false, status: 403, text: async () => "Resource not accessible by integration" })) as unknown as typeof fetch;
  await assert.rejects(upsertComment({ api: "https://api.test", repo: "o/r", pr: 5, token: "x", body: "b", tag: "t", fetch: f }), (e: { status?: number }) => e.status === 403);
});
