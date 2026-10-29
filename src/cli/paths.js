import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BUNDLED = typeof __AUSTERE_BUNDLED__ !== "undefined";

/** Directory holding austere.js, spec.json, prompt.md, chrome/ (dist/). */
export const ASSET_DIR = BUNDLED ? HERE : path.resolve(HERE, "../../dist");

export const VERSION =
  typeof __AUSTERE_VERSION__ === "string"
    ? __AUSTERE_VERSION__
    : JSON.parse(fs.readFileSync(path.resolve(HERE, "../../package.json"), "utf8")).version;

/** Script to run for `server` (the bundled CLI itself, or the dev entry). */
export const CLI_ENTRY = BUNDLED ? fileURLToPath(import.meta.url) : path.resolve(HERE, "main.js");

/** The pack kit (`components build`): bundled next to the CLI, or the source in development. */
export function packKitPath() {
  return BUNDLED ? path.join(HERE, "pack-kit.mjs") : path.resolve(HERE, "../pack-kit/index.js");
}

export function assetPath(name) {
  return path.join(ASSET_DIR, name);
}

export function stateDir() {
  const dir = process.env.AUSTERE_AXI_STATE_DIR || path.join(os.homedir(), ".austere-axi");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function port() {
  const p = Number(process.env.AUSTERE_AXI_PORT);
  return Number.isInteger(p) && p > 0 && p < 65536 ? p : 4388;
}

export function msEnv(name, fallback) {
  const raw = process.env[name];
  if (raw == null || raw === "") return fallback;
  if (/^(0|off|false|no)$/i.test(raw)) return 0;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

export function canonicalFile(file) {
  const abs = path.resolve(file);
  try {
    return fs.realpathSync(abs);
  } catch {
    return abs;
  }
}

/** Newer-than comparison for x.y.z versions. */
export function versionGt(a, b) {
  const pa = String(a).split(/[.-]/).map((x) => parseInt(x, 10) || 0);
  const pb = String(b).split(/[.-]/).map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0);
  }
  return false;
}
