# Review loop v2: design

Status: Approved 2026-11-16. Epic RLM-329, design issue RLM-331. L1–L15 were settled with sid.kasat on 2026-11-16. Q1–Q11 (P1–P11 in the epic) were accepted on the same day on the owner's instruction to proceed with assumptions while away. Line numbers and names below are from 0.10.4 (`e2749d6`). The build issues RLM-332 to RLM-367 follow this note; where an issue and this note differ, this note wins.

## Problem

1. A review must be started, tracked and ended, and the agent must be told to poll each time. Notes reach an agent only through a long poll per page with one listener (`/api/poll` in `src/cli/server.ts`), and a page has open, ended and closed states (`Session.status`, `SessionStore.end`, `closeReview`, `reopen` in `src/cli/sessions.ts`).
2. No event can start or wake an agent.
3. No agent acts while the owner is away.
4. There is no history and no reuse. hub.db stores notes, not page content. `revision` is a counter in memory (`onFileChange` in `server.ts`).
5. The hub shows the same page once per worktree and does not group worktrees. The page id is sha1 of the absolute path (`sessionId` in `sessions.ts`). The project is the nearest folder with a `.git` entry (`projectOf` in `src/cli/hub.ts`), and a worktree has its own `.git` file.
6. There is no navigation between the hub and a review page, and no archive.

## Decisions

### Locked (sid.kasat, 2026-11-16)

| # | Decision |
|---|---|
| L1 | Breaking CLI changes are allowed at 0.x. `end`, `close`, `reopen`, `--reopen` and `--takeover` can go. |
| L2 | Notes stay in an inbox unless the owner turns an agent on for the page. |
| L3 | Attach modes: same session, fork, new. All three are offered where the harness supports them. |
| L4 | No session discovery. The agent registers its own session. |
| L5 | No hooks. Nothing may fire in a session that does not use austere-axi. |
| L6 | Attach is set per page, with a project default. |
| L7 | A dispatched run has the session's full permissions: what the harness configuration already allows. |
| L8 | First harness adapters: omp and Copilot CLI. Others later (RLM-347). |
| L9 | "Duplicates" are the same file in several worktrees: one row per page, a chip per worktree. Notes stay per copy. |
| L10 | No git requirement. Never run the git binary; `.git` is only a hint. |
| L11 | The wiki is optional, outside the core and local-first. Later a paid cloud-only feature (RLM-249). |
| L12 | Wiki readers are people and agents. Blocks and their references live in a database. Markdown and an austere page are generated from them. |
| L13 | Wiki blocks the owner has not reviewed are shown to agents marked unreviewed. |
| L14 | Wiki files live in austere's own files, or in a folder chosen per wiki. That folder may be its own git repo; austere never runs git there. |
| L15 | No embeddings and no live includes between pages for now. |

### Settled from the proposals

Each row is: Accepted 2026-11-16 (owner away, proceed-with-assumptions instruction).

| # | Was | Decision | Issue | Status |
|---|---|---|---|---|
| Q1 | P1 | The newest listener wins. The older poll returns `replaced` and its hint says stop. No `--takeover`, no `listener_active`. | RLM-338 | Accepted 2026-11-16 (owner away, proceed-with-assumptions instruction) |
| Q2 | P2 | `browser_disconnected` is removed. A poll waits for notes or `--timeout-ms`. `armGrace` goes. | RLM-338 | Accepted 2026-11-16 (owner away, proceed-with-assumptions instruction) |
| Q3 | P3 | Attach and `publish --auto` are mutually exclusive. An unattended run with full permissions reads only text the owner sent or released. | RLM-345 | Accepted 2026-11-16 (owner away, proceed-with-assumptions instruction) |
| Q4 | P4 | Only the owner turns attach on: from the review page (owner cookie) or at a terminal. An agent can read the setting, not change it. | RLM-346 | Accepted 2026-11-16 (owner away, proceed-with-assumptions instruction) |
| Q5 | P5 | `hub on\|off\|status` is removed. The hub is always on. | RLM-335 | Accepted 2026-11-16 (owner away, proceed-with-assumptions instruction) |
| Q6 | P6 | A revision stores the full program, not a diff. Diffs are computed on read with `changedStatementIds` (`src/shared/statements.ts`). | RLM-349 | Accepted 2026-11-16 (owner away, proceed-with-assumptions instruction) |
| Q7 | P7 | Archive replaces close. `close`/`reopen` become `archive`/`unarchive`. Archived = composer locked. | RLM-335, RLM-338 | Accepted 2026-11-16 (owner away, proceed-with-assumptions instruction) |
| Q8 | P8 | The wiki's files folder is a root of the project, so core `find`, `show` and `outline` read the wiki. `project_roots.root` is unique, so a files folder is a root of one project only: the first project the wiki was set up for. A second project that shares the wiki (`project_wikis`) reads it with `find --project <first project>`, or the owner merges the two projects; `austere-wiki doctor` says so. | RLM-363 | Accepted 2026-11-16 (owner away, proceed-with-assumptions instruction) |
| Q9 | P9 | Activity triggers are generic and in the core, configured only at a terminal. | RLM-360 | Accepted 2026-11-16 (owner away, proceed-with-assumptions instruction) |
| Q10 | P10 | A wiki block is "reviewed" only by an explicit action, per block or for all. A block with an open note stays unreviewed until the owner has seen the fix. | RLM-365 | Accepted 2026-11-16 (owner away, proceed-with-assumptions instruction) |
| Q11 | P11 | The project default session is "author": the session that wrote each page. When the author session has continuations (A14), "author" means the newest session linked to the page through `parent_kind = continuation` edges, never a fork, so the default run resumes where omp actually continued. No author registered → `new` with the project's default harness. | RLM-346 | Accepted 2026-11-16 (owner away, proceed-with-assumptions instruction) |

Sid can reverse any Q row when he is back. A reversal is a change to this note first, then to the issue.

### Extra assumptions

Choices made while writing this note, where the issues are silent or ambiguous.

| # | Assumption |
|---|---|
| A1 | Before RLM-342, the Copilot CLI adapter flags (RLM-344) came from `copilot --help` and its docs, not from observed runs: `copilot` is not installed on the planning machine. The spike then ran Copilot CLI 1.0.112 through `npx -y @github/copilot@latest`. The flags in [Harness facts](#harness-facts-rlm-342) are observed. |
| A2 | The wiki package `austere-wiki` lives in its own GitHub repo, `MandalorianBatman/austere-wiki`. Nothing of it is in the austere-axi npm package. |
| A3 | PRs are per stage: one PR per top-level sub-issue of RLM-329 (RLM-332, RLM-337, RLM-341, RLM-348, RLM-355, RLM-359), bundling its child issues. The PR lists the child issues it closes. This replaces "one PR per sub-issue" in the epic rules. |
| A4 | `hub status` goes with `hub on\|off` (RLM-335 says `on\|off\|status`; RLM-331 says `on\|off`). `hub list\|notes\|open` stay. |
| A5 | A removed command or flag (`end`, `close`, `reopen`, `--reopen`, `--takeover`, `hub on\|off\|status`) exits 2 with one line naming its replacement, for one minor version (0.11.x). In 0.12 it is an unknown command. |
| A6 | The MCP server has an `end` tool and no `close` or `reopen` tool; `end` goes (`src/cli/mcp.ts`). New MCP tools exist only for commands an agent may run: `poll`, `feedback`, `patch --from`, `history`, `show`, `outline`, `changes`, `decisions`, `find`, `sessions list`, `attach status`, `run list`, `run log`. No MCP tool for `attach on\|off`, `adapter set`, `trigger add\|remove`, `server install` or `restore` (owner-only or terminal-only). |
| A7 | The owner's "last viewed" mark (RLM-352) is a column, `artifacts.last_viewed_rev`, not a table. |
| A8 | A trigger run has no page. `runs.artifact_id` is NULL for it, and `runs.project_id` names the project. The cursor a trigger last saw is stored in hub.db, `trigger_state`, not in `triggers.json`, so the terminal-only file stays the owner's to edit. |
| A9 | `artifacts.project` (the old path) stays and is still written, so a 0.10.4 CLI that opens the DB keeps working. New code reads `project_id`. |
| A10 | `hub.json` (`hubConfigFile`) is ignored after the upgrade and left on disk. Nothing reads `enabled`. |
| A11 | The release that removes the session verbs is 0.11.0. The wire format of hosted pages does not change (`src/shared/sync.ts`, no `SYNC_VERSION` bump). |
| A12 | The chip label of a worktree root reads `HEAD` as a file. Packed refs and reftables are not read; when `HEAD` names a ref, the label is the ref name with `refs/heads/` stripped and the ref is not resolved. |
| A13 | No permission-bypass flag is added by default. L7 means what the harness configuration already allows. omp print mode denies bash unless the configuration or a flag allows it (`--approval-mode always-ask` and `write` deny it, with exit 0). Copilot denies writing commands without `--allow-all`, with exit 0. The owner grants it once, at a terminal: `adapter set omp --extra-args "--approval-mode yolo"`, `adapter set copilot --extra-args "--allow-all"`. `attach status` and the attach popover warn when the adapter has no such grant and the harness is known to deny writes. `docs/attach.md` (RLM-346) says so. This differs from the spike's advice to always pass `--approval-mode yolo` and `--allow-all`. |
| A14 | omp `--resume` on a session that is open elsewhere does not fail: it continues in a new session whose header has `continuationOf`. The omp adapter always reads the session id from the first `--mode json` line. When it differs from the requested id, the registry records the new session (`agent_sessions.parent_id` = the old one) and links it to the page with role `editor`. Copilot answers `SessionInUseError` with exit 1: the run fails with `runs.reason = session_in_use`. It does not fall back to `new` (the spike's advice). The dispatcher ladder already waits while a session is alive, so this is only the race case. |
| A15 | Copilot always gets `--model` (default `auto`), because the session saves the last model and a bad one breaks later resumes. Copilot has no wall-clock flag. omp `--max-time` works, but one limit for both harnesses is simpler: the dispatcher's own 15 min timeout (kill the process tree) is the limit, and `--max-time` is not passed. `--max-cost` (omp) and `--max-ai-credits` (Copilot) are passed when set in `attach.json`. |
| A16 | omp runs get `--wait-async`, so a background job the agent starts finishes inside the run. Copilot has no equivalent: its detached jobs keep running after the run exits and wake nothing. |

## Data model

All hub.db changes are additive and live in `migrate()` in `src/cli/hub.ts`: `CREATE TABLE IF NOT EXISTS`, and `ALTER TABLE … ADD COLUMN` behind the existing `has(table, column)` check. Times are milliseconds since the epoch, as in the existing tables.

### New columns on `artifacts`

An `artifacts` row is one **copy**: a page in one root. Its id stays `sessionId(file)` (sha1 of the absolute path, 12 hex), so `/s/<id>`, `notes.artifact_id` and the keys of `cloud.json` stay valid.

| Column | Issue | Meaning |
|---|---|---|
| `project_id TEXT` | RLM-333 | `projects.id` |
| `page_id TEXT` | RLM-334 | `pages.id` |
| `root TEXT` | RLM-334 | the `project_roots.root` this copy lives in |
| `archived_at INTEGER` | RLM-335 | set by `archive`; replaces `closed_at` |
| `last_viewed_rev INTEGER` | RLM-352 | the owner's last seen `revisions.rev` (A7) |

`ended_at`, `ended_by`, `status` and `closed_at` stay in the table and are no longer written (additive rule).

### Projects and pages (RLM-333, RLM-334)

```sql
projects      (id TEXT PRIMARY KEY, name TEXT NOT NULL, created_at INTEGER NOT NULL)
project_roots (root TEXT PRIMARY KEY,               -- canonicalFile() of the folder
               project_id TEXT NOT NULL,
               kind TEXT NOT NULL,                  -- assigned | git | worktree | folder
               created_at INTEGER NOT NULL)
pages         (id TEXT PRIMARY KEY,                 -- sha1(project_id + "\0" + rel_path), 12 hex
               project_id TEXT NOT NULL,
               rel_path TEXT NOT NULL,              -- "/" separators
               UNIQUE (project_id, rel_path))
```

### Attach (RLM-343, RLM-345, RLM-346)

```sql
agent_sessions  (id TEXT PRIMARY KEY, harness TEXT NOT NULL, session_id TEXT NOT NULL,
                 session_file TEXT, cwd TEXT, model TEXT,
                 parent_id TEXT,                    -- the agent_sessions.id it continues or forks (A14)
                 parent_kind TEXT,                  -- continuation | fork; Q11 follows continuation edges only
                 pid INTEGER, pid_start TEXT,       -- for liveness: alive | exited | unknown
                 first_seen INTEGER NOT NULL, last_seen INTEGER NOT NULL,
                 UNIQUE (harness, session_id))
page_sessions   (artifact_id TEXT NOT NULL, agent_session_id TEXT NOT NULL,
                 role TEXT NOT NULL,                -- author | editor | listener
                 at INTEGER NOT NULL)
attach_settings (scope TEXT NOT NULL,               -- project | page
                 scope_id TEXT NOT NULL,
                 state TEXT NOT NULL,               -- inherit | off | on
                 mode TEXT,                         -- same | fork | new
                 session TEXT,                      -- author | agent_sessions.id
                 harness TEXT, model TEXT,
                 PRIMARY KEY (scope, scope_id))
runs            (id TEXT PRIMARY KEY,
                 kind TEXT NOT NULL,                -- note | trigger
                 artifact_id TEXT,                  -- NULL for a trigger run (A8)
                 project_id TEXT,                   -- A8
                 agent_session_id TEXT, harness TEXT, mode TEXT, model TEXT,
                 seq_from INTEGER, seq_to INTEGER,
                 started_at INTEGER, ended_at INTEGER, exit_code INTEGER,
                 status TEXT NOT NULL,              -- queued | waiting_for_session | running
                                                    -- | done | failed | stopped | interrupted
                 reason TEXT,                       -- why failed or stopped: exit | timeout | no_reply
                                                    -- | session_in_use (A14) | cost_cap | stopped
                 log_file TEXT)                     -- <state>/runs/<id>.log, 0600, ≤ 1 MB, 30 days
trigger_state   (trigger_id TEXT PRIMARY KEY,       -- A8; RLM-360
                 last_cursor INTEGER NOT NULL DEFAULT 0,
                 last_run_at INTEGER)
```

The effective attach setting of a copy: its `page` row, unless `inherit` → the `project` row → off.

Files beside hub.db, written only at a terminal and never read from a project or a page: `<state>/adapters.json` (RLM-344, extra arguments and `command` adapters), `<state>/attach.json` (RLM-345 limits), `<state>/triggers.json` (RLM-360).

### History and the content index (RLM-349, RLM-350, RLM-354)

```sql
revisions         (id INTEGER PRIMARY KEY,          -- global, monotonic: the `changes` cursor
                   artifact_id TEXT NOT NULL,
                   rev INTEGER NOT NULL,            -- per copy, from 1
                   at INTEGER NOT NULL,
                   source TEXT NOT NULL,            -- patch | file | open
                   program TEXT NOT NULL,           -- the full program (Q6)
                   program_sha TEXT NOT NULL,
                   run_id TEXT, agent_session_id TEXT,
                   seq_from INTEGER, seq_to INTEGER, -- the notes that caused it
                   UNIQUE (artifact_id, rev))
statements        (artifact_id TEXT NOT NULL, name TEXT NOT NULL, component TEXT,
                   text TEXT NOT NULL,              -- statementText() projection
                   source TEXT NOT NULL,            -- the OpenUI Lang of the statement
                   rev INTEGER NOT NULL,
                   PRIMARY KEY (artifact_id, name))  -- head revision only
statements_fts    -- FTS5 (title, name, component, text); LIKE fallback when FTS5 is missing
statement_origins (artifact_id TEXT NOT NULL, name TEXT NOT NULL,
                   src_artifact_id TEXT NOT NULL, src_name TEXT NOT NULL, src_rev INTEGER NOT NULL)
```

`statements` and `statements_fts` are rewritten inside the `recordRevision` transaction.

### wiki.db (RLM-361, package `austere-wiki`)

A separate file, `<state>/wiki.db`, mode 0600, owned by the wiki package (A2). The core never opens it.

```sql
wikis         (id, name, files_dir, export_dir)
project_wikis (project_id, wiki_id)                 -- several projects may share one wiki; its files folder is a root of the first one only (Q8)
wiki_pages    (id, wiki_id, slug, title, position)
blocks        (id,                                  -- "b" + base36: a valid statement name
               page_id, position,
               kind,                                -- heading | text | list | table
               md,
               state,                               -- unreviewed | reviewed | stale
               created_run, updated_run, updated_at)
block_refs    (block_id, artifact_id, file, statement, rev,
               kind)                                -- page | note | reply | decision
block_history (block_id, run_id, before_md, after_md, at)
wiki_runs     (id, wiki_id, started_at, ended_at, cursor_from, cursor_to,
               harness, model, status, summary)
```

## CLI before and after

`COMMANDS` and `HELP` in `src/cli/main.ts`, the MCP tools in `src/cli/mcp.ts` (1:1 with flags; A6) and `docs/cli.md` change in the same PR as each command.

| Kind | Command | Issue | Where |
|---|---|---|---|
| Removed | `end <file>` | RLM-338 | `COMMANDS.end`, route `end` in `server.ts`, `SessionStore.end`, MCP `end` |
| Removed | `close <file>` → `archive` | RLM-338 | `COMMANDS.close`, route `close`, `closeReview` in `server.ts` and `sessions.ts` |
| Removed | `reopen <file>` → `unarchive` | RLM-338 | `COMMANDS.reopen`, route `reopen`, `SessionStore.reopen` |
| Removed | `open --reopen` | RLM-338 | `body.reopen` in `server.ts` |
| Removed | `poll --takeover` | RLM-338 | `body.takeover` in the `poll` route |
| Removed | `hub on\|off\|status` | RLM-335 | `cmdHub`, `hubEnabled`, `setHubEnabled`, `homePage` |
| Changed | `poll [<file>]` | RLM-338, RLM-339 | `cmdPoll`: no file → the project of the current directory; `--project`; `replaced` and `final`; no `browser_disconnected` |
| Changed | `feedback [<file>]` | RLM-339 | `cmdFeedback`: no file → the project |
| Changed | `patch --from <src>#<a>[,<b>] [--rev n]` | RLM-354 | `cmdPatch` |
| Changed | `hub list --project <name\|id\|dir> [--archived] [--all]` | RLM-333, RLM-335 | `cmdHub`, `Hub.list` |
| Changed | `open`, `patch`, `poll`, `reply`, `feedback` print `session:` and accept `--session <harness>:<id>` | RLM-343 | `cmdOpen`, `cmdPatch`, `cmdPoll`, `cmdFeedback` |
| Changed | first `open` prints `similar:` | RLM-353 | `cmdOpen` |
| New | `project list\|add\|merge\|rename\|forget-root` | RLM-333 | new `src/cli/projects.ts` |
| New | `archive <file>`, `unarchive <file>` | RLM-335 | `main.ts`, `Hub` |
| New | `sessions list [<file>\|--project]` | RLM-343 | `main.ts` |
| New | `attach status` (anywhere; warns when the adapter has no write grant, A13), `attach on\|off` (TTY only) | RLM-346 | `main.ts` |
| New | `run list`, `run log <id>`, `run stop <file>` | RLM-345 | new `src/cli/dispatch.ts` |
| New | `adapter set <harness> --extra-args "…"` (TTY only; the owner's permission grant, A13) | RLM-344 | new `src/cli/adapters/` |
| New | `history <file> [--statement n] [--since rev]` | RLM-349 | `recordRevision` in `hub.ts` |
| New | `show <file> [statement…] [--rev n] [--text\|--source] [--deps]` | RLM-349, RLM-351 | `main.ts` |
| New | `restore <file> --rev n [statement…]` | RLM-349 | through the `cmdPatch` path |
| New | `outline <file>` | RLM-351 | `main.ts` |
| New | `changes [<file>\|--project] --since <cursor>` | RLM-351 | `main.ts` |
| New | `decisions [<file>\|--project] [--since cursor]` | RLM-351 | `main.ts` |
| New | `find <words> [--project] [--component] [--limit]` | RLM-351 | `main.ts`, `statements_fts` |
| New | `hub reindex` | RLM-350 | `cmdHub` |
| New | `trigger add\|list\|remove` (`add` TTY only) | RLM-360 | `main.ts`, `server.ts` |
| New | `server install\|uninstall\|status` | RLM-340 | `main.ts` |

The TTY rule is the one `cmdTrust` uses for `trust add` (`process.stdin.isTTY`, else `fail` with the command for the user to run).

## What each change touches

| Issue | Files and functions |
|---|---|
| RLM-333 | new `src/cli/projects.ts` (`resolveProject`); `projectOf` in `hub.ts` goes; `canonicalFile` (`src/cli/paths.ts`) for every root |
| RLM-334 | `registerWithHub` and the artifact upsert in `hub.ts`; `Hub.list` returns pages with `copies` |
| RLM-335 | `hubEnabled`, `setHubEnabled`, the early return in `registerWithHub`; the `hubEnabled()` checks in `server.ts`; `homePage`; `cmdHub`; `skills/austere-setup/SKILL.md` step 4; `docs/hub.md` |
| RLM-336 | `hubPage`, `notesPage` in `src/cli/hub-page.ts` |
| RLM-338 | `Session.status`, `endedBy`, `endedAt`, `closedAt`, `SessionStore.end`, `closeReview`, `reopen` in `sessions.ts`; routes `end`, `close`, `reopen`, the takeover branch of `poll`, `armGrace`, `closeReview` in `server.ts`; the owner menu in `src/chrome/chrome.ts` (End/Close/Reopen review → Archive/Unarchive); `src/cli/agent-prompt.ts`; `docs/cli.md` "Session rules" |
| RLM-339 | the `poll` route in `server.ts` (listener registry keyed by page, project fallback); `SessionStore.nextSeq` as the project cursor; `cmdPoll`, `cmdFeedback`; MCP `poll` |
| RLM-340 | `main.ts` (`server install`); the idle exit (`idleMs`) in `server.ts`; `docs/hub.md` "Always on" |
| RLM-343 | `cmdOpen`, `cmdPatch`, `cmdPoll`, `cmdFeedback`, `reply`; new caller detection module; `export.ts` and the `publish` payload must not carry session ids |
| RLM-344 | new `src/cli/adapters/types.ts`, `omp.ts`, `copilot.ts`, `command.ts`; argv as in [Harness facts](#harness-facts-rlm-342) |
| RLM-345 | new `src/cli/dispatch.ts`; the `send` and `release` paths of `server.ts`; route `POST /s/:id/run/stop` |
| RLM-346 | owner header in `src/chrome/chrome.ts`; new owner routes in `server.ts`; new `docs/attach.md` |
| RLM-349 | `recordRevision` in `hub.ts`; `cmdPatch`; `onFileChange` in `server.ts` (`Session.revision` seeded from the stored `rev`); `cmdOpen` and `check` |
| RLM-350 | new `src/shared/text.ts` (`statementText`, no Node APIs); `src/shared/check-program.ts` parser |
| RLM-351 | `main.ts` commands; MCP tools of the same names |
| RLM-352 | `chrome.ts` (changed control, history popover); routes `/s/:id/history`, `/s/:id/restore` |
| RLM-353 | `HELP` WORKFLOW step 0; `cmdOpen` |
| RLM-354 | `cmdPatch`; MCP `patch` `from` |
| RLM-356 | `/hub/api/*` in `server.ts` |
| RLM-357 | new shell in `src/chrome/`; `hub-page.ts` lists replaced |
| RLM-358 | review header in `chrome.ts` |
| RLM-360 | new trigger scheduler in `server.ts`; `runs` kind `trigger` |
| RLM-361–366 | `austere-wiki` repo only (A2); RLM-366 adds one paragraph to austere-axi `docs/` |

## Migration from 0.10.4

`migrate()` runs on the first open of hub.db by a 0.11 CLI or server. It runs in one transaction and a second run changes nothing.

1. Create the new tables and add the new `artifacts` columns.
2. Projects (RLM-333): for each distinct `artifacts.project`, run `resolveProject` with file reads only, create the project and its roots, and set `artifacts.project_id`. A repo and its worktree become one project with two roots.
3. Pages (RLM-334): set `artifacts.root` and `artifacts.page_id`; create the `pages` rows.
4. Archive (RLM-335, RLM-338): a set `closed_at` is copied to `archived_at`. `ended_at` and `ended_by` need nothing; an ended page is a normal page.
5. History (RLM-349): no backfill. The first `open` or `check` of each copy creates revision 1 from the file on disk.
6. Content index (RLM-350): filled as revisions are recorded; `hub reindex` fills it at once.
7. `hub.json` is ignored (A10). `sessions/*.json` were imported by 0.5.0 and are not read again.

Each issue that adds a table or column adds a 0.10.4 fixture DB to `test/` and a test that opens it. A 0.10.4 CLI that meets the migrated DB still works: no column it reads is removed (A9).

## Security

The invariants in `AGENTS.md` stay unchanged:

- The server binds to loopback, plus the Tailscale IP when Tailscale is up, never to `0.0.0.0`.
- `/api/*` answers loopback callers only, and only with the owner key, except `/api/health`. Loopback is not the owner. The key never appears on a command line, in printed output or in a cookie.
- Browser POST routes reject a foreign `Origin`. The hub and every new hub, attach, history, restore and run route are owner-only.
- Artifact files are served from the artifact's own directory only; the frame keeps `allow-same-origin` out of its sandbox (`assetToken`, `resolveSibling`).
- Nothing an installed pack ships runs in the CLI or the server.

New rules in this design:

- **Configuration that runs a command is set at a terminal only.** `attach on|off`, `adapter set`, `trigger add|remove` and `server install` refuse without a TTY, as `trust add` does. `adapters.json`, `attach.json` and `triggers.json` are read only from the state dir, never from a project or a page. Attach can also be turned on from the owner's review page (Q4); never by a reviewer or a hosted page.
- **Threat model of the TTY rule.** It stops configuration that arrives as data (a page, a project file, a note, a hosted page) and an agent's ordinary non-interactive tool call. It does not stop a process that runs as the owner and allocates a pseudo-terminal, or that writes the state dir directly. Such a process already has the owner's full permissions (L7), so no rule inside austere-axi can hold it. The design does not claim to; the TTY rule keeps a prompt-injected or careless agent from turning attach on in passing. The control an agent cannot satisfy is the owner cookie on the review page; it is the only route a remote or hosted party can reach.
- **No permission bypass by default** (A13). An adapter adds no `--approval-mode yolo`, `--allow-all` or similar flag on its own. The owner grants it at a terminal with `adapter set`, and `attach status` warns while a harness that denies writes has no grant.
- **Session ids never leave the machine.** They are absent from `publish`, `export`, hosted sync and printed links.
- **A reviewer's note never starts a run until the owner releases it.** A run starts only from a note that has a `seq` because the owner sent it or released it (RLM-345).
- **Attach and `publish --auto` are mutually exclusive** (Q3). Each refuses while the other is on.
- A run gets `AUSTERE_AXI_RUN_ID`, never the owner key: not in its argv, environment, prompt file or log. Logs and prompt files are mode 0600.
- **Prompt text never goes in argv.** Every adapter pipes the 0600 prompt file on stdin, so page and note text is not readable through `ps` or `/proc/<pid>/cmdline`.
- Page and note text is data in every prompt (dispatcher and wiki ingest), never instructions.
- Product code never runs `git` (L10). Roots and branch labels come from reading `.git` and `HEAD` as files.

## Harness facts (RLM-342)

Observed on Sid's machine on 2026-11-16, in scratch folders under `/dev/shm/spike342`. `S` is the scratch `--session-dir`; `C` is `npx -y @github/copilot@latest`. omp ran with `--model haiku` (claude-haiku-4-5). Copilot ran with `--model auto`, already signed in. The scratch sessions were deleted afterwards.

### omp 18.13.3

| Check | Command | Version | Observed | Conclusion |
|---|---|---|---|---|
| Session id in the bash tool (TUI, subagent) | `env \| grep ^PI_` | 18.13.3 | `PI_SESSION_ID=01a1e322-03e0-…`, `PI_SESSION_FILE=…/Spike342.jsonl`, `OMPCODE=1` | Both variables exist. In a subagent the file name is the agent name, not the id. |
| Session id in the bash tool (print mode) | `omp -p --model haiku --session-dir $S --approval-mode yolo --mode json 'Use bash to run: echo "$PI_SESSION_ID\|$PI_SESSION_FILE"…'` | 18.13.3 | `01a1e325-0a25-…\|$S/<ts>_01a1e325-0a25-….jsonl`, equal to the JSON header id | Print-mode tool calls see their own session id and file. |
| New: where the id appears | `omp -p --model haiku --session-dir $S --mode json "say ok"` | 18.13.3 | line 1 `{"type":"session","version":3,"id":"01a1e322-390d-…",…}`; exit 0; file `$S/<ts>_<id>.jsonl` | The id is on line 1 of `--mode json` stdout. Text mode prints no id. |
| Resume a closed session | `omp -p --model haiku --session-dir $S --resume 01a1e322-390d-… "say ok2"` | 18.13.3 | `ok2`; exit 0; the same file grew from 9 to 13 lines; no new file. An id prefix works too. | Appends to the same file. |
| Resume an unknown id | `omp -p … --resume nonexist "x"` | 18.13.3 | `Error: Session "nonexist" not found.`; exit 1 | Clean error. |
| Resume while another process has it open | in the background `omp -p --resume $ID --approval-mode yolo "…sleep 20…"`; after 6 s `omp -p --model haiku --session-dir $S --resume $ID "reply exactly: concurrent-ok"` | 18.13.3 | `Warning: Session ….jsonl is open for writing in another omp process, so this session now saves to …_01a1e322-ce00-….jsonl …`, then `concurrent-ok`; exit 0. The first process finished normally. New header: `"parentSession":"…390d…","continuationOf":"…390d…"`. A false line about an unfinished tool call came first. | No error and no interleaving: the second run silently continues in a new session. Read the id from the header (A14). |
| Fork a closed session | `omp -p --fork $ID --session-dir $S --model haiku "say ok"` | 18.13.3 | `ok`; exit 0; new file with `"parentSession":"…390d…"`; original unchanged | `--fork` works, though it is not in `omp --help`. |
| Fork while the original is open | in the background a resume with `sleep 15`; after 6 s `omp -p --model haiku --session-dir $S --fork $ID --mode json "reply fork-ok"` | 18.13.3 | line 1 `{"type":"session","id":"01a1e324-d797-…","parentSession":"01a1e322-390d-…",…}`; exit 0 | Fine. New id = line 1 `id`; `parentSession` = the source. |
| Prompt on stdin | `echo "reply exactly: stdin-ok" \| omp -p --model haiku --no-session` | 18.13.3 | `stdin-ok` | Works with `-p` and no positional prompt. |
| What is denied in print mode | `omp -p --model haiku --no-session --approval-mode always-ask "Use the bash tool to run: echo hi…"` (also `write`) | 18.13.3 | `The bash tool requires approval… tools.approvalMode is not set and bash isn't in the allowed tools list`; exit 0 in both modes | `always-ask` and `write` deny every bash call, `austere-axi patch` too. The run still exits 0 (A13). |
| Default approval | `omp -p --model haiku --no-session "Use the bash tool to run: echo hi…"`; `omp config get tools.approvalMode` | 18.13.3 | `hi`; config = `yolo` | Bash ran only because Sid's configuration is `yolo`. |
| `--max-time` | `omp -p --model haiku --no-session --approval-mode yolo --max-time 5 "Use bash to run: sleep 30…"` | 18.13.3 | `Deadline exceeded`; exit 1 | Works in print mode (not passed, A15). |
| `--max-cost` | `omp -p --model haiku --no-session --approval-mode yolo --max-cost 0.000001 "Use bash to run: echo one. Then say done."` | 18.13.3 | `Cost cap reached: this session spent $0.0071 of its $0.0000 cap …`; exit 3 | Checked between requests; the first request always goes out. Exit 3 → `reason = cost_cap`. |
| Background job, no `--wait-async` | `omp -p --model haiku --no-session --approval-mode yolo "Start a background bash job… sleep 8; echo BGDONE… reply 'woke: '…"` | 18.13.3 | `started`; exit 0 before the job finished | No wake; the process exits when the turn ends. |
| Background job, `--wait-async` | the same with `--session-dir $S --wait-async --max-time 90` | 18.13.3 | `woke: BGDONE`; exit 0 | `--wait-async` waits for jobs and wakes the session with each result (A16). With no `--max-time` it has no limit. |
| Wake a TUI with `austere-axi poll` | none | none | not run: it needs an interactive TUI and a note sent by hand | Not observed. The `--wait-async` row shows how a print session is woken. |

### Copilot CLI 1.0.112

| Check | Command | Version | Observed | Conclusion |
|---|---|---|---|---|
| Version | `$C --version` | 1.0.112 | `GitHub Copilot CLI 1.0.112.` | |
| Session id in the environment | `$C help environment` | 1.0.112 | `COPILOT_AGENT_SESSION_ID: the current session's ID, in the agent's shell commands.`; also `COPILOT_SESSION_CWD`, `COPILOT_ALLOW_ALL`, `COPILOT_DISABLE_RESUME_AUTO_CD` | The id is exposed to shell commands. |
| Session id inside a session | `$C -p 'Run the shell command: printenv COPILOT_AGENT_SESSION_ID' --resume=$N --model auto -s --allow-all` | 1.0.112 | `22222222-2222-4333-8444-555555555555` | Confirmed. The model refused prompts that dumped the environment or wrote the id to a file. |
| New with a chosen id | `$C -p "say ok" --session-id 11111111-2222-4333-8444-555555555555 --no-ask-user` | 1.0.112 | `ok`; footer `Resume  copilot --resume=11111111-…`; exit 0; `~/.copilot/session-state/<uuid>/events.jsonl` created | A UUID we choose creates the session. |
| The same `--session-id` again | `$C -p 'Run the shell command: echo hi' --session-id $ID --model auto -s` | 1.0.112 | `hi`; `events.jsonl` gained `session.resume` and a user message | The same id resumes; the transcript grows. |
| `--resume=<id>` with `--model` | `$C -p "…" --resume=$ID --allow-all -s --model gpt-5-mini` | 1.0.112 | `Execution failed: Model "gpt-5-mini" is not available.`; exit 1. The next run without `--model` failed the same way. | The session saves the model, even a failed one. Always pass `--model` (A15). |
| Fork flag | `$C --help` | 1.0.112 | no fork flag | No fork. |
| `-p "/fork"` | `$C -p '/fork' --resume=$N --model auto` | 1.0.112 | `… I can't switch sessions from this non-interactive interface, so no fork was created.`; exit 0; no new session | `/fork` is plain text to the model in `-p` mode. |
| New id without `--session-id` | `$C -p 'say ok' --model auto --output-format json` | 1.0.112 | line 1 `{"type":"session.start","data":{"sessionId":"d260d4ef-…","selectedModel":"auto",…,"alreadyInUse":false}}`; last line `{"type":"result","sessionId":"d260d4ef-…","exitCode":0,…}` | The id is `data.sessionId` on line 1, or `sessionId` on the `result` line. |
| Resume while open elsewhere | in the background `$C -p 'Run the shell command: sleep 20; echo LONG' --resume=$N --allow-all -s`; after 12 s `$C -p 'reply exactly: concurrent-ok' --resume=$N --model auto --output-format json` | 1.0.112 | `Error: Session '2222…' was found but could not be loaded. SessionInUseError: Session … is in use by another Copilot process…`; exit 1, plain text, not JSON. The background run finished. | Refused. The run fails with `session_in_use` (A14). |
| Write without `--allow-all` | `$C -p 'Run the shell command: touch made.txt' --session-id $N --model auto -s` | 1.0.112 | `both the touch command and a file-creation alternative were denied because approval wasn't available.`; exit 0; no file | Writing commands are denied, with exit 0 (A13). |
| `austere-axi patch` without `--allow-all` | `$C -p 'Run the shell command: austere-axi patch --help' --resume=$N --model auto -s` | 1.0.112 | `execution was denied because approval wasn't available.`; exit 0 | Denied, even `--help`. Needs `--allow-all` or `--allow-tool='shell(austere-axi:*)'`. |
| Read-only command without `--allow-all` | `$C -p 'Run the shell command: echo hi' --session-id $ID --model auto -s` | 1.0.112 | `hi` | Commands it judges read-only run. |
| `--no-ask-user` | `$C --help` | 1.0.112 | `Disable the ask_user tool (the agent can still ask in its replies, but not through the question form)` | No effect on permissions. Pass it so `-p` never blocks. |
| Limits | `$C --help` | 1.0.112 | `--max-ai-credits <credits>`, `--max-autopilot-continues <count>`; no time or cost flag | Pass `--max-ai-credits` when set; time is the dispatcher's timeout (A15). |
| Prompt on stdin | `echo "reply exactly: stdin-ok" \| $C -s --model auto --no-ask-user` | 1.0.112 | `stdin-ok`; exit 0 | Piped stdin works as the prompt, without `-p`. |
| Prompt on stdin, new and resume | `printf 'say ok' \| $C --session-id <uuid> --model auto --no-ask-user --output-format json`, then `printf 'say ok2' \| $C --resume=<uuid> --model auto --no-ask-user --output-format json` | 1.0.112 | both exit 0; the transcript grew from 1 to 2 user messages; `sessionId` is on the last line (`{"type":"result",…}`) in both runs, on line 1 only for the new one | The adapter uses stdin, not `-p`, and reads the id from the last line. |
| Background job wakes the session | `$C -p "Start this shell command in the background…: sleep 10; echo BGDONE > bg.txt. … reply 'started'…" --model auto --allow-all --output-format json` | 1.0.112 | `started`; exit 0 after 12 s; `bg.txt` appeared later; no second assistant message | No wake in `-p` mode, and no `--wait-async` equivalent (A16). |
| Delete saved sessions | `$C sessions --help` | 1.0.112 | only `import` | No delete command. |

### Adapter argv (RLM-344)

`<extra>` is the owner's `--extra-args` from `adapters.json` (A13), for example `--approval-mode yolo` or `--allow-all`. Nothing grants permissions by default. `[--max-cost c]` and `[--max-ai-credits n]` come from `attach.json` (A15). Every adapter reads the 0600 prompt file on stdin; no prompt text is in argv.

| Harness | Mode | argv | Session id of the run |
|---|---|---|---|
| omp | same | `omp -p --mode json --wait-async --resume <id> --model <m> [--max-cost c] <extra>` | line 1 `id`. If it differs from `<id>`, a new session with `continuationOf` (A14). |
| omp | fork | `omp -p --mode json --wait-async --fork <id> --model <m> [--max-cost c] <extra>` | line 1 `id`; `parentSession` = `<id>` |
| omp | new | `omp -p --mode json --wait-async --model <m> [--max-cost c] <extra>` | line 1 `id` |
| Copilot CLI | same | `copilot --resume=<id> --model <m or auto> --no-ask-user --output-format json [--max-ai-credits n] <extra>` | last line `sessionId`. `SessionInUseError`, exit 1 → `session_in_use` (A14). |
| Copilot CLI | fork | unavailable: no flag, and `-p "/fork"` does nothing. The popover disables it and says why. | |
| Copilot CLI | new | `copilot --session-id <uuid we mint> --model <m or auto> --no-ask-user --output-format json [--max-ai-credits n] <extra>` | the minted UUID; the last line's `sessionId` confirms it |

Caller detection (RLM-343): omp `PI_SESSION_ID` and `PI_SESSION_FILE`; Copilot CLI `COPILOT_AGENT_SESSION_ID` (no session file).

Exit codes are not enough. A denied tool call still ends with exit 0, so "no reply posted" stays a failure condition (RLM-345, `reason = no_reply`).

## Wiki: free and paid

The wiki (RLM-359) is a separate package and stays free and local: one machine, its own `wiki.db`, the ingest agent run through the owner's own harness and model, and export and import of the whole wiki as Markdown plus `wiki.json`. A paid cloud wiki (RLM-367, with RLM-249) would add what one machine cannot do: live sync between machines, team access, a model included in the price, and search across projects. It needs accounts and billing, private sync of a whole project (not only `publish`ed pages), metered model calls from the Worker, and an explicit per-project opt-in with a data-handling statement. The core stays private by default, and nothing of the wiki moves to the cloud without that opt-in.

## Build order

One PR per stage (A3). A stage starts when the stages it depends on have merged. Child issues inside a PR follow their `stage` order.

| Stage | PR | Child issues, in order | Depends on |
|---|---|---|---|
| 1 | RLM-330 docs split (PR #64) | none | none |
| 1 | RLM-331 this note | none | RLM-330 |
| 1 | RLM-332 projects and page identity | RLM-333 → RLM-334, RLM-335 → RLM-336 | RLM-331 |
| 2 | RLM-337 pages without sessions | RLM-338 → RLM-339, RLM-340 | RLM-332 |
| 3 | RLM-341 attach | RLM-342 (spike, may run from stage 1) → RLM-343, RLM-344 → RLM-345 → RLM-346. RLM-347 stays parked. | RLM-337 |
| 4 | RLM-348 history and reuse | RLM-349 → RLM-350 → RLM-351, RLM-352 → RLM-353, RLM-354 | RLM-332 (RLM-334); may run beside stage 3 |
| 5 | RLM-355 dashboard shell | RLM-356 → RLM-357 → RLM-358 | RLM-336, RLM-346, RLM-349, RLM-350 |
| 6 | RLM-359 wiki | core PR: RLM-360. `austere-wiki` repo: RLM-361 → RLM-362 → RLM-363 → RLM-364 → RLM-365 → RLM-366. RLM-367 stays parked. | RLM-345, RLM-351, RLM-352 |

Every PR runs `npm run build && npm test && npm run typecheck`; a chrome or hub UI change also runs `npm run test:browser` and screenshots at 1280 and 390 px. Each PR updates the guide in `docs/` and `HELP`/`COMMANDS` for every user-facing change it makes.

## Out of scope

Ids stamped into files, rename tracking, live includes, embeddings, cloud workspace sync, accounts and billing (RLM-249).
