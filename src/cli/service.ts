// `server install|uninstall|status`: the server as a per-user service, so pages always have one.
// systemd on Linux, launchd on macOS; on Windows the owner gets the steps to do it by hand.
// The unit sets AUSTERE_AXI_SUPERVISED, and a server started with it never idles out, records its
// supervisor in server.lock and /api/health, and is never replaced by a newer CLI (that CLI prints
// how to restart the unit instead).
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseLinkUrl } from "./net.ts";
import type { LockHolder } from "./lock.ts";

/** The service manager that runs a server. */
export type Supervisor = "systemd" | "launchd";

/** Set by the unit `server install` writes, to the supervisor's name. */
export const SUPERVISED_ENV = "AUSTERE_AXI_SUPERVISED";
export const SYSTEMD_UNIT = "austere-axi.service";
export const LAUNCHD_LABEL = "xyz.kasat.austere-axi";
const BIN = "austere-axi";
const DEFAULT_PORT = 4388;

/** The supervisor this process runs under, from AUSTERE_AXI_SUPERVISED; null when started by hand or by a CLI. */
export function supervisor(env: NodeJS.ProcessEnv = process.env): Supervisor | null {
  const v = env[SUPERVISED_ENV];
  return v === "systemd" || v === "launchd" ? v : null;
}

/** The command that restarts the server under `s`. */
export function restartCommand(s: Supervisor, uid: number | null = process.getuid?.() ?? null): string {
  return s === "systemd" ? `systemctl --user restart ${SYSTEMD_UNIT}` : `launchctl kickstart -k gui/${uid ?? "$(id -u)"}/${LAUNCHD_LABEL}`;
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

function serverEnv(spec: ServiceSpec, s: Supervisor): [string, string][] {
  const env: [string, string][] = [[SUPERVISED_ENV, s]];
  if (spec.linkUrl) env.push(["AUSTERE_AXI_LINK_URL", spec.linkUrl]);
  if (spec.stateDir) env.push(["AUSTERE_AXI_STATE_DIR", spec.stateDir]);
  return env;
}

/** One systemd word: `%` is a specifier, `$` a variable in ExecStart; quote what has spaces or quotes. */
function systemdWord(s: string): string {
  const v = s.replace(/%/g, "%%").replace(/\$/g, "$$$$");
  return /[\s"'\\;]/.test(v) ? `"${v.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"` : v;
}

function systemdEnv(key: string, value: string): string {
  const v = `${key}=${value}`.replace(/%/g, "%%");
  return /[\s"'\\]/.test(v) ? `"${v.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"` : v;
}

/** The systemd user unit. */
export function systemdUnit(spec: ServiceSpec): string {
  return [
    `# Written by \`${BIN} server install\`; \`${BIN} server uninstall\` removes it.`,
    "[Unit]",
    "Description=austere-axi review server",
    "",
    "[Service]",
    `ExecStart=${serverArgs(spec).map(systemdWord).join(" ")}`,
    ...serverEnv(spec, "systemd").map(([k, v]) => `Environment=${systemdEnv(k, v)}`),
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
    ...serverEnv(spec, "launchd").map(([k, v]) => `    <key>${xml(k)}</key>${str(v)}`),
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

/** Run a service manager command, record it in `ran`, and throw when it fails. */
function runChecked(ctx: ServiceContext, ran: string[], cmd: string, args: string[]): RunResult {
  const r = ctx.run(cmd, args);
  const line = [cmd, ...args].join(" ");
  ran.push(line);
  if (r.code !== 0) throw new Error(`\`${line}\` failed${r.code == null ? "" : ` (exit ${r.code})`}: ${(r.stderr || r.stdout).trim() || "no output"}`);
  return r;
}

/**
 * Write the unit for this machine's service manager and start it. Refuses without a terminal (it
 * configures a command to run) and while a server the service manager did not start holds the
 * state dir. On Windows it returns the steps to do by hand.
 */
export async function installService(o: InstallOptions, ctx: ServiceContext): Promise<Record<string, unknown>> {
  const port = o.port ?? defaultPort(ctx.env);
  const linkUrl = o.linkUrl ? parseLinkUrl(o.linkUrl)?.base : undefined;
  const spec: ServiceSpec = { node: ctx.node, cli: ctx.cli, port, linkUrl, stateDir: ctx.env.AUSTERE_AXI_STATE_DIR ? ctx.stateDir : undefined };
  const warning = npxWarning(ctx.cli) ?? undefined;
  const target = unitFile(ctx);
  // The terminal rule comes first on every platform: `server install` configures what runs on
  // this machine, so it is the owner's decision everywhere, Windows included (design note,
  // Security). On Windows it changes nothing anyway, but the refusal is the same.
  if (!ctx.isTTY) {
    throw new Error(`server install needs the user at a terminal and changes nothing here. Ask the user to run \`${installCommand(o)}\` themselves.`);
  }
  if (!target) return manualSteps(spec, ctx, warning);
  const holder = await ctx.holder(ctx.stateDir);
  if (holder && !holder.supervised) {
    const where = holder.port ? `, port ${holder.port}` : "";
    const stop = holder.port && holder.port !== defaultPort(ctx.env) ? `AUSTERE_AXI_PORT=${holder.port} ${BIN} stop` : `${BIN} stop`;
    throw new Error(`a server not started by ${target.supervisor} (pid ${holder.pid}${where}) holds ${path.join(ctx.stateDir, "server.lock")}; run \`${stop}\` first, then \`${installCommand(o)}\` again`);
  }
  const ran: string[] = [];
  const notes: string[] = [];
  fs.mkdirSync(path.dirname(target.file), { recursive: true });
  if (target.supervisor === "systemd") {
    fs.writeFileSync(target.file, systemdUnit(spec), { mode: 0o644 });
    runChecked(ctx, ran, "systemctl", ["--user", "daemon-reload"]);
    runChecked(ctx, ran, "systemctl", ["--user", "enable", "--now", SYSTEMD_UNIT]);
    // enable --now leaves a running unit as it is; restart it so it runs what was just written.
    if (holder?.supervised === "systemd") runChecked(ctx, ran, "systemctl", ["--user", "restart", SYSTEMD_UNIT]);
    const user = ctx.env.USER || os.userInfo().username;
    const linger = ctx.run("loginctl", ["show-user", user, "--property=Linger", "--value"]);
    if (linger.code === 0 && linger.stdout.trim() === "no") {
      notes.push("systemd starts it when you log in. To start it at boot, before you log in, run `loginctl enable-linger` once.");
    }
  } else {
    if (ctx.uid == null) throw new Error("no user id to install the launchd agent for");
    fs.writeFileSync(target.file, launchdPlist(spec, path.join(ctx.stateDir, "server.log")), { mode: 0o644 });
    // Unload an earlier copy (it may not be loaded: ignore the answer), then load this one; RunAtLoad starts it.
    const domain = `gui/${ctx.uid}`;
    ctx.run("launchctl", ["bootout", `${domain}/${LAUNCHD_LABEL}`]);
    ran.push(`launchctl bootout ${domain}/${LAUNCHD_LABEL}`);
    runChecked(ctx, ran, "launchctl", ["bootstrap", domain, target.file]);
  }
  if (port !== defaultPort(ctx.env)) notes.push(`It listens on port ${port}: CLI commands find it with AUSTERE_AXI_PORT=${port}.`);
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

/** Stop the service and remove its unit. */
export function uninstallService(ctx: ServiceContext): Record<string, unknown> {
  const target = unitFile(ctx);
  if (!target) {
    return { status: "manual", platform: ctx.platform, steps: ctx.platform === "win32" ? ["schtasks /End /TN austere-axi", "schtasks /Delete /TN austere-axi /F"] : ["Remove the entry you added to your service manager."] };
  }
  if (!fs.existsSync(target.file)) return { status: "not installed", unit: target.file };
  const ran: string[] = [];
  if (target.supervisor === "systemd") {
    runChecked(ctx, ran, "systemctl", ["--user", "disable", "--now", SYSTEMD_UNIT]);
    fs.rmSync(target.file, { force: true });
    runChecked(ctx, ran, "systemctl", ["--user", "daemon-reload"]);
  } else {
    // Not loaded is fine: the file goes either way.
    ctx.run("launchctl", ["bootout", `gui/${ctx.uid ?? 0}/${LAUNCHD_LABEL}`]);
    ran.push(`launchctl bootout gui/${ctx.uid ?? 0}/${LAUNCHD_LABEL}`);
    fs.rmSync(target.file, { force: true });
  }
  return { status: "uninstalled", supervisor: target.supervisor, unit: target.file, ran };
}

/** The running server, as status reports it (client.ts ServerHealth, narrowed). */
export interface RunningServer {
  version: string;
  pid: number;
  port: number;
  supervised?: Supervisor;
}

/** Whether the unit is installed and running, and which server answers on `port`. */
export function serviceStatus(ctx: ServiceContext, server: RunningServer | null, version: string): Record<string, unknown> {
  const target = unitFile(ctx);
  const out: Record<string, unknown> = {};
  if (target) {
    const installed = fs.existsSync(target.file);
    Object.assign(out, { supervisor: target.supervisor, unit: target.file, installed });
    if (installed && target.supervisor === "systemd") {
      const word = (args: string[]): string => ctx.run("systemctl", ["--user", ...args, SYSTEMD_UNIT]).stdout.trim() || "unknown";
      Object.assign(out, { enabled: word(["is-enabled"]), active: word(["is-active"]) });
    } else if (installed) {
      const r = ctx.run("launchctl", ["print", `gui/${ctx.uid ?? 0}/${LAUNCHD_LABEL}`]);
      Object.assign(out, { loaded: r.code === 0, state: r.code === 0 ? /^\s*state = (.+)$/m.exec(r.stdout)?.[1]?.trim() : undefined });
    }
  } else {
    Object.assign(out, { platform: ctx.platform, installed: "unknown: no supported service manager here" });
  }
  out.server = server ? { version: server.version, pid: server.pid, port: server.port, supervised: server.supervised ?? "no" } : "not running";
  if (server?.supervised && server.version !== version) out.next = `The server runs v${server.version} and this CLI is v${version}. Restart it: ${restartCommand(server.supervised, ctx.uid)}`;
  else if (target && !out.installed) out.next = `${BIN} server install sets it up (at a terminal).`;
  return out;
}
