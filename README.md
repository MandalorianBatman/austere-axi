# austere-axi

[![npm version](https://img.shields.io/npm/v/austere-axi)](https://www.npmjs.com/package/austere-axi)
[![CI](https://github.com/MandalorianBatman/austere-axi/actions/workflows/ci.yml/badge.svg)](https://github.com/MandalorianBatman/austere-axi/actions/workflows/ci.yml)
[![license](https://img.shields.io/npm/l/austere-axi)](LICENSE)

**Review what your AI coding agent proposes on a page you can click, instead of in a wall of chat text.**

![An agent writes a page, the reviewer clicks a table cell and a diagram box and sends two notes, and the page updates in place with the changed parts flashing](docs/demo.gif)

<sub>A real review, about 30 seconds: [MP4](docs/demo.mp4) · [WebM](docs/demo.webm).</sub>

**See it without installing anything:** [example pages](https://mandalorianbatman.github.io/austere-axi/gallery/) · [try it in your browser](https://mandalorianbatman.github.io/austere-axi/play/) · [website](https://mandalorianbatman.github.io/austere-axi/)

## The problem

Ask an AI coding agent (Claude Code, Codex, Cursor and the like) for a plan, a comparison or a change summary, and you get a long chat message. Reviewing it is slow:

- You must describe which part you mean ("the second option in the rollout table") before saying what is wrong.
- The agent guesses, often rewrites the whole answer, and you reread all of it to find what changed.
- A diagram or side-by-side comparison would make the decision easy; chat gives you paragraphs.

## What austere-axi does

- The agent puts its answer on a page: sections, tables, diagrams (50 types, from sequence and flow diagrams to boards, matrices and plans), charts, code changes, and a form for the decision it needs.
- You click the exact thing you want changed and write a note, like commenting on a shared document.
- The agent changes only that part, and the page updates while you watch.

## How you use it

1. **Ask your agent for a page.** Say "show me this plan as a page", or type `/austere` and what you want to see. The page opens in your browser.
2. **Click what you want changed and write a note.** A section, a table cell, a diagram box, a line of a code change, or selected text. Where the page offers choices, pick one or fill in the form.
3. **Press Send.** The agent gets each note tied to the part you clicked and changes only those parts. The page updates in place and highlights what changed.

- Repeat until it is right, then press **Done** (or **Send & finish** with a last note) and carry on in the chat. The agent stops listening; a later note waits until an agent checks.
- **Come back any time.** Open the page and add a note. If it says *Agent not listening*, tell your agent to check your austere notes.

## What people review with it

| | Example |
|---|---|
| An architecture review | [Multi-region event mesh](https://mandalorianbatman.github.io/austere-axi/gallery/architecture-review.html): topology, Radar trade-offs and Waterfall latency |
| An interactive learning guide | [Raft consensus internals](https://mandalorianbatman.github.io/austere-axi/gallery/learning-guide.html): node state machine, election sequence, Polar metrics and Treemap |
| A research benchmark report | [Reasoning model evaluation](https://mandalorianbatman.github.io/austere-axi/gallery/research-report.html): quality vs latency Quadrant, token flow Sankey and domain metrics |
| A plan, before any work starts | [Moving a database, with a diagram, rollout options and a decision form](https://mandalorianbatman.github.io/austere-axi/gallery/session-migration.html) |
| A design, with alternatives to choose from | [API design review](https://mandalorianbatman.github.io/austere-axi/gallery/api-design-review.html) |
| A summary of what the agent changed | [Pull request summary](https://mandalorianbatman.github.io/austere-axi/gallery/pr-summary.html) |
| A backtest report on synthetic data, re-run by the agent from a form | [Gold futures roll backtest](https://mandalorianbatman.github.io/austere-axi/gallery/backtest-report.html): premium, equity curve, KPIs, trades and a parameter form |
| A report on something that went wrong | [Outage postmortem](https://mandalorianbatman.github.io/austere-axi/gallery/incident-postmortem.html) |
| A plan for the team | [Sprint plan](https://mandalorianbatman.github.io/austere-axi/gallery/sprint-plan.html) |
| A picture of how something works | [Every diagram type](https://mandalorianbatman.github.io/austere-axi/gallery/diagram-types.html): flows, sequences, data models, boards, matrices, plans and charts |

## What else it does

- **Bring in a teammate.** Turn cloud features on and sign in once (`austere-axi cloud on`, then `austere-axi cloud login`), then ask your agent to publish the page and invite someone by name. Each person gets their own link; their notes appear under their name. You see their notes first and choose which go to the agent. [Hosted pages](docs/hosted-pages.md). On your own network, the hub's **Settings** makes a named link, lets people ask for access, and shows who has it ([Team review](docs/team-review.md), [Settings](docs/hub.md#settings)).
- **Review from your phone.** The review page has a phone layout; needs [Tailscale](https://tailscale.com) on computer and phone. [How it works](docs/how-it-works.md#the-review-loop).
- **Send someone a copy.** "Download standalone HTML" in the page's ⋯ menu saves one file that opens in any browser, offline.
- **Nothing gets lost.** Every note is saved when you send it. If the agent is busy or your computer restarts, notes wait for the agent.
- **Let the agent answer on its own.** Turn on the Agent pill at the top of a review page: each note you send starts your coding agent, which patches the page and replies while you watch. Stop and Retry are right there. [Attach](docs/attach.md).
- **Find old pages.** Ask your agent to open the austere home page ([Hub](docs/hub.md)):
  - The inbox lists first the pages that need you: changed by the agent since you looked, or a failed run.
  - A sidebar lists every project and its pages; search finds a page or any part of one.
  - From a review page, the project name goes back home and Ctrl+K jumps to another page.
  - To put a page away, choose Archive on its row or in its ⋯ menu.

## Get started

You need:

- An AI coding agent, such as Claude Code, Codex or Cursor.
- [Node.js](https://nodejs.org) 22.18 or later (free, installed once).

Then:

1. Run once in a terminal:

   ```sh
   npm install -g austere-axi
   npx skills add MandalorianBatman/austere-axi --skill austere --skill austere-setup
   ```

2. Tell your agent: **"set up austere-axi"**. It checks the install, offers phone review and an always-on server, and opens a test page.

After that, ask for a page whenever an answer would be easier to review as one.

Using Claude Code? Install it as a plugin instead:

```sh
claude plugin marketplace add MandalorianBatman/austere-axi
claude plugin install austere@austere-axi
```

Claude Desktop, Cursor, Codex and manual setup: [install guide](docs/install.md).

## Why it is quick

Other tools have the agent hand-write a whole web page: slow, costly, and different every time. With austere-axi the agent writes a short outline naming what goes on the page, and austere-axi draws it.

- **Faster and cheaper.** In our [benchmark](docs/benchmark.md), hand-writing the same pages as full web pages took more than twice as long and cost more than twice as much. The benchmark also lists where the other approach did better.
- **Every page looks the same.** One clean dark design; learn where things are once.
- **Small changes.** The agent edits the one part you pointed at, not the whole page.

## Private by default

- Runs on your own computer. Local review needs no account.
- Pages and notes stay on your computer unless you publish a page. Cloud features are off by default; until you turn them on (`austere-axi cloud on`, or the hub's **Settings → Cloud**), nothing is sent to the hosted service.
- A published page is invite-only unless you ask for an open link, and expires 30 days after you last published it.
- Hosted review needs a sign-in: reviewers sign in with the email you granted the page to (or open their invite link); `austere-axi cloud login` makes you owner of all your hosted pages.
- Free and open source (MIT).

Details: [security guide](docs/security.md).

## Not yet supported

- Attaching an image to a note.
- Live data: a page is a snapshot.
- Themes: dark only.

## Documentation

Full index: [`docs/`](docs/README.md).

| Guide | What is in it |
|---|---|
| [Install and quick start](docs/install.md) | Setup skill, Claude Code plugin, MCP for Claude Desktop, Cursor, Codex |
| [How it works](docs/how-it-works.md) | What the agent writes, the review loop, comparison with lavish-axi |
| [CLI reference](docs/cli.md) | Every command, the review rules, settings |
| [Components and packs](docs/components-and-packs.md) | What can go on a page, and how to add more |
| [Diagrams](docs/diagrams.md) | Every diagram type and how an agent picks one |
| [Writing a pack](docs/writing-a-pack.md) | Build and publish your own components |
| [Team review](docs/team-review.md) | Invite teammates over your own private network |
| [Hosted pages](docs/hosted-pages.md) | Publish a page and invite reviewers by link |
| [Attach an agent](docs/attach.md) | Let an agent answer notes on its own |
| [Hub](docs/hub.md) | Home page with every review and note; running it all the time |
| [Docker](docs/docker.md) | The review server in a container |
| [GitHub Action](docs/github-action.md) | A review page on every pull request |
| [Security](docs/security.md) | Who can reach your pages, and how they are protected |
| [Benchmark](docs/benchmark.md) | Speed and cost comparison, with caveats |
| [Sync protocol](docs/sync-protocol.md) | Wire protocol of hosted pages, sync and presence |

## Contributing

Bug reports, examples, docs fixes and packs are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md). Issues labelled [`good first issue`](https://github.com/MandalorianBatman/austere-axi/labels/good%20first%20issue) are small with a clear finish line. Security problems: [report privately](https://github.com/MandalorianBatman/austere-axi/security/advisories/new), not in an issue.

## License

MIT. Builds on [OpenUI](https://github.com/thesysdev/openui) (MIT). The review loop design comes from [lavish-axi](https://github.com/kunchenguid/lavish-axi) (MIT).
