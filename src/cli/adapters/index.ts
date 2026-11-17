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
 * name is looked up in `PATH`, trying each `PATHEXT` extension on Windows. Null when not found.
 */
export function findOnPath(bin: string, env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform, cwd = process.cwd()): string | null {
  const windows = platform === "win32";
  const p = windows ? path.win32 : path.posix;
  // Windows environments name it Path; look the variable up without regard to case there.
  const get = (name: string) => (windows ? Object.entries(env).find(([k]) => k.toUpperCase() === name)?.[1] : env[name]);
  const exts = windows ? ["", ...(get("PATHEXT") || ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean)] : [""];
  const bases = bin.includes("/") || (windows && bin.includes("\\")) ? [p.resolve(cwd, bin)] : (get("PATH") || "").split(windows ? ";" : ":").filter(Boolean).map((dir) => p.join(dir, bin));
  for (const base of bases) {
    const hit = exts.map((e) => base + e).find((f) => isExecutable(f, windows));
    if (hit) return hit;
  }
  return null;
}

/** The adapter's capabilities here: all off, naming the binary, when it is not on PATH. */
export function capabilitiesOf(adapter: Adapter, env: NodeJS.ProcessEnv = process.env): Capabilities {
  if (findOnPath(adapter.bin, env)) return adapter.capabilities;
  const missing: Capability = { ok: false, reason: `${adapter.bin} not found on PATH` };
  return { same: missing, fork: missing, new: missing, model: missing, maxCost: missing };
}
