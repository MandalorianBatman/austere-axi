import assert from "node:assert/strict";
import test from "node:test";
import { changedStatementIds, referencesTo, splitStatements, statementMap } from "../src/shared/statements.js";

const program = `root = Stack([intro, flow], "column", "l")
// a comment
intro = Card([CardHeader("Hi = there"), text])
text = MarkDownRenderer("line one
line two with ) and ] inside")
flow = Mermaid('flowchart LR
  a --> b')
`;

test("splits statements, keeping multi-line strings and skipping comments", () => {
  const s = splitStatements(program);
  assert.deepEqual(s.map((x) => x.id), ["root", "intro", "text", "flow"]);
  assert.equal(s[2].line, 4);
  assert.equal(s[2].endLine, 5);
  assert.match(s[3].text, /a --> b'\)$/);
});

test("detects changed and added statements", () => {
  const next = program.replace("Hi = there", "Hello").replace("flow = ", "extra = TextContent(\"x\")\nflow = ");
  assert.deepEqual(changedStatementIds(program, next).sort(), ["extra", "intro"]);
  assert.deepEqual(changedStatementIds(program, program), []);
});

test("finds parents that reference a statement, ignoring string contents", () => {
  const map = statementMap(program + 'note = TextContent("text is not a ref")\n');
  assert.deepEqual(referencesTo(map, "text"), ["intro"]);
});
