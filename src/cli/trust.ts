// The user's trust list, <state>/trusted.json: registry packs an agent may
// install without --trust. An entry pins one exact version and the integrity
// of its pack.js, or names a whole npm scope (a company registry). Only this
// user-level file is read, never one in a project: a cloned repo must not
// grant itself trust. `trust add` refuses without a terminal, which stops an
// agent acting on a search hit by accident, not an agent set on editing the file.
import fs from "node:fs";
import path from "node:path";
import { isFirstParty } from "./packs.ts";
import { stateDir } from "./paths.ts";
import { isValidPackName, isValidVersion } from "../shared/packs-meta.ts";

export interface TrustPin {
  version: string;
  /** sha384 of dist/pack.js, as an install records it. */
  integrity: string;
}

export interface TrustList {
  pins: Record<string, TrustPin>;
  /** npm scopes, "@acme": every pack under one is trusted. */
  scopes: string[];
}

const FORMAT = 1;
const SCOPE_RE = /^@[a-z0-9][a-z0-9._-]*$/;
const INTEGRITY_RE = /^sha384-[A-Za-z0-9+/]+={0,2}$/;

export function trustFile(): string {
  return path.join(stateDir(), "trusted.json");
}

export function isScope(s: string): boolean {
  return SCOPE_RE.test(s);
}

function scopeOf(name: string): string | null {
  return name.startsWith("@") ? name.slice(0, name.indexOf("/")) : null;
}

/** The trust list; empty when the file does not exist. A malformed file throws, naming it. */
export function readTrustList(): TrustList {
  const file = trustFile();
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { pins: {}, scopes: [] };
    throw err;
  }
  const bad = (why: string) => new Error(`${file} is malformed (${why}); fix or delete it`);
  let data: { format?: unknown; pins?: unknown; scopes?: unknown };
  try {
    data = JSON.parse(raw);
  } catch {
    throw bad("not JSON");
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) throw bad("not an object");
  if (data.format !== FORMAT) throw bad(`format ${JSON.stringify(data.format)}; this austere-axi reads ${FORMAT}`);
  const { pins = {}, scopes = [] } = data;
  if (!pins || typeof pins !== "object" || Array.isArray(pins)) throw bad("pins is not an object");
  const list: TrustList = { pins: {}, scopes: [] };
  for (const [name, pin] of Object.entries(pins)) {
    const { version, integrity } = (pin || {}) as { version?: unknown; integrity?: unknown };
    if (!isValidPackName(name) || typeof version !== "string" || !isValidVersion(version) || typeof integrity !== "string" || !INTEGRITY_RE.test(integrity)) {
      throw bad(`pin ${JSON.stringify(name)} needs a version x.y.z and a sha384 integrity`);
    }
    list.pins[name] = { version, integrity };
  }
  if (!Array.isArray(scopes)) throw bad("scopes is not a list");
  for (const s of scopes) {
    if (typeof s !== "string" || !isScope(s)) throw bad(`scope ${JSON.stringify(s)} is not an npm scope like "@acme"`);
    list.scopes.push(s);
  }
  return list;
}

export function writeTrustList(list: TrustList): void {
  const file = trustFile();
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ format: FORMAT, ...list }, null, 2) + "\n");
  fs.renameSync(tmp, file);
}

/** Whether the list could trust some version of this pack (checked before fetching it). */
export function mayTrust(list: TrustList, name: string): boolean {
  return Object.hasOwn(list.pins, name) || list.scopes.includes(scopeOf(name) ?? "");
}

/**
 * Why an agent may install this registry pack without --trust, or null:
 * first-party, or on the list (its scope, or a pin of exactly this version and pack.js).
 */
export function trustOf(list: TrustList, pack: { name: string; version: string; integrity: string }): "first-party" | "trust-list" | null {
  if (isFirstParty(pack.name)) return "first-party";
  if (list.scopes.includes(scopeOf(pack.name) ?? "")) return "trust-list";
  const pin = Object.hasOwn(list.pins, pack.name) ? list.pins[pack.name] : undefined;
  return pin && pin.version === pack.version && pin.integrity === pack.integrity ? "trust-list" : null;
}
