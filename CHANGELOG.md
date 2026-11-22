# Changelog

Versions before 0.11.0 are listed only in the [GitHub releases](https://github.com/MandalorianBatman/austere-axi/releases).

## Unreleased

### Added

- **Push delivery for omp.** A note the owner sends now starts the next turn of the open omp session that wrote, edited or listened to the page, when that session is idle, with no `poll` running. Load the extension with `omp -e "$(npm root -g)/austere-axi/dist/harness/omp.js"`, or link it into `~/.omp/agent/extensions/`. It does nothing in a session the server knows no page for (one check at start), never interrupts a running turn, and wakes a session once even when two omp processes have it open. The turn names the page and the `feedback`/`patch`/`reply` commands, never the notes' text. New server routes: `POST /api/sessions/<harness>:<id>/wake-poll` and `wake-ack`. A delivered wake cancels an attached run that has not started. In omp 18.22, `deliverAs: "followUp"` does not start a turn in an idle session, so the extension sends without it. See `docs/cli.md`, "Wake an idle session", and `docs/attach.md`, "Who gets a note". (RLM-447)
- The review page says who would take a note: "Agent idle in omp · Send wakes it", "Agent busy in omp · notes wait for its turn", "Queued · agent busy" under a waiting note and "Delivered to omp 14:02" under a delivered one. "Agent not listening" shows only when nothing would take it. hub.db schema 7 adds `notes.seen_by`. (RLM-447)
- **Push delivery for Copilot CLI.** The same wake for an open, idle Copilot CLI session (1.0.112, extensions are experimental): `ln -s "$(npm root -g)/austere-axi/dist/harness/copilot" ~/.copilot/extensions/austere-wake`, then `copilot --experimental` once. It uses Copilot's extension SDK (`joinSession`, `session.send`), waits for `session.idle` before it wakes the session, and sends the turn as an automation, not as the owner. The omp and Copilot extensions share one client (`src/harness/client.ts`). (RLM-452)

### Changed

- The `austere-setup` skill's description now lists when to use it (setup, a missing `austere-axi` or `/austere` command, old Node, pages that do not open, a server still on the old version after an update, phone review, an always-on server) instead of what it does, like the `austere` skill's in 0.17.0. After an update it restarts a running server. (RLM-425)
- The guides in `docs/` are pages on the website (`/austere-axi/docs/`), with a Docs item in the nav. They are rebuilt on every push to `main`; the site build fails on a broken link or `#fragment` between them. (RLM-428)
- **The skills no longer install anything.** The `austere` skill runs the `austere-axi` command the user installed (`npm install -g austere-axi`), not `npx -y austere-axi`; without it, it uses the austere MCP tools if the agent has them, or tells the user and stops. The `austere-setup` skill checks the installed CLI, offers phone review and an always-on server, and runs the test page; it no longer installs or updates the `austere` skill or the CLI. Install both from the README or `docs/install.md`: `npm install -g austere-axi`, then `npx skills add MandalorianBatman/austere-axi --skill austere --skill austere-setup`.
- The `austere` skill runs the CLI's own subcommands from its output and asks the user before running anything else it suggests, and before acting beyond the page on a note marked `from:` (another reviewer's). With the above, this answers the skills.sh audits of the `austere` skill (Snyk E004, Gen Agent Trust Hub).

## 0.17.0 (2026-11-22)

### Changed

- **Breaking: publishing needs an account.** `publish` (and `publish list|invites|revoke|login|rm`) and `clone` refuse until this machine is signed in with `cloud login`: they fail with `code: login_required` and `next: austere-axi cloud login` before any request, and before the page is bundled. The CLI never starts the sign-in by itself. The anonymous owner token is gone: no command creates, claims or sends one, and the local server does not sync hosted pages until you sign in. `--help`, `help all`, the home view and the unknown-command list leave `publish` and `clone` out until cloud is on and the machine is signed in, and show how to sign in instead; `publish --help` still prints its flags, with a note. `cloud on` says when sign-in is the next step. The hosted service no longer issues or accepts owner tokens either (austere-cloud, RLM-434). **Pages published anonymously** (with an owner token, without an account) are not moved to an account: the service takes them down. `cloud login` forgets their entries and drops the token from `cloud.json`; `publish` on such a file makes a new link. (RLM-432, RLM-434)
- `cloud.json` records which account its published files belong to. `cloud login` as another account forgets them and says how many (`forgotten:`), so `publish` makes new links instead of failing with "the hosted page … is gone". Signing out and in again as the same account keeps them. (RLM-434)
- The `austere` skill's description now lists when to use it (plans, option comparisons, decisions, code reviews, design proposals, system walkthroughs, reports) instead of what it does, so agents pick it up for those answers without being asked. Short answers and plain code edits stay out. (RLM-425)
- `cloud login` always prints the sign-in link with the code in it, whether or not it opened a browser, so a headless or remote machine can be signed in from a phone or another computer. It also prints the bare link and the code to type in, and says when no browser was started. (RLM-431)

## 0.16.0 (2026-11-20)

### Changed

- **Cloud features are off by default.** `publish`, `clone`, `cloud login|whoami` and the local server's sync of hosted pages need the new switch: `cloud on|off|status`, or the hub's **Settings → Cloud**. Off, nothing reaches the hosted service: those commands fail with `cloud features are off` before any request, and the server opens no socket and queues nothing for hosted pages. The switch is kept in `<state dir>/settings.json`. **Upgrading with published pages:** they stop syncing until you run `austere-axi cloud on`. `cloud logout` works either way. (RLM-421)

## 0.15.0 (2026-11-20)

### Added

- Accounts on the hosted service (WorkOS AuthKit). `cloud login` signs this machine in with a code you approve in the browser (email code, Google, GitHub or passkey); `cloud whoami` and `cloud logout`. Signed in, you are the owner of all your hosted pages: `publish` and the local server's sync use the account, and the same account in the browser is the owner on every page without `publish login`. The first login hands this machine's owner token to the account, so pages published before stay yours. The CLI keeps the tokens in `cloud.json` (0600) and stores the new refresh token at every refresh. Needs austere-cloud with accounts on. (RLM-414)
- `clone` lists your hosted pages from every machine; `clone <id> [<file>]` writes one to a new local file and attaches it, so its notes sync here and `publish` updates the same link. (RLM-414)
- A hosted page that refuses a viewer (no invite, or one no longer valid) offers **Sign in** when the service has accounts: a reviewer the owner granted the page to by email gets in under their account name. (RLM-414)

### Changed

- The hub and the review page have a new look: Inter and JetBrains Mono (bundled, nothing is fetched), shared colour tokens with higher-contrast secondary text, line icons, and grouped list cards. The hub's Inbox shows each page's state as a coloured icon with one main action; Pages, Notes, Runs and Settings follow the same layout; on a phone the hub's views are a bottom tab bar. The review page has a 52px top bar, an Annotate/Explore bar above the page, and a side panel with Notes, Agent and History tabs; the queue lists numbered notes with Edit and Remove. The Go to page switcher groups pages and parts and shows each page's state. The comment popover's button reads **Add to queue**. No command, flag, route or stored data changes.
- A service that hosts pages must send `font-src data:` in the `Content-Security-Policy` of the page's shell, for the fonts bundled in the review page's stylesheet (`docs/hosted-share-links.md`). austere-cloud already does.

### Fixed

- Switching between Annotate and Explore no longer switches the Agent panel's disabled choices back on. The Annotate and Explore buttons tell a screen reader which one is on (`aria-pressed`).
- `stop` returns when the server process has exited, not when it answers the shutdown request. Before, the server still held `hub.db` for 100 ms or more after `stop` returned, so a command or script that wrote `hub.db` at once could fail with `database is locked` (seen on Windows). If the server does not exit within 10 s, `stop` says `status: stopping`.

## 0.14.1 (2026-11-19)

### Fixed

- A Form's button sends every answer. A `RadioGroup` or `Slider` with a default, or a `CheckBoxGroup` or `SwitchGroup` with a `defaultChecked` item, showed its default but stored nothing until the reviewer changed it, so an answer left as pre-selected never reached the agent. Each field now stores the default it shows, as `OptionCards` and `Chips` already did. (RLM-412)

## 0.14.0 (2026-11-18)

To upgrade: install 0.14.0. A server that `server install` (or your own unit) runs keeps serving the old version until you run `austere-axi server restart`; the CLI says so. If you ran `server install` through `npx`, the unit still points at npx's cached copy: run `austere-axi server install` again with the installed 0.14.0 CLI, then restart. hub.db migrates on open (schema 6, additive), and no command or flag is removed. Two behaviours change for existing setups:

- **Hub URLs:** `/` is now the hub app (Inbox, Pages, Notes, Runs, Settings), and `/notes` opens its Notes view with the same filters. Bookmarks keep working; a script that read the old server-rendered HTML of `/` should read the JSON routes instead, such as `/hub/api/pages`, `/hub/api/inbox` or `/hub/api/notes` (owner cookie).
- **Reviewers over Tailscale:** a device first opened over Tailscale is bound to that login. The same device cookie from another Tailscale login is refused; give that person their own link, or `share tailscale <login>`.

The new local-network listener (`server lan`) is off by default and never takes the owner's sign-in; the owner signs in on this computer or over Tailscale as before.

### Added

- Activity triggers: `trigger add|list|remove` runs a command once a project has been quiet (`quiet:2h`), once per burst of activity, as a run (`run list --project p`, `run log`, `run stop --project p`). `add` and `remove` work only at a terminal; `triggers.json` is read only from the state dir. See [Triggers](docs/cli.md#triggers). (RLM-360)
- The hub is an app with an inbox. **Needs you** first: pages the agent changed since you looked, reviewer notes waiting for you to release them, and pages whose last agent run failed. Then **Waiting on agent**, with who takes the notes (an agent listening, the attached agent, or nobody, with **Turn agent on**), then **Quiet**. A sidebar lists projects and their pages with a chip per worktree. The views are Inbox, Pages, Notes and Runs; the hub opens on the one you used last. Search finds pages and parts, and a part opens its page with that part outlined. Rows have **Archive**, with **Undo**. (RLM-355, RLM-357)
- `/hub/api/` (`projects`, `pages`, `inbox`, `search`, `page/<copy id>`, `notes`, `runs`, `page/<copy id>/archive|unarchive`) serves the hub, with the attention fields computed on the server. It answers the owner's cookie only: 403 from loopback without it, to a reviewer's device, and to another site's page. (RLM-356)
- The owner's review header has a breadcrumb back to the hub and a list of the page's copies in other worktrees. **Ctrl+K** (⌘K) opens a quick switcher over pages and parts, with recent pages first. **Next unanswered page** is in the `⋯` menu. Reviewers and hosted pages see none of it. (RLM-358)
- The hub has **Settings**, the owner's page for this local server. **People and access**: who waits for access (Approve, Deny, Block), where browsers without a link may ask, a new named link for a page, its project or every page, the links nobody has opened yet, and the devices with access (rename, change what they reach, revoke, their notes). **Network**: the addresses the server answers on, the address to share, and whether it stays on. **Review defaults**: hold new reviewers' notes for you or send them straight to the agent, and who has a page open now. **Projects**: rename, merge into the same repository's project, forget a folder, archive missing pages. **About**: version, state folder, and a note when the CLI is newer than the server. The sidebar counts the people waiting. Every setting has a terminal form; nothing on the page runs a command. (RLM-396)
- `share default [hold|auto]` sets where a new reviewer's notes go when a share or an approval does not say; `share --hold` and `share approve --hold` keep one reviewer's notes for you when the default is auto. (RLM-396)
- Over Tailscale, the server asks `tailscale whois` who is behind each connection to its Tailscale address, with the connection's own address and never a header. An access request then carries the person's Tailscale name, login and device, shown as verified; a device opened over Tailscale keeps that login, and its cookie from another login is refused. A tagged device, or `tailscale` missing or failing, is unknown. `share tailscale <login> [file] [--project <p> | --all]` (Settings → Network → Names from Tailscale) lets a login in on any of its Tailscale devices without a link. (RLM-399)
- `server lan [<address>|off]` and the switch in Settings → Network listen on one of this computer's local-network addresses as well, off by default, with a warning that its traffic is not encrypted. That listener serves reviewers only: the owner's sign-in, key link and cookie, the hub and `/api/*` answer 403 there. (RLM-399)

### Changed

- hub.db schema version 6 (additive; migrated on open): `trigger_state` and `runs.trigger_id`. (RLM-360)
- Devices record the hostname of the address they were last seen at (reverse lookup, kept when it resolves back), or their Tailscale device name, instead of the `Host` header they sent. (RLM-399)
- `/notes` opens the hub's Notes view, with the same filters. (RLM-357)

## 0.13.0 (2026-11-17)

### Added

- Review page: cards fold. A column Card that starts with a titled `CardHeader` has a chevron beside the title; it hides the rest of the card and keeps the title. Cards start open; row Cards do not fold. A note in the history that points inside a folded card opens it, and a change inside it outlines the card. A click on a folded card's title still adds a note to the card. Agents write nothing new: no prop, no prompt text. (RLM-404)
- History and reuse: hub.db keeps every revision of every page and its statements as plain text with a full-text index. New commands `find`, `outline`, `show`, `history`, `restore`, `changes` and `decisions`; `patch --from <src>#<a>[,<b>…] [--rev n]` copies statements from another page; `hub reindex` rebuilds the index. The first `open` of a page lists `similar:` pages. MCP tools of the same names. See [History and reuse](docs/cli.md#history-and-reuse). (RLM-348)
- Review page: a bar when the page changed while the tab was hidden, **History…** in the `⋯` menu, and **History (n)** in a part's annotate popover. (RLM-348)
- Community standards: code of conduct, issue and PR templates, and [ACCESSIBILITY.md](ACCESSIBILITY.md). (RLM-402)

### Changed

- hub.db schema version 5 (additive; migrated on open). (RLM-348)

### Fixed

- `publish rm <id>` takes a page id that starts with `--` (page ids are base64url) instead of reading it as a flag. Any other unknown flag after `publish rm` now says to put `--` before an id that starts with `--`. (RLM-403)
- The site redeploy after Publish waits, up to 10 minutes, until npm's `latest` is the release tag, and renders that version, so the footer no longer shows the previous version; it fails if npm never shows it. (RLM-403)

## 0.12.0 (2026-11-17)

Breaking: the review session is gone. Read [Upgrading to 0.12](docs/upgrading-to-0.12.md) before you upgrade.

### Removed

- `end`, `close`, `reopen`, `open --reopen`, `poll --takeover`, `poll --owner`, and `hub on|off|status`. Each exits 2 with `status: error`, `code: REMOVED` and names its replacement: nothing for `end` and `close` (archive a page only when the user asks), `unarchive` for `reopen`, nothing for `--takeover` and `--owner`, `hub open` for `hub on|off|status`. (RLM-338, RLM-395)
- Poll statuses `ended`, `closed`, `listener_active` and `browser_disconnected`. The reviewer's last batch now carries `final: true`; a newer poll answers the older one with `replaced`. (RLM-338)
- MCP: the `end` tool (a call answers that it was removed and to stop polling), `open`'s `reopen` argument and `poll`'s `takeover` argument. (RLM-338, RLM-395)

### Changed

- A registered page always takes notes. Its state is derived: `listening`, `working`, `stale`, `idle` or `archived`. Archive is the only lock: an archived page stops taking notes. (RLM-338, RLM-385)
- Closed pages become archived when 0.12 opens `hub.db`, on every open, so a page an older CLI closes later is archived too. (RLM-332, RLM-338)
- Reviewer: **Done** tells the agent you have no more notes without typing one; **Send & finish** sends the composer's notes as the last batch. Both reach the agent as `final: true`. They replace Send & End. (RLM-381)
- `--help`, the agent prompt, the docs and MCP teach one loop: one `poll` for the checkout, `patch`, `reply`. `poll <file>` is the one-page variant. `--help` is back under 1,100 tokens; owner-only rows move to `help all`. (RLM-380)
- Vocabulary: pages, not sessions. `open` prints `status: registered` (or `archived`), the bare command prints `pages:`, and an unknown page gets one message: `this page is not registered yet`. (RLM-392)
- A newer CLI never replaces a server that a unit runs, an older server included: a systemd user unit, or a launchd agent under any label. It leaves it serving and says to run `austere-axi server restart`. A server started any other way is still replaced, and keeps its address variables when it is from 0.12 on. (RLM-340, RLM-369, RLM-375, RLM-400)
- `server install` checks the service manager first, shows what it will write and asks, backs up a unit it changes, rolls back when its unit does not answer within 15 s, and refuses a unit that runs another CLI or state dir unless `--force`. (RLM-382)
- `server status` in plain words: `running`, `starting`, `failing to start` or `stopped`, when it starts, and linger. CLI commands find the port in `server.lock` or the installed unit, so `AUSTERE_AXI_PORT` is needed only to override. `server install` writes a `node` path that survives Node updates when one exists. (RLM-391)
- Health checks no longer count as use, so an ordinary server still idles out while something probes it. (RLM-375)
- A CLI run from a checkout of austere-axi uses `<checkout>/.dev/state` and a port of its own unless `AUSTERE_AXI_STATE_DIR` is set, so it keeps off the installed server. (RLM-376)
- Projects without git: the folder the CLI runs in is the guessed root when the file is inside it (never `/`, the home folder or the temp folder). `open` prints the page's `project:` and the `poll` that covers it. (RLM-378)
- Project names come from the repository's `origin`; equal names get the parent folder. Two clones of one repository stay apart, with a `project merge` hint. The main root is listed first. (RLM-390)
- `project add` refuses `/`, home, temp and folders above home, and asks for `--yes` before it takes roots or pages from other projects. `forget-root` says where pages went, and needs `--drop` for a gone folder that holds pages. (RLM-389)
- `archive` names the copy it archives, the copies that stay open and the unanswered notes that go with it; `--every-copy` archives them all. The review page asks the same in a dialog. (RLM-386)
- Team review: a link is claimed by one device, expires after 7 days unclaimed (`--expires`), and reaches one page, a project (`--project`) or every page (`--all`). `share list` shows devices; `share revoke` closes their streams at once. Invites in `invites.json` move into `hub.db` and keep working. (RLM-397)
- Hosted pages: the default service is `https://austere.blundertech.com`. The hosted shell no longer carries the page title. (RLM-384)
- Hub: counts and empty states match the view; plain labels; `hub open` honours `AUSTERE_AXI_NO_OPEN`. A row shows 3 copy chips, then `+n more`; long labels are shortened in the middle; focus is visible. `project list` counts roots per kind (`--roots` lists them). (RLM-387, RLM-393)
- Review page presence: `Agent working (2 min)`, and `stale` when an agent took notes and did nothing for 10 minutes (`AUSTERE_AXI_STALE_WORKING_MS`). When no agent listens, the composer says the notes wait, and the owner gets a **Copy agent prompt** button. (RLM-385)

### Added

- `poll` and `feedback` with no file cover every page of the checkout they run in; `--project` widens them to every checkout of the project. Each answers with one batch per page. MCP `poll` without `file` does the same from the server's folder. (RLM-339, RLM-377, RLM-380)
- Poll statuses `moved` (the checkout's pages joined another project; `next:` says where to poll) and `archived` (a `poll <file>` on an archived page; `next:` says to stop). (RLM-378, RLM-386)
- Attach: the owner turns an agent on for a page (the review page's Agent pill, or `attach on`), and a note the owner sends or releases starts the page's harness headless (omp or Copilot CLI) to read it, patch the page and reply. No adapter gets write permission until the owner grants it with `adapter set`. `sessions list`, `adapter list|set`, `run list|log|stop`, `attach status|on|off|inherit`; MCP `sessions_list`, `run_list`, `run_log`, `attach_status`. See [Attach](docs/attach.md). (RLM-341)
- `server install|uninstall|status|restart`: an always-on server as a per-user systemd or launchd service. `server install --adopt` takes over a unit you wrote and keeps its settings in a drop-in. (RLM-340, RLM-382, RLM-391)
- `server status` and every command say when a server the service did not start holds its port. The unit `server install` writes stops after 5 failed starts in 2 minutes; the next CLI command after `austere-axi stop` resets and starts it. (RLM-375)
- Team review: `share requests on|off`: a browser without a link asks for access from the page address, and the owner approves (`share approve|deny|block`). Off by default. **Share…** in the page menu makes a link. (RLM-397, RLM-398)
- `publish login <file>`: a single-use link that signs the owner in to a hosted page. (RLM-384)
- Missing files: a page for a missing copy, `archive --missing [--project p]`, `missing: true` on its batch, and `reply` and `archive` without the file. (RLM-388)
- hub.db records its schema version. Commands that open it without the server refuse to write, or open it read-only, while a server or command of another version holds the state dir. (RLM-376)
- `AUSTERE_AXI_PROJECT_REFRESH_MS`, `AUSTERE_AXI_PAGE_HOLD_MS` and `AUSTERE_AXI_STALE_WORKING_MS`. (RLM-339, RLM-379, RLM-385)

### Fixed

- A note is no longer delivered twice to a page poll and the checkout or project poll, and `--cursor` acknowledges only notes a poll handed over: a note `--after` skipped stays unread. `reply` without a cursor still acknowledges after a server restart. (RLM-379, RLM-377)
- A repository and its worktrees share one page prefix, whatever the order of `project merge` and `forget-root`. (RLM-368)
- A folder whose `.git` file points into a real repository joins it only when git's back-pointer agrees. (RLM-394)
- A page from 0.10.4 that was ended but not closed stays listed, and its unread note reaches the next poll. (RLM-395)

## 0.11.0 (2026-11-16)

### Removed

- `hub on`, `hub off` and `hub status`. They exit 2 and point at `hub open`: the hub is always on, and `/` serves it. (RLM-335)

### Changed

- A review closed in an older version is archived when 0.11 first opens its `hub.db`: it leaves the hub's lists. `close` itself still closes a review, and a review closed later is not archived (0.12 fixes this). (RLM-335)

### Added

- Projects without git: `project list|add|merge|rename|forget-root`. (RLM-333)
- Page identity: one page per project path, one copy per root; the same file in several worktrees shares a page and keeps its notes per copy. (RLM-334)
- `archive <file>` and `unarchive <file>`; `hub list --archived`. Check-only copies are hidden by default. (RLM-335)
- Hub home page grouped by project, one row per page with a chip per worktree copy, unanswered notes first. The notes view shows project and copy, with a project filter. (RLM-336)
