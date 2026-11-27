# Sync protocol

The wire protocol between a hosted page and its clients: the CLI (`publish` and the local server's sync peer) and the review chrome. The server is [austere-cloud](https://github.com/MandalorianBatman/austere-cloud).

- The server keeps a private op log per page. Clients send **mutations** and pull **changed rows after a cursor** over a WebSocket.
- hub.db holds the current rows and one cursor per published page. It is a cache: it can be dropped and re-pulled. Any machine signed in to the same account is a peer.

## Schema module

Implemented once in `src/shared/sync.ts`; published as **`austere-axi/sync`** (`dist/sync.mjs`, types in `types/sync.d.ts`).

```ts
import { parseClientFrame, MUTATION_ROLE, SYNC_VERSION } from "austere-axi/sync";
import type { Mutation, Row } from "austere-axi/sync";
```

- Platform-neutral ESM, no imports: runs in Workers, browsers and Node. zod 4 is bundled and never in the API.
- `types/sync.d.ts` is the contract; the source checks itself against it at compile time (`npm run typecheck`).
- Exports:
  - Constants: `SYNC_VERSION`, `MIN_SYNC_VERSION`, `SUBPROTOCOL`, `LIMITS`, `ERROR_CODES`, `MUTATIONS`, `MUTATION_ROLE`, `ROW_TYPES`.
  - `parseClientFrame` (server side), `parseServerFrame` (client side).
  - `mutation`: builds a mutation frame at `SYNC_VERSION`.
  - `syncProtocols` / `readProtocols`: handshake.
  - `grantId`: the `acl` row's `grant` for a token hash.
  - A type for every frame, mutation, row and presence message.
- A parse returns `{ ok: true, value }` or `{ ok: false, error: { code, message }, key? }`. `key` is the mutation's `(clientId, n)` when readable, so the server can `ack` it.

## Versioning and compatibility

- `v` = integer protocol version (`SYNC_VERSION`, now 2; v2 added optional `project` and `relPath` to `publish`). Every frame, mutation and row carries it.
- `v` below `MIN_SYNC_VERSION` → `upgrade_required`. A higher `v` is read as far as this version knows it.
- Unknown fields: kept on the parsed value, ignored.
- Unknown row `type`: kept (`skipped` on the parsed `changes` frame), not applied; its `seq` still counts toward the cursor.
- Unknown server frame `t`: skipped (parses to `null`).
- Unknown mutation or client frame type: server answers `invalid`. The service deploys before a CLI that sends something new.
- Changes are **additive only**, each with a `SYNC_VERSION` bump: new optional fields, mutations, row types, frame types. Never remove, rename or retype a field. Never add a value to an existing string set (status, note state, error code); add a field instead.
- `MIN_CLI_VERSION` is service configuration. The owner socket sends `?cli=<version>`; the reviewer chrome's version is the page's `cliVersion`. Missing, malformed or too old → 426 `upgrade_required`.
- Compatibility window: the last 3 published austere-axi versions and `MIN_CLI_VERSION`.
- When hub.db was filled under a different `SYNC_VERSION`, the CLI drops the cached rows and pulls from 0.
- Local page states (`archive` etc.) are not on the wire. A hosted page has no archive state; its viewers' notes reach a local archived page held for the owner.

## Objects and pages (HTTP)

| Route | Caller | Behavior |
|---|---|---|
| `POST /api/pages` | owner | Creates an empty page; returns `{ id, url }`. Used by `publish --new` and a first publish; a republish reuses the id from `cloud.json`. Before its first `publish` the page answers reviewers 404; an unpublished page is deleted after 24 h. |
| `PUT /api/objects/:sha256` | owner | Uploads page HTML (`text/html`) or pack JS (`text/javascript`), optionally `Content-Encoding: gzip`. SHA-256 of decoded bytes must match (else 400). 204 on success; re-upload is a no-op. Max 1 MB per request (413). |

The `publish` mutation then names the page HTML and its packs by SHA-256. Each must be uploaded (else `invalid`).

## WebSocket endpoints

| Endpoint | Client | Credential |
|---|---|---|
| `GET /api/pages/:id/sync?cli=<version>` | Owner peer: the local server, and `publish` | Account access token (Authorization header) |
| `GET /p/:id/sync` | Reviewer chrome (same origin; foreign `Origin` rejected) | Owner cookie, else invite token; none on an unlisted page |

- Credentials ride in `Sec-WebSocket-Protocol` (browsers can't set WebSocket headers; query strings get logged). Client offers `austere-sync.1` plus `austere-owner.<token>` or `austere-invite.<token>` (`syncProtocols`). Server reads them with `readProtocols` and answers `austere-sync.1`, never echoing a credential.
- A failed handshake is plain HTTP with `{ "error": { "code", "message" } }`:

| Status | Cause |
|---|---|
| 403 `forbidden` | Missing, wrong, revoked or expired credential |
| 404 | Unknown, unpublished, expired or deleted page |
| 410 | Taken down |
| 426 `upgrade_required` | No `austere-sync.1` offered; CLI version missing or below `MIN_CLI_VERSION` |
| 429 `rate_limited` | Limit reached; retry after `Retry-After` |

- Clients do not retry 403, 404, 410 or 426 on their own: the CLI stops syncing that page and reports why; the chrome shows the reason.
- Frames are JSON text frames, one message each. Client frame max 64 KiB (`LIMITS.frameBytes`).

## Frames

Every frame is `{ "v": <version>, "t": "<type>", … }`.

| Direction | `t` | Fields |
|---|---|---|
| client → server | `mutation` | `clientId`, `n`, `name`, `args` |
| client → server | `pull` | `after` (cursor; 0 = everything) |
| client → server | `hello`, `status`, `focus`, `bye` | presence, see [Presence](#presence) |
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

## Mutations

| Mutation | Sent by | `args` | Effect |
|---|---|---|---|
| `publish` | owner | `{ title, cliVersion, html, packs: [{ sha256, name, version }], auto, unlisted, presence, project?, relPath? }` | Points the page at a new version. `publishedAt` = now, `expiresAt` = now + 30 days. Counts toward publish limits. `page` row. |
| `addNote` | reviewer | `{ items, name? }` | New note. `author` = invite name; on an unlisted page `name` (max 40 chars, `Reviewer` when empty). `state` = `released` on an `auto` page, else `held`. `note` row. |
| `releaseNote` | owner | `{ note }` | `held` → `released`; otherwise no change. `note` row. |
| `discardNote` | owner | `{ note }` | `held` → `discarded`; otherwise no change. `note` row. |
| `addReply` | owner | `{ text }` | Agent reply shown in the hosted conversation. `reply` row. |
| `grant` | owner | `{ name, tokenHash, expiresAt }` | Creates invite `name`, or gives it a new token (old link stops working). `acl` row. |
| `revoke` | owner | `{ name }` | Revokes invite `name`; its sockets get `error` `forbidden` and close. `acl` row. |
| `delete` | owner | `{}` | Sends the `page` row with `deleted: true` (other fields as last published) to every socket, closes them (1000), deletes the page's storage and object references. Later handshakes get 404. Deleted before first `publish`: sockets just close. |

- `project` / `relPath` (v2, optional): the local hub's project name for the file and its path in that project. The owner's cloud hub groups pages by `project`; without it the page is listed as Ungrouped. Not in the `page` row reviewers receive. A `publish` with neither keeps the stored values. When hub.db can't be written, neither is sent.
- Wrong role (`MUTATION_ROLE`) → `forbidden`. Unknown `note` or `name` → `invalid`.
- Field rules (validators in `austere-axi/sync`): hashes are lowercase hex SHA-256; `tokenHash` is base64url SHA-256 (43 chars); invite names 1–40 chars; `addNote` needs ≥ 1 item; times are epoch ms.
- `items` = the shape the chrome posts locally: `{ kind: "message", text }` or `{ kind: "annotation", target?, component?, path?, selection?, excerpt?, note?, detail? }`. The local server rebuilds every remote item with `reviewerItem` (`src/cli/items.ts`) before it reaches the owner or agent.
- The `ack` only says applied or rejected. The effect arrives, to the sender too, as rows in the change feed.

## Idempotency

- Key = `(clientId, n)`. `clientId` is 16 random bytes, base64url, owned by exactly one outgoing queue, never shared.
  - Local server: one queue in hub.db with its own `clientId`, created and dropped with hub.db.
  - One-shot commands (`publish`, `publish rm`): fresh `clientId` per run.
  - Chrome: one per page load, in memory, numbering from 1 (a reload or duplicated tab never reuses a key). Unacked notes are saved with their `(clientId, n)` in sessionStorage and re-sent under it after a reload, only while the page is the same reviewer (invite name or open link). If the save fails, the composer warns that a reload before the ack would lose the note.
- `n` starts at 1, +1 per new mutation, stored with the queue so a restart continues.
- The server stores its answer to each key for the life of the page (except `rate_limited`). A repeated key gets the same `ack` and changes nothing.
- Clients keep each mutation until acked and re-send unacked ones in order after reconnect.
- `rate_limited` ack: wait `retryAfter` seconds, re-send the same mutation once. The deadline is stored with the queued mutation, so a reconnect or reload does not send it early.
- Any other error ack: drop the mutation and report the error.
- Rejected mutation with a readable key → `ack` with the error; no readable key → `error` frame. `mutation()` throws rather than build a frame over 64 KiB.

## Rows and the cursor

| Row | Fields (plus `v`, `type`, `id`, `seq`) | Owner | Reviewer |
|---|---|---|---|
| `page` | `title`, `cliVersion`, `html`, `packs`, `auto`, `unlisted`, `presence`, `publishedAt`, `expiresAt`, `deleted`; `id` = page id | yes | yes |
| `note` | `author`, `items`, `at`, `state` (`held` / `released` / `discarded`) | yes | yes |
| `reply` | `text`, `at` | yes | yes |
| `acl` | `name`, `grantedAt`, `expiresAt`, `revoked`, `grant`; `id` = invite name | yes | no |

- `grant` = `grantId(tokenHash)`: first 16 chars of the base64url SHA-256. Tells an owner peer whether its own link is the live one; reveals nothing usable. Optional for readers. The full hash and token never leave the server.
- Clients never see operations, only current row state.
- One counter per page: every row change gets the next `seq`. Rows are removed only with the whole page.
- `pull { after }`: every visible row with `seq > after`, in `seq` order, each once in latest state, ≤ 500 rows per `changes` frame, `more: true` on all but the last. No live frame before the last. Then the server pushes `changes` whenever rows change. A second `pull` restarts from its `after`.
- `cursor` = highest `seq` the frame covers. On the last pull frame and live frames it is the page counter (including rows the socket can't see).
- Clients upsert rows by `(type, id)`, then store `cursor`. Re-applying is harmless.
- `after` ahead of the counter (storage reset): first frame has `reset: true` and starts from 0; the client drops its cached rows for the page.
- Reviewers receive notes in every state; the chrome hides discarded ones.
- A `page` row always carries every field; a deleted page's row keeps its last publish's fields.

## Errors

| Code | When | Answer |
|---|---|---|
| `upgrade_required` | `v` below `MIN_SYNC_VERSION`; CLI below `MIN_CLI_VERSION` | 426 at handshake; else `error` frame, then close (1008) |
| `forbidden` | Missing, wrong, revoked or expired credential; wrong role | 403 at handshake; `ack` error for a mutation; `error` frame and close (1008) on revoke |
| `rate_limited` | A limit is reached | 429 at handshake; `ack` error with `retryAfter` seconds |
| `too_large` | Frame over 64 KiB; `addNote` items over 4 KB; object over 1 MB | `error` frame; `ack` error; 413 |
| `invalid` | Malformed frame, unknown mutation or frame type, missing note or invite | `ack` error when the key was readable, else `error` frame |

The server closes a socket only in these cases:

| Event | Frame first | Close code |
|---|---|---|
| `v` below `MIN_SYNC_VERSION` | `error` `upgrade_required` | 1008 |
| Invite revoked or expired | `error` `forbidden` | 1008 |
| `publish` clears `unlisted` (sockets without an invite) | `error` `forbidden` | 1008 |
| Takedown | `error` `forbidden` | 1008 |
| `delete` | `changes` with the deleted `page` row | 1000 |

- After 1008: no automatic reconnect.
- Any other close (network, deploy, eviction): reconnect with backoff (max 60 s) and pull after the stored cursor.
- The code set is closed: a new failure reuses a code with its own `message`.

## Access

Invite-only by default; an unlisted open link is opt-in.

- **Invites** (`grant`): the CLI generates a token (32 random bytes, base64url), sends only its SHA-256 (`tokenHash`), and prints `https://austere.blundertech.com/p/<id>#i=<token>`. The fragment never reaches the server (stays out of logs and `Referer`).
- The chrome reads `#i=`, stores it in localStorage as `austere:invite:<id>`, and strips it from the address bar (`history.replaceState`). It reloads on `hashchange` to pick up another invite in the same tab. It sends the token as `X-Austere-Invite` on same-origin HTTP and `austere-invite.<token>` on the socket.
- A reviewer's name is their invite name. One name has one live token; granting the name again replaces it.
- `grant` with the name's current token only moves expiry (keeps `grantedAt`). A new token sets `grantedAt` to now and closes sockets using the old one (`error` `forbidden`, 1008). Past `expiresAt`, or a `tokenHash` another name holds → `invalid`. Expired invites' sockets are closed on expiry.
- **Shell** `GET /p/:id`: no content, no invite needed, names no page (`<title>` `Shared page · austere`, boot `title` `Shared page`). The artifact, row feed and `addNote` need a live invite, the owner's sign-in cookie, or an unlisted page. The owner's access token is not accepted on reviewer routes.
- **Asset token**: the sandboxed frame can't carry a header or cookie. The chrome calls `POST /p/:id/asset-token` → `{ token, expiresAt, name, title, owner }` (10 min, this page only) and loads the frame from `/p/:id/a/<assetToken>/`.
  - `name`: invite name, `Owner` for owner sign-in, or `null` on the open link (chrome shows the name prompt).
  - `title`: page title, shown by the chrome from then on. `owner`: true for owner sign-in.
  - No live invite or sign-in on a non-unlisted page → 403 `forbidden`.
  - Stops working on expiry, when its invite is revoked, replaced or expires, when its sign-in expires, or (open link) when a publish clears `unlisted`; the artifact then answers 403.
- **Owner sign-in**: `publish login <file>` calls `POST /api/pages/:id/login` with the owner's access token → `{ code, ttlMs }` (single use, 60 s; server stores only its SHA-256). Prints `https://<service>/p/<id>?login=<code>`.
  - `GET /p/:id?login=<code>` → 303 to `/p/:id` with `Set-Cookie: austere_owner=<session>; Path=/p/<id>; HttpOnly; SameSite=Lax; Max-Age=2592000` (+ `Secure` over https). Used, expired or unknown code → 403.
  - The cookie is scoped to that one page and valid 30 days (server stores only its SHA-256). It enters as reviewer `Owner`, ahead of any invite also offered. On expiry its sockets close (`error` `forbidden`, 1008).
- **Unlisted**: `publish` with `unlisted: true` opens the link to anyone; `addNote` takes the self-declared `name`. A later `unlisted: false` closes sockets that came in without an invite.
- On an invited page, the per-IP note limit counts per invite instead.

## Presence

- Runs when the page's `presence` is true (`publish --no-presence` sets it false). Otherwise the server drops presence frames and sends none. A `publish` that turns it off sends `bye` for every viewer.
- Messages are never stored, never in the row feed, never acked. More than 10 presence frames/s from one socket are dropped.

| Client sends | Meaning |
|---|---|
| `hello { status, name? }` | Join (first `hello` makes the socket a viewer; before that it gets no presence frames). `name` only on an unlisted page, from the name prompt. A second `hello` keeps the viewer id and updates status and name. |
| `status { status }` | `viewing`, `away` (tab hidden) or `writing` (composer or the frame's note box has the keyboard). Also the heartbeat: at least every 30 s (chrome: every 25 s). Only changes are passed on. |
| `focus { statement }` | Statement id last clicked in Annotate mode, or `null` to clear. |
| `bye {}` | Leaving (`pagehide`). |

- On `hello` the server answers with one `hello` per other viewer, then the joiner's own (`self: true`), and sends the newcomer's `hello` to everyone else.
- Server `hello` carries `viewer: { id, name, colour, role }`, `status`, `focus`.
  - `id`: per socket.
  - `name`: invite name, the self-declared name on an unlisted page (max 40 chars, `Reviewer` when empty), or `Owner`.
  - `colour`: lowercase `#rrggbb`, picked by the server; same for every socket under one name, different from other names present.
- Server copies of `status`, `focus`, `bye` carry `viewer` (the id) and go to the other viewers only.
- The server sends `bye { viewer }` on `bye`, on close, or after 60 s without any frame from the viewer. A viewer dropped for silence returns under the same id, with a `hello` to the others, on its next frame.
- **Chrome UI**: roster chips (own chip first, ringed; then one per other viewer with name, colour, status). The focused statement is outlined in the viewer's colour with their name; viewers on the same statement share one outline with a tag each. Clicking a chip scrolls to that viewer's focus. No live pointers.
- On a dropped socket the chrome clears its roster; after reconnecting it sends `hello` again, and `focus` if set. If the socket closes before opening, the chrome asks the page shell: 404 or 410 means the page is gone and it stops retrying.
- **Owner in the local review page**: while the owner has a published file's review page open, the local server keeps the owner socket open and joins as a viewer (role `owner`, after its pull, unless `presence: false`).
  - It forwards every presence frame unchanged to the review page as SSE event `viewer`, and replays the roster as `hello` frames to a review page that connects later.
  - The review page posts its `hello`, `status` and `focus` to `POST /s/:id/presence` (owner only). A local `bye` is not passed on.
  - When the last owner review page closes, the server sends `bye`. When the socket drops, the review page gets a `bye` for every viewer it showed.
