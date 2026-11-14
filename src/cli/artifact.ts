// Reading and rewriting artifact HTML files. An artifact is an ordinary HTML
// file with one runtime <script src=".../austere.js"> tag and one
// <script type="text/openui"> block holding the program.

export const CDN_RUNTIME_URL = "https://cdn.jsdelivr.net/npm/austere-axi@0/dist/austere.js";

const PROGRAM_RE = /(<script\b[^>]*\btype\s*=\s*["']text\/openui(?:-lang)?["'][^>]*>)([\s\S]*?)(<\/script\s*>)/i;
const RUNTIME_RE = /<script\b[^>]*\bsrc\s*=\s*["']([^"']*\/austere(?:\.min)?\.js(?:\?[^"']*)?|austere(?:\.min)?\.js)["'][^>]*>\s*<\/script\s*>/i;
const TITLE_RE = /<title[^>]*>([\s\S]*?)<\/title\s*>/i;
/** `export` marks the scripts it inlines (and their loader) with this attribute. */
export const INLINE_ATTR = "data-austere-inline";
// Exports from before INLINE_ATTR carry the runtime as a plain inline script, which ends by setting `window.__austere`.
const INLINE_RUNTIME_RE = new RegExp(`<script\\b[^>]*\\b${INLINE_ATTR}\\b|window\\.__austere\\s*=\\s*\\{`);

export function skeleton(title = "Artifact"): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${escapeHtml(title)}</title>
<script src="${CDN_RUNTIME_URL}"></script>
</head>
<body>
<script type="text/openui">
root = Stack([intro], "column", "l")
intro = Card([CardHeader("${title.replace(/"/g, '\\"')}")])
</script>
</body>
</html>
`;
}

export interface Artifact {
  program: string | null;
  programStart: number;
  programEnd: number;
  programLine: number;
  runtimeSrc: string | null;
  title: string;
  shell: string;
}

export function readArtifact(html: string): Artifact {
  const text = String(html);
  const m = PROGRAM_RE.exec(text);
  const rt = RUNTIME_RE.exec(text);
  const t = TITLE_RE.exec(text);
  let program: string | null = null;
  let programStart = -1;
  let programEnd = -1;
  let programLine = 0;
  let shell = text;
  if (m) {
    programStart = m.index + m[1].length;
    programEnd = programStart + m[2].length;
    program = m[2];
    programLine = lineAt(text, programStart);
    shell = text.slice(0, programStart) + text.slice(programEnd);
  }
  return {
    program,
    programStart,
    programEnd,
    programLine,
    runtimeSrc: rt ? rt[1] : null,
    title: t ? decodeEntities(t[1].trim()) : "",
    shell,
  };
}

/** 1-based line number of a character offset. */
export function lineAt(text: string, offset: number): number {
  let line = 1;
  for (let i = 0; i < offset && i < text.length; i++) if (text.charCodeAt(i) === 10) line++;
  return line;
}

export function replaceProgram(html: string, program: string): string {
  const text = String(html);
  const m = PROGRAM_RE.exec(text);
  if (!m) throw new Error('no <script type="text/openui"> block to patch');
  const body = program.startsWith("\n") ? program : `\n${program}`;
  const tail = body.endsWith("\n") ? body : `${body}\n`;
  return text.slice(0, m.index) + m[1] + tail + m[3] + text.slice(m.index + m[0].length);
}

/** Is this an exported copy, with the runtime inlined instead of a runtime tag? */
export function hasInlineRuntime(html: string): boolean {
  return !RUNTIME_RE.test(html) && INLINE_RUNTIME_RE.test(html);
}

/**
 * Point the runtime tag at another URL (local server, or nothing when inlined). An exported copy
 * (runtime already inlined) is left as it is: a second runtime would render the page twice.
 */
export function rewriteRuntime(html: string, replacement: string | (() => string)): string {
  const text = String(html);
  if (RUNTIME_RE.test(text)) {
    const rep = typeof replacement === "function" ? replacement() : replacement;
    return text.replace(RUNTIME_RE, () => rep);
  }
  if (INLINE_RUNTIME_RE.test(text)) return text;
  const rep = typeof replacement === "function" ? replacement() : replacement;
  // No runtime tag: inject one so the page still renders under review.
  if (/<\/head\s*>/i.test(text)) return text.replace(/<\/head\s*>/i, () => `${rep}\n</head>`);
  return rep + "\n" + text;
}

const ENTITIES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

export function escapeHtml(s: unknown): string {
  return String(s).replace(/[&<>"']/g, (c) => ENTITIES[c]);
}

function decodeEntities(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&");
}
