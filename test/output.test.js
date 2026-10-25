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
