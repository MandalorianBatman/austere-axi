// The <meta name="austere-packs"> tag: which component packs a page needs.
//   content="austere-pack-gantt@1.2.0 sha384-…, @acme/austere-pack-flows@0.3.1"
// One entry per pack, comma-separated: name@version, then optionally the
// Subresource Integrity hash of its pack.js. Shared by the runtime and the CLI.

export const PACKS_META_RE = /<meta\s+name=["']austere-packs["']\s+content=["']([^"']*)["']\s*\/?>/i;

/** Split "name@version" (the name may be scoped: "@scope/name@1.0.0"). */
export function splitSpec(spec) {
  const at = spec.lastIndexOf("@");
  if (at <= 0) return { name: spec, version: "" };
  return { name: spec.slice(0, at), version: spec.slice(at + 1) };
}

const NAME_RE = /^(@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;
const VERSION_RE = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;

/** @returns {{ name: string, version: string, integrity?: string }[]} entries that parse; the rest are dropped */
export function parsePacksMeta(content) {
  const out = [];
  for (const part of String(content || "").split(",")) {
    const [spec, integrity] = part.trim().split(/\s+/);
    if (!spec) continue;
    const { name, version } = splitSpec(spec);
    if (!NAME_RE.test(name) || !VERSION_RE.test(version)) continue;
    if (out.some((p) => p.name === name)) continue;
    out.push(integrity && /^sha(256|384|512)-[A-Za-z0-9+/=]+$/.test(integrity) ? { name, version, integrity } : { name, version });
  }
  return out;
}

export function formatPacksMeta(packs) {
  return packs.map((p) => `${p.name}@${p.version}${p.integrity ? ` ${p.integrity}` : ""}`).join(", ");
}

export function isValidPackName(name) {
  return NAME_RE.test(name);
}

export function isValidVersion(version) {
  return VERSION_RE.test(version);
}
