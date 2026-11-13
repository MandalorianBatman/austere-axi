# austere-axi

[![npm version](https://img.shields.io/npm/v/austere-axi)](https://www.npmjs.com/package/austere-axi)
[![npm downloads](https://img.shields.io/npm/dm/austere-axi)](https://www.npmjs.com/package/austere-axi)
[![jsDelivr hits](https://img.shields.io/jsdelivr/npm/hm/austere-axi)](https://www.jsdelivr.com/package/npm/austere-axi)
[![skills.sh](https://skills.sh/b/mandalorianbatman/austere-axi)](https://skills.sh/mandalorianbatman/austere-axi)
[![CI](https://github.com/MandalorianBatman/austere-axi/actions/workflows/ci.yml/badge.svg)](https://github.com/MandalorianBatman/austere-axi/actions/workflows/ci.yml)
[![node](https://img.shields.io/node/v/austere-axi)](https://www.npmjs.com/package/austere-axi)
[![license](https://img.shields.io/npm/l/austere-axi)](LICENSE)

Review pages for coding agents.

1. The agent writes a short [OpenUI Lang](https://github.com/thesysdev/openui) program, not HTML.
2. You open it in the browser, click any part, and write a note.
3. The agent gets each note with the name of the statement it points at, edits only those statements, and the page updates in place.

![An agent writes a page, the reviewer clicks a table cell and a diagram node and sends two notes, and the page patches in place with the changed statements flashing](docs/demo.gif)

<sub>The real loop, about 30 s: [MP4](docs/demo.mp4) · [WebM](docs/demo.webm).</sub>

**[Website](https://mandalorianbatman.github.io/austere-axi/)** · **[Playground](https://mandalorianbatman.github.io/austere-axi/play/)** (no install) · **[Gallery](https://mandalorianbatman.github.io/austere-axi/gallery/)** · **[Benchmark](docs/benchmark.md)** · **[Writing a pack](docs/writing-a-pack.md)**

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

A full page (KPIs, diagram, table, chart, diff, decision form) is about 1,000 tokens: [`examples/session-migration.html`](examples/session-migration.html).

**See it without installing:** the [gallery](https://mandalorianbatman.github.io/austere-axi/gallery/) shows example pages next to their source and token counts. The [playground](https://mandalorianbatman.github.io/austere-axi/play/) lets you edit OpenUI Lang and see the page live.

## Quick start

Needs Node.js 22.18 or later. Your agent runs:

```sh
npx -y austere-axi spec              # component reference (read once per session)
npx -y austere-axi plan.html         # validate and open the page for review
npx -y austere-axi poll plan.html    # wait until the reviewer presses Send
```

`--help` prints the file skeleton and the loop (about 900 tokens); `help all` adds the rarer commands and the environment. The agent does not look at the page itself: the reviewer judges how it looks, and render failures come back through `poll`. To have agents reach for it on their own, use the [skill, plugin or MCP server](#install).

## Why

Same loop as [lavish-axi](https://github.com/kunchenguid/lavish-axi). The difference: the agent never writes HTML, CSS or layout.

| | lavish-axi | austere-axi |
|---|---|---|
| Agent writes | Full HTML + CSS + SVG | OpenUI Lang statements |
| After feedback | Edits the HTML; the page reloads | Edits the named statements; the page patches in place |
| Feedback points at | CSS selector + text | Statement name and line, plus table cell, diff line, diagram node or selected text |
| Validation | Layout audit in the browser | `austere-axi check`, in Node, no browser |
| Look | Different for each agent | One dark design |

Fewer output tokens: faster pages, lower cost. From the [benchmark](docs/benchmark.md):

<!-- bench:start -->
Across 36 paired runs (6 review pages, 2 models), lavish-axi spent a median **3.2×** the output tokens of austere-axi to produce the same page, took **2.4×** as long and cost **2.5×** as much. Answering one reviewer note took **2.7×** the output tokens.
<!-- bench:end -->

lavish-axi does better in some cases. Read the benchmark caveats before you quote the numbers.

## Install

Needs Node.js 22.18 or later.

**Let your agent do it.** Install the setup skill, then ask your agent to "set up austere-axi":

```sh
npx skills add MandalorianBatman/austere-axi --skill austere-setup
```

It checks Node, installs the `austere` skill, offers the optional items below, and opens a test page.

**Or do it yourself.** Agents can run the CLI with no install (`-y` skips the npm prompt):

```sh
npx -y austere-axi --help
```

Optional:

```sh
npm install -g austere-axi                                     # `austere-axi` command, no npx
npx skills add MandalorianBatman/austere-axi --skill austere   # tells agents when to make a page; adds /austere
```

The `austere` skill only points at `--help` and `spec`, so it never goes stale. A global install stays on its version until `npm update -g austere-axi`.

### Claude Code plugin

Bundles the `austere` skill (and `/austere`), the `austere-setup` skill and the MCP server:

```sh
claude plugin marketplace add MandalorianBatman/austere-axi
claude plugin install austere@austere-axi
```

In a session: `/plugin marketplace add MandalorianBatman/austere-axi`, then `/plugin install austere@austere-axi`. The MCP server runs `npx -y austere-axi mcp` (needs Node 22.18+ and npm access). `claude plugin update austere` updates the skill text; the CLI comes from npm each time.

### MCP

`austere-axi mcp` is an MCP server on stdio. Tools: `spec`, `check`, `open`, `poll`, `reply`, `patch`, `end`. Each one runs the CLI command of the same name, so the loop is the same as on the command line.

- `poll` returns `status: timeout` after 50 s by default, because many clients cancel longer calls. The agent polls again; nothing is lost. `timeout_ms: 0` waits until feedback arrives.
- `poll` and `reply` take the `cursor` a poll returned, like `--cursor`.
- Pass absolute file paths. The server resolves relative paths against its own working directory, which depends on the client.
- No screen? Set `AUSTERE_AXI_NO_OPEN=1` in the server's `env` so `open` prints the link instead. Other [environment variables](#environment) work the same way.

**Claude Desktop** (`claude_desktop_config.json`) and **Cursor** (`~/.cursor/mcp.json`, or `.cursor/mcp.json` in a project):

```json
{
  "mcpServers": {
    "austere": {
      "command": "npx",
      "args": ["-y", "austere-axi", "mcp"]
    }
  }
}
```

**Codex** (`~/.codex/config.toml`), or `codex mcp add austere -- npx -y austere-axi mcp`:

```toml
[mcp_servers.austere]
command = "npx"
args = ["-y", "austere-axi", "mcp"]
```

## How it works

```
agent writes plan.html ──► austere-axi plan.html ──► local server + browser review
                                                        │  reviewer annotates, picks options,
                                                        │  types, presses Send
agent patches changes  ◄── austere-axi poll plan.html ◄─┘  (long-poll returns the batch)
          │
          └─► page updates in place and flashes the changed statements
```

- **A page is a plain `.html` file:** one runtime `<script>` tag and one `<script type="text/openui">` block. Opened directly, it loads the runtime from the CDN. Under review, the server serves a local copy.
- **Components:** 58 stock OpenUI components, plus `Architecture` (`Node`, `Edge`, `Group`), `Diff` and `FileTree`. Nine shadcn-style components come as a bundled [pack](#components-and-packs).
- **Diagrams lay out automatically** ([dagre](https://github.com/dagrejs/dagre)); the agent never writes coordinates. Every node and edge is a click target. `lanes` puts each group in a column; `tone` colors a box or line to show risk.
- **Notes** attach to the smallest named statement under the click, with detail where it exists: table row and column, `file:+line` in a diff, a diagram node, or selected text. The reviewer can move a note to a parent section.
- **Changes flash** after each agent turn, and the bar shows `N changed`. Click it to keep the last turn's changes outlined until you click again.
- **Buttons and forms send feedback.** `@ToAssistant("…")` sends a message with the form values. A button with no action sends its label.
- **Phone review:** with Tailscale running, the server also listens on the tailnet IP and prints a phone link. That link carries your owner key; keep it private. The review UI has a mobile layout.

## CLI

Usage errors (unknown command or flag, missing argument) exit 2 before anything runs; failures exit 1. `<command> --help` prints that command's flags and an example.

```
austere-axi                      sessions + command list
austere-axi <file>               validate + open a review   [--no-open] [--reopen]
austere-axi poll <file>          long-poll for feedback      [--cursor n] [--agent-reply "..."] [--after n] [--takeover]
austere-axi reply <file>         post a reply without polling   [--cursor n]
austere-axi end <file>           stop as the agent; the reviewer can still add notes
austere-axi close <file>         close the review: no more notes until reopen
austere-axi reopen <file>        reopen an ended or closed review
austere-axi login [file]         single-use link that signs a browser in as you (SSH, --no-open)
austere-axi feedback <file>      feedback no agent has answered yet   [--all] [--peek]
austere-axi check <file>         validate the program (no browser)    [--fix] [--render: headless Chrome, text report]
austere-axi patch <file>         merge statements from stdin into the program (reports dropped unreferenced ones)
austere-axi spec [group|pack...] component reference (~5.8k tokens; groups narrow it)
austere-axi components ...       list | search | show | add | remove | new | build
austere-axi trust list|add|remove   packs your agent may add without --trust (see Trust)
austere-axi export <file>        one self-contained HTML file, works offline
austere-axi hub on|off|status|list|notes|open   home page with every page and note
austere-axi share <file> --as "<name>"   invite link for a teammate on your tailnet   [--auto]
austere-axi share list|revoke           see invites, cut one off
austere-axi stop                 stop the background server
austere-axi server --persist     run the server in the foreground and never idle out
austere-axi mcp                  MCP server on stdio (see MCP)
```

Output is compact YAML for agents. Each `poll` item has its statement and that statement's line and source, so the agent does not read the file again. Agents revise with `patch` only: they send the changed statements, never the whole file.

### Session rules

- **One listener:** one `poll` listens on a session at a time.
- **No lost notes:** every note is written to `~/.austere-axi/hub.db` before the page is told it was sent, so it survives a server crash or restart. Feedback sent while no agent listens waits for the next poll.
- **Acknowledge with the cursor:** `poll` prints a `cursor`. Passing it back (`--cursor n` on the next `poll` or `reply`), or replying at all, acknowledges everything up to it. Without it, `poll` returns the same feedback again, so a crash or timed-out tool call loses nothing. `--after n` replays from any point.
- **End is soft:** ending a review (the agent's `end`, or **End review** in the page) means the agent stopped. The reviewer can still send notes. The next `poll` returns every unacknowledged note, including ones sent before the end or released from hold after it, and reopens the review. A batch the reviewer sent together with end stays final.
- **Close is hard:** only the owner's **close** (`close <file>`, or **Close review** in the page) locks the composer. `reopen <file>` or **Reopen review** unlocks it.
- A review the user ended or closed opens again only with `--reopen`.
- An `Image` src that is a path relative to the page (png, jpg, gif, webp, svg, avif) loads under review for the owner and for invited reviewers, and `export` inlines it as a data URI. Both read only regular files in the page's own folder, never dotfiles or links that leave it; `export` skips an image over 10 MB. A file `export` cannot read stays as written, and the output names it in `notices`.
- **Tabs closed:** `poll` returns `browser_disconnected` 10 s after the last review tab closes, or 5 min after a dropped connection (for example, a locked phone). The review stays open, so later notes reach the next `poll`.
- `feedback <file>` returns notes no agent has answered, from any day. Reading them acknowledges them; `reply` marks them answered.
- **Render failures reach the agent without a click:** an unknown component or a component that throws. The owner's open review page sends them as a note from "Render check", once per page revision, and `poll` returns them as `render_error` items. With no review tab open, nothing renders, so nothing is sent. `check --render <file>` renders the page in headless Chrome (an installed Chrome, Chromium or Edge, or `CHROME_PATH`) at 1280 and 390 px, opens each tab in turn, and prints render errors and the statements that make the page scroll sideways, as text, with no screenshot. Agents run it only when the user asks for a check.

## Components and packs

`spec` covers the common components (~5.8k tokens). Rare ones (area and scatter charts, sliders, switches, editable tables, …) are in the library but not in `spec`. Find them with `components`:

```sh
austere-axi components                  # every component, by group
austere-axi components search scatter   # search by name, group, description; also packs on npm
austere-axi components show AreaChart   # signature, notes, example
austere-axi components show Milestones --pack austere-pack-orbit   # one pack's, when several share the name
```

**Packs** add components. A pack is an npm package with `dist/pack.js` (the components, a few KB) and `dist/catalog.json` (signatures, examples, schema).

```sh
austere-axi components add austere-pack-gantt --trust   # npm name, folder, or .tgz
austere-axi check --fix plan.html                       # adds the pack tag to the page
```

`components search` and `components show` also cover packs on npm that are not installed, meaning any package with the keyword `austere-axi-pack`. Search lists up to 8 core and installed components under `results`, then up to 3 from packs on npm under `npm`, so a pack on npm never pushes a core component out. A result names its pack, says `not installed`, and says whether the pack is first-party, `trusted` (on your trust list) or third-party; `show` cuts such a component's description, example and notes short. `show <Name>` returns the first component by that name, core and installed packs first; `--pack <pack>` looks only in that pack, and search names it for an npm result whose name another result or a local component shares. The CLI reads the pack's catalog from its tarball, checked against the registry's integrity hash, and runs none of its code. It caches the pack list for an hour, under `~/.austere-axi/npm-packs/`. It caches each pack version for good once it is read, fails the install checks, or the registry answers 404 or 410 for it; any other failure is tried again on the next search. For a third-party pack, the agent is told to ask you to review it and run `components add <pack> --trust`. With the registry unreachable, search shows local results, says so, and tries the registry again after 5 minutes. A pack the registry fails to serve is left out, and search says how many were.

A page names its packs in the head, so it renders anywhere:

```html
<meta name="austere-packs" content="austere-pack-gantt@1.2.0 sha384-…">
```

- Under review, the server serves an installed pack only while it matches its hash in `~/.austere-axi/packs.json`. Opened directly, the page loads packs from jsDelivr with Subresource Integrity. `export` inlines them.
- A pack component with no pack tag is a `missing-pack` error. `check --fix` repairs it.
- **Bundled packs** need no tag and load only when used:
  - `shadcn`: `Progress`, `Avatar`, `AvatarGroup`, `Tooltip`, `HoverCard`, `Breadcrumb` (`BreadcrumbItem`), `Kbd`, `Skeleton`, `Calendar` and `Timeline` (`TimelineItem`). Read-only.
  ```
  rollout = Progress(64, "Rows migrated")
  freeze = Calendar("2026-11", ["2026-11-04 Code freeze"])
  ```

**Trust.** Pack code runs inside your review pages, where notes and button presses also come from. Packs under `@austere-axi/` on npm install directly. Other npm packs and any `.tgz` need `--trust`, so read them first. A local folder counts as your own. A page with third-party packs shows a warning, and `poll` tells the agent.

Your trust list, `~/.austere-axi/trusted.json`, names npm packs your agent may install without `--trust`:

```sh
austere-axi trust add austere-pack-gantt@1.2.0   # pins that version and the hash of its pack.js
austere-axi trust add @acme                      # every pack in a scope on the current registry, e.g. your company's
austere-axi trust list
austere-axi trust remove @acme
```

- A pin trusts one exact version with the same `pack.js`. A later publish, or the same version with other code, still needs `--trust`. `components add <pack>` with no version installs the pinned one.
- A scope is bound to the registry it was added from (`AUSTERE_AXI_NPM_REGISTRY`, else `npm_config_registry`, else npmjs). Pointed at another registry, packs in that scope are third-party again, since anyone may own the same scope name there.
- Search marks packs on the list `trusted` and tells the agent it may add them.
- `trust add` asks you to confirm at a terminal and refuses when stdin is not one, which is how agents run commands. That stops an agent adding a search hit to the list by accident. It does not stop an agent set on editing the file.
- Only this file in your home folder counts. A project cannot ship its own list.
- If the file is unreadable, search counts every npm pack third-party and says so, while `components add` and `trust` refuse until you fix or delete it.

**Write a pack:** [Writing a pack](docs/writing-a-pack.md) goes from scaffold to `npm publish`, with [austere-pack-gantt](https://github.com/MandalorianBatman/austere-pack-gantt) as the example. Short version:

```sh
austere-axi components new austere-pack-milestones
cd austere-pack-milestones && npm install && npm run build
austere-axi components add .
```

Each component uses `austereComponent` from `austere-axi/pack`: a PascalCase name, zod props in positional order (append-only after you publish), a one-line description and an example. The build loads the pack in Node, so build only code you trust.

## Hub

The server starts when needed and stops after 30 idle minutes. Every review is kept in `~/.austere-axi/hub.db` (SQLite) either way. `hub on` adds a home page over it and indexes every page you `check` or `patch`:

```sh
austere-axi hub on      # http://127.0.0.1:4388/: pages by project and day, with search
austere-axi hub list    # the same, for an agent: [words] [--project dir]
austere-axi hub notes   # every note, same for an agent: [words] [--project dir] [--unanswered]
austere-axi hub off     # back to the plain session list; the database stays
```

The home page shows which reviews are live and how much feedback the agent answered. `/notes` lists every note, newest first, with search, status and project filters.

- Session files from before 0.5 (`~/.austere-axi/sessions/*.json`) are imported into `hub.db` on first start and renamed to `*.imported`.
- One server runs per state dir; a second one refuses to start. `server.lock` holds the running server's pid and port. If that server no longer answers on the port, the lock is stale and is taken over.

### Always on, behind a reverse proxy

Run the server under a supervisor with `--persist` so it never idles out, and point the proxy at it:

```ini
# ~/.config/systemd/user/austere-axi.service
[Unit]
Description=austere-axi review server

[Service]
ExecStart=/usr/bin/env npx -y austere-axi server --persist
Environment=AUSTERE_AXI_LINK_URL=https://austere.example.com
Restart=on-failure

[Install]
WantedBy=default.target
```

Then `systemctl --user enable --now austere-axi`. CLI commands on the same machine use the running server. A newer CLI that replaces an older server also starts it with `--persist`. `AUSTERE_AXI_PERSIST=1` is the same as `--persist`.

Read the [trust model](#team-review) first: behind a proxy on the same machine, every request looks local.

## Team review

Teammates on your tailnet can review a page and leave notes under their own name. The server still runs on your machine. No accounts, no hosted service.

```sh
austere-axi share plan.html --as "Ana"           # prints a link; notes wait for you
austere-axi share plan.html --as "Bo" --auto     # Bo's notes go straight to the agent
austere-axi share list [--links]                 # who has a link
austere-axi share revoke Ana                     # name or id; takes effect at once
```

Send the link to the teammate. It needs Tailscale (or `AUSTERE_AXI_HOST`); without one, `share` stops with an error.

- **Hold (default):** a teammate's note waits in your side panel. **Send** one note, **Send all**, or **Discard**. The agent does not see held notes (`poll` and `feedback` skip them) until you send them. Up to 200 held notes per teammate; more are refused until you send or discard some.
- **Auto:** the note goes to the agent without your approval.
- **Author:** `poll` and `feedback` show `from: <name>` on a teammate's note. Your own notes have no `from`. The hub Notes view shows the author and can filter on it.
- **Reviewers can** read the page and the conversation, and add notes. They cannot end the review, export, or send held notes.

**Trust model.** Anyone with the link who can reach your machine on the tailnet can post notes under that name until you revoke it. Share only with people you trust, and revoke when the review is done.

- The link holds a random 192-bit token. Opening it shows a "Continue as <name>" button. Pressing it (a same-origin POST) trades the token for a cookie and removes it from the address bar, so a link opened from another site cannot turn your browser into a reviewer.
- A request without a valid invite or the owner key is refused, on loopback too. The hub and its Notes view are yours only. A reverse proxy on the same machine gets no owner rights from looking local.
- Your own phone link carries the owner key (`~/.austere-axi/owner.key`); do not forward it. To revoke all old phone links and owner cookies, delete that file and restart the server.

## GitHub Action

Posts an austere review page on every pull request: runs `austere-axi check` on the pages you commit, exports each with `austere-axi export`, uploads them as a workflow artifact, and posts or updates **one** PR comment with a summary and a download link.

```yaml
# .github/workflows/austere.yml
name: austere review
on: pull_request

permissions:
  contents: read
  pull-requests: write   # to post the comment

jobs:
  review:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7
      - uses: MandalorianBatman/austere-axi/action@v0.7.0
        with:
          pages: reviews/*.html
```

| Input | Default | |
|---|---|---|
| `pages` | required | paths or globs, one per line, relative to the workspace |
| `version` | `latest` | austere-axi version from npm; pin it for reproducible runs |
| `artifact-name` | `austere-review` | workflow artifact that holds the exported pages |
| `retention-days` | repository default | artifact retention |
| `comment` | `true` | `false` leaves only the artifact and the job summary |
| `comment-tag` | `default` | names the sticky comment; use one per use of the action in the same PR |
| `github-token` | `github.token` | needs `pull-requests: write` to comment |

Outputs: `ok` (`true` when every page passed) and `artifact-url`.

- **A failing check fails the job.** The log and the job summary show each error with its statement and line. Pages that passed are still exported.
- **Fork PRs** get a read-only token, so the comment is skipped with a warning. The job summary and the artifact still carry the report.
- **Sticky comment:** the action updates only a marked comment posted by its own token's account (a bot account for `github.token`). If someone else posts a comment with the same marker, the action leaves it alone and posts its own.
- **Triggers:** use `pull_request`. Do not use `pull_request_target` to run pages from a fork.
- **Artifact:** GitHub zips it and needs a login to download. Unzip and open the HTML in a browser; it works offline. No Pages preview.
- The action lives in this repo under `action/`, so one ref pins both the action and the CLI contract it calls. `version` still picks the CLI.

## Environment

| Variable | Default | |
|---|---|---|
| `AUSTERE_AXI_PORT` | `4388` | server port |
| `AUSTERE_AXI_STATE_DIR` | `~/.austere-axi` | sessions, owner key, server log (mode 0700 on macOS and Linux) |
| `AUSTERE_AXI_NO_OPEN` | | `1` = never open a browser |
| `AUSTERE_AXI_HOST` | | extra bind address (never `0.0.0.0`) |
| `AUSTERE_AXI_NO_TAILSCALE` | | `1` = loopback only |
| `AUSTERE_AXI_LINK_HOST` | | host in the printed remote link (`http://<host>:<port>`) |
| `AUSTERE_AXI_LINK_URL` | | full origin of the printed remote link, e.g. `https://austere.example.com` behind a TLS proxy; the host is accepted without `ALLOWED_HOSTS` |
| `AUSTERE_AXI_ALLOWED_HOSTS` | | extra `Host` headers to accept (reverse proxy) |
| `AUSTERE_AXI_DISCONNECT_GRACE_MS` | `300000` | how long a dropped connection can stay away before `poll` returns; `0` disables |
| `AUSTERE_AXI_IDLE_TIMEOUT_MS` | `1800000` | idle shutdown; `0` disables |
| `AUSTERE_AXI_PERSIST` | | `1`: never idle out, as `server --persist` |
| `AUSTERE_AXI_NPM_REGISTRY` | `npm_config_registry`, else npmjs | where `components add` gets packs and `components search` finds them |
| `CHROME_PATH` | an installed Chrome, Chromium or Edge | the browser `check --render` uses |

## Security

The server binds to loopback, plus the Tailscale IP when Tailscale is up. Never to all interfaces.

**Loopback is not the owner.** Other OS users on the machine can reach loopback too. The owner key (`owner.key`) is what proves ownership.

- **API:** `/api/*` answers only loopback callers that send the owner key, and refuses browser requests. `/api/health` needs no key. It proves the server holds the key with an HMAC of its port and the CLI's nonce, so the CLI never talks to, or hands the key to, another program on its port.
- **Browser sign-in:** when the CLI opens your browser, it gets a single-use login code from the server and opens the page with it. The server swaps the code for the owner cookie and removes it from the address bar. The key never appears on a command line or in output. A code works once, for 60 seconds. Another local user who reads it from the process list in that window can use it first; your browser then shows "used already", and `austere-axi login` gives you a new one.
- **Other browsers:** a printed `url` works in a browser that already has the cookie. For any other browser (SSH with a forwarded port, `--no-open`, a second browser), run `austere-axi login [file]` and open the link it prints.
- **Owner cookie** is an HMAC of the key, not the key. Browsers share `127.0.0.1` cookies across ports, so a program on another local port that your browser visits can read it. With it, that program can open your pages and the hub as you in a browser, but cannot call `/api/*`, which needs the key.

**Files.** On macOS and Linux the state dir is set to mode 0700 on every run. New files in it (`owner.key`, `server.log`, and `hub.db`, which holds every note) are mode 0600. Files an older version created keep their old mode, behind the 0700 dir. On Windows, file modes do not apply; only your user profile's permissions protect the state dir.

**Requests.**

- `Host` headers must be on an allowlist (DNS-rebinding defense).
- Browser routes that change state refuse a foreign `Origin`.
- Invite tokens are random, compared in constant time, and kept out of the log. A reviewer link can only add notes to its own page. See [Team review](#team-review).
- The server serves files only from the page's own directory, with no dotfiles.

**Page sandbox.** The page runs in a sandboxed iframe with no same-origin access; packs run there too. Page files are also served with `Content-Security-Policy: sandbox`, so a page opened in a popup or its own tab stays sandboxed. In review, the review page opens new-window links only if they are external `http(s):` or `mailto:` links. A popup the frame opens any other way stays sandboxed.

**Packs.** Third-party packs need `--trust` unless your trust list names them. Installed packs must match their lockfile hash; CDN loads use Subresource Integrity.

**Telemetry.** OpenUI's Node side has PostHog telemetry; the CLI sets `OPENUI_TELEMETRY_DISABLED=1`. The browser runtime sends none.

## Not in v1

- Image attachments in feedback.
- Live data: `Query` and `Mutation` are off, so pages are static.
- Themes: one dark theme only.
- Hosted sharing: use `export` to make one offline file.

## Development

```sh
npm install
npm run build     # dist/: runtime, packs, pack kit, spec, catalog, review UI, cli.mjs
npm test
npm run typecheck # tsc over src/cli, src/shared and the pack types
node dist/cli.mjs examples/session-migration.html
```

Repo layout, website, playground, benchmark, CI and release: [CONTRIBUTING.md](CONTRIBUTING.md).

## Contributing

Bug reports, examples, docs fixes and packs are welcome; [CONTRIBUTING.md](CONTRIBUTING.md) has setup and the rules. Issues labelled [`good first issue`](https://github.com/MandalorianBatman/austere-axi/labels/good%20first%20issue) are small and have a clear finish line. Security problems: [report privately](https://github.com/MandalorianBatman/austere-axi/security/advisories/new), not in an issue.

## License

MIT. Builds on [OpenUI](https://github.com/thesysdev/openui) (MIT). The review loop design comes from [lavish-axi](https://github.com/kunchenguid/lavish-axi) (MIT).
