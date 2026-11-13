// The user's trust list, <state>/trusted.json: registry packs an agent may
// install without --trust. An entry pins one exact version and the integrity
// of its pack.js, or names a whole npm scope (a company registry) on the
// registry it was added from: the same scope on another registry is someone
// else's. Only this user-level file is read, never one in a project: a cloned
// repo must not grant itself trust. `trust add` refuses without a terminal,
// which stops an agent acting on a search hit by accident, not an agent set on
// editing the file.
import fs from "node:fs";
import path from "node:path";
import { isFirstParty, writeJsonAtomic } from "./packs.ts";
import { stateDir } from "./paths.ts";
import { isValidPackName, isValidVersion } from "../shared/packs-meta.ts";

export interface TrustPin {
  version: string;
  /** sha384 of dist/pack.js, as an install records it. */
  integrity: string;
}

/** An npm scope, "@acme": every pack under it is trusted, on this registry only. */
export interface TrustScope {
  scope: string;
  /** registryUrl() when the user added the scope. */
  registry: string;
}

export interface TrustList {
  pins: Record<string, TrustPin>;
  scopes: TrustScope[];
}

const FORMAT = 2;
const SCOPE_RE = /^@[a-z0-9][a-z0-9._-]*$/;
const INTEGRITY_RE = /^sha384-[A-Za-z0-9+/]+={0,2}$/;
const REGISTRY_RE = /^https?:\/\/\S+\/$/;

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
  const bad = (why: string) => new Error(`${file} is malformed (${why}); ask the user to fix or delete it`);
  let data: { format?: unknown; pins?: unknown; scopes?: unknown };
  try {
    data = JSON.parse(raw);
  } catch {
    throw bad("not JSON");
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) throw bad("not an object");
  if (data.format === 1) throw bad("format 1 does not record which registry a scope was trusted on; delete it and add the entries again with `trust add`");
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
    const { scope, registry } = (s || {}) as { scope?: unknown; registry?: unknown };
    if (typeof scope !== "string" || !isScope(scope) || typeof registry !== "string" || !REGISTRY_RE.test(registry)) {
      throw bad(`scope ${JSON.stringify(s)} needs an npm scope like "@acme" and the registry URL it was trusted on`);
    }
    list.scopes.push({ scope, registry });
  }
  return list;
}

/**
 * Read the list, change it and write it back in one step, so a change another
 * process made since an earlier read (say, before a prompt) is kept. Writes
 * only when `change` returns true; returns what it returned.
 */
export function updateTrustList(change: (list: TrustList) => boolean): boolean {
  const list = readTrustList();
  if (!change(list)) return false;
  writeJsonAtomic(trustFile(), { format: FORMAT, ...list });
  return true;
}

/** Whether the list trusts every pack in this pack's scope on `registry`. */
function scopeTrusted(list: TrustList, name: string, registry: string): boolean {
  const scope = scopeOf(name);
  return list.scopes.some((s) => s.scope === scope && s.registry === registry);
}

/** Whether the list could trust some version of this pack from `registry` (checked before fetching it). */
export function mayTrust(list: TrustList, name: string, registry: string): boolean {
  return Object.hasOwn(list.pins, name) || scopeTrusted(list, name, registry);
}

/**
 * Why an agent may install this pack from `registry` without --trust, or null:
 * first-party, or on the list (its scope on that registry, or a pin of exactly this version and pack.js).
 */
export function trustOf(list: TrustList, pack: { name: string; version: string; integrity: string }, registry: string): "first-party" | "trust-list" | null {
  if (isFirstParty(pack.name)) return "first-party";
  if (scopeTrusted(list, pack.name, registry)) return "trust-list";
  const pin = Object.hasOwn(list.pins, pack.name) ? list.pins[pack.name] : undefined;
  return pin && pin.version === pack.version && pin.integrity === pack.integrity ? "trust-list" : null;
}
