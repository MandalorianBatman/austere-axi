import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { escapeMd, expandPages, marker, parseCheck, renderComment, upsertComment } from "../action/lib.mjs";

const cli = (...args) => spawnSync(process.execPath, ["src/cli/main.js", ...args], { encoding: "utf8" }).stdout;

test("parseCheck reads real `check` output: errors with statement, line and message", () => {
  const r = parseCheck(cli("check", "test/fixtures/action/bad.html"));
  assert.equal(r.status, "errors");
  assert.equal(r.statements, 2);
  assert.equal(r.errors.length, 1);
  assert.equal(r.errors[0].statement, "summary");
  assert.equal(r.errors[0].line, "11");
  assert.match(r.errors[0].message, /^Unknown component "NoSuchComponent"/);
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

const page = (over = {}) => ({ page: "a.html", title: "A", ok: true, statements: 5, warnings: 0, errors: [], exported: "a.html", ...over });

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

function fakeGitHub(comments) {
  const calls = [];
  const f = async (url, init) => {
    calls.push([init.method, url.replace("https://api.test", "")]);
    const json = (v) => ({ ok: true, status: 200, json: async () => v, text: async () => "" });
    if (init.method === "GET") return json(comments);
    return json({ html_url: "https://example.test/c", id: 7 });
  };
  return { f, calls };
}

test("upsertComment: updates the comment that carries this tag's marker, else creates", async () => {
  const mine = { id: 42, body: `${marker("t")}\nold` };
  const other = { id: 43, body: `${marker("other")}\nold` };
  const args = { api: "https://api.test", repo: "o/r", pr: 5, token: "x", body: `${marker("t")}\nnew`, tag: "t" };

  let gh = fakeGitHub([other, mine]);
  assert.equal((await upsertComment({ ...args, fetch: gh.f })).action, "updated");
  assert.deepEqual(gh.calls.at(-1), ["PATCH", "/repos/o/r/issues/comments/42"]);

  gh = fakeGitHub([other, { id: 1, body: "unrelated" }]);
  assert.equal((await upsertComment({ ...args, fetch: gh.f })).action, "created");
  assert.deepEqual(gh.calls.at(-1), ["POST", "/repos/o/r/issues/5/comments"]);
});

test("upsertComment: a 403 rejects with the status so the action can warn instead of fail", async () => {
  const f = async () => ({ ok: false, status: 403, text: async () => "Resource not accessible by integration" });
  await assert.rejects(upsertComment({ api: "https://api.test", repo: "o/r", pr: 5, token: "x", body: "b", tag: "t", fetch: f }), (e) => e.status === 403);
});
