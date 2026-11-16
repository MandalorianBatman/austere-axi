// Adapter registry (RLM-344): the built-in harness adapters, `command` adapters from adapters.json, caller
// detection from the environment (RLM-343) and whether a harness's binary is on PATH. A missing binary
// makes the adapter's capabilities `unavailable` with the reason; it never throws.
import fs from "node:fs";
import path from "node:path";
import { commandAdapter, COMMAND_PREFIX } from "./command.ts";
import { copilot } from "./copilot.ts";
import { omp } from "./omp.ts";
import { AdapterError } from "./types.ts";
import type { AdaptersConfig } from "./config.ts";
import type { Adapter, AdapterHarness, CallerSession, Capabilities, Capability, Env, HarnessId } from "./types.ts";

export const BUILTIN_ADAPTERS: Readonly<Record<AdapterHarness, Adapter>> = { omp, copilot };
export const HARNESS_IDS: readonly HarnessId[] = ["omp", "copilot", "dsh"];

/** A built-in adapter, or `command:<name>` from the config; null when unknown. */
export function getAdapter(id: string, config?: AdaptersConfig): Adapter | null {
  if (id === "omp" || id === "copilot") return BUILTIN_ADAPTERS[id];
  if (id.startsWith(COMMAND_PREFIX) && config) {
    const name = id.slice(COMMAND_PREFIX.length);
    const spec = Object.hasOwn(config.commands, name) ? config.commands[name] : undefined;
    if (spec) return commandAdapter(name, spec);
  }
  return null;
}

/** Every adapter: the built-ins, then the config's `command` adapters. */
export function listAdapters(config?: AdaptersConfig): Adapter[] {
  const list: Adapter[] = [omp, copilot];
  if (config) for (const [name, spec] of Object.entries(config.commands)) list.push(commandAdapter(name, spec));
  return list;
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

export function binaryAvailable(bin: string, env: Env = process.env, platform: NodeJS.Platform = process.platform): boolean {
  return findBinary(bin, env, platform) !== null;
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

/**
 * The caller's harness session. `override` is the value of `--session <harness>:<id>` and wins; otherwise
 * the environment: omp (`PI_SESSION_ID`, `PI_SESSION_FILE`), Copilot CLI (`COPILOT_AGENT_SESSION_ID`),
 * dsh (`DSH_SESSION_ID`), in that order. Null when none is set.
 */
export function detectCaller(env: Env, override?: string): CallerSession | null {
  if (override !== undefined) return parseSessionOverride(override);
  // dsh is detected only; it has no adapter (RLM-347 is parked).
  const dsh: CallerSession | null = env.DSH_SESSION_ID ? { harness: "dsh", sessionId: env.DSH_SESSION_ID } : null;
  return omp.detect(env) ?? copilot.detect(env) ?? dsh;
}

/** `<harness>:<id>` → the session; throws AdapterError("bad_input") on anything else. */
export function parseSessionOverride(value: string): CallerSession {
  const colon = value.indexOf(":");
  const harness = colon < 0 ? "" : value.slice(0, colon);
  const sessionId = colon < 0 ? "" : value.slice(colon + 1);
  if (!(HARNESS_IDS as readonly string[]).includes(harness) || !sessionId || /[\s\x00-\x1f]/.test(sessionId)) {
    throw new AdapterError("bad_input", `--session takes <harness>:<id>, harness one of ${HARNESS_IDS.join(", ")}; got ${JSON.stringify(value)}`);
  }
  return { harness: harness as HarnessId, sessionId };
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
