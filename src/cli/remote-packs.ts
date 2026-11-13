// Packs on the npm registry that are not installed here, for `components
// search|show`. A pack is found by its package.json keyword "austere-axi-pack".
// Its catalog comes from its tarball, checked like an install; nothing from
// the pack runs. Cached under <state>/npm-packs/<registry>/: the pack list for
// an hour, each catalog by name@version for good (published versions do not change).
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { PackCatalog } from "../../types/catalog.d.ts";
import { fetchBuffer, readRegistryPack, registryUrl } from "./install.ts";
import type { InstallError } from "./install.ts";
import { installedPacks, isFirstParty, packDirName } from "./packs.ts";
import { stateDir } from "./paths.ts";
import { isValidPackName, isValidVersion } from "../shared/packs-meta.ts";

export interface RemotePack {
  name: string;
  version: string;
  /** sha384 of dist/pack.js, as an install records it. */
  integrity: string;
  trust: "first-party" | "third-party";
  catalog: PackCatalog;
}

/** Packs found, and why the registry could not be (fully) searched, if it could not. */
export interface RemotePacks {
  packs: RemotePack[];
  unavailable?: string;
}

interface Listed {
  name: string;
  version: string;
}

const KEYWORD = "austere-axi-pack";
const LIST_TTL_MS = 60 * 60_000;
const BUDGET_MS = 4000;

function cacheDir(): string {
  const registry = registryUrl();
  return path.join(stateDir(), "npm-packs", crypto.createHash("sha256").update(registry).digest("hex").slice(0, 12));
}

function readCache<T>(file: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function writeCache(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value));
  fs.renameSync(tmp, file);
}

async function listPacks(signal: AbortSignal): Promise<Listed[]> {
  const file = path.join(cacheDir(), "list.json");
  const cached = readCache<{ at: number; packs: Listed[] }>(file);
  if (cached && Date.now() - cached.at < LIST_TTL_MS) return cached.packs;
  const url = `${registryUrl()}-/v1/search?text=keywords:${KEYWORD}&size=250`;
  const body: { objects?: { package?: { name?: unknown; version?: unknown } }[] } = JSON.parse((await fetchBuffer(url, { signal })).toString("utf8"));
  const packs: Listed[] = [];
  for (const o of body.objects || []) {
    const { name, version } = o.package || {};
    if (typeof name === "string" && typeof version === "string" && isValidPackName(name) && isValidVersion(version)) packs.push({ name, version });
  }
  writeCache(file, { at: Date.now(), packs });
  return packs;
}

async function readPack({ name, version }: Listed, signal: AbortSignal): Promise<RemotePack> {
  const file = path.join(cacheDir(), `${packDirName(name, version)}.json`);
  const cached = readCache<RemotePack>(file);
  if (cached) return cached;
  const { catalog, integrity } = await readRegistryPack(name, version, signal);
  const pack: RemotePack = { name, version, integrity, trust: isFirstParty(name) ? "first-party" : "third-party", catalog };
  writeCache(file, pack);
  return pack;
}

/**
 * Packs on the registry that are not installed here. Never throws: an
 * unreachable registry or a timeout comes back as `unavailable`; a pack whose
 * tarball or catalog fails the install checks is left out.
 */
export async function remotePacks(): Promise<RemotePacks> {
  const signal = AbortSignal.timeout(BUDGET_MS);
  const reason = (err: unknown): string => (signal.aborted ? `no answer from ${registryUrl()} within ${BUDGET_MS / 1000}s` : err instanceof Error ? err.message : String(err));
  let listed: Listed[];
  try {
    listed = await listPacks(signal);
  } catch (err) {
    return { packs: [], unavailable: reason(err) };
  }
  const installed = new Set(installedPacks().map((p) => p.name));
  let unavailable: string | undefined;
  const read = await Promise.all(
    listed
      .filter((p) => !installed.has(p.name))
      .map((p) =>
        readPack(p, signal).catch((caught: unknown) => {
          const err = caught as InstallError;
          if (signal.aborted || err.network || err.status) unavailable ||= reason(err);
          return null;
        }),
      ),
  );
  return { packs: read.filter((p): p is RemotePack => !!p), unavailable };
}
