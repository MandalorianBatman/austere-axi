// Attach (RLM-346): which setting applies to a page, the CLI that shows it anywhere and changes
// it only at a terminal, and the owner's routes behind the review page's Agent pill.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { resolveSetting } from "../src/cli/attach.ts";
import type { AttachSettingRow, AttachState } from "../src/cli/attach.ts";
import { shellJoin } from "../src/cli/adapters/config.ts";
import { COOKIE } from "../src/cli/invites.ts";
import { ownerHeaders } from "./owner.ts";
import { freePort } from "./port.ts";

const STATE = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "austere-attach-state-")));
const WORK = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "austere-attach-work-")));
const PROJECT = path.join(WORK, "site");
const MAIN = path.resolve("src/cli/main.ts");
const AT_TERMINAL = "data:text/javascript,Object.defineProperty(process.stdin,'isTTY',{value:true})";
const PORT = await freePort();
process.env.AUSTERE_AXI_STATE_DIR = STATE;

// The test may itself run inside a harness: its session must not become a page's author.
const ENV: NodeJS.ProcessEnv = { ...process.env, AUSTERE_AXI_STATE_DIR: STATE, AUSTERE_AXI_PORT: String(PORT), AUSTERE_AXI_NO_TAILSCALE: "1", AUSTERE_AXI_NO_OPEN: "1", OPENUI_TELEMETRY_DISABLED: "1" };
for (const name of ["PI_SESSION_ID", "PI_SESSION_FILE", "COPILOT_AGENT_SESSION_ID", "DSH_SESSION_ID"]) delete ENV[name];

function cli(args: string[], opts: { tty?: boolean } = {}): { code: number | null; out: string } {
  const r = spawnSync(process.execPath, [...(opts.tty ? ["--import", AT_TERMINAL] : []), MAIN, ...args], { env: ENV, encoding: "utf8", cwd: PROJECT });
  return { code: r.status, out: r.stdout + r.stderr };
}

/** cli at a terminal, without blocking this process: a test's own SSE client keeps reading meanwhile. */
function cliAsync(args: string[]): Promise<{ code: number | null; out: string }> {
  const { promise, resolve } = Promise.withResolvers<{ code: number | null; out: string }>();
  const child = spawn(process.execPath, ["--import", AT_TERMINAL, MAIN, ...args], { env: ENV, cwd: PROJECT });
  let out = "";
  child.stdout.on("data", (c) => (out += c));
  child.stderr.on("data", (c) => (out += c));
  child.on("close", (code) => resolve({ code, out }));
  return promise;
}

function page(name: string): string {
  const file = path.join(PROJECT, `${name}.html`);
  fs.writeFileSync(file, `<!doctype html><html><head><title>${name}</title></head><body><script type="text/openui">\nroot = Stack([intro])\nintro = TextContent("hello")\n</script></body></html>`);
  return file;
}

const row = (scope: "page" | "project", state: AttachState, fields: Partial<AttachSettingRow> = {}): AttachSettingRow => ({ scope, scope_id: "x", state, mode: null, session: null, harness: null, model: null, ...fields });

test("the effective setting: the page's row, unless inherit, then the project's, else off", () => {
  const projects: (AttachSettingRow | null)[] = [row("project", "on", { mode: "fork", harness: "copilot" }), row("project", "off"), row("project", "inherit"), null];
  for (const project of projects) {
    const projectSays = project && project.state !== "inherit" ? project.state : null;
    for (const page of [row("page", "on", { mode: "new", model: "m" }), row("page", "off"), row("page", "inherit"), null]) {
      const e = resolveSetting(page, project);
      const where = `page ${page?.state ?? "none"} × project ${project?.state ?? "none"}`;
      if (page && page.state !== "inherit") {
        assert.equal(e.state, page.state, where);
        assert.equal(e.source, "page", where);
      } else if (projectSays) {
        assert.equal(e.state, projectSays, where);
        assert.equal(e.source, "project", where);
      } else {
        assert.equal(e.state, "off", where);
        assert.equal(e.source, "default", where);
      }
    }
  }
  // The page's own fields win; a page row without a harness takes the project's (Q11); the default session is the author.
  assert.deepEqual(resolveSetting(row("page", "on", { mode: "new", model: "m" }), row("project", "on", { mode: "fork", harness: "copilot" })), {
    state: "on",
    source: "page",
    mode: "new",
    session: "author",
    harness: "copilot",
    model: "m",
  });
  assert.deepEqual(resolveSetting(row("page", "inherit", { mode: "new" }), row("project", "on", { mode: "fork" })), {
    state: "on",
    source: "project",
    mode: "fork",
    session: "author",
    harness: "omp",
    model: null,
  });
  assert.deepEqual(resolveSetting(null, null), { state: "off", source: "default", mode: "same", session: "author", harness: "omp", model: null });
});

let server: ChildProcess | null = null;

before(async () => {
  fs.mkdirSync(path.join(PROJECT, ".git"), { recursive: true });
});

after(async () => {
  if (server && server.exitCode === null) {
    const child = server;
    const exited = new Promise((r) => child.once("exit", r));
    child.kill();
    await exited;
  }
  fs.rmSync(STATE, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  fs.rmSync(WORK, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
});

test("attach on|off|inherit without a terminal exits 2, changes nothing and names the command for the user", () => {
  const file = page("tty");
  for (const args of [["on", file, "--mode", "fork"], ["off", file], ["inherit", file], ["on", "--project", PROJECT]]) {
    const r = cli(["attach", ...args]);
    assert.equal(r.code, 2, r.out);
    assert.match(r.out, /code: USAGE/);
    assert.match(r.out, new RegExp(`attach ${args[0]} needs the user at a terminal and changes nothing here`));
    // The output quotes a value with backslashes (a Windows path) JSON-style, doubling them.
    const hint = `Ask the user to run \`austere-axi ${shellJoin(["attach", ...args])}\` themselves`;
    assert.ok(r.out.includes(hint) || r.out.includes(JSON.stringify(hint).slice(1, -1)), r.out);
  }
  assert.match(cli(["attach", "status", file]).out, /attach: off\n[\s\S]*page_setting: none/);
  // Usage errors come before the terminal check.
  assert.equal(cli(["attach", "on", file, "--mode", "sideways"]).code, 2);
  assert.equal(cli(["attach", "status", file, "--mode", "fork"]).code, 2);
  assert.equal(cli(["attach", "inherit"]).code, 2);
  assert.equal(cli(["attach", "frob"]).code, 2);
});

test("attach status warns while the harness has no write grant, and not once it has one", () => {
  const file = page("grant");
  const without = cli(["attach", "status", file]);
  assert.equal(without.code, 0, without.out);
  assert.match(without.out, /omp has no write grant/);
  assert.ok(without.out.includes('austere-axi adapter set omp --extra-args \\"--approval-mode yolo\\"'), without.out);
  fs.writeFileSync(path.join(STATE, "adapters.json"), JSON.stringify({ format: 1, extraArgs: { omp: ["--approval-mode", "yolo"] } }), { mode: 0o600 });
  try {
    const granted = cli(["attach", "status", file]);
    assert.equal(granted.code, 0, granted.out);
    assert.doesNotMatch(granted.out, /write grant/);
  } finally {
    fs.rmSync(path.join(STATE, "adapters.json"));
  }
});

test("at a terminal: on, off and inherit write the page's row; an auto page and an unsupported mode are refused", () => {
  const file = page("term");
  let r = cli(["attach", "on", file, "--mode", "new", "--model", "haiku"], { tty: true });
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /status: on\n[\s\S]*attach: on\nfrom: page\nmode: new\n[\s\S]*model: haiku/);
  r = cli(["attach", "off", file], { tty: true });
  assert.match(r.out, /attach: off\nfrom: page\nmode: new/);
  r = cli(["attach", "on", "--project", PROJECT, "--mode", "fork"], { tty: true });
  assert.equal(r.code, 0, r.out);
  r = cli(["attach", "inherit", file], { tty: true });
  assert.match(r.out, /attach: on\nfrom: project site\nmode: "?fork/);
  cli(["attach", "off", "--project", PROJECT], { tty: true });

  // Copilot has no fork: refused with its reason, nothing written.
  r = cli(["attach", "on", file, "--harness", "copilot", "--mode", "fork"], { tty: true });
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /copilot cannot run mode fork: Copilot CLI has no fork/);
  assert.match(cli(["attach", "status", file]).out, /attach: off/);

  // Published with --auto (Q3, A17): attach on refuses and names why.
  fs.writeFileSync(path.join(STATE, "cloud.json"), JSON.stringify({ url: "http://127.0.0.1:9", token: "t", pages: { [file]: { id: "p1", auto: true, unlisted: false, presence: true, invites: {} } } }));
  try {
    r = cli(["attach", "on", file], { tty: true });
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /published with --auto/);
    assert.match(r.out, /exclude each other/);
    assert.match(cli(["attach", "status", file]).out, /attach: off/);

    // Nor through its project's default: `attach on --project` while the page inherits it…
    assert.equal(cli(["attach", "inherit", file], { tty: true }).code, 0);
    r = cli(["attach", "on", "--project", PROJECT], { tty: true });
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /published with --auto[\s\S]*the setting stays as it was/);
    assert.match(cli(["attach", "status", file]).out, /attach: off/);
    // …nor `attach inherit` onto a project default that is on.
    assert.equal(cli(["attach", "off", file], { tty: true }).code, 0);
    fs.renameSync(path.join(STATE, "cloud.json"), path.join(STATE, "cloud.json.off"));
    assert.equal(cli(["attach", "on", "--project", PROJECT], { tty: true }).code, 0);
    fs.renameSync(path.join(STATE, "cloud.json.off"), path.join(STATE, "cloud.json"));
    r = cli(["attach", "inherit", file], { tty: true });
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /published with --auto/);
    assert.match(cli(["attach", "status", file]).out, /attach: off\nfrom: page/);
  } finally {
    fs.rmSync(path.join(STATE, "cloud.json"), { force: true });
    fs.rmSync(path.join(STATE, "cloud.json.off"), { force: true });
    cli(["attach", "off", "--project", PROJECT], { tty: true });
  }
});

interface Res {
  status: number | undefined;
  data: string;
}

function req(method: string, route: string, headers: Record<string, string>, body?: unknown): Promise<Res> {
  const { promise, resolve, reject } = Promise.withResolvers<Res>();
  const r = http.request({ host: "127.0.0.1", port: PORT, method, path: route, headers: { host: `127.0.0.1:${PORT}`, "content-type": "application/json", ...headers } }, (res) => {
    let data = "";
    res.on("data", (c) => (data += c));
    res.on("end", () => resolve({ status: res.statusCode, data }));
  });
  r.on("error", reject);
  r.end(body === undefined ? undefined : JSON.stringify(body));
  return promise;
}

test("the owner's attach routes: reviewers and a foreign Origin get 403; the owner reads and sets the page's row", async () => {
  server = spawn(process.execPath, [MAIN, "server", "--port", String(PORT)], { env: { ...ENV, AUSTERE_AXI_LINK_HOST: "127.0.0.1" }, stdio: "ignore" });
  const owner = ownerHeaders(STATE);
  for (let i = 0; ; i++) {
    const up = await req("GET", "/api/health", {}).catch(() => null);
    if (up?.status === 200) break;
    if (i > 100) throw new Error("server did not start");
    await new Promise((r) => setTimeout(r, 50));
  }
  const file = page("routes");
  const opened = await req("POST", "/api/open", owner, { file });
  assert.equal(opened.status, 200, opened.data);
  const id = (JSON.parse(opened.data) as { session: { id: string } }).session.id;
  const shared = await req("POST", "/api/share", owner, { file, name: "Ana" });
  const token = new URL((JSON.parse(shared.data) as { link: string }).link).searchParams.get("invite");
  const reviewer = { cookie: `${COOKIE}=${token}` };
  const foreign = { cookie: owner.cookie, origin: "https://evil.example" };

  for (const [method, route, body] of [
    ["GET", `/s/${id}/attach`],
    ["POST", `/s/${id}/attach`, { state: "on" }],
    ["GET", `/s/${id}/runs`],
    ["POST", `/s/${id}/run/retry`, {}],
  ] as const) {
    assert.equal((await req(method, route, reviewer, body)).status, 403, `${method} ${route} as a reviewer`);
    assert.equal((await req(method, route, foreign, body)).status, 403, `${method} ${route} from a foreign Origin`);
  }
  // The invite is not auto, so the owner may turn attach on.
  let r = await req("GET", `/s/${id}/attach`, { cookie: owner.cookie });
  assert.equal(r.status, 200, r.data);
  const info = JSON.parse(r.data) as { effective: { state: string }; harnesses: Record<string, { capabilities: { fork: { ok: boolean; reason?: string } } }> };
  assert.equal(info.effective.state, "off");
  assert.match(info.harnesses.copilot.capabilities.fork.reason ?? "", /Copilot CLI has no fork/);

  r = await req("POST", `/s/${id}/attach`, { cookie: owner.cookie, origin: `http://127.0.0.1:${PORT}` }, { state: "on", mode: "new", model: "haiku" });
  assert.equal(r.status, 200, r.data);
  assert.equal((JSON.parse(r.data) as { effective: { state: string; mode: string } }).effective.mode, "new");
  assert.match(cli(["attach", "status", file]).out, /attach: on\nfrom: page\nmode: new/);

  r = await req("POST", `/s/${id}/attach`, { cookie: owner.cookie }, { state: "on", harness: "copilot", mode: "fork" });
  assert.equal(r.status, 409, r.data);
  assert.match(r.data, /Copilot CLI has no fork/);
  r = await req("POST", `/s/${id}/attach`, { cookie: owner.cookie }, { state: "sideways" });
  assert.equal(r.status, 400, r.data);
  r = await req("POST", `/s/${id}/run/retry`, { cookie: owner.cookie }, {});
  assert.equal(r.status, 409, r.data);
  assert.match(r.data, /no run yet/);

  // An --auto invite makes the page auto: the owner cannot turn attach on from the page either (Q3, A17).
  await req("POST", `/s/${id}/attach`, { cookie: owner.cookie }, { state: "off" });
  await req("POST", "/api/share/revoke", owner, { key: "Ana" });
  assert.equal((await req("POST", "/api/share", owner, { file, name: "Bo", auto: true })).status, 200);
  r = await req("POST", `/s/${id}/attach`, { cookie: owner.cookie }, { state: "on" });
  assert.equal(r.status, 409, r.data);
  assert.match(r.data, /shared with --auto \(Bo\)/);
  assert.match(cli(["attach", "status", file]).out, /attach: off/);

  // At a terminal while the server runs: the CLI's change goes through it (the server holds the
  // state dir's lock, so a direct write would time out), and the owner's open tab hears it.
  await req("POST", "/api/share/revoke", owner, { key: "Bo" });
  const heard = Promise.withResolvers<void>();
  const events = http.get({ host: "127.0.0.1", port: PORT, path: `/s/${id}/events`, headers: { host: `127.0.0.1:${PORT}`, cookie: owner.cookie } }, (res) => {
    let buf = "";
    res.on("data", (c) => {
      buf += c;
      if (/^event: attach$/m.test(buf)) heard.resolve();
    });
  });
  events.on("error", () => {});
  await new Promise((r) => setTimeout(r, 200)); // the tab is connected before the change
  const set = await cliAsync(["attach", "on", file, "--mode", "fork"]);
  assert.equal(set.code, 0, set.out);
  assert.match(set.out, /status: on\n[\s\S]*attach: on\nfrom: page\nmode: "?fork/);
  await heard.promise;
  events.destroy();
});
