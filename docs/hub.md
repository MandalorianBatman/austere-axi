# Hub

The server starts when needed and stops after 30 idle minutes. Every review is kept in `~/.austere-axi/hub.db` (SQLite) either way. `hub on` adds a home page over it and indexes every page you `check` or `patch`:

```sh
austere-axi hub on      # http://127.0.0.1:4388/: pages by project and day, with search
austere-axi hub list    # the same, for an agent: [words] [--project dir]
austere-axi hub notes   # every note, same for an agent: [words] [--project dir] [--unanswered]
austere-axi hub off     # back to the plain session list; the database stays
```

The home page shows which reviews are live and how much feedback the agent answered. `/notes` lists every note, newest first, with search, status and project filters.

- Session files from before 0.5 (`~/.austere-axi/sessions/*.json`) are imported into `hub.db` on first start and renamed to `*.imported`.
- One server runs per state dir; a second one refuses to start. `server.lock` holds the running server's pid and port. If that server no longer answers on the port, the lock is stale and is taken over.

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
