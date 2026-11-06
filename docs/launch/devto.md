# dev.to / blog long-form

Paste everything below the line into dev.to's editor (it reads the front matter), or into your blog. Set `canonical_url` to the blog copy if you publish there first, so search engines credit one place. Upload `docs/benchmark.svg` (as PNG) and a frame of `docs/demo.gif` as the cover; dev.to wants 1000×420 for covers, so crop `docs/social-preview.png` if you'd rather use that.

---

```markdown
---
title: "Agents shouldn't write HTML to show you a plan: measuring a 3.2x token gap"
published: false
description: "Review pages for coding agents in OpenUI Lang, annotated in the browser, patched by statement name. Plus a benchmark against agents writing the HTML."
tags: ai, opensource, productivity, webdev
cover_image:
canonical_url:
---

Coding agents write a lot for us to review: migration plans, code reviews, architecture decisions, comparison tables. Most of it arrives as a long block of text in a terminal. When something is wrong, I type a reply like "in step 3, the second option, the risk should be high", and hope the agent finds the same spot I meant.

A rendered page is easier to read. A page you can point at is easier to answer. That is the loop [austere-axi](https://github.com/MandalorianBatman/austere-axi) gives an agent, and this post is about one design decision in it, and what it was worth when I measured it.

## The loop

1. The agent writes a page.
2. You open it in the browser, click the part you disagree with (a table cell, a diff line, a node in a diagram, selected text) and write a note.
3. You press Send. The agent gets each note together with what it points at.
4. The agent changes those parts, and the page updates in place.

The loop is not new. [lavish-axi](https://github.com/kunchenguid/lavish-axi) does the same thing, and austere-axi borrows the idea. The difference is what the agent writes in step 1.

## The agent writes statements, not HTML

With lavish-axi, the agent writes the page: HTML, CSS, SVG for diagrams, layout. With austere-axi, it writes a short program in [OpenUI Lang](https://github.com/thesysdev/openui):

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

Three things follow from that:

- **The page can be checked without a browser.** `austere-axi check` parses the program in Node and reports unknown components, props of the wrong type and statements that are referenced but never defined. The agent finds out before you open anything.
- **Feedback has an address.** Every part you click belongs to a named statement. A note on the "high" risk tag comes back attached to `optionTable` and its line, with the row and column, not as a CSS selector the agent has to map back to its own markup.
- **Revisions are small.** The agent sends back only the statements it changed (`austere-axi patch`): same name replaces, a new name adds. The page re-renders those statements and leaves the rest of the page as it was.

The cost is that every page shares one fixed, dark design. The agent can't make a page look like your product. Components that core lacks come from packs, npm packages with their own catalog, such as a [Gantt chart pack](https://github.com/MandalorianBatman/austere-pack-gantt).

## Does it actually save tokens?

The README claimed "a few hundred tokens instead of a whole HTML page". I wanted a number I could defend, so I built a benchmark against lavish-axi and committed all of it.

**Setup.** Six review pages, each with a fixed prompt that holds every fact the page needs: a migration plan, a code review with a diff, an architecture decision record, a four-way comparison table, a service dashboard and a release triage. Two models: Claude Sonnet and MiniMax-M3. Three repetitions each, so 36 pairs. Each tool's own guidance (its `--help` and reference text, captured live from its CLI) is the system prompt. The model writes the page; if the tool's own check fails, it gets one turn to fix it; then it answers one reviewer note with the tool's cheapest edit.

**Results** (median of paired ratios, lavish-axi ÷ austere-axi):

| | Claude Sonnet | MiniMax-M3 | All |
|---|--:|--:|--:|
| Output tokens per page | 2.4× | 4.9× | **3.2×** |
| Time per page | 2.2× | 3.1× | 2.4× |
| Cost per page | 2.3× | 2.8× | 2.5× |
| Output tokens to answer one note | 2.1× | 5.3× | 2.7× |

Every lavish-axi page used more output tokens than its austere-axi pair; the smallest gap was 1.7×. And both tools kept every one of their task's key facts on every page, so the austere-axi pages are not shorter because they leave things out.

## Where it did worse

Three results cut the other way.

**First-try validity with the weaker model.** MiniMax-M3's austere-axi programs passed `check` on the first try only 7 times out of 18. Most errors were props in the wrong position or of the wrong type: a label where `variant` goes, an object where a string goes. One fix turn of about 180 tokens repaired 9 of the 11. lavish-axi's checks passed 16 of 18, but they only look at layout, so the two numbers measure different things. Claude passed `check` 18 times out of 18.

**Time and cost shrink less than tokens.** Both tools send a similar amount of input (about 7,400 tokens of guidance for austere-axi and 10,800 for lavish-axi), and every call has fixed latency. A 3.2× token gap became 2.4× in time and 2.5× in cost.

**Small edits are a tie.** When a note changes one value, both tools cost about the same (1.1×). The gap shows up when a note adds structure, like a new table row or a new form option. Then HTML repeats its markup and classes, and the program adds a line.

The benchmark also found a bug in austere-axi. In one revision, the model added a statement but never referenced it from the table. `patch` dropped it and still reported success, so the agent never knew. That is [issue #20](https://github.com/MandalorianBatman/austere-axi/issues/20).

The full write-up has the method, per-task tables and threats to validity, including the fact that I wrote the benchmark and picked the tasks: [docs/benchmark.md](https://github.com/MandalorianBatman/austere-axi/blob/main/docs/benchmark.md). Every prompt, raw result and generated page is in `bench/`. To rerun it or add a model: `npm run bench`.

## Try it

It runs locally: a server on loopback (plus your Tailscale IP, if you use it for team review) and pages in a sandboxed iframe. There is no account and no hosted service. You need Node 22.18 or later.

Any agent that can run a CLI:

    npx -y austere-axi --help

Claude Code plugin:

    claude plugin marketplace add MandalorianBatman/austere-axi
    claude plugin install austere@austere-axi

MCP server for Codex, Cursor or Claude Desktop:

    npx -y austere-axi mcp

There is also a GitHub Action that posts a review page on pull requests.

Examples with their source and token counts are in the [gallery](https://mandalorianbatman.github.io/austere-axi/gallery/). If you review agent output every day, I'd like to hear where this loop breaks for you: [issues are open](https://github.com/MandalorianBatman/austere-axi/issues).
```

## Before publishing

- [ ] If #20 is fixed and released by launch day, change "That is issue #20" to "That is fixed in 0.x".
- [ ] Check every link resolves (the site and `docs/benchmark.md` exist only after their PRs merge).
