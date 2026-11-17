import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { after, test } from "node:test";
import { health, serverAction } from "../src/cli/client.ts";
import type { ServerHealth } from "../src/cli/client.ts";
import { stateDirHolder } from "../src/cli/lock.ts";
import { hasActiveWork, openDatabase } from "../src/cli/hub.ts";
import { childEnv, detectUnit, installService, isAncestor, launchdPlist, nodeWarning, npxWarning, parseLaunchctlList, parsePsScript, parseSystemdShow, restartCommand, restartHint, restartUnit, runsTheServer, serverPort, serverUnit, serviceStatus, stableNode, startInstalledService, systemdUnit, uninstallService, unitInCgroup, unitPort, unitStateDir } from "../src/cli/service.ts";
import type { ProcessView, RunResult, ServiceContext, ServiceSpec } from "../src/cli/service.ts";
import { format } from "../src/cli/output.ts";
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
const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

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
  assert.match(String(r.notes), /stops it when your last session ends \(you log out, or the last ssh connection closes\)\. Run `loginctl enable-linger` once/);
  assert.equal(r.warnings, undefined);
  assert.equal(r.next, "austere-axi server status shows it; austere-axi server restart restarts it (after upgrading austere-axi, too); austere-axi server uninstall removes it.");
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
  assert.match(String(r.notes), /It listens on port 5000\. CLI commands on this state dir find it there: the server's server\.lock names its port, and the unit does while it is stopped\./);
  // AUSTERE_AXI_PORT outranks both: the note says it points elsewhere.
  const { ctx: pinned } = context({ platform: "darwin", env: { USER: "ana", AUSTERE_AXI_PORT: "4400" } });
  const p = await installService({ port: 5000 }, pinned);
  assert.match(String(p.notes), /AUSTERE_AXI_PORT=4400 sends CLI commands to another one: set it to 5000, or unset it/);
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
  assert.match(String(r.warnings), /npm install -g austere-axi/);
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

/**
 * A machine with the unit `server install` writes for STATE, run by node at `<home>/bin/node`;
 * systemd's `show` answers `show`, loginctl says linger is `lingerValue`, launchctl print answers `print`.
 */
function statusMachine({ show = "", lingerValue = "no", print = null, platform = "linux", node, stateDir = STATE }: { show?: string; lingerValue?: string; print?: string | null; platform?: NodeJS.Platform; node?: string; stateDir?: string } = {}) {
  const c = context({
    platform,
    run: (cmd, args): RunResult => {
      c.calls.push([cmd, ...args].join(" "));
      if (cmd === "loginctl") return { code: 0, stdout: `${lingerValue}\n`, stderr: "" };
      if (cmd === "systemctl" && args[1] === "show") return { code: 0, stdout: show, stderr: "" };
      if (cmd === "launchctl" && args[0] === "print") return print == null ? { code: 113, stdout: "", stderr: "Could not find service" } : { code: 0, stdout: print, stderr: "" };
      return { code: 0, stdout: "", stderr: "" };
    },
  });
  const bin = path.join(c.ctx.home, "bin", "node");
  fs.mkdirSync(path.dirname(bin), { recursive: true });
  fs.writeFileSync(bin, "");
  const spec = { node: node ?? bin, cli: CLI, port: 4388, stateDir };
  const file = platform === "darwin" ? path.join(c.ctx.home, "Library", "LaunchAgents", "xyz.kasat.austere-axi.plist") : unitPath(c.ctx.home);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, platform === "darwin" ? launchdPlist(spec, "/tmp/log") : systemdUnit(spec));
  return c;
}

/** What `server status` prints, with the temp HOME as `~` and the state dir as `$STATE`. */
const shown = (ctx: ServiceContext, out: object): string => format(out).replaceAll(STATE, "$STATE").replaceAll(ctx.home, "~").replaceAll("\\", "/");

const RUNNING = "ActiveState=active\nSubState=running\nUnitFileState=enabled\nMainPID=4242\n";
const SERVED = { version: "0.12.0", pid: 4242, port: 4388, supervised: "systemd" as const, unit: "austere-axi.service" };

test("status snapshot: running, starts at login, linger off says what logout does", () => {
  const { ctx } = statusMachine({ show: RUNNING });
  assert.equal(
    shown(ctx, serviceStatus(ctx, SERVED, "0.12.0")),
    [
      "service: running",
      "supervisor: systemd",
      "unit: ~/.config/systemd/user/austere-axi.service",
      "port: 4388",
      "starts: at login",
      "linger: off",
      "server: v0.12.0, pid 4242, port 4388, run by austere-axi.service",
      'note: "linger is off: systemd starts the service when you log in and stops it when your last session ends (you log out, or the last ssh connection closes). Run `loginctl enable-linger` once to keep it running without a session and start it at boot."',
    ].join("\n"),
  );
});

test("status snapshot: a unit that restarts in a loop is failing to start, with linger on it starts at boot", () => {
  const { ctx } = statusMachine({ show: "ActiveState=activating\nSubState=auto-restart\nUnitFileState=enabled\n", lingerValue: "yes" });
  assert.equal(
    shown(ctx, serviceStatus(ctx, null, "0.12.0")),
    [
      "service: failing to start",
      "supervisor: systemd",
      "unit: ~/.config/systemd/user/austere-axi.service",
      "port: 4388",
      "starts: at boot",
      "linger: on",
      "server: not running",
      'next: "It does not stay up. See why: journalctl --user -u austere-axi.service -n 50; then `austere-axi server restart`."',
    ].join("\n"),
  );
  // A unit that hit its start limit says the same; one that is only starting says so.
  const failed = statusMachine({ show: "ActiveState=failed\nSubState=failed\nUnitFileState=enabled\n", lingerValue: "yes" }).ctx;
  assert.equal(serviceStatus(failed, null, "0.12.0").service, "failing to start");
  const starting = statusMachine({ show: "ActiveState=activating\nSubState=start\nUnitFileState=enabled\n", lingerValue: "yes" }).ctx;
  assert.equal(serviceStatus(starting, null, "0.12.0").service, "starting");
});

test("status snapshot: stopped and disabled, and how to start it", () => {
  const { ctx } = statusMachine({ show: "ActiveState=inactive\nSubState=dead\nUnitFileState=disabled\n", lingerValue: "yes" });
  assert.equal(
    shown(ctx, serviceStatus(ctx, null, "0.12.0")),
    [
      "service: stopped",
      "supervisor: systemd",
      "unit: ~/.config/systemd/user/austere-axi.service",
      "port: 4388",
      "starts: not on its own (disabled)",
      "linger: on",
      "server: not running",
      'next: "Start it: `austere-axi server restart` (the next command that needs a server starts it too)."',
    ].join("\n"),
  );
});

test("status: a supervised server on an older version is restarted with server restart", () => {
  const { ctx } = statusMachine({ show: RUNNING, lingerValue: "yes" });
  const s = serviceStatus(ctx, { ...SERVED, version: "0.0.1" }, "0.0.2");
  assert.equal(s.next, "The server runs v0.0.1 and this CLI is v0.0.2. Restart it: austere-axi server restart");
  // A launchd agent whose label was not found is restarted by hand.
  const mac = statusMachine({ platform: "darwin", print: "\tstate = running\n\tpid = 4242\n" }).ctx;
  assert.match(String(serviceStatus(mac, { version: "0.0.1", pid: 4242, port: 4388, supervised: "launchd" }, "0.0.2").next), /Restart it: launchctl kickstart -k gui\/501\/<launchd-label> \(`launchctl list` shows the label\)/);
});

test("status snapshot: a unit for another state dir is named, and its state is not reported as this one's", () => {
  const { ctx, calls } = statusMachine({ show: RUNNING, stateDir: "/home/ana/.austere-axi" });
  calls.length = 0;
  assert.equal(
    shown(ctx, serviceStatus(ctx, null, "0.12.0")),
    [
      "service: not installed for this state dir",
      "supervisor: systemd",
      "unit: ~/.config/systemd/user/austere-axi.service",
      "server: not running",
      `note: "that unit serves ${path.resolve("/home/ana/.austere-axi").replaceAll("\\", "/")}, and this CLI uses $STATE; its state is not this state dir's."`,
    ].join("\n"),
  );
  assert.deepEqual(calls, [], "the real unit's state is not asked for");
});

test("status snapshot: launchd agent running, then failing after a failed exit", () => {
  const { ctx } = statusMachine({ platform: "darwin", print: "\tstate = running\n\tpid = 4242\n" });
  assert.equal(
    shown(ctx, serviceStatus(ctx, { ...SERVED, supervised: "launchd", unit: "xyz.kasat.austere-axi" }, "0.12.0")),
    [
      "service: running",
      "supervisor: launchd",
      "unit: ~/Library/LaunchAgents/xyz.kasat.austere-axi.plist",
      "port: 4388",
      "starts: at login",
      "server: v0.12.0, pid 4242, port 4388, run by xyz.kasat.austere-axi",
    ].join("\n"),
  );
  const failing = statusMachine({ platform: "darwin", print: "\tstate = not running\n\tlast exit code = 1\n" }).ctx;
  assert.equal(serviceStatus(failing, null, "0.12.0").service, "failing to start");
  assert.equal(serviceStatus(statusMachine({ platform: "darwin", print: "\tstate = spawn scheduled\n" }).ctx, null, "0.12.0").service, "failing to start");
  const unloaded = statusMachine({ platform: "darwin" }).ctx;
  assert.equal(serviceStatus(unloaded, null, "0.12.0").service, "stopped");
});

test("status warns when the unit runs node from a folder of one release, and when that node is gone", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "austere-node-"));
  HOMES.push(home);
  const versioned = path.join(home, "node-v24.22.3-linux-x64", "bin", "node");
  fs.mkdirSync(path.dirname(versioned), { recursive: true });
  fs.writeFileSync(versioned, "");
  const { ctx } = statusMachine({ show: RUNNING, lingerValue: "yes", node: versioned });
  assert.deepEqual(serviceStatus(ctx, SERVED, "0.12.0").warnings, [nodeWarning(versioned)]);
  const gone = statusMachine({ show: RUNNING, lingerValue: "yes", node: "/opt/node-v24.0.0-linux-x64/bin/node" }).ctx;
  assert.deepEqual(serviceStatus(gone, SERVED, "0.12.0").warnings, [
    "the unit runs node from /opt/node-v24.0.0-linux-x64/bin/node, which is not there any more: the service cannot start. Run `austere-axi server install` again.",
  ]);
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
  // A launchd server whose label the system would not name: never replaced, and no label is guessed.
  assert.deepEqual(serverAction(h({ supervised: "launchd" }), "0.11.0", noUnit), { action: "restart-unit", unit: { supervisor: "launchd", unit: "<launchd-label>" } });
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
    ancestors: (pid) => (pid === 4243 ? [4243, 4242, 1] : [pid, 1]),
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

// `launchctl list` and `launchctl print gui/501/<label>` on macOS: the user's agents and what runs under them.
const LAUNCHCTL_LIST = `PID\tStatus\tLabel
-\t0\tcom.apple.Spotlight
812\t0\tapplication.com.apple.Terminal.1234.5678
901\t0\tcom.ana.review-server
-\t78\tcom.example.other
`;
const MAC_CLI = "/usr/local/lib/node_modules/austere-axi/dist/cli.mjs";
const printOf = (label: string, pid: number, program: string): string => `gui/501/${label} = {
\tactive count = 1
\tpath = /Users/ana/Library/LaunchAgents/${label}.plist
\tstate = running
\tprogram = ${program}
\targuments = {
\t\t${program}
\t\t${MAC_CLI}
\t\tserver
\t\t--persist
\t}
\tpid = ${pid}
}
`;

/** A Mac where agent com.ana.review-server (pid 901) runs the server; 902 is the server when node runs below it, 903 one started from Terminal (pid 812). */
function macView(over: Partial<ProcessView> = {}): ProcessView {
  return {
    platform: "darwin",
    uid: 501,
    run: (cmd, args) => {
      if (cmd !== "launchctl") return { code: 1, stdout: "", stderr: "" };
      if (args[0] === "list") return { code: 0, stdout: LAUNCHCTL_LIST, stderr: "" };
      if (args[1] === "gui/501/com.ana.review-server") return { code: 0, stdout: printOf("com.ana.review-server", 901, "/usr/local/bin/node"), stderr: "" };
      if (args[1] === "gui/501/application.com.apple.Terminal.1234.5678") return { code: 0, stdout: "gui/501/application.com.apple.Terminal = {\n\tprogram = /System/Applications/Utilities/Terminal.app/Contents/MacOS/Terminal\n\tpid = 812\n}\n", stderr: "" };
      return { code: 113, stdout: "", stderr: "Could not find service" };
    },
    cgroup: () => null,
    script: () => MAC_CLI,
    ancestors: (pid) => (pid === 902 ? [902, 901, 1] : pid === 903 ? [903, 850, 812, 1] : [pid, 1]),
    ...over,
  };
}

test("launchctl list rows with a running pid name their label", () => {
  assert.deepEqual(parseLaunchctlList(LAUNCHCTL_LIST), [
    { pid: 812, label: "application.com.apple.Terminal.1234.5678" },
    { pid: 901, label: "com.ana.review-server" },
  ]);
});

test("parsePsScript extracts the script path and avoids space-split prefixes", () => {
  // Standard command line with node and script path.
  assert.equal(parsePsScript("/usr/local/bin/node /opt/austere-axi/dist/cli.mjs server --persist"), "/opt/austere-axi/dist/cli.mjs");
  assert.equal(parsePsScript("node src/cli/main.ts server"), "src/cli/main.ts");
  // Quoted paths with spaces.
  assert.equal(parsePsScript('node "/Users/ana/My Apps/cli.mjs" server --persist'), "/Users/ana/My Apps/cli.mjs");
  assert.equal(parsePsScript("node '/Users/ana/My Apps/cli.mjs' server"), "/Users/ana/My Apps/cli.mjs");
  // Unquoted path with spaces cannot be safely separated from arguments; returns null to fall back to CLI_ENTRY.
  assert.equal(parsePsScript("node /Users/ana/My Apps/cli.mjs server"), null);
  // Non-script command or unrelated binary.
  assert.equal(parsePsScript("/usr/bin/tmux new -s session"), null);
});

test("a server under a launchd agent with its own label is the agent's: left alone, and the hint names that label", () => {
  // RLM-400: a 0.11 server (no `supervised` in its health) under a hand-written agent, as the first 0.12 CLI sees it.
  const old: ServerHealth = { name: "austere-axi", version: "0.11.0", pid: 902, port: 4388, stateDir: STATE, listen: ["127.0.0.1"], persist: true };
  const plan = serverAction(old, "0.12.0", () => serverUnit(old.pid, macView()));
  assert.deepEqual(plan, { action: "restart-unit", unit: { supervisor: "launchd", unit: "com.ana.review-server" } });
  assert.equal(restartCommand("launchd", 501, "com.ana.review-server"), "launchctl kickstart -k gui/501/com.ana.review-server");
  // The server is the agent's own main process (it execs, no wrapper): no `print` is needed.
  const exec = macView({ ancestors: (pid) => [pid, 1], run: (cmd, args) => (args[0] === "list" ? { code: 0, stdout: "901\t0\tcom.ana.review-server\n", stderr: "" } : { code: 1, stdout: "", stderr: "" }) });
  assert.deepEqual(serverUnit(901, exec), { supervisor: "launchd", unit: "com.ana.review-server" });
});

test("a server started by hand on a Mac is not an agent's, even below an app that launchd runs", () => {
  const stray: ServerHealth = { name: "austere-axi", version: "0.11.0", pid: 903, port: 4388, stateDir: STATE, listen: [], persist: false };
  assert.equal(serverUnit(903, macView()), null);
  assert.deepEqual(serverAction(stray, "0.12.0", () => serverUnit(stray.pid, macView())), { action: "replace" });
  // An agent that runs something else (a tmux) does not own the server below it.
  const tmux = macView({ run: (cmd, args) => (args[0] === "list" ? { code: 0, stdout: "901\t0\tcom.ana.tmux\n", stderr: "" } : { code: 0, stdout: "gui/501/com.ana.tmux = {\n\tprogram = /opt/homebrew/bin/tmux\n\tpid = 901\n}\n", stderr: "" }) });
  assert.equal(serverUnit(902, tmux), null);
  // launchctl cannot be asked: no answer, so the old rules apply.
  assert.equal(serverUnit(902, macView({ run: () => ({ code: null, stdout: "", stderr: "spawn launchctl ENOENT" }) })), null);
});

test("a stray server in another service's cgroup is not that service's, and is replaced", () => {
  // RLM-374: an agent's CLI started the server, so it sits in the agent daemon's unit.
  const daemon = processView({
    cgroup: () => "0::/user.slice/user-1000.slice/user@1000.service/app.slice/multica-host.service\n",
    run: () => ({ code: 0, stdout: "ExecStart={ path=/usr/bin/node ; argv[]=/usr/bin/node /home/ana/multica/daemon/index.js ; ignore_errors=no ; start_time=[n/a] ; stop_time=[n/a] ; pid=4000 ; code=(null) ; status=0/0 }\nMainPID=4000\n", stderr: "" }),
    ancestors: (pid) => [pid, 4000, 1],
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
  const { ctx } = statusMachine({ show: "ActiveState=failed\nSubState=failed\nUnitFileState=enabled\n", lingerValue: "yes" });
  const s = serviceStatus(ctx, { version: "0.12.0", pid: 3106419, port: 4388 }, "0.12.0");
  assert.equal(s.service, "failing to start");
  assert.equal(s.server, "v0.12.0, pid 3106419, port 4388, not run by a service");
  assert.equal(s.next, "the service cannot start: pid 3106419 holds port 4388 and was not started by the service. Run `austere-axi stop`.");
  // The same server, run by the unit (what serverUnit found for one from before 0.12): no lock-out.
  const ok = serviceStatus(ctx, { version: "0.10.4", pid: 4242, port: 4388, supervised: "systemd", unit: "austere-axi.service" }, "0.12.0");
  assert.equal(ok.next, "The server runs v0.10.4 and this CLI is v0.12.0. Restart it: austere-axi server restart");
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
  // idle exit waits for them (RLM-340).
  const { child, port } = await startServer({ AUSTERE_AXI_IDLE_TIMEOUT_MS: "200" });
  const db = await openDatabase(path.join(STATE, "hub.db"));
  try {
    assert.equal(hasActiveWork(db), false);
    // A run is active: the server stays up over several idle intervals, without a request
    // to keep it awake (a health check would reset the idle timer on its own).
    db.exec("INSERT INTO runs (id, kind, status) VALUES ('r1', 'note', 'running')");
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
  // `--port=n`, as the CLI reads it, is the unit's port too.
  assert.equal(systemdSettings("[Service]\nExecStart=/usr/bin/npx -y austere-axi server --persist --port=5000\n").port, 5000);
  // The unit `server install` writes has nothing of its own to keep.
  assert.deepEqual(systemdSettings(systemdUnit({ ...SPEC, stateDir: STATE })).kept, []);
  assert.deepEqual(launchdSettings(launchdPlist({ ...SPEC, port: 5000, env: [["HTTPS_PROXY", "http://proxy:3128"]] }, "/tmp/log")), {
    cli: SPEC.cli,
    node: SPEC.node,
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
  assert.match(asked[0], new RegExp(`will write ${escapeRegExp(unitPath(ctx.home))}:\\n  ExecStart: /usr/bin/node ${escapeRegExp(CLI)} server --persist --port 5000\\n  port: 5000\\n  state dir: ${escapeRegExp(STATE)}\\n  link url: https://austere.example.com\\nGo ahead\\?$`));
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
  const ownersState = path.resolve("/home/ana/.austere-axi");
  const owners = systemdUnit({ ...SPEC, stateDir: ownersState });
  fs.writeFileSync(file, owners);
  const checkout = "/home/ana/src/austere-axi/src/cli/main.ts";
  ctx.cli = checkout;
  await assert.rejects(installService({ port: 5000 }, ctx), new RegExp(`${escapeRegExp(file)} serves the state dir ${escapeRegExp(ownersState)}, and this CLI uses ${escapeRegExp(STATE)}\\. .*add --force`));
  assert.throws(() => uninstallService(ctx), new RegExp(`serves the state dir ${escapeRegExp(ownersState)}.*add --force to remove it anyway`));
  assert.equal(fs.readFileSync(file, "utf8"), owners);
  // Same state dir, another CLI: refused too.
  fs.writeFileSync(file, systemdUnit({ ...SPEC, stateDir: STATE }));
  await assert.rejects(installService({}, ctx), new RegExp(`runs ${escapeRegExp(CLI)}, and this CLI is ${escapeRegExp(checkout)}`));
  assert.throws(() => uninstallService(ctx), new RegExp(`runs ${escapeRegExp(CLI)}, and this CLI is ${escapeRegExp(checkout)}`));
  assert.deepEqual(changes(calls), []);
  // --force: the owner meant it.
  const r = await installService({ force: true }, ctx);
  assert.equal(r.status, "installed");
  assert.match(fs.readFileSync(file, "utf8"), new RegExp(`ExecStart=/usr/bin/node ${escapeRegExp(checkout)} server`));
  fs.writeFileSync(file, owners);
  assert.equal(uninstallService(ctx, { force: true }).status, "uninstalled");
  // A unit npx's cache runs is not another CLI's: the npx warning says to install for good and run install again.
  const { ctx: moved, asked } = context();
  fs.mkdirSync(path.dirname(unitPath(moved.home)), { recursive: true });
  const npx = "/home/ana/.npm/_npx/1a2b3c/node_modules/austere-axi/dist/cli.mjs";
  fs.writeFileSync(unitPath(moved.home), systemdUnit({ ...SPEC, cli: npx, stateDir: STATE }));
  assert.equal((await installService({}, moved)).status, "installed");
  assert.match(asked[0], new RegExp(`ExecStart: /usr/bin/node ${escapeRegExp(CLI)} server --persist --port 4388 \\(was ${escapeRegExp(npx)}\\)`));
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

test("a node from a folder of one release is warned about, and a link to it without a version is run instead", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "austere-node-"));
  HOMES.push(home);
  const release = path.join(home, "node-v24.22.3-linux-x64", "bin", "node");
  fs.mkdirSync(path.dirname(release), { recursive: true });
  fs.writeFileSync(release, "");
  assert.equal(nodeWarning("/usr/bin/node"), null);
  assert.equal(nodeWarning("/opt/homebrew/bin/node"), null);
  for (const versioned of [release, "/home/ana/.nvm/versions/node/v24.1.0/bin/node", "/opt/homebrew/Cellar/node/24.1.0/bin/node"]) {
    assert.match(String(nodeWarning(versioned)), /a folder of one Node release; a Node update or `nvm uninstall` removes it, and the service then stops starting/, versioned);
  }
  // No link: the node it runs on, warned about.
  assert.equal(stableNode(release, { PATH: "" }), release);
  assert.equal(stableNode("/usr/bin/node", { PATH: "" }), "/usr/bin/node");
  const { ctx } = context({ node: release });
  const r = await installService({}, ctx);
  assert.deepEqual(r.warnings, [nodeWarning(release)]);
  if (process.platform === "win32") return; // symlinks need rights a Windows runner may not have
  // A link on PATH that leads to it, as Homebrew's or a hand-made one does: the unit runs the link.
  const links = path.join(home, "links");
  fs.mkdirSync(links);
  fs.symlinkSync(release, path.join(links, "node"));
  assert.equal(stableNode(release, { PATH: ["relative/bin", links].join(path.delimiter) }), path.join(links, "node"));
  assert.equal(nodeWarning(path.join(links, "node")), null);
  // A link that lasts one shell session (fnm's multishell folder, XDG_RUNTIME_DIR) is passed over for a lasting one.
  const multishell = path.join(home, "run", "fnm_multishells", "4123_1700000000000", "bin");
  fs.mkdirSync(multishell, { recursive: true });
  fs.symlinkSync(release, path.join(multishell, "node"));
  assert.equal(stableNode(release, { PATH: [multishell, links].join(path.delimiter) }), path.join(links, "node"));
  const runtime = path.join(home, "xdg-runtime");
  fs.mkdirSync(path.join(runtime, "bin"), { recursive: true });
  fs.symlinkSync(release, path.join(runtime, "bin", "node"));
  assert.equal(stableNode(release, { PATH: path.join(runtime, "bin"), XDG_RUNTIME_DIR: runtime }), release);
});

test("a command echoed for the owner to paste is quoted: a link url can carry shell syntax", async () => {
  const { ctx } = context({ isTTY: false });
  await assert.rejects(installService({ linkUrl: "https://a$(id).example.com", port: 5000 }, ctx), (e: Error) => {
    assert.ok(e.message.includes("Ask the user to run `austere-axi server install --port 5000 --link-url 'https://a$(id).example.com'` themselves."), e.message);
    return true;
  });
  const win = context({ isTTY: false, platform: "win32" }).ctx;
  await assert.rejects(installService({ linkUrl: "https://a&b.example.com" }, win), /`austere-axi server install --link-url "https:\/\/a&b\.example\.com"`/);
});

test("CLI commands find the server on the port in server.lock, then on the installed unit's port", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "austere-port-"));
  HOMES.push(dir);
  const { ctx } = context();
  const lock = path.join(dir, "server.lock");
  assert.equal(serverPort(ctx, dir), 4388);
  // A unit installed for this state dir on another port.
  fs.mkdirSync(path.dirname(unitPath(ctx.home)), { recursive: true });
  fs.writeFileSync(unitPath(ctx.home), systemdUnit({ ...SPEC, port: 5000, stateDir: dir }));
  assert.equal(serverPort(ctx, dir), 5000);
  // ...but not for another state dir.
  assert.equal(serverPort(ctx, STATE), 4388);
  // A live server's lock names its port: it wins over the unit.
  fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, port: 5100, at: Date.now() }));
  assert.equal(serverPort(ctx, dir), 5100);
  // A dead holder's lock, or a command's lock without a port, does not count.
  const dead = spawnSync(process.execPath, ["-e", "0"]).pid as number;
  fs.writeFileSync(lock, JSON.stringify({ pid: dead, port: 5100, at: Date.now() }));
  assert.equal(serverPort(ctx, dir), 5000);
  fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, at: Date.now() }));
  assert.equal(serverPort(ctx, dir), 5000);
  // AUSTERE_AXI_PORT outranks both.
  assert.equal(serverPort({ ...ctx, env: { AUSTERE_AXI_PORT: "4400" } }, dir), 4400);
});

test("restartUnit resets and restarts the unit that runs the server; an unknown launchd label is the owner's to restart", () => {
  const { ctx, calls } = context();
  assert.deepEqual(restartUnit(ctx, { supervisor: "systemd", unit: "austere.service" }), ["systemctl --user reset-failed austere.service", "systemctl --user restart austere.service"]);
  const mac = context({ platform: "darwin" });
  assert.deepEqual(restartUnit(mac.ctx, { supervisor: "launchd", unit: "com.ana.austere" }), ["launchctl kickstart -k gui/501/com.ana.austere"]);
  assert.throws(() => restartUnit(mac.ctx, { supervisor: "launchd", unit: "<launchd-label>" }), /`launchctl list` shows it/);
  const refusing = context({ run: (cmd, args) => (args.includes("restart") ? { code: 1, stdout: "", stderr: "Job failed" } : { code: 0, stdout: "", stderr: "" }) });
  assert.throws(() => restartUnit(refusing.ctx, { supervisor: "systemd", unit: "austere-axi.service" }), /Job failed.*see why: systemctl --user status austere-axi\.service/);
  assert.equal(restartHint({ supervisor: "systemd", unit: "austere.service" }), "austere-axi server restart");
  assert.equal(calls.length, 2);
});

test("server restart replaces a server no unit runs; the CLI then finds it by server.lock", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "austere-home-"));
  HOMES.push(home);
  const { child, port } = await startServer({ HOME: home });
  const env = { ...process.env, HOME: home, AUSTERE_AXI_STATE_DIR: STATE, AUSTERE_AXI_NO_TAILSCALE: "1", OPENUI_TELEMETRY_DISABLED: "1" };
  let replaced: number | undefined;
  try {
    const before = await health(port);
    assert.ok(before && !before.foreign);
    const r = spawnSync(process.execPath, ["src/cli/main.ts", "server", "restart"], { env: { ...env, AUSTERE_AXI_PORT: String(port) }, encoding: "utf8", timeout: 60_000 });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /^status: restarted$/m);
    assert.match(r.stdout, new RegExp(`^was: v\\S+, pid ${before.pid}$`, "m"));
    // This process's pooled connection went to the old server: the first ask after it may fail.
    let after = await health(port);
    for (let i = 0; i < 20 && !after; i++) after = await health(port);
    assert.ok(after && !after.foreign);
    replaced = after.pid;
    assert.notEqual(after.pid, before.pid);
    assert.match(r.stdout, new RegExp(`^server: v\\S+, pid ${after.pid}, port ${port}, not run by a service$`, "m"));
    // Without AUSTERE_AXI_PORT the CLI reads the port from server.lock, and stops the server there.
    const stopped = spawnSync(process.execPath, ["src/cli/main.ts", "stop"], { env, encoding: "utf8", timeout: 30_000 });
    assert.match(stopped.stdout, new RegExp(`^status: stopped\\nport: ${port}$`, "m"), stopped.stdout + stopped.stderr);
    // A real process exits on its own schedule: wait for its port to close.
    for (let i = 0; i < 100 && (await health(port)); i++) await new Promise((res) => setTimeout(res, 100));
    assert.equal(await health(port), null);
    replaced = undefined;
  } finally {
    await stop(child);
    if (replaced) process.kill(replaced);
  }
});

test("the server listens on Tailscale's address when Tailscale comes up after it, and moves when the address changes", { skip: process.platform !== "linux" && "127.0.0.2 is loopback only on Linux" }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "austere-tailscale-"));
  HOMES.push(dir);
  const ipFile = path.join(dir, "ip");
  // Tailscale down: `status --json` says so (a CLI that fails would send detection on to a real one).
  fs.writeFileSync(
    path.join(dir, "tailscale"),
    `#!/bin/sh\nif [ -f "${ipFile}" ]; then printf '{"BackendState":"Running","Self":{"TailscaleIPs":["%s"],"DNSName":""}}' "$(cat "${ipFile}")"; else printf '{"BackendState":"Stopped"}'; fi\n`,
    { mode: 0o755 },
  );
  const accepts = (host: string, port: number): Promise<boolean> => {
    const { promise, resolve } = Promise.withResolvers<boolean>();
    const socket = net.connect({ host, port });
    socket.once("connect", () => resolve(true));
    socket.once("error", () => resolve(false));
    return promise.finally(() => socket.destroy());
  };
  // The server re-checks on its own timer in another process: poll for what it does, up to 5 s.
  const until = async (check: () => Promise<boolean>): Promise<boolean> => {
    for (let i = 0; i < 50; i++) {
      if (await check()) return true;
      await new Promise((r) => setTimeout(r, 100));
    }
    return false;
  };
  const { child, port } = await startServer({ PATH: `${dir}${path.delimiter}${process.env.PATH}`, AUSTERE_AXI_NO_TAILSCALE: "", AUSTERE_AXI_TAILNET_CHECK_MS: "100" });
  try {
    assert.equal(await accepts("127.0.0.2", port), false);
    fs.writeFileSync(ipFile, "127.0.0.2");
    assert.ok(await until(() => accepts("127.0.0.2", port)), "listens on the address Tailscale came up with");
    fs.writeFileSync(ipFile, "127.0.0.3");
    assert.ok(await until(() => accepts("127.0.0.3", port)), "listens on the new address");
    assert.ok(await until(async () => !(await accepts("127.0.0.2", port))), "lets go of the old one");
  } finally {
    await stop(child);
  }
});
