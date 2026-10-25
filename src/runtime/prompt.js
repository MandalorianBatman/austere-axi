// Prompt options for the agent-facing component reference (`austere-axi spec`).

export const PREAMBLE =
  "OpenUI Lang reference for austere-axi artifacts. The program goes inside <script type=\"text/openui\"> in an .html file (`austere-axi --help` shows the file skeleton). One statement per line: name = Expression.";

export const RULES = [
  "Statement names are what the reviewer clicks and what feedback points back to. Name every section, table, chart, diagram, option and risk descriptively in camelCase (rolloutTable, riskCallout, optionB), never s1/s2. Capitalized names read as components.",
  "To revise after feedback, edit only the statements the feedback names (and add new ones); untouched statements keep their state on the reviewer's screen.",
  'Pass null to skip an optional argument before one you set: Tag("high", null, "sm", "danger").',
  "Strings may span lines (use that for Mermaid, Diff, CodeBlock and long markdown) and accept \\n escapes. Escape \" inside double-quoted strings, or use single quotes. Never write </script> inside the program.",
  "Artifacts are static: no Query, Mutation or tools, and you never need $variables (omit $binding props).",
  "Size: one idea per section, 3-7 sections, tables up to ~12 rows with phrase-length cells. A page that could have been a paragraph should have been a paragraph.",
];

export const EXAMPLES = [
  `Example 1 — plan with a diagram, options and a decision form:

root = Stack([intro, flow, options, openQuestion, decide], "column", "l")
intro = Card([CardHeader("Session storage migration", "Move sessions from Redis to Postgres"), introText])
introText = MarkDownRenderer("Sessions live only in Redis and are lost on failover. **Goal:** durable sessions with no forced logout.")
flow = Card([CardHeader("Request path after the change"), flowDiagram])
flowDiagram = Mermaid("flowchart LR
  client[Client] --> edge[Edge worker]
  edge --> api[API]
  api --> pg[(Postgres)]
  api -. read-through .-> redis[(Redis)]")
options = Card([CardHeader("Rollout options"), optionTable])
optionTable = Table([Col("Option", ["Big bang", "Dual-write"]), Col("Effort", ["2 days", "5 days"]), Col("Risk", [riskHigh, riskLow])])
riskHigh = Tag("high", null, "sm", "danger")
riskLow = Tag("low", null, "sm", "success")
openQuestion = Callout("warning", "Open question", "Keep Redis as a read-through cache after cutover?")
decide = Card([CardHeader("Your call"), decideForm])
decideForm = Form("rollout", decideButtons, [strategyField, notesField])
strategyField = FormControl("Rollout", RadioGroup("strategy", [RadioItem("Big bang", "One deploy, short maintenance window", "bigbang"), RadioItem("Dual-write", "Two weeks writing to both stores", "dualwrite")]))
notesField = FormControl("Notes", TextArea("notes", "Anything to change?", 3))
decideButtons = Buttons([Button("Send decision", @ToAssistant("Decision: rollout strategy"), "primary")])`,
  `Example 2 — code review with one-click follow-ups:

root = Stack([summary, change, followUps], "column", "l")
summary = Card([CardHeader("Retry fix", "1 file, +2 -1"), facts])
facts = EntityList([{left: "Tests", right: "48 passed"}, {left: "Risk", right: "Low"}])
change = Card([CardHeader("Patch"), retryPatch])
retryPatch = Diff("diff --git a/src/retry.ts b/src/retry.ts
--- a/src/retry.ts
+++ b/src/retry.ts
@@ -10,3 +10,4 @@
-  for (let i = 0; i < 3; i++) {
+  for (let i = 0; i < MAX_ATTEMPTS; i++) {
+    await sleep(backoff(i));
     try { return await fn(); } catch {}")
followUps = Buttons([Button("Ship it", @ToAssistant("Ship it"), "primary"), Button("Add a jitter test")])`,
];

export const PROMPT_OPTIONS = {
  preamble: PREAMBLE,
  additionalRules: RULES,
  examples: EXAMPLES,
  toolCalls: false,
  bindings: false,
  builtinFunctions: false,
  editMode: false,
  inlineMode: false,
};
