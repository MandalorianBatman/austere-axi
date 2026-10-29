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
- **The runtime** bundles the OpenUI React renderer with a curated component library: 58 of the stock components, plus `Architecture` (with `Node`, `Edge` and `Group`), `Diff` and `FileTree`. `Mermaid` ships as a bundled [pack](#components-and-packs) that loads only on pages that call it. Every rendered statement is tagged with its name.
- **Architecture diagrams** are laid out automatically ([dagre](https://github.com/dagrejs/dagre)): the agent writes nodes, edges and groups as statements and never a coordinate. Each node and edge is its own click target, so feedback on a diagram arrives as `annotation: api (Node)` with its line. The layout runs across when that stays legible at the page width and down otherwise, so a phone gets a tall diagram. For a system split by owner or tier, `lanes` turns each group into a column with right-angle lines between them (stacked as bands on a phone); `tone` tints a box or line to mark risk or a store family. Mermaid stays for sequences, state machines, ER and gantt.
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
austere-axi feedback <file>      feedback no agent has answered yet   [--all] [--peek]
austere-axi check <file>         validate the program (no browser)    [--fix]
austere-axi patch <file>         merge statements from stdin into the program
austere-axi spec [group|pack...] component reference (~5.8k tokens; groups narrow it)
austere-axi components ...       list | search | show | add | remove | new | build
austere-axi export <file>        one self-contained HTML file, works offline
austere-axi hub on|off|status|list|open   persistent server with an index of every artifact
austere-axi stop                 stop the background server
```

Output is compact YAML, written for agents to read. `poll` returns each item with the statement it points at and that statement's line in the file, so the agent can edit it without re-reading the file.

Session rules follow lavish:

- Only one poll listens on a session at a time.
- Feedback sent while no agent is listening is queued until the next poll.
- A review the user ended is not reopened unless `--reopen` is passed.
- If every review tab stays closed, `poll` returns `browser_disconnected`. The wait is 10 s after a tab is closed, or 5 min after a dropped connection, such as a phone screen locking.
- Feedback outlives the agent session. `feedback <file>` returns what the reviewer said that no agent has answered: sent after polling stopped, or days ago. Reading it counts as received, so a later `poll` does not repeat it; `reply` marks it addressed.

## Components and packs

`spec` covers the components most pages need. Rarer ones (area and scatter charts, sliders, switches, editable tables, …) stay in the library but out of `spec`, which keeps it near 5.8k tokens. Each group's notes name them, and `components` finds them:

```sh
austere-axi components                  # every component, by group
austere-axi components search scatter   # ranked by name, group and description
austere-axi components show AreaChart   # signature, notes, an example
```

**Packs** add components without growing the core. A pack is an npm package with two built files: `dist/pack.js`, the components (a few KB: they use the page's React and zod), and `dist/catalog.json`, their signatures, examples and the schema `check` validates against.

```sh
austere-axi components add austere-pack-gantt --trust   # from npm; also a folder or an `npm pack` .tgz
austere-axi check --fix plan.html                       # declares the packs the page uses
```

A page that uses a pack names it in its head, so the page renders wherever it is opened:

```html
<meta name="austere-packs" content="austere-pack-gantt@1.2.0 sha384-…">
```

- Under review, the server serves installed packs, and only if they still match the hash in the lockfile (`~/.austere-axi/packs.json`). Opened directly, the page loads them from jsDelivr with Subresource Integrity. `export` inlines them.
- `check`, `spec` and `components` know the installed packs. Using a pack's component without declaring the pack is a `missing-pack` error, which `check --fix` resolves.
- Mermaid is the first pack. It ships inside austere-axi and loads only when the program calls `Mermaid(...)`, so it needs no tag and existing pages are unchanged.

**Trust.** A pack's code runs inside your review pages, where annotations and button presses also come from. Packs published to npm under `@austere-axi/` install directly; any other npm pack, and any `.tgz`, needs `--trust`, after you have read it. A local folder counts as your own. A page with third-party packs says so above the artifact, and `poll` tells the agent its items could have come from that code.

**Writing a pack.** `components new` writes a working pack with one component:

```sh
austere-axi components new austere-pack-timeline
cd austere-pack-timeline && npm install && npm run build
austere-axi components add .
```

Components follow the core contract, `austereComponent` from `austere-axi/pack`: a PascalCase name, zod props in positional order (append-only once published), a one-line description and an example. The build maps React, zod and `austere-axi/pack` onto the page's copies. It also loads the pack in Node to read its components, so build only code you trust, as with any npm script. Publish with `npm publish`.

## Hub

By default the server starts on demand and stops after 30 idle minutes. `hub on` keeps it running and indexes every artifact you open or check:

```sh
austere-axi hub on      # http://127.0.0.1:4388/: artifacts by project (git root) and day, with search
austere-axi hub list    # the same for an agent: [words] [--project dir]
austere-axi hub off     # back to on-demand; the index stays
```

For each artifact the home page shows whether a review is live and how much of its feedback the agent has answered. The index is SQLite (`~/.austere-axi/hub.db`), mirrored from the session files, so the review loop does not depend on it. The hub needs Node 22.13 or later, for `node:sqlite`; everything else runs on Node 20.
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
| `AUSTERE_AXI_IDLE_TIMEOUT_MS` | `1800000` | idle server shutdown; `0` disables (the hub never idles out) |
| `AUSTERE_AXI_NPM_REGISTRY` | `npm_config_registry`, else npmjs | where `components add` fetches packs |

## Security

The server binds to loopback, plus the Tailscale IP when Tailscale is up. It never binds to every interface.

- **CLI control routes** (`/api/*`) answer only loopback callers, and refuse any request a browser sends.
- **Host headers** are checked against an allowlist, as a DNS-rebinding defense.
- **Mutating browser routes** reject foreign `Origin` headers.
- **The artifact** runs in a sandboxed iframe with no same-origin access.
- **File access** covers only the artifact's own directory, with no dotfiles.
- **Packs** run inside that sandboxed iframe, so they cannot reach the server's routes. Third-party packs need `--trust` to install; installed ones are served only while they match their lockfile hash, and CDN loads carry Subresource Integrity.

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
npm run build     # dist/: austere.js (runtime), packs/, pack-kit.mjs, mermaid.min.js, spec.json, prompt.md, catalog.json, chrome/, cli.mjs
npm test
node dist/cli.mjs examples/session-migration.html
```

| Path | Contents |
|---|---|
| `src/runtime/components/` | Custom components (`Architecture` family, `Diff`, `FileTree`), one self-describing file each, collected automatically |
| `src/runtime/stock.js` | Which stock OpenUI components ship, which stay out of `spec` (`EXTENDED`), their prompt groups, renderer overrides |
| `packs/` | Packs bundled with austere-axi (`mermaid`), built like any third-party pack |
| `src/runtime/pack-api.js`, `src/pack-kit/` | What a pack imports as `austere-axi/pack`, and the build behind `components build` |
| `src/shared/catalog.js` | The component catalog: `components list/search/show`, a pack's `catalog.json`, the prompt tiers |
| `src/runtime/` | Library assembly, annotation layer, review bridge, styles |
| `src/chrome/` | Review UI around the artifact iframe |
| `src/cli/` | CLI, server, session store, `check`, `export`, packs (`packs.js`, `install.js`), hub (`hub.js`) |
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

The runtime is about 3 MB minified. It is served locally and cached. `export` inlines it, and inlines Mermaid and any packs the artifact uses.

## License

MIT. Builds on [OpenUI](https://github.com/thesysdev/openui) (MIT) and borrows the review-loop design of [lavish-axi](https://github.com/kunchenguid/lavish-axi) (MIT).
