// Standalone export: one HTML file that renders offline, with the runtime
// (and Mermaid, when the program uses it) inlined. No network fetches.
import fs from "node:fs";
import { readArtifact, rewriteRuntime } from "./artifact.js";
import { assetPath } from "./paths.js";

function inlineScript(code) {
  // A literal "</script" inside the bundle would end the tag early.
  return `<script>${code.replace(/<\/script/gi, "<\\/script")}</script>`;
}

export function exportHtml(html) {
  const art = readArtifact(html);
  const notices = [];
  if (art.program == null) throw new Error('no <script type="text/openui"> block');
  let tags = "";
  if (/\bMermaid\s*\(/.test(art.program)) {
    tags += inlineScript(fs.readFileSync(assetPath("mermaid.min.js"), "utf8")) + "\n";
  }
  tags += inlineScript(fs.readFileSync(assetPath("austere.js"), "utf8"));
  // Function replacement: the bundles contain "$&"-like sequences.
  const out = rewriteRuntime(html, () => tags);
  const rel = art.program.match(/Image\([^)]*?["'](?!https?:|data:)([^"']+\.(?:png|jpe?g|gif|webp|svg|avif))["']/gi);
  if (rel) notices.push("Images referenced by relative path are not inlined; keep them next to the exported file.");
  return { html: out, notices };
}
