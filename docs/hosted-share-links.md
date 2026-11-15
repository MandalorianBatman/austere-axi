# Hosted share links (austere-cloud): design

Status: Approved by sid.kasat. All twelve decisions (Q1–Q12) were settled with the owner on RLM-245 on 2026-11-09. Q13–Q18 (sync, access and presence) were locked on 2026-11-14 in the austere-cloud architecture review and are specified in [Sync, access and presence](#sync-access-and-presence-q13q18). Where an earlier part disagrees with Q13–Q18, Q13–Q18 win; those parts are marked **Replaced**.

## Goal

`austere-axi publish plan.html` uploads a review page and prints a link per invited reviewer. Invitees (or, on an opt-in unlisted page, anyone with the URL) can open the page and add notes. The owner's agent receives those notes through the normal `poll` and `feedback`. Every hosted page links back to austere-axi.

> **Replaced** (Q16): "prints a public URL. Anyone with the URL can open the page and add notes." Pages are invite-only by default.

Out of scope: a paid tier (teams, private pages, longer history; see RLM-249), GitHub login, page version history, and live pointers.

> **Replaced** (Q13, Q17): "live push" was out of scope. Rows and presence now arrive over a WebSocket.

## Constraints

- The CLI stays MIT and local-first. `publish` is the only command that talks to the service. Nothing contacts the service until the user runs `publish`; after that, only sessions that were published do.
- The service is a separate public MIT repo: `MandalorianBatman/austere-cloud` (Q12). Once that repo exists, this document moves to `austere-cloud/docs/design.md`, and the austere-axi README keeps a short section on the protocol.
- A hosted artifact runs exactly as sandboxed as it does in the local server: an `iframe sandbox="allow-scripts"` without `allow-same-origin`, so the frame has an opaque origin.

## Decisions

| # | Topic | Decision |
|---|---|---|
| Q1 | Hosting | Cloudflare Workers, R2 for page blobs, and D1 for pages, notes, tokens and reports. Free tier. **Replaced in part** (Q13): notes and replies live in each page's Durable Object, not D1. |
| Q2 | Domain | `https://austere.kasat.xyz`, with pages at `/p/<id>`. No separate user-content domain; the sandbox's opaque origin isolates the artifact. A brandable alias can be added later. |
| Q3 | Upload | The raw artifact plus third-party pack bundles. The service serves pinned runtime, chrome and `@austere-axi/*` packs by CLI version. Relative images are inlined as data URLs within the size cap. |
| Q4 | Republish | `publish` on the same file updates the same URL. The page id is stored in local state, keyed by absolute path. `--new` forces a fresh link. Old versions are not kept. |
| Q5 | Identity | An anonymous owner token, created on first `publish` and stored in `~/.austere-axi/cloud.json`. GitHub login comes later. |
| Q6 | Reviewers | Open link with a 128-bit unguessable id, unlisted, `noindex`. A one-time name prompt (stored in localStorage) appears before the first note. Names are self-declared. **Replaced** (Q16): invite-only by default; the reviewer's name is the invite name. The open link and the name prompt remain only for opt-in unlisted pages. |
| Q7 | Hold | Remote notes are **held** by default. `publish --auto` sends them straight to the agent. |
| Q8 | Delivery | Remote notes are synced into the local session files, so `poll`, `feedback`, `reply` and the hub keep their current code paths. |
| Q9 | Live updates | None in v1. A hosted reviewer sees new versions and replies on reload, or through a 30 s background check. **Replaced** (Q13): rows arrive live over the page's WebSocket. |
| Q10 | Limits | See [Limits](#limits). |
| Q11 | Abuse | A footer with "Made with austere-axi" and "Report". Reports go to D1 and email the admin. Takedown is an admin command. |
| Q12 | Repo | Public, MIT, `MandalorianBatman/austere-cloud`. |
| Q13–Q18 | Sync, access, presence, self-host | See [Sync, access and presence](#sync-access-and-presence-q13q18). |

## Architecture

```
austere-axi (CLI, local)                          austere-cloud (Cloudflare Worker + one Durable Object per page)
────────────────────────                          ─────────────────────────────────────────────────────────────
publish plan.html ── POST /api/pages ───────────► D1: owners, pages (index), reports, limits, blocked_ids, page_objects
                  ── PUT /api/objects/:sha256 ──► R2: objects/<sha256> (page HTML, pack JS)
                  ── publish mutation ──┐
  cloud.json (token, path → page id)    │
local server (sync peer)                │
  owner socket ═════ GET /api/pages/:id/sync ═══► PageObject (SQLite): private op log, rows, invites,
  hub.db: cached rows + cursor per page            idempotency keys; presence in socket attachments
  SSE relay of presence to the local page
reply ── addReply mutation ─────────────────────►
                                                  GET /p/:id                    chrome shell (hosted mode)
reviewer's browser ◄────────────────────────────  GET /p/:id/a/<assetToken>/    artifact, sandboxed frame
  (#i=<invite token>) ── POST /p/:id/asset-token ►
                      ═══ GET /p/:id/sync ═══════► same PageObject (addNote, rows, presence)
                                                  GET /rt/<ver>/*               pinned runtime + chrome
                                                  POST /p/:id/report
```

`═══` is a WebSocket. Before Q13 this diagram had owner REST routes for notes and replies, a 25 s long-poll and a reviewer `send`/`conversation` pair; see [Replaced routes](#replaced-routes).

### What the CLI uploads

`publish` reuses `readArtifact` and `rewriteRuntime` (see `src/cli/export.ts`):

1. Replace the runtime `<script>` tag with `<script src="/rt/<cliVersion>/austere.js"></script>`, followed by `<script src="/rt/<cliVersion>/packs/<id>.js"></script>` for each bundled `@austere-axi/*` pack the program calls (`implicitPacks`). The runtime's own fallback, `/rt/<cliVersion>/packs/<id>/pack.js` (`packSource` in `src/runtime/packs.ts`), is not on the Worker's asset allow-list, so the tag must have registered the pack first.
2. Each installed third-party pack is uploaded as an object and gets a `<script src="/pk/<sha256>.js"></script>` tag after the runtime, so it registers before the runtime looks for it (it would otherwise try the npm CDN, which the frame CSP blocks). `sha256` is the hex SHA-256 of the UTF-8 `pack.js`. A pack that is missing locally, installed at another version, or rebuilt since the page's hash was written is an error, because the hosted page can't fetch it from a CDN.
3. Relative `Image(alt, src)` paths are inlined as `data:` URLs by the same code and rules as `export` (`inlineImages` in `src/cli/export.ts`, `resolveSibling` in `src/cli/assets.ts`): only files in the page's own folder, after symlinks, no dotfiles. Where `export` leaves an unreadable image as it is with a notice, `publish` stops with an error, before any request.
4. Everything else in the file is byte-for-byte unchanged. Inlining relative images (step 3) is the one explicit exception beyond runtime tags: the hosted page has no file system to resolve them against. Otherwise this keeps the AGENTS.md rule that the served artifact equals the file except for runtime tags.

> **Replaced** (Q13): the single JSON upload body (`{ cliVersion, title, html, packs, auto, thirdPartyPacks }` to `PUT /api/pages/:id`). The page HTML and each pack are now uploaded as content-addressed objects, then named by a `publish` mutation; see [Objects and pages](#objects-and-pages-http).

The Worker checks that every `<script src>` in the page HTML points to `/rt/<cliVersion>/…` or to a `/pk/<sha>.js` the same `publish` names, recomputes each object's SHA-256, and rejects anything else.

### Pinned runtime (`/rt/<version>/…`)

The Worker proxies `https://cdn.jsdelivr.net/npm/austere-axi@<version>/dist/<asset>` and caches the result with the Cache API. Only versions at or above `MIN_CLI_VERSION` are allowed, and only an allow-listed set of asset paths (runtime, chrome JS/CSS, packs). Pages stay same-origin, and `script-src 'self'` holds. No R2 copy of the runtime is needed.

`MIN_CLI_VERSION` is the first austere-axi release that ships chrome hosted mode and `publish`. Releasing it to npm is a human step for sid.kasat.

### Hosted page

`GET /p/:id` returns the same shell the local server builds (`src/cli/server.ts`), loading `/rt/<v>/chrome/chrome.{js,css}`, with:

```js
window.__AUSTERE__ = { id, artifactUrl: "/p/<id>/a/", viewer: { role: "reviewer", name: "" }, hosted: { base: "/p/<id>", report: "/p/<id>/report", publishedAt } };
```

`artifactUrl` is a prefix: the chrome loads the frame from `${artifactUrl}<assetToken>/` (see [Access](#access-q16)).

The shell holds no page content, so it is public. `viewer.name` stays empty in the shell: the reviewer's name comes from their invite (the server's `hello`), or from the name prompt on an unlisted page.

Chrome hosted mode (an austere-axi change):

- All `/s/${SID}/…` URLs come from one `base`, which defaults to `/s/${SID}`.
- It hides owner and local-only controls: end review, close review, reopen review, Send & End, copy file path, held-note release, and the `bye` beacon. These were hidden with export and copy-link alike from RLM-265 (#29) on, when `OWNER` became `!HOSTED && role === "owner"`; RLM-322 brought the download and the page link back.
- The ⋯ menu keeps "Download standalone HTML": the chrome trades a fresh asset token, fetches the artifact, fetches each `/rt/…` and `/pk/…` script it names (all same-origin, so `connect-src 'self'` holds), and packs them in the format `export` writes (`src/shared/standalone.ts`). The result is a `blob:` download. Images are already inlined by `publish`. The menu stays open and the item reads "Preparing download…" until the file is saved or the banner says why it failed.
- Sharing follows the page, not the viewer: on an unlisted page (the page row's `unlisted`), "Copy page link" copies the URL without its fragment, for every viewer, invited or not, because the plain URL carries no invite. On an invite-only page the menu shows how the owner invites someone (`publish <file> --invite "Name"`) instead: an invite link names its reviewer and must not be passed on.
- It renders the footer: "Made with austere-axi" (links to the GitHub repo) and "Report".

> **Replaced** (Q13, Q16): "polls `GET {base}/conversation?after=<cursor>` every 30 s, and on focus, instead of opening `EventSource`" — the chrome opens the reviewer socket instead. "asks for the reviewer's name before the first send … and sends it with every batch" — only on unlisted pages; invited reviewers are named by their invite.

Headers on `/p/:id`:

```
Content-Security-Policy: default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'
X-Robots-Tag: noindex, nofollow
Referrer-Policy: no-referrer
```

`connect-src 'self'` also admits the same-origin `wss:` socket.

`GET /p/:id/a/<assetToken>/` serves the artifact with `Content-Security-Policy: sandbox allow-scripts; default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src data:; connect-src 'none'`. `font-src data:` is needed because the runtime injects Inter as a `data:font/woff2` URL. The frame cannot make network requests. Notes leave it only by `postMessage` to the chrome, which is how it already works locally (`src/runtime/index.tsx`). The path was `/p/:id/a/` before Q16.

### Data model (D1)

```sql
owners   (id TEXT PK, token_hash TEXT UNIQUE, created_at INT, blocked INT DEFAULT 0)
pages    (id TEXT PK, owner_id TEXT, title TEXT, cli_version TEXT, auto INT, bytes INT,
          created_at INT, published_at INT, expires_at INT, taken_down INT DEFAULT 0)
reports  (id INTEGER PK AUTOINCREMENT, page_id TEXT, reason TEXT, ip_hash TEXT, at INT)
limits   (key TEXT PK, window_start INT, count INT)          -- fixed-window rate limits
blocked_ids (page_id TEXT PK)                                -- takedown tombstones
page_objects (page_id TEXT, sha TEXT, PRIMARY KEY (page_id, sha)) -- object references
```

> **Replaced** (Q13): the D1 `notes` and `replies` tables. Notes, replies and invites live in the page's Durable Object (SQLite), next to its private op log. `pages` stays in D1 as the owner's index (`GET /api/pages`, retention, takedown); the page object updates it on `publish` and `delete`. `page_packs` became `page_objects`, because the page HTML is now a content-addressed object too.

Objects in R2 are content-addressed (`objects/<sha>`) and shared by every page that names the same object, so `page_objects` counts references. Whenever a page is deleted, expires or is taken down, its `page_objects` rows are removed and an object is deleted only when no row references its `sha` any more. An object no `publish` has named within 24 hours of its upload is deleted by the daily cron.

The token is 32 random bytes, base64url, and only its SHA-256 is stored. Page ids are 16 random bytes, base64url (22 characters). `ip_hash` is HMAC-SHA-256 of the IP under a Worker secret, used only for rate limits and abuse.

### API

Owner routes need `Authorization: Bearer <token>`. They return JSON and are not CORS-enabled, since the CLI calls them from Node.

| Route | Purpose |
|---|---|
| `POST /api/owners` | Creates an owner and returns `{ token }`. Rate-limited per IP. |
| `POST /api/pages` | Creates an empty page object and returns `{ id, url }`. The page is served after its first `publish` mutation. |
| `PUT /api/objects/:sha256` | Uploads one object (page HTML or pack JS); see [Objects and pages](#objects-and-pages-http). |
| `GET /api/pages` | Lists the owner's live pages, newest first: `{ pages: [{ id, title, url, expiresAt, notes }] }`. `notes` comes with the page object (RLM-268); `publish list` leaves it out until the service sends it. |
| `GET /api/pages/:id/sync` | The owner peer's WebSocket; see [WebSocket endpoints](#websocket-endpoints). |

Reviewer routes are same-origin from the hosted chrome, and a foreign `Origin` is rejected:

| Route | Purpose |
|---|---|
| `GET /p/:id`, `GET /p/:id/a/<assetToken>/` | Shell and artifact (above). Returns 404 when expired or deleted, and 410 Gone when taken down. |
| `POST /p/:id/asset-token` | Trades the invite (`X-Austere-Invite`) for a short-lived `assetToken`; see [Access](#access-q16). |
| `GET /p/:id/sync` | The reviewer chrome's WebSocket. |
| `POST /p/:id/report` | `{ reason }`. Inserts a report row and emails the admin. |

#### Replaced routes

| Route | Replaced by |
|---|---|
| `POST /api/pages` with the upload body | `POST /api/pages` (empty page) + `PUT /api/objects/:sha256` + `publish` mutation |
| `PUT /api/pages/:id` | `PUT /api/objects/:sha256` + `publish` mutation |
| `DELETE /api/pages/:id` | `delete` mutation |
| `GET /api/pages/:id/notes?after=<seq>&wait=25` (long-poll) | `pull` on the owner socket; `note` rows |
| `POST /api/pages/:id/replies` | `addReply` mutation |
| `POST /p/:id/send` | `addNote` mutation on the reviewer socket |
| `GET /p/:id/conversation?after=<cursor>` (30 s check) | `pull` on the reviewer socket; `page`, `note` and `reply` rows |

### CLI side

New state: `~/.austere-axi/cloud.json` (mode 0600)

```json
{ "url": "https://austere.kasat.xyz", "token": "…",
  "pages": { "/abs/path/plan.html": { "id": "…", "auto": false, "unlisted": false, "presence": true,
                                       "invites": { "Ana": { "token": "…", "expiresAt": null } } } } }
```

`invites` keeps each invite's token so a republish with the same `--invite` name, and `publish invites`, print the same link. Only the token's SHA-256 is ever sent. `publish invites` shows a name's link only while the service's `acl` row names this token: its `grant` equals `grantId(tokenHash)` of the saved token. A re-grant from another machine changes `grant`, so this machine then lists the name as live without a link, with a note that re-sending it from here makes this machine's link the live one again. Lost rows after a publish change nothing, since the check runs on every `publish invites`. `publish revoke` drops the name. `publish invites` and `publish revoke` work from this entry, even after the source file is moved or deleted, also through a symlinked folder (the path resolves through its nearest existing folder). Invite names are 1–40 UTF-16 units (the schema's `LIMITS.nameChars`), checked before any request.

The service URL defaults to `https://austere.kasat.xyz`, and `AUSTERE_AXI_CLOUD_URL` overrides it for tests and self-hosting. A token belongs to the `url` it was created on: when `AUSTERE_AXI_CLOUD_URL` names another service, `publish` stops with an error instead of sending the token there. Copying `cloud.json` to another machine makes that machine a peer of the same pages (Q14). It holds no [idempotency](#idempotency) `clientId`: those belong to one queue each.

A publish, in order: bundle the page (any error stops here, before a request); `POST /api/owners` on the first publish (the token is saved at once); `PUT /api/objects/:sha256` for the page HTML and each pack; `POST /api/pages` unless `cloud.json` already maps the file (or `--new`); then the owner socket, with a fresh `clientId`: the `publish` mutation (`n: 1`), one `grant` per `--invite` (`n: 2…`), their `ack`s, and `pull { after: 0 }` for the `page` row, whose `expiresAt` the command prints. `publish rm` sends `delete`, and `publish revoke` sends `revoke`, the same way; `publish invites` only pulls and reads the `acl` rows. `unlisted` is `true` only with `--unlisted` (each publish sets it); `presence` is `true` unless `--no-presence` is given (each publish sets it, like `--auto`). When the `publish` is acked but a `grant` is not, the page is still recorded, so a retry updates the same link. A republish whose handshake answers 404 points at `--new`; `rm` of a page the service no longer has still drops it from `cloud.json`. A `rate_limited` ack is reported with its `retryAfter`, not waited out, since `publish` is a one-shot command.

Commands:

```
austere-axi publish <file> [--invite <name>]... [--expires <dur>] [--unlisted] [--auto] [--no-presence] [--new]
                                              upload; prints one link per invite of this run (and on republish, "updated");
                                              the plain URL only with --unlisted
austere-axi publish invites <file>            the page's invites (live / expired / revoked), with this machine's links
austere-axi publish revoke <file> <name>      revoke one invite: its link stops working, its open pages are disconnected
austere-axi publish list                      your hosted pages, expiry, note counts
austere-axi publish rm <file|id>              delete at once
```

- `--invite` is repeatable. A name already invited from this machine keeps its token, so its link stays the same; `--expires` (`30m`, `12h`, `7d`, `2w`) applies to the invites of that run, and without it a re-sent invite keeps its expiry.
- A publish that is not `--unlisted` and has no live invites, now or from earlier, prints that nobody can open the page yet. The count comes from the `acl` rows of a finished pull (a frame without `more`); when the pull is cut off, the count is unknown and nothing is printed.

Sync into local sessions (Q8, Q14). This runs in the local server (`src/cli/peer.ts`), which `poll` already starts:

- For every page in `cloud.json`, the server opens the owner socket while it has a reason to: once on server start, while a `poll` is listening on that file's session, while the owner's review page for the file is open (presence, unless the page is `--no-presence`; see [Presence](#presence-q17)), for each `feedback` on the file (which starts the server and waits up to 5 s for the pull), and while queued mutations for the page wait for their ack. Then it closes it. Offline, it reconnects with backoff (1 s doubling to 60 s) and `poll` still works for local notes.
- hub.db caches the page's current rows (`cloud_rows`) and one cursor per page (`cloud_pages`). Each new `note` row becomes `SessionStore.addUserBatch(s, items, { author, hold, remote })`, with `entry.remote = true`, its items rebuilt with `reviewerItem`, de-duplicated by row id (`notes.remote_id`, `<pageId>/<noteId>`). `hold` is "the row is not `released`": the page object releases a note at once on an `auto` page, so the page's current mode decides, not the `auto` copy in `cloud.json`, which another machine may have changed since. The cursor is saved only after the notes are on disk, so a crash re-delivers rather than losing notes. `reply` and `acl` rows are cached, not applied: a reply sent from another machine is not added to this machine's transcript.
- The hold decision is still made locally: a peer holds a remote note until it sees the note's row in state `released`. Send, Send all and Discard on a held remote note in the local side panel send `releaseNote` / `discardNote`, so a note released on one machine arrives released on the others. A row that arrives `discarded` is recorded as discarded. On a review the owner has closed, remote notes stay held, `--auto` or not, including a `released` row for a note already held here.
- `poll` and `feedback` output adds `remote: true` next to `from: <name>`; the hub's Notes view marks the note "hosted page".
- `reply` and `poll --agent-reply` on a published file also send `addReply`. `reply` waits up to 5 s for the ack; when the reply is still queued or was refused, it prints a `warning`, and the local reply stands. Mutations made offline are queued in hub.db (`cloud_queue`; `clientId` and the next `n` in `cloud_meta`) and replayed on reconnect; idempotency keys make the replay safe. A local change (Send, Discard, a reply) and its queued mutation commit in one transaction, so a crash cannot keep one without the other. Nothing is queued for a page known to be gone.
- A handshake refused with 403, 404, 410 or 426, or a 1008 close, stops syncing that page until the server restarts, with the reason in `server.log`. A page that is gone (404, 410, deleted) drops its queued mutations. 429 waits for `Retry-After`. A socket that has not finished its pull within 30 s is dropped and retried.

> **Replaced** (Q13, Q14): "one long-poll loop against `GET /api/pages/:id/notes`", the per-page `cursor` in `cloud.json` (it moved to hub.db), "de-duplicated by `(pageId, seq)`", and "`reply` … also calls `POST /api/pages/:id/replies`".

## Sync, access and presence (Q13–Q18)

Locked by sid.kasat on RLM-245, 2026-11-14 (austere-cloud architecture review).

| # | Topic | Decision |
|---|---|---|
| Q13 | Sync model | One SQLite-backed Durable Object per page owns an op log. The log is **private to the server**. Clients send **mutations** (`publish`, `addNote`, `releaseNote`, `discardNote`, `addReply`, `grant`, `revoke`, `delete`) and pull **changed rows after a cursor** (`page`, `note`, `reply`, `acl`) over a WebSocket. This replaces the owner REST notes/replies routes and the 25 s long-poll. |
| Q14 | Local copy is a cache | hub.db stores current rows + one cursor per published page; it can be dropped and re-pulled. Any machine with the owner token is a peer (fixes multi-machine consumption). |
| Q15 | Contract | Mutation list + row schema live in one versioned schema module shared by CLI and service. Every mutation carries `v` and an idempotency key `(clientId, n)`. Unknown fields/rows are kept and skipped. Additive changes only. Compat window = last 3 CLI versions + `MIN_CLI_VERSION`. CI tests old CLIs against the new service. |
| Q16 | Access | Invite-only by default: named, revocable invites (`grant`/`revoke`), token in URL fragment `/p/:id#i=<token>`, sent by the chrome as a header; the sandboxed frame loads via a short-lived `assetToken` path. Reviewer identity = invite name. Unlisted public link is opt-in. |
| Q17 | Presence v1 | Roster chips (own chip first, ringed, named as the viewer posts; then one per other viewer: name, colour, status viewing/away/writing) + click focus (statement outline with reviewer name), for all viewers incl. owner. Messages `hello/status/focus/bye`, never stored. No live pointers in v1. Owner sees it in the local review page via local-server relay over SSE. `--no-presence` opt-out. |
| Q18 | Self-host | Stay on the standard Durable Object API, keep handlers thin and DO classes free of Cloudflare-only extras so the code stays celld/workerd-compatible. No storage abstraction layer now. |

### Schema module: `austere-axi/sync`

The protocol below is implemented once, in `src/shared/sync.ts`, and published in the npm package as **`austere-axi/sync`** (`dist/sync.mjs`, types in `types/sync.d.ts`). The CLI imports the source; austere-cloud and anything else import the package:

```ts
import { parseClientFrame, MUTATION_ROLE, SYNC_VERSION } from "austere-axi/sync";
import type { Mutation, Row } from "austere-axi/sync";
```

- It is platform-neutral ESM with no imports: it runs in Workers, browsers and Node. zod 4 is bundled inside and never appears in the API, so a zod upgrade on either side changes nothing for the other.
- `types/sync.d.ts` is the contract. The source checks itself against it at compile time (`npm run typecheck`), so the published types cannot drift from what the validators accept.
- Exports: `SYNC_VERSION`, `MIN_SYNC_VERSION`, `SUBPROTOCOL`, `LIMITS`, `ERROR_CODES`, `MUTATIONS`, `MUTATION_ROLE`, `ROW_TYPES`; `parseClientFrame` (server side), `parseServerFrame` (client side), `mutation` (builds a mutation frame at `SYNC_VERSION`), `syncProtocols` / `readProtocols` (handshake), `grantId` (the `acl` row's `grant` for a token hash); and a type for every frame, mutation, row and presence message.
- A parse returns `{ ok: true, value }` or `{ ok: false, error: { code, message }, key? }`. `key` is the mutation's `(clientId, n)` when it could be read, so the server can answer with an `ack`.

### Versioning and compatibility

- `v` is the integer protocol version (`SYNC_VERSION`, now 1). Every frame, mutation and row carries it.
- `v` below `MIN_SYNC_VERSION` is `upgrade_required`. A higher `v` is read as far as this version knows it.
- Unknown fields are kept on the parsed value and ignored. A row of an unknown `type` is kept (`skipped` on the parsed `changes` frame), not applied, and its `seq` still counts toward the cursor. A server frame of an unknown `t` is skipped (parses to `null`).
- The server rejects an unknown mutation or client frame type with `invalid`. The service always deploys before a CLI that sends something new.
- Changes are additive only: new optional fields, new mutations, new row types, new frame types, each with a `SYNC_VERSION` bump. Never remove, rename or retype a field, and never add a value to an existing set of string values (a status, a note state, an error code); add a field instead.
- `MIN_CLI_VERSION` is service configuration. The owner socket sends the CLI version (`?cli=<version>`), and the reviewer chrome's version is the page's `cliVersion`. A missing or malformed `cli`, or one below `MIN_CLI_VERSION`, gets 426 `upgrade_required`.
- Compatibility window: the service supports the last 3 published austere-axi versions and `MIN_CLI_VERSION`. austere-cloud CI runs its sync tests against each of them (installed from npm) on every change. `MIN_CLI_VERSION` moves only by a deliberate release.
- hub.db is a cache (Q14): when the `SYNC_VERSION` it was filled under differs from the CLI's, the CLI drops the cached rows and pulls from 0.

### Objects and pages (HTTP)

- `POST /api/pages` (owner) creates an empty page object and returns `{ id, url }`. `publish --new` and a first publish call it; a republish reuses the id from `cloud.json`. Until its first `publish`, the page answers reviewers with 404, and the daily cron deletes a page left unpublished for 24 hours.
- `PUT /api/objects/:sha256` (owner) uploads one object: page HTML (`Content-Type: text/html`) or pack JS (`text/javascript`), optionally `Content-Encoding: gzip`. The Worker recomputes the SHA-256 of the decoded bytes (400 when it differs), stores `objects/<sha256>` in R2 and answers 204. Uploading an existing object is a no-op. The 1 MB upload limit applies per request (413).
- The `publish` mutation then names the page HTML and its packs by SHA-256. Each must have been uploaded (else `invalid`), and the page HTML must pass the `<script src>` check in [What the CLI uploads](#what-the-cli-uploads).

### WebSocket endpoints

| Endpoint | Client | Credential |
|---|---|---|
| `GET /api/pages/:id/sync?cli=<version>` | Owner peer: the local server, and `publish` | Owner token |
| `GET /p/:id/sync` | Reviewer chrome (same origin; a foreign `Origin` is rejected) | Invite token; none on an unlisted page |

- Browsers cannot set headers on a WebSocket, and query strings end up in logs, so credentials ride in `Sec-WebSocket-Protocol`. The client offers `austere-sync.1` followed by `austere-owner.<token>` or `austere-invite.<token>` (`syncProtocols`); the server reads them with `readProtocols` and answers `Sec-WebSocket-Protocol: austere-sync.1`, never echoing a credential.
- A handshake that fails is a plain HTTP response with `{ "error": { "code", "message" } }`: 403 `forbidden` (missing, wrong, revoked or expired credential), 404 (unknown, unpublished, expired or deleted page), 410 (taken down), 426 `upgrade_required` (no `austere-sync.1` offered, or CLI version missing or below `MIN_CLI_VERSION`), 429 `rate_limited`. A client retries 429 after `Retry-After` and does not retry 403, 404, 410 or 426 on its own: the CLI stops syncing that page and reports why; the chrome shows the reason.
- Frames are JSON text frames, one message each. A client frame is at most 64 KiB (`LIMITS.frameBytes`).
- The page object uses WebSocket hibernation and keeps each socket's identity (role, invite name, viewer id, presence) in the socket attachment.

### Frames

Every frame is `{ "v": 1, "t": "<type>", … }`.

| Direction | `t` | Fields |
|---|---|---|
| client → server | `mutation` | `clientId`, `n`, `name`, `args` |
| client → server | `pull` | `after` (cursor; 0 = everything) |
| client → server | `hello`, `status`, `focus`, `bye` | presence, see [Presence](#presence-q17) |
| server → client | `ack` | `clientId`, `n`, `error?` |
| server → client | `changes` | `rows`, `cursor`, `more?`, `reset?` |
| server → client | `error` | `code`, `message`, `retryAfter?` |
| server → client | `hello`, `status`, `focus`, `bye` | presence, with a `viewer` |

A reviewer session, start to first note:

```
→ { "v":1, "t":"pull", "after":0 }
← { "v":1, "t":"changes", "rows":[{ "v":1, "type":"page", "id":"…", "seq":1, … }], "cursor":1 }
→ { "v":1, "t":"mutation", "clientId":"q3V…", "n":1, "name":"addNote", "args":{ "items":[{ "kind":"annotation", "target":"intro", "note":"Why now?" }] } }
← { "v":1, "t":"ack", "clientId":"q3V…", "n":1 }
← { "v":1, "t":"changes", "rows":[{ "v":1, "type":"note", "id":"n7", "seq":2, "author":"Ana", "items":[…], "at":1763164800000, "state":"held" }], "cursor":2 }
```

### Mutations

| Mutation | Sent by | `args` | Effect |
|---|---|---|---|
| `publish` | owner | `{ title, cliVersion, html, packs: [{ sha256, name, version }], auto, unlisted, presence }` | Points the page at a new version. `publishedAt` = now, `expiresAt` = now + 30 days. Updates the D1 `pages` index. Counts toward the publish limits. `page` row. |
| `addNote` | reviewer | `{ items, name? }` | New note. `author` = the invite name; on an unlisted page `name`, truncated to 40 characters (`Reviewer` when empty). `state` = `released` on an `auto` page, else `held`. `note` row. |
| `releaseNote` | owner | `{ note }` | `held` → `released`. Already released or discarded: no change. `note` row. |
| `discardNote` | owner | `{ note }` | `held` → `discarded`. Already released or discarded: no change. `note` row. |
| `addReply` | owner | `{ text }` | An agent reply shown in the hosted conversation. `reply` row. |
| `grant` | owner | `{ name, tokenHash, expiresAt }` | Creates invite `name`, or gives it a new token (the old link stops working). `acl` row. |
| `revoke` | owner | `{ name }` | Revokes invite `name`; its open sockets get `error` `forbidden` and are closed. `acl` row. |
| `delete` | owner | `{}` | Sends the `page` row with `deleted: true` (and every other field as last published) to every socket, closes them (1000), deletes the page's storage, D1 row and object references. Later handshakes get 404. A page deleted before its first `publish` has no `page` row; its sockets just close. |

- A mutation sent by the wrong role (`MUTATION_ROLE`) gets `forbidden`. A `note` or `name` that does not exist gets `invalid`.
- Field rules are the validators in `austere-axi/sync`: hashes are lowercase hex SHA-256, `tokenHash` is base64url SHA-256 (43 characters), invite names are 1–40 characters, `addNote` needs at least one item, times are epoch milliseconds.
- `items` is the shape the chrome posts locally (`{ kind: "message", text }` or `{ kind: "annotation", target?, component?, path?, selection?, excerpt?, note?, detail? }`). The local server still rebuilds every remote item with `reviewerItem` (`src/cli/items.ts`) before it reaches the owner or the agent.
- The ack only says the mutation was applied or rejected. Its effect arrives, to the sender too, as rows in the change feed.

### Idempotency

- A `clientId` belongs to exactly one outgoing queue, the one that numbers its `n`, and is never copied or shared. The local server's queue lives in hub.db with its own `clientId`, made with hub.db and dropped with it. A one-shot command (`publish`, `publish rm`) makes a fresh `clientId` per run. The chrome makes one per page load and keeps it in memory, numbering from 1, so a reload or a duplicated tab (which copies sessionStorage) never reuses a key; notes still unacked are saved with their own `(clientId, n)` in sessionStorage and re-sent under it after a reload. Each saved note records who sent it (the invite name, or the open link) and is re-sent and shown only while the page is that same reviewer: opening another invite in the same tab never sends one reviewer's note under another's name. If that save fails, the composer warns that a reload before the ack would lose the note. A `clientId` is 16 random bytes, base64url.
- `n` starts at 1 and grows by one per new mutation; it is stored with the queue so a restart continues the count.
- The page object stores the answer it gave each `(clientId, n)`, applied or rejected, for the life of the page, except `rate_limited`, which is not stored. The same `(clientId, n)` again gets the same `ack` and changes nothing.
- A client keeps each mutation until its `ack` arrives and, after a reconnect, re-sends the unacknowledged ones in order. On a `rate_limited` ack it waits `retryAfter` seconds and re-sends the same mutation, keeping it queued meanwhile; the deadline is kept with the queued mutation, so a reconnect or a reload during the wait does not send it early, and there is one re-send per refusal. On any other error ack it drops the mutation and reports the error.
- A mutation the parser rejects but whose key was readable (the `key` on a failed parse) is answered with an `ack` carrying the error; one without a readable key gets an `error` frame. A frame over 64 KiB has no readable key, so clients never send one: `mutation()` throws instead of building it.

### Rows and the cursor

| Row | Fields (plus `v`, `type`, `id`, `seq`) | Owner | Reviewer |
|---|---|---|---|
| `page` | `title`, `cliVersion`, `html`, `packs`, `auto`, `unlisted`, `presence`, `publishedAt`, `expiresAt`, `deleted`; `id` = page id | yes | yes |
| `note` | `author`, `items`, `at`, `state` (`held` / `released` / `discarded`) | yes | yes |
| `reply` | `text`, `at` | yes | yes |
| `acl` | `name`, `grantedAt`, `expiresAt`, `revoked`, `grant`; `id` = invite name. `grant` (`grantId(tokenHash)`, the first 16 characters of the base64url SHA-256) names which token the name has now, so an owner peer can tell whether its own link is the live one. It is a prefix of a hash of a 256-bit random token, so it reveals nothing usable; the full hash and the token never leave the server. `grant` was added before the first deploy, so `v` stays 1; readers treat it as optional. | yes | no |

- The op log is private: clients never see operations, only the current state of rows.
- Each page object has one counter. Every change to a row (created or updated) gives that row the next `seq`. Rows are only removed with the whole page.
- `pull { after }` answers with every row the socket may see whose `seq` is greater than `after`, in `seq` order, each once in its latest state, at most 500 rows per `changes` frame, with `more: true` on all but the last. No live frame is sent before that last frame. After it, the server pushes a `changes` frame whenever rows change. A second `pull` restarts the feed from its `after`.
- `cursor` is the highest `seq` the frame covers. On the last frame of a pull and on live frames that is the page's counter, including rows the socket may not see, so a reviewer's cursor advances like the owner's.
- A client applies rows as upserts by `(type, id)`, then stores `cursor`. Re-applying a row is harmless, so a crash between the two re-delivers instead of losing.
- When `after` is ahead of the page's counter (its storage was reset), the first frame has `reset: true` and starts from 0; the client drops the rows it cached for the page.
- Reviewers receive notes in every state; the chrome hides discarded ones.
- A `page` row always carries every field. The deleted page's row keeps the fields of its last publish.

### Errors

| Code | When | Answer |
|---|---|---|
| `upgrade_required` | `v` below `MIN_SYNC_VERSION`; CLI below `MIN_CLI_VERSION` | 426 at handshake; else `error` frame, then the socket is closed (1008) |
| `forbidden` | Missing, wrong, revoked or expired credential; mutation sent by the wrong role | 403 at handshake; `ack` error for a mutation; `error` frame and close (1008) on revoke |
| `rate_limited` | A [limit](#limits) is reached | 429 at handshake; `ack` error with `retryAfter` seconds |
| `too_large` | Frame over 64 KiB; `addNote` items over 4 KB; object over 1 MB | `error` frame; `ack` error; 413 |
| `invalid` | Malformed frame, unknown mutation or frame type, missing note or invite | `ack` error when the key was readable, else `error` frame |

The server closes a socket in these cases only, each after the frame named:

| Event | Frame first | Close code |
|---|---|---|
| `v` below `MIN_SYNC_VERSION` | `error` `upgrade_required` | 1008 |
| The socket's invite is revoked or expires | `error` `forbidden` | 1008 |
| A `publish` clears `unlisted`: sockets without an invite | `error` `forbidden` | 1008 |
| Takedown | `error` `forbidden` | 1008 |
| `delete` | `changes` with the deleted `page` row | 1000 |

After a 1008 close a client does not reconnect on its own. After any other close (network, deploy, hibernation eviction) it reconnects with backoff (up to 60 s) and pulls after its stored cursor. The set of codes is closed: a new failure reuses one of these, with its own `message`.

### Access (Q16)

- `grant` makes an invite: the CLI generates the token (32 random bytes, base64url), sends only its SHA-256 (`tokenHash`), and prints `https://austere.kasat.xyz/p/<id>#i=<token>`. The fragment is never sent to the server, so the token stays out of server logs and `Referer`.
- The chrome reads `#i=`, stores it in localStorage under `austere:invite:<id>`, and removes it from the address bar (`history.replaceState`). Another invite link opened in the same tab changes only the fragment, so the chrome reloads on `hashchange` to take it. It sends the token as `X-Austere-Invite` on same-origin HTTP calls and as `austere-invite.<token>` on the socket. The server hashes it and looks the hash up among the page's live invites.
- `GET /p/:id` (the shell) holds no content and needs no invite. The artifact, the row feed and `addNote` need a live invite, unless the page is unlisted. The owner token is not accepted on reviewer routes; the owner reviews through the local server.
- The frame cannot carry a header or a cookie. The chrome trades its invite for an `assetToken` with `POST /p/:id/asset-token` (answer `{ token, expiresAt, name }`, valid 10 minutes, for this page only) and loads the frame from `/p/:id/a/<assetToken>/`, the pattern the local server uses for `/s/:id/a/<token>/<file>`. `name` is the invite name, or `null` on the open link (the chrome then shows the name prompt). Without a live invite on a page that is not unlisted the answer is 403 `forbidden`. An asset token stops working when it expires, when its invite is revoked, replaced or expires, or (on the open link) when a publish clears `unlisted`; the artifact then answers 403.
- `grant` with a name's current token only moves its expiry and keeps the `acl` row's `grantedAt`; a new token sets `grantedAt` to now and closes the sockets that came in with the old one (`error` `forbidden`, 1008). A past `expiresAt`, or a `tokenHash` another name holds, is `invalid`. An expired invite's sockets are closed when it expires.
- A reviewer's name is their invite name. One name has one live token; granting the name again replaces the token.
- `unlisted: true` on `publish` opts the page into the open link: no invite needed, and `addNote` takes the self-declared `name` from the prompt (Q6). A later `publish` with `unlisted: false` closes the sockets that came in without an invite (see [Errors](#errors)).
- On an invited page, the per-IP note limit counts per invite instead.

### Presence (Q17)

- Presence runs when the page's `presence` is true (`publish --no-presence` sets it false). Otherwise the server drops presence frames and sends none. A `publish` that turns it off sends `bye` for every viewer, then stops.
- A socket becomes a viewer with its first `hello`; until then it gets no presence frames (the `publish` command never sends one). After opening the socket, a viewer sends `hello { status, name? }` (`name` only on an unlisted page, from the name prompt). The server answers with one `hello` per other viewer present, then the joiner's own, marked `self: true`, and sends the newcomer's `hello` to everyone else. A `hello` from the server carries `viewer: { id, name, colour, role }`, `status` and `focus`. `id` is per socket; `name` is the invite name, the self-declared name on an unlisted page (truncated to 40 characters, `Reviewer` when empty), or `Owner`; `colour` is lowercase `#rrggbb`, picked by the server: the same for every socket under one name, and different from the other names present (clients only display it). Until invites land, a reviewer socket without one counts as "no invite": its name is `hello.name`.
- `status { status }`: `viewing`, `away` (tab hidden) or `writing` (the composer or the frame's note box has the keyboard; the frame posts `writing` to the chrome). It is also the heartbeat: send it at least every 30 s (the chrome sends it every 25 s). The server passes on a change only; a repeated status is just the heartbeat.
- `focus { statement }`: the statement id the viewer last clicked in Annotate mode (the frame posts `focus` when a click opens the note box), or `null` to clear. The chrome outlines that statement in the viewer's colour with their name; viewers on the same statement share one outline with a name tag each. Clicking a viewer's chip scrolls to their focus.
- `bye {}`: sent on leaving (`pagehide`). The server sends `bye { viewer }` to the others on `bye`, on close, or after 60 s without a frame from that viewer. Any frame counts, not only presence. A viewer dropped for silence comes back under the same id, with a `hello` to the others, on its next frame.
- Server copies of `status`, `focus` and `bye` carry `viewer` (the viewer id), and go to the other viewers only, never back to the sender. Presence is never stored, never in the op log or the row feed, and never acked. More than 10 presence frames a second from one socket are dropped.
- A second `hello` keeps the viewer id and updates status and name: the chrome sends one when its name prompt is answered after joining, so the others see the name at once.
- On a dropped socket the chrome clears its roster; after reconnecting it sends `hello` again, and `focus` if it has one. A browser cannot read a refused handshake's status, so when the socket closes before opening the chrome asks the page shell: 404 or 410 means the page is gone and it stops retrying.
- The owner sees presence in the local review page: while the owner has a published file's review page open, the local server keeps the page's owner socket open and joins as a viewer (role `owner`, after its pull, unless the page row says `presence: false`). It forwards every presence frame it receives unchanged to the owner's review page as an SSE event `viewer` (not `presence`, which the local stream already uses for the agent's state), and replays the current roster as `hello` frames to a review page that connects later. The review page posts its own `hello`, `status` and `focus` to `POST /s/:id/presence` (owner only), which the server sends on; a local `bye` is not passed on, since another tab may be open. When the last owner review page closes, the server sends `bye`. When the socket drops, the review page gets a `bye` for every viewer it showed.

### Self-host (Q18)

- The page object uses only the standard Durable Object API: SQLite storage (`ctx.storage.sql`), WebSocket hibernation (`ctx.acceptWebSocket`, socket attachments) and alarms. No Cloudflare-only extras inside it, so it runs under workerd and celld.
- Worker handlers stay thin: route, check credentials, hand the socket to the page object.
- No storage abstraction layer for now.

## Limits

| Limit | Value | Response |
|---|---|---|
| Upload size (gzip request body) | 1 MB | 413 with a message that names the size |
| Publishes (create and update) per owner token | 20 per day | 429 |
| Publishes per IP | 100 per day | 429 |
| New owners per IP | 5 per day | 429 |
| Notes per page per IP | 60 per hour | 429 |
| Note batch size | 4 KB of JSON `items` | 413 |
| Reviewer name | 40 characters, plain text | Truncated |
| Retention | 30 days after the last publish | A daily cron deletes pages, page blobs, notes, replies and unreferenced pack blobs |

All text is rendered with `textContent` in chrome, never as HTML. Rate limits use the D1 `limits` table with fixed windows. This is cheap and good enough at this scale. Cloudflare's rate-limiting binding can replace it later.

Over a socket, a 429 is `rate_limited` and a 413 is `too_large` (see [Errors](#errors)). Retention deletes the page object's storage along with its D1 row and objects.

## Abuse and takedown

- The footer on every page reads: "Made with austere-axi · Report".
- `POST /p/:id/report` stores the report and sends one email per report to the admin address (`ADMIN_EMAIL` secret) through the Cloudflare Email Routing `send_email` binding. Reports are rate-limited at 5 per IP per day.
- `npx austere-cloud-admin takedown <id> [--owner]` is a small script in the cloud repo that uses `ADMIN_TOKEN`. It sets `taken_down` (the page then returns 410 Gone), deletes the page blobs and any unreferenced pack blobs, adds a `blocked_ids` tombstone, and with `--owner` blocks the owner token so every one of its pages returns 410 Gone. It also closes the page object's open sockets.
- `npx austere-cloud-admin reports` lists open reports.

## Threats

| Threat | Mitigation |
|---|---|
| Artifact JS steals reviewer data or calls the API as the reviewer | Opaque-origin sandbox, `connect-src 'none'` on the frame, no cookies anywhere on the domain. The invite token stays in the chrome; the frame only ever gets a short-lived, page-scoped `assetToken`. The downloaded standalone copy is built from the artifact and its scripts only: no invite token, asset token or reviewer name is written into it. |
| Prompt injection through public notes | Held by default (Q7). Remote notes are marked `remote: true`. `--auto` is an explicit opt-in. |
| Phishing or malware hosting gets the domain flagged | Report and takedown, 30-day expiry, `noindex`, 1 MB cap, upload rate limits |
| Owner token leak | The token only controls that owner's pages. A token can be rotated by deleting `cloud.json`, which loses control of existing pages until they expire. |
| Invite link leak | Only that invite's name is affected: the owner revokes it (`publish revoke`), which closes its sockets at once. Tokens travel in the fragment and `Sec-WebSocket-Protocol`, never in a logged URL. |
| Note spam | Per-IP (per-invite on invited pages) per-page limits, 4 KB cap, and holding |
| Replayed or duplicated mutations | `(clientId, n)` idempotency keys: a repeat changes nothing |
| Untrusted third-party pack code | On the hosted page it runs only in the sandboxed frame, as locally, and the page shows the same third-party-pack warning. A downloaded standalone copy is an ordinary HTML file: opened from disk it runs that code with no sandbox, like any `export` of the page. That is the reviewer's choice, the same as saving any web page. |

## Build tickets

The tickets are staged under RLM-245. The service and the CLI are separate repos, so their tickets can run in parallel against the contract above and the `austere-axi/sync` module.

| Stage | Ticket | Repo |
|---|---|---|
| 1 | Cloud scaffold, schema, publish and serve slice (RLM-264) | austere-cloud |
| 1 | Chrome hosted mode (RLM-265) | austere-axi |
| 1 | Sync/access/presence contract + `austere-axi/sync` (RLM-313) | austere-axi |
| 2 | `publish` command: objects, `publish` mutation, list, rm (RLM-267) | austere-axi |
| 2 | Page Durable Object: op log, mutations, WebSocket change feed (RLM-268) | austere-cloud |
| 3 | Cloudflare account, DNS, D1/R2, secrets (human, RLM-266) | — |
| 3 | Retention cron, report, takedown (RLM-269) | austere-cloud |
| 3 | Local server as sync peer (RLM-270) | austere-axi |
| 3 | Invite-only access (RLM-314) | both |
| 3 | Presence v1 (RLM-315) | both |
| 4 | Release, deploy, end-to-end smoke, docs (RLM-271) | both |
