# LinkedIn

Attach `docs/demo.mp4` as a native video (LinkedIn plays it inline; a YouTube link gets less reach). Put the GitHub link in the first comment rather than in the post: LinkedIn shows posts with outbound links to fewer people. Link the portfolio case study if it is live by then.

## Post

```
Coding agents are good at writing plans, code reviews and design comparisons. Reviewing them is still slow: a long block of text in a terminal, and replies like "in step 3, the second option, change the rollout".

I built austere-axi to fix that loop.

→ The agent writes the plan as a short program in OpenUI Lang (cards, tables, diffs, diagrams, forms), not as HTML.
→ It opens as a page in your browser.
→ You click the exact table cell, diff line or diagram node you disagree with and leave a note.
→ The agent gets each note by statement name and changes only those statements. The page updates in place.

Because the agent writes a few lines instead of a whole web page, it is cheaper. In a benchmark against a tool that has agents write the HTML, that tool used 3.2x the output tokens per page, 2.4x the time and 2.5x the cost (36 paired runs, 2 models). The write-up also lists where the other tool did better, and every prompt and result is public.

It runs locally with no account, works with Claude Code, Codex, Cursor and any agent that can run a CLI, and is MIT-licensed.

Link to the code and the benchmark is in the first comment. If you review agent output every day, I'd like to know what slows you down.

#AI #DeveloperTools #OpenSource #CodingAgents
```

## First comment

```
Code: https://github.com/MandalorianBatman/austere-axi
Example pages: https://mandalorianbatman.github.io/austere-axi/gallery/
Benchmark write-up: https://github.com/MandalorianBatman/austere-axi/blob/main/docs/benchmark.md
```
