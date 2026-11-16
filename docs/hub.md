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
- Archived pages: `austere-axi archive <file>` puts a page away, notes kept; `unarchive <file>` brings it back; `hub list --archived` shows them. A closed review is archived: `close` archives it, and a review closed in an older version (0.10.4 can still share this `hub.db`) is archived the next time `hub.db` is opened. `unarchive` on a closed review also reopens it, so a listed page is never locked.
- Nothing else: a page whose file is gone stays listed, marked `missing`, with its notes. A page's title opens a copy that is still there; the chips open each copy.

## Notes

- Session files from before 0.5 (`~/.austere-axi/sessions/*.json`) are imported into `hub.db` on first start and renamed to `*.imported`. A `hub.db` from an older version gets its projects on first open.
- One server runs per state dir; a second one refuses to start. `server.lock` holds the running server's pid and port. If that server no longer answers on the port, the lock is stale and is taken over.
- `hub on`, `hub off` and `hub status` are gone: they exit 2 and point at `hub open`.

## Always on, behind a reverse proxy

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

Read the [trust model](team-review.md) first: behind a proxy on the same machine, every request looks local.
