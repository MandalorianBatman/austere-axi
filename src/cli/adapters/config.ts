// <state>/adapters.json: the owner's extra arguments per harness and the `command` adapters.
// Only this file in the state dir is read, never one in a project or a page, and only
// `adapter set` at a terminal writes it (docs/review-loop-v2.md "Security"). The extra arguments
// are where the owner grants a harness the right to write (A13).
import fs from "node:fs";
import path from "node:path";
import { stateDir } from "../paths.ts";
import type { AdapterKind, HarnessId } from "./types.ts";

/** A `command` adapter: a fixed binary and arguments, the prompt on stdin. */
export interface CommandSpec {
  bin: string;
  args: string[];
}

export interface AdaptersConfig {
  /** The owner's `--extra-args`, by harness. */
  extraArgs: Partial<Record<HarnessId, string[]>>;
  /** `command` adapters, by name. */
  commands: Record<string, CommandSpec>;
}

export const HARNESSES: readonly HarnessId[] = ["omp", "copilot"];

export const isHarness = (v: string): v is HarnessId => (HARNESSES as readonly string[]).includes(v);

/**
 * Arguments every run of a harness gets before the owner's own. All empty: no adapter adds a
 * permission-bypass flag by default (A13); the owner grants it with `adapter set`. Reversing A13
 * (always passing `--approval-mode yolo` / `--allow-all`) is a change to this one constant.
 */
export const DEFAULT_EXTRA_ARGS: Record<HarnessId, string[]> = { omp: [], copilot: [] };

/** The owner's extra arguments that grant a harness's runs the right to write (A13): what `attach status` and the attach popover tell the user to set. */
export const GRANT_ARGS: Record<HarnessId, string> = { omp: "--approval-mode yolo", copilot: "--allow-all" };

/** The terminal command that grants `harness` the right to write. */
export function grantCommand(harness: HarnessId): string {
  return `austere-axi adapter set ${harness} --extra-args "${GRANT_ARGS[harness]}"`;
}

const FORMAT = 1;
/** A command adapter's name: also how attach settings will name it. */
const COMMAND_NAME = /^[a-z][a-z0-9-]{0,31}$/;

export const isCommandName = (v: string): boolean => COMMAND_NAME.test(v) && !isHarness(v);

export function adaptersFile(): string {
  return path.join(stateDir(), "adapters.json");
}

const empty = (): AdaptersConfig => ({ extraArgs: {}, commands: {} });

const isStrings = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === "string");

/** The owner's adapter settings; empty when the file does not exist. A malformed file throws, naming it. */
export function readAdapters(): AdaptersConfig {
  const file = adaptersFile();
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return empty();
    throw err;
  }
  const bad = (why: string) => new Error(`${file} is malformed (${why}); ask the user to fix it or set it again with \`austere-axi adapter set\``);
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    throw bad("not JSON");
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) throw bad("not an object");
  const d = data as { format?: unknown; extraArgs?: unknown; commands?: unknown };
  if (d.format !== FORMAT) throw bad(`format ${JSON.stringify(d.format)}; this austere-axi reads ${FORMAT}`);
  const cfg = empty();
  if (d.extraArgs !== undefined) {
    if (!d.extraArgs || typeof d.extraArgs !== "object" || Array.isArray(d.extraArgs)) throw bad("extraArgs is not an object");
    for (const [h, args] of Object.entries(d.extraArgs)) {
      if (!isHarness(h)) throw bad(`extraArgs names an unknown harness ${JSON.stringify(h)}`);
      if (!isStrings(args)) throw bad(`extraArgs.${h} is not a list of strings`);
      cfg.extraArgs[h] = args;
    }
  }
  if (d.commands !== undefined) {
    if (!d.commands || typeof d.commands !== "object" || Array.isArray(d.commands)) throw bad("commands is not an object");
    for (const [name, spec] of Object.entries(d.commands)) {
      if (!isCommandName(name)) throw bad(`command name ${JSON.stringify(name)}`);
      const s = spec as { bin?: unknown; args?: unknown } | null;
      if (!s || typeof s.bin !== "string" || !s.bin || !isStrings(s.args)) throw bad(`commands.${name} needs bin (a string) and args (a list of strings)`);
      cfg.commands[name] = { bin: s.bin, args: s.args };
    }
  }
  return cfg;
}

/** Write adapters.json: mode 0600, a temp file renamed over it. */
export function writeAdapters(cfg: AdaptersConfig): void {
  const file = adaptersFile();
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ format: FORMAT, extraArgs: cfg.extraArgs, commands: cfg.commands }, null, 2) + "\n", { mode: 0o600 });
  fs.renameSync(tmp, file);
}

/** The arguments a harness's runs get after its own: DEFAULT_EXTRA_ARGS, then the owner's. */
export function extraArgsFor(harness: HarnessId, cfg: AdaptersConfig): string[] {
  return [...DEFAULT_EXTRA_ARGS[harness], ...(cfg.extraArgs[harness] ?? [])];
}

/**
 * Whether the adapter's runs may write (run `austere-axi patch`, edit files): omp with
 * `--approval-mode yolo`, Copilot with `--allow-all` or `--allow-tool`, and any `command`
 * adapter (its arguments are the owner's own). Without it, both harnesses deny writing
 * commands and still exit 0 (A13); `attach status` warns.
 */
export function hasWriteGrant(harness: AdapterKind, cfg: AdaptersConfig): boolean {
  if (harness === "command") return true;
  const args = extraArgsFor(harness, cfg);
  if (harness === "omp") return args.some((a, i) => a === "--approval-mode=yolo" || (a === "--approval-mode" && args[i + 1] === "yolo"));
  return args.some((a) => a === "--allow-all" || a === "--allow-tool" || a.startsWith("--allow-tool="));
}

/**
 * Split a command line into words the way a POSIX shell does, with no expansion: whitespace
 * separates, '…' is literal, "…" keeps \" \\ \$ \` escapes, a backslash outside quotes escapes the
 * next character. Throws on an unterminated quote or a trailing backslash.
 */
export function shellWords(line: string): string[] {
  const words: string[] = [];
  let word = "";
  let inWord = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === "'") {
      const end = line.indexOf("'", i + 1);
      if (end < 0) throw new Error("unterminated ' quote");
      word += line.slice(i + 1, end);
      inWord = true;
      i = end;
    } else if (c === '"') {
      inWord = true;
      let closed = false;
      for (i++; i < line.length; i++) {
        const d = line[i];
        if (d === '"') {
          closed = true;
          break;
        }
        if (d === "\\" && i + 1 < line.length && '"\\$`'.includes(line[i + 1])) word += line[++i];
        else word += d;
      }
      if (!closed) throw new Error('unterminated " quote');
    } else if (c === "\\") {
      if (i + 1 >= line.length) throw new Error("trailing backslash");
      word += line[++i];
      inWord = true;
    } else if (/\s/.test(c)) {
      if (inWord) words.push(word);
      word = "";
      inWord = false;
    } else {
      word += c;
      inWord = true;
    }
  }
  if (inWord) words.push(word);
  return words;
}

/** Words back into one line a shell splits the same way: single-quoted where needed. */
export function shellJoin(words: readonly string[]): string {
  return words.map((w) => (/^[A-Za-z0-9_./:=@%+,-]+$/.test(w) ? w : `'${w.replace(/'/g, `'\\''`)}'`)).join(" ");
}
