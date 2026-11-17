// `server install|uninstall|status`: the server as a per-user service, so pages always have one.
// systemd on Linux, launchd on macOS; on Windows the owner gets the steps to do it by hand.
// A server a supervisor runs never idles out, records its supervisor in server.lock and
// /api/health, and is never replaced by a newer CLI (that CLI prints how to restart the unit
// instead).
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { commandLine } from "./adapters/config.ts";
import { parseLinkUrl } from "./net.ts";
import { lockedPort, stateDirHolder } from "./lock.ts";
import type { LockHolder } from "./lock.ts";
import { CLI_ENTRY, REAL_PORT, stateDir } from "./paths.ts";
import { launchdSettings, systemdSettings } from "./unit-file.ts";
import type { KeptLine, UnitSettings } from "./unit-file.ts";

/** The service manager that runs a server. */
export type Supervisor = "systemd" | "launchd";

export const SYSTEMD_UNIT = "austere-axi.service";
/** The line both units carry, so the command knows a unit is its own. */
export const UNIT_MARKER = "Written by `austere-axi server install`";
export const LAUNCHD_LABEL = "xyz.kasat.austere-axi";
/** Stands in a restart hint for the label of a launchd agent that runs the server but could not be found (`launchctl list` shows it). */
export const UNKNOWN_LAUNCHD_LABEL = "<launchd-label>";
const BIN = "austere-axi";

/**
 * The unit this process runs under, or null when nobody runs it.
 *
 * The evidence is the system's own, and it is checked: the unit that owns this process's
 * cgroup runs a main process, and this process is it or a child of it. A unit whose command
 * is `npx -y austere-axi server --persist` runs the server below its main process, and that
 * server is supervised too. A variable a process sets for itself proves nothing (a CLI hands
 * its environment to the server it starts, and so does every shell), so the answer is: does
 * the unit run this process? The unit's name goes in server.lock and /api/health, so a hint
 * to restart it names the unit that runs it, not the one `server install` writes.
 */
export function detectUnit(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): ServerUnit | null {
  const job = platform === "linux" ? systemdJob() : platform === "darwin" ? launchdJob(env.XPC_SERVICE_NAME) : null;
  // A unit that runs something else is not our server's, even when this process sits in it.
  if (!job || !runsTheServer(job.command) || job.pid == null) return null;
  return isAncestor(job.pid, process.pid) ? { supervisor: job.supervisor, unit: job.unit } : null;
}

/** A job a service manager runs: its name, its command line and its main pid. */
interface Job {
  supervisor: Supervisor;
  unit: string;
  command: string;
  pid: number | null;
}

const positivePid = (s: string | undefined): number | null => {
  const n = Number(s);
  return Number.isInteger(n) && n > 0 ? n : null;
};

/** The systemd unit that owns this process's cgroup, as systemd describes it (one `systemctl show`). */
function systemdJob(): Job | null {
  const unit = systemdUnitName();
  if (!unit) return null;
  const r = spawnSync("systemctl", ["--user", "show", unit, "--property=ExecStart", "--property=MainPID"], { encoding: "utf8", timeout: 5000 });
  return { supervisor: "systemd", unit, ...parseSystemdShow(r.stdout || "") };
}

/** A unit's command line and main pid, out of `systemctl show --property=ExecStart --property=MainPID`. */
export function parseSystemdShow(text: string): { command: string; pid: number | null } {
  const prop = (key: string): string | undefined => new RegExp(`^${key}=(.*)$`, "m").exec(text)?.[1];
  return { command: prop("ExecStart") ?? "", pid: positivePid(prop("MainPID")) };
}

/** The launchd job named `label`, as launchd describes it (one `launchctl print`). */
function launchdJob(label: string | undefined): Job | null {
  if (!label) return null;
  const r = spawnSync("launchctl", ["print", `gui/${os.userInfo().uid}/${label}`], { encoding: "utf8", timeout: 5000 });
  const text = r.stdout || "";
  return { supervisor: "launchd", unit: label, command: text, pid: positivePid(/\bpid = (\d+)/.exec(text)?.[1]) };
}

const BIN_COMMAND = /(?:^|[\s"'])(?:[^\s"']*[/\\])?austere-axi(?:\.[a-zA-Z0-9]+)?(?:[\s"']|$)/;

/**
 * Whether a command line is the austere server: `server` run by a command that names
 * austere-axi as its executable or package, or runs the very script this process runs
 * (a dev checkout, whatever its folder is called). Another project's `cli.mjs server`
 * or a command mentioning austere-axi only in a flag argument is neither.
 */
export function runsTheServer(command: string, cli: string = CLI_ENTRY): boolean {
  return (BIN_COMMAND.test(command) || command.includes(cli)) && /(^|[\s"'])server([\s"']|$)/.test(command);
}

/** `pid` and its parents, nearest first (up to 20 generations; the chain ends at pid 1 or the last parent we can see). */
export function ancestors(pid: number): number[] {
  const chain: number[] = [];
  let current = pid;
  for (let i = 0; i < 20; i++) {
    chain.push(current);
    if (current <= 1) break;
    const parent = parentPid(current);
    if (parent == null || parent === current) break;
    current = parent;
  }
  return chain;
}

/** Whether `ancestor` is `pid` itself or one of its parents. */
export function isAncestor(ancestor: number, pid: number): boolean {
  return ancestors(pid).includes(ancestor);
}

/** The parent of a process, or null when it has none we can see. */
export function parentPid(pid: number): number | null {
  try {
    // Linux: /proc/<pid>/stat, whose second field is the command in parentheses.
    const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
    return positivePid(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1]);
  } catch {
    // Not Linux (or the process is gone): ask the system.
    const r = spawnSync("ps", ["-o", "ppid=", "-p", String(pid)], { encoding: "utf8", timeout: 5000 });
    return positivePid((r.stdout || "").trim());
  }
}

/** The systemd unit that owns this process, from its cgroup. */
export function systemdUnitName(): string | null {
  try {
    return unitInCgroup(fs.readFileSync("/proc/self/cgroup", "utf8"));
  } catch {
    return null;
  }
}

/** The service a `/proc/<pid>/cgroup` text puts its process in, or null. */
export function unitInCgroup(cgroup: string): string | null {
  const units = [...cgroup.matchAll(/\/([^/\s]+\.service)(?=\/|\s|$)/g)].map((m) => m[1]);
  // The session's own unit (user@1000.service) is not a service that runs a server.
  return units.filter((u) => !/^user@/.test(u)).pop() ?? null;
}

/** A unit that runs a server: its service manager and its name (a systemd unit, a launchd label). */
export interface ServerUnit {
  supervisor: Supervisor;
  unit: string;
}

/** What serverUnit reads about other processes; tests pass their own. */
export interface ProcessView {
  platform: NodeJS.Platform;
  uid: number | null;
  run: Runner;
  /** `/proc/<pid>/cgroup`, or null where there is none. */
  cgroup: (pid: number) => string | null;
  /** The script a process runs (its argv[1]), or null when it cannot be read. */
  script: (pid: number) => string | null;
  /** `pid` and its parents, nearest first (`ancestors`). */
  ancestors: (pid: number) => number[];
}

const readProc = (pid: number, file: string): string | null => {
  try {
    return fs.readFileSync(`/proc/${pid}/${file}`, "utf8");
  } catch {
    return null;
  }
};

/**
 * Where there is no /proc (macOS): parse the script path from a `ps -o args=` line, or null when the full path
 * cannot be established reliably (for example paths containing spaces without quotes). Servers with space-containing
 * paths that differ from CLI_ENTRY may not be detected.
 */
export function parsePsScript(line: string): string | null {
  const trimmed = line.trim();
  const quoted = /^\S+\s+"([^"]+)"\s+server\b/.exec(trimmed) ?? /^\S+\s+'([^']+)'\s+server\b/.exec(trimmed);
  if (quoted) return quoted[1];
  const simple = /^\S+\s+(\S+)\s+server\b/.exec(trimmed);
  if (simple && (/\.[mc]?[jt]s$/.test(simple[1]) || simple[1].includes("austere-axi"))) {
    return simple[1];
  }
  return null;
}

function psScript(pid: number): string | null {
  const r = spawnSync("ps", ["-o", "args=", "-p", String(pid)], { encoding: "utf8", timeout: 5000 });
  if (r.status !== 0 || !r.stdout) return null;
  return parsePsScript(r.stdout);
}

/** This machine, as serverUnit sees it. */
export function thisMachine(): ProcessView {
  return {
    platform: process.platform,
    uid: process.getuid?.() ?? null,
    run: runCommand,
    cgroup: (pid) => readProc(pid, "cgroup"),
    script: (pid) => readProc(pid, "cmdline")?.split("\0")[1] || psScript(pid),
    ancestors,
  };
}

/**
 * The unit that runs the server with process id `pid`, or null when none does. It asks the
 * system, not the server: a server from before 0.12 does not report `supervised`, and a CLI
 * that replaced it would lock its unit out (RLM-311, RLM-375). On Linux the pid's cgroup names
 * the unit; the unit counts when it runs the austere server (runsTheServer, with the script
 * that pid runs) and its main process is that pid or an ancestor of it. On macOS it is the
 * launchd agent whose main process is that pid or an ancestor of it, whatever its label (a
 * hand-written agent has its own): `launchctl list` names the agents with a running pid, and
 * the one found has to run the austere server (launchdUnit).
 */
export function serverUnit(pid: number, view: ProcessView = thisMachine()): ServerUnit | null {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  if (view.platform === "linux") {
    const cgroup = view.cgroup(pid);
    const unit = cgroup ? unitInCgroup(cgroup) : null;
    if (!unit) return null;
    const r = view.run("systemctl", ["--user", "show", unit, "--property=ExecStart", "--property=MainPID"]);
    if (r.code !== 0) return null;
    const job = parseSystemdShow(r.stdout);
    if (job.pid == null || !runsTheServer(job.command, view.script(pid) ?? CLI_ENTRY) || !view.ancestors(pid).includes(job.pid)) return null;
    return { supervisor: "systemd", unit };
  }
  if (view.platform === "darwin") {
    return launchdUnit(pid, view);
  }
  return null;
}

/** The `[pid, label]` rows of `launchctl list` that have a running pid (its columns: PID, last exit status, label). */
export function parseLaunchctlList(text: string): { pid: number; label: string }[] {
  const rows: { pid: number; label: string }[] = [];
  for (const line of text.split("\n")) {
    const m = /^(\d+)\s+\S+\s+(\S+)\s*$/.exec(line);
    if (m) rows.push({ pid: Number(m[1]), label: m[2] });
  }
  return rows;
}

/**
 * The launchd agent that runs the process `pid`, whatever its label. Nearest first, a job
 * whose main process is `pid` itself is the agent's; one whose main process is an ancestor
 * counts when its command runs the austere server (`npx -y austere-axi server` runs it below
 * its main process). An app (Terminal) or an agent that runs something else, a tmux say, is
 * not the server's even when the server sits below it.
 */
function launchdUnit(pid: number, view: ProcessView): ServerUnit | null {
  if (view.uid == null) return null;
  const list = view.run("launchctl", ["list"]);
  if (list.code !== 0) return null;
  const jobs = parseLaunchctlList(list.stdout);
  for (const p of view.ancestors(pid)) {
    if (p <= 1) break;
    for (const { label } of jobs.filter((j) => j.pid === p)) {
      if (p === pid) return { supervisor: "launchd", unit: label };
      const r = view.run("launchctl", ["print", `gui/${view.uid}/${label}`]);
      if (r.code !== 0 || positivePid(/\bpid = (\d+)/.exec(r.stdout)?.[1]) !== p) continue;
      if (runsTheServer(r.stdout, view.script(pid) ?? CLI_ENTRY)) return { supervisor: "launchd", unit: label };
    }
  }
  return null;
}

/** The environment a CLI hands to the server it starts, without the service manager's job markers. */
export function childEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const { INVOCATION_ID, XPC_SERVICE_NAME, ...rest } = env;
  return rest;
}

/** The command that restarts the server under `s`; `unit` names a unit `server install` did not write. */
export function restartCommand(s: Supervisor, uid: number | null = process.getuid?.() ?? null, unit?: string): string {
  return s === "systemd" ? `systemctl --user restart ${unit ?? SYSTEMD_UNIT}` : `launchctl kickstart -k gui/${uid ?? "$(id -u)"}/${unit ?? LAUNCHD_LABEL}`;
}

/**
 * What the owner runs to restart the server under `unit`: `server restart`, which finds the unit
 * itself. A launchd agent whose label could not be found is restarted by hand.
 */
export function restartHint(unit: ServerUnit, uid: number | null = process.getuid?.() ?? null): string {
  return unit.unit === UNKNOWN_LAUNCHD_LABEL ? `${restartCommand(unit.supervisor, uid, unit.unit)} (\`launchctl list\` shows the label)` : `${BIN} server restart`;
}

/**
 * Restart the unit that runs the server, or start it when it is stopped. systemd first forgets a
 * unit's failures, or a unit that hit its start limit would refuse. Returns the commands it ran;
 * throws when the service manager refuses, with how to see why.
 */
export function restartUnit(ctx: ServiceContext, unit: ServerUnit): string[] {
  if (unit.unit === UNKNOWN_LAUNCHD_LABEL) throw new Error(`launchd runs the server under a label this CLI could not find. \`launchctl list\` shows it; restart it with ${restartCommand("launchd", ctx.uid, unit.unit)}`);
  const ran: string[] = [];
  if (unit.supervisor === "systemd") {
    runRecorded(ctx, ran, "systemctl", ["--user", "reset-failed", unit.unit]);
    const { failure } = runRecorded(ctx, ran, "systemctl", ["--user", "restart", unit.unit]);
    if (failure) throw new Error(`${failure} (see why: systemctl --user status ${unit.unit})`);
  } else {
    const { failure } = runRecorded(ctx, ran, "launchctl", ["kickstart", "-k", `gui/${ctx.uid ?? 0}/${unit.unit}`]);
    if (failure) throw new Error(`${failure} (see why: launchctl print gui/${ctx.uid ?? 0}/${unit.unit})`);
  }
  return ran;
}

/**
 * What the owner reads when a server the service did not start holds its port: the unit
 * cannot start (it fails, or loops until its start limit) until that server stops.
 */
export function lockedOutNote(pid: number, port: number): string {
  return `the service cannot start: pid ${pid} holds port ${port} and was not started by the service. Run \`${BIN} stop\`.`;
}

/** The command that shows the state of the server's unit under `s`, and why it failed. */
export function statusCommand(s: Supervisor, uid: number | null = process.getuid?.() ?? null): string {
  return s === "systemd" ? `systemctl --user status ${SYSTEMD_UNIT}` : `launchctl print gui/${uid ?? "$(id -u)"}/${LAUNCHD_LABEL}`;
}

/** What the unit runs. */
export interface ServiceSpec {
  /** Absolute path of node. */
  node: string;
  /** Absolute path of the CLI script. */
  cli: string;
  port: number;
  linkUrl?: string;
  /** AUSTERE_AXI_STATE_DIR when the installing CLI has one set. */
  stateDir?: string;
  /** Variables kept from the agent it replaces (launchd; systemd keeps them in a drop-in). */
  env?: [string, string][];
}

function serverArgs(spec: ServiceSpec): string[] {
  return [spec.node, spec.cli, "server", "--persist", "--port", String(spec.port)];
}

function serverEnv(spec: ServiceSpec): [string, string][] {
  // The supervisor is not named here: the server asks the system who runs it (detectUnit).
  const env: [string, string][] = [];
  if (spec.linkUrl) env.push(["AUSTERE_AXI_LINK_URL", spec.linkUrl]);
  if (spec.stateDir) env.push(["AUSTERE_AXI_STATE_DIR", spec.stateDir]);
  return [...env, ...(spec.env ?? [])];
}

/** Quote a systemd value that has spaces, quotes, backslashes or `;`; `%` is always a specifier. */
function systemdQuote(s: string): string {
  const v = s.replace(/%/g, "%%");
  return /[\s"'\\;]/.test(v) ? `"${v.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"` : v;
}

/**
 * The systemd user unit. The start limit ends a lock-out (another server holds the port or the
 * state dir) in `failed` instead of a restart every few seconds for ever: 5 failed starts, 5 s
 * apart, fit in the 2 minutes.
 */
export function systemdUnit(spec: ServiceSpec): string {
  return [
    `# Written by \`${BIN} server install\`; \`${BIN} server uninstall\` removes it.`,
    "[Unit]",
    "Description=austere-axi review server",
    "StartLimitIntervalSec=120",
    "StartLimitBurst=5",
    "",
    "[Service]",
    // `$` is a variable in ExecStart, not in Environment=.
    `ExecStart=${serverArgs(spec).map((a) => systemdQuote(a.replace(/\$/g, "$$$$"))).join(" ")}`,
    ...serverEnv(spec).map(([k, v]) => `Environment=${systemdQuote(`${k}=${v}`)}`),
    "Restart=on-failure",
    "RestartSec=5",
    "",
    "[Install]",
    "WantedBy=default.target",
    "",
  ].join("\n");
}

const xml = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** The launchd agent. Its stderr goes to `log` (the server's own log, for a crash before it can write there). */
export function launchdPlist(spec: ServiceSpec, log: string): string {
  const str = (s: string): string => `<string>${xml(s)}</string>`;
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    `<!-- Written by \`${BIN} server install\`; \`${BIN} server uninstall\` removes it. -->`,
    '<plist version="1.0">',
    "<dict>",
    `  <key>Label</key>${str(LAUNCHD_LABEL)}`,
    "  <key>ProgramArguments</key>",
    "  <array>",
    ...serverArgs(spec).map((a) => `    ${str(a)}`),
    "  </array>",
    "  <key>EnvironmentVariables</key>",
    "  <dict>",
    ...serverEnv(spec).map(([k, v]) => `    <key>${xml(k)}</key>${str(v)}`),
    "  </dict>",
    "  <key>RunAtLoad</key><true/>",
    "  <key>KeepAlive</key>",
    "  <dict><key>SuccessfulExit</key><false/></dict>",
    `  <key>StandardErrorPath</key>${str(log)}`,
    "</dict>",
    "</plist>",
    "",
  ].join("\n");
}

/** The warning for a CLI run from npx's cache: npm may clear or replace that path, and the unit would stop starting. */
export function npxWarning(cli: string): string | null {
  if (!/[\\/]_npx[\\/]/.test(cli)) return null;
  return `this CLI runs from npx's cache (${cli}), which npm may clear or replace; the service would then fail to start. Install it for good with \`npm install -g ${BIN}\`, then run \`${BIN} server install\` again.`;
}

/** A folder of one Node release in a path: nvm's `v24.1.0`, a tarball's `node-v24.22.3-linux-x64`, Homebrew's `Cellar/node/24.1.0`. */
const NODE_RELEASE = /[\\/](?:node-)?v?\d+\.\d+\.\d+[^\\/]*[\\/]/;

/**
 * The node a unit should run. `node` when its path names no release; else a `node` on PATH (or in
 * /usr/local/bin, /usr/bin, /opt/homebrew/bin) whose path names none and that resolves to the
 * same file, as Homebrew's or a hand-made link does: an update moves the link, not the unit.
 * `node` itself when there is no such link. A link in a folder that lasts one session (fnm's
 * `fnm_multishells`, anything under XDG_RUNTIME_DIR) is not one: it is gone after logout, sooner
 * than the release folder.
 */
export function stableNode(node: string, env: NodeJS.ProcessEnv = process.env): string {
  if (!NODE_RELEASE.test(node)) return node;
  let real: string;
  try {
    real = fs.realpathSync(node);
  } catch {
    return node;
  }
  const runtime = env.XDG_RUNTIME_DIR && path.isAbsolute(env.XDG_RUNTIME_DIR) ? path.resolve(env.XDG_RUNTIME_DIR) + path.sep : null;
  for (const dir of [...(env.PATH ?? "").split(path.delimiter), "/usr/local/bin", "/usr/bin", "/opt/homebrew/bin"]) {
    const candidate = path.join(dir, "node");
    if (!path.isAbsolute(dir) || NODE_RELEASE.test(candidate) || /[\\/]fnm_multishells[\\/]/.test(candidate) || (runtime && candidate.startsWith(runtime))) continue;
    try {
      if (fs.realpathSync(candidate) === real) return candidate;
    } catch {
      // no node there
    }
  }
  return node;
}

/**
 * The warning for a unit that runs node, or the CLI, from a folder of one Node release (nvm keeps
 * global packages there too): the next Node update removes it, and the service stops starting.
 */
export function nodeWarning(node: string, cli = ""): string | null {
  if (NODE_RELEASE.test(node)) {
    return `the service runs node from ${node}, a folder of one Node release; a Node update or \`nvm uninstall\` removes it, and the service then stops starting. Make node reachable at a path without a version (a system package, Homebrew's /opt/homebrew/bin/node, or a link on PATH that you move with each update), then run \`${BIN} server install\` again: it runs such a link when it leads to the node it runs on.`;
  }
  if (NODE_RELEASE.test(cli)) {
    return `the service runs ${cli}, installed in a folder of one Node release (nvm keeps global packages per release); a Node update or \`nvm uninstall\` removes it, and the service then stops starting. Install ${BIN} with a node outside such a folder, then run \`${BIN} server install\` again.`;
  }
  return null;
}

/** What a service is doing, in the words `server status` prints. */
export type ServiceState = "running" | "starting" | "failing to start" | "stopped";

/** systemd's ActiveState and SubState in those words: `activating (auto-restart)` and `failed` are a unit that does not stay up. */
export function systemdState(active: string, sub: string): ServiceState | null {
  if (active === "active" || active === "reloading") return "running";
  if (active === "activating") return sub === "auto-restart" ? "failing to start" : "starting";
  if (active === "failed") return "failing to start";
  if (active === "inactive" || active === "deactivating") return "stopped";
  return null;
}

/** `launchctl print` of the agent in those words; null is an agent that is not loaded. A throttled restart, or a stop after a failed exit, is failing to start. */
export function launchdState(print: string | null): ServiceState {
  if (print == null) return "stopped";
  const state = /^\s*state = (.+)$/m.exec(print)?.[1]?.trim();
  if (state === "running") return "running";
  if (state === "spawn scheduled" || Number(/^\s*last exit code = (\d+)/m.exec(print)?.[1] ?? 0) !== 0) return "failing to start";
  return "stopped";
}

/** What linger off means for the service, in `server install` and `server status`. */
const LINGER_OFF =
  "linger is off: systemd starts the service when you log in and stops it when your last session ends (you log out, or the last ssh connection closes). Run `loginctl enable-linger` once to keep it running without a session and start it at boot.";

/** Whether systemd keeps this user's services running without a session (`loginctl enable-linger`); null when loginctl does not say. */
function linger(ctx: ServiceContext): boolean | null {
  const r = ctx.run("loginctl", ["show-user", ctx.env.USER || os.userInfo().username, "--property=Linger", "--value"]);
  const value = r.stdout.trim();
  return r.code === 0 && (value === "yes" || value === "no") ? value === "yes" : null;
}

export interface RunResult {
  /** Exit code; null when the command could not run. */
  code: number | null;
  stdout: string;
  stderr: string;
}

/** Runs a service manager command (systemctl, launchctl, loginctl); tests pass a fake. */
export type Runner = (cmd: string, args: string[]) => RunResult;

export const runCommand: Runner = (cmd, args) => {
  const r = spawnSync(cmd, args, { encoding: "utf8", timeout: 30_000, windowsHide: true });
  return { code: r.error ? null : r.status, stdout: r.stdout ?? "", stderr: r.stderr || (r.error ? r.error.message : "") };
};

/** What a probe says about a port: is a server there, and whose. */
export interface PortProbe {
  /** A listener that is not an austere-axi server. */
  foreign?: boolean;
  /** The state dir the server on that port uses. */
  stateDir?: string;
  /** The supervisor that runs it, when one does. */
  supervised?: Supervisor;
  /** The pid of the server that answered. */
  pid?: number;
}

/** Everything install, uninstall and status read from the machine, so tests can supply their own. */
export interface ServiceContext {
  platform: NodeJS.Platform;
  home: string;
  env: NodeJS.ProcessEnv;
  run: Runner;
  isTTY: boolean;
  node: string;
  cli: string;
  stateDir: string;
  uid: number | null;
  /** Who holds the state dir's server.lock (stateDirHolder in lock.ts). */
  holder: (dir: string) => Promise<LockHolder | null>;
  /** What answers on a port, if anything. */
  probe: (port: number) => Promise<PortProbe | null>;
  /** The unit that runs the server with this pid, as the system says (serverUnit). */
  unitOf: (pid: number) => ServerUnit | null;
  /** Whether `ancestor` is `pid` itself or one of its parents (isAncestor). */
  isAncestor: (ancestor: number, pid: number) => boolean;
  /** Ask the owner at the terminal; only a yes counts. */
  confirm: (question: string) => Promise<boolean>;
}

export interface InstallOptions {
  port?: number;
  linkUrl?: string;
  /** Take the place of a unit `server install` did not write, keeping what it can of it. */
  adopt?: boolean;
  /** Go ahead when the unit it replaces runs another CLI or another state dir. */
  force?: boolean;
}

/** Where the unit goes; null on a platform with no supported service manager. */
export function unitFile(ctx: Pick<ServiceContext, "platform" | "home" | "env">): { supervisor: Supervisor; file: string } | null {
  if (ctx.platform === "darwin") return { supervisor: "launchd", file: path.join(ctx.home, "Library", "LaunchAgents", `${LAUNCHD_LABEL}.plist`) };
  if (ctx.platform === "linux") {
    const config = ctx.env.XDG_CONFIG_HOME && path.isAbsolute(ctx.env.XDG_CONFIG_HOME) ? ctx.env.XDG_CONFIG_HOME : path.join(ctx.home, ".config");
    return { supervisor: "systemd", file: path.join(config, "systemd", "user", SYSTEMD_UNIT) };
  }
  return null;
}

/** The port CLI commands look for the server on when AUSTERE_AXI_PORT is all there is (serverPort, over ctx.env). */
function defaultPort(env: NodeJS.ProcessEnv): number {
  const p = Number(env.AUSTERE_AXI_PORT);
  return Number.isInteger(p) && p > 0 && p < 65536 ? p : REAL_PORT;
}

/** The install command to run again, quoted for this platform's shell: a link url can hold `&` or `;`. */
function installCommand(o: InstallOptions, platform: NodeJS.Platform): string {
  const words = [BIN, "server", "install", ...(o.port ? ["--port", String(o.port)] : []), ...(o.linkUrl ? ["--link-url", o.linkUrl] : []), ...(o.adopt ? ["--adopt"] : []), ...(o.force ? ["--force"] : [])];
  return commandLine(words, platform);
}

/** launchd's name for the agent, in the user's GUI domain. */
function launchdTarget(uid: number | null): string {
  return `gui/${uid ?? 0}/${LAUNCHD_LABEL}`;
}

/** What a failed command said, for an error message. */
function commandOutput(r: RunResult): string {
  return (r.stderr || r.stdout).trim() || "no output";
}

/** Run a service manager command and record it in `ran`. `failure` says what went wrong, or is null. */
function runRecorded(ctx: ServiceContext, ran: string[], cmd: string, args: string[]): { result: RunResult; failure: string | null } {
  const result = ctx.run(cmd, args);
  const line = [cmd, ...args].join(" ");
  ran.push(line);
  const failure = result.code === 0 ? null : `\`${line}\` failed${result.code == null ? "" : ` (exit ${result.code})`}: ${commandOutput(result)}`;
  return { result, failure };
}

/** runRecorded, and throw when the command fails. */
function runChecked(ctx: ServiceContext, ran: string[], cmd: string, args: string[]): RunResult {
  const { result, failure } = runRecorded(ctx, ran, cmd, args);
  if (failure) throw new Error(failure);
  return result;
}

/** The drop-in, beside the systemd unit, that holds what it kept of the unit it replaced. */
const KEPT_CONF = "kept.conf";

/** A unit file the new one takes the place of. */
interface Replaced {
  /** Its name: a systemd unit, or the launchd label. */
  name: string;
  file: string;
  text: string;
  ours: boolean;
  settings: UnitSettings;
}

/** A free name beside `file` for its backup: `.bak`, then `.bak.1` and on. A backup is never overwritten. */
function backupName(file: string): string {
  for (let i = 0; ; i++) {
    const name = i ? `${file}.bak.${i}` : `${file}.bak`;
    if (!fs.existsSync(name)) return name;
  }
}

/** A systemd user unit's file, state and main pid, out of one `systemctl --user show`; `answered` is false when systemd said nothing. */
function systemdUnitInfo(ctx: ServiceContext, unit: string): { answered: boolean; file: string | null; enabled: boolean; active: boolean; state: string; sub: string; pid: number | null } {
  const r = ctx.run("systemctl", ["--user", "show", unit, "--property=FragmentPath", "--property=UnitFileState", "--property=ActiveState", "--property=SubState", "--property=MainPID"]);
  const prop = (key: string): string => new RegExp(`^${key}=(.*)$`, "m").exec(r.stdout)?.[1]?.trim() ?? "";
  return {
    answered: r.code === 0 && prop("ActiveState") !== "",
    file: prop("FragmentPath") || null,
    enabled: prop("UnitFileState").startsWith("enabled"),
    active: ["active", "activating", "reloading"].includes(prop("ActiveState")),
    state: prop("ActiveState"),
    sub: prop("SubState"),
    pid: positivePid(prop("MainPID")),
  };
}

/** The state dir a unit's settings name (systemd's `%h` read as the home folder), or the default one. */
function unitSettingsStateDir(s: UnitSettings, home: string): string {
  return path.resolve(s.stateDir?.replace(/%h/g, home) ?? path.join(home, ".austere-axi"));
}

/**
 * Why a unit belongs to another hub or another CLI than this one, or null. A service pointed at
 * another state dir serves another hub; a CLI from a checkout would run the owner's service from it.
 * A unit that runs from npx's cache is not another CLI's: npxWarning tells the owner to install for
 * good and run `server install` again.
 */
function otherOwner(s: UnitSettings, file: string, ctx: ServiceContext, checkCli: boolean): string | null {
  const dir = unitSettingsStateDir(s, ctx.home);
  const mine = path.resolve(ctx.stateDir);
  if (dir !== mine) return `${file} serves the state dir ${dir}, and this CLI uses ${mine}`;
  if (checkCli && s.cli && !npxWarning(s.cli) && path.resolve(s.cli) !== path.resolve(ctx.cli)) return `${file} runs ${s.cli}, and this CLI is ${ctx.cli}`;
  return null;
}

/** Why the service manager cannot be reached from here, or null when it can. */
function managerUnreachable(ctx: ServiceContext, supervisor: Supervisor): string | null {
  const cmd = supervisor === "systemd" ? "systemctl" : "launchctl";
  const args = supervisor === "systemd" ? ["--user", "show-environment"] : ["print", `gui/${ctx.uid}`];
  const r = ctx.run(cmd, args);
  if (r.code === 0) return null;
  return `\`${[cmd, ...args].join(" ")}\` ${r.code == null ? "could not run" : `failed (exit ${r.code})`}: ${commandOutput(r)}`;
}

/** The kept lines as drop-in sections. */
function dropInSections(kept: KeptLine[]): string[] {
  return (["Unit", "Service"] as const).flatMap((section) => {
    const lines = kept.filter((k) => k.section === section).map((k) => k.line);
    return lines.length ? ["", `[${section}]`, ...lines] : [];
  });
}

/** Remove the kept drop-in, and its folder when nothing else is in it. */
function removeDropIn(file: string): void {
  fs.rmSync(file, { force: true });
  try {
    fs.rmdirSync(path.dirname(file));
  } catch {
    // other drop-ins are in it: they stay
  }
}

/**
 * Wait for the service's own server to answer on `port`: the server that answers has to be the
 * unit's main process (or below it, as under npx) on this state dir, not one another unit runs.
 * Returns null when it does, or what answered instead.
 */
async function serviceAnswer(ctx: ServiceContext, supervisor: Supervisor, port: number, stateDir: string): Promise<string | null> {
  let seen = "nothing answers";
  for (let i = 0; i < 150; i++) {
    const answer = await ctx.probe(port);
    if (answer?.foreign) seen = "something that is not austere-axi answers";
    else if (answer?.pid != null) {
      const main = supervisor === "systemd" ? systemdUnitInfo(ctx, SYSTEMD_UNIT).pid : positivePid(/\bpid = (\d+)/.exec(ctx.run("launchctl", ["print", launchdTarget(ctx.uid)]).stdout)?.[1]);
      if (main != null && ctx.isAncestor(main, answer.pid) && answer.stateDir != null && path.resolve(answer.stateDir) === stateDir) return null;
      seen = `pid ${answer.pid} answers, and ${main == null ? "the service runs no process" : `the service's process is pid ${main}`}`;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  return seen;
}

/**
 * Write the unit for this machine's service manager and start it, or change nothing. Refuses
 * without a terminal (it configures a command to run), when the service manager does not answer,
 * while a server no service runs holds the state dir, over a unit it did not write unless told to
 * adopt it, and over a unit of another CLI or state dir unless forced. It shows what it will do
 * and asks. A failure on the way puts back what was there. On Windows it returns the steps to do
 * by hand.
 */
export async function installService(o: InstallOptions, ctx: ServiceContext): Promise<Record<string, unknown>> {
  let optionLink: string | undefined;
  if (o.linkUrl) {
    try {
      optionLink = parseLinkUrl(o.linkUrl)?.base;
    } catch (err) {
      throw new Error(`--link-url is not a url: ${o.linkUrl} (${(err as Error).message})`);
    }
  }
  // The service runs from its own working folder (the user's home), so a relative state dir
  // would point it at a different database than the CLI that installed it. Absolute, or nothing:
  // the unit names the state dir whenever it is not the default, so the two always mean the same.
  const stateDir = path.resolve(ctx.stateDir);
  const unitStateDirSetting = ctx.env.AUSTERE_AXI_STATE_DIR || stateDir !== path.join(ctx.home, ".austere-axi") ? stateDir : undefined;
  // The node the unit runs: a link without a version when one leads to this node (stableNode).
  const node = stableNode(ctx.node, ctx.env);
  const specFor = (port: number, linkUrl: string | undefined, env?: [string, string][]): ServiceSpec => ({ node, cli: ctx.cli, port, linkUrl, stateDir: unitStateDirSetting, env });
  const warnings = [npxWarning(ctx.cli), nodeWarning(node, ctx.cli)].filter((w): w is string => w != null);
  const target = unitFile(ctx);
  // The terminal rule comes first on every platform: `server install` configures what runs on
  // this machine, so it is the owner's decision everywhere, Windows included (design note,
  // Security). On Windows it changes nothing anyway, but the refusal is the same.
  if (!ctx.isTTY) {
    throw new Error(`server install needs the user at a terminal and changes nothing here. Ask the user to run \`${installCommand(o, ctx.platform)}\` themselves.`);
  }
  if (!target) return manualSteps(specFor(o.port ?? defaultPort(ctx.env), optionLink), ctx, warnings);
  const systemd = target.supervisor === "systemd";
  if (!systemd && ctx.uid == null) throw new Error("no user id to install the launchd agent for");
  // Nothing is written until the service manager answers. A unit it cannot load would stay on
  // disk, and every later command would try to start it (WSL without systemd, a container, `su`).
  const unreachable = managerUnreachable(ctx, target.supervisor);
  if (unreachable) {
    const spec = specFor(o.port ?? defaultPort(ctx.env), optionLink);
    const vars = serverEnv(spec).map(([k, v]) => `${k}=${v}`);
    const by = `\`${commandLine(serverArgs(spec), ctx.platform)}\`${vars.length ? ` with ${commandLine(vars, ctx.platform)}` : ""}`;
    throw new Error(
      systemd
        ? `systemd's user manager does not answer here (${unreachable}); nothing was written. A shell from \`su\` or \`sudo\`, a container, or WSL without systemd has none. Log in as this user (a desktop session or ssh) and run \`${installCommand(o, ctx.platform)}\` again, or have your service manager run ${by} at login.`
        : `launchd's session for user ${ctx.uid} does not answer (${unreachable}); nothing was written. Run \`${installCommand(o, ctx.platform)}\` from a terminal in that user's desktop session, or run ${by} at login some other way.`,
    );
  }
  const name = systemd ? SYSTEMD_UNIT : LAUNCHD_LABEL;
  const settingsOf = systemd ? systemdSettings : launchdSettings;
  const replaced: Replaced[] = [];
  if (fs.existsSync(target.file)) {
    const text = fs.readFileSync(target.file, "utf8");
    replaced.push({ name, file: target.file, text, ours: text.includes(UNIT_MARKER), settings: settingsOf(text) });
  }
  const holder = await ctx.holder(stateDir);
  // Who runs the server that holds the state dir, as the system says: a server from before
  // 0.12 does not say, and one under a hand-written unit is not "a server not started by systemd".
  const holderUnit = holder ? (ctx.unitOf(holder.pid) ?? (holder.supervised ? { supervisor: holder.supervised, unit: holder.unit ?? name } : null)) : null;
  if (holder && !holderUnit) {
    const where = holder.port ? `, port ${holder.port}` : "";
    const stop = holder.port && holder.port !== defaultPort(ctx.env) ? `AUSTERE_AXI_PORT=${holder.port} ${BIN} stop` : `${BIN} stop`;
    // A server that is still starting does not answer `stop` yet: say to wait for it.
    const advice = holder.serving
      ? `run \`${stop}\` first, then \`${installCommand(o, ctx.platform)}\` again`
      : `it is still starting; wait a moment, then run \`${installCommand(o, ctx.platform)}\` again (a server that keeps the lock for good is stopped with \`${stop}\`)`;
    throw new Error(`a server not started by ${target.supervisor} (pid ${holder.pid}${where}) holds ${path.join(stateDir, "server.lock")}; ${advice}`);
  }
  if (holder && holderUnit && holderUnit.unit !== name) {
    // A unit under another name runs it, one the owner wrote. It is taken over only from the
    // folder the new unit goes in: a unit elsewhere (/etc, a link) is not this command's to move.
    const file = systemd ? systemdUnitInfo(ctx, holderUnit.unit).file : null;
    if (!file || path.dirname(file) !== path.dirname(target.file) || !fs.existsSync(file)) {
      const stop = systemd ? `systemctl --user disable --now ${holderUnit.unit}` : `launchctl bootout gui/${ctx.uid}/${holderUnit.unit}`;
      throw new Error(`the server here (pid ${holder.pid}) runs under ${holderUnit.unit}${file ? ` (${file})` : ""}, which \`${BIN} server install\` did not write and cannot take over from ${path.dirname(target.file)}. Stop and disable it yourself (\`${stop}\`), then run \`${installCommand(o, ctx.platform)}\` again.`);
    }
    const text = fs.readFileSync(file, "utf8");
    replaced.push({ name: holderUnit.unit, file, text, ours: false, settings: systemdSettings(text) });
  }
  const foreign = replaced.filter((r) => !r.ours);
  // A unit this command did not write belongs to the owner: it may carry settings (a proxy url,
  // a wait for the network) only they know about. It is replaced only when they say so.
  if (foreign.length && !o.adopt) {
    const r = foreign[0];
    const what = r.file === target.file ? `there is already a unit at ${r.file} that \`${BIN} server install\` did not write` : `the server here (pid ${holder?.pid}) runs under ${r.name} (${r.file}), which \`${BIN} server install\` did not write`;
    const keeps = systemd ? "its Environment=, EnvironmentFile=, ExecStartPre=, ExecStartPost=, After=, Wants= and Requires= lines, in a drop-in" : "its environment variables";
    throw new Error(`${what}. \`${installCommand({ ...o, adopt: true }, ctx.platform)}\` takes its place: it shows what it keeps of it (${keeps}) and asks, then backs it up beside it, stops and disables it, and installs its own.`);
  }
  if (!o.force) {
    for (const r of replaced) {
      const other = otherOwner(r.settings, r.file, ctx, r.ours);
      if (other) throw new Error(`${other}. Run \`${BIN} server install\` from the CLI and with the state dir the service uses, or add --force to make the service run this CLI on ${stateDir}.`);
    }
  }
  // What the options say, else what the unit it replaces said: a re-install keeps its port and link url.
  const before = (replaced.find((r) => r.ours) ?? replaced[0])?.settings;
  const port = o.port ?? before?.port ?? defaultPort(ctx.env);
  const linkUrl = optionLink ?? before?.linkUrl ?? undefined;
  // The service has to be able to take the port: only the server it replaces may answer there.
  // Anything else would leave the unit restarting in a loop while install said "installed".
  const onPort = await ctx.probe(port);
  if (onPort && !(holder && !onPort.foreign && onPort.pid === holder.pid)) {
    const whose = onPort.foreign ? " that is not an austere-axi server" : onPort.stateDir && path.resolve(onPort.stateDir) !== stateDir ? ` (an austere-axi server for ${onPort.stateDir})` : "";
    throw new Error(`something already listens on port ${port}${whose}; the service could not take it. Stop it, or install on another port: \`${installCommand({ ...o, port: port + 1 }, ctx.platform)}\``);
  }
  // What the new unit keeps of the ones it replaces (an edit to its own unit too): systemd in a
  // drop-in, which a later install leaves alone; launchd in the agent's environment.
  const kept: KeptLine[] = [];
  for (const k of replaced.flatMap((r) => r.settings.kept)) if (!kept.some((x) => x.section === k.section && x.line === k.line)) kept.push(k);
  const dropIn = path.join(`${target.file}.d`, KEPT_CONF);
  const dropInBefore = systemd && fs.existsSync(dropIn) ? fs.readFileSync(dropIn, "utf8") : null;
  const inDropIn = dropInBefore ? systemdSettings(dropInBefore).kept : [];
  const toKeep = systemd ? kept.filter((k) => !inDropIn.some((x) => x.section === k.section && x.line === k.line)) : kept;
  const keptEnv = systemd ? undefined : kept.map((k): [string, string] => [k.line.slice(0, k.line.indexOf("=")), k.line.slice(k.line.indexOf("=") + 1)]);
  const spec = specFor(port, linkUrl, keptEnv);
  const text = systemd ? systemdUnit(spec) : launchdPlist(spec, path.join(stateDir, "server.log"));
  const newLines = new Set(text.split("\n"));
  const dropped = [...new Set(replaced.flatMap((r) => r.settings.other))].filter((l) => !newLines.has(l));
  const backups = new Map(replaced.filter((r) => !r.ours || r.text !== text).map((r) => [r.file, backupName(r.file)]));
  const otherDropIns = systemd && fs.existsSync(path.dirname(dropIn)) ? fs.readdirSync(path.dirname(dropIn)).filter((f) => f.endsWith(".conf") && f !== KEPT_CONF) : [];

  const was = <T>(now: T, then: T | null | undefined): string => (then != null && then !== now ? ` (was ${then})` : "");
  const plan = [
    `${BIN} server install will ${replaced.some((r) => r.file === target.file) ? "replace" : "write"} ${target.file}:`,
    `  ${systemd ? "ExecStart" : "ProgramArguments"}: ${serverArgs(spec).join(" ")}${before?.cli && before.cli !== spec.cli ? ` (was ${before.cli})` : ""}`,
    `  port: ${port}${was(port, before?.port)}`,
    `  state dir: ${stateDir}${was(stateDir, before && unitSettingsStateDir(before, ctx.home))}`,
    `  link url: ${linkUrl ?? "none"}${was(linkUrl ?? "none", before?.linkUrl)}`,
    ...(toKeep.length ? [`  keeps, ${systemd ? `in ${dropIn}` : "in its environment"}:`, ...toKeep.map((k) => `    ${k.line}`)] : []),
    ...(dropped.length ? ["  does not keep (the backup has them):", ...dropped.map((l) => `    ${l}`)] : []),
    ...foreign.map((r) => `  stops and disables ${r.name}, and moves ${r.file} to ${backups.get(r.file)}`),
    ...replaced.filter((r) => r.ours && backups.has(r.file)).map((r) => `  backs up the unit it replaces to ${backups.get(r.file)}`),
    ...(otherDropIns.length ? [`  drop-ins in ${path.dirname(dropIn)} that still apply: ${otherDropIns.join(", ")}`] : []),
  ];
  if (!(await ctx.confirm(`${plan.join("\n")}\nGo ahead?`))) return { status: "cancelled", unit: target.file, note: "nothing was changed" };

  const ran: string[] = [];
  const notes: string[] = [];
  // Every file change, undone last to first when a later step fails.
  const undo: (() => void)[] = [];
  const stopped: { name: string; enabled: boolean; active: boolean }[] = [];
  const ownBefore = replaced.find((r) => r.ours && r.file === target.file) ?? null;
  const ownState = systemd && ownBefore ? systemdUnitInfo(ctx, name) : null;
  const loadedBefore = !systemd && ctx.run("launchctl", ["print", launchdTarget(ctx.uid)]).code === 0;
  let started = false;
  /** Put back what was there; returns what could not be put back. */
  const rollback = (): string[] => {
    const problems: string[] = [];
    const attempt = (cmd: string, args: string[]): void => {
      const { failure } = runRecorded(ctx, ran, cmd, args);
      if (failure) problems.push(failure);
    };
    if (started && systemd && !ownState?.enabled) attempt("systemctl", ["--user", "disable", "--now", SYSTEMD_UNIT]);
    if (started && !systemd) runRecorded(ctx, ran, "launchctl", ["bootout", launchdTarget(ctx.uid)]);
    for (const step of undo.reverse()) {
      try {
        step();
      } catch (err) {
        problems.push((err as Error).message);
      }
    }
    if (systemd && (started || stopped.length)) {
      attempt("systemctl", ["--user", "daemon-reload"]);
      // Its own unit was enabled before: it runs again as it was, or stays stopped.
      if (started && ownState?.enabled) attempt("systemctl", ["--user", ownState.active ? "restart" : "stop", SYSTEMD_UNIT]);
      for (const s of stopped) {
        if (s.enabled) attempt("systemctl", ["--user", "enable", s.name]);
        if (s.active) attempt("systemctl", ["--user", "start", s.name]);
      }
    }
    if (!systemd && loadedBefore && fs.existsSync(target.file)) attempt("launchctl", ["bootstrap", `gui/${ctx.uid}`, target.file]);
    return problems;
  };
  try {
    for (const r of foreign) {
      if (systemd) {
        const info = systemdUnitInfo(ctx, r.name);
        runChecked(ctx, ran, "systemctl", ["--user", "disable", "--now", r.name]);
        stopped.push({ name: r.name, enabled: info.enabled, active: info.active });
      } else {
        bootoutAgent(ctx, ran);
      }
      const backup = backups.get(r.file) as string;
      fs.renameSync(r.file, backup);
      undo.push(() => fs.renameSync(backup, r.file));
    }
    const ownBackup = ownBefore && backups.get(ownBefore.file);
    if (ownBackup) {
      fs.copyFileSync(target.file, ownBackup);
      undo.push(() => fs.rmSync(ownBackup, { force: true }));
    }
    if (systemd && toKeep.length) {
      fs.mkdirSync(path.dirname(dropIn), { recursive: true });
      const sources = replaced.filter((r) => r.settings.kept.length).map((r) => r.file);
      const body = dropInBefore ?? `# ${UNIT_MARKER}: what it kept of ${sources.join(", ")}; \`${BIN} server uninstall\` removes it.\n`;
      fs.writeFileSync(dropIn, [body.trimEnd(), ...dropInSections(toKeep), ""].join("\n"), { mode: 0o644 });
      undo.push(() => (dropInBefore == null ? removeDropIn(dropIn) : fs.writeFileSync(dropIn, dropInBefore)));
    }
    fs.mkdirSync(path.dirname(target.file), { recursive: true });
    fs.writeFileSync(target.file, text, { mode: 0o644 });
    undo.push(() => (ownBefore ? fs.writeFileSync(target.file, ownBefore.text) : fs.rmSync(target.file, { force: true })));
    if (systemd) {
      runChecked(ctx, ran, "systemctl", ["--user", "daemon-reload"]);
      // A unit that is already running keeps the settings it was started with, so it has to
      // restart to pick up what was just written (a new port, a new state dir).
      const active = ctx.run("systemctl", ["--user", "is-active", SYSTEMD_UNIT]).stdout.trim() === "active";
      started = true;
      runChecked(ctx, ran, "systemctl", ["--user", "enable", "--now", SYSTEMD_UNIT]);
      if (active || holderUnit?.unit === name) runChecked(ctx, ran, "systemctl", ["--user", "restart", SYSTEMD_UNIT]);
      if (linger(ctx) === false) notes.push(LINGER_OFF);
    } else {
      // Unload an earlier copy (it may not be loaded: ignore the answer), then load this one; RunAtLoad starts it.
      runRecorded(ctx, ran, "launchctl", ["bootout", launchdTarget(ctx.uid)]);
      started = true;
      runChecked(ctx, ran, "launchctl", ["bootstrap", `gui/${ctx.uid}`, target.file]);
    }
    // The service has to answer: a unit that dies at once (a port taken, a bad path) would
    // restart in a loop while install said "installed".
    const seen = await serviceAnswer(ctx, target.supervisor, port, stateDir);
    if (seen) throw new Error(`the service did not answer on port ${port} within 15 s (${seen})`);
  } catch (err) {
    const problems = rollback();
    const why = systemd ? `journalctl --user -u ${SYSTEMD_UNIT} -n 50` : path.join(stateDir, "server.log");
    const after = problems.length ? `Putting back what was there failed too: ${problems.join("; ")}.` : `Nothing was changed: ${replaced.length ? "the units it replaced are back" : "the unit it wrote was removed"}.`;
    throw new Error(`${(err as Error).message}. ${after} See why: ${why}`);
  }
  if (port !== defaultPort(ctx.env)) {
    notes.push(
      ctx.env.AUSTERE_AXI_PORT
        ? `It listens on port ${port}, and AUSTERE_AXI_PORT=${ctx.env.AUSTERE_AXI_PORT} sends CLI commands to another one: set it to ${port}, or unset it.`
        : `It listens on port ${port}. CLI commands on this state dir find it there: the server's server.lock names its port, and the unit does while it is stopped.`,
    );
  }
  return {
    status: "installed",
    supervisor: target.supervisor,
    unit: target.file,
    runs: serverArgs(spec).join(" "),
    port,
    link_url: linkUrl,
    kept: toKeep.length ? toKeep.map((k) => k.line) : undefined,
    kept_in: systemd && toKeep.length ? dropIn : undefined,
    stopped: foreign.length ? foreign.map((r) => r.name) : undefined,
    backups: backups.size ? [...backups.values()] : undefined,
    ran,
    warnings: warnings.length ? warnings : undefined,
    notes: notes.length ? notes : undefined,
    next: `${BIN} server status shows it; ${BIN} server restart restarts it (after upgrading ${BIN}, too); ${BIN} server uninstall removes it.`,
  };
}

/** Windows (and any platform without systemd or launchd): what to do by hand. Changes nothing. */
function manualSteps(spec: ServiceSpec, ctx: ServiceContext, warnings: string[]): Record<string, unknown> {
  const quoted = serverArgs(spec).map((a) => (/[\s"]/.test(a) ? `\\"${a}\\"` : a));
  const steps =
    ctx.platform === "win32"
      ? [
          ...(spec.linkUrl ? [commandLine(["setx", "AUSTERE_AXI_LINK_URL", spec.linkUrl], "win32")] : []),
          `schtasks /Create /SC ONLOGON /TN austere-axi /TR "${quoted.join(" ")}"`,
          "schtasks /Run /TN austere-axi",
        ]
      : [`Run \`${commandLine(serverArgs(spec), ctx.platform)}\` at login with your service manager${spec.linkUrl ? `, with ${commandLine([`AUSTERE_AXI_LINK_URL=${spec.linkUrl}`], ctx.platform)}` : ""}.`];
  return {
    status: "manual",
    platform: ctx.platform,
    steps,
    warnings: warnings.length ? warnings : undefined,
    note: `${BIN} installs a service on Linux (systemd) and macOS (launchd) only. Started this way the server is not supervised: a newer CLI replaces it, and keeps --persist.`,
    remove: ctx.platform === "win32" ? "schtasks /Delete /TN austere-axi /F" : undefined,
  };
}

/**
 * Unload the launchd agent. An agent that is not loaded is fine; any other failure is not:
 * the file must not go while the agent is still loaded, or the server keeps running with no
 * unit behind it.
 */
function bootoutAgent(ctx: ServiceContext, ran: string[]): void {
  const { result, failure } = runRecorded(ctx, ran, "launchctl", ["bootout", launchdTarget(ctx.uid)]);
  if (failure && !/Could not find service|No such process|not loaded/i.test(result.stderr)) throw new Error(failure);
}

/**
 * Stop the service and remove its unit, and the drop-in install wrote beside it. Refuses a unit
 * that runs another CLI or another state dir unless forced: a checkout must not take the owner's
 * service away.
 */
export function uninstallService(ctx: ServiceContext, { force = false }: { force?: boolean } = {}): Record<string, unknown> {
  const target = unitFile(ctx);
  if (!target) {
    return { status: "manual", platform: ctx.platform, steps: ctx.platform === "win32" ? ["schtasks /End /TN austere-axi", "schtasks /Delete /TN austere-axi /F"] : ["Remove the entry you added to your service manager."] };
  }
  if (!fs.existsSync(target.file)) return { status: "not installed", unit: target.file };
  if (!isOurUnit(target.file)) {
    // A unit the owner wrote is theirs: it may carry settings only they know about.
    return { status: "not installed", unit: target.file, note: `that unit was not written by \`${BIN} server install\`; it was left alone` };
  }
  // Taking a service away is the owner's decision, like setting one up (design note, Security).
  if (!ctx.isTTY) {
    throw new Error(`server uninstall needs the user at a terminal: it stops a service and removes its unit. Ask the user to run \`${BIN} server uninstall\` themselves.`);
  }
  const systemd = target.supervisor === "systemd";
  if (!force) {
    const text = fs.readFileSync(target.file, "utf8");
    const other = otherOwner(systemd ? systemdSettings(text) : launchdSettings(text), target.file, ctx, true);
    if (other) throw new Error(`${other}. Run \`${BIN} server uninstall\` from the CLI and with the state dir the service uses, or add --force to remove it anyway.`);
  }
  const ran: string[] = [];
  const problems: string[] = [];
  const dropIn = path.join(`${target.file}.d`, KEPT_CONF);
  const ownDropIn = systemd && isOurUnit(dropIn);
  if (systemd) {
    // The unit goes either way: a service manager that fails must not leave a file that
    // starts the server again at the next login.
    const disable = runRecorded(ctx, ran, "systemctl", ["--user", "disable", "--now", SYSTEMD_UNIT]).failure;
    fs.rmSync(target.file, { force: true });
    if (ownDropIn) removeDropIn(dropIn);
    const reload = runRecorded(ctx, ran, "systemctl", ["--user", "daemon-reload"]).failure;
    problems.push(...[disable, reload].filter((p): p is string => p != null));
  } else {
    // The agent has to be gone before the file goes, or the server keeps running with no unit.
    bootoutAgent(ctx, ran);
    fs.rmSync(target.file, { force: true });
  }
  return {
    status: problems.length ? "removed with errors" : "uninstalled",
    supervisor: target.supervisor,
    unit: target.file,
    drop_in: ownDropIn ? dropIn : undefined,
    ran,
    problems: problems.length ? problems : undefined,
  };
}

/** The running server, as status reports it (client.ts ServerHealth, narrowed). */
export interface RunningServer {
  version: string;
  pid: number;
  port: number;
  /** The supervisor that runs it: what the server says, or what serverUnit found. */
  supervised?: Supervisor;
  /** The unit's name, when serverUnit found it. */
  unit?: string;
}

/** This machine, as the service commands see it. `confirm` asks the owner; without it, install asks and hears no. */
export function serviceContext(probe: (port: number) => Promise<PortProbe | null>, confirm: (question: string) => Promise<boolean> = async () => false): ServiceContext {
  return {
    platform: process.platform,
    home: os.homedir(),
    env: process.env,
    run: runCommand,
    isTTY: !!process.stdin.isTTY,
    node: process.execPath,
    cli: CLI_ENTRY,
    stateDir: stateDir(),
    uid: process.getuid?.() ?? null,
    holder: stateDirHolder,
    probe,
    unitOf: (pid) => serverUnit(pid),
    isAncestor,
    confirm,
  };
}

/** Whether a unit file is the one this command wrote. */
export function isOurUnit(file: string): boolean {
  try {
    return fs.readFileSync(file, "utf8").includes(UNIT_MARKER);
  } catch {
    return false;
  }
}

/**
 * What the installed unit runs with, read by the same parsers install uses (systemd's quoting and
 * `%h`, launchd's XML escapes; the port from `--port` or `AUSTERE_AXI_PORT`), and its state dir.
 */
function installedSettings(target: { supervisor: Supervisor; file: string }, home: string): UnitSettings & { dir: string } {
  const settings = (target.supervisor === "systemd" ? systemdSettings : launchdSettings)(fs.readFileSync(target.file, "utf8"));
  return { ...settings, dir: unitSettingsStateDir(settings, home) };
}

/** The installed service, when it is the one for this state dir and port (a unit that names no port is taken for any). */
export function installedServiceFor(ctx: Pick<ServiceContext, "platform" | "home" | "env">, dir: string, port: number): { supervisor: Supervisor; file: string } | null {
  const target = unitFile(ctx);
  if (!target || !fs.existsSync(target.file)) return null;
  const s = installedSettings(target, ctx.home);
  if (s.dir !== path.resolve(dir)) return null; // another state dir's service
  if (s.port != null && s.port !== port) return null; // it serves another port
  return target;
}

/**
 * The port CLI commands find this state dir's server on: AUSTERE_AXI_PORT when it is set; else
 * the port in server.lock while the server that wrote it lives; else the port of the service
 * installed for this state dir (`server install --port n`), so a stopped service is started
 * where it listens; else 4388.
 */
export function serverPort(ctx: Pick<ServiceContext, "platform" | "home" | "env"> = { platform: process.platform, home: os.homedir(), env: process.env }, dir: string = stateDir()): number {
  if (ctx.env.AUSTERE_AXI_PORT) return defaultPort(ctx.env);
  const locked = lockedPort(dir);
  if (locked != null) return locked;
  const target = unitFile(ctx);
  if (!target || !fs.existsSync(target.file)) return REAL_PORT;
  const s = installedSettings(target, ctx.home);
  return s.dir === path.resolve(dir) ? (s.port ?? REAL_PORT) : REAL_PORT;
}

/**
 * Start the installed service, when it is the one for this state dir and this port. A CLI
 * that starts its own server instead would take the port and the state dir away from the
 * unit, and the unit could never come back (RLM-311). `restart` restarts a unit that is already
 * active (its server does not answer), which a start would leave as it is. Returns whether a
 * service was started.
 */
export function startInstalledService(ctx: ServiceContext, dir: string, port: number, { restart = false }: { restart?: boolean } = {}): boolean {
  const target = installedServiceFor(ctx, dir, port);
  if (!target) return false;
  // A unit that hit its start limit (it was locked out) refuses to start until it is reset.
  if (target.supervisor === "systemd") ctx.run("systemctl", ["--user", "reset-failed", SYSTEMD_UNIT]);
  const r = target.supervisor === "systemd" ? ctx.run("systemctl", ["--user", restart ? "restart" : "start", SYSTEMD_UNIT]) : ctx.run("launchctl", ["kickstart", "-k", launchdTarget(ctx.uid)]);
  if (r.code !== 0) throw new Error(`the installed service did not start: ${commandOutput(r)} (see why: ${statusCommand(target.supervisor, ctx.uid)}; remove it: ${BIN} server uninstall)`);
  return true;
}

/**
 * The service for this state dir in plain words: what it does (running, starting, failing to
 * start, stopped), whether it starts at login and, under systemd, whether it outlives the
 * owner's last session (linger); and which server answers. A unit that serves another state
 * dir is named, and its state is not reported as this one's.
 */
export function serviceStatus(ctx: ServiceContext, server: RunningServer | null, version: string): Record<string, unknown> {
  const target = unitFile(ctx);
  const answering = server ? `v${server.version}, pid ${server.pid}, port ${server.port}, ${server.supervised ? `run by ${server.unit ?? server.supervised}` : "not run by a service"}` : "not running";
  if (!target) return { service: "unknown: no supported service manager here", platform: ctx.platform, server: answering };
  const unit = { supervisor: target.supervisor, unit: target.file };
  if (!fs.existsSync(target.file)) {
    // A unit the owner wrote may run it under another name: say so, not "install one".
    const next = server?.supervised
      ? `It runs under ${server.unit ?? server.supervised}, a unit \`${BIN} server install\` did not write; \`${BIN} server restart\` restarts it, \`${BIN} server install --adopt\` takes its place.`
      : `${BIN} server install sets it up (at a terminal).`;
    return { service: "not installed", ...unit, server: answering, next };
  }
  const dir = path.resolve(ctx.stateDir);
  const settings = installedSettings(target, ctx.home);
  if (settings.dir !== dir) {
    return { service: "not installed for this state dir", ...unit, server: answering, note: `that unit serves ${settings.dir}, and this CLI uses ${dir}; its state is not this state dir's.` };
  }
  const systemd = target.supervisor === "systemd";
  const port = settings.port ?? REAL_PORT;
  let state: string;
  let enabled: boolean | null = true; // a launchd agent in LaunchAgents loads at login
  let lingers: boolean | null | undefined;
  if (systemd) {
    const info = systemdUnitInfo(ctx, SYSTEMD_UNIT);
    // No answer (a `su` shell, a container): nothing is known, not "stopped" or "disabled".
    state = info.answered ? (systemdState(info.state, info.sub) ?? `unknown (systemd says ${info.state})`) : "unknown: systemd's user manager does not answer here";
    enabled = info.answered ? info.enabled : null;
    lingers = linger(ctx);
  } else {
    const r = ctx.run("launchctl", ["print", launchdTarget(ctx.uid)]);
    state = launchdState(r.code === 0 ? r.stdout : null);
  }
  const node = settings.node;
  const warnings = [
    node && path.isAbsolute(node) && !fs.existsSync(node) ? `the unit runs node from ${node}, which is not there any more: the service cannot start. Run \`${BIN} server install\` again.` : nodeWarning(node ?? "", settings.cli ?? ""),
    settings.cli ? npxWarning(settings.cli) : null,
  ].filter((w): w is string => w != null);
  const why = systemd ? `journalctl --user -u ${SYSTEMD_UNIT} -n 50` : path.join(dir, "server.log");
  let next: string | undefined;
  if (server && !server.supervised && server.port === port) {
    // The installed service's port is taken by a server it did not start: it fails until that one stops.
    next = lockedOutNote(server.pid, server.port);
  } else if (server?.supervised && server.version !== version) {
    next = `The server runs v${server.version} and this CLI is v${version}. Restart it: ${restartHint({ supervisor: server.supervised, unit: server.unit ?? (server.supervised === "launchd" ? UNKNOWN_LAUNCHD_LABEL : SYSTEMD_UNIT) }, ctx.uid)}`;
  } else if (state === "failing to start") {
    next = `It does not stay up. See why: ${why}; then \`${BIN} server restart\`.`;
  } else if (!server && state === "running") {
    next = `The unit runs, but no server answers on port ${port}. See why: ${why}`;
  } else if (!server && state === "stopped") {
    next = `Start it: \`${BIN} server restart\` (the next command that needs a server starts it too).`;
  }
  return {
    service: state,
    ...unit,
    port,
    starts: enabled === null ? "unknown" : !enabled ? "not on its own (disabled)" : lingers ? "at boot" : "at login",
    linger: lingers === undefined ? undefined : lingers === null ? "unknown" : lingers ? "on" : "off",
    server: answering,
    warnings: warnings.length ? warnings : undefined,
    note: lingers === false ? LINGER_OFF : undefined,
    next,
  };
}
