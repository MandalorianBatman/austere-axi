// @ts-check
// Standalone export: one HTML file that renders offline, with the runtime
// (Mermaid and every pack the page uses, too) inlined. No network fetches.
import fs from "node:fs";
import path from "node:path";
import { readArtifact, rewriteRuntime } from "./artifact.js";
import { assetPath } from "./paths.js";
import { implicitPacks, pagePacks } from "./packs.js";

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
  // Packs register with the runtime, so they come after it.
  for (const p of implicitPacks(art.program)) tags += "\n" + inlineScript(fs.readFileSync(path.join(p.dir, "pack.js"), "utf8"));
  const packs = pagePacks(html);
  for (const p of packs.installed) tags += "\n" + inlineScript(fs.readFileSync(path.join(p.dir, "pack.js"), "utf8"));
  for (const p of [...packs.missing, ...packs.mismatched]) {
    notices.push(`Pack ${p.name}@${p.version} is not installed here, so the exported page loads it from the CDN (needs network).`);
  }
  // Function replacement: the bundles contain "$&"-like sequences.
  const out = rewriteRuntime(html, () => tags);
  const rel = art.program.match(/Image\([^)]*?["'](?!https?:|data:)([^"']+\.(?:png|jpe?g|gif|webp|svg|avif))["']/gi);
  if (rel) notices.push("Images referenced by relative path are not inlined; keep them next to the exported file.");
  return { html: out, notices };
}
