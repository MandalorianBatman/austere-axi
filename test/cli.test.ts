import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Hub } from "../src/cli/hub.ts";
import { SessionStore, sessionId } from "../src/cli/sessions.ts";
import { ownerHeaders } from "./owner.ts";
import { freePort } from "./port.ts";

const STATE = fs.mkdtempSync(path.join(os.tmpdir(), "austere-cli-"));
const env = { ...process.env, AUSTERE_AXI_STATE_DIR: STATE, AUSTERE_AXI_NO_OPEN: "1", AUSTERE_AXI_NO_TAILSCALE: "1", AUSTERE_AXI_PORT: "4997" };
const cliWith = (e: NodeJS.ProcessEnv, ...args: string[]) => {
  const r = spawnSync(process.execPath, ["src/cli/main.ts", ...args], { encoding: "utf8", env: e });
  return { code: r.status, out: r.stdout };
};
const cli = (...args: string[]) => cliWith(env, ...args);

test.after(() => fs.rmSync(STATE, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }));

test("an unknown flag is a usage error (exit 2) and the command does not run", () => {
  const r = cli("check", "test/fixtures/action/ok.html", "--bogus");
  assert.equal(r.code, 2);
  assert.match(r.out, /code: USAGE/);
  assert.match(r.out, /unknown flag for check: --bogus; valid: --fix/);
  assert.doesNotMatch(r.out, /statements:/);
});

test("a flag from another command is rejected, a command without flags says so", () => {
  assert.match(cli("check", "test/fixtures/action/ok.html", "--trust").out, /unknown flag for check: --trust/);
  const r = cli("login", "--fix");
  assert.equal(r.code, 2);
  assert.match(r.out, /it takes no flags/);
});

test("removed session verbs and flags exit 2 with their replacement and run nothing", () => {
  const file = "test/fixtures/action/ok.html";
  for (const [args, pointer] of [
    [["end", file], /nothing to end.*continue in chat/],
    [["close", file], /austere-axi archive <file>/],
    [["reopen", file], /austere-axi unarchive <file>/],
    [[file, "--reopen"], /--reopen was removed.*unarchive/],
    [["poll", file, "--takeover"], /--takeover was removed.*newest poll replaces/],
  ] as const) {
    const r = cli(...args);
    assert.equal(r.code, 2, args.join(" "));
    assert.match(r.out, /code: REMOVED/);
    assert.match(r.out, pointer);
  }
});

test("usage errors exit 2; failures while running exit 1", () => {
  assert.equal(cli("nosuchcmd").code, 2);
  assert.equal(cli("check").code, 2);
  assert.equal(cli("poll", "x.html", "--cursor").code, 2);
  assert.equal(cli("spec", "NoSuchGroup").code, 2);
  assert.equal(cli("check", "test/fixtures/action/nope.html").code, 1);
  assert.equal(cli("check", "test/fixtures/action/bad.html").code, 1);
});

test("<command> --help prints that command's usage, flags and example, not the full help", () => {
  for (const args of [["check", "--help"], ["help", "check"]]) {
    const r = cli(...args);
    assert.equal(r.code, 0);
    assert.match(r.out, /^austere-axi check <file> \[--fix\] \[--render\]\n/);
    assert.match(r.out, /--fix/);
    assert.match(r.out, /EXAMPLE\n  austere-axi check plan\.html/);
    assert.doesNotMatch(r.out, /WORKFLOW/);
  }
  assert.match(cli("--help").out, /WORKFLOW/);
});

test("with no arguments, live state comes first and the full help is not printed", () => {
  const r = cli();
  assert.equal(r.code, 0);
  assert.match(r.out, /^bin: austere-axi \S+\n/);
  assert.match(r.out, /\nserver: not running\nopen_sessions: 0\n/);
  assert.doesNotMatch(r.out, /WORKFLOW/);
});

test("hub list and hub notes say when --limit cut the list, and take a number", async () => {
  const work = fs.mkdtempSync(path.join(STATE, "work-"));
  fs.mkdirSync(path.join(work, ".git"));
  const store = await SessionStore.open(STATE);
  try {
    const hub = new Hub(store.db);
    const first = store.ensure(path.join(work, "page-00.html"));
    fs.writeFileSync(first.file, "<!doctype html><title>t</title>");
    for (let i = 1; i < 45; i++) {
      const file = path.join(work, `page-${String(i).padStart(2, "0")}.html`);
      fs.writeFileSync(file, "<!doctype html><title>t</title>");
      hub.register({ id: i.toString(16).padStart(12, "0"), file });
    }
    store.addUserBatch(first, Array.from({ length: 45 }, (_, i) => ({ kind: "message", text: `note ${i}` })));
  } finally {
    store.close();
  }

  let r = cli("hub", "list", "--all", "--project", work);
  assert.equal(r.code, 0);
  assert.match(r.out, /shown: "?40 of 45 pages shown; `--limit n` shows more/);
  assert.equal(r.out.match(/page: page-/g)?.length, 40);
  r = cli("hub", "list", "--all", "--project", work, "--limit", "45");
  assert.doesNotMatch(r.out, /shown:/, "nothing was cut");
  assert.equal(r.out.match(/page: page-/g)?.length, 45);
  r = cli("hub", "list", "--all", "--project", work, "--limit", "2");
  assert.match(r.out, /shown: "?2 of 45 pages shown/);

  r = cli("hub", "notes", "--project", work);
  assert.match(r.out, /shown: "?40 of 45 notes shown; `--limit n` shows more/);
  assert.match(cli("hub", "notes", "--project", work, "--limit", "45").out, /note 44/);
  assert.doesNotMatch(cli("hub", "notes", "--project", work, "--limit", "45").out, /shown:/);

  for (const bad of ["0", "-3", "many", "2.5"]) {
    r = cli("hub", "list", "--limit", bad);
    assert.equal(r.code, 2, bad);
    assert.match(r.out, /--limit takes a whole number of 1 or more/);
  }
});

test("hub open honours AUSTERE_AXI_NO_OPEN: no browser is started and the sign-in hint is printed", { skip: process.platform === "win32" }, async () => {
  // A stand-in for the platform's opener that leaves a mark when it runs.
  const bin = fs.mkdtempSync(path.join(STATE, "bin-"));
  const mark = path.join(bin, "launched");
  for (const name of ["xdg-open", "open"]) {
    fs.writeFileSync(path.join(bin, name), `#!/bin/sh\necho "$1" > "${mark}"\n`, { mode: 0o755 });
  }
  const withOpener = { ...env, PATH: `${bin}${path.delimiter}${process.env.PATH}` };
  try {
    const r = cliWith({ ...withOpener, AUSTERE_AXI_NO_OPEN: "1" }, "hub", "open");
    assert.equal(r.code, 0);
    assert.match(r.out, /status: open the url/);
    assert.match(r.out, /url: http:\/\/127\.0\.0\.1:4997\//);
    assert.match(r.out, /note: "?AUSTERE_AXI_NO_OPEN is set/);
    assert.match(r.out, /sign_in: .*austere-axi login/);
    await new Promise((res) => setTimeout(res, 500));
    assert.equal(fs.existsSync(mark), false, "the opener was not run");

    // Without it the opener runs (so the check above can fail).
    const opened = cliWith({ ...withOpener, AUSTERE_AXI_NO_OPEN: "" }, "hub", "open");
    assert.match(opened.out, /status: opened/);
    for (let i = 0; i < 40 && !fs.existsSync(mark); i++) await new Promise((res) => setTimeout(res, 50));
    assert.equal(fs.existsSync(mark), true, "the opener ran");
  } finally {
    cli("stop");
  }
});

// ── missing files (RLM-388): a copy whose file is gone can still be answered and put away ──

const PAGE = fs.readFileSync("test/fixtures/action/ok.html", "utf8");

/** A server of its own (own state dir, own port) and a project folder; both are removed when `fn` ends. */
async function scratch(fn: (s: Scratch) => Promise<void>): Promise<void> {
  const state = fs.mkdtempSync(path.join(os.tmpdir(), "austere-cli-gone-"));
  const port = await freePort();
  const sEnv = { ...env, AUSTERE_AXI_STATE_DIR: state, AUSTERE_AXI_PORT: String(port), AUSTERE_AXI_NO_TAILSCALE: "1", AUSTERE_AXI_PERSIST: "1" };
  const runIn = (cwd: string, ...args: string[]): Promise<{ code: number | null; out: string }> =>
    new Promise((resolve) => {
      const child = spawn(process.execPath, [path.resolve("src/cli/main.ts"), ...args], { cwd, env: sEnv });
      let out = "";
      child.stdout.on("data", (c) => (out += c));
      child.stderr.on("data", (c) => (out += c));
      child.on("close", (code) => resolve({ code, out }));
    });
  const run = (...args: string[]) => runIn(process.cwd(), ...args);
  /** The owner sends a note on page `f` (`end`: with Send & End). */
  const send = (f: string, text: string, end = false): Promise<number | undefined> =>
    new Promise((resolve, reject) => {
      const r = http.request(
        { host: "127.0.0.1", port, method: "POST", path: `/s/${sessionId(f)}/send`, headers: { "content-type": "application/json", host: `127.0.0.1:${port}`, ...ownerHeaders(state) } },
        (res) => {
          res.resume();
          res.on("end", () => resolve(res.statusCode));
        },
      );
      r.on("error", reject);
      r.end(JSON.stringify({ items: [{ kind: "message", text }], end }));
    });
  /** A project folder (it has a .git) with the fixture page at `<name>.html`; each is opened for review and has one note. */
  const project = async (...names: string[]): Promise<{ dir: string; files: string[] }> => {
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "austere-cli-gone-work-")));
    fs.mkdirSync(path.join(dir, ".git"));
    const files = names.map((n) => path.join(dir, `${n}.html`));
    for (const f of files) {
      fs.writeFileSync(f, PAGE);
      assert.equal((await run(f)).code, 0);
      assert.equal(await send(f, `note on ${path.basename(f)}`), 200);
    }
    dirs.push(dir);
    return { dir, files };
  };
  const dirs: string[] = [state];
  try {
    await fn({ run, runIn, send, project });
  } finally {
    await run("stop");
    for (const d of dirs) fs.rmSync(d, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  }
}

interface Scratch {
  run: (...args: string[]) => Promise<{ code: number | null; out: string }>;
  runIn: (cwd: string, ...args: string[]) => Promise<{ code: number | null; out: string }>;
  send: (file: string, text: string, end?: boolean) => Promise<number | undefined>;
  project: (...names: string[]) => Promise<{ dir: string; files: string[] }>;
}

test("reply works on a page whose file is gone; a path the hub never saw is still 'no such file'", () =>
  scratch(async ({ run, project }) => {
    const { dir, files } = await project("a");
    fs.rmSync(files[0]);
    let r = await run("feedback", "--project", dir);
    assert.match(r.out, /missing: true/);
    assert.match(r.out, /note on a\.html/);
    assert.match(r.out, /archive --missing/, "the hint says how to put every gone copy away");
    r = await run("reply", files[0], "--agent-reply", "File deleted; nothing to change");
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /status: replied/);
    r = await run("feedback", "--project", dir);
    assert.match(r.out, /status: none/, "the reply answered the note");
    r = await run("reply", path.join(dir, "never.html"), "--agent-reply", "x");
    assert.equal(r.code, 1);
    assert.match(r.out, /no such file/);
  }));

test("archive --missing puts away every gone copy, only in --project when given, and leaves a file that is there", () =>
  scratch(async ({ run, project }) => {
    const one = await project("here", "gone1");
    const two = await project("gone2");
    fs.rmSync(one.files[1]);
    fs.rmSync(two.files[0]);
    let r = await run("archive", "--missing", "--project", one.dir);
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /status: archived/);
    assert.match(r.out, /count: 1/);
    assert.match(r.out, /unanswered: 1/, "the note on the copy is still unanswered; the output says so");
    assert.match(r.out, /gone1\.html/);
    assert.doesNotMatch(r.out, /gone2\.html/);

    // The server is stopped: the same command reads and writes hub.db itself.
    await run("stop");
    r = await run("archive", "--missing");
    assert.match(r.out, /count: 1/);
    assert.match(r.out, /gone2\.html/);
    assert.doesNotMatch(r.out, /here\.html/);
    r = await run("archive", "--missing");
    assert.match(r.out, /status: none/, "nothing left to put away");

    r = await run("hub", "list", "--archived");
    assert.match(r.out, /gone1\.html/);
    assert.match(r.out, /gone2\.html/);
    r = await run("hub", "list");
    assert.match(r.out, /here\.html/);
    assert.doesNotMatch(r.out, /gone[12]\.html/);
  }));

test("archive takes a file or --missing, and --project only with --missing", () => {
  for (const args of [["archive", "x.html", "--missing"], ["archive", "x.html", "--project", "p"], ["archive"], ["unarchive", "--missing"]]) {
    const r = cli(...args);
    assert.equal(r.code, 2, args.join(" "));
    assert.match(r.out, /code: USAGE/);
  }
});

// ── one loop (RLM-380): open names the project poll; final ends one page, not the loop ──

test("open names the bare poll; a project poll keeps going after final on one page; --timeout-ms is checked; interrupted keeps --cursor", () =>
  scratch(async ({ runIn, send }) => {
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "austere-cli-loop-")));
    try {
      fs.mkdirSync(path.join(dir, ".git"));
      for (const n of ["a", "b"]) fs.writeFileSync(path.join(dir, `${n}.html`), PAGE);
      const opened = await runIn(dir, "a.html", "--no-open");
      assert.equal(opened.code, 0, opened.out);
      assert.match(opened.out, /^next: "Run `austere-axi poll`; /m, opened.out);
      assert.ok(opened.out.includes("(`austere-axi poll a.html` for this page only)"), opened.out);
      assert.doesNotMatch(opened.out, /leave it running/);
      assert.equal((await runIn(dir, "b.html", "--no-open")).code, 0);

      assert.equal(await send(path.join(dir, "a.html"), "ship it", true), 200);
      assert.equal(await send(path.join(dir, "b.html"), "more on b"), 200);
      const got = await runIn(dir, "poll", "--timeout-ms", "5000");
      assert.match(got.out, /^status: feedback$/m, got.out);
      assert.match(got.out, /final: true/);
      assert.match(got.out, /message: more on b/);
      assert.match(got.out, /final: true means that page is done .*Keep polling with `austere-axi poll --cursor \d+` while another page you opened is still in review/, "final ends that page, not the loop");
      assert.doesNotMatch(got.out, /do not poll again|stop listening for that page/);
      const cursor = (/^cursor: (\d+)$/m.exec(got.out) as RegExpExecArray)[1];
      assert.ok(got.out.includes(`austere-axi poll --cursor ${cursor}`), got.out);

      for (const bad of ["abc", "-1", "1.5"]) {
        const r = await runIn(dir, "poll", "--timeout-ms", bad);
        assert.equal(r.code, 2, bad);
        assert.match(r.out, /--timeout-ms takes a whole number of milliseconds/);
      }

      // The server stops under a listening poll: the hint repeats the poll with the cursor it was given.
      const listening = runIn(dir, "poll", "--cursor", cursor);
      for (let i = 0; i < 100 && !/presence: listening/.test((await runIn(dir)).out); i++) await new Promise((r) => setTimeout(r, 50));
      await runIn(dir, "stop");
      const stopped = await listening;
      assert.match(stopped.out, /^status: interrupted$/m, stopped.out);
      assert.match(stopped.out, /The server stopped or restarted/);
      assert.ok(stopped.out.includes(`\`austere-axi poll --cursor ${cursor}\``), stopped.out);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
    }
  }));
