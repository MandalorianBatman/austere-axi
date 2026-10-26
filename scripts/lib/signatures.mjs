// Stored artifacts call components with POSITIONAL arguments, so a released
// component's prop order is a contract: props may only be appended (and must
// be optional), never reordered, renamed or removed. test/fixtures/signatures.json
// records the released order; `npm run signatures` adds new components and
// appended props, and refuses anything else.
import fs from "node:fs";
import path from "node:path";
import { ROOT } from "./plugins.mjs";

export const SIGNATURES_FILE = path.join(ROOT, "test/fixtures/signatures.json");

/** { Name: { props: [...], required: [...] } } from a library JSON schema. */
export function signaturesOf(schema) {
  const out = {};
  for (const [name, def] of Object.entries(schema.$defs || {})) {
    if (!def || def.type !== "object" || !def.properties) continue;
    out[name] = { props: Object.keys(def.properties), required: def.required || [] };
  }
  return out;
}

export function readSnapshot() {
  try {
    return JSON.parse(fs.readFileSync(SIGNATURES_FILE, "utf8"));
  } catch {
    return {};
  }
}

/**
 * @returns {{ errors: string[], added: string[], appended: string[], next: object }}
 *   errors: contract violations; added/appended: what a snapshot update would record.
 */
export function compareSignatures(snapshot, current) {
  const errors = [];
  const added = [];
  const appended = [];
  const next = JSON.parse(JSON.stringify(snapshot));
  for (const [name, old] of Object.entries(snapshot)) {
    const cur = current[name];
    if (!cur) {
      errors.push(`${name} was removed. Stored artifacts that use it would stop rendering; keep it (it can leave its prompt group's notes) or bump the major version.`);
      continue;
    }
    const prefix = cur.props.slice(0, old.props.length);
    if (prefix.join(",") !== old.props.join(",")) {
      errors.push(`${name}(${old.props.join(", ")}) became ${name}(${cur.props.join(", ")}). Props are positional: only append new optional props at the end.`);
      continue;
    }
    const extra = cur.props.slice(old.props.length);
    const requiredExtra = extra.filter((p) => cur.required.includes(p));
    if (requiredExtra.length) {
      errors.push(`${name}: appended prop(s) ${requiredExtra.join(", ")} must be optional, since stored calls do not pass them.`);
      continue;
    }
    if (extra.length) {
      appended.push(`${name}: +${extra.join(", +")}`);
      next[name] = { props: cur.props, required: old.required };
    }
  }
  for (const [name, cur] of Object.entries(current)) {
    if (!snapshot[name]) {
      added.push(name);
      next[name] = cur;
    }
  }
  return { errors, added, appended, next };
}

export function writeSnapshot(next) {
  // One component per line so a diff shows exactly which signature changed.
  const lines = Object.keys(next)
    .sort()
    .map((k) => `  ${JSON.stringify(k)}: ${JSON.stringify(next[k])}`);
  fs.mkdirSync(path.dirname(SIGNATURES_FILE), { recursive: true });
  fs.writeFileSync(SIGNATURES_FILE, `{\n${lines.join(",\n")}\n}\n`);
}
