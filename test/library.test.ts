// Guards for the component library. These are the rules a maintainer can
// break without noticing; see .agents/skills/add-component/SKILL.md.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { before, test } from "node:test";
import { defineComponent } from "@openuidev/react-lang";
import { z } from "zod";
import { checkHtml } from "../src/cli/check.ts";
import { austereComponent } from "../src/runtime/define.ts";
import { estimateTokens, examplePage, htmlPage, loadLibrary } from "../scripts/lib/plugins.ts";
import type { LoadedLibrary } from "../scripts/lib/plugins.ts";
import type { AustereComponent } from "../types/pack.d.ts";
import { compareSignatures, readSnapshot, signaturesOf } from "../scripts/lib/signatures.ts";

// Every agent pays for the component reference on every `spec` read. Raise
// this only as a deliberate decision, in the same change that needs it.
// 6500 → 6600: Architecture lanes, tones and row pins (6362 → ~6550 tokens).
// 6600 → 5800: rare stock components leave the prompt (tier "extended", found
// with `components search|show`), ~6550 → ~5765 tokens.
// 5800 → 5950: the shadcn pack's names join the slot unions and the "Also in"
// lines (~5765 → ~5905 tokens).
const PROMPT_BUDGET_TOKENS = 5950;
const DESCRIPTION_MAX_CHARS = 280;
// Every agent reads `--help` once per session, before spec. 1100: one loop, owner-only rows
// in `help all` (RLM-380; ~1418 → ~1083 tokens). 1160: step 0, `find` (RLM-353), and the
// `outline`/`show` line (RLM-351): ~1098 → ~1154.
const HELP_BUDGET_TOKENS = 1160;

let lib: LoadedLibrary;
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
  assert.deepEqual(
    missing,
    [],
    `not in any group (they would land under "### Other"): ${missing.join(", ")}`,
  );
  assert.doesNotMatch(lib.prompt(), /^### Other$/m);
});

test(`component reference stays within ${PROMPT_BUDGET_TOKENS} tokens`, () => {
  const tokens = estimateTokens(lib.prompt());
  assert.ok(
    tokens <= PROMPT_BUDGET_TOKENS,
    `prompt is ~${tokens} tokens, over the ${PROMPT_BUDGET_TOKENS} budget`,
  );
});

test(`--help stays within ${HELP_BUDGET_TOKENS} tokens`, () => {
  const state = fs.mkdtempSync(path.join(os.tmpdir(), "austere-help-"));
  try {
    const r = spawnSync(process.execPath, ["src/cli/main.ts", "--help"], {
      encoding: "utf8",
      env: { ...process.env, AUSTERE_AXI_STATE_DIR: state },
    });
    assert.equal(r.status, 0, r.stderr);
    const tokens = estimateTokens(r.stdout);
    assert.ok(
      tokens <= HELP_BUDGET_TOKENS,
      `--help is ~${tokens} tokens, over the ${HELP_BUDGET_TOKENS} budget`,
    );
  } finally {
    fs.rmSync(state, { recursive: true, force: true });
  }
});

/** Top-level parameters of a signature: [{ name, optional, type }]. */
function params(signature: string) {
  const inner = signature.slice(signature.indexOf("(") + 1, signature.lastIndexOf(")"));
  const out: string[] = [];
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
  return out
    .map((p) => /^(\w+)(\?)?:\s*([\s\S]*)$/.exec(p))
    .filter((m) => m !== null)
    .map(([, name, q, type]) => ({ name, optional: !!q, type }));
}

test("a component the spec leaves out is never the only way to fill a required prop of one it keeps", () => {
  const spec = lib.austereLibrary.toSpec();
  const extended = new Set(Object.keys(lib.TIERS));
  for (const [name, c] of Object.entries(spec.components)) {
    if (extended.has(name)) continue;
    for (const p of params(c.signature)) {
      if (p.optional) continue;
      const refs = [...p.type.matchAll(/\b([A-Z][A-Za-z0-9]*)\b/g)]
        .map((m) => m[1])
        .filter((n) => spec.components[n]);
      if (refs.length && refs.every((n) => extended.has(n))) {
        assert.fail(
          `${name}(${p.name}) takes only ${refs.join(" | ")}, which are all out of the spec; keep one of them in it`,
        );
      }
    }
  }
});

test("a pack component whose slot the library cannot place keeps its other slots, and the page still renders", () => {
  const skipped: string[] = [];
  const zed = {
    name: "Zed",
    group: "Content",
    notes: [],
    tagged: true,
    slots: ["Nope.children", "Card.children"],
    definition: defineComponent({
      name: "Zed",
      props: z.object({ text: z.string() }),
      description: "test",
      component: () => null,
    }),
  } as unknown as AustereComponent;
  const withZed = lib.buildLibrary([zed], { onSkip: (c, message) => skipped.push(message) });
  assert.ok(withZed.components.Zed);
  assert.match(skipped.join("\n"), /Nope/);
  assert.match(
    JSON.stringify((withZed.toJSONSchema().$defs as Record<string, unknown>).Card),
    /#\/\$defs\/Zed/,
  );
  assert.deepEqual(
    zed.slots,
    ["Nope.children", "Card.children"],
    "the pack's own component is not mutated",
  );
  // A pack component named like a core one is skipped, not fatal.
  const dup: AustereComponent = { ...zed, name: "Card", slots: null };
  const notes: string[] = [];
  lib.buildLibrary([dup], { onSkip: (c, message) => notes.push(message) });
  assert.match(notes.join(), /already defined/);
});

test("released prop orders are append-only", () => {
  const { errors, added, appended } = compareSignatures(readSnapshot(), signaturesOf(lib.schema()));
  assert.deepEqual(errors, [], errors.join("\n"));
  const pending = [...added, ...appended];
  assert.deepEqual(
    pending,
    [],
    `not recorded in test/fixtures/signatures.json; run \`npm run signatures\`: ${pending.join(", ")}`,
  );
});

test("custom components have short descriptions", () => {
  for (const c of lib.CUSTOM_COMPONENTS) {
    const d = lib.austereLibrary.components[c.name].description;
    assert.ok(
      d !== undefined && d.length <= DESCRIPTION_MAX_CHARS,
      `${c.name} description is ${d?.length} chars (max ${DESCRIPTION_MAX_CHARS})`,
    );
  }
});

const STRESS_NOTES = /^(architecture-layout|flow)$/;

test("the gallery of every example (and of every stress example) passes check without warnings", () => {
  // Examples share one page in the gallery and the browser suite, so their
  // statement names must not collide.
  const schema = lib.schema();
  for (const field of ["example", "stress"] as const) {
    const r = checkHtml(
      htmlPage("gallery", examplePage(lib.CUSTOM_COMPONENTS, field), "austere.js"),
      { schema },
    );
    assert.equal(r.ok, true, `${field}: ${JSON.stringify(r.errors)}`);
    const warnings =
      field === "stress" ? r.warnings.filter((w) => !STRESS_NOTES.test(w.code)) : r.warnings;
    assert.deepEqual(warnings, [], `${field} warnings: ${JSON.stringify(r.warnings)}`);
  }
});

test("every custom component example and stress example passes check", () => {
  const schema = lib.schema();
  for (const c of lib.CUSTOM_COMPONENTS) {
    for (const field of ["example", "stress"] as const) {
      if (!c[field]) continue;
      const r = checkHtml(htmlPage(c.name, examplePage([c], field), "austere.js"), { schema });
      assert.equal(r.ok, true, `${c.name} ${field}: ${JSON.stringify(r.errors)}`);
      // Stress examples are oversized and sloppy on purpose; layout and flow warnings are expected there.
      const warnings =
        field === "stress" ? r.warnings.filter((w) => !STRESS_NOTES.test(w.code)) : r.warnings;
      assert.deepEqual(warnings, [], `${c.name} ${field} warnings: ${JSON.stringify(r.warnings)}`);
    }
  }
});

/** A page with one Card around a program whose first statement is the thing shown. */
function cardPage(title: string, program: string): string {
  const first = program.match(/^\s*([A-Za-z_]\w*)\s*=/)?.[1];
  return htmlPage(
    title,
    `root = Stack([demo], "column", "l")\ndemo = Card([CardHeader(${JSON.stringify(title)}), ${first}])\n${program}`,
    "austere.js",
  );
}

test("every recipe names no component, writes components that exist, and its examples pass check", () => {
  const schema = lib.schema();
  const entries = lib.catalog("").components;
  const components = new Set(entries.filter((e) => !e.uses).map((e) => e.name));
  const recipes = entries.filter((e) => e.uses);
  assert.ok(recipes.length >= 4, "the seed recipes are in the catalog");
  for (const r of recipes) {
    assert.ok(!components.has(r.name), `${r.name} is also a component`);
    assert.equal(r.signature, "");
    assert.ok(r.guide && /^## Use for$/m.test(r.guide), `${r.name} has a guide with "Use for"`);
    assert.equal(r.examples.length, 2, `${r.name} has a minimal and a realistic example`);
    for (const program of r.examples) {
      assert.match(
        program,
        new RegExp(`^\\w+ = ${r.uses?.[0]}\\(`),
        `${r.name} writes ${r.uses?.[0]}`,
      );
      const c = checkHtml(cardPage(r.name, program), { schema });
      assert.equal(c.ok, true, `${r.name}: ${JSON.stringify(c.errors)}`);
      assert.deepEqual(c.warnings, [], `${r.name} warnings: ${JSON.stringify(c.warnings)}`);
    }
  }
});

test("spec prints only core names in content child lists, and one Diagrams line for the other diagram types", () => {
  const prompt = lib.prompt();
  const hidden = new Set([
    ...Object.keys(lib.TIERS),
    ...lib.BUNDLED_PACKS.flatMap((p) => p.components.map((c) => c.name)),
  ]);
  for (const parent of ["Card", "TabItem", "AccordionItem"]) {
    const line = prompt.split("\n").find((l) => l.startsWith(`${parent}(`)) ?? "";
    const listed = /\(([A-Z][^)]*)\)\[\]/.exec(line)?.[1].split(" | ") ?? [];
    assert.ok(listed.length > 5, `${parent} prints its child list`);
    assert.deepEqual(
      listed.filter((n) => hidden.has(n)),
      [],
      `${parent} lists out-of-spec names`,
    );
  }
  const diagrams = prompt.split("\n### Diagrams\n")[1]?.split("\n### ")[0] ?? "";
  assert.match(diagrams, /^Architecture\(/m);
  const more = diagrams.split("\n").filter((l) => l.includes("components list Diagrams"));
  assert.equal(more.length, 1, "one generated line points at the chooser");
  for (const n of ["Steps", "Timeline", "Swimlane"])
    assert.match(more[0], new RegExp(`\\b${n}\\b`));
  assert.doesNotMatch(more[0], /\b(Node|Edge|Group|TimelineItem)\b/, "no value-only parts");
});

test("a component left out of the printed child lists still passes check there", () => {
  const r = checkHtml(cardPage("Progress", `bar = Progress(40, "Migration")`), {
    schema: lib.schema(),
  });
  assert.equal(r.ok, true, JSON.stringify(r.errors));
});

test("a list prop over its catalog limit is a check warning with statement and line", () => {
  const Crowd = austereComponent({
    name: "Crowd",
    group: "Diagrams",
    tier: "extended",
    props: z.object({ items: z.array(z.string()), title: z.string().optional() }),
    description: "test",
    renderer: () => null,
    example: `crowd = Crowd(["a"])`,
    limits: [{ prop: "items", max: 3, message: "Split it into two." }],
  });
  const library = lib.buildLibrary([Crowd]);
  const catalog = lib.catalogFromSpec(library.toSpec(), { details: { Crowd } });
  const limits = Object.fromEntries(
    catalog.components.filter((e) => e.limits).map((e) => [e.name, e.limits ?? []]),
  );
  const schema = { ...library.toJSONSchema(), root: "Stack" };
  const html = cardPage("Crowd", `crowd = Crowd(["a", "b", "c", "d", "e"])`);
  const r = checkHtml(html, { schema, limits });
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  const w = r.warnings.find((x) => x.code === "limit");
  assert.equal(w?.statement, "crowd");
  assert.equal(w?.line, html.split("\n").findIndex((l) => l.startsWith("crowd = ")) + 1);
  assert.match(w?.message ?? "", /items has 5 items, over its limit of 3\. Split it into two\./);
  const short = checkHtml(cardPage("Crowd", `crowd = Crowd(["a", "b", "c"])`), { schema, limits });
  assert.deepEqual(short.warnings, []);
  assert.throws(
    () =>
      austereComponent({
        name: "Crowd",
        group: "Diagrams",
        props: z.object({ title: z.string() }),
        description: "test",
        renderer: () => null,
        example: `crowd = Crowd("a")`,
        limits: [{ prop: "items", max: 3, message: "Split it." }],
      }),
    /limit on items: there is no prop by that name/,
  );
});

test("a Sequence over 5 actors or 12 messages is a check warning, at the limit it is not", () => {
  const schema = lib.schema();
  const limits = Object.fromEntries(
    lib
      .catalog("")
      .components.filter((e) => e.limits)
      .map((e) => [e.name, e.limits ?? []]),
  );
  const sequence = (actors: number, messages: number) => {
    const names = Array.from({ length: actors }, (_, i) => `a${i}`);
    const msgs = Array.from({ length: messages }, (_, i) => `m${i}`);
    return [
      `seq = Sequence([${names}], [${msgs}])`,
      ...names.map((n) => `${n} = Actor("${n}")`),
      ...msgs.map((m) => `${m} = Message(a0, a1, "${m}")`),
    ].join("\n");
  };
  const warnings = (a: number, m: number) =>
    checkHtml(cardPage("Sequence", sequence(a, m)), { schema, limits }).warnings.filter(
      (w) => w.code === "limit",
    );
  assert.deepEqual(warnings(5, 12), []);
  const six = warnings(6, 12);
  assert.equal(six.length, 1);
  assert.match(six[0].message, /actors has 6 items, over its limit of 5/);
  assert.match(warnings(5, 13)[0].message, /messages has 13 items, over its limit of 12/);
});
