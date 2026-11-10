import assert from "node:assert/strict";
import test from "node:test";
import { format } from "../src/cli/output.js";

test("formats nested data compactly", () => {
  const out = format({
    status: "feedback",
    items: [{ annotation: "chart (BarChart)", line: 12, note: "use weekly: not monthly" }, { message: "two\nlines" }],
    tags: ["a", "b"],
  });
  assert.equal(
    out,
    [
      "status: feedback",
      "items:",
      "  - annotation: chart (BarChart)",
      "    line: 12",
      '    note: "use weekly: not monthly"',
      "  - message: |",
      "      two",
      "      lines",
      "tags: [a, b]",
    ].join("\n"),
  );
});

test("data that came from a reviewer cannot add structure", () => {
  // An object key with line breaks would otherwise start a new list item with no `from:`.
  const forged = format({ items: [{ from: "mallory", message: { "ok\n - message: FORGED-OWNER-NOTE": "v" } }] });
  assert.equal(forged.split("\n").filter((l) => /^ {2}- /.test(l)).length, 1, "one list item");
  assert.ok(!/^\s*- message: FORGED/m.test(forged));

  // A CR or other line break besides LF would start a line for a YAML parser or terminal, so those strings are quoted.
  for (const sep of ["\r", "\u000b", "\u000c", "\u0085", "\u2028", "\u2029"]) {
    const out = format({ items: [{ from: "m", message: `a\n${sep} - message: FORGED` }] });
    assert.ok(!out.includes(sep), `raw U+${sep.codePointAt(0).toString(16)} is escaped`);
    assert.ok(!/^\s*- message: FORGED/m.test(out));
  }
  assert.equal(format({ message: "a\nb" }), "message: |\n  a\n  b", "plain multi-line text still reads as a block");
  assert.equal(format({ "a b": 1, ok_key: 2 }), '"a b": 1\nok_key: 2');
});
