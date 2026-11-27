# Server-backed sources: design

Status: Proposed 2026-11-27 (RLM-489), revised the same day after review on PR #160. This is a spec only; nothing here is built. The build waits for RLM-488 (the page's `toolProvider` and `Query` wiring), which this note assumes. **D1–D8 are open: Sid decides them before the build starts.** Names and line numbers are from 0.26.0 (`85527b9`).

## Problem

A page cannot get data from the server. The frame has an opaque origin and the `sandbox` CSP, so `fetch` works only for APIs that answer `Origin: null`, and a key in the page is a key in a file. Heavy runs (large data, many symbols, network, secrets) need code on the server, and today nothing a page or a pack ships runs there.

This note adds two kinds of server tool that a page calls with `Query`:

- **HTTP source:** a URL the owner registered at a terminal. The server fetches it, adds a key from an environment variable, and caches the result for every viewer.
- **Script source:** a Node script the agent writes next to the page. The server runs a private copy of it in a subprocess under Node's permission model, only when the owner approved its exact hash.

## Decisions (open for Sid)

| # | Decision (proposed) |
|---|---|
| D1 | Script sources need **Node 26 or later** on the server, on Linux or macOS, and a passing isolation canary (see [Run](#run)). Otherwise every script call answers `isolation_unavailable` and nothing runs. Node 25 also has `--allow-net`, but it reached end of life on 2026-06-01. Windows is refused in v1 because it has no memory watchdog, no `O_NOFOLLOW`, and was not measured. Docker is not required. See [Isolation](#isolation-measured). |
| D2 | A script lives in `.austere-tools/<name>/` next to the page, with entry `index.mjs`. The pin is a hash over every file in that folder. A dot-folder is never served to the frame or a reviewer (`resolveSibling`, `src/cli/assets.ts`). |
| D3 | Scripts cannot write to the filesystem in v1. A script returns its result on stdout. |
| D4 | `"net": true` in a script's manifest means the whole network, including this machine's loopback services and Unix sockets. Node has no host allowlist. The approval dialog says this in those words. |
| D5 | By default a reviewer's call never starts work. It gets the cached result for the same arguments, or `owner_only`. The owner opts a source in for reviewers with `source add --reviewers` (HTTP) or a checkbox in the approval dialog (script). Opted-in reviewers have their own budget and cache quota, separate from the owner's. Both places tell the owner that reviewers see cached results of the owner's own calls even without the opt-in. |
| D6 | A tool name must appear as a `Query` tool name in the page's current program; any other name gets `unknown_tool`. This rule prevents mistakes; it is not a security boundary, because the page is untrusted input. The boundaries are the terminal-only registry and the hash approval. |
| D7 | Names resolve in this order: a tool the page ships (RLM-488, in the frame), then a registered HTTP source, then a script folder. `check` fails a page whose script name is also a registered source name. |
| D8 | The server stores a script's approval in the state dir, never in the project, so a cloned repo cannot approve its own script (the same rule as `trusted.json`). |

## Bridge: `tool-call` and `tool-result`

The frame's `toolProvider` (RLM-488) handles the tools the page ships itself. For any other name, it sends `tool-call` to the chrome. Both messages carry `austere: 1`, like every bridge message (`src/runtime/index.tsx`).

```ts
// FrameToChrome, added
| { type: "tool-call"; id: string; name: string; args: unknown }

// ChromeToFrame, added
| { type: "tool-result"; id: string; ok: true; data: unknown; fetchedAt: string; cached: boolean }
| { type: "tool-result"; id: string; ok: false; code: string; message: string }
```

- `id`: chosen by the frame, at most 64 characters. The chrome echoes it back.
- The chrome (`src/chrome/review-frame.ts`) checks that `id` and `name` are strings, posts `{ name, args }` to `/s/:id/tool`, and answers with `tool-result`. A frame can have at most 4 calls in flight; a fifth gets `code: "busy"` at once. The chrome gives up after 330 s (`timeout`). The frame gives up after 340 s, so a chrome that predates this message cannot hang a Query.
- Hosted pages (`HOSTED`) and the playground (`site/play/play.ts`) have no server, so they answer every `tool-call` with `code: "unavailable"`. AGENTS.md requires the playground to change together with the bridge.
- The frame shows `ok: false` as the Query's error state and never retries on its own. `Query`'s own `refreshSeconds` is the only repeat.
- On `not_approved`, the owner's chrome shows a banner; see [Pin and approval](#pin-and-approval).

## Route: `POST /s/:id/tool`

The route sits under the session router. `identify()` decides whether the caller is the owner or a reviewer, and the listener (`via`) limits what each can be:

- **Owner:** the owner cookie, on loopback, the tailnet, or an added listener. Never on the local-network listener (`isOwner` already returns false there).
- **Reviewer:** a device cookie whose scope reaches the page, on any listener. `/tool` joins the reviewer allowlist in `handle()` as an exact match (`sub === "/tool"`). The approval routes below and `/export` stay off the reviewer allowlist.
- A foreign `Origin` gets 403 (`checkOrigin`). This route has no `/api/*` form; the only related `/api/*` route is `source test` (below).

Request (JSON, at most 16 KB, `readBody(req, 16 * 1024)`, which already stops reading at the cap):

```json
{ "name": "btc-hourly", "args": { "symbol": "BTC" } }
```

- `name`: `^[a-z][a-z0-9-]{0,39}$`.
- `args`: a JSON object, or absent (treated as `{}`).

### Which names a page may call (D6)

The server reads the page's current program from disk, using the same file and the same parse that `check-program` uses (`src/shared/check-program.ts`). A name counts when it is the first argument of a `Query` call and that argument is a string literal. Text in comments, other strings, or computed arguments does not count. A page's author controls this list completely, so it only guards against mistakes, such as a typo or a stale page calling a source that has since been registered for something else.

### Success, 200

```json
{ "ok": true, "data": <JSON>, "fetchedAt": "2026-11-27T07:00:00.000Z", "cached": false, "kind": "http" }
```

`kind` is `"http"` or `"script"`. `data` is at most 1 MB serialized. The chrome passes `data`, `fetchedAt` and `cached` on to the frame.

### Errors

Errors use the server's existing shape, `{ "error": "<text>", "code": "<code>" }`, with lowercase codes, as `attach` and runs already do. A reviewer gets only the code and a generic text. Only the owner gets details: an environment variable's name, an upstream status, or a script's stderr tail. Owner-visible text goes through the same key redaction as `data` (see [Keeping keys out](#keeping-keys-out)).

| Status | `code` | When |
|---|---|---|
| 400 | `bad_request` | `name` does not match the pattern; `args` is not an object; an HTTP source argument is not declared, or is not a string, number or boolean |
| 403 | — | foreign `Origin` (existing text) |
| 403 | `owner_only` | a reviewer calls a source not opted in for reviewers, and there is no cached result for these arguments |
| 404 | `unknown_tool` | the name is not a `Query` name in the page's current program, or no source or script folder has it |
| 409 | `not_approved` | a script with no approval, or whose folder hash differs from the approved hash. The owner's response also includes `hash`, which the chrome uses for its banner |
| 409 | `script_unsafe` | the script folder holds a symlink or a file with more than one hard link, or breaks a folder limit |
| 413 | — | body over 16 KB (existing `readBody` text) |
| 429 | `rate_limit` | a limit in [Limits](#limits) is reached |
| 501 | `isolation_unavailable` | a script call when D1 does not hold: Node older than 26, Windows, or a failed canary |
| 502 | `upstream_failed` | upstream answered non-2xx or a redirect, or a network error occurred. Owner text names the status |
| 502 | `upstream_not_json` | the upstream body is not JSON, or the `--map` pointer finds nothing |
| 502 | `too_large` | the upstream body (decompressed), the script's stdout, or `data` is over 1 MB |
| 502 | `memory_limit` | the memory watchdog killed the script (resident memory above its cap) |
| 502 | `script_failed` | the script exited non-zero, including V8's own heap-limit abort. Owner text: the last 2 KB of stderr |
| 502 | `bad_output` | the script's stdout is not one JSON value |
| 503 | `env_missing` | a `--header-env` variable is not set in the server's environment. Owner text names the variable, never a value |
| 503 | `busy` | no script slot is free for this caller (see Limits) |
| 504 | `timeout` | upstream took longer than 10 s, or the script ran past its `timeoutSeconds` |

The route is not idempotent in general (a script may call out), so the chrome never retries.

### Cache

- The cache is in memory only; a restart empties it. Its key is: kind, name, the canonical JSON of `args`, and a **config hash**. For HTTP, the config hash is the sha256 of the source's canonical entry in `sources.json`. For a script, it is the approved folder hash. A changed URL, header, map or approval therefore never matches an old entry.
- The server reads `sources.json` on every HTTP call (it is a small file, like the trust list). When a source's config hash changes, or the source is gone, the server purges every cache entry for that name. Revoke and approve purge every entry for that script.
- One fetch or run happens at a time per key. A call that finds the same key in flight waits for that one (single flight). This is "one poll for every viewer": the server never polls on its own timer, and viewers' `Query` refreshes drive it.
- **Quota:** 200 entries in total, evicted least recently used first. At most 50 of them may be entries that a reviewer's call created. When a reviewer's call would add a 51st, the least recently used reviewer-created entry goes first. A reviewer's call never evicts an entry the owner created, so changing arguments cannot flush the owner's cache.
- HTTP: a cached result younger than the source's `minInterval` is returned with `cached: true`, to the owner too.
- Script: the owner's call always runs, or joins the run already in flight. A reviewer's call that is not opted in gets the newest cached result for the same arguments. Before it serves that cached result, the server hashes the live folder (the walk in [Pin and approval](#pin-and-approval), without the copy). The hash must equal the approved hash; otherwise the answer is `not_approved`. A cache hit never skips this check.

### Limits

Owner and reviewers have separate budgets. "Reviewers" means every reviewer device together, so one reviewer can use up the reviewers' budget but never the owner's.

| Limit | Value | Where it is enforced |
|---|---|---|
| Request body | 16 KB | `readBody` stops reading at 16 KB (413) |
| Calls per viewer per page | 60 a minute (`rate_limit`). A viewer is the owner, or one reviewer device | route, before any work |
| HTTP: upstream fetches per source | one per key per `minInterval` (default 30 s, floor 5 s); at most 240 an hour for the owner and 60 an hour for reviewers | route, before the fetch |
| HTTP: upstream timeout | 10 s; redirects are not followed | `AbortSignal.timeout`, `redirect: "manual"` |
| HTTP: upstream body | 1 MB, decompressed | a `Content-Length` over 1 MB is refused before the body is read. Otherwise the server counts decoded bytes as they stream from `response.body` and aborts the fetch once the total passes 1 MB. This also stops a compression bomb at 1 MB of output |
| Script: runs per script | 60 an hour for the owner; 20 an hour for reviewers when opted in | route, before the copy |
| Script: at once on the machine | 2. Reviewers may hold at most 1 of them, so the owner always has one (`busy`) | route, before the copy |
| Script: wall clock | manifest `timeoutSeconds`, default 30, at most 300. The process tree is killed (`killTree`, `src/cli/dispatch.ts`) | runner timer |
| Script: memory | manifest `memoryMb`, default 256, at most 2048. Applied twice: as `--max-old-space-size=<memoryMb>`, and by an RSS watchdog that kills the tree when resident memory passes `memoryMb + 64` MB (`memory_limit`). See [Memory](#memory-a-partial-cap) | `node` flag, plus a runner poll every 200 ms |
| Script: stdout | 1 MB | the runner counts bytes on each `data` event; past 1 MB it kills the tree and answers `too_large` |
| Script: stderr | the last 64 KB is kept. The runner drains stderr into a 64 KB ring buffer, so stderr volume never grows server memory. Stderr is never shown to a reviewer | runner |
| Script folder | at most 200 files, 20 MB in total, depth 4; at most 2 MB of text (see [Pin and approval](#pin-and-approval)) | walk, before the copy |

## HTTP sources

### CLI

```
austere-axi source add <name> <url> [--arg <name>]... [--header-env <Header>=<ENV>]... [--map <json-pointer>] [--min-interval <seconds>] [--reviewers]
austere-axi source remove <name>
austere-axi source list
austere-axi source test <name> [--arg <name>=<value>]...
```

- **Terminal only:** `add` and `remove` decide which host gets a key. Without a terminal they exit 2, change nothing, and print the command for the user to run, as `registry add` and `trust add` do. `add` on an existing name replaces that entry. There is no MCP tool for either command.
- `<url>`: `http:` or `https:`, with no user info and no fragment. It is refused like a registry URL with credentials (`src/cli/registries.ts`). Its query string is kept as registered.
- `--arg <name>`: an argument a page may pass. The name must match `^[A-Za-z][A-Za-z0-9_]{0,39}$`. `add` refuses an `--arg` name that is already a key in the URL's query string. A call cannot replace or remove a registered query key, and the upstream never sees a duplicate key that it would have to pick a winner from.
  - At call time, the server builds the URL with `new URL(url)` and then calls `url.searchParams.append(name, String(value))` for each declared argument the call passes. Both names and values are percent-encoded by `URLSearchParams`, never joined as strings. A value of `x&apikey=1#` reaches the upstream as one value of its own key.
  - Values are strings, numbers or booleans, at most 200 characters. An undeclared argument is `bad_request`.
- `--header-env <Header>=<ENV>`: the request gets header `<Header>` set to the value of environment variable `<ENV>` in the server's environment, verbatim. For a bearer token, use `Authorization=MY_AUTH` with `MY_AUTH="Bearer …"`. `<ENV>` follows the registry `--token-env` rule. `Host`, `Cookie` and `Content-Length` are refused as header names.
- `--map <json-pointer>`: an RFC 6901 pointer into the upstream JSON; `data` is the value it points at. The default is the whole body.
- `--min-interval`: how many seconds a result is reused for. Default 30, floor 5.
- `--reviewers`: reviewers' calls may fetch too (D5). Without it, `add` prints: "Reviewers can see results you fetch, for the same arguments, even without --reviewers."
- `list`: works anywhere and is read-only; an agent may run it. It prints the name, URL, args, header names with their variable names, map, interval and reviewers setting, never a variable's value. With a server running, it adds `env: set|missing` per variable, as the server sees it.
- `test`: works anywhere but needs the server. It calls the source as the owner would, with the same cache and limits, through `POST /api/sources/test` (loopback and owner key, like every `/api/*` route). It prints the result's shape and the first 2 KB. An agent uses it to learn the data shape before writing the page.

### Registry file

`<state>/sources.json`, mode 0600, written whole through `writeJsonAtomic` (`src/cli/packs.ts`) and read only from the state dir. A malformed file throws an error that names the file, as `trusted.json` does.

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

- The file holds variable names, never values. The server reads each value from its own `process.env` at fetch time. Under `server install` or Docker, the variable must be in that unit's or container's environment; `source list` shows `missing` when it is not.
- Keys travel only in headers (there is no `--query-env` in v1), so the URL, the cache key and the log never hold one. The log records the source name, status and duration, never the URL's query.
- Redirects are not followed (`redirect: "manual"`; a 3xx is `upstream_failed`). Otherwise a custom header would follow the redirect to another host.
- **Echo redaction, best effort.** After the body is parsed and `--map` is applied, the server walks every string in `data`, keys and values alike, plus the owner-visible error text. It replaces each of these with `***`:
  - each header value, as is;
  - each header value's `encodeURIComponent` form;
  - each header value's standard and URL-safe base64 forms;
  - each whitespace-separated token of 8 or more characters inside a header value (the bare token of `Bearer <token>`), in the same three forms.

  Because this runs after `JSON.parse`, JSON escapes (`\/`, `\"`, `\uXXXX`) are already decoded and match. **Limit:** this does not close every leak. A key echoed in any other form (base64 of a longer string that contains it, hex, hashed, split, or a token shorter than 8 characters) reaches the cache and the page. An upstream that echoes credentials is not safe to register. `docs/security.md` says so.
- The page file never holds a key or a URL; it names the source only. The export (below) writes `data`, never the source's settings.
- **Known risk, as with `trust add`:** the terminal check is `process.stdin.isTTY`. An agent running in a pty can pass it, register a source whose `--header-env` names any variable in the server's environment, and read that value back through `source test` against a URL it controls. This is the same class as `trust add` and `registry add --token-env`, and `docs/security.md` states it.

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

- **Walk:** the server visits each entry under the folder with `lstat`. A symlink, a file with `nlink > 1`, or a folder limit gives `script_unsafe`. It opens each regular file with `O_RDONLY | O_NOFOLLOW` and `fstat`s the descriptor; the fstat must still show a regular file with `nlink === 1`. It then reads the bytes from that descriptor. A file swapped for a symlink between the `lstat` and the `open` fails the `open` instead of being followed.
- **Hash:** for every file, sorted by its relative POSIX path, the server builds a line `<path>\0<size>\0<sha384 hex of the bytes read>\n`. The pin is `sha384-<base64>` of those lines: the SRI form that pack integrity uses (`sri()` in `src/cli/install.ts`). Any change to code, manifest or data needs approval again (D2).
- **Text and binary:** a file is text when its bytes are valid UTF-8 with no NUL byte; every other file is binary. A folder may hold at most 2 MB of text in total.
- **Approval file:** `<state>/approved-scripts.json`, mode 0600, written with `writeJsonAtomic`, keyed by the folder's real path:

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

- **Banner, then dialog.** A `not_approved` answer to the owner never opens a dialog by itself. The chrome shows a banner above the page: "This page wants to run the script `<name>` on this computer." with a **Review** button. Only the owner's click opens the dialog. The banner appears at most once per script hash per review-tab session (`sessionStorage`). Once dismissed, it does not come back for that hash until the tab is reloaded, however often the page calls. Reviewers never see the banner or the dialog.
- **Dialog.** The dialog shows:
  - every file with its path and size;
  - **every text file in full**;
  - each binary file marked "not shown", with its size and sha384;
  - the manifest in words: "Network: none", or "Network: everything, including services on this computer";
  - a "Reviewers may run it" checkbox, with this fixed line under it: "Reviewers can see results of runs you start, for the same arguments, even if this box is off."

  If the folder holds a binary file, the dialog also shows a second checkbox: "I approve N files I have not seen", listing them. Approve stays disabled until that box is ticked. Approve also stays disabled when the folder breaks the 2 MB text limit, with the reason "Too much text to review in full; make the folder smaller." The server enforces both rules itself (below), so a chrome bug cannot skip them.
- **Owner-only routes**, behind `checkOrigin` and off the reviewer allowlist:
  - `GET /s/:id/tool/<name>/review` → `{ name, hash, files: [{ path, size, sha384, text: boolean }], text: [{ path, content }], unseen: [path], reviewable: boolean, manifest, approved: { hash, reviewers } | null, isolation: { node: string, ok: boolean } }`. `text` holds every text file in full. `reviewable` is false when the text limit is broken; `text` is then empty.
  - `POST /s/:id/tool/<name>/approve` with body `{ hash, reviewers, confirmUnseen }` → 200 `{ ok: true }`. Errors, all 409:
    - `changed`: a fresh walk's hash differs from `hash`;
    - `not_reviewable`: the text limit is broken;
    - `confirm_unseen`: the folder holds binary files and `confirmUnseen` is not `true`.
  - `POST /s/:id/tool/<name>/revoke` → 200 `{ ok: true }`.
- There is no CLI approve in v1. `source list` also lists approved scripts. `check` warns about a page whose script is not approved, and fails a page whose script name is a registered source (D7).

### Run

1. **Gate (D1).** On Node older than 26, on Windows, or after a failed canary, the answer is `isolation_unavailable` and nothing below runs.
2. **Canary, once per server process,** before the first script run. The server opens a TCP listener on `127.0.0.1:0` and writes a sentinel file outside the canary's folder. It then spawns `process.execPath --permission --allow-fs-read=<canary dir> canary.mjs` with the same flags as a real run, minus `--allow-net`. The canary tries to connect to the listener and to read the sentinel, and reports both results on stdout. The canary fails when either attempt succeeds, the listener counted a connection, or the child does not exit 0 within 5 s. The result holds for the life of the process and is logged once. This catches a Node release whose `--allow-net` or fs rules regress (`--allow-net` is Stability 1.1).
3. **Copy, hash, compare.** The server creates `mkdtemp(<state>/script-runs/)` (mode 0700, inside the 0700 state dir). The walk above writes each file's bytes into the copy as it reads them, and the hash is computed over exactly those bytes. If the hash differs from the approved hash, the server deletes the copy and answers `not_approved`. The script that runs is therefore the bytes that were hashed. Edits to the live folder during or after the walk have no effect on this run. Hashing and running the same copy closes the window between approving one version and running another.
4. **Spawn:**

   ```
   <process.execPath> --permission --allow-fs-read=<copy> [--allow-net] --max-old-space-size=<memoryMb> index.mjs
   ```

   - The working directory is the copy. The environment is `env: {}` (scrubbed: no `PATH`, no `HOME`, no keys). Stdin receives `{"args": …}` and is then closed. Stdout and stderr are pipes, and the child gets no other descriptors.
   - Never passed: `--allow-child-process`, `--allow-worker`, `--allow-addons`, `--allow-wasi`, `--allow-inspector`, `--allow-fs-write`.
   - `--allow-net` is passed only when the manifest says `"net": true` (D4).
5. **Watch:** the wall-clock timer, the stdout byte count, the stderr ring buffer and the RSS watchdog, as listed in [Limits](#limits).
6. **Result:** exit 0 with one JSON value on stdout is success; anything else maps to a code in the error table.
7. **Clean up:** the copy is deleted in a `finally` block. The server also deletes anything left in `<state>/script-runs/` when it starts.

### Memory: a partial cap

`--max-old-space-size` caps only V8's heap. `Buffer`, `ArrayBuffer` and WebAssembly memory sit outside it, and the probe allows all three. The RSS watchdog covers them. Every 200 ms it reads `VmRSS` from `/proc/<pid>/status` on Linux, or `ps -o rss= -p <pid>` on macOS, and kills the tree once resident memory passes `memoryMb + 64` MB (`memory_limit`). There is only one process to watch, because child processes and workers are blocked.

**The cap is partial:** a script can allocate and touch memory faster than one 200 ms poll, so its peak can pass the cap before the kill. Memory a script reserves but never touches does not count as resident. Windows has no watchdog, which is one reason D1 refuses scripts there. `docs/security.md` says this in the same words.

### Isolation, measured

Probed 2026-11-27 on Linux x64 with `--permission --allow-fs-read=<dir> --allow-fs-write=<dir>/out` and `env: {}`, against a loopback HTTP server and a Unix socket outside the folder:

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

- **Blocking the network needs Node 25 or later; D1 asks for 26.** `--allow-net` was added in Node 25.0.0 (docs: Stability 1.1, active development). On 22 and 24, the permission model leaves the whole network open. Node 25 reached end of life on 2026-06-01 (nodejs/Release `schedule.json`), and Node 26 has been LTS since 2026-10-28, so D1 proposes 26 as the floor. The canary checks each release at runtime rather than trusting the version number.
- **Docker is not required** for the "no network" acceptance; Node 26's permission model meets it. The repo's own Docker setup would not meet it anyway, because `compose.yaml` runs with `network_mode: host` and `pid: host`. A container per run (`--network none`) would be stronger, but the server would need the Docker socket, which is root on the host. Not in v1.
- **Symlinks:** Node follows symlinks out of an allowed path (a documented known issue). The walk refuses any symlink or hard-linked file and opens files with `O_NOFOLLOW`. The script runs from a copy the server wrote, which holds only regular files. The script cannot create links, because it has no write permission.
- **Signals:** a script can signal any process of the same user, the server included. `process.kill(-1, sig)` signals every process of that user at once. This is a denial of service, not a read or a leak. It is a known gap that only an OS boundary closes (another user, or a container).
- **Seat belt, not a sandbox:** Node's docs say the permission model "does not provide security guarantees in the presence of malicious code". The security gate is the owner's approval of an exact hash. The permission flags stop an approved script from doing more than it appears to do. `docs/security.md` says this plainly.
- **Not measured:** macOS and Windows. On macOS, the canary checks network and fs at runtime. Windows is refused (D1).

## Export and hosted pages

- "Download standalone HTML" on the review page (`/export`) adds the newest cached result per tool name of the page, as `<script type="application/json" id="austere-tool-snapshot">{"takenAt": …, "results": {"<name>": <data>}}</script>`, with `<` escaped as `\u003c`. It ignores arguments, so it can include a result no reviewer could get. This is safe only because `/export` is owner-only: it stays off the reviewer allowlist (`handle()` in `src/cli/server.ts`), and a test asserts that a reviewer gets 403. Without a bridge, the runtime's `toolProvider` answers those names from the snapshot and shows one line: "Data snapshot from <date>. Live data needs the review server."
- `austere-axi export` at a terminal has no cache. It adds a notice through `exportHtml`'s `notices`: "live sources: no data snapshot; download from the review page for one".
- Hosted pages answer `unavailable` (see Bridge). There is no snapshot for hosted pages in v1.

## Contract changes and compatibility

- **Bridge:** two message types are added. Older chromes ignore `tool-call`; the frame times out the call and shows the error state.
- **Server:** `/s/:id/tool`, its three approval routes, and `/api/sources/test` are new. The reviewer allowlist gains `/tool` only.
- **CLI:** `source add|remove|list|test` are new. `check` gains two rules (unknown tool name, script name clash).
- **State:** two new files, `sources.json` and `approved-scripts.json`, and one scratch dir, `script-runs/`. No `hub.db` change and no `SCHEMA_VERSION` bump. `PACK_API`, `CATALOG_FORMAT` and `SYNC_VERSION` do not change.
- **Rule change:** AGENTS.md's "nothing an installed pack ships runs in the CLI or the server" stays true for packs. A new rule joins it: a page's script runs on the server only as a private copy whose hash the owner approved, under the D1 gate, with the flags above.
- **Rollback:** an older austere-axi ignores both files; a page that calls a server tool shows the Query error state. Deleting the files removes every source and approval.

## Build slices

Each slice is one PR, verified on its own. Both wait for RLM-488 and for Sid's decisions on D1–D8.

1. **HTTP source.** Bridge messages and chrome forwarding (`busy`, `timeout`, hosted and playground `unavailable`); `/s/:id/tool` for HTTP; the D6 name check; `source add|remove|list|test` and `sources.json`; argument encoding; cache with config hash, purge and quotas; owner and reviewer budgets; the streamed body cap; echo redaction; the export snapshot; `check`'s unknown-name rule; docs (`docs/cli.md`, `docs/security.md` including the redaction limit and the pty note, `AGENTS.md`, README "What it does not do yet"); `src/runtime/prompt.ts` telling the agent how to name a source; and an example: a live line chart from a keyless public API whose JSON already holds a series (Open-Meteo hourly, for instance).
2. **Script source.** The `.austere-tools/` walk (`O_NOFOLLOW`), hashing and the private copy; `approved-scripts.json`; the review, approve and revoke routes; the banner and the dialog; the D1 gate and canary; the runner with its timer, stdout cap, stderr ring and RSS watchdog; `check`'s clash rule and unapproved warning; the `Dockerfile` default `NODE_VERSION` raised to 26 so the image can run scripts; docs (including the partial memory cap); and an example: a backtest page whose form runs an approved script.

## Test plan

Server tests start the server on an ephemeral port with `AUSTERE_AXI_STATE_DIR` set, using a local fake upstream; no test touches the internet.

Slice 1:

- `sources.json`: a malformed file names itself. A bad name, a URL with user info, a bad env name, a `Host` header, a bad `--arg` name, and an `--arg` name that is already a URL query key are all refused.
- `source add` without a terminal exits 2 and writes nothing. Without `--reviewers`, its output holds the reviewer notice.
- An owner call returns `data` at `--map`, and the upstream saw the header. Neither the response, the page file, the export nor the log holds the key's value.
- Argument encoding: the value `x&apikey=1#` arrives at the upstream as one value of its own key, and the registered keys are unchanged.
- Redaction, one test per form, each echoed by the fake upstream in a JSON string and in an object key: the raw value; the `encodeURIComponent` form; standard and URL-safe base64; the bare token of `Bearer <token>`; and a JSON-escaped echo (`\u` escapes). Each comes back as `***`. Owner error text is redacted too.
- Two calls within `minInterval`, and two concurrent calls: the upstream sees one request.
- `source add` that changes a URL, then a call: the reviewer gets no result from the old upstream. `source remove`: the name is `unknown_tool`, and its cache is gone.
- A name not in the program, a name only in a comment of the program, and a name not registered: all `unknown_tool`. An undeclared argument: `bad_request`. A redirect: `upstream_failed`, and the redirect target sees no request. A body over 1 MB, both with `Content-Length` and chunked without it: `too_large`, and the fetch was aborted. A gzip body that inflates past 1 MB: `too_large`. An unset variable: `env_missing`. The rate limit: 429.
- Reviewer: gets the cached result for the same arguments. Without a cache and not opted in: `owner_only`. Opted in: fetches. Reviewer calls that spend the reviewers' hourly budget leave the owner's call working. 60 reviewer calls with different arguments evict no owner-created entry.
- `/export` as a reviewer: 403. The owner cookie on the local-network listener counts as no owner (existing rule, one assertion). A foreign `Origin`: 403.
- Browser test: the live chart page re-renders with the fake upstream's new value after its refresh interval.

Slice 2 (assertions run on Node 26, the CI leg that runs scripts; on 22 and 24 the same calls assert `isolation_unavailable`):

- Unapproved: `not_approved` with `hash`, and the banner shows once. A second call with the same hash shows no second banner, and the dialog does not open without a click.
- Approving with that hash makes the call run. Changing any file (code, manifest or data) gives `not_approved` again. Approving with a stale hash: `changed`.
- The dialog shows every text file in full and the reviewer notice line. A folder with a `.wasm` file: approve without `confirmUnseen` gives `confirm_unseen`, and with it gives 200. A folder over 2 MB of text: `reviewable: false`, and approve gives `not_reviewable`.
- TOCTOU: a test script that waits on stdin while the test edits the live `index.mjs` still runs the approved bytes, and its working directory is under `<state>/script-runs/`, which is gone after the run.
- Swapping a file for a symlink during the walk gives `script_unsafe` and nothing is followed. A symlink or hard link in the folder: `script_unsafe`, and the script did not start.
- The script's `fetch` and `net.connect` to a test server on loopback fail inside the script, and the test server counts zero connections. Reading `../secret`, or reading the live folder by its path, fails.
- Canary: with the canary forced to fail (a test hook that passes `--allow-net` to the canary), script calls get `isolation_unavailable`.
- `Object.keys(process.env)` is empty. An endless loop with `timeoutSeconds: 1` gives `timeout`, and the process is gone. Stdout over 1 MB: `too_large`, and the process is gone before it finishes writing. 10 MB on stderr: the run succeeds, and the owner sees the last 2 KB.
- Memory: a `Buffer.alloc` loop past `memoryMb` gives `memory_limit`, and the process is gone. A heap-only loop past `memoryMb` gives `script_failed`, with V8's message in the owner's stderr tail. Non-JSON stdout: `bad_output`.
- Reviewer: not opted in, it gets the cache or `owner_only`. After a live-folder edit, its cache hit gives `not_approved`. Revoke purges the cache. Opted in, it runs, at most one reviewer run at a time, and the owner still gets a slot.
- `npm test`, `npm run typecheck`, `npm run lint`, `npm run format:check`, `npm run test:browser`.

## Not in v1

Filesystem writes for scripts; a host allowlist for `net`; keys in the query string (`--query-env`); a CLI `source approve`; a separate Node binary for scripts on an older server; scripts on Windows; a container per run; streaming partial results; snapshots for hosted pages.
