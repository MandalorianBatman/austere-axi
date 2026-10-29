// Loading component packs into a page, before it renders.
//
// A page names the packs it needs in its head:
//   <meta name="austere-packs" content="austere-pack-gantt@1.2.0 sha384-…, other@0.3.1">
// Packs bundled with austere-axi (Mermaid) need no tag: they load when the
// program calls one of their components, so older pages keep working.
import bundledPacks from "austere:bundled-packs";
import { RUNTIME_BASE, assetUrl } from "./env.js";
import { registeredPacks } from "./pack-api.js";
import { parsePacksMeta } from "../shared/packs-meta.js";

export { parsePacksMeta };

const CDN = "https://cdn.jsdelivr.net/npm";

/** The packs this page declares, from its <meta name="austere-packs">. */
export function declaredPacks(doc = document) {
  const meta = doc.querySelector('meta[name="austere-packs"]');
  return meta ? parsePacksMeta(meta.getAttribute("content") || "") : [];
}

/** Declared packs plus the bundled packs whose components the program calls. */
export function packsFor(program, declared) {
  const out = [...declared];
  for (const [id, b] of Object.entries(bundledPacks)) {
    if (out.some((p) => p.name === b.name)) continue;
    if (b.components.some((n) => new RegExp(`\\b${n}\\s*\\(`).test(program))) out.push({ name: b.name, version: b.version, bundled: id });
  }
  return out;
}

function served() {
  return /\/__austere\/$/.test(RUNTIME_BASE);
}

/**
 * Where a pack's script comes from, and the integrity the browser checks:
 *   bundled    next to the runtime (or the CDN copy of this austere-axi version)
 *   installed  from the review server, which checks the hash against its lockfile
 *              (an opaque-origin page cannot make the CORS request SRI needs)
 *   otherwise  the npm CDN, with Subresource Integrity when the tag gives a hash
 */
export function packSource(p) {
  if (p.bundled) {
    return { src: assetUrl(`packs/${p.bundled}/pack.js`) || `${CDN}/austere-axi@${p.version}/dist/packs/${p.bundled}/pack.js` };
  }
  if (served()) {
    const q = p.integrity ? `?integrity=${encodeURIComponent(p.integrity)}` : "";
    return { src: `${RUNTIME_BASE}installed-packs/${encodeURIComponent(`${p.name}@${p.version}`)}/pack.js${q}` };
  }
  return { src: `${CDN}/${p.name}@${p.version}/dist/pack.js`, integrity: p.integrity };
}

function loadScript(src, integrity) {
  return new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = src;
    s.async = true;
    if (integrity) {
      s.integrity = integrity;
      s.crossOrigin = "anonymous";
    }
    s.onload = () => resolve();
    s.onerror = () => reject(new Error(`could not load ${src}`));
    document.head.appendChild(s);
  });
}

/**
 * Load the packs not registered yet (an exported page has them inline).
 * Never rejects: a pack that fails is reported and the page renders without it.
 */
export async function loadPacks(list, { onError } = {}) {
  const missing = list.filter((p) => !registeredPacks().some((r) => r.name === p.name));
  await Promise.all(
    missing.map((p) => {
      const { src, integrity } = packSource(p);
      return loadScript(src, integrity).then(
        () => {
          if (!registeredPacks().some((r) => r.name === p.name)) {
            onError?.(p, new Error(`${src} loaded but did not register pack ${p.name}`));
          }
        },
        (err) => onError?.(p, err),
      );
    }),
  );
  return registeredPacks();
}

/** Add each pack's CSS to the page once. */
export function injectPackStyles(packs) {
  for (const p of packs) {
    if (!p.css) continue;
    const id = `austere-pack-css-${p.name.replace(/[^a-z0-9]/gi, "-")}`;
    if (document.getElementById(id)) continue;
    const style = document.createElement("style");
    style.id = id;
    style.textContent = p.css;
    document.head.appendChild(style);
  }
}
