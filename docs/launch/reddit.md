# Reddit

Three posts, one per subreddit, each written for that audience. Post them on different days, not all at once: Reddit's spam filter flags the same link across subreddits in a short window, and each thread needs you in the comments for the first two hours.

Read each subreddit's rules and its self-promotion policy on the day you post; they change. As of writing:

- **r/ClaudeAI:** use the flair for projects you built (currently "Built with Claude" or similar). Posts about your own tool are allowed when you say it's yours and it is free.
- **r/LocalLLaMA:** self-promotion is tolerated when the post is useful on its own and you take part in the discussion. Lead with numbers, not the pitch.
- **r/ChatGPTCoding:** project posts are allowed; say it's yours and link the source.

Attach `docs/demo.mp4` as the post's video where the subreddit allows media posts with text; otherwise put the GitHub link first and let the README GIF do the work.

---

## r/ClaudeAI

**Title:** I made Claude Code show its plans as a page I can click on and annotate, and it patches only what I commented on

**Body:**

```
I got tired of reading long plans and code reviews from Claude Code in the terminal, then typing "in the second table, the risk for option B is wrong" and hoping it found the right spot. So I built austere-axi (free, MIT, mine).

How it works:

1. Claude writes the plan as a short OpenUI Lang program (cards, tables, diffs, architecture diagrams, a decision form), not HTML.
2. `austere-axi check` validates it in Node, and it opens in your browser.
3. You click a table cell, a diff line, a diagram node or some text, write a note, and press Send.
4. Claude gets each note with the name of the statement it points at, sends back only those statements, and the page updates in place.

Install as a plugin:

    claude plugin marketplace add MandalorianBatman/austere-axi
    claude plugin install austere@austere-axi

Then ask for "a page" when you want a plan, comparison or review. There's also an MCP server (`npx -y austere-axi mcp`) if you use Claude Desktop.

Everything runs on your machine (loopback server, sandboxed page); there's no account and no hosted service.

In a benchmark against lavish-axi (same idea, but the agent writes full HTML), Claude Sonnet with lavish-axi used a median 2.4x the output tokens per page. With austere-axi it passed `check` on the first try 18 out of 18 times.

Repo and GIF: https://github.com/MandalorianBatman/austere-axi
Example pages: https://mandalorianbatman.github.io/austere-axi/gallery/

Happy to answer questions. I'd especially like to hear which components are missing for your plans.
```

---

## r/LocalLLaMA

**Title:** Benchmark: a small UI language cut output tokens 3.2x vs agents writing HTML for review pages (36 paired runs, raw data included)

**Body:**

```
I maintain austere-axi, an open-source (MIT) tool where a coding agent writes review pages (plans, code reviews, comparisons) as a short OpenUI Lang program instead of HTML. The page opens in a browser, you annotate parts of it, and the notes go back to the agent by statement name. I wanted to know whether the "fewer tokens" claim holds, so I benchmarked it against lavish-axi, which has the same review loop but has the agent write the HTML.

Setup: 6 review pages (migration plan, code review, ADR, comparison table, dashboard, release triage), 2 models (Claude Sonnet and MiniMax-M3), 3 repetitions, each tool's own guidance as the system prompt, then one reviewer note to answer.

Results (median of paired ratios, lavish-axi / austere-axi):

- Output tokens per page: 3.2x overall; 2.4x for Sonnet, 4.9x for MiniMax-M3
- Time per page: 2.4x
- Cost per page: 2.5x
- Tokens to answer one reviewer note: 2.7x
- Every page kept all of its task's facts with both tools

Where it doesn't look as good:

- MiniMax-M3 passed `austere-axi check` on the first try only 7/18 times (mostly props in the wrong position or of the wrong type). One fix turn of about 180 tokens repaired 9 of the 11. lavish-axi's own checks passed 16/18, but they only check layout.
- Time and cost gaps are smaller than the token gap, because input (about 7.4k tokens of guidance for austere-axi vs 10.8k for lavish-axi) and per-call latency are similar.
- No local model is in this run. The harness talks to any Anthropic-compatible endpoint; adding a model is one entry in `bench/models.json`, and runs resume, so you only pay for what's missing. If you run it on a local model, I'd like to add the numbers: https://github.com/MandalorianBatman/austere-axi/issues/24

Write-up with method, all tables and threats to validity: https://github.com/MandalorianBatman/austere-axi/blob/main/docs/benchmark.md
Every prompt, raw result and generated page is committed under bench/.

The tool itself runs fully locally: a loopback server and a sandboxed page, with no hosted service.
```

---

## r/ChatGPTCoding

**Title:** Open-source tool: your coding agent (Codex, Claude Code, Cursor) shows plans as pages you annotate in the browser

**Body:**

```
I built austere-axi (MIT) to stop reviewing agent plans and code reviews as walls of text.

The agent writes a short program in OpenUI Lang (tables, diffs, diagrams, forms) instead of HTML. The CLI validates it and opens it in your browser. You click anything on the page, a table cell, a diff line or a diagram node, and write a note. The agent receives the notes by statement name and patches only those statements, so the page updates in place instead of being regenerated.

It works with any agent that can run a CLI:

    npx -y austere-axi --help

Or as an MCP server for Codex, Cursor or Claude Desktop:

    codex mcp add austere -- npx -y austere-axi mcp

There's also a GitHub Action that posts a review page on PRs.

In a benchmark against lavish-axi, where the agent writes the HTML itself, lavish-axi used a median 3.2x the output tokens per page across 36 paired runs. The write-up includes the cases where austere-axi did worse: https://github.com/MandalorianBatman/austere-axi/blob/main/docs/benchmark.md

Repo: https://github.com/MandalorianBatman/austere-axi
Gallery: https://mandalorianbatman.github.io/austere-axi/gallery/
```
