# Hub

The server starts when needed and stops after 30 idle minutes; to keep it running for good, see [Always on](#always-on). The hub has no on/off switch: it is the home page over `~/.austere-axi/hub.db` (SQLite), which keeps every page you open for review, `check` or `patch`, and its notes. It is there whenever the server runs:

```sh
austere-axi hub open    # http://127.0.0.1:4388/, signed in: the inbox, every page by project, notes, runs, search
austere-axi hub list    # the same, for an agent: [words] [--project p] [--archived] [--all] [--limit n]
austere-axi hub notes   # every note, same for an agent: [words] [--project p] [--unanswered] [--limit n]
```

The home page has a sidebar and four views. The sidebar lists the projects, each with its pages open for review and its unanswered notes; a page in several worktrees has a small chip per copy. ▸ folds a project away. The views:

- **Inbox** (the first time; then the view you used last): the pages open for review, in three groups, newest activity first in each.
  - **Needs you:** the agent changed the page since you last had it open (`Changed since you looked: 2 revisions`), a reviewer's notes wait for you to release them, or the last agent run on it failed. A page you never had open in a browser is not "changed".
  - **Waiting on agent:** notes no agent has answered, with who takes them: **an agent is listening** (a `poll` covers the page); **agent on**, the attached agent (see [Attach](attach.md)): **a run is working on them**, or **your next note starts a run** (turning attach on does not start a run for notes already there); or **nobody is taking them**, with a **Turn agent on** link that opens the page's Agent popover.
  - **Quiet:** the rest.
  A row shows the page's title (it opens the page), its path, project, last activity, its newest unanswered notes, and its chips. **Archive** puts every open copy of the page away (notes kept); **Undo** right after brings back exactly those copies.
- **Pages:** one section per project and one row per page, pages with unanswered notes first. **Open** (opened for review, not archived), **Everything** and **Archived** each show their page count; when a view is empty it names the others that are not. In **Archived** a row has **Unarchive**.
- **Notes:** every note, newest first, with its project and copy; search, status and author filters. `/notes` (and its old links, with their filters) opens this view.
- **Runs:** the newest 100 agent runs, with their state, page, harness and reason.

The search box at the top looks for pages by title, path or project, and for **parts**: statements whose text matches (the same index as `find`). A part opens its page with that part outlined. Every view and filter is in the address (`/?view=pages&project=shop`), so the back button and bookmarks work.

`hub list` and `hub notes` show 40 and say `40 of 45 pages shown` when there are more; `--limit n` shows more. `hub open` starts a browser unless `AUSTERE_AXI_NO_OPEN=1` is set (a machine with no screen); then it prints the url and how to sign in.

### From a review page

The owner's review header has a breadcrumb, **project ›** title, back to the hub (filtered to that project), and, on a page with copies in several worktrees, a list that opens the same page in another copy. On a phone the breadcrumb is a **‹** and the list is left out for room: the hub's chips and the quick switcher open the other copies. **Ctrl+K** (**⌘K** on a Mac; anywhere on the page, the composer too), or **Go to page…** in the `⋯` menu, opens a quick switcher: pages you opened lately first, then type to find pages and parts. **Next unanswered page** in the `⋯` menu goes to the next page in the inbox with notes no agent answered, at the copy that has them. A reviewer's page, and a hosted page, has none of this.

### What the hub sends

The hub is a small app over `/hub/api/` (`projects`, `pages`, `inbox`, `search`, `page/<copy id>`, `notes`, `runs`, and `page/<copy id>/archive|unarchive`). Like the hub, every route needs the owner's cookie: loopback alone, a reviewer's device and another site's page get 403, and a host not on the allowlist too.

## Projects and copies

A project is a name and a list of root folders. A page is a path inside a root, so the same file in two worktrees of one repository is one page with two copies. The row shows a chip per copy, labelled with the branch that worktree has checked out (or the folder's name), marked when it has unanswered notes; a chip opens that copy. A row shows 3 chips: copies with unanswered notes first, then one with an agent listening, then the newest; the rest are behind **+n more**. A long branch name is shortened in the middle; the chip's tooltip has the full name and the file. Notes stay with their copy: each branch's file can differ.

The hub finds a page's project without git; it never runs it. Walking up from the page's folder it takes the first of:

1. a root it already knows: a root holds every folder below it, except a folder it guessed at `/`, your home folder or the temp folder, which holds only that folder;
2. a folder with a `.git` entry: a `.git` directory is a repository; a `.git` file of a worktree joins the project of its main repository when git registered it there: its git dir sits in the repository's `worktrees/` folder, and points back at that `.git` file (`<gitdir>/gitdir`, as `git worktree add` writes it). A submodule, or any other `.git` file, is its own project. A worktree moved by hand is one of those until you run `git worktree repair`; if a page was already opened from the moved folder, its root is stored (see below), so also run `austere-axi project forget-root <folder>` once after the repair. Inside a root you assigned (`project add`), the repository or worktree joins that root's project, and its page paths start with the repository's folder inside that root (`shop/docs/plan.html`), so two repositories there stay apart and the repository's worktrees, wherever they are, share its pages;
3. a guessed folder: the folder the command ran in when the page is inside it (never `/`, your home folder or the temp folder), else the page's own folder. So `cd notes && austere-axi a/sprint.html` and `austere-axi b/plan.html` make one project, `notes`. A guessed folder takes in the folders guessed below it earlier, with their pages; a project `poll` waiting on one of those ends with `status: moved`.

A bare `poll` or `feedback` finds its project from the folder it runs in by the same rule, so it covers the pages opened from there.

A new project takes the repository's name: the `url` of its `origin` remote in the repository's `config` (`…/austere-axi.git` → `austere-axi`), for a bare repository and its worktrees too. With no origin it takes the folder's name without `.git` (a `.bare` folder: its parent's). When another project already has the name, the parent folder is added: `shop (work)`. The section heading on the home page, and `project list`, show the project's main root first: a root you assigned, else the repository, else a guessed folder, else a worktree; the first stored of a kind.

Two clones of one repository (one origin) that git does not tie together, such as a normal clone and a bare repository's worktrees, stay two projects. The newer one says so on the home page and in `project list`: `same repository as project austere-axi: austere-axi project merge austere-axi <id>`. Merging is your call; nothing is grouped on its own.

What it finds is stored, so it does not look again. Change it with `project`:

```sh
austere-axi project list                     # projects, their main root, root counts by kind, page counts
austere-axi project list --roots             # every root folder, with its kind
austere-axi project add ~/work/plans --name plans   # assign a root (a folder with no .git, holding pages in subfolders)
austere-axi project merge shop shop-clone    # the second project's roots move to the first
austere-axi project rename shop storefront     # refused if another project is named storefront
austere-axi project forget-root ~/old/clone  # its pages, and the project's other roots, are filed again
austere-axi project forget-root ~/gone/repo --drop  # a root whose folder is gone: its pages are archived
```

`project add` takes in the folders it guessed below the new root, and refuses a folder inside another project's root, or around one, naming that project; `project merge` is the way to join them. When the new root would take roots or pages from other projects, `add` lists each one (name, id, pages, roots) and changes nothing until you run it again with `--yes`. It refuses `/`, the temp folder, and the home folder or any folder holding it. A name is never empty and never looks like an id (12 hex characters). When two projects share a name, an error asking for an id lists each one's id and main root.

`forget-root` says where the root's pages went (`went:` each project, its root and page count). A folder with a `.git` is a root again at once, of a new project: `status: found again`, and the note gives the `project merge` that joins it back. A root whose folder is gone and holds pages needs `--drop`: its copies are archived (their notes are kept, `hub list --archived` shows them) and stay in their project, instead of being filed under folders that do not exist.

`--project` (on `poll`, `feedback`, `hub list` and `hub notes`) and the home page's project link take a name, an id, or any folder a root holds.

## What the lists leave out

- Pages only `check`ed or `patch`ed, never opened for review. `hub list --all` (or **Everything** on the home page) shows them.
- Archived pages: `austere-axi archive <file>` puts a page away and it stops taking notes, notes kept; `unarchive <file>` brings it back; `hub list --archived` shows them. Archive works per copy: with a copy in another worktree, the row stays, without the archived copy's notes in its counts, and opens the copy that is still open (`--every-copy` takes them all). A review closed in an older version (0.10.4 can still share this `hub.db`) is archived the next time `hub.db` is opened by this version, however late it was closed.
- Nothing else: a page whose file is gone stays listed, marked `missing`, with its notes. A page's title opens a copy that is still there; the chips open each copy.

## A copy whose file is gone

A row or chip marked `missing` opens a page of its own (status 410) with the file's path, the notes the copy still holds, and an **Archive this copy** button. Archiving leaves the copy out of the lists and keeps its notes. In the CLI, `archive <file>` does the same for one copy, and `archive --missing [--project p]` for every copy opened for review whose file is gone (a deleted worktree); `reply <file>` still answers its notes, and `feedback` marks its batch `missing: true`.

## History and text index

hub.db also holds each page's revisions (the whole program every time) and its statements as plain text, with a full-text index. They are filled by `patch`, `open`, `check` and the server watching a page, and read by `history`, `show`, `outline`, `find`, `changes` and `decisions` ([CLI](cli.md#history-and-reuse)). `austere-axi hub reindex` rebuilds the index from the files that still exist. A hub.db from 0.10.4 or 0.12 gets the tables on first open, and a page's first revision on its first open.

## Notes

- Session files from before 0.5 (`~/.austere-axi/sessions/*.json`) are imported into `hub.db` on first start and renamed to `*.imported`. A `hub.db` from an older version gets its projects on first open.
- One server runs per state dir; a second one refuses to start. `server.lock` holds the running server's pid and port. If that server no longer answers on the port, the lock is stale and is taken over.
- `hub on`, `hub off` and `hub status` are gone, because the hub has no on/off switch: they exit 2 and point at `hub open`.

## Always on

Without a service, the server a CLI command starts exits after 30 idle minutes. To keep one running for good, at a terminal:

```sh
npm install -g austere-axi      # a stable path for the service to run; npx's cache is not one
austere-axi server install      # [--port n] [--link-url https://austere.example.com]
austere-axi server status       # running, starting, failing to start or stopped; starts at login or boot; linger; which server answers
austere-axi server restart      # restart it, after upgrading austere-axi too; starts a stopped one
austere-axi server uninstall    # stop it and remove the unit
```

`server install` writes a per-user service that runs the installed CLI as `server --persist`, starts at login and restarts it when it fails:

- **Linux:** a systemd user unit, `~/.config/systemd/user/austere-axi.service`, then `systemctl --user daemon-reload` and `systemctl --user enable --now austere-axi.service`. With linger off (the default), systemd starts it when you log in and stops it when your last session ends: you log out, or the last ssh connection closes. Run `loginctl enable-linger` once to keep it running without a session and start it at boot. `server install` says so when linger is off; `server status` shows which applies (`linger: on|off`, `starts: at login|at boot`).
- **macOS:** a launchd agent, `~/Library/LaunchAgents/xyz.kasat.austere-axi.plist`, loaded with `launchctl bootstrap gui/<uid>`.
- **Windows:** it prints the Task Scheduler commands (`schtasks`) to do it by hand and changes nothing.

Before it writes anything it checks that the service manager answers (`systemctl --user show-environment`; on macOS `launchctl print gui/<uid>`). A shell from `su` or `sudo`, a container, or WSL without systemd has none: it then writes nothing and prints the command to run at login some other way. It refuses without a terminal, so an agent or a page cannot set it up, and while a server no service started holds the state dir (`server.lock`): run `austere-axi stop` first. On Windows it refuses the same way, and prints the steps to a terminal that runs it. A command it prints for you to paste is quoted for your shell. Run from npx, it warns: npm may clear npx's cache, and the service would stop starting. Run by a node in a folder of one Node release (nvm's `~/.nvm/versions/node/v24.1.0/bin/node`, a tarball's `node-v24.22.3-linux-x64/bin/node`, Homebrew's `Cellar/node/24.1.0`), it warns too: the next Node update removes that folder. When a `node` without a version in its path leads to the same file (on `PATH`, or in `/usr/local/bin`, `/usr/bin`, `/opt/homebrew/bin`), the unit runs that link instead, and an update moves the link. `server status` repeats the warning, and says so when the unit's node is gone.

It shows what it will do and asks (y/N): the command the unit runs, the port, the state dir, the link url, what it keeps of the unit it replaces and what it does not. If the service then fails to start, or another server answers on its port instead of the unit's own process within 15 s, it stops the unit and puts back what was there, and says where to see why (`journalctl --user -u austere-axi.service`, or `server.log` in the state dir on macOS).

`--port n` sets the port the service listens on. CLI commands on the same state dir find it without `AUSTERE_AXI_PORT`: the running server's `server.lock` names its port, and while the service is stopped the unit does. `AUSTERE_AXI_PORT`, when set, wins over both. `--link-url` sets `AUSTERE_AXI_LINK_URL` in the unit (see below). Run `server install` again to change either; without them it keeps the installed unit's, and it restarts the service. A re-install that changes the unit backs it up first (`austere-axi.service.bak`, then `.bak.1`; a backup is never overwritten). Lines you added to the unit (`Environment=`, `EnvironmentFile=`, `ExecStartPre=`, `ExecStartPost=`, `After=`, `Wants=`, `Requires=`) move to a drop-in, `~/.config/systemd/user/austere-axi.service.d/kept.conf`, which later installs leave alone; your own drop-ins there (`systemctl --user edit austere-axi.service`) are left alone too. Any other line you changed is not kept, and the summary names it. On macOS, extra `EnvironmentVariables` of the agent are kept in the new agent.

`server status` reports the service for this state dir in plain words: `running`, `starting`, `failing to start` (systemd restarts it in a loop, or gave up after 5 tries; launchd's last start exited with an error) or `stopped`; when it starts (`at login`, `at boot` with linger on, or `not on its own` when disabled); and the server that answers, with its version and pid and whether a service runs it. A unit that serves another state dir (`AUSTERE_AXI_STATE_DIR` points elsewhere) is named as `not installed for this state dir`; its state is not reported as this one's.

`server restart` restarts the server for this state dir and waits until the new one answers. Under a service it restarts the unit that runs it (`systemctl --user reset-failed` and `restart`, or `launchctl kickstart -k`), whatever its name, and starts a stopped one. A server no service runs is stopped and started again where it listened, with `--persist` if it had it; a CLI older than that server refuses, rather than put its own older version in its place. With no server and no service it starts one, as any command would.

`server install` and `server uninstall` refuse a unit that runs another CLI or another state dir than the one they run with: a build from a checkout, which uses a state dir of its own, must not repoint or remove the owner's service. `--force` goes ahead. A unit that runs from npx's cache is not refused for its CLI: moving it to an installed CLI is what the npx warning asks for.

A server the service runs never idles out, and a CLI never replaces it. What counts as a service is what the system says, and it is checked: the server asks systemd (or launchd) whether the unit that owns it runs the austere server (a `server` command that names `austere-axi`, or the very script this server runs; another project's `cli.mjs server` is not it), and whether that unit runs this process. A unit whose command is `npx -y austere-axi server --persist` counts too, although the server sits below the unit's main process. On macOS the agent can have any label: the CLI lists the running agents (`launchctl list`) and takes the one whose main process is the server or sits above it and runs the austere server; `server restart` restarts that label. An agent that wraps the server in a script that does not name `austere-axi` and does not `exec` it is not recognised; stop that server with `austere-axi stop` before upgrading. No variable can claim a supervisor that is not there, so a server you start by hand is an ordinary one. A CLI asks the system the same question about an older server before it replaces it, so a server from before 0.12 (which does not report a supervisor) that a unit runs, your own unit included, is left alone too. After upgrading austere-axi, the old server keeps running, and every CLI command says it needs a restart: `austere-axi server restart` (for a launchd agent whose label it cannot find, `launchctl kickstart -k gui/<uid>/<its label>`). A command that needs a server starts the service rather than one of its own. If the service does not start, the error names `systemctl --user status austere-axi.service` (or `launchctl print`) to see why, and `austere-axi server uninstall` to remove it. `austere-axi stop` stops the server; the next command that needs one starts the service again, which is what "always on" means. `austere-axi server uninstall` takes the service away for good. A server started any other way is still replaced by a newer CLI, which says so on stderr (`replaced server 0.11.0 (pid N) with 0.12.0 from <path>`) and starts the new one where the old one listened, with `--persist` if the old one had it, and with the old one's `AUSTERE_AXI_LINK_URL`, `AUSTERE_AXI_LINK_HOST` and `AUSTERE_AXI_ALLOWED_HOSTS` (a server from 0.12 on reports them; for an older one the caller's apply). `AUSTERE_AXI_PERSIST=1` is the same as `--persist`.

While such a server holds the service's port, the service cannot start. `server status` and every CLI command say so: ``the service cannot start: pid N holds port P and was not started by the service. Run `austere-axi stop`.`` The unit `server install` writes stops trying after 5 failed starts in 2 minutes (`failed` in `systemctl --user status`) instead of restarting for ever; after `austere-axi stop`, the next CLI command resets it and starts it. Health checks do not count as use, so an ordinary server still idles out while something probes it.

The server asks Tailscale for its address again every minute (`AUSTERE_AXI_TAILNET_CHECK_MS`, `0` turns it off). It starts listening on the tailnet when Tailscale comes up after the server (a service that starts at boot), listens again when the listener there stops accepting connections after Tailscale restarts, and moves when the address changes. While Tailscale does not answer, it keeps what it has. A proxy that points at the tailnet address needs no wait script or watchdog for this; it may answer 502 for up to a minute after Tailscale comes back.

### From a unit you wrote yourself

`server install` will not replace a unit it did not write unless told to, and `server uninstall` leaves one alone: yours may carry settings only you know about. This covers a unit at `~/.config/systemd/user/austere-axi.service`, and the unit that runs the server holding the state dir, whatever its name (for a server from before 0.12, the system names it). To move to the one this command writes:

```sh
austere-axi server install --adopt
```

It shows your unit's command, port, state dir and link url, and what it keeps: the port (`--port` or `AUSTERE_AXI_PORT`) and `AUSTERE_AXI_LINK_URL` become the new unit's own settings, and the other `Environment=`, `EnvironmentFile=`, `ExecStartPre=`, `ExecStartPost=`, `After=`, `Wants=` and `Requires=` lines go into the drop-in `austere-axi.service.d/kept.conf`. It lists the lines it does not keep (`Restart=always`, `Type=`, …). Say yes and it stops and disables your unit, moves its file to `<name>.bak` beside it, and installs and starts its own. If that fails, your unit is moved back, enabled and started again as it was. A unit outside `~/.config/systemd/user` (in `/etc`, or linked from elsewhere) is not moved: it says to disable it yourself (`systemctl --user disable --now <name>`) and run `server install` again. Other units of yours (a watchdog timer, a wait script) are not touched.

On macOS, `--adopt` takes the place of an agent at `~/Library/LaunchAgents/xyz.kasat.austere-axi.plist` that `server install` did not write, and keeps its `EnvironmentVariables`. An agent under another label is not found.

### Behind a reverse proxy

Install the service with the address reviewers reach it at, and point the proxy at its port:

```sh
austere-axi server install --link-url https://austere.example.com
```

Read the [trust model](team-review.md) first: behind a proxy on the same machine, every request looks local.
