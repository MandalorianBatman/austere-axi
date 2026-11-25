// `austere-axi/hub-api` (types/hub-api.d.ts) is generated from src/shared/hub-api.ts; a stale copy would let
// austere-cloud's adapter type-check against an old shape.
import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";
import { hubApiDeclarations } from "../scripts/hub-api-types.ts";

test("types/hub-api.d.ts is current (npm run hub-api-types)", () => {
  assert.equal(fs.readFileSync("types/hub-api.d.ts", "utf8"), hubApiDeclarations());
});

test("the shared source is types only: nothing in it exists at runtime", () => {
  const code = fs
    .readFileSync("src/shared/hub-api.ts", "utf8")
    .split("\n")
    .filter((l) => /^export (const|let|var|function|class|enum)\b/.test(l));
  assert.deepEqual(code, []);
});
