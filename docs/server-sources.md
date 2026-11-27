# Server-backed sources: design

Status: Proposed 2026-11-27 (RLM-489). Spec only; nothing here is built. The build waits for RLM-488 (the page's `toolProvider` and `Query` wiring), which this note assumes. D1–D8 below need Sid's approval before the build starts. Names and line numbers are from 0.26.0 (`85527b9`).

## Problem

A page cannot get data from the server. The frame has an opaque origin and the `sandbox` CSP, so `fetch` works only for APIs that answer `Origin: null`, and a key in the page is a key in a file. Heavy runs (large data, many symbols, network, secrets) need code on the server, and today nothing a page or pack ships runs there.

This note adds two kinds of server tool that a page calls with `Query`:

- **HTTP source:** a URL the owner registered at a terminal. The server fetches it, with a key from an environment variable, and caches the result for every viewer.
- **Script source:** a Node script the agent writes next to the page. The server runs it in a subprocess under Node's permission model, only when the owner approved its exact hash.

## Decisions (proposed)

| # | Decision |
|---|---|
| D1 | Script sources need Node 25 or later on the server (Node 26 in CI). On Node 22 and 24 every script call answers `isolation_unavailable` and the script does not run. Docker is not required. See [Isolation](#isolation-measured). |
| D2 | A script lives in `.austere-tools/<name>/` next to the page, entry `index.mjs`. The pin is a hash over every file in that folder. A dot-folder is never served to the frame or a reviewer (`resolveSibling`, `src/cli/assets.ts`). |
| D3 | No filesystem writes for scripts in v1. A script returns its result on stdout. |
| D4 | `"net": true` in a script's manifest means the whole network, including this machine's loopback services and Unix sockets. Node has no host allowlist. The approval dialog says this in those words. |
| D5 | A reviewer's call never starts work by default. It gets the cached result for the same arguments, or `owner_only`. The owner opts a source in for reviewers: `source add --reviewers` for HTTP, a checkbox in the approval dialog for a script. |
| D6 | A tool name must appear as a `Query` tool name in the page's current program; any other name is `unknown_tool`. A page cannot call a source it does not show. |
| D7 | Name resolution order: a tool the page ships (RLM-488, in the frame), then a registered HTTP source, then a script folder. `check` fails a page whose script name equals a registered source name. |
| D8 | The approval of a script is stored by the server in the state dir, never in the project. A cloned repo cannot approve its own script (same rule as `trusted.json`). |

## Bridge: `tool-call` and `tool-result`

The frame's `toolProvider` (RLM-488) handles the tools the page ships itself. For any other name it sends `tool-call` to the chrome. Both messages carry `austere: 1`, as every bridge message does (`src/runtime/index.tsx`).

```ts
// FrameToChrome, added
| { type: "tool-call"; id: string; name: string; args: unknown }

// ChromeToFrame, added
| { type: "tool-result"; id: string; ok: true; data: unknown; fetchedAt: string; cached: boolean }
| { type: "tool-result"; id: string; ok: false; code: string; message: string }
```

- `id`: chosen by the frame, at most 64 characters; the chrome echoes it.
- The chrome (`src/chrome/review-frame.ts`) checks `id` and `name` are strings, then posts `{ name, args }` to `/s/:id/tool` and answers with `tool-result`. At most 4 calls per frame are in flight; a fifth gets `code: "busy"` at once. The chrome gives up after 330 s (`timeout`); the frame gives up after 340 s, so a chrome that predates this message cannot hang a Query.
- Hosted pages (`HOSTED`) and the playground (`site/play/play.ts`) have no server. They answer every `tool-call` with `code: "unavailable"`. AGENTS.md requires the playground change with the bridge change.
- The frame shows `ok: false` as the Query's error state; it never retries on its own. `Query`'s own `refreshSeconds` is the only repeat.

## Route: `POST /s/:id/tool`

The route sits under the session router, so `identify()` decides owner or reviewer, and the listener (`via`) decides what each may be:

- **Owner:** the owner cookie, on loopback, the tailnet or an added listener. Never on the local-network listener (`isOwner` already returns false there).
- **Reviewer:** a device cookie whose scope reaches the page, on any listener. `/tool` joins the reviewer allowlist in `handle()` (`sub === "/tool"` exactly; the approval routes below stay owner-only).
- A foreign `Origin` gets 403 (`checkOrigin`). There is no `/api/*` form of this route except `source test` (below).

Request (JSON, at most 16 KB, `readBody(req, 16 * 1024)`):

```json
{ "name": "btc-hourly", "args": { "symbol": "BTC" } }
```

- `name`: `^[a-z][a-z0-9-]{0,39}$`.
- `args`: a JSON object, or absent (`{}`).

Success, 200:

```json
{ "ok": true, "data": <JSON>, "fetchedAt": "2026-11-27T07:00:00.000Z", "cached": false, "kind": "http" }
```

`kind` is `"http"` or `"script"`. `data` is at most 1 MB serialized. The chrome passes `data`, `fetchedAt` and `cached` to the frame.

Errors use the server's existing shape, `{ "error": "<text>", "code": "<code>" }`, with lowercase codes as `attach` and runs use them. A reviewer gets the code and a generic text; only the owner gets details (an environment variable's name, an upstream status, a script's stderr tail).

| Status | `code` | When |
|---|---|---|
| 400 | `bad_request` | `name` does not match, `args` not an object, an HTTP source argument not declared or not a string, number or boolean |
| 403 | — | foreign `Origin` (existing text) |
| 403 | `owner_only` | a reviewer, the source not opted in for reviewers, and no cached result for these arguments |
| 404 | `unknown_tool` | the name is not a `Query` name in the page's current program, or no source or script folder has it |
| 409 | `not_approved` | a script with no approval, or its folder's hash differs from the approved one. The owner's body adds `hash` so the chrome can open the approval dialog |
| 409 | `script_unsafe` | the script folder holds a symlink, a file with more than one hard link, or breaks a folder limit |
| 413 | — | body over 16 KB (existing `readBody` text) |
| 429 | `rate_limit` | a limit in [Limits](#limits) |
| 501 | `isolation_unavailable` | a script call on Node older than 25 |
| 502 | `upstream_failed` | upstream non-2xx, a redirect, a network error. Owner text names the status |
| 502 | `upstream_not_json` | upstream body is not JSON, or the `--map` pointer finds nothing |
| 502 | `too_large` | upstream body, script stdout, or `data` over 1 MB |
| 502 | `script_failed` | the script exited non-zero or was killed for memory. Owner text: the last 2 KB of stderr |
| 502 | `bad_output` | the script's stdout is not one JSON value |
| 503 | `env_missing` | a `--header-env` variable is not set in the server's environment. Owner text names the variable, never a value |
| 503 | `busy` | the machine's script slots are full |
| 504 | `timeout` | upstream past 10 s, or the script past its `timeoutSeconds` |

Not idempotent in general (a script may call out), so the chrome never retries.

### Cache

- In memory only; a restart empties it. Key: kind, name, the canonical JSON of `args`, and for a script its folder hash. At most 200 entries, least recently used dropped first.
- One fetch or run at a time per key: a call that finds the same key in flight waits for it (single flight). This is "one poll for every viewer": the server never polls on its own timer; viewers' `Query` refreshes drive it.
- HTTP: a cached result younger than the source's `minInterval` is returned with `cached: true`, to the owner too.
- Script: the owner's call always runs (or joins the run in flight). A reviewer's call gets the newest cached result for the same arguments unless the script is opted in for reviewers.

### Limits

| Limit | Value |
|---|---|
| Request body | 16 KB |
| `data`, upstream body, script stdout | 1 MB each |
| Calls per viewer per page | 60 a minute (`rate_limit`). A viewer is the owner, or one reviewer device |
| HTTP: upstream fetches per source | one per key per `minInterval` (default 30 s, floor 5 s); at most 240 an hour per source |
| HTTP: upstream timeout | 10 s; redirects are not followed |
| Script: runs per script | 60 an hour, owner and opted-in reviewers together |
| Script: at once on the machine | 2 (`busy`) |
| Script: wall clock | manifest `timeoutSeconds`, default 30, at most 300; the process tree is killed (`killTree`, `src/cli/dispatch.ts`) |
| Script: memory | manifest `memoryMb`, default 256, at most 2048, as `--max-old-space-size`. That caps the V8 heap, not buffers outside it |
| Script: stderr kept | the last 64 KB, never shown to a reviewer |
| Script folder | at most 200 files, 20 MB, depth 4 |

## HTTP sources

### CLI

```
austere-axi source add <name> <url> [--arg <name>]... [--header-env <Header>=<ENV>]... [--map <json-pointer>] [--min-interval <seconds>] [--reviewers]
austere-axi source remove <name>
austere-axi source list
austere-axi source test <name> [--arg <name>=<value>]...
```

- **Terminal only:** `add` and `remove` decide which host gets a key, so without a terminal they exit 2, change nothing and print the command for the user to run, as `registry add` and `trust add` do. `add` on an existing name replaces it. No MCP tool for either.
- `<url>`: `http:` or `https:`, no user info, no fragment (refused like a registry URL with credentials, `src/cli/registries.ts`). Its query string stays; each `--arg` adds `name=value` to it at call time.
- `--arg <name>`: an argument a page may pass. Undeclared arguments are `bad_request`. Values are strings, numbers or booleans, at most 200 characters.
- `--header-env <Header>=<ENV>`: the request gets header `<Header>` with the value of environment variable `<ENV>` in the server's environment, verbatim (a bearer token is `Authorization=MY_AUTH` with `MY_AUTH="Bearer …"`). `<ENV>` matches the registry `--token-env` rule. `Host`, `Cookie` and `Content-Length` are refused as header names.
- `--map <json-pointer>`: RFC 6901 pointer into the upstream JSON; `data` is what it points at. Default: the whole body.
- `--min-interval`: seconds a result is reused for; default 30, floor 5.
- `--reviewers`: reviewers' calls may fetch too (D5).
- `list`: anywhere, read-only; an agent may run it. Prints name, URL, args, header names with their variable names, map, interval, reviewers. Never a variable's value. With a server running, it adds `env: set|missing` per variable as the server sees it.
- `test`: anywhere; needs the server. Calls the source as the owner would (same cache and limits) through `POST /api/sources/test` (loopback and owner key, like every `/api/*` route) and prints the result's shape and the first 2 KB. This is how an agent learns the data shape before it writes the page.

### Registry file

`<state>/sources.json`, mode 0600, written whole through `writeJsonAtomic` (`src/cli/packs.ts`), read only from the state dir. A malformed file throws, naming itself, as `trusted.json` does.

```json
{
  "format": 1,
  "sources": {
    "btc-hourly": {
      "url": "https://api.example.com/v1/candles?interval=1h",
      "args": ["symbol"],
      "headers": { "X-Api-Key": "EXAMPLE_API_KEY" },
      "map": "/data",
      "minInterval": 30,
      "reviewers": false
    }
  }
}
```

### Keeping keys out

- The file holds variable names, never values. The server reads the value from its own `process.env` at fetch time. For `server install` or Docker, the variable must be in that unit's or container's environment; `source list` shows `missing` when it is not.
- Keys travel only in headers (no `--query-env` in v1), so the URL, the cache key and the log never hold one. The log records the source name, status and duration, never the URL's query.
- Redirects are not followed (`redirect: "manual"`, a 3xx is `upstream_failed`): a custom header would otherwise follow the redirect to another host.
- Before caching, the server replaces each occurrence of a header value in the upstream text with `***`, so an API that echoes the request does not hand the key to the page.
- The page file never holds a key or a URL: it names the source only. `export` (below) writes `data`, never the source's settings.

## Script sources

### Layout

```
reports/
  backtest.html
  .austere-tools/
    backtest/
      index.mjs      entry: reads JSON on stdin, writes one JSON value on stdout
      tool.json      optional manifest
      prices.csv     any data the script reads (pinned with the code)
```

`tool.json`, every field optional:

```json
{ "net": false, "timeoutSeconds": 30, "memoryMb": 256 }
```

The manifest is in the pinned folder, so what it asks for is part of what the owner approves.

### Pin and approval

- **Hash:** for every regular file under the folder, sorted by its relative POSIX path, a line `<path>\0<size>\0<sha384 hex>\n`; the pin is `sha384-<base64>` of those lines, the SRI form pack integrity uses (`sri()` in `src/cli/install.ts`). The walk uses `lstat` and fails with `script_unsafe` on a symlink, a file with `nlink > 1`, or a folder limit. It runs on every call, before the spawn. Any change to code, manifest or data needs approval again (D2).
- **Approval file:** `<state>/approved-scripts.json`, mode 0600, `writeJsonAtomic`, keyed by the folder's real path:

```json
{
  "format": 1,
  "scripts": {
    "/home/me/src/shop/reports/.austere-tools/backtest": {
      "hash": "sha384-…",
      "reviewers": false,
      "approvedAt": "2026-11-27T07:00:00.000Z"
    }
  }
}
```

- **Review UI:** a script call that answers `not_approved` to the owner opens a dialog in the chrome: the script's files and sizes, the text of `.mjs`, `.js`, `.cjs` and `.json` files (first 256 KB in all), the manifest in words ("Network: none" or "Network: everything, including services on this computer"), and a "Reviewers may run it" checkbox. Reviewers never see the dialog.
- Owner-only routes, `checkOrigin`, not in the reviewer allowlist:
  - `GET /s/:id/tool/<name>/review` → `{ name, hash, files: [{ path, size }], code: [{ path, text }], manifest, approved: { hash, reviewers } | null, isolation: { node: string, ok: boolean } }`.
  - `POST /s/:id/tool/<name>/approve` `{ hash, reviewers }` → 200 `{ ok: true }`, or 409 `changed` when the folder's hash now differs from `hash` (the owner approves exactly what was shown).
  - `POST /s/:id/tool/<name>/revoke` → 200 `{ ok: true }`.
- No CLI approve in v1. `source list` also lists approved scripts. `check` warns about a page whose script is not approved, and fails one whose script name is a registered source (D7).

### Run

```
<process.execPath> --permission --allow-fs-read=<real folder> [--allow-net] --max-old-space-size=<memoryMb> index.mjs
```

- `cwd` the real folder; `env: {}` (scrubbed: no `PATH`, no `HOME`, no keys); stdin `{"args": …}` then closed; stdout and stderr are pipes; no other descriptors.
- No `--allow-child-process`, `--allow-worker`, `--allow-addons`, `--allow-wasi`, `--allow-inspector`, `--allow-fs-write`.
- `--allow-net` only when the manifest says `"net": true` (D4).
- Exit 0 and one JSON value on stdout: success. Anything else: the codes in the table above.
- Node older than 25 (`process.versions.node`): no spawn, `isolation_unavailable` (D1).

### Isolation, measured

Probed 2026-11-27 on Linux x64 with `--permission --allow-fs-read=<dir> --allow-fs-write=<dir>/out`, `env: {}`, against a loopback HTTP server and a Unix socket outside the folder:

| Attempt from the script | 22.23.5 | 24.22.3 | 25.9.0 | 26.13.1 |
|---|---|---|---|---|
| Read a file in its folder | allowed | allowed | allowed | allowed |
| Read or list outside its folder | blocked | blocked | blocked | blocked |
| `import()` a module outside its folder | blocked | blocked | blocked | blocked |
| Read through a symlink already in its folder that points outside | **allowed** | **allowed** | **allowed** | **allowed** |
| Create a symlink or hard link (in a writable dir) | blocked | blocked | blocked | blocked |
| Write in its folder without `--allow-fs-write` | blocked | blocked | blocked | blocked |
| `child_process`, `worker_threads`, addons, `process.binding`, inspector | blocked | blocked | blocked | blocked |
| `fetch`, TCP connect, Unix socket connect, listen, UDP, DNS | **allowed** | **allowed** | blocked | blocked |
| `process.kill(<parent pid>, 0)`: may signal a same-user process | **allowed** | **allowed** | **allowed** | **allowed** |
| Read `process.env` | allowed (empty, since `env: {}`) | same | same | same |
| WebAssembly | allowed | allowed | allowed | allowed |

What follows from it:

- **No network needs Node 25+.** `--allow-net` was added in Node 25.0.0 (docs: Stability 1.1, active development). On 22 and 24 the permission model leaves the whole network open, so D1 refuses to run scripts there rather than claim isolation it lacks.
- **Docker is not required** for the "no network" acceptance; Node 26's permission model meets it. The repo's own Docker setup would not meet it anyway: `compose.yaml` runs with `network_mode: host` and `pid: host`. A per-run container (`--network none`) would be stronger, but the server would need the Docker socket, which is root on the host. Not in v1.
- **Symlinks:** Node follows symlinks out of an allowed path (its documented known issue). The pre-run walk refuses a folder with any symlink or hard-linked file; the script cannot make either, because it has no write permission.
- **Signals:** a script can signal any process of the same user, the server included. That is a denial of service, not a read or a leak. Known gap; only an OS boundary (another user, a container) closes it.
- **Seat belt, not a sandbox:** Node's docs say the permission model "does not provide security guarantees in the presence of malicious code". The security gate is the owner's approval of an exact hash; the permission flags stop an approved script from doing more than it looks like it does. `docs/security.md` says this plainly.
- Not measured here: Windows (CI runs Node 24 there, so scripts answer `isolation_unavailable` on that leg).

## Export and hosted pages

- "Download standalone HTML" from the review page (`/export`) adds the newest cached result per tool name of the page as `<script type="application/json" id="austere-tool-snapshot">{"takenAt": …, "results": {"<name>": <data>}}</script>`, with `<` escaped as `\u003c`. Without a bridge, the runtime's `toolProvider` answers those names from the snapshot and shows one line: "Data snapshot from <date>. Live data needs the review server."
- `austere-axi export` at a terminal has no cache; it adds a notice ("live sources: no data snapshot; download from the review page for one") through `exportHtml`'s `notices`.
- Hosted pages answer `unavailable` (see Bridge). No snapshot there in v1.

## Contract changes and compatibility

- **Bridge:** two message types added. Older chromes ignore `tool-call`; the frame times out the call and shows the error state.
- **Server:** `/s/:id/tool`, its three approval routes, and `/api/sources/test` are new. The reviewer allowlist gains `/tool`.
- **CLI:** `source add|remove|list|test` are new. `check` gains two rules (unknown tool name, script name clash).
- **State:** two new files, `sources.json` and `approved-scripts.json`. No `hub.db` change, no `SCHEMA_VERSION` bump. `PACK_API`, `CATALOG_FORMAT` and `SYNC_VERSION` do not change.
- **Rule change:** AGENTS.md's "nothing an installed pack ships runs in the CLI or the server" stays true for packs. A new rule joins it: a page's script runs on the server only with the owner's approval of its exact hash, on Node 25+, with the flags above.
- **Rollback:** an older austere-axi ignores both files; a page that calls a server tool shows the Query error state. Deleting the files removes every source and approval.

## Build slices

Each slice is one PR, verified on its own. Both wait for RLM-488.

1. **HTTP source.** Bridge messages and chrome forwarding (`busy`, `timeout`, hosted and playground `unavailable`); `/s/:id/tool` for HTTP; `source add|remove|list|test` and `sources.json`; cache and limits; the export snapshot; `check`'s unknown-name rule; docs (`docs/cli.md`, `docs/security.md`, `AGENTS.md`, README "What it does not do yet"); `src/runtime/prompt.ts` tells the agent how to name a source; example: a live line chart from a keyless public API whose JSON already holds a series (Open-Meteo hourly, say).
2. **Script source.** `.austere-tools/` hashing and the walk; `approved-scripts.json`; the review, approve and revoke routes and the chrome dialog; the runner and its limits; the Node 25 gate; `check`'s clash rule and unapproved warning; `Dockerfile` default `NODE_VERSION` to 26 so the image can run scripts; docs; example: a backtest page whose form runs an approved script.

## Test plan

Server tests start the server on an ephemeral port with `AUSTERE_AXI_STATE_DIR` set, and a local fake upstream; no test touches the internet.

Slice 1:

- `sources.json`: malformed file names itself; bad name, URL with user info, bad env name, `Host` header refused.
- `source add` without a terminal exits 2 and writes nothing.
- Owner call returns `data` at `--map`; the upstream saw the header; neither the response, the page file, the export nor the log holds the key's value; an upstream that echoes the header comes back with `***`.
- Two calls within `minInterval`, and two concurrent calls: the upstream sees one request.
- Name not in the program, and a name not registered: `unknown_tool`. Undeclared argument: `bad_request`. Redirect: `upstream_failed`, the redirect target sees no request. Oversized body: `too_large`. Unset variable: `env_missing`. Rate limit: 429.
- Reviewer: cached result for the same arguments; none and not opted in: `owner_only`; opted in: fetches. Owner cookie on the local-network listener is treated as no owner (existing rule, one assertion). Foreign `Origin`: 403.
- Browser test: the live chart page re-renders with the fake upstream's new value after its refresh interval.

Slice 2 (assertions on Node 25+; on 22 and 24 the same calls assert `isolation_unavailable`):

- Unapproved: `not_approved` with `hash`. Approve with that hash, then the call runs. Change any file (code, manifest, data): `not_approved` again. Approve with a stale hash: `changed`.
- The script's `fetch` and `net.connect` to a test server on loopback fail inside the script, and the test server counts zero connections. Reading `../secret` fails. A symlink or hard link in the folder: `script_unsafe`, and the script did not start.
- `Object.keys(process.env)` is empty. An endless loop with `timeoutSeconds: 1` is `timeout` and the process is gone. stdout over 1 MB: `too_large`. Heap past `memoryMb`: `script_failed`. Non-JSON stdout: `bad_output`.
- Reviewer: not opted in gets the cache or `owner_only`; opted in runs.
- `npm test`, `npm run typecheck`, `npm run lint`, `npm run format:check`, `npm run test:browser`.

## Not in v1

Filesystem writes for scripts, a host allowlist for `net`, keys in the query string (`--query-env`), a CLI `source approve`, a separate Node binary for scripts on an older server, per-run containers, streaming partial results, snapshots for hosted pages.
