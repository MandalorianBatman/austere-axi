// Installing component packs: from the npm registry, a .tgz (`npm pack`
// output), or a pack folder that has been built. Only three files are kept
// per pack: dist/pack.js, dist/catalog.json and package.json. Installing runs
// nothing from the pack; its code runs only inside review pages.
//
// Trust: a pack counts as first-party only when it came from the registry
// under @austere-axi/ (the registry vouches for the scope). A tarball needs
// --trust whatever name its catalog claims; a folder is the user's own.
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import crypto from "node:crypto";
import type { PackCatalog } from "../../types/catalog.d.ts";
import { coreCatalog, installedPacks, isFirstParty, packDirName, packsDir, PACK_API, readLock, writeLock, TRUSTED_SCOPE } from "./packs.ts";
import type { PackSource, PackTrust } from "./packs.ts";
import { isValidPackName, isValidVersion, splitSpec } from "../shared/packs-meta.ts";
import { CATALOG_FORMAT } from "../shared/catalog.ts";

/** The part of a registry packument (`GET <registry>/<name>`) installing reads. */
export interface RegistryMeta {
  "dist-tags"?: Record<string, string>;
  versions: Record<string, { dist?: { tarball?: string; integrity?: string; shasum?: string } }>;
}

/** The three files kept from a pack. */
interface PackFiles {
  packJs: Buffer;
  catalog: Buffer;
  packageJson: Buffer | null;
}

/** A pack's files and where they came from. */
interface FetchedPack extends PackFiles {
  source: PackSource;
  resolved: string;
  /** What the registry served it as; its catalog must say the same. */
  expect?: { name: string; version: string };
}

export interface AddedPack {
  name: string;
  version: string;
  integrity: string;
  previous: string | undefined;
  components: string[];
  warnings: string[];
  trust: PackTrust;
}

/** What install errors carry besides the message (main.ts reads them). */
export interface InstallError extends Error {
  code?: string;
  network?: boolean;
  status?: number;
}

const MAX_TARBALL = 20 * 1024 * 1024;
const MAX_UNPACKED = 32 * 1024 * 1024;
const MAX_PACK_JS = 8 * 1024 * 1024;
/** The only files read from a pack tarball. */
const PACK_FILES = new Set(["dist/pack.js", "dist/catalog.json", "package.json"]);

export function registryUrl(): string {
  const r = process.env.AUSTERE_AXI_NPM_REGISTRY || process.env.npm_config_registry || "https://registry.npmjs.org/";
  return r.endsWith("/") ? r : r + "/";
}

/** A folder or tarball rather than an npm name: anything path-shaped (an npm name has a slash only after "@scope"). */
export function looksLikePath(spec: string): boolean {
  return (
    /^(\.{1,2}([\\/]|$)|[\\/]|~[\\/]|[A-Za-z]:[\\/])/.test(spec) ||
    /\.t(ar\.)?gz$/i.test(spec) ||
    spec.includes("\\") ||
    (spec.includes("/") && !spec.startsWith("@"))
  );
}

function sri(alg: string, buf: Buffer): string {
  return `${alg}-${crypto.createHash(alg).update(buf).digest("base64")}`;
}

// ── tarballs ──

/** The pack files (PACK_FILES) in a gunzipped tar archive, with the top folder ("package/") stripped. */
export function untar(buf: Buffer): Map<string, Buffer> {
  const files = new Map<string, Buffer>();
  let off = 0;
  let longName: string | null = null;
  let paxPath: string | null = null;
  const str = (h: Buffer, a: number, b: number): string => h.subarray(a, b).toString("utf8").replace(/\0[\s\S]*$/, "");
  while (off + 512 <= buf.length) {
    const h = buf.subarray(off, off + 512);
    if (h.every((b) => b === 0)) break;
    let name = str(h, 0, 100);
    const size = parseInt(str(h, 124, 136).trim() || "0", 8);
    const type = String.fromCharCode(h[156] || 48);
    const prefix = str(h, 345, 500);
    if (prefix && h.subarray(257, 262).toString() === "ustar") name = `${prefix}/${name}`;
    const body = buf.subarray(off + 512, off + 512 + size);
    off += 512 + Math.ceil(size / 512) * 512;
    if (type === "x") {
      const m = /(?:^|\n)\d+ path=([^\n]*)\n/.exec(body.toString("utf8"));
      if (m) paxPath = m[1];
      continue;
    }
    if (type === "L") {
      longName = body.toString("utf8").replace(/\0[\s\S]*$/, "");
      continue;
    }
    if (type === "0") {
      const full = (paxPath || longName || name).replace(/^\.?\//, "").split("/").slice(1).join("/");
      if (PACK_FILES.has(full)) files.set(full, Buffer.from(body));
    }
    paxPath = null;
    longName = null;
  }
  return files;
}

// ── versions ──

function cmp(a: string, b: string): number {
  const pa = a.split(/[.-]/).map((x) => parseInt(x, 10) || 0);
  const pb = b.split(/[.-]/).map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i] - pb[i];
  return 0;
}

/** Resolve "", a dist-tag, x.y.z, ^x.y.z, ~x.y.z, x or x.y against the published versions. */
export function pickVersion(meta: RegistryMeta, range: string): string | null {
  const tags: Record<string, string> = meta["dist-tags"] || {};
  const versions = Object.keys(meta.versions || {}).filter(isValidVersion);
  if (!range || range === "latest") return tags.latest || null;
  if (tags[range]) return tags[range];
  if (isValidVersion(range)) return versions.includes(range) ? range : null;
  const m = /^([\^~])?(\d+)(?:\.(\d+|x|\*))?(?:\.(\d+|x|\*))?$/.exec(range);
  if (!m) return null;
  const [, op, M, mi, pa] = m;
  const want = [Number(M), mi && /\d/.test(mi) ? Number(mi) : null, pa && /\d/.test(pa) ? Number(pa) : null];
  const ok = (v: string): boolean => {
    if (v.includes("-")) return false;
    const [a, b, c] = v.split(".").map(Number);
    if (a !== want[0]) return false;
    if (op === "^") {
      if (a === 0 && want[1] !== null && b !== want[1]) return false;
      return cmp(v, `${want[0]}.${want[1] ?? 0}.${want[2] ?? 0}`) >= 0;
    }
    if (want[1] !== null && b !== want[1]) return false;
    if (op === "~") return c >= (want[2] ?? 0);
    return want[2] === null || c === want[2];
  };
  return versions.filter(ok).sort(cmp).pop() || null;
}

// ── sources ──

export async function fetchBuffer(url: string, { accept, signal }: { accept?: string; signal?: AbortSignal } = {}): Promise<Buffer> {
  let res;
  try {
    res = await fetch(url, { headers: accept ? { accept } : {}, redirect: "follow", signal });
  } catch (caught) {
    // fetch rejects with a TypeError whose cause carries the network error code.
    const err = caught as { cause?: { code?: string }; message?: string };
    const e = Object.assign(new Error(`could not reach ${url} (${err.cause?.code || err.message})`), { network: true });
    throw e;
  }
  if (!res.ok) {
    const e = Object.assign(new Error(`${url}: HTTP ${res.status}`), { status: res.status });
    throw e;
  }
  const len = Number(res.headers.get("content-length") || 0);
  if (len > MAX_TARBALL) throw new Error(`${url} is larger than ${MAX_TARBALL / 1024 / 1024} MB`);
  let buf;
  try {
    buf = Buffer.from(await res.arrayBuffer());
  } catch (caught) {
    // The connection dropped mid-body: as much a network failure as no answer at all.
    throw Object.assign(new Error(`could not read ${url} (${caught instanceof Error ? caught.message : String(caught)})`), { network: true });
  }
  if (buf.length > MAX_TARBALL) throw new Error(`${url} is larger than ${MAX_TARBALL / 1024 / 1024} MB`);
  return buf;
}

async function fromRegistry(spec: string, signal?: AbortSignal): Promise<FetchedPack> {
  const { name, version: range } = spec.startsWith("@") || spec.includes("@") ? splitSpec(spec) : { name: spec, version: "" };
  if (!isValidPackName(name)) throw new Error(`${JSON.stringify(name)} is not an npm package name`);
  const metaUrl = registryUrl() + name.replace("/", "%2f");
  let meta: RegistryMeta;
  try {
    meta = JSON.parse((await fetchBuffer(metaUrl, { accept: "application/vnd.npm.install-v1+json; q=1.0, application/json; q=0.8", signal })).toString("utf8"));
  } catch (err) {
    if (err instanceof Error && "status" in err && err.status === 404) throw new Error(`no package ${name} on ${registryUrl()}`);
    throw err;
  }
  const version = pickVersion(meta, range);
  if (!version) throw new Error(`${name} has no version matching ${range || "latest"}`);
  const dist = meta.versions[version].dist || {};
  if (!dist.tarball) throw new Error(`${name}@${version} has no tarball`);
  const tgz = await fetchBuffer(dist.tarball, { signal });
  if (dist.integrity) {
    const [alg] = dist.integrity.split("-");
    if (!["sha512", "sha384", "sha256"].includes(alg) || sri(alg, tgz) !== dist.integrity) {
      throw new Error(`${name}@${version}: the tarball does not match the registry's integrity hash`);
    }
  } else if (dist.shasum && crypto.createHash("sha1").update(tgz).digest("hex") !== dist.shasum) {
    throw new Error(`${name}@${version}: the tarball does not match the registry's shasum`);
  }
  return { ...readTarball(tgz, `${name}@${version}`), expect: { name, version }, source: "npm", resolved: dist.tarball };
}

function readTarball(tgz: Buffer, label: string): PackFiles {
  let files;
  try {
    files = untar(zlib.gunzipSync(tgz, { maxOutputLength: MAX_UNPACKED }));
  } catch (err) {
    if ((err as InstallError).code === "ERR_BUFFER_TOO_LARGE") throw new Error(`${label} unpacks to more than ${MAX_UNPACKED / 1024 / 1024} MB`);
    throw new Error(`${label}: not a gzipped tarball (${err instanceof Error ? err.message : undefined})`);
  }
  const packJs = files.get("dist/pack.js");
  const catalog = files.get("dist/catalog.json");
  if (!packJs || !catalog) {
    throw new Error(`${label} is not an austere-axi pack: it has no dist/pack.js and dist/catalog.json (\`austere-axi components build\` makes them)`);
  }
  return { packJs, catalog, packageJson: files.get("package.json") || null };
}

function fromTarball(file: string): FetchedPack {
  const abs = path.resolve(file.replace(/^~(?=[\\/])/, process.env.HOME || ""));
  if (!fs.existsSync(abs)) throw new Error(`no such file: ${abs}`);
  return { ...readTarball(fs.readFileSync(abs), path.basename(abs)), source: "tarball", resolved: abs };
}

function fromFolder(dir: string): FetchedPack {
  const abs = path.resolve(dir.replace(/^~(?=[\\/])/, process.env.HOME || ""));
  if (!fs.existsSync(abs)) throw new Error(`no such folder: ${abs}`);
  if (fs.statSync(abs).isFile()) return fromTarball(abs);
  const read = (rel: string): Buffer | null => (fs.existsSync(path.join(abs, rel)) ? fs.readFileSync(path.join(abs, rel)) : null);
  const packJs = read("dist/pack.js");
  const catalog = read("dist/catalog.json");
  if (!packJs || !catalog) throw new Error(`${abs} has no dist/pack.js and dist/catalog.json: run \`austere-axi components build ${dir}\` first`);
  return { packJs, catalog, packageJson: read("package.json"), source: "folder", resolved: abs };
}

// ── install ──

function parseCatalog(buf: Buffer, label: string): PackCatalog {
  let cat: PackCatalog;
  try {
    cat = JSON.parse(buf.toString("utf8"));
  } catch {
    throw new Error(`${label}: dist/catalog.json is not JSON`);
  }
  if (cat.format !== CATALOG_FORMAT) throw new Error(`${label}: catalog format ${cat.format}; this austere-axi reads ${CATALOG_FORMAT}`);
  if (cat.api !== PACK_API) throw new Error(`${label} was built for pack API ${cat.api}; this austere-axi has ${PACK_API}`);
  if (!isValidPackName(cat.pack || "") || !isValidVersion(cat.version || "")) throw new Error(`${label}: catalog has no valid pack name and version`);
  if (!Array.isArray(cat.components) || !cat.components.length) throw new Error(`${label}: catalog lists no components`);
  if (cat.groups != null && !(Array.isArray(cat.groups) && cat.groups.every((g) => typeof g?.name === "string" && Array.isArray(g.notes) && g.notes.every((n) => typeof n === "string")))) {
    throw new Error(`${label}: catalog has malformed groups (expected [{ "name": "...", "notes": ["..."] }])`);
  }
  for (const c of cat.components) {
    if (!c || typeof c.name !== "string" || !/^[A-Z][A-Za-z0-9]*$/.test(c.name) || typeof c.signature !== "string" || typeof c.group !== "string") {
      throw new Error(`${label}: bad component entry ${JSON.stringify(c?.name)} (needs a name, signature and group)`);
    }
    if (c.description != null && typeof c.description !== "string") throw new Error(`${label}: ${c.name} has a description that is not a string`);
    if (c.examples != null && !(Array.isArray(c.examples) && c.examples.every((x) => typeof x === "string"))) {
      throw new Error(`${label}: ${c.name} has malformed examples (expected an array of strings)`);
    }
    if (c.slots != null && !(Array.isArray(c.slots) && c.slots.every((x) => /^[A-Z][A-Za-z0-9]*\.[a-z][A-Za-z0-9]*$/.test(x)))) {
      throw new Error(`${label}: ${c.name} has malformed slots (expected ["Card.children", ...] or null)`);
    }
  }
  return cat;
}

/** A fetched pack's catalog, checked against the name the registry served and against its pack.js. */
function verifyPack(got: FetchedPack, label: string): { cat: PackCatalog; integrity: string } {
  const cat = parseCatalog(got.catalog, label);
  if (got.expect && (cat.pack !== got.expect.name || cat.version !== got.expect.version)) {
    throw new Error(`${label}: its catalog says ${cat.pack}@${cat.version}; rebuild the pack before publishing`);
  }
  if (got.packJs.length > MAX_PACK_JS) throw new Error(`${label}: pack.js is over ${MAX_PACK_JS / 1024 / 1024} MB`);
  const integrity = sri("sha384", got.packJs);
  if (cat.integrity && cat.integrity !== integrity) {
    throw new Error(`${label}: dist/pack.js changed after its catalog was built; run \`austere-axi components build\` again`);
  }
  return { cat, integrity };
}

/** A registry pack's verified catalog and pack.js integrity, read from its tarball without installing it. */
export async function readRegistryPack(name: string, version: string, signal?: AbortSignal): Promise<{ catalog: PackCatalog; integrity: string }> {
  const label = `${name}@${version}`;
  const { cat, integrity } = verifyPack(await fromRegistry(label, signal), label);
  return { catalog: cat, integrity };
}

/**
 * Install a pack. `spec`: npm name[@range], a .tgz, or a built pack folder.
 * Third-party packs (outside @austere-axi/) from npm or a tarball need `trust`.
 */
export async function addPack(spec: string, { trust = false }: { trust?: boolean } = {}): Promise<AddedPack> {
  const local = looksLikePath(spec);
  if (!local) {
    const { name } = spec.startsWith("@") || spec.includes("@") ? splitSpec(spec) : { name: spec };
    if (!isFirstParty(name) && !trust) {
      throw Object.assign(
        new Error(
          `${name} is a third-party pack: its code would run inside your review pages, where it can read the page and add items to the feedback queue. Look at its source first (npm view ${name} repository), then rerun with --trust.`,
        ),
        { code: "untrusted" },
      );
    }
  }
  const got: FetchedPack = local ? fromFolder(spec) : await fromRegistry(spec);
  if (got.source === "tarball" && !trust) {
    // Nothing vouches for a tarball's name, so even an @austere-axi/ one needs --trust.
    const peek = parseCatalog(got.catalog, path.basename(got.resolved));
    throw Object.assign(
      new Error(
        `${path.basename(got.resolved)} (${peek.pack}) comes from a file, not the registry: its code would run inside your review pages. Rerun with --trust once you have looked at it.`,
      ),
      { code: "untrusted" },
    );
  }
  const label = got.expect ? `${got.expect.name}@${got.expect.version}` : spec;
  const { cat, integrity } = verifyPack(got, label);

  const warnings: string[] = [];
  const coreNames = new Set(coreCatalog().components.map((c) => c.name));
  const others = installedPacks().filter((p) => p.name !== cat.pack);
  for (const c of cat.components) {
    if (coreNames.has(c.name)) warnings.push(`${c.name} is a core component; pages use the core one`);
    const clash = others.find((p) => p.catalog.components.some((x) => x.name === c.name));
    if (clash) warnings.push(`${c.name} is also in ${clash.name}; a page should declare only one of them`);
  }

  const lock = readLock();
  const previous = lock.packs[cat.pack];
  const dir = path.join(packsDir(), packDirName(cat.pack, cat.version));
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "pack.js"), got.packJs);
  fs.writeFileSync(path.join(dir, "catalog.json"), got.catalog);
  if (got.packageJson) fs.writeFileSync(path.join(dir, "package.json"), got.packageJson);
  if (previous && previous.version !== cat.version) {
    fs.rmSync(path.join(packsDir(), packDirName(cat.pack, previous.version)), { recursive: true, force: true });
  }
  lock.packs[cat.pack] = {
    version: cat.version,
    integrity,
    source: got.source,
    resolved: got.resolved,
    trust: got.source === "npm" && isFirstParty(cat.pack) ? "first-party" : got.source === "folder" ? "local" : "--trust",
    components: cat.components.map((c) => c.name),
    installedAt: new Date().toISOString(),
  };
  writeLock(lock);
  return { name: cat.pack, version: cat.version, integrity, previous: previous?.version, components: lock.packs[cat.pack].components, warnings, trust: lock.packs[cat.pack].trust };
}

export function removePack(name: string): { name: string; version: string } | null {
  const lock = readLock();
  const entry = lock.packs[name];
  if (!entry) return null;
  delete lock.packs[name];
  writeLock(lock);
  fs.rmSync(path.join(packsDir(), packDirName(name, entry.version)), { recursive: true, force: true });
  return { name, version: entry.version };
}

export { TRUSTED_SCOPE };
