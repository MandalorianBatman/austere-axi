# How it works

Review pages for coding agents.

1. The agent writes a short [OpenUI Lang](https://github.com/thesysdev/openui) program, not HTML.
2. You open it in the browser, click any part, and write a note.
3. The agent gets each note with the name of the statement it points at, edits only those statements, and the page updates in place.

## What the agent writes

```
root = Stack([intro, flow, options, decide], "column", "l")
intro = Card([CardHeader("Session storage migration", "Redis → Postgres"), introText])
introText = MarkDownRenderer("Sessions are lost on failover. **Goal:** durable sessions, no forced logout.")
flow = Card([CardHeader("Request path"), flowDiagram])
flowDiagram = Architecture([client, api, pg], [toApi, toPg])
client = Node("Client", "external")
api = Node("API", "backend", "Node :8080")
pg = Node("Postgres", "database", "sessions table", "new")
toApi = Edge(client, api, "HTTPS", "emphasis")
toPg = Edge(api, pg, "SQL")
options = Card([CardHeader("Rollout options"), optionTable])
optionTable = Table([Col("Option", ["Big bang", "Dual-write"]), Col("Risk", [Tag("high", null, "sm", "danger"), Tag("low", null, "sm", "success")])])
decide = Form("rollout", Buttons([Button("Send decision", @ToAssistant("Decision: rollout"), "primary")]), [strategyField])
strategyField = FormControl("Rollout", RadioGroup("strategy", [RadioItem("Big bang", "", "bigbang"), RadioItem("Dual-write", "", "dualwrite")]))
```

A full page (KPIs, diagram, table, chart, diff, decision form) is about 1,000 tokens: [`examples/session-migration.html`](../examples/session-migration.html).

**See it without installing:** the [gallery](https://mandalorianbatman.github.io/austere-axi/gallery/) shows example pages next to their source and token counts. The [playground](https://mandalorianbatman.github.io/austere-axi/play/) lets you edit OpenUI Lang and see the page live.

## The review loop

```
agent writes plan.html ──► austere-axi plan.html ──► local server + browser review
                                                        │  reviewer annotates, picks options,
                                                        │  types, presses Send
agent patches changes  ◄── austere-axi poll plan.html ◄─┘  (long-poll returns the batch)
          │
          └─► page updates in place and flashes the changed statements
```

- **A page is a plain `.html` file:** one runtime `<script>` tag and one `<script type="text/openui">` block. Opened directly, it loads the runtime from the CDN. Under review, the server serves a local copy.
- **The jsDelivr link at the top of a page** (`https://cdn.jsdelivr.net/npm/austere-axi@0/dist/austere.js`) is that runtime `<script>` tag. [jsDelivr](https://www.jsdelivr.com/) is a free public CDN that serves the files of any npm package; the URL reads `npm/<package>@<version>/<file>`. `austere.js` is the renderer: it finds the `text/openui` block, parses it and draws the page. Without it the browser shows a blank page. `@0` means "latest 0.x release". The page's content stays in the file; the browser only fetches the script. A page opened directly needs network to render; `austere-axi export` inlines the runtime for an offline file.
- **Components:** 58 stock OpenUI components, plus `Architecture` (`Node`, `Edge`, `Group`), `Diff` and `FileTree`. Ten shadcn-style components come as a bundled [pack](components-and-packs.md).
- **Diagrams lay out automatically** ([dagre](https://github.com/dagrejs/dagre)); the agent never writes coordinates. Every node and edge is a click target. `lanes` puts each group in a column; `tone` colors a box or line to show risk.
- **Notes** attach to the smallest named statement under the click, with detail where it exists: table row and column, `file:+line` in a diff, a diagram node, or selected text. The hover box outlines that row, line or node, not the whole statement. The reviewer can move a note to a parent section.
- **Changes flash** after each agent turn, and the bar shows `N changed`. Click it to keep the last turn's changes outlined until you click again.
- **Buttons and forms send feedback.** `@ToAssistant("…")` sends a message with the form values. A button with no action sends its label.
- **Phone review:** with Tailscale running, the server also listens on the tailnet IP and prints a phone link. That link carries your owner key; keep it private. The review UI has a mobile layout.

## Compared with lavish-axi

Same loop as [lavish-axi](https://github.com/kunchenguid/lavish-axi). The difference: the agent never writes HTML, CSS or layout.

| | lavish-axi | austere-axi |
|---|---|---|
| Agent writes | Full HTML + CSS + SVG | OpenUI Lang statements |
| After feedback | Edits the HTML; the page reloads | Edits the named statements; the page patches in place |
| Feedback points at | CSS selector + text | Statement name and line, plus table cell, diff line, diagram node or selected text |
| Validation | Layout audit in the browser | `austere-axi check`, in Node, no browser |
| Look | Different for each agent | One dark design |

Fewer output tokens: faster pages, lower cost. From the [benchmark](benchmark.md):

<!-- bench:start -->
Across 36 paired runs (6 review pages, 2 models), lavish-axi spent a median **3.2×** the output tokens of austere-axi to produce the same page, took **2.4×** as long and cost **2.5×** as much. Answering one reviewer note took **2.7×** the output tokens.
<!-- bench:end -->

lavish-axi does better in some cases. Read the benchmark caveats before you quote the numbers.

## Not in v1

- Image attachments in feedback.
- Live data: `Query` and `Mutation` are off, so pages are static.
- Themes: one dark theme only.
