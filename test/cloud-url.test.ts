// The test host the CLI once defaulted to refuses requests ("host not allowed"), so a new user's
// first `publish` failed (RLM-384). Nothing the package or its guides ship may name it again.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { DEFAULT_CLOUD_URL } from "../src/cli/cloud.ts";

const TEST_HOST = ["austere", "kasat", "xyz"].join(".");
const ROOTS = ["src", "docs", "skills", "site", "types", "scripts", "examples", "packs", "test", "README.md", "AGENTS.md", "CONTRIBUTING.md"];
const SKIP = ["node_modules", "dist", ".git"];

function* files(p: string): Generator<string> {
  const stat = fs.statSync(p, { throwIfNoEntry: false });
  if (!stat) return;
  if (stat.isFile()) return yield p;
  for (const e of fs.readdirSync(p, { withFileTypes: true })) {
    if (!SKIP.includes(e.name)) yield* files(path.join(p, e.name));
  }
}

test("no shipped file or guide names the old test host; the default is the live service", () => {
  const hits = [];
  for (const root of ROOTS) {
    for (const f of files(root)) {
      if (fs.readFileSync(f, "utf8").includes(TEST_HOST)) hits.push(f);
    }
  }
  assert.deepEqual(hits, [], `use https://austere.blundertech.com instead of ${TEST_HOST}`);
  assert.equal(DEFAULT_CLOUD_URL, "https://austere.blundertech.com");
});
