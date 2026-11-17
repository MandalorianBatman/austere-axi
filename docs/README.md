# austere-axi documentation

The [project README](../README.md) says what austere-axi is and how to start. These guides hold the reference detail.

## Guides

| Guide | What is in it |
|---|---|
| [Install and quick start](install.md) | The commands your agent runs, the setup skill, the Claude Code plugin, and the MCP server for Claude Desktop, Cursor and Codex |
| [How it works](how-it-works.md) | What the agent writes (OpenUI Lang), the review loop, the comparison with lavish-axi, and what is not in v1 |
| [CLI reference](cli.md) | Every command, the session rules, and the environment variables |
| [Components and packs](components-and-packs.md) | Finding components, installing packs, the trust list, private registries |
| [Writing a pack](writing-a-pack.md) | From scaffold to `npm publish` |
| [Team review](team-review.md) | `share`: teammates on your tailnet review a page under their own name |
| [Hosted pages](hosted-pages.md) | `publish`: a hosted copy of a page with one invite link per reviewer |
| [Attach an agent](attach.md) | Turning an agent on for a page, from the page or a terminal: modes, sessions, the write grant, runs, Stop and Retry |
| [Hub](hub.md) | The home page over every review and note, and running the server all the time behind a reverse proxy |
| [GitHub Action](github-action.md) | Check and export review pages on every pull request |
| [Security](security.md) | What the server binds to, the owner key, browser sign-in, the page sandbox, packs, telemetry |

## Measurements and design notes

| Document | What is in it |
|---|---|
| [Benchmark](benchmark.md) | austere-axi against lavish-axi: output tokens, time, cost, and the caveats |
| [Hosted share links](hosted-share-links.md) | Design and wire protocol of hosted pages, sync and presence |
| [Durable notes](durable-notes.md) | Design of note storage and the cursor that acknowledges feedback |
| [Review loop v2](review-loop-v2.md) | Design of projects, pages without sessions, attach, history and reuse, the dashboard shell and the wiki; the settled decisions and the build order |

## Contributing

Setup, repository layout and release steps are in [CONTRIBUTING.md](../CONTRIBUTING.md).
