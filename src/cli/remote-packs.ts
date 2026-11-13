// Packs on npm registries that are not installed here, for `components
// search|show`: the default registry and each scope's mapped one
// (registries.ts). A pack is found by its package.json keyword
// "austere-axi-pack". Its catalog comes from its tarball, checked like an
// install; nothing from the pack runs. Cached under <state>/npm-packs/<registry>/:
// the pack list for an hour (a failed list fetch for 5 minutes), and each pack
// by name@version for good once it is read or fails for good (published
// versions do not change).
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { PackCatalog } from "../../types/catalog.d.ts";
import { fetchBuffer, readRegistryPack } from "./install.ts";
import type { InstallError } from "./install.ts";
import { installedPacks, packDirName } from "./packs.ts";
import { readTrustList, trustFile, trustOf } from "./trust.ts";
import type { TrustList } from "./trust.ts";
import { defaultRegistry, readRegistries, registriesFile, registryFor } from "./registries.ts";
import type { Registries, Registry } from "./registries.ts";
import { stateDir } from "./paths.ts";
import { isValidPackName, isValidVersion } from "../shared/packs-meta.ts";

export interface RemotePack {
  name: string;
  version: string;
  /** sha384 of dist/pack.js, as an install records it. */
  integrity: string;
  /** "trusted": on the user's trust list (trust.ts). */
  trust: "first-party" | "trusted" | "third-party";
  catalog: PackCatalog;
  /** The registry it comes from, as routed for its name. */
  registry: Registry;
}

/** Packs found, and one line on what was not searched, if anything was not. */
export interface RemotePacks {
  packs: RemotePack[];
  note?: string;
}

interface Listed {
  name: string;
  version: string;
}

/** The pack list as cached: what the registry listed (`total` counts packs past the page), or why it could not be fetched. */
type PackList = { at: number; packs: Listed[]; total: number } | { at: number; error: string };

/** The pack as the registry has it; trust is the reader's and the registry is the cache's, so neither is cached. */
type ReadPack = Omit<RemotePack, "trust" | "registry">;

/** One pack version as cached: its catalog, or why it fails the install checks for good. */
type PackRead = ReadPack | (Listed & { error: string });

const KEYWORD = "austere-axi-pack";
const LIST_SIZE = 250;
const LIST_TTL_MS = 60 * 60_000;
const LIST_FAILED_TTL_MS = 5 * 60_000;
const BUDGET_MS = 4000;
const PARALLEL_FETCHES = 4;

function cacheDir(registry: Registry): string {
  return path.join(stateDir(), "npm-packs", crypto.createHash("sha256").update(registry.url).digest("hex").slice(0, 12));
}

function readCache<T>(file: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

/** Best effort: a cache that cannot be written only means the next search fetches again. */
function writeCache(file: string, value: unknown): void {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(value));
    fs.renameSync(tmp, file);
  } catch {}
}

async function listPacks(registry: Registry, signal: AbortSignal, reason: (err: unknown) => string): Promise<PackList> {
  const file = path.join(cacheDir(registry), "list.json");
  const cached = readCache<PackList>(file);
  if (cached && Date.now() - cached.at < ("error" in cached ? LIST_FAILED_TTL_MS : LIST_TTL_MS)) return cached;
  let list: PackList;
  try {
    const url = `${registry.url}-/v1/search?text=keywords:${KEYWORD}&size=${LIST_SIZE}`;
    const body: { total?: unknown; objects?: { package?: { name?: unknown; version?: unknown } }[] } = JSON.parse((await fetchBuffer(url, { signal, registry })).toString("utf8"));
    const packs: Listed[] = [];
    for (const o of body.objects || []) {
      const { name, version } = o.package || {};
      if (typeof name === "string" && typeof version === "string" && isValidPackName(name) && isValidVersion(version)) packs.push({ name, version });
    }
    list = { at: Date.now(), packs, total: typeof body.total === "number" ? body.total : packs.length };
  } catch (err) {
    list = { at: Date.now(), error: reason(err) };
  }
  writeCache(file, list);
  return list;
}

/**
 * A pack version's catalog or its lasting failure: it fails the install checks
 * (an error with no status), or the registry answers 404 or 410. Throws on any
 * other failure (no answer, a timeout, any other HTTP status), so the next search tries again.
 * Trust is the reader's, so it is not cached.
 */
async function readPack(registry: Registry, { name, version }: Listed, signal: AbortSignal): Promise<PackRead> {
  const file = path.join(cacheDir(registry), `${packDirName(name, version)}.json`);
  const cached = readCache<PackRead>(file);
  if (cached) return cached;
  let read: PackRead;
  try {
    const { catalog, integrity } = await readRegistryPack(`${name}@${version}`, registry, signal);
    read = { name, version, integrity, catalog };
  } catch (caught) {
    const err = caught as InstallError;
    const lasting = !err.network && (err.status === undefined || err.status === 404 || err.status === 410);
    if (signal.aborted || !lasting) throw err;
    read = { name, version, error: err.message };
  }
  writeCache(file, read);
  return read;
}

/**
 * Packs on the registries that are not installed here. Never throws: an
 * unreachable registry, a timeout, an unreadable trust list or registries file
 * comes back as a note while the other registries still answer; with no trust
 * list every pack counts third-party, with no registries file only the default
 * registry is searched. A registry's packs count only under the names routed to
 * it, so a mapped registry cannot shadow other packs and the default registry's
 * packs in a mapped scope are left out. A pack whose catalog fails the install
 * checks is left out; packs a registry did not serve this time are left out and
 * counted in the note.
 */
export async function remotePacks(): Promise<RemotePacks> {
  const notes: string[] = [];
  let trusted: TrustList;
  try {
    trusted = readTrustList();
  } catch {
    trusted = { pins: {}, scopes: [] };
    notes.push(`trust list unreadable: ask the user to fix ${trustFile()}`);
  }
  let regs: Registries;
  try {
    regs = readRegistries();
  } catch {
    regs = new Map();
    notes.push(`registries unreadable: ask the user to fix ${registriesFile()}`);
  }
  const sources = [defaultRegistry(), ...regs.values()];
  const signal = AbortSignal.timeout(BUDGET_MS);
  const lists = await Promise.all(
    sources.map((registry) =>
      listPacks(registry, signal, (err) => (signal.aborted ? `no answer from ${registry.url} within ${BUDGET_MS / 1000}s` : err instanceof Error ? err.message : String(err))),
    ),
  );
  const installed = new Set(installedPacks().map((p) => p.name));
  const todo: { registry: Registry; pack: Listed }[] = [];
  sources.forEach((registry, i) => {
    const list = lists[i];
    const label = registry.scope ? `${registry.scope} registry` : "registry";
    if ("error" in list) return notes.push(`${label} unavailable (${list.error})`);
    if (list.total > LIST_SIZE) notes.push(`only the first ${LIST_SIZE} of ${list.total} packs on the ${label} were searched`);
    for (const pack of list.packs) {
      if (!installed.has(pack.name) && registryFor(regs, pack.name).scope === registry.scope) todo.push({ registry, pack });
    }
  });
  const reads: (PackRead | null)[] = [];
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < todo.length) {
      const i = next++;
      reads[i] = await readPack(todo[i].registry, todo[i].pack, signal).catch(() => null);
    }
  };
  await Promise.all(Array.from({ length: PARALLEL_FETCHES }, worker));
  const unread = reads.filter((r) => r === null).length;
  if (unread) notes.push(`${unread} npm ${unread === 1 ? "pack" : "packs"} could not be read`);
  const rank = { "first-party": 0, trusted: 1, "third-party": 2 };
  const packs = reads
    .flatMap((r, i): RemotePack[] => {
      if (!r || "error" in r) return [];
      const { registry } = todo[i];
      const by = trustOf(trusted, r, registry.url);
      return [{ ...r, registry, trust: by === "first-party" ? "first-party" : by ? "trusted" : "third-party" }];
    })
    // Equal matches list the packs an agent may install first.
    .sort((a, b) => rank[a.trust] - rank[b.trust]);
  return { packs, note: notes.join("; ") || undefined };
}
