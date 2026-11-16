# Hub

The server starts when needed and stops after 30 idle minutes. Every review is kept in `~/.austere-axi/hub.db` (SQLite), with every page you open for review, `check` or `patch`. The hub is the home page over it, always on:

```sh
austere-axi hub open    # http://127.0.0.1:4388/, signed in: pages by project, with search
austere-axi hub list    # the same, for an agent: [words] [--project p] [--archived] [--all]
austere-axi hub notes   # every note, same for an agent: [words] [--project p] [--unanswered]
```

The home page has one section per project and one row per page. A row shows the page's path in the project, its last activity, and its unanswered and answered notes across copies; pages with unanswered notes come first, then by last activity. `/notes` lists every note, newest first, with its project and copy, and search, status and project filters.

## Projects and copies

A project is a name and a list of root folders. A page is a path inside a root, so the same file in two worktrees of one repository is one page with two copies. The row shows a chip per copy, labelled with the branch that worktree has checked out (or the folder's name), marked when it has unanswered notes; a chip opens that copy. Notes stay with their copy: each branch's file can differ.

The hub finds a page's project without git; it never runs it. Walking up from the page's folder it takes the first of:

1. a root it already knows (a folder it guessed from a page, rule 3, counts only for pages directly in it);
2. a folder with a `.git` entry: a `.git` directory is a repository; a `.git` file of a worktree joins the project of its main repository; a submodule is its own project. Inside a root you assigned (`project add`), the repository or worktree joins that root's project, and its page paths start with the repository's folder inside that root (`shop/docs/plan.html`), so two repositories there stay apart and the repository's worktrees, wherever they are, share its pages;
3. the page's own folder.

What it finds is stored, so it does not look again. Change it with `project`:

```sh
austere-axi project list                     # projects, their roots and page counts
austere-axi project add ~/work/plans --name plans   # assign a root (a folder with no .git, holding pages in subfolders)
austere-axi project merge shop shop-clone    # the second project's roots move to the first
austere-axi project rename shop storefront     # refused if another project is named storefront
austere-axi project forget-root ~/old/clone  # its pages, and the project's other roots, are filed again
```

`project add` takes in the folders it guessed below the new root, and refuses a folder inside another project's root, or around one, naming that project; `project merge` is the way to join them. `--project` (on `hub list` and `hub notes`) and the home page's project link take a name, an id, or any folder inside a root.

## What the lists leave out

- Pages only `check`ed or `patch`ed, never opened for review. `hub list --all` (or **All, with checked-only** on the home page) shows them.
- Archived pages: `austere-axi archive <file>` puts a page away, notes kept; `unarchive <file>` brings it back; `hub list --archived` shows them. A closed review is archived: `close` archives it, and a review closed in an older version (0.10.4 can still share this `hub.db`) is archived the next time `hub.db` is opened. `reopen` on a closed review brings it back, and `unarchive` on a closed review also reopens it, so a listed page is never locked. Reopening a review that was only ended leaves a page you archived where it is.
- Nothing else: a page whose file is gone stays listed, marked `missing`, with its notes. A page's title opens a copy that is still there; the chips open each copy.

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

It refuses without a terminal, so an agent or a page cannot set it up, and while a server it did not start holds the state dir (`server.lock`): run `austere-axi stop` first. On Windows it refuses the same way, and prints the steps to a terminal that runs it. Run from npx, it warns: npm may clear npx's cache, and the service would stop starting.

`--port n` sets the port the service listens on; CLI commands then find it with `AUSTERE_AXI_PORT=n`. `--link-url` sets `AUSTERE_AXI_LINK_URL` in the unit (see below). Run `server install` again to change either; it restarts the service.

A server the service runs never idles out, and a CLI never replaces it. What counts as a service is what the system says, and it is checked: the server asks systemd (or launchd) whether the unit that owns it runs the austere server, and whether that unit runs this process. A unit whose command is `npx -y austere-axi server --persist` counts too, although the server sits below the unit's main process. No variable can claim a supervisor that is not there, so a server you start by hand is an ordinary one. After upgrading austere-axi, the old server keeps running, and every CLI command says it needs a restart and how: `systemctl --user restart austere-axi.service`, or `launchctl kickstart -k gui/<uid>/xyz.kasat.austere-axi`. A command that needs a server starts the service rather than one of its own, so the two never fight over the port. `austere-axi stop` stops the server; the next command that needs one starts the service again, which is what "always on" means. `austere-axi server uninstall` takes the service away for good. A server started any other way is still replaced by a newer CLI, which starts the new one with `--persist` if the old one had it. `AUSTERE_AXI_PERSIST=1` is the same as `--persist`.

### From a unit you wrote yourself

`server install` will not overwrite a unit it did not write, and `server uninstall` leaves one alone: yours may carry settings only you know about. To move to the one this command writes:

1. read your unit and note what it carries that the new one does not — a proxy url (`AUSTERE_AXI_LINK_URL`), a `Restart=always`, a wait for the network or for Tailscale before the server starts;
2. move your unit aside (`mv ~/.config/systemd/user/austere-axi.service ~/.config/systemd/user/austere-axi.service.mine`), then `systemctl --user daemon-reload`;
3. install the new one with the settings you want to keep: `austere-axi server install --link-url https://austere.example.com`;
4. check the new unit against your old one (`systemctl --user cat austere-axi.service`), and keep the old file until you are happy.

### Behind a reverse proxy

Install the service with the address reviewers reach it at, and point the proxy at its port:

```sh
austere-axi server install --link-url https://austere.example.com
```

Read the [trust model](team-review.md) first: behind a proxy on the same machine, every request looks local.
