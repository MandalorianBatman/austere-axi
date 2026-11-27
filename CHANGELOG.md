# Changelog

Versions before 0.11.0 are listed only in the [GitHub releases](https://github.com/MandalorianBatman/austere-axi/releases).

## 0.27.0 (2026-11-27)

### Added

- **Example `backtest-report.html`** and the guide [Report pages](docs/report-pages.md): a backtest report on synthetic data (charts, KPIs, trades table, parameter form), updated by patch after the form is sent. No component or CLI change. (RLM-487)

### Changed

- A hosted page opened by a viewer signed in to an account (owner or reviewer, when the service puts `account` in the page's boot object) shows the projects sidebar, Go to page (Ctrl/Cmd+K) and the link back to the hub, with the cloud's views (Pages, Shared). Without an account, the page is as before.
- `MetricIndicatorInline(value, subtext?, trend?, better?)`: `better` (`"up"` default, or `"down"`) sets which direction is good (green) and which is bad (red). The figure in an `OverviewCardItem` is larger than its label.
- A `Button` with no variant is secondary; mark the deciding action `"primary"`. A non-primary button no longer blocks on form validation.
- Tables at 480 px and under show each row as a block of label/value lines.
- `BarChart`, `LineChart`, `AreaChart`, `ScatterChart`, `HorizontalBarChart`: one distinct hue per series; bars up to 44 px wide; scatter prints axis titles.
- `Radar`, `PolarChart`, `Quadrant` fit a phone's width at full size; labels are cut shorter there.
- `Sequence`, `Waterfall`, `Sankey` fit a phone's width (under 470 px); a waterfall prints its unit under the figure. Expand still draws the natural size.
- Expand is a slim row (36 px; 44 px on a phone).
- `RadioGroup`: the unselected ring shows on the card; a description sits under its label (also checkboxes and switches).
- `Timeline`: `done` is neutral grey.
- `Architecture`: a tag chip takes its node's tone; tags and `Radar`/`PolarChart`/`Waterfall` ticks are 11 px.
- Markdown headings: `#` 30 px, `##` 24 px, `###` 17 px (`CardHeader` title is 22 px).
- `check` warns `state-dot` when an `initial` or `final` `State` has a detail, and `node-tag` when a `Node` tag is a style word such as `"emphasis"`.
- `spec` is ~5,877 tokens (budget 5,950).

### Fixed

- Hosted review page, signed in as owner (`publish login`): notes go straight to the agent and show as sent; held teammate notes show Send/Discard (and the "held from teammates" bar), sent as `releaseNote`/`discardNote` over the page socket. Needs the service to store owner notes as `released` and accept those mutations from the owner's socket. (RLM-497)
- A multi-line double-quoted string no longer keeps `\"` and `\n` literally (e.g. in a multi-line `CodeBlock`), in `check`, `show`, the runtime and the playground.

## 0.26.0 (2026-11-25)

### Added

- `Tree(nodes, direction?)` with `TreeNode(label, parent?, detail?, tone?)`, and `OrgChart(people, direction?)` with `Person(name, role?, reportsTo?, kind?, dotted?, tone?)` (`kind`: person, team, agent, `gap`; `dotted` adds a dashed second line).
- `Nested(levels)` with `NestedLevel(label, note?, tone?)`; `LayerStack(layers, top?, bottom?)` with `Layer(name, items?, tag?, tone?)`.
  - `check` warns on a second root, depth over 4, over 5 nodes per level, over 5 direct reports, more than one `strong` node, and over 12 people, 6 levels or 6 layers.
- `ERDiagram(entities, relations, direction?)` with `Entity(name, fields?, tone?)` and `Relation(from, to, cardinality?, label?)` (crow's foot: `"1:N"`, `"N:M"`, `"0..1:1..*"`).
- `ClassDiagram(classes, links, direction?)` with `ClassBox(name, members?, kind?, tone?)` (class, interface, abstract, enum) and `ClassLink(from, to, kind?, label?, fromMultiplicity?, toMultiplicity?)` (UML's six kinds).
- `DatabaseSchema` recipe: `ERDiagram` with typed fields and the `ON DELETE` rule in the relation label.
  - `check` warns on a relation with no cardinality, over 12 fields, over 7 classes or 8 links, over 5 members per compartment, getters/setters, an association with no multiplicity.
- Boards: `Kanban(columns, cards, limits?)` with `KanbanCard(title, column, detail?, state?)` (blocked, waiting, done; WIP limit marked); `StoryMap(activities, stories, slices?, cut?)` with `Story(title, activity, slice?, detail?, risk?)`; `UserJourney(stages, steps, persona?)` with `JourneyStep(action, stage, score?, touchpoint?, pain?)`; `ServiceBlueprint(stages, steps)` with `BlueprintStep(action, stage, layer, detail?, focus?)`; `EventModel(stages, items)` with `EventItem(name, stage, kind, detail?)`.
  - `check` warns above 5 columns or 12 cards (Kanban); 5 activities, 12 stories or 3 slices (StoryMap); 6 stages (others).
- Matrices: `Heatmap(columns, rows, unit?)` with `HeatRow(label, values, focus?)`; `PermissionMatrix(roles, rows)` with `AccessRow(resource, grants, hint?, focus?)` (none, read, write, admin); `UnitGrid(parts, unit?)` with `UnitShare(name, count, detail?)`; `Traceability(requirements, items)` with `TraceReq(id, text, source?)` and `TraceItem(id, name, kind, covers)` (unlinked requirement marked as a gap).
- Time and plan: `Gantt(tasks, title?)` with `GanttTask(name, start, end?, progress?, owner?)` (same API as `austere-pack-gantt`; a page declaring that pack now draws the bundled one); `GitGraph(lanes, commits)` with `GitCommit(message, lane, branchFrom?, mergeFrom?, tag?, focus?)`; `ScheduleNetwork(tasks, unit?)` with `ScheduleTask(id, name, duration, after?)` (computes ES/EF/LS/LF, float, critical path).
- Shapes: `Quadrant(items, xAxis, yAxis, quadrants?)` with `QuadrantItem(label, x, y, focus?)`; `Venn(sets, overlaps?)` with `VennSet(name, size?, detail?)` and `VennOverlap(label, of, focus?)` (2 or 3 circles); `Pyramid(layers, shape?)` with `PyramidLayer(name, value?, detail?, focus?)` (`"funnel"` shape); `Loop(steps, hub?)` with `LoopStep(name, detail?, writes?, focus?)` and `LoopHub(name, detail?)`; `Fishbone(effect, causes)` with `FishCause(text, category, root?)`; `WardleyMap(parts)` with `WardleyPart(name, stage, visibility, needs?, evolving?)`.
- Quantities: `Radar(labels, series, max?, unit?)` with `RadarSeries(name, values, focus?)`; `PolarChart(labels, values, unit?, focus?, max?)` (missing value shows `–`); `Waterfall(labels, values, unit?, focus?, subtotal?)` (reports a total that does not add up); `Treemap(labels, values, unit?, focus?, groups?)`; `Sankey(sources, targets, values, unit?, focus?)` (reports loops and unbalanced nodes). Stock `RadarChart` and `RadialChart` stay off.
- All the above are in the bundled `diagrams` pack; every part is a click target; `components show <Name>` prints a guide and examples.
- Ten `Architecture` recipes (conventions, not components): `ArchitectureDelta`, `ITCurrentState`, `HighLevel`, `ProcessMap`, `Medallion`, `DataFlow`, `DPIntegration`, `Deployment`, `DependencyGraph`, `SBGN` (not the full notation).
- Gallery page of every diagram type: `examples/diagram-types.html`. `pr-summary` example gained a `Sequence`. Docs describe the 50 types.

### Changed

- `check`: signature errors (`type-mismatch`, `missing-required`, `null-required`, `excess-args`) end with "Run `austere-axi components show <Name>` for its signature."
- `spec` is ~5,843 tokens (budget 5,950); `--help` unchanged. The `diagrams` pack (`dist/packs/diagrams/pack.js`, ~218 KB) loads only on pages that use it.

### Fixed

- `Radar`: `check` now warns above 5 criteria (was 6).
- `Treemap`: group names are cut by character, not UTF-16 unit.
- `Sankey`: bands have a thin stroke on the dark page.
- `Venn`: labels wrap at spaces and are cut at the end with `…`.
- `ScheduleNetwork`: a duration of 1 uses the singular unit.
- Review `Send`: a note queued while Send was in progress is no longer lost.
- `UserJourney`: the score dot's accessible name is "score 4 of 5".

## 0.25.0 (2026-11-25)

### Added

- Hub shell cloud mode: `chrome/shell.js` with boot flag `mode: "cloud"` (and `account`) shows Pages (by project, plus Ungrouped), Shared, search, a People dialog (grant/revoke by email) and Sign out.
- `publish` sends optional `project` and `relPath` so hosted pages can be grouped; `SYNC_VERSION` is 2. Older pages are listed as Ungrouped.
- `austere-axi/hub-api`: types for `/hub/api`, generated by `npm run hub-api-types`.
- `Flowchart(steps, links, direction?)` with `FlowStep` (start, end, step, `decision`) and `FlowLink`; `StateMachine(states, transitions, direction?)` with `State` (`initial`, `final`) and `Transition(from, to, event, guard, action)`. `check` warns on a decision with over 3 exits or an unlabeled exit, a transition with no event, and more transitions than twice the states.

### Fixed

- `Flowchart`/`StateMachine`: unnamed parts no longer collide with statements named `_node0`/`_edge0`.

## 0.24.0 (2026-11-25)

### Added

- `Sequence(actors, messages)` with `Actor`, `Message` (call, return, async, self loop, `"emphasis"`) and `Branch` (`alt`, `opt`, `loop`). `check` warns above 5 actors or 12 messages.
- Bundled `diagrams` pack (`packs/diagrams/`): no install; loaded only by pages that use it.
- `Diagrams` component group: `Architecture`, `Node`, `Edge`, `Group` move from `Content` (signatures unchanged).
- `components list <Group>` shows each component's purpose; `components show` adds part signatures, placement, a usage guide and examples; `components search --group`, ranked by `keywords`.
- Recipes `Swimlane`, `BarComparison`, `LineTrend`, `ScatterPlot`; calling one is a `check` error naming the components to use.
- Catalogs take optional `guide`, `keywords`, `family`, `limits`, `alsoIn`.
- Coverage of diagram types: [Diagrams](docs/diagrams.md).

### Changed

- `spec` lists only core children of `Card`, `TabItem`, `AccordionItem` (~5,725 tokens).

## 0.23.0 (2026-11-25)

### Added

- `DiagramFrame` exported from `austere-axi/pack`: scroll cue, edge fades, focusable region, Expand dialog and print rules for pack diagrams. `PACK_API` stays 1. See [Writing a pack](docs/writing-a-pack.md).

### Fixed

- Printing a sideways-scrolled architecture diagram no longer keeps the edge fade.

## 0.22.0 (2026-11-24)

### Added

- Expand button on architecture diagrams: opens a full-size modal that scrolls both ways; Esc or Close returns focus. Annotate works inside it.

## 0.21.0 (2026-11-24)

### Added

- Wide architecture diagrams: edge fades and a scroll cue while part is hidden; the scroll box is focusable (←/→); print scales the diagram to the page.
- `Dockerfile` and `compose.yaml` to run `server --persist` in a container. Attach runs, triggers and tailnet review still need `server install` on the host. See [Docker](docs/docker.md).

## 0.20.0 (2026-11-23)

### Added

- Push delivery for OpenCode (1.19.5+): `ln -s "$(npm root -g)/austere-axi/dist/harness/opencode.js" ~/.config/opencode/plugins/austere-wake.js`. The plugin sets `OPENCODE_SESSION_ID`, read as the `opencode` harness, and wakes an idle session the server knows a page for.

## 0.19.0 (2026-11-23)

### Changed

- UI polish of the hub, Settings and review page: one type, radius, button and spacing scale; `rem` is 16 px on the hub; 480 px dialogs; one projects sidebar.
- Contrast and focus: primary/destructive button text fixed; field edges 3:1 or more; one 2 px accent focus ring.
- Keyboard and screen reader: notes are a bottom sheet on a phone; skip link on the hub; focus moves sensibly when a row disappears; Ctrl/Cmd+I and Ctrl/Cmd+B ignore typing; shortcut shows as ⌘K on a Mac.
- Forms and states: errors show an `Alert` with Try again; skeletons while loading; empty states name the next step; confirm dialogs name the verb; failed sends offer Retry; "Block" asks first. The notes setting reads "Hold notes for me" / "Send notes straight to the agent". Undo toast stays 10 s.
- For scripts: the notes sheet is in the DOM only while open at 860 px and narrower; the copy switcher is named "Worktree copy: <label>"; on a phone, hub views are in the tab bar.

## 0.18.0 (2026-11-23)

Breaking.

### Added

- Collapsible projects sidebar on the review page (owner only): Ctrl/Cmd+B or the header trigger toggles it; state is kept in `localStorage` (`austere:sidebar-open`), shared with the hub. Starts folded on the review page. Under 1100 px it is a sheet.
- Push delivery for omp: a note the owner sends starts the next turn of the idle omp session tied to the page. Load with `omp -e "$(npm root -g)/austere-axi/dist/harness/omp.js"` or link it into `~/.omp/agent/extensions/`. Never interrupts a running turn. New routes: `POST /api/sessions/<harness>:<id>/wake-poll` and `wake-ack`. A delivered wake cancels an attached run that has not started. See [Wake an idle session](docs/cli.md#wake-an-idle-session) and [Attach](docs/attach.md).
- Review page shows who takes a note: "Agent idle in omp · Send wakes it", "Agent busy in omp · notes wait for its turn", "Queued · agent busy", "Delivered to omp 14:02". hub.db schema 7 (`notes.seen_by`).
- Push delivery for Copilot CLI (1.0.112, experimental extensions): `ln -s "$(npm root -g)/austere-axi/dist/harness/copilot" ~/.copilot/extensions/austere-wake`, then `copilot --experimental` once.

### Changed

- **Breaking for scripts and user CSS:** the review page and hub use React, shadcn/ui and Tailwind; CSS class names changed. Use `data-*` hooks and `aria-*` roles to find controls.
  - Review page: tabs use `aria-selected`; dialogs are `role="dialog"`; the Agent panel is a popover.
  - ⋯ menu is `role="menu"` with `role="menuitem"` items (present only while open; disabled items have `data-disabled`); the quick switcher is `role="dialog"` named "Go to page" with `role="option"` rows.
  - Annotate/Explore and attach On/Off/default are toggle groups (`role="radio"`, `aria-checked`; attach items carry `data-attach`).
  - Removed classes: `.crumbs`, `.copy-switch`, `.qs*`, `.menu-pop`, `.seg*`, `.attach-state`, `.link-btn`, `.btn`, `.seg`, `.views`, `.proj-*`, `.status`, `.search-box`.
  - Each review page panel has an error boundary with Try again.
  - Settings forms validate inline and submit on Enter; feedback is a toast; confirm/prompt are dialogs.
- The `austere-setup` skill's description lists when to use it; after an update it restarts a running server.
- Docs are published at `/austere-axi/docs/` on the website.
- The skills no longer install anything. Install with `npm install -g austere-axi`, then `npx skills add MandalorianBatman/austere-axi --skill austere --skill austere-setup`. Without the CLI, the `austere` skill uses the austere MCP tools or tells the user and stops.
- The `austere` skill asks before running commands other than the CLI's own, and before acting beyond the page on a note marked `from:`.

## 0.17.0 (2026-11-22)

### Changed

- **Breaking: publishing needs an account.** `publish` (and `publish list|invites|revoke|login|rm`) and `clone` fail with `code: login_required` and `next: austere-axi cloud login` until signed in. Owner tokens are gone; the server does not sync hosted pages until you sign in. Help hides `publish`/`clone` until cloud is on and signed in. Pages published anonymously are not moved to an account: `cloud login` forgets them, and `publish` makes a new link.
- `cloud.json` records the account; `cloud login` as another account forgets its published files (`forgotten:`).
- The `austere` skill's description lists when to use it.
- `cloud login` always prints the sign-in link with the code, the bare link and the code, and says when no browser was started.

## 0.16.0 (2026-11-20)

### Changed

- **Cloud features are off by default.** Enable with `cloud on|off|status` or Settings → Cloud (stored in `<state dir>/settings.json`). Off: `publish`, `clone`, `cloud login|whoami` fail with `cloud features are off`, and nothing syncs. Existing published pages stop syncing until `austere-axi cloud on`. `cloud logout` always works.

## 0.15.0 (2026-11-20)

### Added

- `cloud login` (browser-approved code), `cloud whoami`, `cloud logout`. Signed in, you own all your hosted pages in the browser without `publish login`. Tokens are kept in `cloud.json` (0600).
- `clone` lists your hosted pages; `clone <id> [<file>]` writes one to a local file and attaches it.
- A hosted page that refuses a viewer offers **Sign in**; a reviewer granted by email gets in under their account.

### Changed

- New look for the hub and review page (bundled fonts, line icons, inbox state icons, bottom tab bar on a phone). The comment popover's button reads **Add to queue**. No command, flag, route or stored data changes.
- A service hosting pages must send `font-src data:` in the page shell's CSP. See [Sync protocol](docs/sync-protocol.md).

### Fixed

- Switching Annotate/Explore no longer re-enables the Agent panel's disabled choices; the buttons expose `aria-pressed`.
- `stop` returns once the server process has exited (fixes `database is locked`). If it does not exit within 10 s, `stop` says `status: stopping`.

## 0.14.1 (2026-11-19)

### Fixed

- A Form sends default values of `RadioGroup`, `Slider`, `CheckBoxGroup` and `SwitchGroup` even when the reviewer did not change them.

## 0.14.0 (2026-11-18)

- A unit-run server keeps the old version until `austere-axi server restart`. If `server install` ran through `npx`, rerun it with the installed CLI, then restart. hub.db migrates on open. No command or flag is removed.
- Hub URLs: `/` is the hub app; `/notes` opens its Notes view. Scripts that read the old HTML of `/` should use `/hub/api/pages`, `/hub/api/inbox` or `/hub/api/notes` (owner cookie).
- A device first opened over Tailscale is bound to that login; another login's use of its cookie is refused.
- `server lan` is off by default and never accepts the owner's sign-in.

### Added

- `trigger add|list|remove`: run a command once a project has been quiet (`quiet:2h`), once per burst; runs show in `run list --project p`, `run log`, `run stop --project p`. `add`/`remove` only at a terminal; `triggers.json` is read only from the state dir. See [Triggers](docs/cli.md#triggers).
- Hub inbox: **Needs you**, **Waiting on agent** (with **Turn agent on**), **Quiet**. A sidebar lists projects and pages with worktree chips. Views: Inbox, Pages, Notes, Runs. Search over pages and parts. **Archive** with **Undo**.
- `/hub/api/` routes: `projects`, `pages`, `inbox`, `search`, `page/<copy id>`, `notes`, `runs`, `page/<copy id>/archive|unarchive`. Owner cookie only (403 otherwise).
- Owner review header: breadcrumb to the hub, copies in other worktrees, **Ctrl+K** (⌘K) quick switcher, **Next unanswered page** in the `⋯` menu.
- Hub **Settings**: People and access, Network, Review defaults, Projects, About. Every setting has a terminal form.
- `share default [hold|auto]`; `share --hold` and `share approve --hold`.
- Tailscale identity via `tailscale whois`: access requests show verified name, login and device. `share tailscale <login> [file] [--project <p> | --all]`.
- `server lan [<address>|off]`: also listen on a local-network address (unencrypted, reviewers only; owner routes, hub and `/api/*` answer 403).

### Changed

- hub.db schema 6 (additive): `trigger_state`, `runs.trigger_id`.
- Devices record a reverse-resolved hostname or Tailscale device name instead of the `Host` header.
- `/notes` opens the hub's Notes view, with the same filters.

## 0.13.0 (2026-11-17)

### Added

- Column Cards with a titled `CardHeader` fold via a chevron. A history note inside a folded card opens it.
- History and reuse: hub.db keeps every revision with a full-text index. New commands `find`, `outline`, `show`, `history`, `restore`, `changes`, `decisions`; `patch --from <src>#<a>[,<b>…] [--rev n]`; `hub reindex`. First `open` lists `similar:` pages. Matching MCP tools. See [History and reuse](docs/cli.md#history-and-reuse).
- Review page: a changed-while-hidden bar, **History…** in the `⋯` menu, **History (n)** in the annotate popover.
- Code of conduct, issue and PR templates, [ACCESSIBILITY.md](ACCESSIBILITY.md).

### Changed

- hub.db schema 5 (additive).

### Fixed

- `publish rm <id>` accepts an id starting with `--`; other unknown flags suggest `--` before the id.
- The website footer shows the released version.

## 0.12.0 (2026-11-17)

Breaking: the review session is gone.

### Removed

- `end`, `close`, `reopen`, `open --reopen`, `poll --takeover`, `poll --owner`, `hub on|off|status`. Each exits 2 with `status: error`, `code: REMOVED` and names its replacement (`unarchive` for `reopen`, `hub open` for `hub on|off|status`, none for the rest).
- Poll statuses `ended`, `closed`, `listener_active`, `browser_disconnected`. The last batch carries `final: true`; a newer poll answers an older one with `replaced`.
- MCP: `end` tool, `open`'s `reopen`, `poll`'s `takeover`.

### Changed

- A registered page always takes notes. States: `listening`, `working`, `stale`, `idle`, `archived`. Only archive stops notes.
- Closed pages become archived when `hub.db` is opened.
- Reviewer **Done** and **Send & finish** replace Send & End; both reach the agent as `final: true`.
- One loop: `poll` for the checkout, `patch`, `reply`; `poll <file>` for one page. Owner-only help moves to `help all`.
- Pages, not sessions: `open` prints `status: registered` (or `archived`); the bare command prints `pages:`; unknown page: `this page is not registered yet`.
- A newer CLI never replaces a unit-run server (systemd user unit or launchd agent); it says to run `austere-axi server restart`. Other servers are replaced.
- `server install` checks the service manager, previews and asks, backs up a changed unit, rolls back if the unit does not answer within 15 s, and refuses a unit for another CLI or state dir unless `--force`.
- `server status` reports `running`, `starting`, `failing to start` or `stopped`, and linger. The port is found in `server.lock` or the unit; `AUSTERE_AXI_PORT` only overrides.
- Health checks no longer count as use.
- From an austere-axi checkout, the CLI uses `<checkout>/.dev/state` and its own port unless `AUSTERE_AXI_STATE_DIR` is set.
- Without git, the current folder is the guessed root (never `/`, home or temp). `open` prints `project:` and the covering `poll`.
- Project names come from `origin`; duplicates get the parent folder. Clones stay apart, with a `project merge` hint.
- `project add` refuses `/`, home, temp and folders above home; needs `--yes` to take roots or pages from other projects. `forget-root` needs `--drop` for a gone folder holding pages.
- `archive` names what it archives and what stays; `--every-copy` archives all copies.
- Team review links: claimed by one device, expire after 7 days unclaimed (`--expires`), reach one page, `--project` or `--all`. `share list` shows devices; `share revoke` closes their streams.
- Hosted pages: default service `https://austere.blundertech.com`.
- Hub: `hub open` honours `AUSTERE_AXI_NO_OPEN`; up to 3 copy chips then `+n more`. `project list --roots`.
- Presence: `Agent working (2 min)`; `stale` after 10 minutes idle (`AUSTERE_AXI_STALE_WORKING_MS`). Owner gets **Copy agent prompt** when no agent listens.

### Added

- `poll` and `feedback` without a file cover the checkout; `--project` widens to every checkout. MCP `poll` without `file` does the same.
- Poll statuses `moved` and `archived`, each with `next:`.
- Attach: `attach status|on|off|inherit`, `sessions list`, `adapter list|set`, `run list|log|stop`; MCP `sessions_list`, `run_list`, `run_log`, `attach_status`. No adapter writes until granted by `adapter set`. See [Attach](docs/attach.md).
- `server install|uninstall|status|restart` (systemd or launchd); `server install --adopt`.
- Commands say when a foreign server holds the port. The unit stops after 5 failed starts in 2 minutes; the next command after `austere-axi stop` resets it.
- `share requests on|off` (off by default) and `share approve|deny|block`. **Share…** in the page menu.
- `publish login <file>`: single-use owner sign-in link for a hosted page.
- Missing files: `archive --missing [--project p]`, `missing: true` in batches, `reply`/`archive` without the file.
- hub.db records its schema version; other-version commands open it read-only or refuse to write.
- `AUSTERE_AXI_PROJECT_REFRESH_MS`, `AUSTERE_AXI_PAGE_HOLD_MS`, `AUSTERE_AXI_STALE_WORKING_MS`.

### Fixed

- No double delivery between page and checkout/project polls; `--cursor` acknowledges only handed-over notes.
- A repository and its worktrees share one page prefix.
- A `.git` file joins a repository only when git's back-pointer agrees.
- Ended-but-not-closed pages from 0.10.4 stay listed.

## 0.11.0 (2026-11-16)

### Removed

- `hub on`, `hub off`, `hub status` (exit 2, point at `hub open`). The hub is always on at `/`.

### Changed

- Reviews closed in an older version are archived on first open of `hub.db`.

### Added

- `project list|add|merge|rename|forget-root` for projects without git.
- One page per project path, one copy per root; worktree copies share a page and keep notes per copy.
- `archive <file>`, `unarchive <file>`, `hub list --archived`. Check-only copies hidden by default.
- Hub home grouped by project, one row per page with worktree chips, unanswered first. Notes view has a project filter.
