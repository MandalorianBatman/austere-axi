# CLI reference

- Exit 2: usage error (unknown command or flag, missing argument), before anything runs. Exit 1: failure.
- `<command> --help` prints the command's flags and an example.
- Output is compact YAML for agents (`AUSTERE_AXI_FORMAT=json` for one JSON line).
- Each `poll` item carries its statement, line and source: the agent need not re-read the file.
- Agents revise with `patch` only: send changed statements, never the whole file.

## Commands

```
# Review
austere-axi                      pages + command list
austere-axi <file>               validate + register + open a review   [--no-open]
austere-axi poll [file]          long-poll for feedback; no file: every page of this checkout   [--project p: every checkout] [--cursor n] [--agent-reply "..."] [--after n]
austere-axi reply <file>         post a reply without polling   [--cursor n]
austere-axi feedback [file]      feedback no agent has answered yet; no file: every page of this checkout   [--project p: every checkout] [--all] [--peek]
austere-axi login [file]         single-use link that signs a browser in as you (SSH, --no-open)

# Pages
austere-axi check <file>         validate the program (no browser)    [--fix] [--render: headless Chrome, text report]
austere-axi patch <file>         merge statements from stdin (reports dropped unreferenced ones)   [--from <src>#<a>[,<b>…] [--rev n]]: copy parts from another page first
austere-axi find <words>         search statement text of every page: title, file, copy, statement, snippet, age   [--project p] [--component c] [--limit n] [--all]
austere-axi outline <file>       the page as a tree from root: name, component, first words, child count
austere-axi show <file> [statement…]   source (default) or plain text of parts   [--text|--source] [--deps] [--rev n]
austere-axi history <file>       every version, newest first, with the notes that caused each   [--statement name] [--since rev]
austere-axi restore <file> --rev n [statement…]   put the page or named statements back (a patch, kept as a new revision)
austere-axi changes [file]       what changed since a cursor: statements before/after, causes, replies   [--project p] [--since cursor] [--limit n]
austere-axi decisions [file]     forms submitted, buttons pressed, batches sent with Send & finish   [--project p] [--since cursor] [--limit n]
austere-axi export <file>        one self-contained HTML file, works offline (~1.1 MB)
austere-axi archive <file>       remove a page from the hub's lists; it stops taking notes   [--every-copy]; unarchive <file> brings it back
austere-axi archive --missing    archive every copy whose file is gone   [--project p]

# Components
austere-axi spec [group|pack...] component reference (~5.7k tokens; groups narrow it)
austere-axi components ...       list [group] | search <words> [--group G] | show <Name…> | add | remove | new | build; `list Diagrams` is the diagram chooser
austere-axi trust list|add|remove      packs your agent may add without --trust
austere-axi registry list|add|remove   private npm registries for scopes

# Agents
austere-axi sessions list [file]   sessions that opened, patched or listened to a page; no file: the project   [--project p]   (any command: --session <harness>:<id>)
austere-axi attach status [file] whether an agent is attached and what would stop it; no file: the project   [--project p]
austere-axi attach on|off [file] attach an agent to a page or project (user, at a terminal)   [--mode m] [--session s] [--harness h] [--model x]; attach inherit <file>
austere-axi run list [file]      runs of the attached agent; no file: the project   [--project p]; run log <id>; run stop <file> | --project p
austere-axi adapter list|command|set   how a run starts an agent: binaries, capabilities, extra arguments
austere-axi trigger list|add|remove    run a command once a project is quiet (user, at a terminal)   add --project p --on quiet:2h [--max-time 30m] -- <bin> [args…]

# Hub and projects
austere-axi hub [list|notes|open|reindex]   inbox, pages by project, notes, runs, search; reindex rebuilds the text index   [--project p] [--archived] [--all] [--unanswered]
austere-axi project list|add|merge|rename|forget-root   projects: a name and its root folders

# Sharing (tailnet)
austere-axi share <file> --as "<name>"   link for one teammate's device, claimed once   [--project <p> | --all] [--auto | --hold] [--expires <dur>]
austere-axi share list|revoke           unopened links and devices; cut one off
austere-axi share requests [on|off]     access requests from a page's address (off by default)   [--project <p>]
austere-axi share approve|deny|block <id>   let a browser in, refuse it, or stop it asking   approve: [--project <p> | --all] [--auto | --hold]
austere-axi share default [hold|auto]   where a new reviewer's notes go when unspecified (hold unless changed; also hub Settings)

# Hosted pages (cloud)
austere-axi cloud on|off|status         cloud features: publish, clone, cloud login, hosted-page sync (off by default; also hub Settings → Cloud)
austere-axi cloud login|logout|whoami   your hosted-service account, owner of your hosted pages; publish and clone fail with login_required until signed in, and help hides them
austere-axi publish <file>       hosted copy on austere.blundertech.com   [--invite <name>]... [--expires <dur>] [--unlisted] [--auto] [--no-presence] [--new]
austere-axi publish invites|revoke <file> [name]   list a page's invites, cut one off
austere-axi publish login <file>   single-use link that signs your browser in to your hosted page
austere-axi publish list|rm <file|id>   your hosted pages; delete one now
austere-axi clone [<id> [<file>]]   your hosted pages from any machine; one as a local, attached file

# Server
austere-axi stop                 stop the background server
austere-axi server --persist     run in the foreground, never idle out
austere-axi server install|uninstall|status|restart   always-on per-user systemd or launchd service   [--port n] [--link-url u] [--adopt] [--force]
austere-axi mcp                  MCP server on stdio
```

See also: Trust and private registries in [Components and packs](components-and-packs.md); MCP in [Install](install.md#mcp); hub, projects and the always-on server in [Hub](hub.md); hosted pages in [Hosted pages](hosted-pages.md).

## Review rules

**Page state**
- A registered page always takes notes. Nothing starts, ends, closes or reopens a review; `poll`, `reply`, `feedback` need only the page.
- Derived states: `listening` (a poll waits), `working` (an agent has a batch), `stale` (an agent took a batch and for 10 min has not replied, polled or changed the file), `idle`, `archived`.
- Review page labels: "Agent working (2 min)", "Took your notes 14 min ago, no reply yet", "Agent idle in omp · Send wakes it", "Agent busy in omp · notes wait for its turn" (see [Wake an idle session](#wake-an-idle-session)), and "Agent not listening" only when nothing would take a note. On a phone, the dock under the page shows the same label.

**Polling**
- **Newest listener wins:** a new `poll` on a page answers the older one with `status: replaced`; its `next:` says to stop. No `--takeover`; a poll waits for notes or `--timeout-ms`, however many tabs are open.
- **One poll per checkout:** `poll` with no file covers every page of the current checkout (the root folder holding the current directory: repository, worktree, assigned or guessed folder). `--project <dir|name|id>` covers every root of the project.
  - Any registered page takes notes while the server runs, including pages registered after the poll started.
  - Output: `scope` (`this checkout` / `every checkout of shop`) and `batches`, one per page, each with `file`, `copy` (branch or folder of its root), `final`, `items`.
- **Precedence:** page poll > checkout poll > project poll.
  - A poll that answered keeps its pages until its agent acknowledges that batch (max 10 min): a page poll's batch from every wider poll, a checkout poll's batch from the project poll.
  - A newer poll replaces only an older poll of the same scope, so agents in two worktrees never take each other's notes.
- **Coverage:** `poll`/`feedback` with no file print `scope:` and `pages: n` (open pages; archived excluded; copies counted once).
  - None: `poll` returns at once with `no page of this checkout is open` (`… of this project …` with `--project`); so does `feedback` when no page there was ever opened.
  - Opening a page prints its `project:` and a `next:` poll: bare `poll` if the current folder is in the page's checkout, else `poll --project <name>`.
  - Without `.git` and outside a root assigned with `project add`, a page opened from inside the current folder belongs to that folder's project, unless the folder is `/`, home or temp; then the page's own folder is the project (see [Hub](hub.md)).
  - A poll whose pages moved to another project or root ends with `status: moved`; poll that one instead.

**Cursor and acknowledgement**
- Every note is written to `~/.austere-axi/hub.db` before the page is told it was sent: it survives a crash or restart. Notes sent while no agent listens wait for the next poll.
- `poll` prints a `cursor`. Note seqs are one database-wide counter; a project poll's cursor is the highest seq it returned.
- `--cursor n` (on `poll` or `reply`), or any reply, acknowledges every note up to `n` that a poll handed over. A reply without a cursor acknowledges what the last poll handed over, also after a server restart.
- Never acknowledges an undelivered note: one skipped by `--after k` comes back (at-least-once). Without acknowledgement, `poll` returns the same feedback again. `--after n` replays from any point.
- Replies are per page: `reply <file> --cursor n` or `--agent-reply` after patching each file, then `poll --cursor n`. `--agent-reply` on a project poll is a usage error.
- `feedback <file>` returns unanswered notes from any day; reading acknowledges them, `reply` marks them answered. With no file it reads every page of the checkout (or `--project`). `--peek` acknowledges nothing.

**Done**
- **Done** (empty batch) or **Send & finish** (composer notes) marks a batch: `poll` returns `final: true` (`feedback` shows it only on Send & finish).
- The agent applies it and replies; on a project poll it keeps polling while another page it opened is in review, else stops and continues in chat.
- The page still takes notes; later ones wait for the next `poll`, across restarts. A Done is not counted as a note awaiting an answer.

**Hand the page to an agent**
- **Copy agent prompt** (owner only) in the `⋯` menu, and under the composer while no agent listens ("Saved. The agent gets them the next time it checks."), copies a prompt: the file, the published address if any, and the loop: `poll --project <name>`, `patch`, `reply`.
- If an agent already polls the project or this checkout, the prompt uses `poll <file>` instead.
- Holds no owner key, token or invite link. Works on another machine with the file at the same path and your `cloud.json`.
- Hidden when an agent is attached (**Agent** pill): a note starts a run.

**Archive**
- `archive <file>` (or **Archive page** in `⋯`): leaves the hub's lists and stops taking notes (`/send` answers 409). `unarchive <file>` / **Unarchive page** restores both.
- Applied by the running server, so open pages update at once. `open` leaves an archived page archived and prints `status: archived`. While archived, the frame stays in Explore; Annotate is off.
- One copy per worktree; `archive <file>` archives that copy only. Prints `copy:`, `unanswered:` (kept, excluded from hub counts) and `still_open:` (each with unanswered notes). The hub row stays and opens a remaining copy.
- `--every-copy` archives every copy. The `⋯` menu offers **Archive this copy** / **Archive every copy**, listing copies that stay open. Failures show on the page.
- `poll <file>` on an archived page still returns notes queued before archiving; then answers at once with `status: archived` and a `next:` to stop (unarchive only if the user asks). A waiting poll gets the same when the page is archived.

**Missing files**
- A copy whose file is gone keeps its notes. `feedback` (no file) marks its batch `missing: true`; `reply <file>` and `archive <file>` work without the file (an unknown path says `no such file`).
- `archive --missing [--project p]` archives every such copy and prints how many, and how many notes were unanswered; those stay (`feedback` shows `archived: true`).

**Images**
- An `Image` src relative to the page (png, jpg, gif, webp, svg, avif) loads in review for the owner and invited reviewers; `export` inlines it as a data URI.
- Only regular files in the page's own folder; never dotfiles or links leaving it. `export` skips images over 10 MB; unreadable files stay as written and are named in `notices`.

**Render failures**
- Unknown or throwing components: the owner's open review page sends them as a "Render check" note, once per revision; `poll` returns `render_error` items. No open review tab, nothing sent.
- `check --render <file>`: headless Chrome (installed Chrome, Chromium, Edge, or `CHROME_PATH`) at 1280 and 390 px, each tab in turn; prints render errors and statements causing horizontal scroll, as text. Agents run it only when the user asks.

## History and reuse

hub.db keeps every version of every page, whole, and every statement as plain text. Nothing is written into the project.

- **Revisions:** a patch, a watched edit, an edit found on open/check (made with no server), or a restore makes the next revision of that copy (numbered from 1). Unchanged programs make none. `patch` first records the current page, so a never-opened page keeps its pre-patch version.
- **Cause:** a revision names the notes delivered and unanswered when made, or inside an attached run, that run's notes (`run:` id). `by:` is the agent session.
- **`history <file>`:** revisions with statements changed/removed, the first causing note (80 chars), and copy origins. `--statement name`: revisions that changed it; `--since rev`: later ones.
- **`show <file> --rev n [statement…]`** reads one revision. **`restore <file> --rev n [statement…]`** writes it back via patch (a named part brings what it needs) as a new revision. Already matching: `status: unchanged`.
- **`outline <file>`:** tree from `root`; each named statement once, with component, first 8 words, count of direct named children. Diagram, table and form parts are counted, not listed (use `show <file> <statement> --deps`). Reads the file; no server needed.
- **`show --text`:** plain text — table as Markdown, diagram as nodes and `a → b (label)` edges, diff as file names with +/− counts, form as labels and options, chart as labels and series names. References are not followed; enumerations and field names are not text.
- **`changes [file] [--project p] --since <cursor>`:** revisions after global revision id `cursor`, oldest first: page and copy, statements before/after as text, causing notes, agent reply. Prints `cursor:`.
- **`decisions`:** same, over the owner's forms and buttons (with values) and Send & finish batches; cursor is a note `seq`. Both default to the current folder's project.
- **`find <words>`:** SQLite FTS5, best first, each word a prefix match; if no page has every word, matches any. Without FTS5, falls back to `LIKE` (`search: LIKE …`).
  - A page in several worktrees is one hit; max 3 hits per page. Archived pages and missing-file copies excluded unless `--all`.
  - Last line: `reuse: austere-axi patch <file> --from <page>#<statement>`.
  - `hub reindex` rebuilds the index from existing files (missing-file copies lose index rows, not revisions).
- **`patch <file> --from <src>#<a>[,<b>…] [--rev n]`** (repeatable): copies those statements and everything they reference (from the file, or revision `n`), then merges stdin, which may reference them. Unreferenced statements are dropped (`dropped:`).
  - A name clash renames the incoming statement (`flow` → `flow2`) and its references; `renamed:` reports it, and stdin must use the new name.
  - Pack components print the `check --fix` hint. A copy, not an include.
  - Origins kept (`statement_origins`): `outline` marks `← page#statement`, `history` lists it.
- **`similar:`:** the first `open` of a page lists up to 3 non-archived pages of its project with similar title or card heading (two meaningful words shared, or all of the shorter's), with file and age. Never blocks. `--help` says to run `find` first.
- **Review page (owner):** returning to a page changed while hidden shows "2 revisions since you last looked", with an outline of changes. **History…** in `⋯` lists revisions (time, how, agent, note); picking one outlines it. A part's annotate popover has **History (n)** and **Restore this version**.
- `/s/:id/history`, `/s/:id/viewed`, `/s/:id/restore` are owner-only: reviewers get 403; a foreign `Origin` is refused.
- MCP tools map 1:1: `find`, `outline`, `show` (`plain_text` = `--text`), `history`, `restore`, `changes`, `decisions`, `patch` (`from`, `rev`).

## Agent sessions

- **Detection:** `open`, `patch`, `poll`, `reply`, `feedback` read the session from the environment only:

| Harness | Variable |
|---|---|
| omp | `PI_SESSION_ID` (and `PI_SESSION_FILE`) |
| Copilot CLI | `COPILOT_AGENT_SESSION_ID` |
| OpenCode | `OPENCODE_SESSION_ID` (set by the austere-axi OpenCode plugin) |
| dsh | `DSH_SESSION_ID` |

- `--session <harness>:<id>` names it otherwise (`omp`, `copilot`, `opencode`, `dsh`; malformed exits 2). Nothing searches for sessions.
- **Output line:** `session: omp 1a2b3c registered` (last six characters of the id) or `session: "not detected (attach: new only)"`.
- **Roles:** first session to `open`/`patch` a copy is `author`; later different sessions are `editor`. `poll`, `reply`, `feedback` make a `listener` (every project page for project-wide calls). Repeats only update the time.
- **Liveness:** registering records the harness's parent pid and start time (`/proc` on Linux, `ps` on macOS). `sessions list` shows `alive`, `exited`, or `unknown` (none found; always on Windows).
- **`sessions list [file]`:** harness, short id, role, last seen, liveness; no file: the current folder's project or `--project`. Reads hub.db; no server needed.
- **Privacy:** session ids stay in `hub.db` and run logs (`<state>/runs/<id>.log`, which may name full ids, e.g. in `session_unknown`). Never in `publish`, `export`, hosted sync or printed links. Check run logs before sharing them.

## Wake an idle session

With the omp, Copilot CLI or OpenCode extension loaded, an owner's note starts the next turn of the session that wrote, edited or listened to the page, if open and idle. No poll needed. Never interrupts a running turn. `poll` and attach work unchanged.

```
omp -e "$(npm root -g)/austere-axi/dist/harness/omp.js"                                         one omp session
ln -s "$(npm root -g)/austere-axi/dist/harness/omp.js" ~/.omp/agent/extensions/austere-wake.js   every omp session
ln -s "$(npm root -g)/austere-axi/dist/harness/copilot" ~/.copilot/extensions/austere-wake       every Copilot CLI session
ln -s "$(npm root -g)/austere-axi/dist/harness/opencode.js" ~/.config/opencode/plugins/austere-wake.js   every OpenCode session
```

- **Copilot CLI:** extensions are experimental: start `copilot --experimental` once or `/settings experimental on` (saves `"experimental": true` in `~/.copilot/settings.json`). Works in interactive and `-p` sessions, not `copilot --acp`. Wake turns show as automation (`source: "automation-austere-axi"`), not as the owner.
- **OpenCode:** plugin in `plugins/*.js` under `~/.config/opencode/` or a project's `.opencode/`; works in the TUI and `opencode serve` (many sessions). Sets `OPENCODE_SESSION_ID` for the bash tool (root session for subagents). OpenCode picks agent and model as for any prompt. OpenCode 2 not required. A session resumed in a new process is checked at its first turn there.
- **Idle sessions without a page:** nothing happens. At session start the extension reads `server.lock` and `owner.key`, verifies the server via `/api/health`, asks once for a role. No role or server: it stops, re-checking only after a turn that ran `austere-axi`. It never starts a server, writes a file or registers a session.
- **With a role:** checks idleness every second (omp: idle, nothing queued; Copilot: until `session.idle`, which waits for background shells and sub-agents; OpenCode: `session.status`, subagents keep the root busy). After 2 idle seconds it waits on `wake-poll` (50 s, repeated); a starting turn drops the wait.
  - On owner notes it starts a turn and answers `wake-ack`. If the session turned busy or the harness refused, notes are `released` and come again after the turn.
  - Unreachable server: retries with back-off; gives up after 6 failures until the session runs `austere-axi` again.
- **Turn prompt:** file, waiting note count, and `feedback`, `patch`, `reply --cursor <n>`. Never note text (untrusted); the agent reads it with `feedback`.
- **Which notes:** those the owner sent or released. Not for pages an agent polls, archived pages, pages published or shared with `--auto`, or pages an attached run is answering.
- **Once:** one client claims a page's notes at a time (60 s claim). A delivered wake counts as a listener: it cancels an unstarted attached run.
- **Review page:** "Agent idle in omp · Send wakes it" while a client waits; "Agent busy in omp · notes wait for its turn" during a turn (while its process runs, or 15 min if unknown); "Queued · agent busy" under a waiting note; "Delivered to omp 14:02" under a delivered one. Copilot/OpenCode show `copilot`/`opencode`.
- **Routes** (owner key required, as for all `/api/*`; a waiting client does not keep an idle server up):
  - `POST /api/sessions/<harness>:<id>/wake-poll` `{client, timeoutMs}` → `no_role`, `idle` (`timeoutMs` 0), `timeout`, `interrupted`, or `wake` `{claim, prompt, pages}`.
  - `POST /api/sessions/<harness>:<id>/wake-ack` `{client, claim, outcome: delivered|released}`.
- **Limits:** claims are in server memory; a restart between wake and `feedback` can wake once more. Notes a page poll left untaken reach a waiting session within 50 s. Claude Code and Codex have no client yet.

## Adapters

An adapter turns a run (an owner's note on an attached page) into one harness command. `adapter list` works anywhere, read-only; `adapter set` needs a terminal.

```
austere-axi adapter list                                   per harness: bin, found (path or false), same/fork/new, model, max_cost, extra_args, write_grant
austere-axi adapter command <name> [--model m]             command a new run would use (bin, args incl. extra arguments and limits, env; prompt on stdin), for programs that start the harness themselves
austere-axi adapter set omp --extra-args "--approval-mode yolo"   arguments appended to every omp run ("" clears)
austere-axi adapter set copilot --extra-args "--allow-all"        same for Copilot CLI
austere-axi adapter set <name> --command "<bin> <args…>"          command adapter: fixed binary and args, new session only ("" removes)
```

| Harness | Command | Session | Limits |
|---|---|---|---|
| `omp` | `omp -p --mode json --wait-async`, `--model` if chosen | `--resume <id>` (same), `--fork <id>` (fork), none (new) | `--max-cost` |
| `copilot` | `copilot --no-ask-user --output-format json`, always `--model` (default `auto`) | `--resume=<id>` (same), `--session-id <minted UUID>` (new); no fork (refused) | `--max-ai-credits` |

- Prompt always on stdin from a 0600 file, never argv. No wall-clock flag; the run timeout applies.
- **No write permission by default:** without a grant, omp and Copilot deny `austere-axi patch` and still exit 0. Grant once at a terminal: `adapter set omp --extra-args "--approval-mode yolo"` or `adapter set copilot --extra-args "--allow-all"` (or `--allow-tool 'shell(austere-axi:*)'`). `write_grant` shows it; command adapters always count as granted.
- **Terminal only:** `adapter set` without a terminal exits 2, changes nothing, prints the command to run. `--extra-args`/`--command` are split like a shell line (quotes, backslashes), without variable or glob expansion.
- **Settings:** `<state>/adapters.json` (0600) only; same-named files elsewhere are ignored.
- **Missing binary:** not an error; capabilities read `no: <bin> not found on PATH`.

## Runs

With attach on (see [Attach](#attach)), an owner's note, or a held note the owner releases, starts the page's harness headless; it uses `feedback`, `patch`, `reply`. A reviewer's note starts nothing until released. If an agent polls the page (directly or via project), the note goes to the poll; an arriving poll cancels an unstarted run.

```
austere-axi run list [file] [--project p]   status, reason, harness, mode, note seqs, duration; no file: the project
austere-axi run log <id>                    stdout/stderr and why it ended
austere-axi run stop <file>                 kill the page's running run and its tree (without a server, also a crashed server's leftover run)
austere-axi run stop --project p            end the project's trigger runs
```

- **Start:** `debounceMs` (5 s) after the owner's last note. One run per page; notes during a run make the next run. Max `maxConcurrent` (2) per machine; others `queued`.
- **Session:** mode `same`/`fork`/`new`; session `author` (the page's writer, followed to its newest continuation).
  - No session registered: `new`. A harness's first `new` session is kept; later `new` runs resume it. Command adapters: always new.
  - `same` (or resumed `new`) waits as `waiting_for_session` (announced once) while the session's process runs or another page's run uses it; rechecked every second, every `recheckMs`, and on poll.
  - Liveness `unknown`: not resumed; fails `session_unknown`; choose fork or new.
- **Statuses:** `queued`, `waiting_for_session`, `running`, `done`, `failed`, `stopped`, `interrupted`. `done` only when every note was replied to.
- **Reasons:** `no_reply` (exit 0 without reply, e.g. no write grant), `exit`, `timeout`, `cost_cap` (omp exit 3), `session_in_use` (Copilot), `stopped`, `session_unknown`, `unsupported` (Copilot fork), `unavailable` (no adapter or binary), `rate_limit`, `auto_conflict`, `config` (malformed `attach.json`/`adapters.json`); ended before start: `listener`, `answered`, `attach_off`.
- Failed runs leave notes unanswered and are not retried. The review page sees each run change, with the last 20 log lines on failure.
- **Environment:** 0600 prompt file on stdin (path, three commands, seq to acknowledge; no note text; deleted after). Working directory: page's root (else its folder). Server env plus `AUSTERE_AXI_RUN_ID`, `AUSTERE_AXI_STATE_DIR`, `AUSTERE_AXI_PORT`; `<state>/runs/bin` first on `PATH` (this server's CLI). Never the owner key.
- **Logs:** `<state>/runs/<id>.log`, 0600, stdout+stderr, 1 MB cap, deleted after 30 days.
- **Time limit:** after `maxMinutes` the process tree is killed (SIGTERM, SIGKILL 5 s later; `taskkill /T /F` on Windows). `run stop` and the review page's stop do so at once.
- **Restart:** a stopping server kills runs (waits for their trees) and leaves rows `running`. The next server kills leftovers, marks rows `interrupted`, requeues each once (a second interruption stays `interrupted`; the next owner note starts a run reading all notes).
  - Unconfirmable leftovers (no start time, unreadable process table, process group still present) are not killed; the row stays `running`, blocking new runs; `run stop` leaves it (says why without a server) and ends the row once the process is gone.
  - Windows: `tasklist` image name decides: the spawned binary is killed with its tree; another program means pid reuse, row ends; `tasklist` failure keeps `running`.
- **Attach vs `--auto`:** runs read only owner-sent or released notes. `publish --auto` and `share --auto` refuse while attach is on; runs refuse (`auto_conflict`) on pages published or shared with `--auto`, or while a note let through by a since-revoked `--auto` invite is unanswered (answer or discard it).
- **Windows:** npm-installed harnesses run via their `.cmd` shim (`PATHEXT` only) through `cmd.exe /d /s /c`, arguments quoted; prompt still on stdin.

`<state>/attach.json` (owner-written, state dir only; keys optional; a value above max makes it malformed):

| Key | Default | Max | |
|---|---|---|---|
| `maxMinutes` | `15` | `1440` | wall clock per run |
| `runsPerHour` | `12` | `1000` | runs per page per hour; next fails `rate_limit` |
| `maxConcurrent` | `2` | `16` | runs at once on the machine |
| `debounceMs` | `5000` | `3600000` | wait after the owner's last note |
| `recheckMs` | `30000` | `3600000` | how often a waiting run rechecks |
| `maxCost` | | | omp `--max-cost` (dollars) |
| `maxAiCredits` | | | Copilot `--max-ai-credits` |

## Triggers

A trigger runs a command once a project has been quiet.

```
austere-axi trigger add --project shop --on quiet:2h [--max-time 30m] -- ./scripts/nightly-report.sh
austere-axi trigger list
austere-axi trigger remove <id>
```

- **Terminal only:** `add`/`remove` without a terminal exit 2, change nothing, print the command. `<state>/triggers.json` (0600) is read only from the state dir; never from projects, pages or notes. Agents may `trigger list` and read runs.
- **When:** once `<duration>` (`quiet:90s`, `quiet:30m`, `quiet:2h`, `quiet:1d`) passes after the project's last revision or note, the command runs once: no shell, in the project's first folder, server env plus `AUSTERE_AXI_RUN_ID`, `AUSTERE_AXI_PROJECT`, `AUSTERE_AXI_CHANGES_CURSOR` (prior cursor, for `changes --since`); `austere-axi` on `PATH` is this server's CLI. Never the owner key.
- **Activity:** counted from when the trigger was added. Activity during a run makes exactly one more run once quiet again. A restart-interrupted run returns its cursor, so it reruns.
- **Runs:** listed in `run list --project p` (`trigger: <id>`, cursor range); `run log <id>`; `run stop --project p`. Same log rules (1 MB, 0600, 30 days), `maxTime` (else `maxMinutes`), `runsPerHour` (per trigger), `maxConcurrent`. Statuses: `done`, `failed` (`exit`, `timeout`, `rate_limit`, `unavailable`), `stopped`, `interrupted`.
- **Needs a server:** a server with triggers never idles out; with no server nothing runs (`server install` keeps one).

## Attach

Whether an owner's note starts an agent on a page (see [Attach an agent](attach.md)). Page setting, else project default, else off.

```
austere-axi attach status [file] [--project p]          setting and its source, mode, resumed session, harness, model, last run, warnings
austere-axi attach on [file] [--mode m] [--session s] [--harness h] [--model x]   turn on for the page (no file: current folder's project, or --project)
austere-axi attach off [file]                            turn off for the page (or project)
austere-axi attach inherit <file>                        page reverts to project default
```

- **`attach status`:** read-only, no server needed; agents may run it (MCP `attach_status`). `warnings`: harness without write grant (with the granting `adapter set` command), binary not on `PATH`, unsupported mode, `same` session with unknown process, page published or shared with `--auto`.
- **User only:** `on`/`off`/`inherit` without a terminal exit 2, change nothing, print the command. Also via the review page's Agent pill. No MCP tool. With a server, changes show in open review tabs at once.
- **Fields** (omitted fields keep their value):
  - `--mode same|fork|new` (default `same`)
  - `--session author|<id>` (default `author`; or short/full id from `sessions list`)
  - `--harness omp|copilot|<command adapter>` (default the project's, else omp)
  - `--model` (default the harness's own; `""` clears)
- **Refused** (nothing written): leaving a page published or shared with `--auto` attached (`attach on`, `inherit` onto an on default, `attach on --project` while it inherits), or a mode the harness cannot run (Copilot fork).

## Environment

| Variable | Default | |
|---|---|---|
| `AUSTERE_AXI_PORT` | port in the state dir's `server.lock` while running, else the installed service's, else `4388` | server port |
| `AUSTERE_AXI_STATE_DIR` | `~/.austere-axi` | pages and notes (`hub.db`), owner key, server log (mode 0700 on macOS and Linux) |
| `AUSTERE_AXI_NO_OPEN` | | `1` = never open a browser |
| `AUSTERE_AXI_HOST` | | extra bind address (never `0.0.0.0`) |
| `AUSTERE_AXI_NO_TAILSCALE` | | `1` = loopback only |
| `AUSTERE_AXI_FORMAT` | | `json` = one JSON line per command instead of YAML (same fields) |
| `AUSTERE_AXI_TAILNET_CHECK_MS` | `60000` | how often to re-ask Tailscale for the address; `0` disables |
| `AUSTERE_AXI_LINK_HOST` | | host in the printed remote link (`http://<host>:<port>`) |
| `AUSTERE_AXI_LINK_URL` | | full origin of the printed remote link, e.g. `https://austere.example.com` behind a TLS proxy; host accepted without `ALLOWED_HOSTS`; letters, digits, dots, hyphens, underscores, or bracketed IPv6 only |
| `AUSTERE_AXI_ALLOWED_HOSTS` | | extra `Host` headers to accept (reverse proxy) |
| `AUSTERE_AXI_IDLE_TIMEOUT_MS` | `1800000` | idle shutdown; `0` disables |
| `AUSTERE_AXI_PERSIST` | | `1` = never idle out (as `server --persist`) |
| `AUSTERE_AXI_PROJECT_REFRESH_MS` | `30000` | how often a waiting project `poll` rechecks for pages joined from another process (`project merge`) |
| `AUSTERE_AXI_PAGE_HOLD_MS` | `600000` | how long a page poll's unacknowledged batch keeps the page out of the project `poll`; `0` disables |
| `AUSTERE_AXI_STALE_WORKING_MS` | `600000` | quiet time before a page with taken notes reads `stale`; `0` disables |
| `AUSTERE_AXI_NPM_REGISTRY` | `npm_config_registry`, else npmjs | registry for `components add`/`search`, except scopes mapped with `registry add` |
| `AUSTERE_AXI_CLOUD_URL` | `https://austere.blundertech.com` | service `publish` uses once `cloud on` (self-hosting, tests) |
| `AUSTERE_AXI_SYNC_RETRY_MS` | `1000` | first reconnect wait to a hosted page; doubles up to 60 s |
| `CHROME_PATH` | installed Chrome, Chromium or Edge | browser for `check --render` |

- **Dev checkout:** running from an austere-axi checkout (`node src/cli/main.ts`, or `dist/cli.mjs` in a git checkout) with `AUSTERE_AXI_STATE_DIR` unset uses `<checkout>/.dev/state` and a port in 4400–4899 derived from the path, and says so on stderr. Setting `AUSTERE_AXI_STATE_DIR` restores the `4388` default port.
- **Schema version:** hub.db records it. Commands that open it without the server (`hub list`, `hub notes`, `project …`, `archive`, file-less `poll`/`feedback`, and the index updates of `check`/`patch`) leave it alone while another version holds the state dir: readers open read-only or refuse if the schema is older than theirs; writers refuse. The error names the holder's version, pid and port.
