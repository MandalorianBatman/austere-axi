# Show HN

Post from your own account at https://news.ycombinator.com/submit. HN ignores the text box when a URL is given, so the explanation goes in a first comment you post right after submitting.

## Submission

**Title** (HN allows 80 characters):

```
Show HN: Austere-axi – coding agents write review pages, you click to annotate
```

Alternatives, if you prefer a plainer one:

```
Show HN: Review your coding agent's plans as pages you can click and annotate
Show HN: Austere-axi – annotate your agent's plan in the browser, it patches by name
```

**URL:** `https://github.com/MandalorianBatman/austere-axi`

Link the repo, not the site: HN readers want the code, the README opens with the GIF, and the site is one click away.

## First comment

Post within a minute of submitting.

```
Hi HN, I built this because I kept reading long plans and code reviews from coding agents in a terminal, and replying with "in step 3, the second option, change X" was slow and lossy.

austere-axi lets the agent show that work as a page instead. The agent writes a short OpenUI Lang program (a statement per line: root = Stack([...]), a Table, a Diff, an Architecture diagram, a Form) instead of HTML. The CLI validates it in Node with no browser (`austere-axi check`: component names, prop types, references) and opens it in your browser. You click a table cell, a diff line, a diagram node or selected text, write a note, press Send. The agent gets each note with the name and line of the statement it points at, sends back only the changed statements (`austere-axi patch`), and the page updates in place.

Some details:

- The loop is the same as lavish-axi's (credit to it; it's where the idea comes from). The difference is that the agent never writes HTML, CSS or layout. In a benchmark against lavish-axi (6 review pages, 2 models, 36 paired runs), lavish-axi used a median 3.2x the output tokens for the same page, 2.4x the time and 2.5x the cost. The write-up also lists where lavish-axi did better: with MiniMax-M3, austere-axi pages passed check on the first try only 7 of 18 times (one fix turn repaired 9 of the 11). Every prompt, raw result and page is committed so you can rerun it: https://github.com/MandalorianBatman/austere-axi/blob/main/docs/benchmark.md
- Everything runs locally. The review server binds to loopback (plus your Tailscale IP if Tailscale is up, for team review with invite links), and pages render in a sandboxed iframe. No account and no hosted service.
- It works with any agent that can run a CLI: `npx -y austere-axi --help` is the whole onboarding. There is also a Claude Code plugin, a stdio MCP server (`npx -y austere-axi mcp`) and a GitHub Action that posts a review page on PRs.
- Components that core doesn't have come from packs, which are npm packages with their own catalog. The Gantt pack is a worked example: https://github.com/MandalorianBatman/austere-pack-gantt
- Limits: one dark theme, static pages (no live data), and no images in feedback yet.

Example pages with their source and token counts: https://mandalorianbatman.github.io/austere-axi/gallery/

I'd like to hear where the loop breaks for you, and which components you'd want next.
```

## Before you post

- [ ] Every gate in [README.md](README.md#gates) is done. In particular, the site and benchmark links above must not 404.
- [ ] `npx -y austere-axi@latest mcp` starts, because the comment mentions it.
- [ ] If the playground at `/play` has shipped, add a line under "Some details": `- Try it with no install: https://mandalorianbatman.github.io/austere-axi/play/`.
