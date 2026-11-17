# CLI reference

Usage errors (unknown command or flag, missing argument) exit 2 before anything runs; failures exit 1. `<command> --help` prints that command's flags and an example.

```
austere-axi                      sessions + command list
austere-axi <file>               validate + register + open a review   [--no-open]
austere-axi poll [file]          long-poll for feedback; no file: every page of this folder's project   [--project p] [--cursor n] [--agent-reply "..."] [--after n]
austere-axi reply <file>         post a reply without polling   [--cursor n]

austere-axi login [file]         single-use link that signs a browser in as you (SSH, --no-open)
austere-axi feedback [file]      feedback no agent has answered yet; no file: every page of the project   [--project p] [--all] [--peek]
austere-axi sessions list [file]   agent sessions that opened, patched or listened to a page; no file: the project   [--project p]
austere-axi run list [file]      runs of the attached agent; no file: the project   [--project p]; run log <id>; run stop <file>
austere-axi attach status [file] whether an agent is attached to a page and what would stop it; no file: the project   [--project p]
austere-axi attach on|off [file] attach an agent to a page or a project (the user, at a terminal)   [--mode m] [--session s] [--harness h] [--model x]; attach inherit <file>
austere-axi check <file>         validate the program (no browser)    [--fix] [--render: headless Chrome, text report]
austere-axi patch <file>         merge statements from stdin into the program (reports dropped unreferenced ones)
austere-axi spec [group|pack...] component reference (~5.8k tokens; groups narrow it)
austere-axi components ...       list | search | show | add | remove | new | build
austere-axi trust list|add|remove   packs your agent may add without --trust (see Trust)
austere-axi registry list|add|remove   private npm registries for scopes (see Private registries)
austere-axi adapter list|set     how a run starts an agent: harness binaries, capabilities, the owner's extra arguments (see Adapters)
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

## Agent sessions

- **The command names its session:** `open`, `patch`, `poll`, `reply` and `feedback` find the agent session they run in from the harness's environment only: omp `PI_SESSION_ID` (and `PI_SESSION_FILE`), Copilot CLI `COPILOT_AGENT_SESSION_ID`, dsh `DSH_SESSION_ID`. `--session <harness>:<id>` names it when the environment does not (harness `omp`, `copilot` or `dsh`; a malformed value exits 2). There are no hooks and nothing searches for sessions.
- **One output line:** each of these commands prints `session: omp 1a2b3c registered` (the harness and the last six characters of the id; omp ids start with a timestamp, so their first characters repeat) or `session: "not detected (attach: new only)"`: with no session to go back to, attach can only start a new one.
- **Roles:** the first session to `open` or `patch` a copy of a page is its `author`; a different session that opens or patches it later is an `editor`. `poll`, `reply` and `feedback` make a session a `listener` of the page (every page of the project for a project `poll` or `feedback`). A repeat only moves the time.
- **Liveness:** when a command registers, it walks its parent processes to the harness's own (`/proc` on Linux, `ps` on macOS) and records that pid and its start time. `sessions list` shows `alive` while that process runs, `exited` once it is gone, `unknown` when none was found (always on Windows).
- **`sessions list [file]`:** harness, short id, role, last seen and liveness of each session of a page; with no file, of every page of the project of the current folder, or `--project`. It reads hub.db and needs no server.
- **Session ids stay on this machine:** they are in `hub.db` only, never in `publish`, `export`, hosted sync or a printed link.

## Adapters

An adapter turns a run (a note the owner sent to an attached page) into one command for a harness. `adapter list` works anywhere and changes nothing; `adapter set` works only at a terminal.

```
austere-axi adapter list                                   each harness: bin, found (its path on PATH, or false), same/fork/new, model, max_cost, extra_args, write_grant
austere-axi adapter set omp --extra-args "--approval-mode yolo"   arguments added last to every omp run ("" clears them)
austere-axi adapter set copilot --extra-args "--allow-all"        the same for Copilot CLI
austere-axi adapter set <name> --command "<bin> <args…>"          a command adapter: a fixed binary and arguments, new session only ("" removes it)
```

- **Harnesses:** `omp` and `copilot` (Copilot CLI). The prompt always goes on stdin from a 0600 file, never in argv. omp runs `omp -p --mode json --wait-async` with `--resume <id>` (same), `--fork <id>` (fork) or neither (new), `--model` when one is chosen and `--max-cost` when a limit is set. Copilot runs `copilot --resume=<id>` (same) or `--session-id <a UUID austere-axi mints>` (new), always `--model` (default `auto`), `--no-ask-user --output-format json`, and `--max-ai-credits` when a limit is set. Copilot has no fork: `adapter list` says so and a fork run is refused. No wall-clock flag is passed; the run's own timeout is the limit.
- **No write permission by default:** no adapter adds `--approval-mode yolo`, `--allow-all` or a similar flag on its own. Without one, omp and Copilot deny `austere-axi patch` and other writing commands in a run, and still exit 0. The owner grants it once, at a terminal: `adapter set omp --extra-args "--approval-mode yolo"`, or `adapter set copilot --extra-args "--allow-all"` (or `--allow-tool 'shell(austere-axi:*)'`). `write_grant` in `adapter list` shows whether a harness has one; a command adapter always counts as granted, since its arguments are the owner's own.
- **Terminal only:** `adapter set` without a terminal exits 2, changes nothing and prints the command for the user to run. `--extra-args` and `--command` are split like a shell line (quotes, backslashes), with no variable or glob expansion.
- **One file, in the state dir:** the settings live in `<state>/adapters.json` (mode 0600). A file of that name in a project, a page's folder or anywhere else is never read.
- **A missing binary is not an error:** a harness whose binary is not on `PATH` lists every capability as `no: <bin> not found on PATH`.

## Runs

With attach on for a page (see [Attach](#attach)), a note the owner sends from the review page, or a held note the owner releases, starts the page's harness headless: it reads the notes with `feedback`, changes the page with `patch` and answers with `reply`, through the normal CLI. A reviewer's note starts nothing until the owner releases it. While an agent polls the page (its own poll or its project's), the note goes to that poll and no run starts; a poll that arrives cancels a run that has not started.

```
austere-axi run list [file] [--project p]   status, reason, harness and mode, the notes (seq) and how long it took; no file: the project
austere-axi run log <id>                    what the run printed (stdout and stderr), and why it ended
austere-axi run stop <file>                 end the page's runs: the running one and everything it started is killed
```

- **When a run starts:** 5 s after the owner's last note on the page (`debounceMs`). One run per page at a time; notes that arrive while one runs make the next run, after it. At most 2 runs at once on the machine (`maxConcurrent`); the rest stay `queued`.
- **Which session:** the page's setting names a mode (`same`, `fork`, `new`) and a session (`author`: the session that wrote the page, followed to its newest continuation). With no session registered for the page, the run is `new`; the first `new` run's session is kept, and later `new` runs on the page resume it. A `same` run waits (`waiting_for_session`) while that session's harness process still runs, and starts when it exits (checked every second, and again every `recheckMs`, and when a poll arrives). A session whose process is unknown (`sessions list` shows `unknown`) is not resumed: the run fails with `session_unknown`; choose fork or new.
- **Statuses:** `queued`, `waiting_for_session`, `running`, `done`, `failed`, `stopped`, `interrupted`. A run is `done` only when it replied to every note it was started for; exit 0 without a reply is `failed` with `no_reply` (a harness without a write grant exits 0, see Adapters). Other reasons: `exit` (non-zero exit), `timeout`, `cost_cap` (omp exit 3), `session_in_use` (Copilot), `stopped`, `session_unknown`, `unsupported` (Copilot fork), `unavailable` (no such adapter, or its binary is not on `PATH`), `rate_limit`, `auto_conflict` (the page is published or shared with `--auto`), `config` (a malformed `attach.json` or `adapters.json`), and for a run that ended before it started: `listener`, `answered`, `attach_off`. A failed run leaves its notes unanswered, and is not retried; the owner's review page hears each change of a run, with the last 20 log lines when it failed.
- **What a run gets:** a 0600 prompt file on stdin (the page's path, the three commands and the seq its reply acknowledges; no note text), deleted when the run ends; the working directory of the page's root (else its folder); the server's environment with `AUSTERE_AXI_RUN_ID`, `AUSTERE_AXI_STATE_DIR` and `AUSTERE_AXI_PORT` of this server. Never the owner key, in argv, environment, prompt or log.
- **Logs:** `<state>/runs/<id>.log`, mode 0600, stdout and stderr, cut at 1 MB, removed after 30 days.
- **Time limit:** after `maxMinutes` the run's whole process tree is killed (SIGTERM, then SIGKILL 5 s later; `taskkill /T /F` on Windows). `run stop` and the review page's stop do the same at once.
- **Restart:** a server that stops kills its runs; the next one marks them `interrupted` and queues each once more.
- **Attach and `--auto` exclude each other:** an unattended run reads only notes the owner sent or released. `publish --auto` and `share --auto` refuse while attach is on for the page, and a run refuses (`auto_conflict`) on a page published or shared with `--auto`.

`<state>/attach.json` (written by the owner, read only from the state dir; every key optional):

| Key | Default | |
|---|---|---|
| `maxMinutes` | `15` | wall clock per run |
| `runsPerHour` | `12` | runs started per page in any hour; the next one fails with `rate_limit` |
| `maxConcurrent` | `2` | runs at once on the machine |
| `debounceMs` | `5000` | wait after the owner's last note |
| `recheckMs` | `30000` | how often a waiting run looks again |
| `maxCost` | | omp `--max-cost` (dollars) |
| `maxAiCredits` | | Copilot `--max-ai-credits` |

## Attach

Attach decides whether a note the owner sends starts an agent on a page (see [Attach an agent](attach.md) for the whole story). A page has its own setting, or uses its project's default; with neither it is off.

```
austere-axi attach status [file] [--project p]          the setting that applies and where it comes from, the mode, the session a run resumes, harness, model, last run, warnings
austere-axi attach on [file] [--mode m] [--session s] [--harness h] [--model x]   turn it on for the page (no file: the project of the current folder, or --project)
austere-axi attach off [file]                            turn it off for the page (or the project)
austere-axi attach inherit <file>                        the page goes back to its project's default
```

- **Anywhere, read-only:** `attach status` changes nothing and needs no server; an agent may run it (MCP `attach_status`). Its `warnings` name what would stop a run or make it useless: a harness without the write grant (with the `adapter set` command that grants it), a binary not on `PATH`, a mode the harness cannot run, a `same` session whose process is unknown, a page published or shared with `--auto`.
- **The user's only:** `attach on`, `off` and `inherit` without a terminal exit 2, change nothing and print the command for the user to run. The review page's Agent pill does the same for the owner. No MCP tool changes it.
- **Fields:** `--mode same|fork|new` (default `same`), `--session author|<id>` (default `author`: the session that wrote the page, followed to its newest continuation; or a short or full id from `sessions list`), `--harness omp|copilot|<command adapter>` (the harness of a new session; default the project's, else omp), `--model` (default the harness's own; `""` clears it). A field you leave out keeps its value.
- **Refused:** `attach on` for a page published or shared with `--auto` (they exclude each other), and a mode the harness cannot run (Copilot fork). Nothing is written then.

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
