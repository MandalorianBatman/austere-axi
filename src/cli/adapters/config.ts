// <state>/adapters.json (RLM-344): the owner's extra arguments per harness (the permission grant, A13) and
// `command` adapters. Only this file in the state dir is read, never one in a project or a page: a cloned
// repo must not grant an agent permissions or a command to run. Changes need the user at a terminal, as
// `trust add` does; that stops an agent acting on a page's text by accident, not an agent set on editing
// the file.
import fs from "node:fs";
import path from "node:path";
import { stateDir } from "../paths.ts";
import { AdapterError } from "./types.ts";
import type { AdapterHarness } from "./types.ts";
import { COMMAND_PREFIX } from "./command.ts";
import type { CommandSpec } from "./command.ts";

const BIN = "austere-axi";
export const ADAPTER_HARNESSES: readonly AdapterHarness[] = ["omp", "copilot"];
const COMMAND_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export interface HarnessConfig {
  extraArgs: string[];
}

export interface AdaptersConfig {
  omp?: HarnessConfig;
  copilot?: HarnessConfig;
  commands: Record<string, CommandSpec>;
}

export interface TerminalCheck {
  /** `process.stdin.isTTY` of the command making the change. */
  isTTY: boolean | undefined;
}

export function adaptersFile(): string {
  return path.join(stateDir(), "adapters.json");
}

export function isAdapterHarness(s: string): s is AdapterHarness {
  return (ADAPTER_HARNESSES as readonly string[]).includes(s);
}

export function isCommandName(s: string): boolean {
  return COMMAND_NAME_RE.test(s);
}

/** The config; empty when the file does not exist. A malformed file throws AdapterError("bad_config"), naming it. */
export function readAdaptersConfig(): AdaptersConfig {
  const file = adaptersFile();
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { commands: {} };
    throw err;
  }
  const bad = (why: string) => new AdapterError("bad_config", `${file} is malformed (${why}); ask the user to fix or delete it`);
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    throw bad("not JSON");
  }
  if (!isObject(data)) throw bad("not an object");
  const config: AdaptersConfig = { commands: {} };
  for (const harness of ADAPTER_HARNESSES) {
    const entry = data[harness];
    if (entry === undefined) continue;
    if (!isObject(entry) || !isStringList(entry.extraArgs)) throw bad(`${harness}.extraArgs is not a list of strings`);
    config[harness] = { extraArgs: [...entry.extraArgs] };
  }
  const commands = data.commands ?? {};
  if (!isObject(commands)) throw bad("commands is not an object");
  for (const [name, spec] of Object.entries(commands)) {
    if (!isCommandName(name) || !isObject(spec) || typeof spec.bin !== "string" || !spec.bin || !isStringList(spec.args)) {
      throw bad(`command ${JSON.stringify(name)} needs a name, a bin and a list of string args`);
    }
    config.commands[name] = { bin: spec.bin, args: [...spec.args] };
  }
  return config;
}

/** Writes the config atomically, mode 0600. */
export function writeAdaptersConfig(config: AdaptersConfig): void {
  const file = adaptersFile();
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(config, null, 2) + "\n", { mode: 0o600 });
  if (process.platform !== "win32") fs.chmodSync(tmp, 0o600);
  fs.renameSync(tmp, file);
}

/** The owner's extra arguments for a harness; none when unset. */
export function extraArgsFor(config: AdaptersConfig, harness: AdapterHarness): string[] {
  return config[harness]?.extraArgs ?? [];
}

/**
 * `adapter set <harness> --extra-args "…"`: split the string (no shell) and store it. An empty string
 * clears the grant. Refuses without a terminal and changes nothing.
 */
export function setExtraArgs(harness: string, argString: string, terminal: TerminalCheck): AdaptersConfig {
  if (!isAdapterHarness(harness)) {
    throw new AdapterError("bad_input", `unknown harness ${JSON.stringify(harness)}; one of: ${ADAPTER_HARNESSES.join(", ")}`);
  }
  if (!terminal.isTTY) {
    throw new AdapterError(
      "no_tty",
      `adapter set needs the user at a terminal and changes nothing here. Ask the user to run \`${BIN} adapter set ${harness} --extra-args "…"\` themselves.`,
    );
  }
  const extraArgs = splitArgs(argString);
  const config = readAdaptersConfig();
  config[harness] = { extraArgs };
  writeAdaptersConfig(config);
  return config;
}

/**
 * `adapter set command:<name> --run "<bin> <args…>"`: split the string (no shell) and store the binary and
 * its arguments. An empty string removes the command. Refuses without a terminal and changes nothing.
 */
export function setCommand(name: string, runString: string, terminal: TerminalCheck): AdaptersConfig {
  if (!isCommandName(name)) throw new AdapterError("bad_input", `command name ${JSON.stringify(name)}: use letters, digits, ".", "_" or "-"`);
  const [bin, ...args] = splitArgs(runString);
  if (bin === "") throw new AdapterError("bad_input", `command ${name} needs a binary`);
  if (!terminal.isTTY) {
    throw new AdapterError(
      "no_tty",
      `adapter set needs the user at a terminal and changes nothing here. Ask the user to run \`${BIN} adapter set ${COMMAND_PREFIX}${name} --run "…"\` themselves.`,
    );
  }
  const config = readAdaptersConfig();
  if (bin === undefined) delete config.commands[name];
  else config.commands[name] = { bin, args };
  writeAdaptersConfig(config);
  return config;
}

/**
 * Splits an argument string the way a POSIX shell splits words, without running one: whitespace separates,
 * '…' is literal, "…" keeps \" \\ \$ \` escapes, a backslash outside quotes escapes the next character.
 * No expansion of variables, globs or `~`. An unterminated quote throws AdapterError("bad_input").
 */
export function splitArgs(input: string): string[] {
  const args: string[] = [];
  let current = "";
  let inWord = false;
  let i = 0;
  while (i < input.length) {
    const c = input[i];
    if (c === " " || c === "\t" || c === "\n" || c === "\r") {
      if (inWord) args.push(current);
      current = "";
      inWord = false;
      i++;
      continue;
    }
    inWord = true;
    if (c === "'") {
      const end = input.indexOf("'", i + 1);
      if (end < 0) throw new AdapterError("bad_input", `unterminated ' in ${JSON.stringify(input)}`);
      current += input.slice(i + 1, end);
      i = end + 1;
    } else if (c === '"') {
      i++;
      for (;;) {
        if (i >= input.length) throw new AdapterError("bad_input", `unterminated " in ${JSON.stringify(input)}`);
        const d = input[i];
        if (d === '"') break;
        if (d === "\\" && i + 1 < input.length && '"\\$`'.includes(input[i + 1])) {
          current += input[i + 1];
          i += 2;
        } else {
          current += d;
          i++;
        }
      }
      i++;
    } else if (c === "\\") {
      if (i + 1 < input.length) current += input[i + 1];
      i += 2;
    } else {
      current += c;
      i++;
    }
  }
  if (inWord) args.push(current);
  return args;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function isStringList(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((v) => typeof v === "string");
}
