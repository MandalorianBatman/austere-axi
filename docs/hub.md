# Hub

The server starts when needed and stops after 30 idle minutes. Every review is kept in `~/.austere-axi/hub.db` (SQLite), with every page you open for review, `check` or `patch`. The hub is the home page over it, always on:

```sh
austere-axi hub open    # http://127.0.0.1:4388/, signed in: pages by project, with search
austere-axi hub list    # the same, for an agent: [words] [--project p] [--archived] [--all] [--limit n]
austere-axi hub notes   # every note, same for an agent: [words] [--project p] [--unanswered] [--limit n]
```

The home page has one section per project and one row per page. A row shows the page's path in the project, its last activity, and its unanswered and answered notes across copies; a quiet page shows nothing more, and a page an agent is polling for says **agent listening**. Pages with unanswered notes come first, then by last activity. The header counts the pages, projects and unanswered notes of the view shown. The views are **Open** (pages opened for review, not archived), **Everything** and **Archived**, each with its page count for the current search and project; when a view is empty, the page names the other views that are not. `/notes` lists every note, newest first, with its project and copy, and search, status and project filters.

`hub list` and `hub notes` show 40 and say `40 of 45 pages shown` when there are more; `--limit n` shows more. `hub open` starts a browser unless `AUSTERE_AXI_NO_OPEN=1` is set (a machine with no screen); then it prints the url and how to sign in.

## Projects and copies

A project is a name and a list of root folders. A page is a path inside a root, so the same file in two worktrees of one repository is one page with two copies. The row shows a chip per copy, labelled with the branch that worktree has checked out (or the folder's name), marked when it has unanswered notes; a chip opens that copy. Notes stay with their copy: each branch's file can differ.

The hub finds a page's project without git; it never runs it. Walking up from the page's folder it takes the first of:

1. a root it already knows: a root holds every folder below it, except a folder it guessed at `/`, your home folder or the temp folder, which holds only that folder;
2. a folder with a `.git` entry: a `.git` directory is a repository; a `.git` file of a worktree joins the project of its main repository; a submodule is its own project. Inside a root you assigned (`project add`), the repository or worktree joins that root's project, and its page paths start with the repository's folder inside that root (`shop/docs/plan.html`), so two repositories there stay apart and the repository's worktrees, wherever they are, share its pages;
3. a guessed folder: the folder the command ran in when the page is inside it (never `/`, your home folder or the temp folder), else the page's own folder. So `cd notes && austere-axi a/sprint.html` and `austere-axi b/plan.html` make one project, `notes`. A guessed folder takes in the folders guessed below it earlier, with their pages; a project `poll` waiting on one of those ends with `status: moved`.

A bare `poll` or `feedback` finds its project from the folder it runs in by the same rule, so it covers the pages opened from there.

What it finds is stored, so it does not look again. Change it with `project`:

```sh
austere-axi project list                     # projects, their roots and page counts
austere-axi project add ~/work/plans --name plans   # assign a root (a folder with no .git, holding pages in subfolders)
austere-axi project merge shop shop-clone    # the second project's roots move to the first
austere-axi project rename shop storefront     # refused if another project is named storefront
austere-axi project forget-root ~/old/clone  # its pages, and the project's other roots, are filed again
```

`project add` takes in the folders it guessed below the new root, and refuses a folder inside another project's root, or around one, naming that project; `project merge` is the way to join them. `--project` (on `poll`, `feedback`, `hub list` and `hub notes`) and the home page's project link take a name, an id, or any folder a root holds.

## What the lists leave out

- Pages only `check`ed or `patch`ed, never opened for review. `hub list --all` (or **Everything** on the home page) shows them.
- Archived pages: `austere-axi archive <file>` puts a page away and locks its composer, notes kept; `unarchive <file>` brings it back; `hub list --archived` shows them. A review closed in an older version (0.10.4 can still share this `hub.db`) is archived the next time `hub.db` is opened by this version, however late it was closed.
- Nothing else: a page whose file is gone stays listed, marked `missing`, with its notes. A page's title opens a copy that is still there; the chips open each copy.

## A copy whose file is gone

A row or chip marked `missing` opens a page of its own (status 410) with the file's path, the notes the copy still holds, and an **Archive this copy** button. Archiving leaves the copy out of the lists and keeps its notes. In the CLI, `archive <file>` does the same for one copy, and `archive --missing [--project p]` for every copy opened for review whose file is gone (a deleted worktree); `reply <file>` still answers its notes, and `feedback` marks its batch `missing: true`.

## Notes

- Session files from before 0.5 (`~/.austere-axi/sessions/*.json`) are imported into `hub.db` on first start and renamed to `*.imported`. A `hub.db` from an older version gets its projects on first open.
- One server runs per state dir; a second one refuses to start. `server.lock` holds the running server's pid and port. If that server no longer answers on the port, the lock is stale and is taken over.
- `hub on`, `hub off` and `hub status` are gone: they exit 2 and point at `hub open`.

## Always on

Without a service, the server a CLI command starts exits after 30 idle minutes. To keep one running for good, at a terminal:

```sh
npm install -g austere-axi      # a stable path for the service to run; npx's cache is not one
austere-axi server install      # [--port n] [--link-url https://austere.example.com]
austere-axi server status       # installed, enabled, running, which version
austere-axi server uninstall    # stop it and remove the unit
```

`server install` writes a per-user service that runs the installed CLI as `server --persist`, starts at login and restarts it when it fails:

- **Linux:** a systemd user unit, `~/.config/systemd/user/austere-axi.service`, then `systemctl --user daemon-reload` and `systemctl --user enable --now austere-axi.service`. It starts when you log in; to start it at boot, before you log in, run `loginctl enable-linger` once.
- **macOS:** a launchd agent, `~/Library/LaunchAgents/xyz.kasat.austere-axi.plist`, loaded with `launchctl bootstrap gui/<uid>`.
- **Windows:** it prints the Task Scheduler commands (`schtasks`) to do it by hand and changes nothing.

Before it writes anything it checks that the service manager answers (`systemctl --user show-environment`; on macOS `launchctl print gui/<uid>`). A shell from `su` or `sudo`, a container, or WSL without systemd has none: it then writes nothing and prints the command to run at login some other way. It refuses without a terminal, so an agent or a page cannot set it up, and while a server no service started holds the state dir (`server.lock`): run `austere-axi stop` first. On Windows it refuses the same way, and prints the steps to a terminal that runs it. Run from npx, it warns: npm may clear npx's cache, and the service would stop starting.

It shows what it will do and asks (y/N): the command the unit runs, the port, the state dir, the link url, what it keeps of the unit it replaces and what it does not. If the service then fails to start, or another server answers on its port instead of the unit's own process within 15 s, it stops the unit and puts back what was there, and says where to see why (`journalctl --user -u austere-axi.service`, or `server.log` in the state dir on macOS).

`--port n` sets the port the service listens on; CLI commands then find it with `AUSTERE_AXI_PORT=n`. `--link-url` sets `AUSTERE_AXI_LINK_URL` in the unit (see below). Run `server install` again to change either; without them it keeps the installed unit's, and it restarts the service. A re-install that changes the unit backs it up first (`austere-axi.service.bak`, then `.bak.1`; a backup is never overwritten). Lines you added to the unit (`Environment=`, `EnvironmentFile=`, `ExecStartPre=`, `ExecStartPost=`, `After=`, `Wants=`, `Requires=`) move to a drop-in, `~/.config/systemd/user/austere-axi.service.d/kept.conf`, which later installs leave alone; your own drop-ins there (`systemctl --user edit austere-axi.service`) are left alone too. Any other line you changed is not kept, and the summary names it. On macOS, extra `EnvironmentVariables` of the agent are kept in the new agent.

`server install` and `server uninstall` refuse a unit that runs another CLI or another state dir than the one they run with: a build from a checkout, which uses a state dir of its own, must not repoint or remove the owner's service. `--force` goes ahead. A unit that runs from npx's cache is not refused for its CLI: moving it to an installed CLI is what the npx warning asks for.

A server the service runs never idles out, and a CLI never replaces it. What counts as a service is what the system says, and it is checked: the server asks systemd (or launchd) whether the unit that owns it runs the austere server (a `server` command that names `austere-axi`, or the very script this server runs; another project's `cli.mjs server` is not it), and whether that unit runs this process. A unit whose command is `npx -y austere-axi server --persist` counts too, although the server sits below the unit's main process. No variable can claim a supervisor that is not there, so a server you start by hand is an ordinary one. A CLI asks the system the same question about an older server before it replaces it, so a server from before 0.12 (which does not report a supervisor) that a unit runs, your own unit included, is left alone too. After upgrading austere-axi, the old server keeps running, and every CLI command says it needs a restart and how: `systemctl --user restart <its unit>`, or `launchctl kickstart -k gui/<uid>/xyz.kasat.austere-axi`. A command that needs a server starts the service rather than one of its own. If the service does not start, the error names `systemctl --user status austere-axi.service` (or `launchctl print`) to see why, and `austere-axi server uninstall` to remove it. `austere-axi stop` stops the server; the next command that needs one starts the service again, which is what "always on" means. `austere-axi server uninstall` takes the service away for good. A server started any other way is still replaced by a newer CLI, which says so on stderr (`replaced server 0.11.0 (pid N) with 0.12.0 from <path>`) and starts the new one where the old one listened, with `--persist` if the old one had it, and with the old one's `AUSTERE_AXI_LINK_URL`, `AUSTERE_AXI_LINK_HOST` and `AUSTERE_AXI_ALLOWED_HOSTS` (a server from 0.12 on reports them; for an older one the caller's apply). `AUSTERE_AXI_PERSIST=1` is the same as `--persist`.

While such a server holds the service's port, the service cannot start. `server status` and every CLI command say so: ``the service cannot start: pid N holds port P and was not started by the service. Run `austere-axi stop`.`` The unit `server install` writes stops trying after 5 failed starts in 2 minutes (`failed` in `systemctl --user status`) instead of restarting for ever; after `austere-axi stop`, the next CLI command resets it and starts it. Health checks do not count as use, so an ordinary server still idles out while something probes it.

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
