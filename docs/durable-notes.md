# Durable notes: SQLite as the source of truth

Status: implemented in 0.5.0 (RLM-272). sid.kasat settled all decisions (Q1–Q21) in a grilling session on 2026-11-09. Where the implementation differs from the first draft, see [As built](#as-built).

## Problem

On a page served through a reverse proxy (`austere.kasat.xyz/s/<id>`), the reviewer could not add notes once no agent was listening. The cause is in how a review ends, not in storage:

1. When every tab is closed, `poll` returns `browser_disconnected` (`src/cli/server.js` `armGrace`). The hint for that status (`src/cli/main.js:291`) tells the agent to ask the user whether to end the review, and agents usually end it.
2. Ending locks the composer (`src/chrome/chrome.js:529-531`), and the server answers `/send` with 409.
3. Separately, the server exits after 30 minutes with no poll and no open tab, unless the hub is on (`server.js:969-974`). Behind a proxy, the page then stops working.

Two weaknesses in delivery sit underneath:

- The source of truth is memory: `SessionStore.sessions[].pending`. It is written to `sessions/<id>.json` about 150 ms later on a best-effort basis, with write errors ignored. `hub.db` (SQLite) is an optional index that is synced after that write.
- Delivery is at-most-once. Ids leave `pending` when the HTTP response finishes (`sessions.js` `markDelivered`). If an agent crashes after that, the notes are lost.

## Decisions

| # | Decision |
|---|---|
| Q1 | The target is the local server behind a proxy (`/s/`). The cursor API is the same contract the D1 service (`docs/hosted-share-links.md` on `agent/lucius/13c6d8b74f80`) uses for `GET /api/pages/:id/notes?after=`. |
| Q2 | The lockout came from the review ending. The hosted setup also needs a server that is always running (Q12). |
| Q3 | An ended review still accepts notes. Only an owner **close** locks the composer (Q17). |
| Q4 | SQLite (`hub.db`, `DatabaseSync`, WAL) is the source of truth. `/send` commits before it returns 200. Memory is a cache. The hub stops being optional. |
| Q5 | Agents still go through the server. `poll` becomes a cursor read: the server serves it from SQLite and wakes any waiting poll after an insert. The CLI never depends on the schema. |
| Q6 | Delivery is at-least-once. Notes are acknowledged when the cursor moves forward. Polling with an old cursor replays them. |
| Q7 | The cursor counts batches: each send gets one `seq`. The tables have the same shape as D1's `notes` and `replies`. |
| Q8 | The server stores `acked_seq` for each session. `poll` returns `cursor`. The next `poll` or `reply` sends the cursor back, and that is the acknowledgement. `poll --after <seq>` overrides it. The agent CLI keeps no state. |
| Q9 | A held reviewer note has `seq = NULL` until it is released. Releasing it assigns the next `seq`. A discarded note never gets one. |
| Q10 | Presence stays `listening`, `working` or `idle`, and adds `unread = count(seq > acked_seq)`. The page shows "N notes waiting for the agent". `working` runs from the moment notes are handed over until they are acknowledged. |
| Q11 | One server process per state dir, enforced by an exclusive lock that makes a second process fail loudly. Running several processes is out of scope; the D1 service covers that case. |
| Q12 | The 30-minute idle exit stays for local use. `server --persist` (or `AUSTERE_AXI_PERSIST=1`) turns it off. The README gets a sample systemd unit. Turning the hub on no longer implies "never exit". |
| Q13 | On first start, `sessions/*.json` and the old `hub.db` `items` rows are imported once, and the JSON files are renamed to `*.imported`. The 400-entry transcript cap is removed. The page loads the latest N entries and pages back for older ones. |
| Q14 | Nothing wakes an agent for notes that arrive after a review ended. They wait for the next `poll` or `feedback`, and the hub `/` list shows the unread count. A notification hook is a separate decision. |
| Q15 | `poll` keeps its `status` values and adds `cursor` and `notes: [{seq, author, items, at}]`. `interrupted` means the notes were not acknowledged, so the next poll returns them again. |
| Q16 | A `poll` on an ended session that has unread notes clears the ended state and returns `feedback`. With no unread notes it returns `ended` immediately, as it does now. It does not need `--takeover`. |
| Q17 | `end` (from the agent or the page) means the agent stopped, and the composer stays open. The new owner-only `close <file>` (also a page button) locks the composer and makes `/send` return 409. `reopen` undoes it. |
| Q18 | `feedback` stays as the catch-up read and is served from SQLite. `--peek` does not move the cursor. When no server is running, it opens `hub.db` read-only. |
| Q19 | The `browser_disconnected` timer stays. Its hint changes to "stop polling; don't `end`". Notes left later are picked up by the next `poll`. |
| Q20 | The regression tests are listed below. |
| Q21 | This doc plus one Multica issue with the ordered phases below. |

## Data model

```sql
sessions (id TEXT PK, file TEXT UNIQUE, project TEXT, title TEXT,
          created_at INT, updated_at INT,
          acked_seq INT NOT NULL DEFAULT 0,      -- Q8
          ended_at INT, ended_by TEXT,           -- agent stopped (Q17)
          closed_at INT)                         -- owner lock (Q17)
notes    (rowid INTEGER PK,
          seq INT UNIQUE,                        -- NULL while held (Q9), global and monotonic
          session_id TEXT, author TEXT, items TEXT /* JSON */,
          state TEXT,                            -- held | discarded | queued
          at INT, released_at INT)
replies  (seq INTEGER PK AUTOINCREMENT, session_id TEXT, text TEXT, at INT)
```

- `seq` is global, not per session. One counter is enough when there is a single process (Q11), and it keeps "next seq" to a single `MAX(seq)+1` inside the insert transaction.
- `unread(s) = SELECT count(*) FROM notes WHERE session_id = ? AND seq > acked_seq`.
- Per-item status for the hub Notes view (`open | received | addressed`) is derived. An item is `received` when `seq <= acked_seq`, and `addressed` when a later reply exists. If querying the JSON proves too slow, the existing `items` table stays as an index that is written in the same transaction.

## Flows

**Send** (`POST /s/:id/send`):
1. Return 409 only if `closed_at` is set.
2. In one transaction: insert into `notes`. Owner and `--auto` notes get `state = queued` and a `seq`; other reviewers' notes get `state = held` and `seq = NULL`.
3. Commit, broadcast over SSE, then wake the waiting poll if there is one.

**Poll** (`POST /api/poll {cursor?, after?}`):
1. If `cursor` is present, save `acked_seq = max(acked_seq, cursor)`. That is the acknowledgement.
2. If `after` is given, read from there instead of `acked_seq`.
3. If the session is ended:
   - with unread notes: clear `ended_at` and fall through (Q16);
   - otherwise: return `ended`.
4. If there are notes after the read point, return `{status: feedback, notes, cursor: max(seq)}` and mark the session `working`.
5. Otherwise park the poll. Insert, timeout, `replaced` and `browser_disconnected` wake it.

The server never moves `acked_seq` when a response finishes. Only the next request from the client does.

**Reply** (`POST /api/reply {cursor?, text}`): acknowledge `cursor` as in Poll step 1, then insert the reply. Notes with `seq <= cursor` count as addressed.

**Release** (`/release`): assign the next `seq` to held notes, set `state = queued`, then wake the waiting poll. **Discard** sets `state = discarded` and never assigns a `seq`.

## CLI changes

- `poll [--cursor <n>] [--after <seq>]` and `reply [--cursor <n>]`: the output adds `cursor`, and the `next:` hint prints the exact follow-up command with `--cursor <n>` filled in. The acknowledgement is explicit on purpose. If a poll *without* a cursor counted as an acknowledgement, an agent that crashed and restarted would acknowledge the notes it lost. A poll without `--cursor` therefore replays from `acked_seq`.
- `close <file>` and `reopen <file>` are owner-only.
- `server --persist` turns off the idle exit.
- `feedback [--peek]` reads from SQLite, and opens it read-only when no server is running.
- `hub on|off` keeps only the meaning "open the hub page". The database is always on.
- Hint changes in `main.js`: `browser_disconnected` becomes "stop polling, don't end; later notes are kept". `ended` adds "a new note reopens it on the next poll".

## Chrome changes

- The composer is disabled only when the review is closed: `closed || sending`.
- The presence label shows the unread count. The receipt hint becomes "waiting for the agent (N unread)".
- There is an owner-only "Close review" and "Reopen" button. The existing "end review" button stays and means "the agent stopped".
- The transcript is paged: `GET /s/:id/transcript?before=<seq>`.

## As built

These are the places where the implementation departs from the draft above.

- **Tables.** Sessions are rows of the existing `artifacts` table, which gains `ended_at`, `closed_at` and `acked_seq`; `reviewed = 1` marks a review session. Replies use the existing `replies(id, artifact_id, at, text)`. `notes` is new: `id, artifact_id, seq, state, author, items, ends, at, released_at, seen_at, work_at, done_at`. The `items` table is kept as the hub index. Its `status` column is written in the same transaction as every note change, so the hub queries did not change.
- **A reply acknowledges.** A `poll --agent-reply` or `reply` without `--cursor` acknowledges up to what the last poll handed over. A bare `poll` without a cursor still acknowledges nothing and replays. This keeps agents that follow the old loop (`poll`, edit, `poll --agent-reply`) from receiving the same feedback forever.
- **`poll` payload.** It keeps `items`, flattened with `author`, and adds `cursor`. It does not add a separate `notes` array.
- **Paging key.** `GET /s/:id/transcript?before=<entry id>` takes an entry id, not a `seq`, because replies and held notes have no `seq`.
- **`feedback` without a server** opens `hub.db` read-write, so that it can acknowledge what it reads; `--peek` writes nothing. It holds the state-dir lock while it does, so a server cannot start on the same `hub.db` meanwhile.
- **Reopen on unread (Q16).** Any note the agent has not acknowledged (`seq > acked_seq`) reopens an ended review, whenever it was written: one sent before the end, or one held then and released after it. Two exceptions: a batch the reviewer sent with end stays final, so only notes after the last such batch count; and an `--after` replay of acknowledged notes does not count. A poll answer carries `ended` only while the review is still ended by the reviewer (an end batch, **End review**, or a close), not when an agent that ended replays old notes.
- **Lock.** `server.lock` holds `{pid, port, at}`. A later process takes it over unless that port answers `/api/health` with the same pid and state dir, so a reused pid cannot block a start. A lock that names no port (`feedback` without a server) holds while its pid is alive, for at most a minute; so does a server's lock in its first minute, before it answers. An old lock with a bare pid holds while that pid is alive, because taking a lock a server still holds would put two writers on `hub.db`.
- **`seen_at`** is set when a poll answer goes out, so the page's "Seen" receipt still lights up at once. The cursor alone decides what is unread.
- **Version.** The server reports 0.5.0, so an older server that still writes JSON is replaced by the CLI on the next command.

## Migration

The first start of a version that includes this change:

1. Takes the state-dir lock, opens `hub.db` and creates the new tables.
2. For each `sessions/<id>.json`:
   - insert a session row;
   - insert each transcript entry as a note in transcript order, with these mappings:
     - `pending` → `queued` with a fresh `seq`
     - delivered → `queued`, with `seq <= acked_seq`
     - held → `held`
     - discarded → `discarded`
   - insert the replies.
3. Renames each file to `*.imported`.
4. Leaves old `items` and `replies` rows that have no JSON source as they are, and backfills them only if a test shows a gap.

The whole import runs in one transaction, and running it again does nothing.

## Regression tests (`node:test`, `test/`)

1. A note sent after the agent `end`s is accepted. The next `poll` returns it and the review is no longer ended.
2. Kill the server between `/send` and `poll`, start it again, and `poll` returns the note.
3. A poll response that is never acknowledged (the client drops it) is returned again by the next poll that has no cursor.
4. A held note released after `acked_seq` has moved past its send time is still delivered.
5. The JSON and hub import maps every state correctly, and running it a second time changes nothing.
6. `/send` returns 409 only after `close`, not after `end`. `reopen` lets it succeed again.
7. A second server on the same state dir fails because of the lock.
8. Browser test (`test/browser/review-loop.browser.test.js`): after the agent ends, the composer still sends, and the note shows as unread.

## Phases

1. SQLite as the source of truth: schema, state-dir lock, the send and release paths, the import. `SessionStore` reads through to SQLite and the JSON writes are removed.
2. Cursor `poll`, `reply` acknowledgement, `--after`, replay. The CLI output and hints change.
3. Split `end` from `close`, add `reopen`, reopen ended sessions on new notes. Update the composer gating and the unread presence label.
4. `server --persist`, a systemd unit in the README, and remove the link between the hub and the idle exit.
5. README "Session rules" and the CLI help (`main.js:48-60`, `290-294`) brought up to date.

## Out of scope

- Running several server processes (use the D1 service).
- Waking an agent when a note arrives (Q14; a separate decision).
- The hosted D1 service itself. This change only matches its cursor contract.
