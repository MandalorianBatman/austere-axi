// Standalone export: one HTML file that renders offline, with the runtime
// (and every pack the page uses) inlined. No network fetches.
import fs from "node:fs";
import path from "node:path";
import { readArtifact, rewriteRuntime } from "./artifact.ts";
import { resolveSibling } from "./assets.ts";
import { assetPath } from "./paths.ts";
import { implicitPacks, pagePacks } from "./packs.ts";

function inlineScript(code: string): string {
  // A literal "</script" inside the bundle would end the tag early.
  return `<script>${code.replace(/<\/script/gi, "<\\/script")}</script>`;
}

const IMAGE_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".avif": "image/avif",
};
/** The largest image worth carrying inside the page. */
const MAX_INLINE_BYTES = 10 * 1024 * 1024;

interface Literal {
  start: number;
  end: number;
  value: string;
}

/** The string literal that starts at `i` (a quote), or null when it never closes. */
function stringAt(src: string, i: number): Literal | null {
  const q = src[i];
  let value = "";
  for (let j = i + 1; j < src.length; j++) {
    const c = src[j];
    if (c === "\\" && j + 1 < src.length) value += src[++j];
    else if (c === q) return { start: i, end: j + 1, value };
    else value += c;
  }
  return null;
}

/** The offset of the first character at or after `i` that is not whitespace or a comment. */
function skipBlank(src: string, i: number): number {
  for (;;) {
    while (i < src.length && /\s/.test(src[i])) i++;
    if (src[i] === "#" || (src[i] === "/" && src[i + 1] === "/")) while (i < src.length && src[i] !== "\n") i++;
    else return i;
  }
}

/**
 * The second argument of every `Image(alt, src)` call whose `src` is a string literal. Strings
 * and comments are skipped, so an `Image(` inside a CodeBlock source or a note is not a call.
 */
function imageSources(src: string): Literal[] {
  const out: Literal[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === '"' || c === "'") {
      i = stringAt(src, i)?.end ?? src.length;
    } else if (c === "#" || (c === "/" && src[i + 1] === "/")) {
      while (i < src.length && src[i] !== "\n") i++;
    } else if (/[A-Za-z_$]/.test(c)) {
      let j = i + 1;
      while (j < src.length && /[\w$]/.test(src[j])) j++;
      const word = src.slice(i, j);
      i = j;
      if (word !== "Image") continue;
      j = skipBlank(src, j);
      if (src[j] !== "(") continue;
      // First argument: skip to its end at bracket depth 0, then read the second as a literal.
      let k = j + 1;
      let depth = 0;
      while (k < src.length) {
        const d = src[k];
        if (d === '"' || d === "'") k = stringAt(src, k)?.end ?? src.length;
        else if (d === "#" || (d === "/" && src[k + 1] === "/")) k = skipBlank(src, k);
        else if (d === "(" || d === "[" || d === "{") {
          depth++;
          k++;
        } else if (d === ")" || d === "]" || d === "}") {
          if (depth === 0) break;
          depth--;
          k++;
        } else if (d === "," && depth === 0) break;
        else k++;
      }
      if (src[k] !== ",") continue;
      k = skipBlank(src, k + 1);
      if (src[k] === '"' || src[k] === "'") {
        const lit = stringAt(src, k);
        if (lit) out.push(lit);
      }
    } else i++;
  }
  return out;
}

/**
 * Replace each relative `Image` src in an OpenUI program with a data URI of the file next to the
 * page. A file that cannot be read (missing, hidden, outside `dir`, too big, not an image type)
 * stays as it was, with a notice that names it.
 */
function inlineImages(program: string, dir: string, notices: string[]): string {
  let out = "";
  let at = 0;
  const seen = new Set<string>();
  const warn = (src: string, why: string) => {
    if (!seen.has(src)) notices.push(`Image "${src}" is not inlined: ${why}. Keep it next to the exported file.`);
    seen.add(src);
  };
  for (const lit of imageSources(program)) {
    if (/^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(lit.value)) continue; // http:, data:, blob:, //host
    let rel = lit.value.replace(/[?#].*$/, "");
    try {
      rel = decodeURIComponent(rel);
    } catch {
      // Not percent-encoded after all: the name is literal.
    }
    const type = IMAGE_TYPES[path.extname(rel).toLowerCase()];
    if (!type) {
      warn(lit.value, "not a png, jpg, gif, webp, svg or avif file");
      continue;
    }
    const sib = resolveSibling(dir, rel, MAX_INLINE_BYTES);
    if (!sib.ok) {
      const why = { missing: "no such file next to the page", outside: "it is outside the page's folder", hidden: "hidden files are never read", "too-large": "it is over 10 MB" }[sib.reason];
      warn(lit.value, why);
      continue;
    }
    let bytes: Buffer;
    try {
      bytes = fs.readFileSync(sib.file);
    } catch {
      warn(lit.value, "it cannot be read (permissions?)");
      continue;
    }
    out += program.slice(at, lit.start) + JSON.stringify(`data:${type};base64,${bytes.toString("base64")}`);
    at = lit.end;
  }
  return out + program.slice(at);
}

/** @param dir the folder the page's relative image paths are read from */
export function exportHtml(html: string, dir: string): { html: string; notices: string[] } {
  const art = readArtifact(html);
  const notices: string[] = [];
  if (art.program == null) throw new Error('no <script type="text/openui"> block');
  let tags = inlineScript(fs.readFileSync(assetPath("austere.js"), "utf8"));
  // Packs register with the runtime, so they come after it.
  for (const p of implicitPacks(art.program)) tags += "\n" + inlineScript(fs.readFileSync(path.join(p.dir, "pack.js"), "utf8"));
  const packs = pagePacks(html);
  for (const p of packs.installed) tags += "\n" + inlineScript(fs.readFileSync(path.join(p.dir, "pack.js"), "utf8"));
  for (const p of [...packs.missing, ...packs.mismatched]) {
    notices.push(`Pack ${p.name}@${p.version} is not installed here, so the exported page loads it from the CDN (needs network).`);
  }
  const inlined = inlineImages(art.program, dir, notices);
  const withImages = inlined === art.program ? html : html.slice(0, art.programStart) + inlined + html.slice(art.programEnd);
  // Function replacement: the bundles contain "$&"-like sequences.
  return { html: rewriteRuntime(withImages, () => tags), notices };
}
