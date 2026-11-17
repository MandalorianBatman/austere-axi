// `server install|uninstall|status`: the server as a per-user service, so pages always have one.
// systemd on Linux, launchd on macOS; on Windows the owner gets the steps to do it by hand.
// A server a supervisor runs never idles out, records its supervisor in server.lock and
// /api/health, and is never replaced by a newer CLI (that CLI prints how to restart the unit
// instead).
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseLinkUrl } from "./net.ts";
import { stateDirHolder } from "./lock.ts";
import type { LockHolder } from "./lock.ts";
import { CLI_ENTRY, stateDir } from "./paths.ts";

/** The service manager that runs a server. */
export type Supervisor = "systemd" | "launchd";

export const SYSTEMD_UNIT = "austere-axi.service";
/** The line both units carry, so the command knows a unit is its own. */
export const UNIT_MARKER = "Written by `austere-axi server install`";
export const LAUNCHD_LABEL = "xyz.kasat.austere-axi";
/** Stands in a restart hint for the label of a launchd agent that runs the server but could not be found (`launchctl list` shows it). */
export const UNKNOWN_LAUNCHD_LABEL = "<launchd-label>";
const BIN = "austere-axi";
const DEFAULT_PORT = 4388;

/**
 * The supervisor this process runs under, or null when nobody runs it.
 *
 * The evidence is the system's own, and it is checked: the unit that owns this process's
 * cgroup runs a main process, and this process is it or a child of it. A unit whose command
 * is `npx -y austere-axi server --persist` runs the server below its main process, and that
 * server is supervised too. A variable a process sets for itself proves nothing (a CLI hands
 * its environment to the server it starts, and so does every shell), so the answer is: does
 * the unit run this process?
 */
export function detectSupervisor(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): Supervisor | null {
  const job = platform === "linux" ? systemdJob() : platform === "darwin" ? launchdJob(env.XPC_SERVICE_NAME) : null;
  // A unit that runs something else is not our server's, even when this process sits in it.
  if (!job || !runsTheServer(job.command) || job.pid == null) return null;
  return isAncestor(job.pid, process.pid) ? job.supervisor : null;
}

/** A job a service manager runs: its command line and its main pid. */
interface Job {
  supervisor: Supervisor;
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
  return { supervisor: "systemd", ...parseSystemdShow(r.stdout || "") };
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
  return { supervisor: "launchd", command: text, pid: positivePid(/\bpid = (\d+)/.exec(text)?.[1]) };
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

/** Where there is no /proc (macOS): the second word of the process's command line, as ps prints it (a path with spaces is cut, and then matches nothing). */
function psScript(pid: number): string | null {
  const r = spawnSync("ps", ["-o", "args=", "-p", String(pid)], { encoding: "utf8", timeout: 5000 });
  return (r.stdout || "").trim().split(/\s+/)[1] || null;
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
}

function serverArgs(spec: ServiceSpec): string[] {
  return [spec.node, spec.cli, "server", "--persist", "--port", String(spec.port)];
}

function serverEnv(spec: ServiceSpec): [string, string][] {
  // The supervisor is not named here: the server asks the system who runs it (detectSupervisor).
  const env: [string, string][] = [];
  if (spec.linkUrl) env.push(["AUSTERE_AXI_LINK_URL", spec.linkUrl]);
  if (spec.stateDir) env.push(["AUSTERE_AXI_STATE_DIR", spec.stateDir]);
  return env;
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
}

export interface InstallOptions {
  port?: number;
  linkUrl?: string;
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

/** The port CLI commands look for the server on (paths.ts port(), over ctx.env). */
function defaultPort(env: NodeJS.ProcessEnv): number {
  const p = Number(env.AUSTERE_AXI_PORT);
  return Number.isInteger(p) && p > 0 && p < 65536 ? p : DEFAULT_PORT;
}

function installCommand(o: InstallOptions): string {
  return [`${BIN} server install`, o.port ? `--port ${o.port}` : "", o.linkUrl ? `--link-url ${o.linkUrl}` : ""].filter(Boolean).join(" ");
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

/**
 * Write the unit for this machine's service manager and start it. Refuses without a terminal (it
 * configures a command to run) and while a server the service manager did not start holds the
 * state dir. On Windows it returns the steps to do by hand.
 */
export async function installService(o: InstallOptions, ctx: ServiceContext): Promise<Record<string, unknown>> {
  const port = o.port ?? defaultPort(ctx.env);
  let linkUrl: string | undefined;
  if (o.linkUrl) {
    try {
      linkUrl = parseLinkUrl(o.linkUrl)?.base;
    } catch (err) {
      throw new Error(`--link-url is not a url: ${o.linkUrl} (${(err as Error).message})`);
    }
  }
  // The service runs from its own working folder (the user's home), so a relative state dir
  // would point it at a different database than the CLI that installed it. Absolute, or nothing.
  const stateDir = path.resolve(ctx.stateDir);
  const spec: ServiceSpec = { node: ctx.node, cli: ctx.cli, port, linkUrl, stateDir: ctx.env.AUSTERE_AXI_STATE_DIR ? stateDir : undefined };
  const warning = npxWarning(ctx.cli) ?? undefined;
  const target = unitFile(ctx);
  // The terminal rule comes first on every platform: `server install` configures what runs on
  // this machine, so it is the owner's decision everywhere, Windows included (design note,
  // Security). On Windows it changes nothing anyway, but the refusal is the same.
  if (!ctx.isTTY) {
    throw new Error(`server install needs the user at a terminal and changes nothing here. Ask the user to run \`${installCommand(o)}\` themselves.`);
  }
  if (!target) return manualSteps(spec, ctx, warning);
  // A unit that this command did not write belongs to the owner: it may carry settings (a
  // proxy url) that only they know about. Overwriting it silently would lose them.
  if (fs.existsSync(target.file) && !isOurUnit(target.file)) {
    throw new Error(`there is already a unit at ${target.file} that \`${BIN} server install\` did not write; move it aside or remove it, then run \`${installCommand(o)}\` again`);
  }
  const holder = await ctx.holder(stateDir);
  if (holder && !holder.supervised) {
    const where = holder.port ? `, port ${holder.port}` : "";
    const stop = holder.port && holder.port !== defaultPort(ctx.env) ? `AUSTERE_AXI_PORT=${holder.port} ${BIN} stop` : `${BIN} stop`;
    // A server that is still starting does not answer `stop` yet: say to wait for it.
    const advice = holder.serving
      ? `run \`${stop}\` first, then \`${installCommand(o)}\` again`
      : `it is still starting; wait a moment, then run \`${installCommand(o)}\` again (a server that keeps the lock for good is stopped with \`${stop}\`)`;
    throw new Error(`a server not started by ${target.supervisor} (pid ${holder.pid}${where}) holds ${path.join(stateDir, "server.lock")}; ${advice}`);
  }
  // The service has to be able to take the port: something else on it would leave the unit
  // restarting in a loop, and install would say "installed".
  const onPort = await ctx.probe(port);
  if (onPort && !onPort.supervised) {
    throw new Error(`something already listens on port ${port}${onPort.foreign ? " that is not an austere-axi server" : ""}; the service could not take it. Stop it, or install on another port: \`${installCommand({ ...o, port: port + 1 })}\``);
  }
  const ran: string[] = [];
  const notes: string[] = [];
  fs.mkdirSync(path.dirname(target.file), { recursive: true });
  if (target.supervisor === "systemd") {
    fs.writeFileSync(target.file, systemdUnit(spec), { mode: 0o644 });
    runChecked(ctx, ran, "systemctl", ["--user", "daemon-reload"]);
    // A unit that is already running keeps the settings it was started with, so it has to
    // restart to pick up what was just written (a new port, a new state dir).
    const active = ctx.run("systemctl", ["--user", "is-active", SYSTEMD_UNIT]).stdout.trim() === "active";
    runChecked(ctx, ran, "systemctl", ["--user", "enable", "--now", SYSTEMD_UNIT]);
    if (active || holder?.supervised === "systemd") runChecked(ctx, ran, "systemctl", ["--user", "restart", SYSTEMD_UNIT]);
    const user = ctx.env.USER || os.userInfo().username;
    const linger = ctx.run("loginctl", ["show-user", user, "--property=Linger", "--value"]);
    if (linger.code === 0 && linger.stdout.trim() === "no") {
      notes.push("systemd starts it when you log in. To start it at boot, before you log in, run `loginctl enable-linger` once.");
    }
  } else {
    if (ctx.uid == null) throw new Error("no user id to install the launchd agent for");
    fs.writeFileSync(target.file, launchdPlist(spec, path.join(stateDir, "server.log")), { mode: 0o644 });
    // Unload an earlier copy (it may not be loaded: ignore the answer), then load this one; RunAtLoad starts it.
    runRecorded(ctx, ran, "launchctl", ["bootout", launchdTarget(ctx.uid)]);
    runChecked(ctx, ran, "launchctl", ["bootstrap", `gui/${ctx.uid}`, target.file]);
  }
  if (port !== defaultPort(ctx.env)) notes.push(`It listens on port ${port}: CLI commands find it with AUSTERE_AXI_PORT=${port}.`);
  // The service has to answer: a unit that dies at once (a port taken, a bad path) would
  // restart in a loop while install said "installed".
  let up = false;
  for (let i = 0; i < 150 && !up; i++) {
    const answer = await ctx.probe(port);
    up = Boolean(answer && answer.supervised);
    if (!up) await new Promise((r) => setTimeout(r, 100));
  }
  if (!up) {
    throw new Error(`the service was written to ${target.file} but does not answer on port ${port}; look at it: ${target.supervisor === "systemd" ? `systemctl --user status ${SYSTEMD_UNIT}` : `launchctl print ${launchdTarget(ctx.uid)}`}`);
  }
  return {
    status: "installed",
    supervisor: target.supervisor,
    unit: target.file,
    runs: serverArgs(spec).join(" "),
    port,
    link_url: linkUrl,
    ran,
    warning,
    notes: notes.length ? notes : undefined,
    next: `${BIN} server status shows it; ${BIN} server uninstall removes it. After upgrading ${BIN}, restart it: ${restartCommand(target.supervisor, ctx.uid)}`,
  };
}

/** Windows (and any platform without systemd or launchd): what to do by hand. Changes nothing. */
function manualSteps(spec: ServiceSpec, ctx: ServiceContext, warning: string | undefined): Record<string, unknown> {
  const quoted = serverArgs(spec).map((a) => (/[\s"]/.test(a) ? `\\"${a}\\"` : a));
  const steps =
    ctx.platform === "win32"
      ? [
          ...(spec.linkUrl ? [`setx AUSTERE_AXI_LINK_URL ${spec.linkUrl}`] : []),
          `schtasks /Create /SC ONLOGON /TN austere-axi /TR "${quoted.join(" ")}"`,
          "schtasks /Run /TN austere-axi",
        ]
      : [`Run \`${serverArgs(spec).join(" ")}\` at login with your service manager${spec.linkUrl ? `, with AUSTERE_AXI_LINK_URL=${spec.linkUrl}` : ""}.`];
  return {
    status: "manual",
    platform: ctx.platform,
    steps,
    warning,
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

/** Stop the service and remove its unit. */
export function uninstallService(ctx: ServiceContext): Record<string, unknown> {
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
  const ran: string[] = [];
  const problems: string[] = [];
  if (target.supervisor === "systemd") {
    // The unit goes either way: a service manager that fails must not leave a file that
    // starts the server again at the next login.
    const disable = runRecorded(ctx, ran, "systemctl", ["--user", "disable", "--now", SYSTEMD_UNIT]).failure;
    fs.rmSync(target.file, { force: true });
    const reload = runRecorded(ctx, ran, "systemctl", ["--user", "daemon-reload"]).failure;
    problems.push(...[disable, reload].filter((p): p is string => p != null));
  } else {
    // The agent has to be gone before the file goes, or the server keeps running with no unit.
    bootoutAgent(ctx, ran);
    fs.rmSync(target.file, { force: true });
  }
  return { status: problems.length ? "removed with errors" : "uninstalled", supervisor: target.supervisor, unit: target.file, ran, problems: problems.length ? problems : undefined };
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

/** This machine, as the service commands see it. */
export function serviceContext(probe: (port: number) => Promise<PortProbe | null>): ServiceContext {
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

/** The installed service, when it is the one for this state dir and port. */
export function installedServiceFor(ctx: Pick<ServiceContext, "platform" | "home" | "env">, dir: string, port: number): { supervisor: Supervisor; file: string } | null {
  const target = unitFile(ctx);
  if (!target || !fs.existsSync(target.file)) return null;
  if (path.resolve(unitStateDir(target.file)) !== path.resolve(dir)) return null; // another state dir's service
  const unitPortNumber = unitPort(target.file);
  if (unitPortNumber != null && unitPortNumber !== port) return null; // it serves another port
  return target;
}

/** The state dir an installed unit runs with: its own setting, or the default. */
export function unitStateDir(file: string): string {
  const text = fs.readFileSync(file, "utf8");
  // systemd: Environment=AUSTERE_AXI_STATE_DIR=/path, or the whole assignment quoted.
  const systemd = /^Environment="?AUSTERE_AXI_STATE_DIR=(.*?)"?$/m.exec(text);
  if (systemd) return path.resolve(systemd[1]);
  // launchd: <key>AUSTERE_AXI_STATE_DIR</key><string>/path</string>
  const plist = /<key>AUSTERE_AXI_STATE_DIR<\/key>\s*<string>(.*?)<\/string>/.exec(text);
  if (plist) return path.resolve(plist[1]);
  return path.join(os.homedir(), ".austere-axi");
}

/** The port an installed unit listens on, or null when its command does not name one. */
export function unitPort(file: string): number | null {
  const text = fs.readFileSync(file, "utf8");
  // systemd: ExecStart=... --port 5000
  const systemd = /--port\s+(\d+)/.exec(text);
  // launchd: <string>--port</string><string>5000</string>
  const plist = /<string>--port<\/string>\s*<string>(\d+)<\/string>/.exec(text);
  const port = Number(systemd?.[1] ?? plist?.[1] ?? NaN);
  return Number.isInteger(port) && port > 0 ? port : null;
}

/**
 * Start the installed service, when it is the one for this state dir and this port. A CLI
 * that starts its own server instead would take the port and the state dir away from the
 * unit, and the unit could never come back (RLM-311). Returns whether a service was started.
 */
export function startInstalledService(ctx: ServiceContext, dir: string, port: number): boolean {
  const target = installedServiceFor(ctx, dir, port);
  if (!target) return false;
  // A unit that hit its start limit (it was locked out) refuses to start until it is reset.
  if (target.supervisor === "systemd") ctx.run("systemctl", ["--user", "reset-failed", SYSTEMD_UNIT]);
  const r = target.supervisor === "systemd" ? ctx.run("systemctl", ["--user", "start", SYSTEMD_UNIT]) : ctx.run("launchctl", ["kickstart", "-k", launchdTarget(ctx.uid)]);
  if (r.code !== 0) throw new Error(`the installed service did not start: ${commandOutput(r)} (see why: ${statusCommand(target.supervisor, ctx.uid)}; remove it: ${BIN} server uninstall)`);
  return true;
}

/** Whether the unit is installed and running, and which server answers on `port`. */
export function serviceStatus(ctx: ServiceContext, server: RunningServer | null, version: string): Record<string, unknown> {
  const target = unitFile(ctx);
  const out: Record<string, unknown> = {};
  if (target) {
    const installed = fs.existsSync(target.file);
    Object.assign(out, { supervisor: target.supervisor, unit: target.file, installed });
    if (installed) {
      // The port the unit runs on, not the one this command was given: they can differ.
      const unitPortNumber = unitPort(target.file);
      if (unitPortNumber != null) out.port = unitPortNumber;
      if (target.supervisor === "systemd") {
        const word = (args: string[]): string => ctx.run("systemctl", ["--user", ...args, SYSTEMD_UNIT]).stdout.trim() || "unknown";
        Object.assign(out, { enabled: word(["is-enabled"]), active: word(["is-active"]) });
      } else {
        const r = ctx.run("launchctl", ["print", launchdTarget(ctx.uid)]);
        Object.assign(out, { loaded: r.code === 0, state: r.code === 0 ? /^\s*state = (.+)$/m.exec(r.stdout)?.[1]?.trim() : undefined });
      }
    }
  } else {
    Object.assign(out, { platform: ctx.platform, installed: "unknown: no supported service manager here" });
  }
  out.server = server ? { version: server.version, pid: server.pid, port: server.port, supervised: server.supervised ?? "no" } : "not running";
  if (server && !server.supervised && installedServiceFor(ctx, ctx.stateDir, server.port)) {
    // The installed service's port is taken by a server it did not start: it fails until that one stops.
    out.next = lockedOutNote(server.pid, server.port);
  } else if (server?.supervised && server.version !== version) {
    out.next = `The server runs v${server.version} and this CLI is v${version}. Restart it: ${restartCommand(server.supervised, ctx.uid, server.unit ?? (server.supervised === "launchd" ? UNKNOWN_LAUNCHD_LABEL : undefined))}`;
  } else if (target && !out.installed) {
    out.next = `${BIN} server install sets it up (at a terminal).`;
  } else if (target && out.installed && !server) {
    // Installed but not answering: say how to start it, and on which port.
    const start = target.supervisor === "systemd" ? `systemctl --user start ${SYSTEMD_UNIT}` : `launchctl kickstart -k ${launchdTarget(ctx.uid)}`;
    out.next = `The service is installed but no server answers. Start it: ${start}${out.port ? ` (it listens on port ${out.port}; CLI commands find it with AUSTERE_AXI_PORT=${out.port})` : ""}`;
  }
  return out;
}
