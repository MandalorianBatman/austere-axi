import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BUNDLED = typeof __AUSTERE_BUNDLED__ !== "undefined";

/** Directory holding austere.js, spec.json, prompt.md, chrome/ (dist/). */
export const ASSET_DIR = BUNDLED ? HERE : path.resolve(HERE, "../../dist");

export const VERSION: string =
  typeof __AUSTERE_VERSION__ === "string" ? __AUSTERE_VERSION__ : packageVersion();

function packageVersion(): string {
  // Our own package.json, beside the sources in development.
  const pkg: { version: string } = JSON.parse(
    fs.readFileSync(path.resolve(HERE, "../../package.json"), "utf8"),
  );
  return pkg.version;
}

/** Script to run for `server` (the bundled CLI itself, or the dev entry). */
export const CLI_ENTRY = BUNDLED ? fileURLToPath(import.meta.url) : path.resolve(HERE, "main.ts");

/** The pack kit (`components build`): bundled next to the CLI, or the source in development. */
export function packKitPath(): string {
  return BUNDLED ? path.join(HERE, "pack-kit.mjs") : path.resolve(HERE, "../pack-kit/index.ts");
}

export function assetPath(name: string): string {
  return path.join(ASSET_DIR, name);
}

/** The port an installed build's server listens on unless AUSTERE_AXI_PORT says otherwise. */
export const REAL_PORT = 4388;

/**
 * The checkout this CLI runs from: the sources (`src/cli/main.ts`), or `dist/` whose parent is a
 * git checkout. Null for an installed build. Only `dist/`'s own parent counts: a package installed
 * under `node_modules/` inside someone's repository is not a checkout of austere-axi.
 */
export function devCheckout(bundled = BUNDLED, here = HERE): string | null {
  const root = path.resolve(here, bundled ? ".." : "../..");
  if (!bundled) return root;
  return fs.existsSync(path.join(root, ".git")) ? root : null;
}

/** A checkout's own port, 4400-4899 by its path: two checkouts rarely share one, and none is the real 4388. */
export function devPort(root: string): number {
  return 4400 + (crypto.createHash("sha1").update(root).digest().readUInt32BE(0) % 500);
}

/**
 * A build run from a checkout keeps off the owner's state dir and port: with AUSTERE_AXI_STATE_DIR
 * unset it sets it to `<checkout>/.dev/state`, and AUSTERE_AXI_PORT, when unset too, to the
 * checkout's own port. Written into `env`, so a server, service or child CLI this process starts
 * means the same ones. Returns the line that says so, or null when nothing changed.
 */
export function applyDevDefaults(
  env: NodeJS.ProcessEnv = process.env,
  root = devCheckout(),
): string | null {
  if (!root || env.AUSTERE_AXI_STATE_DIR) return null;
  env.AUSTERE_AXI_STATE_DIR = path.join(root, ".dev", "state");
  env.AUSTERE_AXI_PORT ||= String(devPort(root));
  return `a build from a checkout: state dir ${env.AUSTERE_AXI_STATE_DIR}, port ${env.AUSTERE_AXI_PORT}, not ~/.austere-axi and ${REAL_PORT}. Set AUSTERE_AXI_STATE_DIR to choose.`;
}

let securedDir: string | null = null;

export function stateDir(): string {
  // An absolute path, always: the state dir is named by a server, a CLI command and a
  // service that may run from different folders, and they have to mean the same one.
  const dir = process.env.AUSTERE_AXI_STATE_DIR
    ? path.resolve(process.env.AUSTERE_AXI_STATE_DIR)
    : path.join(os.homedir(), ".austere-axi");
  // Sessions, invites, the owner key and logs live here: the owner's only. mkdir's mode only applies to
  // a new dir, so tighten one made by an older version too (POSIX; Windows ignores modes).
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (securedDir !== dir && process.platform !== "win32") {
    try {
      fs.chmodSync(dir, 0o700);
    } catch {
      // not ours to change (a shared AUSTERE_AXI_STATE_DIR); its owner decides
    }
    securedDir = dir;
  }
  return dir;
}

export function msEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw == null || raw === "") return fallback;
  if (/^(0|off|false|no)$/i.test(raw)) return 0;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

/**
 * The real path of `file`. A file that no longer exists resolves through its nearest existing
 * folder, so a path through a symlinked folder still names the file it was recorded under.
 */
export function canonicalFile(file: string): string {
  const abs = path.resolve(file);
  const rest: string[] = [];
  for (let dir = abs; ;) {
    try {
      return path.join(fs.realpathSync(dir), ...rest);
    } catch {
      const parent = path.dirname(dir);
      if (parent === dir) return abs;
      rest.unshift(path.basename(dir));
      dir = parent;
    }
  }
}

/** Newer-than comparison for x.y.z versions. */
export function versionGt(a: unknown, b: unknown): boolean {
  const pa = String(a)
    .split(/[.-]/)
    .map((x) => parseInt(x, 10) || 0);
  const pb = String(b)
    .split(/[.-]/)
    .map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0);
  }
  return false;
}

/** A file path as one word in a command line printed for an agent: double-quoted when it has spaces or shell characters. */
export function quote(file: string): string {
  return /[\s"'$`\\]/.test(file) ? JSON.stringify(file) : file;
}
