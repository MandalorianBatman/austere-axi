import assert from "node:assert/strict";
import fs from "node:fs";
import { before, test } from "node:test";
import { loadLibrary } from "../scripts/lib/plugins.ts";
import type { LoadedLibrary } from "../scripts/lib/plugins.ts";

process.env.OPENUI_TELEMETRY_DISABLED = "1";

let lib: LoadedLibrary;
before(async () => {
  lib = await loadLibrary();
});

/** The coverage table of docs/diagrams.md: upstream type, the names in the austere-axi column, status. */
function coverage() {
  const rows = fs
    .readFileSync("docs/diagrams.md", "utf8")
    .split("\n")
    .filter((l) => l.startsWith("| ") && !l.startsWith("| Upstream") && !l.startsWith("|---"))
    .map((l) => l.split("|").map((c) => c.trim()))
    .filter((c) => c.length >= 6);
  return rows.map((c) => ({
    upstream: c[1],
    names: [...c[2].matchAll(/`(\w+)`/g)].map((m) => m[1]),
    status: c[4],
  }));
}

test("docs/diagrams.md lists the 52 upstream types, and 50 of them as built", () => {
  const rows = coverage();
  assert.equal(rows.length, 52);
  assert.deepEqual(
    rows.filter((r) => r.status === "not planned").map((r) => r.upstream),
    ["Exploded axonometric", "Axonometric plan"],
  );
  assert.equal(rows.filter((r) => r.status === "built").length, 50);
});

test("every built row names a component or recipe the catalog has", () => {
  const known = new Set([
    ...lib.CUSTOM_COMPONENTS.map((c) => c.name),
    ...lib.RECIPES.map((r) => r.name),
    ...Object.keys(lib.austereLibrary.components),
  ]);
  for (const row of coverage().filter((r) => r.status === "built")) {
    assert.ok(row.names.length, `${row.upstream} names no component`);
    for (const name of row.names)
      assert.ok(known.has(name), `${row.upstream}: ${name} is not a component or recipe`);
  }
});

test("every Diagrams component and recipe has a row", () => {
  const listed = new Set(coverage().flatMap((r) => r.names));
  const missing = [
    ...lib.CUSTOM_COMPONENTS.filter((c) => c.group === "Diagrams").map((c) => c.name),
    ...lib.RECIPES.filter((r) => r.group === "Diagrams").map((r) => r.name),
  ].filter((n) => !listed.has(n));
  assert.deepEqual(missing, [], `in the Diagrams group but not in docs/diagrams.md`);
});
