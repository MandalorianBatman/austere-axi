# austere-axi

[![npm version](https://img.shields.io/npm/v/austere-axi)](https://www.npmjs.com/package/austere-axi)
[![npm downloads](https://img.shields.io/npm/dm/austere-axi)](https://www.npmjs.com/package/austere-axi)
[![jsDelivr hits](https://img.shields.io/jsdelivr/npm/hm/austere-axi)](https://www.jsdelivr.com/package/npm/austere-axi)
[![skills.sh](https://skills.sh/b/mandalorianbatman/austere-axi)](https://skills.sh/mandalorianbatman/austere-axi)
[![CI](https://github.com/MandalorianBatman/austere-axi/actions/workflows/ci.yml/badge.svg)](https://github.com/MandalorianBatman/austere-axi/actions/workflows/ci.yml)
[![node](https://img.shields.io/node/v/austere-axi)](https://www.npmjs.com/package/austere-axi)
[![license](https://img.shields.io/npm/l/austere-axi)](LICENSE)

Review artifacts for coding agents, written in [OpenUI Lang](https://github.com/thesysdev/openui) instead of hand-written HTML.

The agent writes a short program: one named statement per line, built from a fixed set of components. The reviewer opens it in the browser, points at anything, and the agent gets the feedback back addressed by statement name. To revise, the agent edits only the statements the feedback names, and the page updates in place.

It is the same loop as [lavish-axi](https://github.com/kunchenguid/lavish-axi). The difference is that the agent never writes CSS or layout.

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

[`examples/session-migration.html`](examples/session-migration.html) is a full page: a KPI row, a diagram, a table, a chart, a diff, and a decision form. The whole file is about 1,000 tokens.

## Why

Lavish makes the agent author an entire HTML page every time, and re-author it after every round of feedback. That is slow, because output tokens are the slow part, and it is expensive.

austere-axi changes three things:

| | lavish-axi | austere-axi |
|---|---|---|
| What the agent writes | Full HTML + CSS + inline SVG | OpenUI Lang statements |
| Revising after feedback | Regenerate the file | Edit the named statements; the page patches in place and highlights what changed |
| Feedback target | CSS selector + text | Statement name, its line in the file, plus cell / diff line / diagram node / selected text |
| Validation | In-browser layout audit | `austere-axi check`: the renderer's own parser, in Node, no browser |
| Look | Whatever the agent designs | One consistent dark design across agents |

## How it works

```
agent writes plan.html ──► austere-axi plan.html ──► local server + browser review
                                                        │  reviewer annotates, picks options,
                                                        │  types, presses Send
agent edits statements ◄── austere-axi poll plan.html ◄─┘  (long-poll returns the batch)
          │
          └─► page updates in place and flashes the changed statements
```

- **An artifact is a plain `.html` file.** It contains one `<script>` tag for the runtime and one `<script type="text/openui">` block holding the program. Opened directly, it renders from the CDN. Under review, the server points that tag at a local copy.
- **The runtime** bundles the OpenUI React renderer with a curated component library: 58 of the stock components, plus `Architecture` (with `Node`, `Edge` and `Group`), `Mermaid`, `Diff` and `FileTree`. Every rendered statement is tagged with its name.
- **Architecture diagrams** are laid out automatically ([dagre](https://github.com/dagrejs/dagre)): the agent writes nodes, edges and groups as statements and never a coordinate. Each node and edge is its own click target, so feedback on a diagram arrives as `annotation: api (Node)` with its line. The layout runs across when that stays legible at the page width and down otherwise, so a phone gets a tall diagram. Mermaid stays for sequences, state machines, ER and gantt.
- **Annotations** resolve to the innermost named statement. They also carry precise detail where it exists: table row and column, `file:+line` for diff lines, the label of a diagram node, or the selected text. The popover shows the parent chain, so the reviewer can retarget a note to an enclosing section.
- **Buttons and forms** are feedback channels. `@ToAssistant("…")` queues a message along with the form's values. A button with no action sends its label.
- **Remote review.** When Tailscale is running, the server also listens on this machine's tailnet IP, and `open` prints a phone link. The review UI has a mobile layout with a conversation sheet.

## Install

Requires Node.js 20 or later.

**Run it without installing** (what agents use):

```sh
npx -y austere-axi --help
```

`npx` downloads the package into npm's cache and runs it. `-y` skips the install prompt, so a non-interactive agent never stalls on it. Prefix every command below the same way: `npx -y austere-axi spec`, `npx -y austere-axi plan.html`, and so on.

**Or install the command globally:**

```sh
npm install -g austere-axi
austere-axi --help
```

A global install stays on the version you installed until `npm update -g austere-axi`. Mixing the two is fine: a newer CLI replaces an older background server automatically.

**Agent skill (optional):**

```sh
npx skills add MandalorianBatman/austere-axi --skill austere
```

The skill tells an agent when a page beats prose and adds an `/austere <request>` command. It is a stub that sends the agent to `npx -y austere-axi --help` and `spec`, so an installed copy cannot go stale. Agents that can run shell commands do not need it.

## Quick start

```sh
npx -y austere-axi spec              # component reference for the agent (read once per session)
npx -y austere-axi plan.html         # validate and open the page for review
npx -y austere-axi poll plan.html    # wait for the reviewer to press Send
```

`--help` prints the file skeleton and the full review loop.

## CLI

```
austere-axi                      sessions + usage
austere-axi <file>               validate + open a review   [--no-open] [--reopen]
austere-axi poll <file>          long-poll for feedback      [--agent-reply "..."] [--takeover]
austere-axi reply <file>         post a reply without polling
austere-axi end <file>           end the review as the agent
austere-axi check <file>         validate the program (no browser)
austere-axi patch <file>         merge statements from stdin into the program
austere-axi spec [group...]      component reference (~6.4k tokens; groups narrow it)
austere-axi export <file>        one self-contained HTML file, works offline
austere-axi stop                 stop the background server
```

Output is compact YAML, written for agents to read. `poll` returns each item with the statement it points at and that statement's line in the file, so the agent can edit it without re-reading the file.

Session rules follow lavish:

- Only one poll listens on a session at a time.
- Feedback sent while no agent is listening is queued until the next poll.
- A review the user ended is not reopened unless `--reopen` is passed.
- If every review tab stays closed, `poll` returns `browser_disconnected`. The wait is 10 s after a tab is closed, or 5 min after a dropped connection, such as a phone screen locking.

### Environment

| Variable | Default | |
|---|---|---|
| `AUSTERE_AXI_PORT` | `4388` | server port |
| `AUSTERE_AXI_STATE_DIR` | `~/.austere-axi` | sessions, server log |
| `AUSTERE_AXI_NO_OPEN` | | `1` = never launch a browser |
| `AUSTERE_AXI_HOST` | | extra concrete bind address (never `0.0.0.0`) |
| `AUSTERE_AXI_NO_TAILSCALE` | | `1` = loopback only |
| `AUSTERE_AXI_LINK_HOST` | | host to print in the remote link |
| `AUSTERE_AXI_ALLOWED_HOSTS` | | extra `Host` headers to accept (reverse proxy) |
| `AUSTERE_AXI_DISCONNECT_GRACE_MS` | `300000` | how long a dropped connection may stay away before `poll` returns; `0` disables |
| `AUSTERE_AXI_IDLE_TIMEOUT_MS` | `1800000` | idle server shutdown; `0` disables |

## Security

The server binds to loopback, plus the Tailscale IP when Tailscale is up. It never binds to every interface.

- **CLI control routes** (`/api/*`) answer only loopback callers.
- **Host headers** are checked against an allowlist, as a DNS-rebinding defense.
- **Mutating browser routes** reject foreign `Origin` headers.
- **The artifact** runs in a sandboxed iframe with no same-origin access.
- **File access** covers only the artifact's own directory, with no dotfiles.

The Node side of OpenUI ships PostHog telemetry. The CLI sets `OPENUI_TELEMETRY_DISABLED=1` so nothing is sent; the browser runtime never sends telemetry.

## Not in v1

These are left out of v1 on purpose:

- **Image attachments** in feedback.
- **Live data:** `Query` and `Mutation` are disabled, so artifacts are static.
- **Themes:** there is one dark theme. Per-project accents via OpenUI's `ThemeProvider` are an easy follow-up.
- **Hosted sharing:** use `export` to produce a single offline file instead.

## Development

```sh
npm install
npm run build     # dist/: austere.js (runtime), mermaid.min.js, spec.json, prompt.md, chrome/, cli.mjs
npm test
node dist/cli.mjs examples/session-migration.html
```

| Path | Contents |
|---|---|
| `src/runtime/components/` | Custom components (`Architecture` family, `Diff`, `Mermaid`, `FileTree`), one self-describing file each, collected automatically |
| `src/runtime/stock.js` | Which stock OpenUI components ship, their prompt groups, renderer overrides |
| `src/runtime/` | Library assembly, annotation layer, review bridge, styles |
| `src/chrome/` | Review UI around the artifact iframe |
| `src/cli/` | CLI, server, session store, `check`, `export` |
| `src/shared/statements.js` | Statement splitter used by both sides |

To add or change a component, follow [`.agents/skills/add-component/SKILL.md`](.agents/skills/add-component/SKILL.md). It is a maintainer-only skill and is not published; agents working in this repo pick it up through `AGENTS.md`. Tests enforce the mechanical rules:

- every component sits in a prompt group
- the component reference stays within its token budget
- released prop orders are append-only (`npm run signatures`)
- every example passes `check`

For visual checks, `npm run gallery` and `npm run shot` render the components headlessly. `npm run test:browser` drives the real review loop in headless Chrome. It needs Chrome, or `CHROME_PATH` set to a browser, and it checks:

- every component and example renders at desktop and phone width without errors or sideways scrolling
- every clickable part reaches `poll` correctly

Before committing, [`.agents/skills/review-change`](.agents/skills/review-change/SKILL.md) runs these checks plus three review agents from `.agents/agents/`:

- **change-reviewer:** an independent code review
- **visual-qa:** looks at screenshots, including stress inputs
- **cold-start-author:** writes a page from `--help` and `spec` alone, to test the agent-facing docs

All of this is maintainer-only and is not published.

CI (`.github/workflows/ci.yml`) builds and tests on every push to `main` and every pull request: Node 20, 22 and 24 on Linux, Node 24 on Windows, plus the browser suite. To release, bump `version` in `package.json`, push, and publish a GitHub Release. `.github/workflows/publish.yml` then tests again and publishes to npmjs.org through npm trusted publishing, with no token secret.

The runtime is about 3 MB minified. It is served locally and cached. `export` inlines it, and inlines Mermaid too when the artifact uses it.

## License

MIT. Builds on [OpenUI](https://github.com/thesysdev/openui) (MIT) and borrows the review-loop design of [lavish-axi](https://github.com/kunchenguid/lavish-axi) (MIT).
