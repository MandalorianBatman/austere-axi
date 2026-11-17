import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { after, test } from "node:test";
import { health, serverAction } from "../src/cli/client.ts";
import type { ServerHealth } from "../src/cli/client.ts";
import { stateDirHolder } from "../src/cli/lock.ts";
import { hasActiveWork, openDatabase } from "../src/cli/hub.ts";
import { childEnv, detectUnit, installService, isAncestor, launchdPlist, npxWarning, parseSystemdShow, restartCommand, runsTheServer, serverUnit, serviceStatus, startInstalledService, systemdUnit, uninstallService, unitInCgroup, unitPort, unitStateDir } from "../src/cli/service.ts";
import type { ProcessView, RunResult, ServiceContext, ServiceSpec } from "../src/cli/service.ts";
import { launchdSettings, systemdSettings } from "../src/cli/unit-file.ts";
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

/**
 * A context over a temp HOME and a fake service manager that records what it was asked: no lock
 * holder, nothing on the port until the unit is started, then the unit's main process (pid 4242)
 * answers. The owner says yes to every question, which `asked` records.
 */
function context(over: Partial<ServiceContext> = {}): { ctx: ServiceContext; calls: string[]; asked: string[] } {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "austere-home-"));
  HOMES.push(home);
  const calls: string[] = [];
  const asked: string[] = [];
  const ctx: ServiceContext = {
    platform: "linux",
    home,
    env: { USER: "ana" },
    run: (cmd, args): RunResult => {
      calls.push([cmd, ...args].join(" "));
      if (cmd === "loginctl") return { code: 0, stdout: "no\n", stderr: "" };
      if (args.includes("is-enabled")) return { code: 0, stdout: "enabled\n", stderr: "" };
      if (args.includes("is-active")) return { code: 0, stdout: "inactive\n", stderr: "" };
      if (args[1] === "show" && args[2] === "austere-axi.service") return { code: 0, stdout: "MainPID=4242\n", stderr: "" };
      if (cmd === "launchctl" && args[0] === "print" && args[1].includes("xyz.kasat.austere-axi")) return { code: 0, stdout: "\tpid = 4242\n", stderr: "" };
      return { code: 0, stdout: "", stderr: "" };
    },
    isTTY: true,
    node: "/usr/bin/node",
    cli: CLI,
    stateDir: STATE,
    uid: 501,
    holder: async () => null,
    probe: async () => (calls.some((c) => c.includes("enable --now") || c.startsWith("launchctl bootstrap")) ? { stateDir: STATE, supervised: "systemd", pid: 4242 } : null),
    unitOf: () => null,
    isAncestor: (a, b) => a === b,
    confirm: async (q) => {
      asked.push(q);
      return true;
    },
    ...over,
  };
  return { ctx, calls, asked };
}

/** What changed the machine, without the questions asked of it. */
const changes = (calls: string[]): string[] => calls.filter((c) => !/ show-environment$| show | is-active | is-enabled |^launchctl print |^loginctl /.test(c));

const unitPath = (home: string): string => path.join(home, ".config", "systemd", "user", "austere-axi.service");

test("the systemd unit runs the installed CLI with --persist, supervised, restarting on failure", () => {
  assert.equal(
    systemdUnit(SPEC),
    `# Written by \`austere-axi server install\`; \`austere-axi server uninstall\` removes it.
[Unit]
Description=austere-axi review server
StartLimitIntervalSec=120
StartLimitBurst=5

[Service]
ExecStart=/usr/bin/node /usr/lib/node_modules/austere-axi/dist/cli.mjs server --persist --port 4388
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
  assert.equal(fs.readFileSync(unitPath(ctx.home), "utf8"), systemdUnit({ ...SPEC, linkUrl: "https://austere.example.com", stateDir: STATE }));
  assert.deepEqual(changes(calls), ["systemctl --user daemon-reload", "systemctl --user enable --now austere-axi.service"]);
  assert.equal(calls[0], "systemctl --user show-environment", "the service manager is asked first");
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
      if (args[1] === "show") return { code: 0, stdout: "MainPID=4242\n", stderr: "" };
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
  assert.deepEqual(changes(calls), ["launchctl bootout gui/501/xyz.kasat.austere-axi", `launchctl bootstrap gui/501 ${file}`]);
  assert.equal(calls[0], "launchctl print gui/501", "launchd is asked first");
  assert.match(String(r.notes), /AUSTERE_AXI_PORT=5000/);
});

test("a failed install leaves nothing behind: no systemd here, nothing is written and the next command is not stuck", async () => {
  // WSL without systemd, a container, a `su -` shell: systemctl is missing or has no user bus.
  for (const answer of [
    { code: null, stdout: "", stderr: "spawnSync systemctl ENOENT" },
    { code: 1, stdout: "", stderr: "Failed to connect to bus: No medium found" },
  ]) {
    const { ctx, calls, asked } = context({ run: (cmd, args) => (calls.push([cmd, ...args].join(" ")), answer) });
    await assert.rejects(installService({ linkUrl: "https://austere.example.com" }, ctx), (err: Error) => {
      assert.match(err.message, /systemd's user manager does not answer here/);
      assert.ok(err.message.includes(answer.stderr), err.message);
      assert.match(err.message, /nothing was written/);
      // The manual way: the command to run at login, with its variable.
      assert.match(err.message, /\/usr\/bin\/node \/usr\/lib\/node_modules\/austere-axi\/dist\/cli\.mjs server --persist --port 4388` with AUSTERE_AXI_LINK_URL=https:\/\/austere\.example\.com/);
      return true;
    });
    assert.deepEqual(calls, ["systemctl --user show-environment"]);
    assert.deepEqual(asked, []);
    assert.equal(fs.existsSync(unitPath(ctx.home)), false);
    // With no unit on disk, the next CLI command starts its own server instead of failing on systemctl.
    assert.equal(startInstalledService(ctx, STATE, 4388), false);
  }
});

test("a failed install after the unit was written puts back what was there", async () => {
  // systemd answers, then refuses to enable: the unit it wrote goes again.
  const failing = (calls: string[]) => (cmd: string, args: string[]): RunResult => {
    calls.push([cmd, ...args].join(" "));
    if (args.includes("enable")) return { code: 1, stdout: "", stderr: "Failed to enable unit: Unit file is masked." };
    return { code: 0, stdout: "", stderr: "" };
  };
  const calls: string[] = [];
  const { ctx } = context({ run: failing(calls) });
  await assert.rejects(installService({}, ctx), /enable --now austere-axi\.service` failed \(exit 1\): Failed to enable unit.*Nothing was changed: the unit it wrote was removed\. See why: journalctl --user -u austere-axi\.service/);
  assert.equal(fs.existsSync(unitPath(ctx.home)), false);
  // Over an earlier unit of its own: that unit is back as it was, and no backup is left over.
  const again: string[] = [];
  const { ctx: over } = context({ run: failing(again) });
  const before = systemdUnit({ ...SPEC, port: 5000, stateDir: STATE });
  fs.mkdirSync(path.dirname(unitPath(over.home)), { recursive: true });
  fs.writeFileSync(unitPath(over.home), before);
  await assert.rejects(installService({ port: 6000 }, over), /Nothing was changed: the units it replaced are back/);
  assert.equal(fs.readFileSync(unitPath(over.home), "utf8"), before);
  assert.deepEqual(fs.readdirSync(path.dirname(unitPath(over.home))), ["austere-axi.service"]);
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
  fs.mkdirSync(path.dirname(unitPath(ctx.home)), { recursive: true });
  fs.writeFileSync(unitPath(ctx.home), systemdUnit({ ...SPEC, stateDir: STATE }));
  const s = serviceStatus(ctx, { version: "0.0.1", pid: 42, port: 4388, supervised: "systemd" }, "0.0.2");
  assert.equal(s.installed, true);
  assert.equal(s.enabled, "enabled");
  assert.equal(s.active, "active");
  assert.match(String(s.next), /systemctl --user restart austere-axi.service/);
});

test("a CLI never replaces a supervised server; it says how to restart the unit", () => {
  const h = (over: Partial<ServerHealth>): ServerHealth => ({ name: "austere-axi", version: "0.10.0", pid: 1, port: 4388, stateDir: STATE, listen: [], persist: true, ...over });
  const noUnit = (): null => null;
  assert.deepEqual(serverAction(h({}), "0.10.0", noUnit), { action: "use" });
  assert.deepEqual(serverAction(h({}), "0.11.0", noUnit), { action: "replace" });
  assert.deepEqual(serverAction(h({ legacy: true }), "0.10.0", noUnit), { action: "replace" });
  assert.deepEqual(serverAction(h({ supervised: "systemd" }), "0.11.0", noUnit), { action: "restart-unit", unit: { supervisor: "systemd", unit: "austere-axi.service" } });
  // The unit's name comes from the server, so the hint restarts the unit that runs it.
  assert.deepEqual(serverAction(h({ supervised: "systemd", unit: "austere.service" }), "0.11.0", noUnit), { action: "restart-unit", unit: { supervisor: "systemd", unit: "austere.service" } });
  assert.deepEqual(serverAction(h({ supervised: "launchd" }), "0.10.0", noUnit), { action: "use" });
  assert.equal(restartCommand("systemd"), "systemctl --user restart austere-axi.service");
  assert.equal(restartCommand("launchd", 501), "launchctl kickstart -k gui/501/xyz.kasat.austere-axi");
  assert.equal(restartCommand("systemd", 501, "austere.service"), "systemctl --user restart austere.service");
});

// What `systemctl --user show <unit> --property=ExecStart --property=MainPID` printed on Linux for a
// running hand-written unit (the old README's shape, a global install), paths renamed.
const HAND_WRITTEN_CLI = "/home/ana/.npm-global/lib/node_modules/austere-axi/dist/cli.mjs";
const HAND_WRITTEN_SHOW = `MainPID=4242
ExecStart={ path=/usr/bin/node ; argv[]=/usr/bin/node ${HAND_WRITTEN_CLI} server --port 4388 ; ignore_errors=no ; start_time=[Tue 2026-11-17 05:13:25 UTC] ; stop_time=[n/a] ; pid=4242 ; code=(null) ; status=0/0 }
`;
const UNIT_CGROUP = "0::/user.slice/user-1000.slice/user@1000.service/app.slice/austere-axi.service\n";

/** A machine where pid 4242 is the main process of the unit `show` describes, and 4243 is its child. */
function processView(over: Partial<ProcessView> = {}): ProcessView {
  return {
    platform: "linux",
    uid: 1000,
    run: (cmd, args) => (cmd === "systemctl" && args[1] === "show" ? { code: 0, stdout: HAND_WRITTEN_SHOW, stderr: "" } : { code: 1, stdout: "", stderr: "" }),
    cgroup: () => UNIT_CGROUP,
    script: () => HAND_WRITTEN_CLI,
    isAncestor: (ancestor, pid) => ancestor === pid || (ancestor === 4242 && pid === 4243),
    ...over,
  };
}

test("the real systemctl show text of a hand-written unit names its command and main pid", () => {
  const job = parseSystemdShow(HAND_WRITTEN_SHOW);
  assert.equal(job.pid, 4242);
  assert.ok(runsTheServer(job.command, HAND_WRITTEN_CLI), job.command);
  assert.equal(unitInCgroup(UNIT_CGROUP), "austere-axi.service");
});

test("a server from before 0.12 that sits in a unit's cgroup is the unit's: restart it, never replace it", () => {
  // 0.10.4 does not report `supervised`; the system says a unit runs it.
  const old: ServerHealth = { name: "austere-axi", version: "0.10.4", pid: 4242, port: 4388, stateDir: STATE, listen: ["127.0.0.1"], persist: false };
  assert.deepEqual(serverAction(old, "0.12.0", () => serverUnit(old.pid, processView())), { action: "restart-unit", unit: { supervisor: "systemd", unit: "austere-axi.service" } });
  // Below the unit's main process (npx runs it so) counts too; the version does not matter.
  assert.deepEqual(serverAction({ ...old, pid: 4243, legacy: true }, "0.12.0", () => serverUnit(4243, processView())), { action: "restart-unit", unit: { supervisor: "systemd", unit: "austere-axi.service" } });
});

test("a stray server in another service's cgroup is not that service's, and is replaced", () => {
  // RLM-374: an agent's CLI started the server, so it sits in the agent daemon's unit.
  const daemon = processView({
    cgroup: () => "0::/user.slice/user-1000.slice/user@1000.service/app.slice/multica-host.service\n",
    run: () => ({ code: 0, stdout: "ExecStart={ path=/usr/bin/node ; argv[]=/usr/bin/node /home/ana/multica/daemon/index.js ; ignore_errors=no ; start_time=[n/a] ; stop_time=[n/a] ; pid=4000 ; code=(null) ; status=0/0 }\nMainPID=4000\n", stderr: "" }),
    isAncestor: () => true,
  });
  assert.equal(serverUnit(4243, daemon), null);
  // The unit runs the server, but some other process: not this one.
  assert.equal(serverUnit(9999, processView()), null);
  // In no service at all (a login shell's scope).
  assert.equal(serverUnit(4243, processView({ cgroup: () => "0::/user.slice/user-1000.slice/session-3.scope\n" })), null);
  const old: ServerHealth = { name: "austere-axi", version: "0.10.4", pid: 4243, port: 4388, stateDir: STATE, listen: [], persist: false };
  assert.deepEqual(serverAction(old, "0.12.0", () => serverUnit(old.pid, daemon)), { action: "replace" });
});

test("status names the pid and the fix when a server the service did not start holds its port", () => {
  const { ctx } = context({
    run: (cmd, args): RunResult => {
      if (args.includes("is-enabled")) return { code: 0, stdout: "enabled\n", stderr: "" };
      if (args.includes("is-active")) return { code: 3, stdout: "failed\n", stderr: "" };
      return { code: 0, stdout: "", stderr: "" };
    },
  });
  fs.mkdirSync(path.dirname(unitPath(ctx.home)), { recursive: true });
  fs.writeFileSync(unitPath(ctx.home), systemdUnit({ ...SPEC, stateDir: STATE }));
  const s = serviceStatus(ctx, { version: "0.12.0", pid: 3106419, port: 4388 }, "0.12.0");
  assert.equal(s.active, "failed");
  assert.equal(s.next, "the service cannot start: pid 3106419 holds port 4388 and was not started by the service. Run `austere-axi stop`.");
  // The same server, run by the unit (what serverUnit found for one from before 0.12): no lock-out.
  const ok = serviceStatus(ctx, { version: "0.10.4", pid: 4242, port: 4388, supervised: "systemd", unit: "austere-axi.service" }, "0.12.0");
  assert.match(String(ok.next), /Restart it: systemctl --user restart austere-axi\.service/);
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
    assert.deepEqual(changes(calls), []);
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
  // The supervisor is what the system says; the test asks for it directly, because a test
  // machine has no unit that runs this server. It runs in its own process: a server that
  // shuts down exits, and that would end the test run.
  const port = await freePort();
  const script = path.join(STATE, "supervised-server.ts");
  // A file URL: a Windows path is not a valid module specifier.
  const serverModule = pathToFileURL(path.resolve("src/cli/server.ts")).href;
  fs.writeFileSync(script, `import { runServer } from ${JSON.stringify(serverModule)};\nawait runServer({ port: Number(process.env.TEST_PORT), unit: { supervisor: "systemd", unit: "austere-axi.service" } });\n`);
  const child = spawn(process.execPath, [script], {
    env: { ...process.env, AUSTERE_AXI_STATE_DIR: STATE, AUSTERE_AXI_NO_TAILSCALE: "1", TEST_PORT: String(port) },
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
    const h = await health(port);
    assert.ok(h && !h.foreign);
    assert.equal(h.supervised, "systemd");
    assert.equal(h.unit, "austere-axi.service");
    assert.equal(h.persist, true);
    const lock = JSON.parse(fs.readFileSync(path.join(STATE, "server.lock"), "utf8"));
    assert.deepEqual([lock.supervised, lock.unit], ["systemd", "austere-axi.service"]);
    assert.equal((await stateDirHolder(STATE))?.unit, "austere-axi.service");
    const { ctx, calls } = context({ holder: stateDirHolder });
    const r = await installService({}, ctx);
    assert.equal(r.status, "installed");
    assert.ok(calls.includes("systemctl --user restart austere-axi.service"), calls.join("; "));
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

test("install refuses to overwrite a unit it did not write, and uninstall leaves it alone", async () => {
  const { ctx } = context();
  const file = unitPath(ctx.home);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, "[Unit]\nDescription=my own server\nEnvironment=AUSTERE_AXI_LINK_URL=https://mine.example\n");
  await assert.rejects(installService({}, ctx), /did not write\. `austere-axi server install --adopt` takes its place/);
  assert.match(fs.readFileSync(file, "utf8"), /my own server/);
  const r = uninstallService(ctx);
  assert.equal(r.status, "not installed");
  assert.match(String(r.note), /left alone/);
  assert.equal(fs.existsSync(file), true);
});

test("install refuses when something else already listens on the port", async () => {
  const { ctx } = context({ probe: async () => ({ foreign: true }) });
  await assert.rejects(installService({}, ctx), /already listens on port 4388/);
  assert.equal(fs.existsSync(unitPath(ctx.home)), false);
});

test("install fails when the service does not answer on its port, and takes the unit out again", async () => {
  const { ctx } = context({ probe: async () => null });
  await assert.rejects(installService({}, ctx), /did not answer on port 4388 within 15 s \(nothing answers\)\. Nothing was changed: the unit it wrote was removed/);
  assert.equal(fs.existsSync(unitPath(ctx.home)), false);
});

test("a CLI starts the installed service instead of one of its own", () => {
  const { ctx, calls } = context();
  fs.mkdirSync(path.dirname(unitPath(ctx.home)), { recursive: true });
  fs.writeFileSync(unitPath(ctx.home), systemdUnit({ ...SPEC, stateDir: STATE }));
  assert.equal(startInstalledService(ctx, STATE, 4388), true);
  // A unit that hit its start limit while locked out starts again: reset first.
  assert.deepEqual(calls, ["systemctl --user reset-failed austere-axi.service", "systemctl --user start austere-axi.service"]);
  // A unit for another state dir is another machine's business: leave it alone.
  const { ctx: other, calls: otherCalls } = context();
  fs.mkdirSync(path.dirname(unitPath(other.home)), { recursive: true });
  fs.writeFileSync(unitPath(other.home), systemdUnit({ ...SPEC, stateDir: "/home/ana/other-state" }));
  assert.equal(startInstalledService(other, STATE, 4388), false);
  assert.deepEqual(otherCalls, []);
});

test("when the installed service does not start, the error says how to see why and how to remove it", () => {
  const { ctx } = context({ run: (cmd, args) => (args.includes("start") ? { code: 1, stdout: "", stderr: "Job failed" } : { code: 0, stdout: "", stderr: "" }) });
  fs.mkdirSync(path.dirname(unitPath(ctx.home)), { recursive: true });
  fs.writeFileSync(unitPath(ctx.home), systemdUnit({ ...SPEC, stateDir: STATE }));
  assert.throws(() => startInstalledService(ctx, STATE, 4388), (e: Error) => {
    assert.match(e.message, /Job failed/);
    assert.match(e.message, /systemctl --user status austere-axi\.service/);
    assert.match(e.message, /austere-axi server uninstall/);
    assert.doesNotMatch(e.message, /restart/);
    return true;
  });
});

test("the state dir and port are read out of a systemd unit and a launchd agent alike", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "austere-unit-"));
  HOMES.push(dir);
  const systemd = path.join(dir, "austere-axi.service");
  fs.writeFileSync(systemd, systemdUnit({ ...SPEC, stateDir: "/home/ana/My State" }));
  assert.equal(unitStateDir(systemd), path.resolve("/home/ana/My State"));
  assert.equal(unitPort(systemd), 4388);
  const plain = path.join(dir, "plain.service");
  fs.writeFileSync(plain, systemdUnit({ ...SPEC, port: 5000 }));
  assert.equal(unitStateDir(plain), path.join(os.homedir(), ".austere-axi"));
  assert.equal(unitPort(plain), 5000);
  const plist = path.join(dir, "austere-axi.plist");
  fs.writeFileSync(plist, launchdPlist({ ...SPEC, port: 5000, stateDir: "/home/ana/other" }, "/tmp/server.log"));
  assert.equal(unitStateDir(plist), path.resolve("/home/ana/other"));
  assert.equal(unitPort(plist), 5000);
});

test("supervision is what the system says, not what a process claims", () => {
  // A variable cannot claim a supervisor: a CLI hands its environment to the server it
  // starts, and so does every shell.
  assert.equal(detectUnit({ AUSTERE_AXI_SUPERVISED: "systemd" }, "linux"), null);
  assert.equal(detectUnit({ INVOCATION_ID: "abc" }, "darwin"), null);
  assert.equal(childEnv({ INVOCATION_ID: "abc", XPC_SERVICE_NAME: "x", AUSTERE_AXI_SUPERVISED: "systemd", PATH: "/bin" }).INVOCATION_ID, undefined);
  assert.equal(childEnv({ INVOCATION_ID: "abc", XPC_SERVICE_NAME: "x", AUSTERE_AXI_SUPERVISED: "systemd", PATH: "/bin" }).PATH, "/bin");
});

test("server uninstall refuses without a terminal, like install does", () => {
  const { ctx: noTty, calls } = context({ isTTY: false });
  fs.mkdirSync(path.dirname(unitPath(noTty.home)), { recursive: true });
  fs.writeFileSync(unitPath(noTty.home), systemdUnit(SPEC));
  assert.throws(() => uninstallService(noTty), /needs the user at a terminal/);
  assert.deepEqual(calls, []);
  assert.equal(fs.existsSync(unitPath(noTty.home)), true);
});

test("uninstall removes the unit even when the service manager fails, and says so", () => {
  const { ctx } = context({
    run: (cmd, args): RunResult => {
      if (args.includes("disable")) return { code: 1, stdout: "", stderr: "Failed to connect to bus" };
      return { code: 0, stdout: "", stderr: "" };
    },
  });
  fs.mkdirSync(path.dirname(unitPath(ctx.home)), { recursive: true });
  fs.writeFileSync(unitPath(ctx.home), systemdUnit({ ...SPEC, stateDir: STATE }));
  const r = uninstallService(ctx);
  assert.equal(fs.existsSync(unitPath(ctx.home)), false);
  assert.match(String(r.problems), /disable --now/);
});

test("a server below the unit's main process is supervised too, as npx runs it", () => {
  // The old guide's unit was `ExecStart=/usr/bin/env npx -y austere-axi server --persist`:
  // npx runs the server below the unit's main process, and that server is supervised.
  assert.equal(isAncestor(process.pid, process.pid), true);
  if (process.platform === "win32") return; // Windows has no cheap way to read a parent pid
  assert.equal(isAncestor(process.ppid, process.pid), true); // my parent is an ancestor of me
  assert.equal(isAncestor(process.pid, process.ppid), false); // and not the other way round
});

test("only a unit that runs the austere server counts as the server's unit", () => {
  const cli = "/home/ana/.npm-global/lib/node_modules/austere-axi/dist/cli.mjs";
  assert.equal(runsTheServer(`/usr/bin/node ${cli} server --persist --port 4388`, cli), true);
  assert.equal(runsTheServer("/usr/bin/env npx -y austere-axi server --persist", "/home/ana/.npm/_npx/1a/node_modules/austere-axi/dist/cli.mjs"), true);
  assert.equal(runsTheServer("/usr/bin/node /home/ana/multica/daemon/index.js", cli), false);
  assert.equal(runsTheServer("/usr/bin/node /home/ana/other/cli.mjs serve", cli), false);
  // Another project's cli.mjs runs `server`: not ours, even when an austere server sits in its unit.
  assert.equal(runsTheServer("/usr/bin/node /home/ana/other/dist/cli.mjs server", cli), false);
  // A foreign unit referencing austere-axi only in an argument path is not ours.
  assert.equal(runsTheServer("/usr/bin/node /home/ana/other/dist/cli.mjs server --config /home/ana/austere-axi/settings.json", cli), false);
  // A dev checkout in a folder with any name: the unit runs this very script, so it is ours.
  const dev = "/home/ana/src/axi-fork/dist/cli.mjs";
  assert.equal(runsTheServer(`/usr/bin/node ${dev} server --persist --port 4388`, dev), true);
  assert.equal(runsTheServer("/usr/bin/node /home/ana/other/dist/cli.mjs server", dev), false);
});

// ── server install over what is already there (RLM-382) ──

// The hand-written unit the old README taught, as one ran on a Linux host (paths renamed): a
// wait for Tailscale, the network, a link url, a port, Restart=always.
const HAND_WRITTEN_UNIT = `# ~/.config/systemd/user/austere-axi.service
# austere-axi review server and hub, written by hand.

[Unit]
Description=austere-axi review server and hub
After=network-online.target docker.service
Wants=network-online.target

[Service]
Type=simple
Environment=AUSTERE_AXI_PORT=4388
Environment=AUSTERE_AXI_NO_OPEN=1
Environment=AUSTERE_AXI_LINK_URL=https://austere.example.com
Environment=OPENUI_TELEMETRY_DISABLED=1
# The server binds the tailnet IP only if Tailscale is already up when it starts.
ExecStartPre=/home/ana/.config/systemd/user/austere-axi-wait-tailscale.sh 90
ExecStart=/usr/bin/node %h/.npm-global/lib/node_modules/austere-axi/dist/cli.mjs server --port 4388
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
`;

/**
 * What `systemctl --user show <unit> --property=FragmentPath --property=UnitFileState
 * --property=ActiveState --property=MainPID` printed on Linux for that unit, disabled (paths renamed).
 */
const showText = (file: string, state = "disabled", active = "inactive", pid = 0): string => `MainPID=${pid}\nActiveState=${active}\nFragmentPath=${file}\nUnitFileState=${state}\n`;

/**
 * A machine with a unit at `file` (the hand-written one by default) on the default state dir, whose
 * `show` says `before` until `server install` enables its own unit, which then runs as pid 4242.
 */
function machineWith(text: string | null, { before = "disabled inactive", failOn = "" }: { before?: string; failOn?: string } = {}) {
  const c = context();
  const { ctx, calls } = c;
  ctx.stateDir = path.join(ctx.home, ".austere-axi");
  const started = (): boolean => calls.some((x) => x.endsWith("enable --now austere-axi.service"));
  const [state, active] = before.split(" ");
  ctx.run = (cmd, args): RunResult => {
    const line = [cmd, ...args].join(" ");
    calls.push(line);
    if (failOn && line.includes(failOn)) return { code: 1, stdout: "", stderr: `${failOn}: failed` };
    if (args[1] === "show" && args[2] === "austere-axi.service") return { code: 0, stdout: started() ? showText(unitPath(ctx.home), "enabled", "active", 4242) : showText(unitPath(ctx.home), state, active), stderr: "" };
    if (args.includes("is-active")) return { code: 0, stdout: started() ? "active\n" : `${active}\n`, stderr: "" };
    return { code: 0, stdout: "", stderr: "" };
  };
  ctx.probe = async () => (started() ? { stateDir: ctx.stateDir, supervised: "systemd", pid: 4242 } : null);
  if (text != null) {
    fs.mkdirSync(path.dirname(unitPath(ctx.home)), { recursive: true });
    fs.writeFileSync(unitPath(ctx.home), text);
  }
  return c;
}

test("a hand-written unit is read for what the new unit keeps: Environment=, ExecStartPre= and After= lines", () => {
  const s = systemdSettings(HAND_WRITTEN_UNIT);
  assert.equal(s.cli, "%h/.npm-global/lib/node_modules/austere-axi/dist/cli.mjs");
  assert.equal(s.port, 4388);
  assert.equal(s.linkUrl, "https://austere.example.com");
  assert.equal(s.stateDir, null);
  assert.deepEqual(s.kept, [
    { section: "Unit", line: "After=network-online.target docker.service" },
    { section: "Unit", line: "Wants=network-online.target" },
    { section: "Service", line: "Environment=AUSTERE_AXI_NO_OPEN=1" },
    { section: "Service", line: "Environment=OPENUI_TELEMETRY_DISABLED=1" },
    { section: "Service", line: "ExecStartPre=/home/ana/.config/systemd/user/austere-axi-wait-tailscale.sh 90" },
  ]);
  assert.deepEqual(s.other, ["Type=simple", "Restart=always", "RestartSec=5", "WantedBy=default.target"]);
  // Several assignments on one line: the new unit's own variables leave it, the rest stays as written.
  const mixed = systemdSettings('[Service]\nEnvironment="A=1 2" AUSTERE_AXI_STATE_DIR=/srv/austere B=2\nExecStart=/usr/bin/node "/opt/my axi/cli.mjs" server\n');
  assert.deepEqual(mixed.kept, [{ section: "Service", line: 'Environment="A=1 2" B=2' }]);
  assert.equal(mixed.stateDir, "/srv/austere");
  assert.equal(mixed.cli, "/opt/my axi/cli.mjs");
  assert.equal(mixed.port, null);
  // The unit `server install` writes has nothing of its own to keep.
  assert.deepEqual(systemdSettings(systemdUnit({ ...SPEC, stateDir: STATE })).kept, []);
  assert.deepEqual(launchdSettings(launchdPlist({ ...SPEC, port: 5000, env: [["HTTPS_PROXY", "http://proxy:3128"]] }, "/tmp/log")), {
    cli: SPEC.cli,
    port: 5000,
    stateDir: null,
    linkUrl: SPEC.linkUrl,
    kept: [{ section: "Service", line: "HTTPS_PROXY=http://proxy:3128" }],
    other: [],
  });
});

test("install --adopt takes the place of a hand-written unit: shows what it keeps, asks, backs it up, stops and disables it", async () => {
  const refused = machineWith(HAND_WRITTEN_UNIT);
  await assert.rejects(installService({}, refused.ctx), /there is already a unit at .* that `austere-axi server install` did not write\. `austere-axi server install --adopt` takes its place/);
  assert.equal(fs.readFileSync(unitPath(refused.ctx.home), "utf8"), HAND_WRITTEN_UNIT);
  assert.deepEqual(changes(refused.calls), []);

  const { ctx, calls, asked } = machineWith(HAND_WRITTEN_UNIT);
  const file = unitPath(ctx.home);
  const dropIn = path.join(`${file}.d`, "kept.conf");
  const r = await installService({ adopt: true }, ctx);
  assert.equal(r.status, "installed");
  // What the owner was asked: the command, the port, the state dir and the link url it runs
  // with, what it keeps where, what it leaves out, and what happens to the old unit.
  const question = asked[0];
  for (const line of [
    `ExecStart: /usr/bin/node ${CLI} server --persist --port 4388`,
    "  port: 4388\n",
    `  state dir: ${ctx.stateDir}\n`,
    "  link url: https://austere.example.com\n",
    `  keeps, in ${dropIn}:\n    After=network-online.target docker.service\n    Wants=network-online.target\n    Environment=AUSTERE_AXI_NO_OPEN=1\n    Environment=OPENUI_TELEMETRY_DISABLED=1\n    ExecStartPre=/home/ana/.config/systemd/user/austere-axi-wait-tailscale.sh 90\n`,
    "  does not keep (the backup has them):\n    Type=simple\n    Restart=always\n  stops",
    `  stops and disables austere-axi.service, and moves ${file} to ${file}.bak`,
  ]) {
    assert.ok(question.includes(line), `${JSON.stringify(line)} not in:\n${question}`);
  }
  assert.doesNotMatch(question, /WantedBy|RestartSec/); // the new unit has them too
  // The old unit is stopped and disabled before its file moves; then the new one starts.
  assert.deepEqual(changes(calls), ["systemctl --user disable --now austere-axi.service", "systemctl --user daemon-reload", "systemctl --user enable --now austere-axi.service"]);
  assert.equal(fs.readFileSync(`${file}.bak`, "utf8"), HAND_WRITTEN_UNIT);
  assert.equal(fs.readFileSync(file, "utf8"), systemdUnit({ ...SPEC, linkUrl: "https://austere.example.com" }));
  const kept = fs.readFileSync(dropIn, "utf8");
  assert.match(kept, /^# Written by `austere-axi server install`: what it kept of /);
  assert.match(kept, /\[Unit\]\nAfter=network-online\.target docker\.service\nWants=network-online\.target\n\n\[Service\]\nEnvironment=AUSTERE_AXI_NO_OPEN=1\nEnvironment=OPENUI_TELEMETRY_DISABLED=1\nExecStartPre=\/home\/ana\/\.config\/systemd\/user\/austere-axi-wait-tailscale\.sh 90\n$/);
  assert.doesNotMatch(kept, /AUSTERE_AXI_(PORT|LINK_URL)/);
  assert.deepEqual([r.kept_in, r.stopped, r.backups], [dropIn, ["austere-axi.service"], [`${file}.bak`]]);

  // Installed again while its server runs, nothing changes: no new backup, the drop-in as it was.
  ctx.holder = async () => ({ pid: 4242, port: 4388, serving: true, supervised: "systemd", unit: "austere-axi.service" });
  asked.length = 0;
  const again = await installService({}, ctx);
  assert.equal(again.backups, undefined);
  assert.equal(fs.readFileSync(dropIn, "utf8"), kept);
  assert.doesNotMatch(asked[0], /keeps|backs up/);
  // Uninstall takes the drop-in with the unit; the backup of the owner's unit stays.
  const u = uninstallService(ctx);
  assert.equal(u.drop_in, dropIn);
  assert.equal(fs.existsSync(`${file}.d`), false);
  assert.deepEqual(fs.readdirSync(path.dirname(file)), ["austere-axi.service.bak"]);
});

test("a failed adoption puts the owner's unit back, enabled and running as it was", async () => {
  const { ctx, calls } = machineWith(HAND_WRITTEN_UNIT, { before: "enabled active", failOn: "enable --now austere-axi.service" });
  const file = unitPath(ctx.home);
  await assert.rejects(installService({ adopt: true }, ctx), /enable --now austere-axi\.service` failed.*Nothing was changed: the units it replaced are back/);
  assert.equal(fs.readFileSync(file, "utf8"), HAND_WRITTEN_UNIT);
  assert.deepEqual(fs.readdirSync(path.dirname(file)), ["austere-axi.service"]);
  const after = changes(calls).slice(changes(calls).indexOf("systemctl --user enable --now austere-axi.service") + 1);
  assert.deepEqual(after, ["systemctl --user disable --now austere-axi.service", "systemctl --user daemon-reload", "systemctl --user enable austere-axi.service", "systemctl --user start austere-axi.service"]);
});

test("a server run by a hand-written unit under another name is that unit's: install says so, and --adopt takes it over", async () => {
  // A server from before 0.12: its lock names no supervisor; the system names the unit.
  const setup = (fragment: (home: string) => string) => {
    const c = machineWith(null);
    const { ctx } = c;
    const own = path.join(path.dirname(unitPath(ctx.home)), "austere.service");
    fs.mkdirSync(path.dirname(own), { recursive: true });
    fs.writeFileSync(own, HAND_WRITTEN_UNIT);
    ctx.holder = async () => ({ pid: 777, port: 4388, serving: true });
    ctx.unitOf = (pid) => (pid === 777 ? { supervisor: "systemd", unit: "austere.service" } : null);
    const base = ctx.run;
    const stopped = (): boolean => c.calls.includes("systemctl --user disable --now austere.service");
    ctx.run = (cmd, args) => (args[1] === "show" && args[2] === "austere.service" ? (c.calls.push([cmd, ...args].join(" ")), { code: 0, stdout: showText(fragment(ctx.home), "enabled", "active", 777), stderr: "" }) : base(cmd, args));
    const probe = ctx.probe;
    ctx.probe = async (port) => (await probe(port)) ?? (stopped() ? null : { stateDir: ctx.stateDir, supervised: undefined, pid: 777 });
    return { ...c, own };
  };
  const { ctx, calls, own } = setup((home) => path.join(home, ".config", "systemd", "user", "austere.service"));
  await assert.rejects(installService({}, ctx), (err: Error) => {
    assert.match(err.message, /the server here \(pid 777\) runs under austere\.service \(.*austere\.service\), which `austere-axi server install` did not write\. `austere-axi server install --adopt` takes its place/);
    assert.doesNotMatch(err.message, /not started by|austere-axi stop/);
    return true;
  });
  const r = await installService({ adopt: true }, ctx);
  assert.equal(r.status, "installed");
  assert.deepEqual(r.stopped, ["austere.service"]);
  assert.equal(fs.readFileSync(`${own}.bak`, "utf8"), HAND_WRITTEN_UNIT);
  assert.equal(fs.existsSync(own), false);
  assert.ok(calls.indexOf("systemctl --user disable --now austere.service") < calls.indexOf("systemctl --user enable --now austere-axi.service"));
  // A unit outside the user's unit folder is not this command's to move.
  const elsewhere = setup(() => "/etc/systemd/user/austere.service");
  await assert.rejects(installService({ adopt: true }, elsewhere.ctx), /runs under austere\.service \(\/etc\/systemd\/user\/austere\.service\).*cannot take over.*`systemctl --user disable --now austere\.service`/);
  assert.deepEqual(changes(elsewhere.calls), []);
});

test("install asks first, with what it will run; no changes nothing", async () => {
  const { ctx, calls, asked } = context();
  ctx.confirm = async (q) => (asked.push(q), false);
  const r = await installService({ port: 5000, linkUrl: "https://austere.example.com" }, ctx);
  assert.deepEqual(r, { status: "cancelled", unit: unitPath(ctx.home), note: "nothing was changed" });
  assert.match(asked[0], new RegExp(`will write ${unitPath(ctx.home)}:\\n  ExecStart: /usr/bin/node ${CLI} server --persist --port 5000\\n  port: 5000\\n  state dir: ${STATE}\\n  link url: https://austere.example.com\\nGo ahead\\?$`));
  assert.deepEqual(changes(calls), []);
  assert.equal(fs.existsSync(unitPath(ctx.home)), false);
});

test("re-install keeps the unit's port, link url and hand edits, and backs up the unit it replaces", async () => {
  const { ctx, asked } = context();
  const file = unitPath(ctx.home);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // The owner added a wait to the generated unit and made it restart always.
  const edited = systemdUnit({ ...SPEC, port: 5000, stateDir: STATE }).replace("Restart=on-failure", "ExecStartPre=/bin/sleep 5\nRestart=always");
  fs.writeFileSync(file, edited);
  ctx.probe = async () => (asked.length ? { stateDir: STATE, supervised: "systemd", pid: 4242 } : null);
  const r = await installService({}, ctx);
  assert.equal(r.port, 5000);
  assert.equal(r.link_url, SPEC.linkUrl);
  assert.match(asked[0], /  port: 5000\n/);
  assert.match(asked[0], /keeps, in .*kept\.conf:\n    ExecStartPre=\/bin\/sleep 5\n  does not keep \(the backup has them\):\n    Restart=always\n  backs up the unit it replaces to .*austere-axi\.service\.bak\n/);
  assert.equal(fs.readFileSync(`${file}.bak`, "utf8"), edited);
  assert.match(fs.readFileSync(path.join(`${file}.d`, "kept.conf"), "utf8"), /\[Service\]\nExecStartPre=\/bin\/sleep 5\n$/);
  // A new port is shown against the old one; an earlier backup is never overwritten.
  asked.length = 0;
  await installService({ port: 6000 }, ctx);
  assert.match(asked[0], /  port: 6000 \(was 5000\)\n/);
  assert.equal(fs.readFileSync(`${file}.bak`, "utf8"), edited);
  assert.ok(fs.existsSync(`${file}.bak.1`));
});

test("install and uninstall refuse a unit of another state dir or another CLI unless --force", async () => {
  // The owner's unit; then a CLI from a checkout, on its own state dir, runs install and uninstall.
  const { ctx, calls } = context();
  const file = unitPath(ctx.home);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const owners = systemdUnit({ ...SPEC, stateDir: "/home/ana/.austere-axi" });
  fs.writeFileSync(file, owners);
  const checkout = "/home/ana/src/austere-axi/src/cli/main.ts";
  ctx.cli = checkout;
  await assert.rejects(installService({ port: 5000 }, ctx), new RegExp(`${file} serves the state dir /home/ana/\\.austere-axi, and this CLI uses ${STATE}\\. .*add --force`));
  assert.throws(() => uninstallService(ctx), /serves the state dir \/home\/ana\/\.austere-axi.*add --force to remove it anyway/);
  assert.equal(fs.readFileSync(file, "utf8"), owners);
  // Same state dir, another CLI: refused too.
  fs.writeFileSync(file, systemdUnit({ ...SPEC, stateDir: STATE }));
  await assert.rejects(installService({}, ctx), new RegExp(`runs ${CLI}, and this CLI is ${checkout}`));
  assert.throws(() => uninstallService(ctx), new RegExp(`runs ${CLI}, and this CLI is ${checkout}`));
  assert.deepEqual(changes(calls), []);
  // --force: the owner meant it.
  const r = await installService({ force: true }, ctx);
  assert.equal(r.status, "installed");
  assert.match(fs.readFileSync(file, "utf8"), new RegExp(`ExecStart=/usr/bin/node ${checkout} server`));
  fs.writeFileSync(file, owners);
  assert.equal(uninstallService(ctx, { force: true }).status, "uninstalled");
});

test("installed means the unit's own process answers, not a server another unit runs", async () => {
  // A server of another state dir already on the port: refused before anything is written.
  const taken = context({ probe: async () => ({ stateDir: "/home/ana/other", supervised: "systemd", pid: 5 }) });
  await assert.rejects(installService({}, taken.ctx), /already listens on port 4388 \(an austere-axi server for \/home\/ana\/other\)/);
  assert.deepEqual(changes(taken.calls), []);
  // After the start, pid 999 answers while the unit's main process is 4242: not installed.
  let started = false;
  const { ctx } = context({ probe: async () => (started ? { stateDir: STATE, supervised: "systemd", pid: 999 } : null) });
  const base = ctx.run;
  ctx.run = (cmd, args) => {
    if (args.includes("enable")) started = true;
    return base(cmd, args);
  };
  await assert.rejects(installService({}, ctx), /did not answer on port 4388 within 15 s \(pid 999 answers, and the service's process is pid 4242\)\. Nothing was changed/);
  assert.equal(fs.existsSync(unitPath(ctx.home)), false);
});

test("launchd: --adopt keeps the agent's own variables in the new one", async () => {
  const { ctx, calls, asked } = context({ platform: "darwin" });
  const file = path.join(ctx.home, "Library", "LaunchAgents", "xyz.kasat.austere-axi.plist");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const mine = launchdPlist({ ...SPEC, stateDir: STATE, env: [["HTTPS_PROXY", "http://proxy:3128"]] }, "/tmp/log").replace(/<!-- Written by[^\n]*\n/, "");
  fs.writeFileSync(file, mine);
  await assert.rejects(installService({}, ctx), /did not write\. `austere-axi server install --adopt` takes its place: it shows what it keeps of it \(its environment variables\)/);
  const r = await installService({ adopt: true }, ctx);
  assert.equal(r.status, "installed");
  assert.match(asked[0], /keeps, in its environment:\n    HTTPS_PROXY=http:\/\/proxy:3128\n/);
  assert.match(fs.readFileSync(file, "utf8"), /<key>HTTPS_PROXY<\/key><string>http:\/\/proxy:3128<\/string>/);
  assert.equal(fs.readFileSync(`${file}.bak`, "utf8"), mine);
  assert.deepEqual(changes(calls).slice(0, 1), ["launchctl bootout gui/501/xyz.kasat.austere-axi"]);
});
