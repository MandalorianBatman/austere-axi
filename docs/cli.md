# CLI reference

Usage errors (unknown command or flag, missing argument) exit 2 before anything runs; failures exit 1. `<command> --help` prints that command's flags and an example.

```
austere-axi                      sessions + command list
austere-axi <file>               validate + register + open a review   [--no-open]
austere-axi poll [file]          long-poll for feedback; no file: every page of this folder's project   [--project p] [--cursor n] [--agent-reply "..."] [--after n]
austere-axi reply <file>         post a reply without polling   [--cursor n]

austere-axi login [file]         single-use link that signs a browser in as you (SSH, --no-open)
austere-axi feedback [file]      feedback no agent has answered yet; no file: every page of the project   [--project p] [--all] [--peek]
austere-axi check <file>         validate the program (no browser)    [--fix] [--render: headless Chrome, text report]
austere-axi patch <file>         merge statements from stdin into the program (reports dropped unreferenced ones)
austere-axi spec [group|pack...] component reference (~5.8k tokens; groups narrow it)
austere-axi components ...       list | search | show | add | remove | new | build
austere-axi trust list|add|remove   packs your agent may add without --trust (see Trust)
austere-axi registry list|add|remove   private npm registries for scopes (see Private registries)
austere-axi export <file>        one self-contained HTML file, works offline (~1.1 MB)
austere-axi hub [list|notes|open]   home page with every page by project and every note   [--project p] [--archived] [--all] [--unanswered]
austere-axi project list|add|merge|rename|forget-root   projects: a name and its root folders (see Hub)
austere-axi archive <file>       put a page away from the hub's lists and lock its composer; unarchive <file> brings it back
austere-axi share <file> --as "<name>"   invite link for a teammate on your tailnet   [--auto]
austere-axi share list|revoke           see invites, cut one off
austere-axi publish <file>       hosted copy of the page on austere.kasat.xyz   [--invite <name>]... [--expires <dur>] [--unlisted] [--auto] [--no-presence] [--new]
austere-axi publish invites|revoke <file> [name]   see a page's invites, cut one off
austere-axi publish list|rm <file|id>   your hosted pages; delete one now
austere-axi stop                 stop the background server
austere-axi server --persist     run the server in the foreground and never idle out
austere-axi server install|uninstall|status   always-on server as a per-user systemd or launchd service (see Hub)   [--port n] [--link-url u]
austere-axi mcp                  MCP server on stdio (see MCP)
```

Trust and private registries are in [Components and packs](components-and-packs.md); the MCP server is in [Install](install.md#mcp).

Output is compact YAML for agents. Each `poll` item has its statement and that statement's line and source, so the agent does not read the file again. Agents revise with `patch` only: they send the changed statements, never the whole file.

## Session rules

- **Pages are permanent:** a registered page always takes notes. Nothing starts, ends, closes or reopens a review. `poll`, `reply` and `feedback` need only the page; the page's state is derived: `listening` (a poll waits), `working` (an agent has a batch), `idle`, or `archived`.
- **Newest listener wins:** a new `poll` on a page answers the older one with `status: replaced`, and its `next:` says to stop. There is no `--takeover`; a poll waits for notes or for `--timeout-ms`, however many tabs are open.
- **One poll per project:** `poll` with no file listens to every page of the project of the current folder (`--project <dir|name|id>` names another). Pages are not opened first or registered one by one: any registered page takes notes while the server runs, and a page registered after the poll started is covered too. The answer lists `batches`, one per page, each with its `file`, its `copy` label (the branch or folder of its root), `final` and the usual `items`. A poll on one page wins for that page; the project poll gets the rest. A newer project poll replaces the older one.
- **The project cursor:** note seqs are one counter for the whole database, so the `cursor` of a project poll is the highest seq it returned. `poll --cursor n` acknowledges every note up to `n` on the pages it covers that a poll already handed over, and unacknowledged notes come back. It never acknowledges a note no poll delivered: after `poll --after k` skipped an older note on a page, the cursor stops short of it and the skipped note comes back, so a replay loses nothing (at-least-once). Replies stay per page: `reply <file> --cursor n` or `--agent-reply` after patching each file, then `poll --cursor n`; `--agent-reply` on a project poll is a usage error. `feedback` with no file reads every page of the project the same way (`--peek` acknowledges nothing).
- **Hand the page to an agent:** **Copy agent prompt** in the review page's `⋯` menu (the owner's only) copies a prompt for an agent that should listen on this page: the file, the shared page's address when it is published, and the `poll` / `patch` loop. It holds no owner key, token or invite link. The agent needs the file at the same path, so it works on another machine too once that machine has your `cloud.json`.
- **No lost notes:** every note is written to `~/.austere-axi/hub.db` before the page is told it was sent, so it survives a server crash or restart. Feedback sent while no agent listens waits for the next poll.
- **Acknowledge with the cursor:** `poll` prints a `cursor`. Passing it back (`--cursor n` on the next `poll` or `reply`), or replying at all, acknowledges everything up to it. Without it, `poll` returns the same feedback again, so a crash or timed-out tool call loses nothing. `--after n` replays from any point.
- **Send & End is a hint, not a state:** the reviewer's **Send & End** marks that batch. `poll` and `feedback` return `final: true` on it, and `next:` tells the agent to apply it and stop listening. The page still takes notes: a later one waits in the inbox for the next `poll`, days later and after a server restart too.
- **Archive is the only lock:** `archive <file>` (or **Archive page** in the page's `⋯` menu) leaves the hub's lists and locks the composer: `/send` answers 409. `unarchive <file>` or **Unarchive page** restores both. A running server makes the change, so an open page updates at once; `open` leaves an archived page archived.
- **Removed in 0.12:** `end`, `close`, `reopen`, `open --reopen`, `poll --takeover` and `poll --owner` exit 2 with one line that names the replacement, or says the flag is gone when there is none (`--owner`). In 0.13 they are unknown.
- An `Image` src that is a path relative to the page (png, jpg, gif, webp, svg, avif) loads under review for the owner and for invited reviewers, and `export` inlines it as a data URI. Both read only regular files in the page's own folder, never dotfiles or links that leave it; `export` skips an image over 10 MB. A file `export` cannot read stays as written, and the output names it in `notices`.
- `feedback <file>` returns notes no agent has answered, from any day. Reading them acknowledges them; `reply` marks them answered.
- **Render failures reach the agent without a click:** an unknown component or a component that throws. The owner's open review page sends them as a note from "Render check", once per page revision, and `poll` returns them as `render_error` items. With no review tab open, nothing renders, so nothing is sent. `check --render <file>` renders the page in headless Chrome (an installed Chrome, Chromium or Edge, or `CHROME_PATH`) at 1280 and 390 px, opens each tab in turn, and prints render errors and the statements that make the page scroll sideways, as text, with no screenshot. Agents run it only when the user asks for a check.

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
| `AUSTERE_AXI_IDLE_TIMEOUT_MS` | `1800000` | idle shutdown; `0` disables |
| `AUSTERE_AXI_PERSIST` | | `1`: never idle out, as `server --persist` |
| `AUSTERE_AXI_PROJECT_REFRESH_MS` | `30000` | how often a waiting project `poll` looks again for pages that joined the project from another process (`project merge`) |
| `AUSTERE_AXI_NPM_REGISTRY` | `npm_config_registry`, else npmjs | where `components add` gets packs and `components search` finds them, except scopes mapped with `registry add` |
| `AUSTERE_AXI_CLOUD_URL` | `https://austere.kasat.xyz` | the service `publish` talks to (self-hosting, tests) |
| `AUSTERE_AXI_SYNC_RETRY_MS` | `1000` | first wait before the local server reconnects to a hosted page; it doubles up to 60 s |
| `CHROME_PATH` | an installed Chrome, Chromium or Edge | the browser `check --render` uses |
