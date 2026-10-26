// Guards for the component library. These are the rules a maintainer can
// break without noticing; see .agents/skills/add-component/SKILL.md.
import assert from "node:assert/strict";
import { before, test } from "node:test";
import { checkHtml } from "../src/cli/check.js";
import { estimateTokens, examplePage, htmlPage, loadLibrary } from "../scripts/lib/plugins.mjs";
import { compareSignatures, readSnapshot, signaturesOf } from "../scripts/lib/signatures.mjs";

// Every agent pays for the component reference on every `spec` read. Raise
// this only as a deliberate decision, in the same change that needs it.
const PROMPT_BUDGET_TOKENS = 6500;
const DESCRIPTION_MAX_CHARS = 280;

let lib;
before(async () => {
  lib = await loadLibrary();
});

test("every component is in exactly one prompt group", () => {
  const names = Object.keys(lib.austereLibrary.components);
  const seen = new Map();
  for (const g of lib.GROUPS) {
    for (const n of g.components) {
      assert.ok(names.includes(n), `group ${g.name} lists ${n}, which is not in the library`);
      assert.ok(!seen.has(n), `${n} is in both ${seen.get(n)} and ${g.name}`);
      seen.set(n, g.name);
    }
  }
  const missing = names.filter((n) => !seen.has(n));
  assert.deepEqual(missing, [], `not in any group (they would land under "### Other"): ${missing.join(", ")}`);
  assert.doesNotMatch(lib.prompt(), /^### Other$/m);
});

test(`component reference stays within ${PROMPT_BUDGET_TOKENS} tokens`, () => {
  const tokens = estimateTokens(lib.prompt());
  assert.ok(tokens <= PROMPT_BUDGET_TOKENS, `prompt is ~${tokens} tokens, over the ${PROMPT_BUDGET_TOKENS} budget`);
});

test("released prop orders are append-only", () => {
  const { errors, added, appended } = compareSignatures(readSnapshot(), signaturesOf(lib.schema()));
  assert.deepEqual(errors, [], errors.join("\n"));
  const pending = [...added, ...appended];
  assert.deepEqual(pending, [], `not recorded in test/fixtures/signatures.json; run \`npm run signatures\`: ${pending.join(", ")}`);
});

test("custom components have short descriptions", () => {
  for (const c of lib.CUSTOM_COMPONENTS) {
    const d = lib.austereLibrary.components[c.name].description;
    assert.ok(d.length <= DESCRIPTION_MAX_CHARS, `${c.name} description is ${d.length} chars (max ${DESCRIPTION_MAX_CHARS})`);
  }
});

test("every custom component example and stress example passes check", () => {
  const schema = lib.schema();
  for (const c of lib.CUSTOM_COMPONENTS) {
    for (const field of ["example", "stress"]) {
      if (!c[field]) continue;
      const r = checkHtml(htmlPage(c.name, examplePage([c], field), "austere.js"), { schema });
      assert.equal(r.ok, true, `${c.name} ${field}: ${JSON.stringify(r.errors)}`);
      assert.deepEqual(r.warnings, [], `${c.name} ${field} warnings: ${JSON.stringify(r.warnings)}`);
    }
  }
});
