import assert from "node:assert/strict";
import test from "node:test";
import { changedStatementIds, closureOf, referencesTo, renameStatements, splitStatements, statementMap } from "../src/shared/statements.ts";

const program = `root = Stack([intro, flow], "column", "l")
// a comment
intro = Card([CardHeader("Hi = there"), text])
text = MarkDownRenderer("line one
line two with ) and ] inside")
flow = CodeBlock('text', 'step one
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

test("closureOf: the statements and everything they reference, in source order, ignoring names inside strings", () => {
  const map = statementMap(`root = Stack([a, c])
a = Card([b, "mentions d in a string"])
b = TextContent("b")
c = TextContent("c")
d = TextContent("d")`);
  assert.deepEqual(closureOf(map, ["a"]), ["a", "b"]);
  assert.deepEqual(closureOf(map, ["root"]), ["root", "a", "b", "c"]);
  assert.deepEqual(closureOf(map, ["nope"]), []);
});

test("renameStatements: definitions and references follow; strings, comments, members and object keys do not", () => {
  const text = `flow = Architecture([client, api], {client: 1, label: "client"}) // client
client = Node("client", client.name)`;
  const out = renameStatements(text, new Map([["client", "client2"], ["flow", "flow2"]]));
  assert.equal(
    out,
    `flow2 = Architecture([client2, api], {client: 1, label: "client"}) // client
client2 = Node("client", client2.name)`,
  );
  assert.equal(renameStatements("x = y", new Map()), "x = y");
});
