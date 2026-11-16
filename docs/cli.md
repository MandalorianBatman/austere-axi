# CLI reference

Usage errors (unknown command or flag, missing argument) exit 2 before anything runs; failures exit 1. `<command> --help` prints that command's flags and an example.

```
austere-axi                      sessions + command list
austere-axi <file>               validate + open a review   [--no-open] [--reopen]
austere-axi poll <file>          long-poll for feedback      [--cursor n] [--agent-reply "..."] [--after n] [--takeover]
austere-axi reply <file>         post a reply without polling   [--cursor n]
austere-axi end <file>           stop as the agent; the reviewer can still add notes
austere-axi close <file>         close the review: no more notes until reopen; the page is archived
austere-axi reopen <file>        reopen an ended or closed review (a closed one comes back into the hub's lists)
austere-axi login [file]         single-use link that signs a browser in as you (SSH, --no-open)
austere-axi feedback <file>      feedback no agent has answered yet   [--all] [--peek]
austere-axi check <file>         validate the program (no browser)    [--fix] [--render: headless Chrome, text report]
austere-axi patch <file>         merge statements from stdin into the program (reports dropped unreferenced ones)
austere-axi spec [group|pack...] component reference (~5.8k tokens; groups narrow it)
austere-axi components ...       list | search | show | add | remove | new | build
austere-axi trust list|add|remove   packs your agent may add without --trust (see Trust)
austere-axi registry list|add|remove   private npm registries for scopes (see Private registries)
austere-axi export <file>        one self-contained HTML file, works offline (~1.1 MB)
austere-axi hub [list|notes|open]   home page with every page by project and every note   [--project p] [--archived] [--all] [--unanswered]
austere-axi project list|add|merge|rename|forget-root   projects: a name and its root folders (see Hub)
austere-axi archive <file>       put a page away from the hub's lists; unarchive <file> brings it back (and reopens a closed review)
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

- **One listener:** one `poll` listens on a session at a time.
- **Hand the page to an agent:** **Copy agent prompt** in the review page's `⋯` menu (the owner's only) copies a prompt for an agent that should listen on this page: the file, the shared page's address when it is published, and the `poll` / `patch` loop. It holds no owner key, token or invite link. The agent needs the file at the same path, so it works on another machine too once that machine has your `cloud.json`.
- **No lost notes:** every note is written to `~/.austere-axi/hub.db` before the page is told it was sent, so it survives a server crash or restart. Feedback sent while no agent listens waits for the next poll.
- **Acknowledge with the cursor:** `poll` prints a `cursor`. Passing it back (`--cursor n` on the next `poll` or `reply`), or replying at all, acknowledges everything up to it. Without it, `poll` returns the same feedback again, so a crash or timed-out tool call loses nothing. `--after n` replays from any point.
- **End is soft:** ending a review (the agent's `end`, or **End review** in the page) means the agent stopped. The reviewer can still send notes. The next `poll` returns every unacknowledged note, including ones sent before the end or released from hold after it, and reopens the review. A batch the reviewer sent together with end stays final.
- **Close is hard:** only the owner's **close** (`close <file>`, or **Close review** in the page) locks the composer. `reopen <file>` or **Reopen review** unlocks it.
- A review the user ended or closed opens again only with `austere-axi <file> --reopen`.
- An `Image` src that is a path relative to the page (png, jpg, gif, webp, svg, avif) loads under review for the owner and for invited reviewers, and `export` inlines it as a data URI. Both read only regular files in the page's own folder, never dotfiles or links that leave it; `export` skips an image over 10 MB. A file `export` cannot read stays as written, and the output names it in `notices`.
- **Tabs closed:** `poll` returns `browser_disconnected` 10 s after the last review tab closes, or 5 min after a dropped connection (for example, a locked phone). The review stays open, so later notes reach the next `poll`.
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
| `AUSTERE_AXI_DISCONNECT_GRACE_MS` | `300000` | how long a dropped connection can stay away before `poll` returns; `0` disables |
| `AUSTERE_AXI_IDLE_TIMEOUT_MS` | `1800000` | idle shutdown; `0` disables |
| `AUSTERE_AXI_PERSIST` | | `1`: never idle out, as `server --persist` |
| `AUSTERE_AXI_SUPERVISED` | | set by the unit `server install` writes (`systemd` or `launchd`): the server never idles out and a newer CLI does not replace it |
| `AUSTERE_AXI_NPM_REGISTRY` | `npm_config_registry`, else npmjs | where `components add` gets packs and `components search` finds them, except scopes mapped with `registry add` |
| `AUSTERE_AXI_CLOUD_URL` | `https://austere.kasat.xyz` | the service `publish` talks to (self-hosting, tests) |
| `AUSTERE_AXI_SYNC_RETRY_MS` | `1000` | first wait before the local server reconnects to a hosted page; it doubles up to 60 s |
| `CHROME_PATH` | an installed Chrome, Chromium or Edge | the browser `check --render` uses |
