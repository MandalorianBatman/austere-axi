// The adapter registry and what each adapter can do on this machine: an adapter whose binary is
// not on PATH can do nothing, and says why. Nothing here spawns a process.
import fs from "node:fs";
import path from "node:path";
import { commandAdapter } from "./command.ts";
import { copilot } from "./copilot.ts";
import { omp } from "./omp.ts";
import type { AdaptersConfig } from "./config.ts";
import type { Adapter, Capabilities, Capability, HarnessId } from "./types.ts";

export const ADAPTERS: Record<HarnessId, Adapter> = { omp, copilot };

/** A harness adapter, or the `command` adapter of that name from adapters.json; null when there is none. */
export function adapterFor(name: string, cfg: AdaptersConfig): Adapter | null {
  if (name === "omp" || name === "copilot") return ADAPTERS[name];
  return Object.hasOwn(cfg.commands, name) ? commandAdapter(name, cfg.commands[name]) : null;
}

function isExecutable(file: string, windows: boolean): boolean {
  try {
    if (!fs.statSync(file).isFile()) return false;
    if (!windows) fs.accessSync(file, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Where `bin` would run from: a path with a separator is taken as is (relative to `cwd`), a bare
 * name is looked up in `PATH`. On Windows only names with a `PATHEXT` extension count: npm puts
 * an extensionless sh script beside each `.cmd` shim, which Windows cannot run. Null when not found.
 */
export function findOnPath(bin: string, env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform, cwd = process.cwd()): string | null {
  const windows = platform === "win32";
  const p = windows ? path.win32 : path.posix;
  // Windows environments name it Path; look the variable up without regard to case there.
  const get = (name: string) => (windows ? Object.entries(env).find(([k]) => k.toUpperCase() === name)?.[1] : env[name]);
  let exts = [""];
  if (windows) {
    const pathext = (get("PATHEXT") || ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean);
    // A name that already has one (`omp.cmd`) is taken as written.
    exts = pathext.some((e) => bin.toLowerCase().endsWith(e.toLowerCase())) ? [""] : pathext;
  }
  const bases = bin.includes("/") || (windows && bin.includes("\\")) ? [p.resolve(cwd, bin)] : (get("PATH") || "").split(windows ? ";" : ":").filter(Boolean).map((dir) => p.join(dir, bin));
  for (const base of bases) {
    const hit = exts.map((e) => base + e).find((f) => isExecutable(f, windows));
    if (hit) return hit;
  }
  return null;
}

// cmd.exe's metacharacters, and the space (it ends a word); a caret before one makes it literal.
const CMD_META = /([()\][%!^"`<>&|;, *?])/g;

/**
 * One argument for a batch file run by `cmd.exe /d /s /c "…"`: quoted for the program's argv
 * parser (backslashes before a quote and at the end doubled, quotes escaped), then every cmd.exe
 * metacharacter, the quotes included, caret-escaped so cmd passes it on literally.
 */
export function cmdQuoteArg(arg: string): string {
  const quoted = `"${arg.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\*)$/, "$1$1")}"`;
  return quoted.replace(CMD_META, "^$1");
}

/** What to spawn for `bin` and `args`, and whether Node must pass the arguments verbatim. */
export interface SpawnSpec {
  file: string;
  args: string[];
  windowsVerbatimArguments: boolean;
}

/**
 * How to spawn `bin`: as is, except a `.cmd` or `.bat` on Windows (an npm shim), which Node
 * refuses to spawn without a shell. That goes through `cmd.exe /d /s /c` with a command line
 * quoted by `cmdQuoteArg`; stdin (the prompt) passes through cmd.exe to the batch file.
 */
export function spawnSpec(bin: string, args: readonly string[], platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env): SpawnSpec {
  if (platform !== "win32" || !/\.(cmd|bat)$/i.test(bin)) return { file: bin, args: [...args], windowsVerbatimArguments: false };
  const comspec = Object.entries(env).find(([k]) => k.toUpperCase() === "COMSPEC")?.[1] || "cmd.exe";
  // The batch file's own path is caret-escaped, not quoted.
  const line = [bin.replace(CMD_META, "^$1"), ...args.map(cmdQuoteArg)].join(" ");
  return { file: comspec, args: ["/d", "/s", "/c", `"${line}"`], windowsVerbatimArguments: true };
}

/** The adapter's capabilities here: all off, naming the binary, when it is not on PATH. */
export function capabilitiesOf(adapter: Adapter, env: NodeJS.ProcessEnv = process.env): Capabilities {
  if (findOnPath(adapter.bin, env)) return adapter.capabilities;
  const missing: Capability = { ok: false, reason: `${adapter.bin} not found on PATH` };
  return { same: missing, fork: missing, new: missing, model: missing, maxCost: missing };
}
