# Launch kit

Drafts and a checklist for the public launch of austere-axi. sid.kasat posts everything himself, from his own accounts; nothing here is posted by an agent.

| File | What |
|---|---|
| [show-hn.md](show-hn.md) | Show HN title, URL and first comment |
| [reddit.md](reddit.md) | r/ClaudeAI, r/LocalLLaMA and r/ChatGPTCoding posts |
| [social.md](social.md) | X / Bluesky thread (6 posts) |
| [linkedin.md](linkedin.md) | LinkedIn post and first comment |
| [devto.md](devto.md) | dev.to / blog long-form built on the benchmark |
| [awesome-lists.md](awesome-lists.md) | Ready-to-open awesome-list submissions, with repo and section |
| [metrics.csv](metrics.csv) | Stars, downloads and traffic snapshots (`node scripts/launch-snapshot.mjs`) |

## Gates

Do not post until every box is ticked. A launch thread that links a 404 or an `npx` command that fails does not get a second chance.

- [ ] **Merge the feature PRs**, in this order: #7 (MCP + plugin), #8 (Action), #9 (pack guide), #12 (demo GIF), #10 (benchmark), #11 (site). Merged in that order, #10 and #11 each conflict with the earlier ones in `README.md` and `AGENTS.md`; both conflicts keep both sides (one line per `npm run` command, one paragraph per maintainer section). With all six merged, `npm run build && npm test` passes (91 tests) and `npm run typecheck` is clean.
- [ ] **Merge the security fixes** #13 to #19 (RLM-251 to RLM-257). HN readers will try the team-review server; ship with those fixes in.
- [ ] **Release 0.5.0**: bump `version`, push, publish a GitHub Release. npm `latest` is 0.4.1, which has no `mcp` command, so every MCP install line in the drafts fails until then. Check: `npx -y austere-axi@latest mcp` starts and waits on stdin.
- [ ] **Change the Action example** in the README from `@main` to the new tag (`MandalorianBatman/austere-axi/action@v0.5.0`).
- [ ] **Site is live**: https://mandalorianbatman.github.io/austere-axi/ and `/gallery/` load. Then set the repo's website field: `gh repo edit MandalorianBatman/austere-axi --homepage https://mandalorianbatman.github.io/austere-axi/`.
- [ ] **README launch pass merged** (see below).
- [ ] **Social preview**: upload `docs/social-preview.png` in Settings → General → Social preview. GitHub has no API for this. Check it by pasting the repo URL into https://www.opengraph.xyz/.
- [ ] **Publish the Gantt pack**: `npm publish` in `austere-pack-gantt`, so `austere-axi components add austere-pack-gantt --trust` works for people who try it.
- [ ] **Playground**: RLM-246 (`/play`) has not been built yet. Either launch without it (the drafts don't mention it) or wait; if it ships, add the line noted at the bottom of `show-hn.md`.
- [ ] **MCP registry**: publish `server.json` with `mcp-publisher` (text in RLM-241), after the release. Then claim the Glama listing (https://glama.ai/mcp/servers, "Add server"); punkpeye/awesome-mcp-servers won't merge without its score badge.
- [ ] Run `node scripts/launch-snapshot.mjs --label before-launch` the evening before.

Already done: repo description and topics updated, private vulnerability reporting enabled (CONTRIBUTING.md points security reports there), CONTRIBUTING.md added, issues #20 to #24 opened (four labelled `good first issue`, one `help wanted`).

### README launch pass

This is a separate PR, opened after the six feature PRs merge: #10, #11 and #12 each rewrite the top of the README, so any README edit opened now would conflict with all three. With those merged, the README already has the GIF, the pitch, the site link and the benchmark headline (checked on a local merge of all six). The pass adds:

1. A one-line pitch under the badges: **Your coding agent writes a review page; you click any part of it to leave a note; it patches only what you pointed at.**
2. A link row under the GIF: Website · Gallery · Benchmark · Writing a pack (and Playground once it exists).
3. The 3-command quick start (`spec`, open, `poll`) moved up, directly under the example, so it is on the first screen after the GIF. The detailed install options stay where they are.
4. A "Contributing" section before "License" that links CONTRIBUTING.md and the `good first issue` label.

## Launch week

Times are US Pacific, since most of HN and Reddit's tech audience is in the US. They are common practice, not measurements: a weekday morning in the US, and not Friday to Sunday.

| When | What | Snapshot label |
|---|---|---|
| Day 0 (Tue or Wed), 08:00–09:30 PT | Show HN, then the first comment within a minute | `before-hn` just before |
| Day 0, an hour after HN | X / Bluesky thread, LinkedIn post | |
| Day 0, all day | Answer every HN comment, ideally within 30 minutes, for the first 4–6 hours | `hn+6h` |
| Day 1, 07:00–09:00 PT | r/ClaudeAI | `day1` |
| Day 2, 07:00–09:00 PT | r/LocalLLaMA; dev.to long-form | `day2` |
| Day 3, 07:00–09:00 PT | r/ChatGPTCoding | `day3` |
| Day 3 to Day 7 | Open the awesome-list PRs, one or two a day, best fit first (some lists want a minimum star count; open those after the launch) | |
| Day 7 | Final snapshot; compare with `before-launch` | `day7` |

Rules of thumb:

- Don't ask anyone to upvote, on any site. HN and Reddit both penalize it, and HN detects ring voting.
- If the Show HN gets no traction in the first two hours, leave it. HN mods sometimes put good Show HNs into the second-chance pool; you can also email hn@ycombinator.com once to ask. Don't delete and repost.
- Post on Reddit from your own account, say it's your project in the first line, and stay in the thread for the first two hours.

## Answering comments

Short, factual, and concede what's true. Questions you will likely get, with the facts to answer from:

**"Why not just render Markdown?"** Markdown has no diagrams with click targets, no diffs, no forms that send choices back, and no stable address for a note. The point is the loop: the note comes back to the agent attached to a named statement, and the agent changes only that statement.

**"How is this different from lavish-axi?"** Same loop, and credit to it. With lavish-axi the agent writes HTML, CSS and SVG, and every page has its own design. With austere-axi it writes OpenUI Lang statements against one fixed design, which is checked in Node before the browser opens. The trade: about 3x fewer output tokens per page in our benchmark, in exchange for one look for every page.

**"You wrote the benchmark yourself."** Yes, and the write-up says so. Every prompt, raw result and generated page is committed under `bench/`; `npm run bench` reruns it, and runs resume, so you can add a model cheaply. The write-up lists where lavish-axi did better.

**"The weaker model failed check most of the time."** True: MiniMax-M3 passed `check` on the first try 7 of 18 times, mostly with props in the wrong position or of the wrong type. `check` reports those errors to the agent, and one fix turn of about 180 tokens repaired 9 of 11. Claude passed 18 of 18. Positional props are a known cost of the format.

**"What is OpenUI Lang?"** A small language from thesys (https://github.com/thesysdev/openui) for describing UI as statements: `name = Component(args)`, one per line, referencing each other by name. austere-axi adds diagrams, diffs and file trees, plus packs for more components.

**"Does it send my code anywhere?"** No. The server binds to loopback (plus your Tailscale IP when Tailscale is up, for team review), the page runs in a sandboxed iframe, and there is no hosted service or telemetry. `export` makes one offline HTML file if you want to share a page.

**"Which agents does it work with?"** Anything that can run a shell command: `npx -y austere-axi --help` is the whole onboarding. Plus a Claude Code plugin, an MCP server for Codex, Cursor and Claude Desktop, and a GitHub Action for PRs.

**"Only a dark theme?"** Yes, one theme for now. Themes are listed under "Not in v1" in the README.

**"Can I add my own components?"** Yes, through packs: npm packages built against `austere-axi/pack`. `docs/writing-a-pack.md` walks through one; `austere-pack-gantt` is the worked example.

**"How many tokens does the agent spend reading the guidance?"** About 7,400 input tokens (`--help` plus `spec`, measured with MiniMax-M3), once per session. lavish-axi's guidance was about 10,800 in the same run.

For a bug report in a thread, open an issue from it and reply with the link.

## Tracking results

`node scripts/launch-snapshot.mjs --label <label>` appends one row to `metrics.csv`: GitHub stars, forks, watchers and open issues; npm downloads for `austere-axi` and `austere-pack-gantt` (last day, week and month); and, with `gh` logged in as a maintainer, 14-day views, unique visitors, clones and the top referrer. Run it at each label in the schedule above.

GitHub keeps traffic data for 14 days only, so the day-7 snapshot is the last one that still covers launch day. npm download counts lag by about a day.

The first row, `baseline-prelaunch`, was taken on 2026-11-06: 1 star, 287 npm downloads in the last week, 6 unique visitors in 14 days.
