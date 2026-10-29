// Guards for the component library. These are the rules a maintainer can
// break without noticing; see .agents/skills/add-component/SKILL.md.
import assert from "node:assert/strict";
import { before, test } from "node:test";
import { defineComponent } from "@openuidev/react-lang";
import { z } from "zod";
import { checkHtml } from "../src/cli/check.js";
import { estimateTokens, examplePage, htmlPage, loadLibrary } from "../scripts/lib/plugins.mjs";
import { compareSignatures, readSnapshot, signaturesOf } from "../scripts/lib/signatures.mjs";

// Every agent pays for the component reference on every `spec` read. Raise
// this only as a deliberate decision, in the same change that needs it.
// 6500 → 6600: Architecture lanes, tones and row pins (6362 → ~6550 tokens).
// 6600 → 5800: rare stock components leave the prompt (tier "extended", found
// with `components search|show`), ~6550 → ~5765 tokens.
const PROMPT_BUDGET_TOKENS = 5800;
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

/** Top-level parameters of a signature: [{ name, optional, type }]. */
function params(signature) {
  const inner = signature.slice(signature.indexOf("(") + 1, signature.lastIndexOf(")"));
  const out = [];
  let depth = 0;
  let cur = "";
  for (const ch of inner) {
    if ("([{<".includes(ch)) depth++;
    if (")]}>".includes(ch)) depth--;
    if (ch === "," && depth === 0) {
      out.push(cur.trim());
      cur = "";
    } else cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out.map((p) => /^(\w+)(\?)?:\s*([\s\S]*)$/.exec(p)).filter(Boolean).map(([, name, q, type]) => ({ name, optional: !!q, type }));
}

test("a component the spec leaves out is never the only way to fill a required prop of one it keeps", () => {
  const spec = lib.austereLibrary.toSpec();
  const extended = new Set(Object.keys(lib.TIERS));
  for (const [name, c] of Object.entries(spec.components)) {
    if (extended.has(name)) continue;
    for (const p of params(c.signature)) {
      if (p.optional) continue;
      const refs = [...p.type.matchAll(/\b([A-Z][A-Za-z0-9]*)\b/g)].map((m) => m[1]).filter((n) => spec.components[n]);
      if (refs.length && refs.every((n) => extended.has(n))) {
        assert.fail(`${name}(${p.name}) takes only ${refs.join(" | ")}, which are all out of the spec; keep one of them in it`);
      }
    }
  }
});

test("a pack component whose slot the library cannot place keeps its other slots, and the page still renders", () => {
  const skipped = [];
  const zed = {
    name: "Zed",
    group: "Content",
    notes: [],
    tagged: true,
    slots: ["Nope.children", "Card.children"],
    definition: defineComponent({ name: "Zed", props: z.object({ text: z.string() }), description: "test", component: () => null }),
  };
  const withZed = lib.buildLibrary([zed], { onSkip: (c, message) => skipped.push(message) });
  assert.ok(withZed.components.Zed);
  assert.match(skipped.join("\n"), /Nope/);
  assert.match(JSON.stringify(withZed.toJSONSchema().$defs.Card), /#\/\$defs\/Zed/);
  assert.deepEqual(zed.slots, ["Nope.children", "Card.children"], "the pack's own component is not mutated");
  // A pack component named like a core one is skipped, not fatal.
  const dup = { ...zed, name: "Card", slots: null };
  const notes = [];
  lib.buildLibrary([dup], { onSkip: (c, message) => notes.push(message) });
  assert.match(notes.join(), /already defined/);
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

test("the gallery of every example (and of every stress example) passes check without warnings", () => {
  // Examples share one page in the gallery and the browser suite, so their
  // statement names must not collide.
  const schema = lib.schema();
  for (const field of ["example", "stress"]) {
    const r = checkHtml(htmlPage("gallery", examplePage(lib.CUSTOM_COMPONENTS, field), "austere.js"), { schema });
    assert.equal(r.ok, true, `${field}: ${JSON.stringify(r.errors)}`);
    const warnings = field === "stress" ? r.warnings.filter((w) => w.code !== "architecture-layout") : r.warnings;
    assert.deepEqual(warnings, [], `${field} warnings: ${JSON.stringify(r.warnings)}`);
  }
});

test("every custom component example and stress example passes check", () => {
  const schema = lib.schema();
  for (const c of lib.CUSTOM_COMPONENTS) {
    for (const field of ["example", "stress"]) {
      if (!c[field]) continue;
      const r = checkHtml(htmlPage(c.name, examplePage([c], field), "austere.js"), { schema });
      assert.equal(r.ok, true, `${c.name} ${field}: ${JSON.stringify(r.errors)}`);
      // Stress examples are oversized on purpose; a layout warning is expected there.
      const warnings = field === "stress" ? r.warnings.filter((w) => w.code !== "architecture-layout") : r.warnings;
      assert.deepEqual(warnings, [], `${c.name} ${field} warnings: ${JSON.stringify(r.warnings)}`);
    }
  }
});
