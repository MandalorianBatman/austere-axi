// @ts-check
// Reading and rewriting artifact HTML files. An artifact is an ordinary HTML
// file with one runtime <script src=".../austere.js"> tag and one
// <script type="text/openui"> block holding the program.

export const CDN_RUNTIME_URL = "https://cdn.jsdelivr.net/npm/austere-axi@0/dist/austere.js";

const PROGRAM_RE = /(<script\b[^>]*\btype\s*=\s*["']text\/openui(?:-lang)?["'][^>]*>)([\s\S]*?)(<\/script\s*>)/i;
const RUNTIME_RE = /<script\b[^>]*\bsrc\s*=\s*["']([^"']*\/austere(?:\.min)?\.js(?:\?[^"']*)?|austere(?:\.min)?\.js)["'][^>]*>\s*<\/script\s*>/i;
const TITLE_RE = /<title[^>]*>([\s\S]*?)<\/title\s*>/i;

export function skeleton(title = "Artifact") {
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

/**
 * @returns {{ program: string|null, programStart: number, programEnd: number, programLine: number,
 *   runtimeSrc: string|null, title: string, shell: string }}
 */
export function readArtifact(html) {
  const text = String(html);
  const m = PROGRAM_RE.exec(text);
  const rt = RUNTIME_RE.exec(text);
  const t = TITLE_RE.exec(text);
  let program = null;
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
export function lineAt(text, offset) {
  let line = 1;
  for (let i = 0; i < offset && i < text.length; i++) if (text.charCodeAt(i) === 10) line++;
  return line;
}

export function replaceProgram(html, program) {
  const text = String(html);
  const m = PROGRAM_RE.exec(text);
  if (!m) throw new Error('no <script type="text/openui"> block to patch');
  const body = program.startsWith("\n") ? program : `\n${program}`;
  const tail = body.endsWith("\n") ? body : `${body}\n`;
  return text.slice(0, m.index) + m[1] + tail + m[3] + text.slice(m.index + m[0].length);
}

/** Point the runtime tag at another URL (local server, or nothing when inlined). */
export function rewriteRuntime(html, replacement) {
  const text = String(html);
  const rep = typeof replacement === "function" ? replacement() : replacement;
  if (RUNTIME_RE.test(text)) return text.replace(RUNTIME_RE, () => rep);
  // No runtime tag: inject one so the page still renders under review.
  if (/<\/head\s*>/i.test(text)) return text.replace(/<\/head\s*>/i, () => `${rep}\n</head>`);
  return rep + "\n" + text;
}

export function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

function decodeEntities(s) {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&");
}
