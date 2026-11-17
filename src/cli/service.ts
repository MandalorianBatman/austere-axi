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
import { launchdSettings, systemdSettings } from "./unit-file.ts";
import type { KeptLine, UnitSettings } from "./unit-file.ts";

/** The service manager that runs a server. */
export type Supervisor = "systemd" | "launchd";

export const SYSTEMD_UNIT = "austere-axi.service";
/** The line both units carry, so the command knows a unit is its own. */
export const UNIT_MARKER = "Written by `austere-axi server install`";
export const LAUNCHD_LABEL = "xyz.kasat.austere-axi";
const BIN = "austere-axi";
const DEFAULT_PORT = 4388;

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

/** Whether `ancestor` is `pid` itself or one of its parents. */
export function isAncestor(ancestor: number, pid: number): boolean {
  let current = pid;
  for (let i = 0; i < 20; i++) {
    if (current === ancestor) return true;
    if (current <= 1) return false;
    const parent = parentPid(current);
    if (parent == null || parent === current) return false;
    current = parent;
  }
  return false;
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
  isAncestor: (ancestor: number, pid: number) => boolean;
}

const readProc = (pid: number, file: string): string | null => {
  try {
    return fs.readFileSync(`/proc/${pid}/${file}`, "utf8");
  } catch {
    return null;
  }
};

/** This machine, as serverUnit sees it. */
export function thisMachine(): ProcessView {
  return {
    platform: process.platform,
    uid: process.getuid?.() ?? null,
    run: runCommand,
    cgroup: (pid) => readProc(pid, "cgroup"),
    script: (pid) => readProc(pid, "cmdline")?.split("\0")[1] || null,
    isAncestor,
  };
}

/**
 * The unit that runs the server with process id `pid`, or null when none does. It asks the
 * system, not the server: a server from before 0.12 does not report `supervised`, and a CLI
 * that replaced it would lock its unit out (RLM-311, RLM-375). On Linux the pid's cgroup names
 * the unit; the unit counts when it runs the austere server (runsTheServer, with the script
 * that pid runs) and its main process is that pid or an ancestor of it. On macOS it is the
 * agent `server install` writes, when its pid is that pid or an ancestor.
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
    if (job.pid == null || !runsTheServer(job.command, view.script(pid) ?? CLI_ENTRY) || !view.isAncestor(job.pid, pid)) return null;
    return { supervisor: "systemd", unit };
  }
  if (view.platform === "darwin") {
    const r = view.run("launchctl", ["print", launchdTarget(view.uid)]);
    const main = r.code === 0 ? positivePid(/\bpid = (\d+)/.exec(r.stdout)?.[1]) : null;
    return main != null && view.isAncestor(main, pid) ? { supervisor: "launchd", unit: LAUNCHD_LABEL } : null;
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

/** The port CLI commands look for the server on (paths.ts port(), over ctx.env). */
function defaultPort(env: NodeJS.ProcessEnv): number {
  const p = Number(env.AUSTERE_AXI_PORT);
  return Number.isInteger(p) && p > 0 && p < 65536 ? p : DEFAULT_PORT;
}

function installCommand(o: InstallOptions): string {
  return [`${BIN} server install`, o.port ? `--port ${o.port}` : "", o.linkUrl ? `--link-url ${o.linkUrl}` : "", o.adopt ? "--adopt" : "", o.force ? "--force" : ""].filter(Boolean).join(" ");
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

/** A systemd user unit's file, state and main pid, out of one `systemctl --user show`. */
function systemdUnitInfo(ctx: ServiceContext, unit: string): { file: string | null; enabled: boolean; active: boolean; pid: number | null } {
  const r = ctx.run("systemctl", ["--user", "show", unit, "--property=FragmentPath", "--property=UnitFileState", "--property=ActiveState", "--property=MainPID"]);
  const prop = (key: string): string => new RegExp(`^${key}=(.*)$`, "m").exec(r.stdout)?.[1]?.trim() ?? "";
  return {
    file: prop("FragmentPath") || null,
    enabled: prop("UnitFileState").startsWith("enabled"),
    active: ["active", "activating", "reloading"].includes(prop("ActiveState")),
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
 */
function otherOwner(s: UnitSettings, file: string, ctx: ServiceContext, checkCli: boolean): string | null {
  const dir = unitSettingsStateDir(s, ctx.home);
  const mine = path.resolve(ctx.stateDir);
  if (dir !== mine) return `${file} serves the state dir ${dir}, and this CLI uses ${mine}`;
  if (checkCli && s.cli && path.resolve(s.cli) !== path.resolve(ctx.cli)) return `${file} runs ${s.cli}, and this CLI is ${ctx.cli}`;
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
  const specFor = (port: number, linkUrl: string | undefined, env?: [string, string][]): ServiceSpec => ({ node: ctx.node, cli: ctx.cli, port, linkUrl, stateDir: unitStateDirSetting, env });
  const warning = npxWarning(ctx.cli) ?? undefined;
  const target = unitFile(ctx);
  // The terminal rule comes first on every platform: `server install` configures what runs on
  // this machine, so it is the owner's decision everywhere, Windows included (design note,
  // Security). On Windows it changes nothing anyway, but the refusal is the same.
  if (!ctx.isTTY) {
    throw new Error(`server install needs the user at a terminal and changes nothing here. Ask the user to run \`${installCommand(o)}\` themselves.`);
  }
  if (!target) return manualSteps(specFor(o.port ?? defaultPort(ctx.env), optionLink), ctx, warning);
  const systemd = target.supervisor === "systemd";
  if (!systemd && ctx.uid == null) throw new Error("no user id to install the launchd agent for");
  // Nothing is written until the service manager answers. A unit it cannot load would stay on
  // disk, and every later command would try to start it (WSL without systemd, a container, `su`).
  const unreachable = managerUnreachable(ctx, target.supervisor);
  if (unreachable) {
    const spec = specFor(o.port ?? defaultPort(ctx.env), optionLink);
    const vars = serverEnv(spec).map(([k, v]) => `${k}=${v}`);
    const by = `\`${serverArgs(spec).join(" ")}\`${vars.length ? ` with ${vars.join(" ")}` : ""}`;
    throw new Error(
      systemd
        ? `systemd's user manager does not answer here (${unreachable}); nothing was written. A shell from \`su\` or \`sudo\`, a container, or WSL without systemd has none. Log in as this user (a desktop session or ssh) and run \`${installCommand(o)}\` again, or have your service manager run ${by} at login.`
        : `launchd's session for user ${ctx.uid} does not answer (${unreachable}); nothing was written. Run \`${installCommand(o)}\` from a terminal in that user's desktop session, or run ${by} at login some other way.`,
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
      ? `run \`${stop}\` first, then \`${installCommand(o)}\` again`
      : `it is still starting; wait a moment, then run \`${installCommand(o)}\` again (a server that keeps the lock for good is stopped with \`${stop}\`)`;
    throw new Error(`a server not started by ${target.supervisor} (pid ${holder.pid}${where}) holds ${path.join(stateDir, "server.lock")}; ${advice}`);
  }
  if (holder && holderUnit && holderUnit.unit !== name) {
    // A unit under another name runs it, one the owner wrote. It is taken over only from the
    // folder the new unit goes in: a unit elsewhere (/etc, a link) is not this command's to move.
    const file = systemd ? systemdUnitInfo(ctx, holderUnit.unit).file : null;
    if (!file || path.dirname(file) !== path.dirname(target.file) || !fs.existsSync(file)) {
      const stop = systemd ? `systemctl --user disable --now ${holderUnit.unit}` : `launchctl bootout gui/${ctx.uid}/${holderUnit.unit}`;
      throw new Error(`the server here (pid ${holder.pid}) runs under ${holderUnit.unit}${file ? ` (${file})` : ""}, which \`${BIN} server install\` did not write and cannot take over from ${path.dirname(target.file)}. Stop and disable it yourself (\`${stop}\`), then run \`${installCommand(o)}\` again.`);
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
    const keeps = systemd ? "its Environment=, ExecStartPre= and After= lines, in a drop-in" : "its environment variables";
    throw new Error(`${what}. \`${installCommand({ ...o, adopt: true })}\` takes its place: it shows what it keeps of it (${keeps}) and asks, then backs it up beside it, stops and disables it, and installs its own.`);
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
    throw new Error(`something already listens on port ${port}${whose}; the service could not take it. Stop it, or install on another port: \`${installCommand({ ...o, port: port + 1 })}\``);
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
    `  ${systemd ? "ExecStart" : "ProgramArguments"}: ${serverArgs(spec).join(" ")}`,
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
      const user = ctx.env.USER || os.userInfo().username;
      const linger = ctx.run("loginctl", ["show-user", user, "--property=Linger", "--value"]);
      if (linger.code === 0 && linger.stdout.trim() === "no") {
        notes.push("systemd starts it when you log in. To start it at boot, before you log in, run `loginctl enable-linger` once.");
      }
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
  if (port !== defaultPort(ctx.env)) notes.push(`It listens on port ${port}: CLI commands find it with AUSTERE_AXI_PORT=${port}.`);
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
    out.next = `The server runs v${server.version} and this CLI is v${version}. Restart it: ${restartCommand(server.supervised, ctx.uid, server.unit)}`;
  } else if (target && !out.installed) {
    out.next = `${BIN} server install sets it up (at a terminal).`;
  } else if (target && out.installed && !server) {
    // Installed but not answering: say how to start it, and on which port.
    const start = target.supervisor === "systemd" ? `systemctl --user start ${SYSTEMD_UNIT}` : `launchctl kickstart -k ${launchdTarget(ctx.uid)}`;
    out.next = `The service is installed but no server answers. Start it: ${start}${out.port ? ` (it listens on port ${out.port}; CLI commands find it with AUSTERE_AXI_PORT=${out.port})` : ""}`;
  }
  return out;
}
