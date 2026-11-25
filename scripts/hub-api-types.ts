// Writes types/hub-api.d.ts ("austere-axi/hub-api"): the `/hub/api` types of src/shared/hub-api.ts, so austere-cloud's
// adapter type-checks against what the hub shell reads. The source is types only (no runtime export: the package has
// no JavaScript for it). `npm run hub-api-types` rewrites it; test/hub-api-types.test.ts fails when it is stale.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export function hubApiDeclarations(): string {
  // A Windows checkout has CRLF endings: the generated file is LF either way.
  const src = fs
    .readFileSync(path.join(ROOT, "src/shared/hub-api.ts"), "utf8")
    .replace(/\r\n/g, "\n");
  return `// Generated from src/shared/hub-api.ts by scripts/hub-api-types.ts: do not edit. Run \`npm run hub-api-types\`.\n${src}`;
}

if (process.argv[1] === fileURLToPath(import.meta.url))
  fs.writeFileSync(path.join(ROOT, "types/hub-api.d.ts"), hubApiDeclarations());
