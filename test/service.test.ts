import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { health, serverAction } from "../src/cli/client.ts";
import type { ServerHealth } from "../src/cli/client.ts";
import { stateDirHolder } from "../src/cli/lock.ts";
import { hasActiveWork, openDatabase } from "../src/cli/hub.ts";
import { installService, launchdPlist, npxWarning, restartCommand, serviceStatus, systemdUnit, uninstallService } from "../src/cli/service.ts";
import type { RunResult, ServiceContext, ServiceSpec } from "../src/cli/service.ts";
import { freePort } from "./port.ts";

const STATE = fs.mkdtempSync(path.join(os.tmpdir(), "austere-service-"));
process.env.AUSTERE_AXI_STATE_DIR = STATE;
const HOMES: string[] = [];
const CHILDREN: ChildProcess[] = [];

after(async () => {
  for (const child of CHILDREN) {
    if (child.exitCode !== null || child.signalCode !== null) continue;
    const exited = new Promise((r) => child.once("exit", r));
    child.kill();
    await exited;
  }
  for (const d of [STATE, ...HOMES]) fs.rmSync(d, { recursive: true, force: true });
});

const SPEC: ServiceSpec = { node: "/usr/bin/node", cli: "/usr/lib/node_modules/austere-axi/dist/cli.mjs", port: 4388, linkUrl: "https://austere.example.com" };
const CLI = "/usr/lib/node_modules/austere-axi/dist/cli.mjs";

/** A context over a temp HOME, a fake service manager that records what it was asked, and no lock holder. */
function context(over: Partial<ServiceContext> = {}): { ctx: ServiceContext; calls: string[] } {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "austere-home-"));
  HOMES.push(home);
  const calls: string[] = [];
  const ctx: ServiceContext = {
    platform: "linux",
    home,
    env: { USER: "ana" },
    run: (cmd, args): RunResult => {
      calls.push([cmd, ...args].join(" "));
      if (cmd === "loginctl") return { code: 0, stdout: "no\n", stderr: "" };
      if (args.includes("is-enabled")) return { code: 0, stdout: "enabled\n", stderr: "" };
      if (args.includes("is-active")) return { code: 0, stdout: "inactive\n", stderr: "" };
      return { code: 0, stdout: "", stderr: "" };
    },
    isTTY: true,
    node: "/usr/bin/node",
    cli: CLI,
    stateDir: STATE,
    uid: 501,
    holder: async () => null,
    ...over,
  };
  return { ctx, calls };
}

const unitPath = (home: string): string => path.join(home, ".config", "systemd", "user", "austere-axi.service");

test("the systemd unit runs the installed CLI with --persist, supervised, restarting on failure", () => {
  assert.equal(
    systemdUnit(SPEC),
    `# Written by \`austere-axi server install\`; \`austere-axi server uninstall\` removes it.
[Unit]
Description=austere-axi review server

[Service]
ExecStart=/usr/bin/node /usr/lib/node_modules/austere-axi/dist/cli.mjs server --persist --port 4388
Environment=AUSTERE_AXI_SUPERVISED=systemd
Environment=AUSTERE_AXI_LINK_URL=https://austere.example.com
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
`,
  );
});

test("the systemd unit quotes paths with spaces and escapes specifiers", () => {
  const unit = systemdUnit({ node: "/opt/my node/bin/node", cli: "/home/a/100%/cli.mjs", port: 5000, stateDir: "/home/a/state dir" });
  assert.match(unit, /^ExecStart="\/opt\/my node\/bin\/node" \/home\/a\/100%%\/cli\.mjs server --persist --port 5000$/m);
  assert.match(unit, /^Environment="AUSTERE_AXI_STATE_DIR=\/home\/a\/state dir"$/m);
});

test("the launchd plist runs the same command, supervised, kept alive after a failure", () => {
  assert.equal(
    launchdPlist(SPEC, "/Users/ana/.austere-axi/server.log"),
    `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<!-- Written by \`austere-axi server install\`; \`austere-axi server uninstall\` removes it. -->
<plist version="1.0">
<dict>
  <key>Label</key><string>xyz.kasat.austere-axi</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/bin/node</string>
    <string>/usr/lib/node_modules/austere-axi/dist/cli.mjs</string>
    <string>server</string>
    <string>--persist</string>
    <string>--port</string>
    <string>4388</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>AUSTERE_AXI_SUPERVISED</key><string>launchd</string>
    <key>AUSTERE_AXI_LINK_URL</key><string>https://austere.example.com</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key>
  <dict><key>SuccessfulExit</key><false/></dict>
  <key>StandardErrorPath</key><string>/Users/ana/.austere-axi/server.log</string>
</dict>
</plist>
`,
  );
});

test("install writes the unit under HOME, reloads systemd and enables it now", async () => {
  const { ctx, calls } = context();
  const r = await installService({ linkUrl: "https://austere.example.com/" }, ctx);
  assert.equal(r.status, "installed");
  assert.equal(r.unit, unitPath(ctx.home));
  assert.equal(fs.readFileSync(unitPath(ctx.home), "utf8"), systemdUnit({ ...SPEC, linkUrl: "https://austere.example.com" }));
  assert.deepEqual(calls, ["systemctl --user daemon-reload", "systemctl --user is-active austere-axi.service", "systemctl --user enable --now austere-axi.service", "loginctl show-user ana --property=Linger --value"]);
  assert.deepEqual(r.ran, ["systemctl --user daemon-reload", "systemctl --user enable --now austere-axi.service"]);
  assert.match(String(r.notes), /loginctl enable-linger/);
  assert.equal(r.warning, undefined);
});

test("installing over a running unit restarts it, so it picks up the settings just written", async () => {
  const { ctx, calls } = context({
    run: (cmd, args): RunResult => {
      calls.push([cmd, ...args].join(" "));
      if (args.includes("is-active")) return { code: 0, stdout: "active\n", stderr: "" };
      if (args.includes("is-enabled")) return { code: 0, stdout: "enabled\n", stderr: "" };
      return { code: 0, stdout: "", stderr: "" };
    },
  });
  const r = await installService({}, ctx);
  assert.ok(String(r.ran).includes("systemctl --user restart austere-axi.service"), String(r.ran));
});

test("install on macOS writes the plist and bootstraps it", async () => {
  const { ctx, calls } = context({ platform: "darwin" });
  const r = await installService({ port: 5000 }, ctx);
  const file = path.join(ctx.home, "Library", "LaunchAgents", "xyz.kasat.austere-axi.plist");
  assert.equal(r.unit, file);
  assert.match(fs.readFileSync(file, "utf8"), /<string>5000<\/string>/);
  assert.deepEqual(calls, ["launchctl bootout gui/501/xyz.kasat.austere-axi", `launchctl bootstrap gui/501 ${file}`]);
  assert.match(String(r.notes), /AUSTERE_AXI_PORT=5000/);
});

test("install reports a failing systemctl", async () => {
  const { ctx } = context({ run: () => ({ code: 1, stdout: "", stderr: "Failed to connect to bus: No medium found" }) });
  await assert.rejects(installService({}, ctx), /systemctl --user daemon-reload` failed \(exit 1\): Failed to connect to bus/);
});

test("install warns when the CLI runs from npx's cache", async () => {
  const npx = "/home/ana/.npm/_npx/1a2b3c/node_modules/austere-axi/dist/cli.mjs";
  assert.equal(npxWarning(CLI), null);
  assert.match(String(npxWarning(npx)), /npm install -g austere-axi/);
  assert.match(String(npxWarning("C:\\Users\\ana\\AppData\\Local\\npm-cache\\_npx\\1a\\node_modules\\austere-axi\\dist\\cli.mjs")), /npx's cache/);
  const { ctx } = context({ cli: npx });
  const r = await installService({}, ctx);
  assert.match(String(r.warning), /npm install -g austere-axi/);
});

test("install refuses without a terminal and changes nothing", async () => {
  const { ctx, calls } = context({ isTTY: false });
  await assert.rejects(installService({ port: 5000 }, ctx), /needs the user at a terminal.*`austere-axi server install --port 5000`/);
  assert.equal(fs.existsSync(unitPath(ctx.home)), false);
  assert.deepEqual(calls, []);
});

test("the CLI refuses server install without a terminal", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "austere-home-"));
  HOMES.push(home);
  const r = spawnSync(process.execPath, ["src/cli/main.ts", "server", "install"], {
    env: { ...process.env, HOME: home, AUSTERE_AXI_STATE_DIR: STATE, XDG_CONFIG_HOME: "" },
    stdio: ["pipe", "pipe", "pipe"],
    input: "",
    encoding: "utf8",
  });
  assert.equal(r.status, 1);
  assert.match(r.stdout, /needs the user at a terminal/);
  assert.equal(fs.existsSync(unitPath(home)), false);
  const bad = spawnSync(process.execPath, ["src/cli/main.ts", "server", "uninstall", "--link-url", "https://x.example"], { env: { ...process.env, HOME: home, AUSTERE_AXI_STATE_DIR: STATE }, encoding: "utf8" });
  assert.equal(bad.status, 2);
});

test("Windows refuses without a terminal too: the rule is the owner's, on every platform", async () => {
  const { ctx, calls } = context({ platform: "win32", isTTY: false });
  await assert.rejects(installService({}, ctx), /needs the user at a terminal/);
  assert.deepEqual(calls, []);
});

test("Windows gets the steps, and nothing is written", async () => {
  const { ctx, calls } = context({ platform: "win32" });
  const r = await installService({ linkUrl: "https://austere.example.com" }, ctx);
  assert.equal(r.status, "manual");
  assert.match(String(r.steps), /schtasks \/Create \/SC ONLOGON/);
  assert.match(String(r.steps), /setx AUSTERE_AXI_LINK_URL https:\/\/austere.example.com/);
  assert.deepEqual(calls, []);
  assert.deepEqual(fs.readdirSync(ctx.home), []);
});

test("uninstall disables the unit and removes it", async () => {
  const { ctx, calls } = context();
  assert.equal(uninstallService(ctx).status, "not installed");
  await installService({}, ctx);
  calls.length = 0;
  const r = uninstallService(ctx);
  assert.equal(r.status, "uninstalled");
  assert.equal(fs.existsSync(unitPath(ctx.home)), false);
  assert.deepEqual(calls, ["systemctl --user disable --now austere-axi.service", "systemctl --user daemon-reload"]);
});

test("status says a supervised server on an older version needs a restart", async () => {
  const { ctx } = context({
    run: (cmd, args): RunResult => {
      if (args.includes("is-enabled")) return { code: 0, stdout: "enabled\n", stderr: "" };
      if (args.includes("is-active")) return { code: 0, stdout: "active\n", stderr: "" };
      return { code: 0, stdout: "", stderr: "" };
    },
  });
  await installService({}, ctx);
  const s = serviceStatus(ctx, { version: "0.0.1", pid: 42, port: 4388, supervised: "systemd" }, "0.0.2");
  assert.equal(s.installed, true);
  assert.equal(s.enabled, "enabled");
  assert.equal(s.active, "active");
  assert.match(String(s.next), /systemctl --user restart austere-axi.service/);
});

test("a CLI never replaces a supervised server; it says how to restart the unit", () => {
  const h = (over: Partial<ServerHealth>): ServerHealth => ({ name: "austere-axi", version: "0.10.0", pid: 1, port: 4388, stateDir: STATE, listen: [], persist: true, ...over });
  assert.equal(serverAction(h({}), "0.10.0"), "use");
  assert.equal(serverAction(h({}), "0.11.0"), "replace");
  assert.equal(serverAction(h({ legacy: true }), "0.10.0"), "replace");
  assert.equal(serverAction(h({ supervised: "systemd" }), "0.11.0"), "restart-unit");
  assert.equal(serverAction(h({ supervised: "launchd" }), "0.10.0"), "use");
  assert.equal(restartCommand("systemd"), "systemctl --user restart austere-axi.service");
  assert.equal(restartCommand("launchd", 501), "launchctl kickstart -k gui/501/xyz.kasat.austere-axi");
});

/** Start a real server on this state dir; `env` adds to its environment. */
async function startServer(env: Record<string, string> = {}): Promise<{ child: ChildProcess; port: number }> {
  const port = await freePort();
  const child = spawn(process.execPath, ["src/cli/main.ts", "server", "--port", String(port)], {
    env: { ...process.env, AUSTERE_AXI_STATE_DIR: STATE, AUSTERE_AXI_NO_TAILSCALE: "1", OPENUI_TELEMETRY_DISABLED: "1", ...env },
    stdio: "ignore",
  });
  CHILDREN.push(child);
  for (let i = 0; i < 200; i++) {
    if (await health(port)) return { child, port };
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error("server did not start");
}

async function stop(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise((r) => child.once("exit", r));
  child.kill();
  await exited;
}

test("install refuses while a server it did not start holds server.lock, and says to stop it first", async () => {
  const { child, port } = await startServer();
  try {
    const { ctx, calls } = context({ holder: stateDirHolder });
    await assert.rejects(installService({}, ctx), (err: Error) => {
      assert.match(err.message, new RegExp(`a server not started by systemd \\(pid ${child.pid}, port ${port}\\)`));
      assert.match(err.message, new RegExp(`run \`AUSTERE_AXI_PORT=${port} austere-axi stop\` first`));
      return true;
    });
    assert.equal(fs.existsSync(unitPath(ctx.home)), false);
    assert.deepEqual(calls, []);
  } finally {
    await stop(child);
  }
});

test("a relative state dir is resolved, so the lock still names the running server", async () => {
  // The server, the CLI and the service may run from different folders; they have to mean
  // the same state dir, or the lock of a running server looks stale and install goes ahead.
  const relative = path.relative(process.cwd(), STATE);
  const port = await freePort();
  const child = spawn(process.execPath, ["src/cli/main.ts", "server", "--port", String(port)], {
    env: { ...process.env, AUSTERE_AXI_STATE_DIR: relative, AUSTERE_AXI_NO_TAILSCALE: "1" },
    stdio: "ignore",
  });
  CHILDREN.push(child);
  try {
    let up = false;
    for (let i = 0; i < 200 && !up; i++) {
      up = Boolean(await health(port));
      if (!up) await new Promise((r) => setTimeout(r, 50));
    }
    assert.ok(up, "the server did not start");
    // A lock older than a minute is only stale when the server does not answer for it; age
    // it, so the check has to prove the running server holds this state dir.
    const lockFile = path.join(STATE, "server.lock");
    const lock = JSON.parse(fs.readFileSync(lockFile, "utf8")) as { at: number };
    fs.writeFileSync(lockFile, JSON.stringify({ ...lock, at: Date.now() - 10 * 60_000 }));
    const holder = await stateDirHolder(STATE);
    assert.ok(holder, "the running server's lock was not found");
    assert.equal(holder.pid, child.pid);
    const { ctx } = context({ holder: stateDirHolder });
    await assert.rejects(installService({}, ctx), /without a supervisor|not started by systemd/);
  } finally {
    await stop(child);
  }
});

test("a supervised server says so in server.lock and /api/health, never idles out, and install restarts it", async () => {
  const { child, port } = await startServer({ AUSTERE_AXI_SUPERVISED: "systemd", AUSTERE_AXI_IDLE_TIMEOUT_MS: "50" });
  try {
    const h = await health(port);
    assert.ok(h && !h.foreign);
    assert.equal(h.supervised, "systemd");
    assert.equal(h.persist, true);
    assert.equal(JSON.parse(fs.readFileSync(path.join(STATE, "server.lock"), "utf8")).supervised, "systemd");
    const { ctx, calls } = context({ holder: stateDirHolder });
    const r = await installService({}, ctx);
    assert.equal(r.status, "installed");
    assert.ok(calls.includes("systemctl --user restart austere-axi.service"));
  } finally {
    await stop(child);
  }
});

test("an unsupervised server waits out the idle exit while a run is active or an agent is attached", async () => {
  // The tables come with the dispatcher and the attach settings (RLM-345, RLM-346); the
  // idle exit waits for them when they are there (RLM-340).
  const { child, port } = await startServer({ AUSTERE_AXI_IDLE_TIMEOUT_MS: "200" });
  const db = await openDatabase(path.join(STATE, "hub.db"));
  try {
    db.exec("CREATE TABLE IF NOT EXISTS runs (id TEXT PRIMARY KEY, status TEXT NOT NULL)");
    db.exec("CREATE TABLE IF NOT EXISTS attach_settings (scope TEXT NOT NULL, scope_id TEXT NOT NULL, state TEXT NOT NULL, PRIMARY KEY (scope, scope_id))");
    assert.equal(hasActiveWork(db), false);
    // A run is active: the server stays up over several idle intervals, without a request
    // to keep it awake (a health check would reset the idle timer on its own).
    db.exec("INSERT INTO runs (id, status) VALUES ('r1', 'running')");
    assert.equal(hasActiveWork(db), true);
    await new Promise((r) => setTimeout(r, 1200));
    assert.equal(child.exitCode, null, "the server idle-exited while a run was active");
    assert.ok(await health(port));
    // The run is done and an agent is attached instead: still no idle exit.
    db.exec("UPDATE runs SET status = 'done'");
    db.exec("INSERT INTO attach_settings (scope, scope_id, state) VALUES ('page', 'p1', 'on')");
    assert.equal(hasActiveWork(db), true);
    await new Promise((r) => setTimeout(r, 1200));
    assert.equal(child.exitCode, null, "the server idle-exited while an agent was attached");
    // Nothing is going on: now the idle exit may do its work.
    db.exec("UPDATE attach_settings SET state = 'off'");
    assert.equal(hasActiveWork(db), false);
    const exited = new Promise((r) => child.once("exit", r));
    await Promise.race([exited, new Promise((r) => setTimeout(r, 5000))]);
    assert.notEqual(child.exitCode, null, "the server did not idle-exit when the work was done");
  } finally {
    db.close();
    await stop(child);
  }
});
