# austere-axi documentation

What austere-axi is and how to start: the [project README](../README.md).

## Guides

| Guide | What is in it |
|---|---|
| [Install and quick start](install.md) | CLI commands, setup skill, Claude Code plugin, MCP server for Claude Desktop, Cursor and Codex |
| [How it works](how-it-works.md) | What the agent writes (OpenUI Lang), the review loop, comparison with lavish-axi, what is not in v1 |
| [CLI reference](cli.md) | Every command, the review rules, environment variables |
| [Components and packs](components-and-packs.md) | Finding components, installing packs, the trust list, private registries |
| [Diagrams](diagrams.md) | Every diagram type, which component or recipe draws it, its status; how an agent picks one |
| [Writing a pack](writing-a-pack.md) | From scaffold to `npm publish` |
| [Team review](team-review.md) | `share`: teammates on your tailnet review a page under their own name |
| [Hosted pages](hosted-pages.md) | `publish`: a hosted copy of a page with one invite link per reviewer |
| [Attach an agent](attach.md) | Turning an agent on for a page: modes, sessions, the write grant, runs, Stop and Retry |
| [Hub](hub.md) | Home page over every review and note; `server install` for an always-on server, also behind a reverse proxy |
| [Docker](docker.md) | The review server in a Linux container: `compose.yaml`, host network and PIDs, limits |
| [GitHub Action](github-action.md) | Check and export review pages on every pull request |
| [Security](security.md) | Server binding, owner key, browser sign-in, page sandbox, packs, telemetry |

## Reference

| Document | What is in it |
|---|---|
| [Benchmark](benchmark.md) | austere-axi vs lavish-axi: output tokens, time, cost, caveats |
| [Sync protocol](sync-protocol.md) | Wire protocol of hosted pages: versioning, WebSocket endpoints, frames, mutations, access, presence |

## Contributing

Setup, repository layout and release steps: [CONTRIBUTING.md](../CONTRIBUTING.md).
