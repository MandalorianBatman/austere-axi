# Hub

The hub is the home page over `~/.austere-axi/hub.db` (SQLite): every page you open for review, `check` or `patch`, and its notes. It has no on/off switch; it is there whenever the server runs. The server starts when needed and stops after 30 idle minutes (to keep it running, see [Always on](#always-on)).

```sh
austere-axi hub open    # http://127.0.0.1:4388/, signed in: inbox, pages by project, notes, runs, search
austere-axi hub list    # the same, for an agent: [words] [--project p] [--archived] [--all] [--limit n]
austere-axi hub notes   # every note, for an agent: [words] [--project p] [--unanswered] [--limit n]
```

- `hub list` and `hub notes` show 40 and say `40 of 45 pages shown` when there are more; `--limit n` shows more.
- `hub open` starts a browser unless `AUSTERE_AXI_NO_OPEN=1` (a machine with no screen); then it prints the url and how to sign in.
- `hub on`, `hub off` and `hub status` exit 2 and point at `hub open`.

## Views

**Sidebar:** the projects, each with its pages open for review and its unanswered notes. A page in several worktrees has a chip per copy. ▸ folds a project.

- **Inbox** (shown first time; then the last view used): pages open for review, newest activity first, in three groups:
  - **Needs you:** the agent changed the page since you last had it open (`Changed since you looked: 2 revisions`; a page never opened in a browser is not "changed"), a reviewer's notes wait for release, or the last agent run failed.
  - **Waiting on agent:** unanswered notes, with who takes them:
    - **an agent is listening** (a `poll` covers the page);
    - **agent on** ([Attach](attach.md)): **a run is working on them**, or **your next note starts a run** (turning attach on does not start a run for existing notes);
    - **nobody is taking them**, with a **Turn agent on** link to the page's Agent popover.
  - **Quiet:** the rest.
  - A row shows title (opens the page), path, project, last activity, newest unanswered notes and chips. **Archive** puts every open copy away (notes kept); **Undo** right after restores exactly those copies.
- **Pages:** a section per project, a row per page, pages with unanswered notes first. **Open** (open for review, not archived), **Everything** and **Archived** show their counts; an empty view names the non-empty ones. **Archived** rows have **Unarchive**.
- **Notes:** every note, newest first, with project and copy; search, status and author filters. `/notes` (and its old links with filters) opens this view.
- **Runs:** the newest 100 agent runs: state, page, harness, reason.
- **Settings:** see [Settings](#settings).

**Search** (top of sidebar; on a phone, the search button in the top bar) finds pages by title, path or project, and **parts**: statements whose text matches (the `find` index). A part opens its page with that part outlined.

Every view and filter is in the address (`/?view=pages&project=shop`), so back and bookmarks work.

### From a review page

Owner only; a reviewer's page and a hosted page have none of this.

- **Breadcrumb** (**project /** title): back to the hub, filtered to that project. On a page with copies in several worktrees, a list opens the same page in another copy. On a phone: a back arrow, no list (use the hub's chips or the quick switcher).
- **Quick switcher:** **Ctrl+K** (**⌘K**; anywhere, including the composer and the page) or **Go to page…** in `⋯`. Recent pages first, then type to find pages and parts.
- **Next page with unanswered notes** (`⋯`): the next inbox page with unanswered notes, at the copy that has them.
- **Projects sidebar** beside the page: every project and its pages, this one marked; click to open another. Toggle with the header's left button or **Ctrl+B** (**⌘B**; the page too). Starts folded; the choice is kept in the browser and shared with the hub (whose sidebar starts open). Under 1100 px and on a phone it opens over the page with a scrim.

### Settings

**Settings** (`/?view=settings`) is the owner's page for this local server (hosted pages keep their own invites: `publish --invite`). Its sidebar count is the people waiting for access. Every setting has a terminal form, named on the page; commands that run things (`server install`, `adapter set`, `trigger add`) stay at a terminal.

| Section | What it does | Terminal |
|---|---|---|
| **People and access** | Waiting requests: **Approve** (this page, its project, or every page; notes held or sent to the agent), **Deny**, **Block**. Where browsers without a link may ask (every page or per project; a project's own choice wins). **New link** for a page, its project or every page (as **Share** in a page's `⋯`). Unopened links: **Copy link**, **Cancel link**, **Make single-use** (old-style links). Devices: how they got in, reach, where notes go, last seen (time, address), **Notes by**, new reach, **Rename**, **Revoke**. See [Team review](team-review.md). | `share`, `share list\|revoke`, `share requests`, `share approve\|deny\|block` |
| **Network** | Addresses the server answers on (this computer, Tailscale, local network, one added at a terminal); the address to share and what set it; whether the server stays on (service, started to stay on, or stops after 30 idle minutes). **Names from Tailscale:** whether Tailscale names reviewers and lets a Tailscale login in without a link. **Local network:** switch, off by default, to also listen on one local-network address, for reviewers only; asks first and warns traffic is not encrypted. See [Team review](team-review.md#who-is-this-reviewer). | `server install`, `share tailscale`, `server lan` |
| **Review defaults** | Where a new reviewer's notes go unless a share or approval says otherwise: **Hold them for me** (default) or **Send them straight to the agent**. Existing reviewers keep theirs. **On pages now:** who has which page open. | `share default hold\|auto`; `share --hold\|--auto` per share |
| **Cloud** | Cloud features, **off by default**: `publish`, `clone`, `cloud login\|whoami`, hosted-page sync. Off: only local features; nothing reaches the hosted service; published pages stay up but do not sync; turning off asks first if there are any. Shows the service, signed-in account and published-page count, from `cloud.json` (no request). See [Hosted pages](hosted-pages.md#cloud-switch). | `cloud on\|off\|status` |
| **Projects** | Each project's folders, **Rename**, **Merge into** an older project of the same repository, **Forget** a folder (gone folder: pages archived, notes kept), **Archive missing pages**. | `project rename\|merge\|forget-root`, `archive --missing` |
| **About** | Version, state folder, port; a note when the terminal's austere-axi is newer than the server. | `server restart` |

Routes: reads `/hub/api/settings`, `/hub/api/people`; changes via `POST /hub/api/settings/review`, `/hub/api/settings/cloud`, `/hub/api/people/…`, `/hub/api/projects/…`.

### What the hub sends

The hub is an app over `/hub/api/` (`projects`, `pages`, `inbox`, `search`, `page/<copy id>`, `notes`, `runs`, `page/<copy id>/archive|unarchive`). Every hub route needs the owner's cookie from the same site: loopback alone, a reviewer's device, another site's page, or a host not on the allowlist get 403.

## Projects and copies

A project is a name plus root folders. A page is a path inside a root, so one file in two worktrees of a repository is one page with two copies.

- A chip per copy, labelled with the worktree's branch (or the folder name), marked when it has unanswered notes; it opens that copy.
- A row shows 3 chips (unanswered notes first, then one with an agent listening, then newest); the rest under **+n more**. Long branch names are shortened in the middle; the tooltip has the full name and file.
- Notes stay with their copy.

**Finding a page's project** (no git is run). Walking up from the page's folder, the first of:

1. **A known root.** A root holds every folder below it, except a root guessed at `/`, home or the temp folder, which holds only itself.
2. **A folder with a `.git` entry.**
   - A `.git` directory is a repository.
   - A worktree's `.git` file joins its main repository's project when git registered it (its git dir is in the repository's `worktrees/` and `<gitdir>/gitdir` points back, as `git worktree add` writes it).
   - A submodule or any other `.git` file is its own project.
   - A worktree moved by hand is its own project until `git worktree repair`; if a page was already opened from the moved folder, also run `austere-axi project forget-root <folder>` once after the repair.
   - Inside a root you assigned (`project add`), the repository or worktree joins that root's project; page paths start with the repository folder (`shop/docs/plan.html`), so repositories there stay apart and its worktrees, wherever they are, share its pages.
3. **A guessed folder:** the folder the command ran in if the page is inside it (never `/`, home or temp), else the page's folder. So `cd notes && austere-axi a/sprint.html` and `austere-axi b/plan.html` make one project, `notes`. A guessed folder absorbs folders guessed below it earlier, with their pages; a project `poll` waiting on one ends with `status: moved`.

A bare `poll` or `feedback` finds its project from its working folder the same way.

**Naming:** a new project takes the repository's name from the `origin` `url` in its `config` (`…/austere-axi.git` → `austere-axi`), also for bare repositories and their worktrees. No origin: the folder name without `.git` (a `.bare` folder: its parent's). A taken name gets the parent folder added: `shop (work)`. The home page heading and `project list` show the main root first: an assigned root, else the repository, else a guessed folder, else a worktree; the first stored of a kind.

**Two clones** of one origin that git does not tie together stay two projects. The newer one says so in the hub and `project list`: `same repository as project austere-axi: austere-axi project merge austere-axi <id>`. Nothing is merged automatically.

What it finds is stored. Change it with `project`:

```sh
austere-axi project list                     # projects, main root, root counts by kind, page counts
austere-axi project list --roots             # every root folder, with its kind
austere-axi project add ~/work/plans --name plans   # assign a root (a folder with no .git, pages in subfolders)
austere-axi project merge shop shop-clone    # the second project's roots move to the first
austere-axi project rename shop storefront   # refused if storefront exists
austere-axi project forget-root ~/old/clone  # its pages, and the project's other roots, are filed again
austere-axi project forget-root ~/gone/repo --drop  # a gone root: its pages are archived
```

- `project add` absorbs folders guessed below the new root. It refuses a folder inside or around another project's root (naming it; use `project merge`), and `/`, the temp folder, and home or any folder holding it. If it would take roots or pages from other projects, it lists each (name, id, pages, roots) and changes nothing until rerun with `--yes`.
- Names are never empty and never look like an id (12 hex characters). When two projects share a name, the error lists each one's id and main root.
- `forget-root` reports where pages went (`went:` each project, root, page count). A folder with a `.git` becomes a root of a new project at once (`status: found again`; the note gives the `project merge` to join back). A gone root holding pages needs `--drop`: its copies are archived (notes kept, shown by `hub list --archived`) and stay in their project.
- `--project` (on `poll`, `feedback`, `hub list`, `hub notes`) and the hub's project link take a name, an id, or any folder a root holds.

## What the lists leave out

- Pages only `check`ed or `patch`ed, never opened for review: `hub list --all` or **Everything** shows them.
- Archived pages. `austere-axi archive <file>` puts a page away (stops taking notes, notes kept); `unarchive <file>` brings it back; `hub list --archived` shows them. Archive is per copy: other copies keep the row (without the archived copy's notes in counts); `--every-copy` archives all.
- Nothing else: a page whose file is gone stays listed, marked `missing`, with its notes. The title opens a copy that still exists; chips open each copy.

## A copy whose file is gone

A `missing` row or chip opens a page (status 410) with the path, the copy's notes and **Archive this copy** (leaves the lists, keeps notes). CLI:

- `archive <file>`: one copy.
- `archive --missing [--project p]`: every copy open for review whose file is gone (e.g. a deleted worktree).
- `reply <file>` still answers its notes; `feedback` marks its batch `missing: true`.

## History and text index

`hub.db` also holds each page's revisions (the whole program each time) and its statements as plain text with a full-text index. Filled by `patch`, `open`, `check` and the server watching a page; read by `history`, `show`, `outline`, `find`, `changes`, `decisions` ([CLI](cli.md#history-and-reuse)). `austere-axi hub reindex` rebuilds the index from files that still exist.

## Server lock

One server runs per state dir; a second refuses to start. `server.lock` holds the running server's pid and port. If that server no longer answers on the port, the lock is stale and is taken over.

## Always on

Without a service, a server a CLI command starts exits after 30 idle minutes. To keep one running, at a terminal:

```sh
npm install -g austere-axi      # a stable path for the service; npx's cache is not one
austere-axi server install      # [--port n] [--link-url https://austere.example.com] [--force] [--adopt]
austere-axi server status       # running, starting, failing to start or stopped; starts at login/boot; linger; which server answers
austere-axi server restart      # restart it (also after updating austere-axi); starts a stopped one
austere-axi server uninstall    # stop it and remove the unit
```

`server install` writes a per-user service running the installed CLI as `server --persist`, started at login, restarted on failure:

| OS | Service |
|---|---|
| Linux | systemd user unit `~/.config/systemd/user/austere-axi.service`; then `systemctl --user daemon-reload` and `systemctl --user enable --now austere-axi.service`. With linger off (default) it starts at login and stops when your last session ends (logout or last ssh connection). `loginctl enable-linger` keeps it running without a session and starts it at boot. `server install` warns when linger is off; `server status` shows `linger: on\|off`, `starts: at login\|at boot`. |
| macOS | launchd agent `~/Library/LaunchAgents/xyz.kasat.austere-axi.plist`, loaded with `launchctl bootstrap gui/<uid>`. |
| Windows | Prints the Task Scheduler (`schtasks`) commands; changes nothing. |

### Install checks

- Checks the service manager answers first (`systemctl --user show-environment`; macOS `launchctl print gui/<uid>`). None (shell from `su`/`sudo`, a container, WSL without systemd): writes nothing, prints the command to run at login another way.
- Refuses without a terminal (an agent or a page cannot set it up). On Windows it refuses the same way and prints the steps to a terminal.
- Refuses while a server no service started holds the state dir (`server.lock`): run `austere-axi stop` first.
- Printed commands are quoted for your shell.
- Warns when run from npx (npm may clear its cache and the service would stop starting).
- Warns when run by a node in a single-release folder (nvm's `~/.nvm/versions/node/v24.1.0/bin/node`, a tarball's `node-v24.22.3-linux-x64/bin/node`, Homebrew's `Cellar/node/24.1.0`): the next Node update removes it. If a versionless `node` leads to the same file (on `PATH`, or in `/usr/local/bin`, `/usr/bin`, `/opt/homebrew/bin`), the unit runs that link instead. `server status` repeats the warning, and says when the unit's node is gone.
- Shows what it will do and asks (y/N): the command, port, state dir, link url, and what it keeps or drops of the unit it replaces.
- If the service fails to start, or another server answers on its port within 15 s, it stops the unit, restores what was there, and says where to look (`journalctl --user -u austere-axi.service`; on macOS `server.log` in the state dir).
- `server install` and `server uninstall` refuse a unit that runs another CLI or another state dir (so a build from a checkout, with its own state dir, cannot repoint or remove your service); `--force` overrides. A unit running from npx's cache is not refused for its CLI.

### Port, link url and re-install

- `--port n`: the service's port. CLI commands on the same state dir find it without `AUSTERE_AXI_PORT` (from `server.lock` while running, from the unit while stopped). `AUSTERE_AXI_PORT`, if set, wins.
- `--link-url`: sets `AUSTERE_AXI_LINK_URL` in the unit.
- Running `server install` again changes either (omitted flags keep the installed values) and restarts the service.
- A re-install that changes the unit backs it up first (`austere-axi.service.bak`, then `.bak.1`; never overwritten).
- Lines you added (`Environment=`, `EnvironmentFile=`, `ExecStartPre=`, `ExecStartPost=`, `After=`, `Wants=`, `Requires=`) move to the drop-in `~/.config/systemd/user/austere-axi.service.d/kept.conf`, which later installs leave alone, as are your own drop-ins (`systemctl --user edit austere-axi.service`). Other changed lines are not kept; the summary names them. On macOS, extra `EnvironmentVariables` are kept.

### Status and restart

- `server status` states: `running`, `starting`, `failing to start` (systemd restart loop, or gave up after 5 tries; launchd's last start exited with an error), `stopped`. When it starts: `at login`, `at boot` (linger on), or `not on its own` (disabled). Also the answering server's version, pid and whether a service runs it. A unit serving another state dir (`AUSTERE_AXI_STATE_DIR` elsewhere) shows as `not installed for this state dir`.
- `server restart` restarts the server for this state dir and waits until it answers. Under a service: restarts its unit, whatever the name (`systemctl --user reset-failed` + `restart`, or `launchctl kickstart -k`), starting a stopped one. Without a service: stops and restarts it where it listened, with `--persist` if it had it; a CLI older than the server refuses. No server and no service: starts one.

### Service-run servers

- A service-run server never idles out and is never replaced by a CLI.
- What counts as a service is checked with systemd/launchd: the owning unit must run the austere server (a `server` command naming `austere-axi`, or the script this server runs; another project's `cli.mjs server` is not) and run this process. `npx -y austere-axi server --persist` counts too.
- macOS: any agent label works; the CLI finds it via `launchctl list` (main process is the server or above it and runs the austere server), and `server restart` restarts that label. A wrapper script that neither names `austere-axi` nor `exec`s it is not recognised; stop that server with `austere-axi stop` before updating.
- No variable can fake a supervisor: a server started by hand is ordinary. A CLI checks the same before replacing any server, so a unit-run server (including your own unit) is left alone.
- After updating austere-axi, the old server keeps running and every CLI command says it needs `austere-axi server restart` (for a launchd agent whose label it cannot find: `launchctl kickstart -k gui/<uid>/<its label>`).
- A command that needs a server starts the service, not its own. If the service does not start, the error names `systemctl --user status austere-axi.service` (or `launchctl print`) and `austere-axi server uninstall`.
- `austere-axi stop` stops the server; the next command that needs one starts the service again. `server uninstall` removes the service for good.
- A server started any other way is replaced by a newer CLI, which says so on stderr (`replaced server 0.11.0 (pid N) with 0.12.0 from <path>`) and starts the new one where the old one listened, with `--persist` if it had it and the old one's `AUSTERE_AXI_LINK_URL`, `AUSTERE_AXI_LINK_HOST` and `AUSTERE_AXI_ALLOWED_HOSTS`. `AUSTERE_AXI_PERSIST=1` equals `--persist`.
- While a non-service server holds the service's port, the service cannot start; `server status` and every command say: ``the service cannot start: pid N holds port P and was not started by the service. Run `austere-axi stop`.`` The unit stops trying after 5 failed starts in 2 minutes (`failed` in `systemctl --user status`); after `austere-axi stop`, the next CLI command resets and starts it.
- Health checks do not count as use: an ordinary server still idles out while probed.

### Tailscale

The server re-checks its Tailscale address every minute (`AUSTERE_AXI_TAILNET_CHECK_MS`; `0` disables). It starts listening on the tailnet when Tailscale comes up after the server, re-listens when the tailnet listener stops accepting after a Tailscale restart, and moves when the address changes. While Tailscale does not answer, it keeps what it has. A proxy pointing at the tailnet address needs no wait script or watchdog; it may answer 502 for up to a minute after Tailscale returns.

### From a unit you wrote yourself

`server install` does not replace a unit it did not write, and `server uninstall` leaves one alone. This covers `~/.config/systemd/user/austere-axi.service` and the unit running the server that holds the state dir, whatever its name. To switch to the generated unit:

```sh
austere-axi server install --adopt
```

- Shows your unit's command, port, state dir and link url, and what it keeps: the port (`--port` or `AUSTERE_AXI_PORT`) and `AUSTERE_AXI_LINK_URL` become the new unit's settings; other `Environment=`, `EnvironmentFile=`, `ExecStartPre=`, `ExecStartPost=`, `After=`, `Wants=`, `Requires=` lines go to `austere-axi.service.d/kept.conf`. Lists lines it drops (`Restart=always`, `Type=`, …).
- On yes: stops and disables your unit, moves it to `<name>.bak` beside it, installs and starts its own. On failure, your unit is moved back, enabled and started.
- A unit outside `~/.config/systemd/user` (in `/etc`, or linked) is not moved: disable it yourself (`systemctl --user disable --now <name>`) and rerun `server install`.
- Other units of yours (a watchdog timer, a wait script) are not touched.
- macOS: `--adopt` replaces a non-generated agent at `~/Library/LaunchAgents/xyz.kasat.austere-axi.plist`, keeping its `EnvironmentVariables`. Agents under other labels are not found.

### Behind a reverse proxy

Install with the address reviewers use, and point the proxy at the port:

```sh
austere-axi server install --link-url https://austere.example.com
```

Read the [trust model](team-review.md#trust-model) first: behind a proxy on the same machine, every request looks local.
