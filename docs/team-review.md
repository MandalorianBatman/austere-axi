# Team review

Teammates on your tailnet review your pages and leave notes under their own name. The server stays on your machine. Local review needs no account or hosted service; hosted review (`publish`) needs a sign-in, see [Hosted pages](hosted-pages.md#accounts).

Access belongs to a **device you know by name**. A link is only the way in: the first browser that opens it becomes that person's device, and the link is used up.

```sh
austere-axi share plan.html --as "Ana"                     # a link for Ana's device; her notes wait for you
austere-axi share plan.html --as "Bo" --auto               # Bo's notes go straight to the agent
austere-axi share plan.html --as "Cy" --project shop       # every page of the page's project
austere-axi share plan.html --as "Dee" --all --expires 2d  # every page; the link lasts 2 days unopened
austere-axi share list [--links]                           # unopened links and devices
austere-axi share revoke Ana                               # a name or an id; immediate
```

- In the review page, **⋯ → Share…** does the same: name, reach, hold or auto, then the link with **Copy link**.
- Send the link to that one person.
- Needs Tailscale, the local network switched on, `AUSTERE_AXI_HOST` or `AUSTERE_AXI_LINK_URL`; otherwise `share` fails.

## A link, then a device

- **Claimed once.** The link shows "Continue as <name>"; pressing it (same-origin POST) makes that browser the device and uses up the link. Another browser gets "already used on another device". Share again for a second device.
- **Expires unopened** after 7 days, or `--expires` (`30m`, `12h`, `7d`, `2w`). Devices do not expire; revoke them.
- **Scope**, set at creation: the page (default), the page's project (`--project <name>`, must be the page's own), or every page (`--all`). Checked on every reviewer route: page, files, conversation, event stream, sending notes. Outside scope: "This page is not shared with you". A device opens other in-scope pages by address (`/s/<id>`); nothing lists them.
- **Hold (default):** a teammate's note waits in your side panel: **Send**, **Send all** or **Discard**. `poll` and `feedback` skip held notes. Max 200 held notes per device; more are refused.
- **Auto:** notes go to the agent without approval. Attach and auto exclude each other: an `--auto` link is refused while an agent is attached to a page it reaches, and `attach on` is refused for a page an auto link or device reaches.
- **Author:** `poll` and `feedback` show `from: <name>` on a teammate's note; yours have no `from`. Each note records its device; the hub Notes view filters by name, `/notes?device=<id>` by device.
- **Reviewers can** read the page and conversation and add notes. They cannot archive, export, share, or send held notes. The hub is never theirs.
- **Revoke** (`share revoke <name|id>`): immediate. Open pages close their stream and say why; the cookie stops working. Revoking an unopened link kills it. A name revokes every live link and device with that name.

`share list` shows, per link: scope, mode, created, expiry (`--links` adds the link). Per device: scope, mode, joined, last seen and from which address.

## Ask for access (no link)

Off by default. When on, a teammate opens a page's plain address, types a name and asks; you let that browser in once.

```sh
austere-axi share requests on                   # every page (clears each project's own setting)
austere-axi share requests off --project shop   # one project; a project's own setting wins
austere-axi share requests                      # who is waiting: name, page, address and hostname, browser
austere-axi share approve r0123456789           # that page; or --project <p> (the page's own) / --all, --auto, --as "<name>"
austere-axi share deny r0123456789              # refused; that browser may ask again
austere-axi share block r0123456789             # refused; that browser cannot ask again
```

- **Teammate sees:** with no reviewer cookie, on a page with requests on: "Ask the owner for access", a name field, **Send**. Title, file and content stay hidden. Then "Waiting for the owner", checked every 2 seconds; on approval the page opens. Requests off: 403.
- **You see:** the name, page, address, hostname, browser and system, and time.
  - The hostname is kept only when reverse and forward lookups agree.
  - Behind a reverse proxy on this machine, the address is the last `X-Forwarded-For` entry; that header from a remote peer is ignored.
  - Over Tailscale, the request carries the Tailscale login and device; the Tailscale name replaces the typed one (see [Who is this reviewer](#who-is-this-reviewer)).
- **Bound to the asking browser.** Send sets a random 192-bit pending secret in an `HttpOnly`, `SameSite=Lax` cookie (`austere_rq`); `hub.db` keeps its SHA-256. Only that browser can collect the approval, once, receiving a fresh device secret (`austere_rv_<id>`). Same name from another browser gets nothing. Address and hostname are evidence, never the key.
- **Block** binds to the same cookie: that browser profile cannot ask again while it keeps it (30 days). A private window or cleared cookies can ask again within the address limit.
- **Limits:** 5 requests per address per hour; 50 waiting max; one waiting request per browser; names 1–40 characters, one line, not `owner`, `you`, `agent`, `me` or `render check`. Undecided requests lapse after 7 days; that browser may ask again.
- The form is a same-origin POST, rechecked after its body arrives: requests turned off meanwhile are refused.
- An approved device works like a claimed one (`share list`, rename, scope, revoke); its `origin` is `request`.
- **One name, one person:** approval is refused while a live link or device with that name (any case) has that scope. Use another name (`--as "Ana (phone)"`), revoke the other, or deny.

## Who is this reviewer

Addresses and hostnames prove nothing (anyone can take an address; a hostname is self-announced). They are shown and stored as evidence, never used to let anyone in.

Each request is decided in order:

1. **Owner:** owner cookie, no reviewer cookie. Never on the local network.
2. **A Tailscale-named person whose login you let in.** For connections on this server's Tailscale address, the server runs `tailscale whois --json` on the connection's remote address (cached one minute per address) and gets login, name and device, backed by the device key. Headers (`Tailscale-User-*`, `X-Forwarded-For`) are never used: behind a reverse proxy or on loopback, nobody is named. A tagged device (server, CI runner) is unknown. If `tailscale` is missing or fails, the reviewer is unknown; nothing breaks.
3. **An approved device:** its cookie, from a link or request. Over Tailscale, a device belongs to the first login Tailscale names behind its cookie (or its request or link); the same cookie from another login is refused.
4. **Unknown:** the request form where requests are on, else 403.

```sh
austere-axi share tailscale ana@example.com plan.html          # Ana, on any of her Tailscale devices: that page
austere-axi share tailscale ana@example.com --project shop     # or a project, or --all; --as "<name>", --auto
austere-axi share revoke ana@example.com                       # by name (default: the login) or id
```

- `share tailscale` admits a login without link or request: any device signed in as that login, over this server's Tailscale address only (unknown on loopback, local network or HTTPS).
- Listed with devices (`origin` `tailscale`); rename, scope, revoke work the same. Settings → Network → **Names from Tailscale** does the same.
- `share list`, `share requests` and Settings show the verified login, or the address, hostname and browser. Each device keeps the login, address, hostname and browser it was last seen with.

## The local network

- The server answers on this computer and Tailscale. `server lan <address>` (or Settings → Network) also listens on one local-network address (never all). `server lan off` stops; `server lan` lists addresses. Off by default. Kept in `hub.db`: a restarted server listens there again while the address exists.

> Traffic on this network is not encrypted. Others on the same network could read pages, notes and reviewers' access. Use it on a network you trust, or use Tailscale or HTTPS.

- Reviewers only. Owner sign-in (`?login=`), the owner key link (`?key=`), the owner cookie, the hub, Settings and `/api/*` answer 403: "The owner does not sign in over the local network". An owner cookie sent there is cleared.
- No owner-key link points at it; teammates' links do when nothing else reaches the server.
- Reviewers there are known by device cookie only; Tailscale names nobody.

## Who can see a page on my network

| Where | Who |
|---|---|
| This computer | You (owner cookie, or the CLI with the key) and reviewers' devices. Other OS users reach loopback but are not the owner. |
| Tailscale | You (phone link), devices you let in, logins you let in (`share tailscale`). Others: 403, or the request form where requests are on. |
| Local network | Nobody until switched on; then devices you let in, over plain HTTP. Never you. |
| HTTPS (`AUSTERE_AXI_LINK_URL` behind your reverse proxy) | As Tailscale, but nobody is named by Tailscale. |
| Hosted page (`publish`) | Only people you invite or grant by email, who sign in; see [Hosted pages](hosted-pages.md). |

## Trust model

Whoever opens a link first becomes that device. Send each link to one person over a trusted channel; revoke anything unfamiliar in `share list`.

- Links hold a random 192-bit token. Opening only shows "Continue as <name>", so a link opened from another site cannot make your browser a reviewer or use the link up.
- Claiming swaps the token for a fresh random 192-bit device secret in an `HttpOnly`, `SameSite=Lax` cookie named per device (`austere_rv_<id>`; a second claim in the same browser adds a device), `Secure` over HTTPS (`X-Forwarded-Proto: https` from a proxy, or an `https` `AUSTERE_AXI_LINK_URL`). The cookie is never the link token; `hub.db` keeps only the secret's SHA-256 and looks it up by hash.
- A browser signed in as owner is warned before claiming a share link: it would become that person's device.
- A request with a reviewer cookie is never the owner, on loopback too. A cookie matching no live device is refused and cleared. A reverse proxy on the same machine gets no owner rights from looking local.
- Old-style links are reusable and do not expire; each new browser that opens one becomes its own device. `share list` marks them; revoke and share again, or use **Make single-use** in Settings → People.
- Tokens and secrets stay out of `server.log`; it names devices by name and id.
- Your phone link carries the owner key (`~/.austere-axi/owner.key`); do not forward it. To revoke all phone links and owner cookies, delete that file and restart the server.

## Settings → People routes (owner only)

[Settings](hub.md#settings) shows all of this. Owner cookie, same-origin only; devices never. A share or approval without `auto` uses the owner's default (`share default hold|auto`, Settings → Review defaults; hold unless changed).

| Route | Does |
|---|---|
| `GET /hub/api/people` | `{ links, devices }`: live unclaimed links (with `link`) and live devices, each with `id`, `name`, `origin` (`link`, `request` or `tailscale`), `scope`, `scopeId`, `reaches`, `auto`, `createdAt`, `reusable`, `expiresAt`, `claimedAt`, `lastSeenAt`, `lastAddr`, `lastHost`, `userAgent`, `verifiedLogin` (Tailscale login or null) |
| `POST /hub/api/people/<id>/rename` `{ name }` | rename a link or device |
| `POST /hub/api/people/<id>/scope` `{ scope: "page", page }` \| `{ scope: "project", project }` \| `{ scope: "all" }` | change reach; open pages outside it are cut off |
| `POST /hub/api/people/<id>/revoke` | revoke it |
| `POST /hub/api/people/share` `{ page, name, scope?, project?, auto? }` | New link for the page with copy id `page`, as `share`; returns the link |
| `POST /hub/api/people/<id>/single-use` `[{ expiresAt }]` | replace an old-style link with a fresh single-use link; old URL and cookie stop working |
| `GET /hub/api/people/requests` | `{ waiting, blocked, switch }`: waiting (oldest first; the sidebar count is `waiting.length`) and blocked requests, each with `id`, `name`, `status`, `page`, `file`, `project`, `addr`, `host`, `userAgent`, `browser`, `verifiedLogin`, `tailscaleDevice`, `createdAt`, `decidedAt`; `switch: { all, projects: [{ id, name, on }] }`, `projects` listing only those whose own setting differs from `all` |
| `POST /hub/api/people/requests/switch` `{ on, project? }` | no `project`: every page, clearing project settings; with `project` (id or name): that project's setting. Returns `switch` |
| `POST /hub/api/people/requests/<id>/approve` `[{ scope: "page" \| "project" \| "all", auto, name }]` | admit that browser; scope relative to the asking page (default page); `name` replaces the typed one. 409 if that name already has that scope. Returns `{ request, device }` |
| `POST /hub/api/people/requests/<id>/deny`, `/block` | refuse; a blocked browser cannot ask again |
| `POST /hub/api/people/tailscale` `{ login, name?, scope: "project" \| "all", project?, auto? }` | admit a Tailscale login (`share tailscale`); `project` by id. Returns the device |
| `POST /hub/api/settings/network` `{ lan: "<address>" \| null }` | local-network switch (`server lan`) |
