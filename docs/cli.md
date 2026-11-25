# CLI reference

Usage errors (unknown command or flag, missing argument) exit 2 before anything runs; failures exit 1. `<command> --help` prints that command's flags and an example.

```
austere-axi                      pages + command list
austere-axi <file>               validate + register + open a review   [--no-open]
austere-axi poll [file]          long-poll for feedback; no file: every page of this checkout   [--project p: every checkout] [--cursor n] [--agent-reply "..."] [--after n]
austere-axi reply <file>         post a reply without polling   [--cursor n]

austere-axi login [file]         single-use link that signs a browser in as you (SSH, --no-open)
austere-axi feedback [file]      feedback no agent has answered yet; no file: every page of this checkout   [--project p: every checkout] [--all] [--peek]
austere-axi sessions list [file]   agent sessions that opened, patched or listened to a page; no file: the project   [--project p]
austere-axi run list [file]      runs of the attached agent; no file: the project   [--project p]; run log <id>; run stop <file> | --project p
austere-axi trigger list|add|remove   run a command once a project has been quiet (the user, at a terminal; see Triggers)   add --project p --on quiet:2h [--max-time 30m] -- <bin> [args…]
austere-axi attach status [file] whether an agent is attached to a page and what would stop it; no file: the project   [--project p]
austere-axi attach on|off [file] attach an agent to a page or a project (the user, at a terminal)   [--mode m] [--session s] [--harness h] [--model x]; attach inherit <file>
austere-axi check <file>         validate the program (no browser)    [--fix] [--render: headless Chrome, text report]
austere-axi patch <file>         merge statements from stdin into the program (reports dropped unreferenced ones)   [--from <src>#<a>[,<b>…] [--rev n]]: copy parts from another page first
austere-axi find <words>         search the text of every page's statements: title, file, copy, statement, snippet, age   [--project p] [--component c] [--limit n] [--all]
austere-axi outline <file>       the page as a tree from root: name, component, first words, child count
austere-axi show <file> [statement…]   source (default) or plain text of parts   [--text|--source] [--deps] [--rev n]
austere-axi history <file>       every version of a page, newest first, with the notes that caused each   [--statement name] [--since rev]
austere-axi restore <file> --rev n [statement…]   put the page, or named statements, back as they were (a patch, kept as a new revision)
austere-axi changes [file]       what changed since a cursor: statements before and after, causes, replies   [--project p] [--since cursor] [--limit n]
austere-axi decisions [file]     forms submitted, buttons pressed, batches sent with Send & finish   [--project p] [--since cursor] [--limit n]
austere-axi spec [group|pack...] component reference (~5.7k tokens; groups narrow it)
austere-axi components ...       list [group] | search <words> [--group G] | show <Name…> | add | remove | new | build; `list Diagrams` is the diagram chooser (see Diagrams)
austere-axi trust list|add|remove   packs your agent may add without --trust (see Trust)
austere-axi registry list|add|remove   private npm registries for scopes (see Private registries)
austere-axi adapter list|command|set     how a run starts an agent: harness binaries, capabilities, the owner's extra arguments (see Adapters)
austere-axi export <file>        one self-contained HTML file, works offline (~1.1 MB)
austere-axi hub [list|notes|open|reindex]   home page: an inbox of what needs you, every page by project, notes, runs, search (see Hub); reindex rebuilds the text index   [--project p] [--archived] [--all] [--unanswered]
austere-axi project list|add|merge|rename|forget-root   projects: a name and its root folders (see Hub)
austere-axi archive <file>       put a page away from the hub's lists; it stops taking notes; unarchive <file> brings it back
austere-axi archive --missing    the same for every copy whose file is gone   [--project p]
austere-axi share <file> --as "<name>"   a link for one teammate's device on your tailnet, claimed once   [--project <p> | --all] [--auto | --hold] [--expires <dur>]
austere-axi share list|revoke           links nobody has opened yet and devices; cut one off
austere-axi share requests [on|off]    who asks for access from a page's address (off by default); turn it on or off   [--project <p>]
austere-axi share approve|deny|block <id>   let that browser in, refuse it, or stop it asking   approve: [--project <p> | --all] [--auto | --hold]
austere-axi share default [hold|auto]   where a new reviewer's notes go when a share or approval does not say (hold unless changed; the hub's Settings too)
austere-axi publish <file>       hosted copy of the page on austere.blundertech.com   [--invite <name>]... [--expires <dur>] [--unlisted] [--auto] [--no-presence] [--new]
austere-axi publish invites|revoke <file> [name]   see a page's invites, cut one off
austere-axi publish login <file>   single-use link that signs your browser in to your hosted page
austere-axi publish list|rm <file|id>   your hosted pages; delete one now
austere-axi cloud on|off|status   cloud features: publish, clone, cloud login and hosted-page sync (off by default; the hub's Settings → Cloud too)
austere-axi cloud login|logout|whoami   your account on the hosted service: owner of all your hosted pages (see Hosted pages). publish and clone need it: until this machine is signed in they fail with login_required, and help leaves them out
austere-axi clone [<id> [<file>]]   your hosted pages from any machine; one as a local, attached file
austere-axi stop                 stop the background server
austere-axi server --persist     run the server in the foreground and never idle out
austere-axi server install|uninstall|status|restart   always-on server as a per-user systemd or launchd service (see Hub)   [--port n] [--link-url u] [--adopt] [--force]
austere-axi mcp                  MCP server on stdio (see MCP)
```

Trust and private registries are in [Components and packs](components-and-packs.md); the MCP server is in [Install](install.md#mcp).

Output is compact YAML for agents. Each `poll` item has its statement and that statement's line and source, so the agent does not read the file again. Agents revise with `patch` only: they send the changed statements, never the whole file.

## Review rules

- **Pages are permanent:** a registered page always takes notes. Nothing starts, ends, closes or reopens a review. `poll`, `reply` and `feedback` need only the page; the page's state is derived: `listening` (a poll waits), `working` (an agent has a batch), `stale` (an agent took a batch and for 10 minutes has neither replied, polled nor changed the file: its poll may have died), `idle`, or `archived`. The review page says "Agent working (2 min)", "Took your notes 14 min ago, no reply yet", "Agent idle in omp · Send wakes it" and "Agent busy in omp · notes wait for its turn" (see [Wake an idle session](#wake-an-idle-session)), and "Agent not listening" only when nothing would take a note; on a phone the dock under the page carries the same label.
- **Newest listener wins:** a new `poll` on a page answers the older one with `status: replaced`, and its `next:` says to stop. There is no `--takeover`; a poll waits for notes or for `--timeout-ms`, however many tabs are open.
- **One poll per checkout:** `poll` with no file listens to every page of the checkout it runs in: the root folder holding the current directory (a repository, a worktree, an assigned or a guessed folder). `--project <dir|name|id>` widens it to every root of that project. Pages are not opened first or registered one by one: any registered page takes notes while the server runs, and a page registered after the poll started is covered too. The answer names its `scope` (`this checkout`, or `every checkout of shop`) and lists `batches`, one per page, each with its `file`, its `copy` label (the branch or folder of its root), `final` and the usual `items`. Precedence is page, then checkout, then project: a poll on one page wins for that page, a checkout's poll for the rest of its checkout, and a `--project` poll gets what is left. A poll that answered keeps its pages until its agent acknowledges that batch (at most 10 minutes, so an agent that went away does not strand its notes): a page poll's batch from every wider poll, a checkout poll's batch from the project poll. A newer poll replaces only an older poll of the same scope, so agents in two worktrees of one repository never take each other's notes or stop each other.
- **Which pages a poll covers:** `poll` and `feedback` with no file print `scope:` and `pages: n`, how many pages of that checkout (or, with `--project`, of the project) are open for review (archived pages left out, a page's copies counted once). With none, `poll` returns at once with `no page of this checkout is open` (`… of this project …` with `--project`) instead of waiting, and so does `feedback` when no page there was ever opened. Opening a page prints its `project:` and a `next:` poll that covers it from the current folder: a bare `poll` when the folder is in the page's checkout, else `poll --project <name>`. Without a `.git` and outside a root you assigned with `project add`, the project of a page opened from inside the current folder is that folder, unless that folder is `/`, your home folder or the temp folder; then the page's own folder is the project (`hub.md`, Projects and copies). A poll whose pages were taken into another project or root ends with `status: moved`; poll that one instead.
- **The project cursor:** note seqs are one counter for the whole database, so the `cursor` of a project poll is the highest seq it returned. `poll --cursor n` acknowledges every note up to `n` on the pages it covers that a poll already handed over, and unacknowledged notes come back. It never acknowledges a note no poll delivered: after `poll --after k` skipped an older note on a page, the cursor stops short of it and the skipped note comes back, so a replay loses nothing (at-least-once). Replies stay per page: `reply <file> --cursor n` or `--agent-reply` after patching each file, then `poll --cursor n`; `--agent-reply` on a project poll is a usage error. `feedback` with no file reads every page of the checkout (with `--project`, of the project) the same way (`--peek` acknowledges nothing).
- **Hand the page to an agent:** **Copy agent prompt** in the review page's `⋯` menu (the owner's only), and under the composer while no agent listens ("Saved. The agent gets them the next time it checks."), copies a prompt for an agent that should listen on this page: the file, the shared page's address when it is published, and the same loop as `--help`: one `poll --project <name>` for every page of the page's project, `patch` and `reply`. When an agent already polls that project or this page's checkout, the prompt names `poll <file>` instead, which takes only this page and leaves the other agent's poll running. It holds no owner key, token or invite link. The agent needs the file at the same path, so it works on another machine too once that machine has your `cloud.json`. With an agent attached (the **Agent** pill), the line and button do not show: a note you send starts a run.
- **No lost notes:** every note is written to `~/.austere-axi/hub.db` before the page is told it was sent, so it survives a server crash or restart. Feedback sent while no agent listens waits for the next poll.
- **Acknowledge with the cursor:** `poll` prints a `cursor`. Passing it back (`--cursor n` on the next `poll` or `reply`), or replying at all, acknowledges everything up to it that a poll handed over; a note no poll delivered (skipped by `--after`) stays unread. A reply without a cursor acknowledges what the last poll handed over, after a server restart too. Without either, `poll` returns the same feedback again, so a crash or timed-out tool call loses nothing. `--after n` replays from any point.
- **Done is a hint, not a state:** the reviewer's **Done** (nothing typed or queued: a batch with no items) or **Send & finish** (the notes in the composer) marks that batch. `poll` returns `final: true` on it (`feedback` lists notes only, so it shows `final: true` on a Send & finish): that page is done. The agent applies it and replies; on a project poll it keeps polling while another page it opened is still in review, else it stops and continues in chat. The page still takes notes: a later one waits in the inbox for the next `poll`, days later and after a server restart too. A Done is not counted as a note waiting for an answer.
- **Archive is the only lock:** `archive <file>` (or **Archive page** in the page's `⋯` menu) leaves the hub's lists and the page stops taking notes: `/send` answers 409. `unarchive <file>` or **Unarchive page** restores both. A running server makes the change, so an open page updates at once; `open` leaves an archived page archived and prints `status: archived`. The page's frame stays in Explore and Annotate is off while it is archived.
- **Archive takes one copy:** a page in several worktrees has a copy in each, and `archive <file>` puts away that copy only. It prints the copy's label (`copy:`), its unanswered notes (`unanswered:`, kept, but out of the hub's counts) and the copies that stay open (`still_open:`, each with its unanswered notes); the hub row stays and opens a copy that is still open. `archive <file> --every-copy` puts away every copy of the page. The `⋯` menu asks the same: **Archive this copy** or **Archive every copy**, with the copies that stay open listed. When archive or unarchive fails, the page shows why.
- **Poll on an archived page:** `poll <file>` still returns notes queued before the page was archived; with none left it answers at once with `status: archived` and a `next:` that says to stop, and to unarchive only if the user asks, instead of waiting for a note the page cannot take. A `poll <file>` already waiting when the page is archived gets the same answer.
- **Missing files:** a copy whose file is gone keeps its notes. `feedback` with no file marks its batch `missing: true`; `reply <file>` and `archive <file>` work on it without the file (a path the hub never saw still says `no such file`). `archive --missing [--project p]` puts away every copy opened for review whose file is gone, in one command, and prints how many it archived and how many notes on them were still unanswered; those notes stay (`feedback` lists them with `archived: true`).
- **Removed in 0.12:** `end`, `close`, `reopen`, `open --reopen`, `poll --takeover` and `poll --owner` exit 2 with one line that names the replacement, or says the flag is gone when there is none (`--owner`). In 0.13 they are unknown. [Upgrading to 0.12](upgrading-to-0.12.md) maps each one, and the poll statuses that went with them.
- An `Image` src that is a path relative to the page (png, jpg, gif, webp, svg, avif) loads under review for the owner and for invited reviewers, and `export` inlines it as a data URI. Both read only regular files in the page's own folder, never dotfiles or links that leave it; `export` skips an image over 10 MB. A file `export` cannot read stays as written, and the output names it in `notices`.
- `feedback <file>` returns notes no agent has answered, from any day. Reading them acknowledges them; `reply` marks them answered.
- **Render failures reach the agent without a click:** an unknown component or a component that throws. The owner's open review page sends them as a note from "Render check", once per page revision, and `poll` returns them as `render_error` items. With no review tab open, nothing renders, so nothing is sent. `check --render <file>` renders the page in headless Chrome (an installed Chrome, Chromium or Edge, or `CHROME_PATH`) at 1280 and 390 px, opens each tab in turn, and prints render errors and the statements that make the page scroll sideways, as text, with no screenshot. Agents run it only when the user asks for a check.

## History and reuse

hub.db keeps every version of every page, whole (programs are a few KB; differences are worked out when read), and every statement as plain text. Nothing is written into the project.

- **Revisions:** a patch, an edit the server sees while the page is watched, an edit found when the page is opened or checked (made while no server ran), and a restore each make the next revision of that copy, numbered from 1. A page with the same program as the newest revision makes none. A `patch` first records the page as it is, so a page never opened still has its version before the patch.
- **The cause:** a revision names the notes it answers: the ones delivered and not yet answered when it was made, or, inside an attached run, that run's notes (`run:` is its id). `by:` is the agent session.
- **`history <file>`** lists revisions with the statements each changed (and removed), the first note behind it cut to 80 characters, and which statements were copied from where. `--statement name` keeps the revisions that changed it; `--since rev` those after it. **`show <file> --rev n [statement…]`** reads one; **`restore <file> --rev n [statement…]`** writes it back through the patch path (a named part comes back with what it needs that the page lost since) and records a new revision, so nothing is lost. A page already reading so answers `status: unchanged`.
- **`outline <file>`** is the tree from `root`: each named statement once, with its component, its first 8 words and how many named statements sit directly under it. The parts of a diagram, a table and a form are counted in their row, not listed: read them with `show <file> <statement> --deps`. It reads the file, so it works without a server. **`show --text`** is a statement as plain text: a table as Markdown, a diagram as its nodes and `a → b (label)` edges, a diff as file names with + and − counts, a form as its labels and options, a chart as its labels and series names. A reference to another statement is not followed (that statement has its own row); enumerations (variant, size, kind) and field names are not text.
- **`changes [file] [--project p] --since <cursor>`** lists revisions after the global revision id `cursor`, oldest first: the page and copy, the statements before and after as text, the notes that caused it, and the agent's reply. It prints `cursor:` for the next call. **`decisions`** reads the same way over the owner's forms and buttons (with their values) and the batches sent with Send & finish; its cursor is a note's `seq`. With no file, both read the project of the current folder (`--project` names another).
- **`find <words>`** searches the text of the statements of every page. SQLite's full-text search (FTS5) ranks them best first, each word matching as a prefix; if no page has every word it matches any of them. Where SQLite has no FTS5 it falls back to `LIKE` and the output says `search: LIKE …`. A page in several worktrees is one hit; a page gives at most 3 hits. Archived pages and copies whose file is gone are left out unless `--all`. The last line, `reuse: austere-axi patch <file> --from <page>#<statement>`, says how to take a part. `hub reindex` rebuilds the index from the files that still exist (a copy whose file is gone loses its index rows, not its revisions).
- **`patch <file> --from <src>#<a>[,<b>…] [--rev n]`** (repeatable) copies those statements and everything they reference from another page (its file now, or revision `n` of it), then merges stdin as usual: stdin may reference the copied statements, and one nothing references is dropped and reported (`dropped:`). A name the page already has is taken by the incoming statement under a new name (`flow` becomes `flow2`) and the incoming references follow; `renamed:` says so, so stdin must use the new name. Copied parts that use pack components print the `check --fix` hint. A copy is a copy, not an include: the page keeps rendering from its one file. Where each statement came from is kept (`statement_origins`): `outline` marks it `← page#statement`, and `history` lists it.
- **`similar:`:** the first `open` of a page the hub has not had under review lists up to 3 pages of its project, not archived, whose title or card heading reads like its own (two meaningful words in common, or all of the shorter one's), with the file and how long ago. It never blocks. `--help` says to run `find` first.
- **In the review page** (the owner's): when the owner returns to a page that changed while the tab was hidden, a bar says "2 revisions since you last looked" and can outline the statements they changed. **History…** in the `⋯` menu lists every revision (time, how it was made, the agent, the note behind it); picking one outlines what it changed. In a part's annotate popover, **History (n)** shows that statement's earlier texts, each with its note, and **Restore this version** puts one back. `/s/:id/history`, `/s/:id/viewed` and `/s/:id/restore` are the owner's only: a reviewer sees none of it and gets 403, and a foreign `Origin` is refused.
- MCP tools of the same names map 1:1 to the flags: `find`, `outline`, `show` (`plain_text` for `--text`), `history`, `restore`, `changes`, `decisions`, and `patch` with `from` and `rev`.

## Agent sessions

- **The command names its session:** `open`, `patch`, `poll`, `reply` and `feedback` find the agent session they run in from the harness's environment only: omp `PI_SESSION_ID` (and `PI_SESSION_FILE`), Copilot CLI `COPILOT_AGENT_SESSION_ID`, OpenCode `OPENCODE_SESSION_ID` (OpenCode sets none: the austere-axi OpenCode plugin below sets it), dsh `DSH_SESSION_ID`. `--session <harness>:<id>` names it when the environment does not (harness `omp`, `copilot`, `opencode` or `dsh`; a malformed value exits 2). Nothing searches for sessions; the only clients inside a session are the optional omp, Copilot and OpenCode extensions below, and they do nothing for a session that has no role.
- **One output line:** each of these commands prints `session: omp 1a2b3c registered` (the harness and the last six characters of the id; omp ids start with a timestamp, so their first characters repeat) or `session: "not detected (attach: new only)"`: with no session to go back to, attach can only start a new one.
- **Roles:** the first session to `open` or `patch` a copy of a page is its `author`; a different session that opens or patches it later is an `editor`. `poll`, `reply` and `feedback` make a session a `listener` of the page (every page of the project for a project `poll` or `feedback`). A repeat only moves the time.
- **Liveness:** when a command registers, it walks its parent processes to the harness's own (`/proc` on Linux, `ps` on macOS) and records that pid and its start time. `sessions list` shows `alive` while that process runs, `exited` once it is gone, `unknown` when none was found (always on Windows).
- **`sessions list [file]`:** harness, short id, role, last seen and liveness of each session of a page; with no file, of every page of the project of the current folder, or `--project`. It reads hub.db and needs no server.
- **Session ids stay on this machine:** they are in `hub.db` and in run logs (`<state>/runs/<id>.log`: what a harness prints, and a failure such as `session_unknown`, can name the full id), never in `publish`, `export`, hosted sync or a printed link. Check a run log for session ids before you share it.

## Wake an idle session

With the omp, Copilot CLI or OpenCode extension loaded, a note the owner sends starts the next turn of the session that wrote, edited or listened to the page, when that session is open and idle. No poll is needed. It never interrupts a running turn: the note waits until the turn ends. `poll` and attach work as before.

```
omp -e "$(npm root -g)/austere-axi/dist/harness/omp.js"                                         one omp session
ln -s "$(npm root -g)/austere-axi/dist/harness/omp.js" ~/.omp/agent/extensions/austere-wake.js   every omp session
ln -s "$(npm root -g)/austere-axi/dist/harness/copilot" ~/.copilot/extensions/austere-wake       every Copilot CLI session
ln -s "$(npm root -g)/austere-axi/dist/harness/opencode.js" ~/.config/opencode/plugins/austere-wake.js   every OpenCode session
```

Copilot CLI extensions are experimental: start `copilot --experimental` once, or turn it on with `/settings experimental on` (saved as `"experimental": true` in `~/.copilot/settings.json`).

- **Nothing happens in a session without a page.** The extension runs in every session it is loaded in, and does nothing until the server reports a role for the session's id. It checks once when the session starts: it reads `server.lock` and `owner.key` from the state dir, asks `/api/health` to prove the server holds that key, then asks the server once. With no role (or no server) it stops; it checks again only after a turn that ran `austere-axi`. It never starts a server, writes a file or registers a session.
- **With a role:** every second it looks whether the session is idle. omp: `isIdle()` and nothing queued. Copilot: busy from the foreground agent's `user.message` or `assistant.turn_start` until `session.idle`, which Copilot sends only when nothing runs, background shells and sub-agents included. OpenCode: the session's `session.status` events (`busy` and `retry` until `idle`); a subagent's session is not watched, its root is busy while it runs. After 2 idle seconds it waits on `POST /api/sessions/<harness>:<id>/wake-poll` (up to 50 s, then again); a turn that starts drops the wait. When the owner sends notes on one of the session's pages, it starts a turn with the server's prompt and answers `wake-ack`. A session that turned busy in between, or a send the harness refused, gives the notes back (`released`), and they come again once the turn ends. A server that stops answering: it retries with a back-off, and gives up after 6 failures until the session runs `austere-axi` again.
- **What the turn says:** the page's file, how many notes wait, and the three commands (`feedback`, `patch`, `reply --cursor <n>`). Never the notes' text: a teammate's note is untrusted, and the agent reads it with `feedback`, as an attached run does.
- **Which notes:** those the owner sent or released, as for attach. A page an agent polls gets nothing (the poll takes the notes), nor a page that is archived or published or shared with `--auto`, nor a page an attached run is answering.
- **Once:** the server gives a page's notes to one client at a time (a claim, held 60 s until the client answers), so two processes on one session never both start a turn. A delivered wake counts as a listener: it cancels an attached run that has not started.
- **On the review page:** "Agent idle in omp · Send wakes it" while a client waits; "Agent busy in omp · notes wait for its turn" while the session is in a turn (its process still runs, or, when that cannot be told, for 15 minutes); under a note that waits for it, "Queued · agent busy"; under a delivered note, "Delivered to omp 14:02". A Copilot or OpenCode session reads `copilot` or `opencode` in place of `omp`.
- **The server's routes:** `POST /api/sessions/<harness>:<id>/wake-poll` `{client, timeoutMs}` answers `no_role`, `idle` (with `timeoutMs` 0), `timeout`, `interrupted`, or `wake` `{claim, prompt, pages}`; `POST /api/sessions/<harness>:<id>/wake-ack` `{client, claim, outcome: delivered|released}`. Both need the owner key, as every `/api/*` route does. A waiting client does not keep an idle server up.
- **omp 18.22: no `deliverAs`.** `sendUserMessage(text, { deliverAs: "followUp" })` queues the message and does not start a turn when the session is idle (plannotator's Pi extension uses it). The extension calls `sendUserMessage(text)` with no `deliverAs`, which starts a turn when idle, and sends only when idle.
- **Copilot CLI 1.0.112:** the extension (`~/.copilot/extensions/<name>/extension.mjs`) runs in its own Node process and joins the session with `joinSession()` from `@github/copilot-sdk/extension`, which the CLI provides. It joins before the session's first prompt; `session.sessionId` is the `COPILOT_AGENT_SESSION_ID` the session's shell commands see. `session.send()` on an idle session starts a turn at once; the extension sends with `source: "automation-austere-axi"`, so the turn shows as an automation, not as the owner. Extensions load in interactive and `-p` sessions, not in `copilot --acp`.
- **OpenCode 1.19.5:** a plugin (`plugins/*.js` in `~/.config/opencode/` or a project's `.opencode/`), loaded by the OpenCode server process: the TUI's, or `opencode serve`'s, which runs many sessions, so the plugin keeps one client per session it has seen a turn of in that process. OpenCode puts no session id in the bash tool's environment, so the plugin sets `OPENCODE_SESSION_ID` there (`shell.env`), to the root session when a subagent runs the command. Its turn starts with `client.session.promptAsync`, which returns at once; `session.prompt` would wait for the turn to end, past the 60 s claim. The wake names no agent or model, so OpenCode picks them as for any prompt that names none. OpenCode 2 is not needed. A session resumed in a new OpenCode process is checked at its first turn there, not when it is opened.
- **Limits:** claims live in the server's memory, so a server restart between a wake and the agent's `feedback` can wake the session once more. When a page's poll ends without taking its notes, a waiting session gets them on its next wait (within 50 s). Other harnesses (Claude Code, Codex) have no client yet.

## Adapters

An adapter turns a run (a note the owner sent to an attached page) into one command for a harness. `adapter list` works anywhere and changes nothing; `adapter set` works only at a terminal.

```
austere-axi adapter list                                   each harness: bin, found (its path on PATH, or false), same/fork/new, model, max_cost, extra_args, write_grant
austere-axi adapter command <name> [--model m]             the command a new run of that adapter would run (bin, args with the owner's extra arguments and limits, env; the prompt goes on stdin): for a program that starts the harness itself, such as an add-on
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
austere-axi run stop <file>                 end the page's runs: the running one and everything it started is killed (without a server, also a crashed server's leftover run)
austere-axi run stop --project p            end the project's trigger runs (see Triggers)
```

- **When a run starts:** 5 s after the owner's last note on the page (`debounceMs`). One run per page at a time; notes that arrive while one runs make the next run, after it. At most 2 runs at once on the machine (`maxConcurrent`); the rest stay `queued`.
- **Which session:** the page's setting names a mode (`same`, `fork`, `new`) and a session (`author`: the session that wrote the page, followed to its newest continuation). With no session registered for the page, the run is `new`; for a harness (omp, Copilot) the first `new` run's session is kept, and later `new` runs on the page resume it. A command adapter reports no session, so each of its runs is new. A `same` run, or a `new` run that resumes the kept session, waits (`waiting_for_session`, announced once) while that session's harness process still runs, or while another page's run uses the same session, and starts when it is free (checked every second, and again every `recheckMs`, and when a poll arrives). A `same` run on a session whose process is unknown (`sessions list` shows `unknown`) is not resumed: the run fails with `session_unknown`; choose fork or new.
- **Statuses:** `queued`, `waiting_for_session`, `running`, `done`, `failed`, `stopped`, `interrupted`. A run is `done` only when it replied to every note it was started for; exit 0 without a reply is `failed` with `no_reply` (a harness without a write grant exits 0, see Adapters). Other reasons: `exit` (non-zero exit), `timeout`, `cost_cap` (omp exit 3), `session_in_use` (Copilot), `stopped`, `session_unknown`, `unsupported` (Copilot fork), `unavailable` (no such adapter, or its binary is not on `PATH`), `rate_limit`, `auto_conflict` (the page is published or shared with `--auto`), `config` (a malformed `attach.json` or `adapters.json`), and for a run that ended before it started: `listener`, `answered`, `attach_off`. A failed run leaves its notes unanswered, and is not retried; the owner's review page hears each change of a run, with the last 20 log lines when it failed.
- **What a run gets:** a 0600 prompt file on stdin (the page's path, the three commands and the seq its reply acknowledges; no note text), deleted when the run ends; the working directory of the page's root (else its folder); the server's environment with `AUSTERE_AXI_RUN_ID`, `AUSTERE_AXI_STATE_DIR` and `AUSTERE_AXI_PORT` of this server, and `<state>/runs/bin` first on `PATH`, where `austere-axi` runs this server's own CLI (not an older global install). Never the owner key, in argv, environment, prompt or log.
- **Logs:** `<state>/runs/<id>.log`, mode 0600, stdout and stderr, cut at 1 MB, removed after 30 days.
- **Time limit:** after `maxMinutes` the run's whole process tree is killed (SIGTERM, then SIGKILL 5 s later; `taskkill /T /F` on Windows). `run stop` and the review page's stop do the same at once.
- **Restart:** a server that stops kills its runs (waiting for their process trees before it lets go of the state dir) and leaves their rows `running`; the next one kills what a crashed server left running, marks those rows `interrupted` and queues each once more. Only once: a requeued run that a second restart interrupts stays `interrupted`. Its notes stay unanswered; the owner's next note on the page (or releasing a held one) starts a run that reads them all. A leftover process that may still run but cannot be confirmed as the run's (no start time was recorded, or the process table cannot be read, and its process group is still there) is not killed: its row stays `running`, so the page starts no other run, and `run stop` leaves it (without a server it says why); once that process is gone, `run stop` ends the row. On Windows, with no process table, the recorded pid's image name decides (`tasklist`): the binary the run spawned is killed with its tree (`taskkill /T /F`); another program means the pid was reused and the run is gone, so its row ends; if `tasklist` fails, the row stays `running`.
- **Attach and `--auto` exclude each other:** an unattended run reads only notes the owner sent or released. `publish --auto` and `share --auto` refuse while attach is on for the page, and a run refuses (`auto_conflict`) on a page published (as the hosted page now has it) or shared with `--auto`, and while a note an `--auto` invite let through, before it was revoked, is still unanswered: answer or discard it.
- **Windows:** a harness installed by npm is found as its `.cmd` shim (only `PATHEXT` names count) and run through `cmd.exe /d /s /c`, every argument quoted for it; the prompt still goes on stdin.

`<state>/attach.json` (written by the owner, read only from the state dir; every key optional; a value above its maximum makes the file malformed):

| Key | Default | Max | |
|---|---|---|---|
| `maxMinutes` | `15` | `1440` | wall clock per run |
| `runsPerHour` | `12` | `1000` | runs started per page in any hour; the next one fails with `rate_limit` |
| `maxConcurrent` | `2` | `16` | runs at once on the machine |
| `debounceMs` | `5000` | `3600000` | wait after the owner's last note |
| `recheckMs` | `30000` | `3600000` | how often a waiting run looks again |
| `maxCost` | | | omp `--max-cost` (dollars) |
| `maxAiCredits` | | | Copilot `--max-ai-credits` |

## Triggers

A trigger runs a command once a project has been quiet: the first "on event" facility of the core, and generic (the optional wiki add-on uses it to start its ingest; nothing here knows it).

```
austere-axi trigger add --project shop --on quiet:2h [--max-time 30m] -- austere-wiki ingest --project shop
austere-axi trigger list
austere-axi trigger remove <id>
```

- **Terminal only:** a trigger names a command that runs on this machine, so `trigger add` and `trigger remove` work only at a terminal, as `trust add` does: without one they exit 2, change nothing and print the command for the user to run. `<state>/triggers.json` (mode 0600) is read only from the state dir: a file of that name in a project or a page's folder is never read, and neither is anything a page or a note says. An agent can `trigger list` and read the runs.
- **When it runs:** after the last revision or note in the project, once `<duration>` (`quiet:90s`, `quiet:30m`, `quiet:2h`, `quiet:1d`) passes with none, the command runs once. It runs with no shell, in the project's first folder, with the server's environment plus `AUSTERE_AXI_RUN_ID`, `AUSTERE_AXI_PROJECT` (the project's name) and `AUSTERE_AXI_CHANGES_CURSOR` (the cursor the trigger had before this run, the one `changes --since` takes), and `austere-axi` on `PATH` is this server's CLI. Never the owner key.
- **Not again without new activity:** a trigger starts from the moment it was added; what happened before is not its activity. Activity while a run goes on (a revision after the run's cursor, a note after it started) makes exactly one more run, once the project is quiet again. A run a restart interrupted gives its cursor back, so the activity it was for runs again.
- **A run like any other:** a row in `run list --project p` (`trigger: <id>`, the cursor range), `run log <id>`, `run stop --project p`. Same log (1 MB, 0600, 30 days), `maxTime` (else `maxMinutes` in `attach.json`) and `runsPerHour` (per trigger) and `maxConcurrent` limits as a note's run. Statuses: `done`, `failed` (`exit`, `timeout`, `rate_limit`, `unavailable`), `stopped`, `interrupted`.
- **It needs a server:** a server with a trigger configured does not idle out. Without a running server nothing runs; `server install` keeps one.

## Add-ons

`austere-wiki`, a project wiki an agent keeps from your reviews and you check in the same review page, is an optional add-on in a separate private repository. It is not part of this package: it reaches the core only through this CLI (`changes`, `decisions`, `show`, `find`, `feedback`, `reply`, `adapter command`, `trigger`, with `AUSTERE_AXI_FORMAT=json`), keeps its own database (`<state>/wiki.db`), and starts its ingest with a [trigger](#triggers). With it uninstalled, nothing here changes.

## Attach

Attach decides whether a note the owner sends starts an agent on a page (see [Attach an agent](attach.md) for the whole story). A page has its own setting, or uses its project's default; with neither it is off.

```
austere-axi attach status [file] [--project p]          the setting that applies and where it comes from, the mode, the session a run resumes, harness, model, last run, warnings
austere-axi attach on [file] [--mode m] [--session s] [--harness h] [--model x]   turn it on for the page (no file: the project of the current folder, or --project)
austere-axi attach off [file]                            turn it off for the page (or the project)
austere-axi attach inherit <file>                        the page goes back to its project's default
```

- **Anywhere, read-only:** `attach status` changes nothing and needs no server; an agent may run it (MCP `attach_status`). Its `warnings` name what would stop a run or make it useless: a harness without the write grant (with the `adapter set` command that grants it), a binary not on `PATH`, a mode the harness cannot run, a `same` session whose process is unknown, a page published or shared with `--auto`.
- **The user's only:** `attach on`, `off` and `inherit` without a terminal exit 2, change nothing and print the command for the user to run. The review page's Agent pill does the same for the owner. No MCP tool changes it. With a server running, the change goes through it, so the owner's open review tabs show it at once.
- **Fields:** `--mode same|fork|new` (default `same`), `--session author|<id>` (default `author`: the session that wrote the page, followed to its newest continuation; or a short or full id from `sessions list`), `--harness omp|copilot|<command adapter>` (the harness of a new session; default the project's, else omp), `--model` (default the harness's own; `""` clears it). A field you leave out keeps its value.
- **Refused:** any change that would leave a page published or shared with `--auto` on (they exclude each other): `attach on` for it, `attach inherit` onto a project default that is on, or `attach on --project` while it uses the project's default. Also a mode the harness cannot run (Copilot fork). Nothing is written then.

## Environment

| Variable | Default | |
|---|---|---|
| `AUSTERE_AXI_PORT` | the port in the state dir's `server.lock` while its server runs, else the installed service's, else `4388` | server port |
| `AUSTERE_AXI_STATE_DIR` | `~/.austere-axi` | pages and notes (`hub.db`), owner key, server log (mode 0700 on macOS and Linux) |
| `AUSTERE_AXI_NO_OPEN` | | `1` = never open a browser |
| `AUSTERE_AXI_HOST` | | extra bind address (never `0.0.0.0`) |
| `AUSTERE_AXI_NO_TAILSCALE` | | `1` = loopback only |
| `AUSTERE_AXI_FORMAT` | | `json` = every command prints one JSON line instead of the compact YAML, for a program that reads the output (the same fields) |
| `AUSTERE_AXI_TAILNET_CHECK_MS` | `60000` | how often the server asks Tailscale for its address again (it came up later, restarted, or changed); `0` disables |
| `AUSTERE_AXI_LINK_HOST` | | host in the printed remote link (`http://<host>:<port>`) |
| `AUSTERE_AXI_LINK_URL` | | full origin of the printed remote link, e.g. `https://austere.example.com` behind a TLS proxy; the host is accepted without `ALLOWED_HOSTS`. The host may hold only letters, digits, dots, hyphens and underscores (or be a bracketed IPv6 address) |
| `AUSTERE_AXI_ALLOWED_HOSTS` | | extra `Host` headers to accept (reverse proxy) |
| `AUSTERE_AXI_IDLE_TIMEOUT_MS` | `1800000` | idle shutdown; `0` disables |
| `AUSTERE_AXI_PERSIST` | | `1`: never idle out, as `server --persist` |
| `AUSTERE_AXI_PROJECT_REFRESH_MS` | `30000` | how often a waiting project `poll` looks again for pages that joined the project from another process (`project merge`) |
| `AUSTERE_AXI_PAGE_HOLD_MS` | `600000` | how long a page poll's unacknowledged batch keeps the page out of the project `poll`; `0` disables |
| `AUSTERE_AXI_STALE_WORKING_MS` | `600000` | how long an agent that took a page's notes may stay quiet (no reply, poll or change to the file) before the page reads `stale`; `0` disables |
| `AUSTERE_AXI_NPM_REGISTRY` | `npm_config_registry`, else npmjs | where `components add` gets packs and `components search` finds them, except scopes mapped with `registry add` |
| `AUSTERE_AXI_CLOUD_URL` | `https://austere.blundertech.com` | the service `publish` talks to (self-hosting, tests), once `cloud on` |
| `AUSTERE_AXI_SYNC_RETRY_MS` | `1000` | first wait before the local server reconnects to a hosted page; it doubles up to 60 s |
| `CHROME_PATH` | an installed Chrome, Chromium or Edge | the browser `check --render` uses |

A CLI run from a checkout of austere-axi (`node src/cli/main.ts`, or `dist/cli.mjs` in a git checkout) with `AUSTERE_AXI_STATE_DIR` unset uses `<checkout>/.dev/state` and a port of its own (4400–4899, from the checkout's path), so it keeps off the installed server and its hub.db. It prints one line on stderr saying so. Set `AUSTERE_AXI_STATE_DIR` to choose; `AUSTERE_AXI_PORT` then defaults to `4388` again.

hub.db records its schema version. Commands that open it without the server (`hub list`, `hub notes`, `project …`, `archive`, `poll` and `feedback` without a file, and the hub index `check` and `patch` update) leave it alone while a server or command of another version holds the state dir: readers open it read-only, or refuse when its schema is older than theirs; commands that write refuse. The error names the holder's version, pid and port.
