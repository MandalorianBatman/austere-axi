# X and Bluesky thread

The same thread works on both. Every post fits X's 280 characters and Bluesky's 300 (URLs count as 23 on X). Attach `docs/demo.mp4` to post 1. Both sites play video inline, and a GIF gets cropped. Attach `docs/benchmark.svg` as a PNG to post 4: neither site accepts SVG, so convert it first, for example `rsvg-convert -w 1600 docs/benchmark.svg -o benchmark.png`, or take a screenshot of it in a browser.

Put the links in the last post, not the first. Both sites show posts with links to fewer people.

## Thread

**1/6** (with `demo.mp4`)

```
Coding agents hand you plans and reviews as walls of text, and you reply with "in step 3, the second option…"

I built austere-axi: the agent writes a review page, you click any part of it and leave a note, and the agent patches only what you pointed at.
```

**2/6**

```
The agent doesn't write HTML. It writes a short OpenUI Lang program: one statement per line, with cards, tables, diffs, diagrams and forms.

`austere-axi check` validates it in Node, so it fails fast on a typo before you ever open the browser.
```

**3/6**

```
Your notes go back to the agent by statement name and line: a table cell, a diff line, a diagram node, selected text.

It sends back only the changed statements, and the page updates in place without regenerating the whole page.
```

**4/6** (with the benchmark chart)

```
Against lavish-axi, which has the same loop but has the agent write the HTML, 36 paired runs:

lavish-axi used 3.2x the output tokens per page, 2.4x the time, 2.5x the cost.

The write-up also covers where lavish-axi did better. All prompts and pages are in the repo.
```

**5/6**

```
Runs locally: a loopback server and a sandboxed page, no account.

Works with any agent that can run a CLI (npx -y austere-axi --help), as a Claude Code plugin, as an MCP server for Codex, Cursor or Claude Desktop, and as a GitHub Action on PRs.
```

**6/6**

```
MIT, free.

Code: github.com/MandalorianBatman/austere-axi
Examples with source and token counts: mandalorianbatman.github.io/austere-axi/gallery/
Benchmark: github.com/MandalorianBatman/austere-axi/blob/main/docs/benchmark.md
```

## Notes

- On X, tag nobody in post 1. If you want to credit lavish-axi's author, do it in post 4 with their handle; check it first.
- On Bluesky, add `#buildinpublic` or a feed tag only if you already use them; untagged posts are fine.
- Pin the thread for launch week.
