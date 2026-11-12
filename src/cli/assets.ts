// Files next to an artifact: which ones may be read, and by whom. The review server (`/s/:id/a/...`)
// and `export` share these rules, so a page cannot read more through one than through the other.
import fs from "node:fs";
import path from "node:path";

/** The largest sibling file the server streams. */
export const MAX_ASSET_BYTES = 64 * 1024 * 1024;

export type Sibling = { ok: true; file: string; size: number } | { ok: false; reason: "outside" | "hidden" | "missing" | "too-large" };

/**
 * Resolve `rel` against the artifact's directory `dir`, for reading. Refuses a NUL byte, a path
 * that leaves `dir` (lexically or through a symlink), any dotfile or dot-directory (also behind a
 * symlink with an ordinary name), anything that is not a regular file, and a file over `maxBytes`.
 * @param rel a path already URL-decoded
 */
export function resolveSibling(dir: string, rel: string, maxBytes = MAX_ASSET_BYTES): Sibling {
  if (rel.includes("\0")) return { ok: false, reason: "outside" };
  const file = path.resolve(dir, rel);
  if (!file.startsWith(dir + path.sep)) return { ok: false, reason: "outside" };
  if (rel.split(/[/\\]/).some((p) => p.startsWith("."))) return { ok: false, reason: "hidden" };
  try {
    // The check above is lexical; a symlink inside the directory can still lead out of it.
    const realDir = fs.realpathSync(dir);
    const real = fs.realpathSync(file);
    if (!real.startsWith(realDir + path.sep)) return { ok: false, reason: "outside" };
    // A link with an ordinary name can still point at a dotfile in the directory.
    if (path.relative(realDir, real).split(path.sep).some((p) => p.startsWith("."))) return { ok: false, reason: "hidden" };
    const st = fs.statSync(real);
    if (!st.isFile()) return { ok: false, reason: "missing" };
    if (st.size > maxBytes) return { ok: false, reason: "too-large" };
    return { ok: true, file: real, size: st.size };
  } catch {
    return { ok: false, reason: "missing" };
  }
}
