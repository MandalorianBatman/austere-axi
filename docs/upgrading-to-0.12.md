# Upgrading to 0.12

0.12 removes the review session. A registered page always takes notes: nothing starts, ends, closes or reopens a review, and the newest `poll` wins. This page lists what changed for agents, scripts and MCP clients, and how to upgrade a server that a service runs. It covers upgrades from 0.10.x and from 0.11.x: the 0.11.0 release notes did not list its removals, so they are here too.

The full list of changes is in the [changelog](../CHANGELOG.md).

## Commands and flags

| Before | In 0.12 |
|---|---|
| `end <file>` | Nothing. Stop polling and continue in chat. |
| `close <file>` | `archive <file>`: the page leaves the hub's lists and stops taking notes. |
| `reopen <file>`, `open --reopen` | `unarchive <file>`. A page that is not archived needs nothing. |
| `poll --takeover` | Nothing. The newest poll replaces the older one by itself. |
| `poll --owner` | Nothing. No flag replaces it. |
| `hub on`, `hub off`, `hub status` (gone since 0.11.0) | Nothing. The hub has no on/off switch: `hub open` opens it, and `server install` keeps the server running (see [Always on](hub.md#always-on)). |

In 0.12 each removed command or flag exits 2 with `code: REMOVED` and one line that names its replacement. `hub on|off|status` exit 2 and point at `hub open`. In 0.13 they are unknown commands and flags. A script that ran them and expected exit 0 now fails: take the line out, or use the replacement.

`poll` with no file is new: it listens to every page of the checkout it runs in (the repository, worktree or folder that holds the current directory) and answers with `batches`, one per page. `--project <p>` widens it to every checkout of the project. `poll <file>` still listens to one page. See [Review rules](cli.md#review-rules).

## Output an agent or script reads

| 0.11 | In 0.12 |
|---|---|
| `status: ended` (the reviewer pressed Send & End, or the agent ran `end`) | The batch has `final: true`: the reviewer pressed **Done** (no items) or **Send & finish**. That page is done: apply it, reply, and stop polling that page. A note sent later waits for the next `poll`. |
| `status: ended` with `closed: true` (after `close`) | `poll <file>` on an archived page hands over the notes queued before the archive, then answers `status: archived` at once. `next:` says to stop. |
| `status: listener_active` (another poll listened on the page) | Gone. The new poll wins, and the older one returns `replaced`. |
| `status: browser_disconnected` (the review tab closed) | Gone. Closing the tab ends nothing; the poll waits for notes or for `--timeout-ms`. |
| | New: `status: moved`. The checkout's pages joined another project; `next:` says where to poll. |
| `open` printed `status: open` | `status: registered`, or `status: archived` for an archived page. |
| The bare command printed `open_sessions:` and `sessions:` | `pages:` (and `more:` when the list is cut at 12). |
| An unknown page: several messages, and the server's `no such session` | One message: `this page is not registered yet: run austere-axi <file> first`; the server says `no such page`. |

`feedback`, `replaced`, `interrupted` and `timeout` are unchanged.

## MCP server

- The `end` tool is gone.
- `open`: the `reopen` argument is gone.
- `poll`: the `takeover` argument is gone. `file` is optional: without it, `poll` covers every page of the checkout of the MCP server's working folder. `project` widens it to every checkout of a project.
- New tools, all read-only: `sessions_list`, `run_list`, `run_log` and `attach_status` (see [Attach](attach.md)). Turning attach on or off and granting permissions stay at a terminal.

## Your agent's instructions

`--help` teaches the 0.12 loop, and the shipped `austere` skill points the agent at it. Instructions you wrote yourself do not change by themselves: a `CLAUDE.md`, `AGENTS.md` or saved prompt that tells the agent to run `end`, `close`, `reopen` or `--takeover`, or to wait for `ended` or `listener_active`, now makes it hit an exit 2 or wait for a status that never comes. Change those lines by the tables above, or take **Copy agent prompt** again from the review page's `⋯` menu.

## Pages and notes

- **Closed pages become archived.** When 0.12 opens `hub.db`, every page that was closed is archived: it leaves the hub's lists (`hub list --archived` shows it) and stops taking notes. Its notes stay. To take notes on it again, run `unarchive <file>`. This runs on every open, so a page an older CLI closes later is archived too.
- **Ended pages take notes.** There is nothing to reopen.
- No note is lost in the upgrade: notes are in `hub.db`, and the server that a 0.12 CLI starts reads them.
- **hub.db moves on.** 0.12 adds tables to `hub.db` (agent sessions, runs, devices, access requests) and records its schema version. 0.11 knows nothing of them: do not go back to 0.11 on a state dir that 0.12 has opened.
- **Team review invites** in `invites.json` move into `hub.db` the first time 0.12 opens it (the file is renamed `invites.json.imported`). Each keeps working as a reusable link with no expiry. See [Team review](team-review.md).

## Hosted pages

The default service is now `https://austere.blundertech.com`. The host 0.11 defaulted to was a test host that refused pages, so `publish` from 0.11 failed unless you set `AUSTERE_AXI_CLOUD_URL`. If your `cloud.json` holds an owner token for another host, `publish` says so and stops: set `AUSTERE_AXI_CLOUD_URL` to that host to keep using it, or move `cloud.json` aside to start over on the new one. See [Hosted pages](hosted-pages.md).

## Upgrading the server

### No service runs it

Upgrade the install (`npm install -g austere-axi@0.12`, or `npx austere-axi@0.12 …`). The next command that needs the server (`open`, `poll`, `reply`, `feedback`) replaces the old one and says so on stderr: `replaced server 0.11.0 (pid N) with 0.12.0 from <path>`. The new server listens where the old one did, with `--persist` if the old one had it. A command that only reads `hub.db` (`hub list`, `project list`) refuses while the old server holds the state dir, and says so: run `austere-axi stop` first, or any command above.

An old server does not report the variables it was started with. If it ran behind a reverse proxy with `AUSTERE_AXI_LINK_URL`, `AUSTERE_AXI_LINK_HOST` or `AUSTERE_AXI_ALLOWED_HOSTS`, set them in the shell of that first command, or run `austere-axi stop` and start the server again yourself.

### Your own unit runs it

0.11 had no `server install`, so a server that runs all the time runs under a unit you wrote. Do this:

1. Upgrade the install.
2. Restart the unit before any other command: `austere-axi server restart` finds the unit that runs the server, whatever its name, and restarts it. By hand: `systemctl --user restart <your unit>`, or `launchctl kickstart -k gui/$(id -u)/<your label>`.
3. Check: `austere-axi server status` prints `server: v0.12.0, pid N, port P, run by <your unit>`.

**If a command already ran before the restart:**

- A **systemd user unit**, or a **launchd agent under any label**, that runs the austere-axi server: 0.12 finds it and leaves its server running. Every command prints `The server runs v0.11.0 under systemd and this CLI is v0.12.0; it keeps serving. Restart it to update: austere-axi server restart`. Run `austere-axi server restart`.
- **Anything else:** a system unit (`systemctl` without `--user`), a launchd agent that wraps the server in a script that neither names `austere-axi` nor `exec`s it, a Windows scheduled task. 0.12 does not find it: it stops your unit's server and starts one of its own. Your unit cannot start again while that server holds the port. Run `austere-axi stop`, then restart the unit.

To move from your unit to the one `server install` writes, run `austere-axi server install --adopt` (see [From a unit you wrote yourself](hub.md#from-a-unit-you-wrote-yourself)).

### `server install` runs it

Not possible before 0.12. From 0.12 on, a newer CLI never replaces the service's server; it tells you to run `austere-axi server restart` (see [Always on](hub.md#always-on)).
