# Team review

Teammates on your tailnet can review your pages and leave notes under their own name. The server still runs on your machine. No accounts, no hosted service.

Access belongs to a **device you know by name**. A link is only the way in: the first browser that opens it becomes that person's device, and the link stops working.

```sh
austere-axi share plan.html --as "Ana"                     # a link for Ana's device; her notes wait for you
austere-axi share plan.html --as "Bo" --auto               # Bo's notes go straight to the agent
austere-axi share plan.html --as "Cy" --project shop       # every page of the page's project
austere-axi share plan.html --as "Dee" --all --expires 2d  # every page; the link lasts 2 days unopened
austere-axi share list [--links]                           # links nobody has opened yet, and devices
austere-axi share revoke Ana                               # a name or an id; takes effect at once
```

In the review page, **⋯ → Share…** does the same: a name, what it reaches, hold or auto, then the link with a **Copy link** button.

Send the link to that one person. It needs Tailscale (or `AUSTERE_AXI_HOST`, or `AUSTERE_AXI_LINK_URL`); without one, `share` stops with an error.

## A link, then a device

- **Claimed once.** Opening the link shows "Continue as <name>". Pressing it (a same-origin POST) makes that browser the device and the link is used up. A second browser that opens it is refused: "already used on another device". Share again for a second device.
- **Expires unopened.** A link nobody has opened stops working after 7 days, or after `--expires` (`30m`, `12h`, `7d`, `2w`). A device does not expire; revoke it.
- **Scope.** Chosen when the link is made: the page (default), the page's project (`--project <name>`, which must be the page's own), or every page on this machine (`--all`). It is checked on every reviewer route: the page, its files, the conversation, its event stream, and sending notes. A page outside the scope answers "This page is not shared with you". A device opens other pages in its scope by their address (`/s/<id>`); nothing lists them for it.
- **Hold (default):** a teammate's note waits in your side panel. **Send** one note, **Send all**, or **Discard**. The agent does not see held notes (`poll` and `feedback` skip them) until you send them. Up to 200 held notes per device; more are refused until you send or discard some.
- **Auto:** the note goes to the agent without your approval. Attach and auto exclude each other: an `--auto` link is refused while an agent is attached to a page it reaches, and `attach on` is refused for a page an auto link or device reaches.
- **Author:** `poll` and `feedback` show `from: <name>` on a teammate's note. Your own notes have no `from`. Each note records the device that sent it; the hub Notes view filters on the name, and `/notes?device=<id>` on one device.
- **Reviewers can** read the page and the conversation, and add notes. They cannot archive the page, export, share, or send held notes. The hub is never theirs, whatever the scope.
- **Revoke** (`share revoke <name|id>`) cuts a device off at once: its open pages close their stream and say why, and its cookie stops working. Revoking a link nobody opened kills the link. A name revokes every live link and device with that name.

`share list` shows, for a link: its scope, mode, when it was made and when it expires (`--links` adds the link, to copy it again); for a device: its scope, mode, when it joined, when it was last seen and from which address.

## Ask for access (no link)

Off until you turn it on. Then a teammate opens a page's plain address, types a name and asks; you let that browser in once.

```sh
austere-axi share requests on                   # every page (clears each project's own setting)
austere-axi share requests off --project shop   # except one project; a project's own setting wins
austere-axi share requests                      # who is waiting: name, page, address and hostname, browser
austere-axi share approve r0123456789           # that page; or --project <p> (the page's own) / --all, --auto, --as "<name>"
austere-axi share deny r0123456789              # refused; that browser may ask again
austere-axi share block r0123456789             # refused; that browser cannot ask again (see below)
```

- **What the teammate sees.** A browser with no reviewer cookie that opens a page where requests are on gets "Ask the owner for access", a name field and **Send**. The page's title, file and content stay hidden. After Send it shows "Waiting for the owner" and checks every 2 seconds; once you approve, it opens the page by itself. Where requests are off, it gets the same 403 as before.
- **What you see.** The name typed, the page it asked from, the address, its hostname, the browser and system, and when. The hostname is kept only when the reverse lookup and the forward lookup of that name agree. Behind a reverse proxy on this machine, the address is the one the proxy saw (the last `X-Forwarded-For` entry); a header from a remote peer is ignored. Over Tailscale the login and device will be added (RLM-399).
- **Bound to the browser that asked.** Send sets a random 192-bit pending secret in an `HttpOnly`, `SameSite=Lax` cookie (`austere_rq`); `hub.db` keeps its SHA-256. Approval makes a device with no secret yet. Only the browser holding the pending secret can collect it, once, and gets a fresh device secret (`austere_rv_<id>`) in exchange. Another browser that typed the same name gets nothing. The address and hostname are evidence for you, never the key.
- **Block** binds to the same cookie: that browser profile cannot ask again while it keeps the cookie (30 days). A private window or cleared cookies can ask again, within the address limit; deny or block it again, or turn requests off.
- **Limits.** 5 requests per address an hour, 50 waiting at most, names cleaned as link names are (1 to 40 characters, one line, not `owner`, `you`, `agent`, `me` or `render check`). One waiting request per browser. A request nobody decides within 7 days lapses and leaves the queue; its browser may ask again.
- The request form is a same-origin POST, checked again after its body arrives: a request that finishes after you turn requests off is refused.
- An approved device is like a claimed one: `share list`, rename, scope, revoke. Its `origin` is `request`.
- **One name, one person.** As for a link, approval is refused while a live link or device with that name (any case) already has that scope: approve under another name (`--as "Ana (phone)"`), revoke the other one first, or deny.

## Links from before (0.12 and older)

Invites in `invites.json` move into `hub.db` the first time this version opens it (the file is renamed `invites.json.imported`). Each becomes an **old-style link**: reusable, no expiry, the same URL as before, and the cookie it gave reviewers keeps working. Each new browser that opens an old-style link becomes a device of its own. `share list` marks these links; revoke one and share again to get a single-use link, or use **Make single-use** in the hub's Settings → People.

## Trust model

Anyone who opens a link before the person you sent it to becomes that device. Send each link to one person over a channel you trust, and revoke what you do not recognise in `share list`.

- The link holds a random 192-bit token. Opening it only shows the "Continue as <name>" button, so a link opened from another site cannot turn your browser into a reviewer or use the link up.
- Claiming swaps the token for a fresh random 192-bit device secret in an `HttpOnly`, `SameSite=Lax` cookie named for the device (`austere_rv_<id>`, so a second link claimed in the same browser adds a device instead of replacing the first), `Secure` when the request came over HTTPS (a proxy's `X-Forwarded-Proto: https`, or an `https` `AUSTERE_AXI_LINK_URL`). The cookie is never the link token. `hub.db` keeps only the secret's SHA-256, and looks it up by hash.
- A browser signed in as the owner that opens a share link is warned before it continues: it would become that person's device.
- A request with a reviewer cookie is never the owner, on loopback too. A cookie that matches no live device is refused and cleared. The hub and its Notes view are yours only. A reverse proxy on the same machine gets no owner rights from looking local.
- Tokens and secrets are kept out of `server.log`; it names devices by name and id.
- Your own phone link carries the owner key (`~/.austere-axi/owner.key`); do not forward it. To revoke all old phone links and owner cookies, delete that file and restart the server.

## For the hub's Settings → People (owner only)

[Settings](hub.md#settings) in the hub shows all of this: who waits, the links nobody has opened, the devices, and where new reviewers' notes go. The owner's browser (owner cookie, same-origin) can use these routes; a device never can. A share or an approval that leaves `auto` out takes the owner's default (`share default hold|auto`, Settings → Review defaults; hold unless changed).

| Route | Does |
|---|---|
| `GET /hub/api/people` | `{ links, devices }`: live links nobody has claimed (with `link`, to copy again) and live devices, each with `id`, `name`, `origin` (`link` or `request`), `scope`, `scopeId`, `reaches`, `auto`, `createdAt`, `reusable`, `expiresAt`, `claimedAt`, `lastSeenAt`, `lastAddr`, `lastHost`, `userAgent` |
| `POST /hub/api/people/<id>/rename` `{ name }` | rename a link or device |
| `POST /hub/api/people/<id>/scope` `{ scope: "page", page }` \| `{ scope: "project", project }` \| `{ scope: "all" }` | change what it reaches; its open pages outside the new scope are cut off |
| `POST /hub/api/people/<id>/revoke` | revoke it |
| `POST /hub/api/people/share` `{ page, name, scope?, project?, auto? }` | Settings → People → New link: a named link for the page whose copy id is `page`, as `share` makes it. Returns the link as `share` does |
| `POST /hub/api/people/<id>/single-use` `[{ expiresAt }]` | an old-style link gets a fresh single-use link; the old URL and cookie stop working |
| `GET /hub/api/people/requests` | `{ waiting, blocked, switch }`: requests waiting (the oldest first; Settings' count in the hub's sidebar is `waiting.length`) and blocked ones, each with `id`, `name`, `status`, `page`, `file`, `project`, `addr`, `host`, `userAgent`, `browser`, `verifiedLogin`, `tailscaleDevice`, `createdAt`, `decidedAt`; and `switch: { all, projects: [{ id, name, on }] }`, where `projects` lists only the projects whose own setting differs from `all` (it wins for their pages) |
| `POST /hub/api/people/requests/switch` `{ on, project? }` | without `project`: on or off for every page, clearing each project's own setting; with `project` (id or name): that project's own setting. Returns the `switch` |
| `POST /hub/api/people/requests/<id>/approve` `[{ scope: "page" \| "project" \| "all", auto, name }]` | let that browser in; scope as for a share, relative to the page it asked from (default the page); `name` replaces the one it typed. 409 when that name already has that scope. Returns `{ request, device }` |
| `POST /hub/api/people/requests/<id>/deny`, `/block` | refuse it; a blocked browser cannot ask again |
