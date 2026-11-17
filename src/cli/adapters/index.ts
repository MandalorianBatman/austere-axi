// Adapter registry (RLM-344): the built-in harness adapters, `command` adapters from adapters.json, and
// whether an adapter's binary is on PATH. A missing binary makes the adapter's capabilities `unavailable`
// with the reason; it never throws.
import fs from "node:fs";
import path from "node:path";
import { commandAdapter, COMMAND_PREFIX } from "./command.ts";
import { readAdaptersConfig } from "./config.ts";
import { copilot } from "./copilot.ts";
import { omp } from "./omp.ts";
import type { AdaptersConfig } from "./config.ts";
import type { Adapter, AdapterHarness, Capabilities, Capability, Env } from "./types.ts";

export const BUILTIN_ADAPTERS: Readonly<Record<AdapterHarness, Adapter>> = { omp, copilot };

/** A built-in adapter, or `command:<name>` from <state>/adapters.json; null when unknown. */
export function getAdapter(id: string, config?: AdaptersConfig): Adapter | null {
  if (id === "omp" || id === "copilot") return BUILTIN_ADAPTERS[id];
  if (!id.startsWith(COMMAND_PREFIX)) return null;
  const commands = (config ?? readAdaptersConfig()).commands;
  const name = id.slice(COMMAND_PREFIX.length);
  return Object.hasOwn(commands, name) ? commandAdapter(name, commands[name]) : null;
}

/** Every adapter: the built-ins, then the `command` adapters of <state>/adapters.json. */
export function listAdapters(config?: AdaptersConfig): Adapter[] {
  const commands = Object.entries((config ?? readAdaptersConfig()).commands);
  return [omp, copilot, ...commands.map(([name, spec]) => commandAdapter(name, spec))];
}

/** The adapter's capabilities here: each supported one is `unavailable` when its binary is not on PATH. */
export function capabilitiesFor(adapter: Adapter, env: Env = process.env, platform: NodeJS.Platform = process.platform): Capabilities {
  if (findBinary(adapter.bin, env, platform)) return { ...adapter.capabilities };
  const missing: Capability = { unavailable: `${adapter.bin} is not on PATH` };
  const caps = { ...adapter.capabilities };
  for (const key of Object.keys(caps) as (keyof Capabilities)[]) {
    if (caps[key] === true) caps[key] = missing;
  }
  return caps;
}

/**
 * The executable `bin` resolves to, searching PATH with the file system only (nothing is spawned); null
 * when there is none. A name with a path separator is checked as given. On Windows each PATHEXT extension
 * is tried.
 */
export function findBinary(bin: string, env: Env = process.env, platform: NodeJS.Platform = process.platform): string | null {
  if (!bin) return null;
  const windows = platform === "win32";
  const exts = windows ? windowsExtensions(env, bin) : [""];
  const hasSeparator = bin.includes("/") || (windows && bin.includes("\\"));
  const dirs = hasSeparator ? [""] : (envValue(env, "PATH", windows) ?? "").split(windows ? ";" : ":").filter(Boolean);
  for (const dir of dirs) {
    const base = dir ? path.join(windows ? dir.replace(/^"(.*)"$/, "$1") : dir, bin) : bin;
    for (const ext of exts) {
      const candidate = base + ext;
      if (isExecutable(candidate, windows)) return candidate;
    }
  }
  return null;
}

function windowsExtensions(env: Env, bin: string): string[] {
  const list = (envValue(env, "PATHEXT", true) || ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean);
  const lower = bin.toLowerCase();
  // A name that already ends in an executable extension is tried as given first.
  return list.some((ext) => lower.endsWith(ext.toLowerCase())) ? ["", ...list] : list;
}

/** Windows environment names are case-insensitive. */
function envValue(env: Env, name: string, windows: boolean): string | undefined {
  if (!windows) return env[name];
  for (const key of Object.keys(env)) if (key.toUpperCase() === name) return env[key];
  return undefined;
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

export { commandAdapter, COMMAND_PREFIX } from "./command.ts";
export type { CommandSpec } from "./command.ts";
export { copilot, COPILOT_DEFAULT_MODEL, COPILOT_FORK_UNAVAILABLE } from "./copilot.ts";
export { omp } from "./omp.ts";
export { AdapterError, requireMode } from "./types.ts";
export type * from "./types.ts";
export {
  ADAPTER_HARNESSES,
  adaptersFile,
  extraArgsFor,
  isAdapterHarness,
  readAdaptersConfig,
  setCommand,
  setExtraArgs,
  splitArgs,
  writeAdaptersConfig,
} from "./config.ts";
export type { AdaptersConfig, HarnessConfig, TerminalCheck } from "./config.ts";
