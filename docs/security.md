# Security

## Binding

The server binds to loopback, plus the Tailscale IP when Tailscale is up, plus one local-network address when switched on (`server lan`, Settings → Network; off by default). Never all interfaces.

## Owner

**Loopback is not the owner.** Other OS users can reach loopback; the owner key (`owner.key`) proves ownership.

- **API:** `/api/*` answers only loopback callers sending the owner key, and refuses browser requests. `/api/health` needs no key; it proves the server holds the key with an HMAC of its port and the CLI's nonce, so the CLI never talks to, or hands the key to, another program on its port.
- **Browser sign-in:** the CLI gets a single-use login code from the server and opens the page with it; the server swaps it for the owner cookie and strips it from the address bar. A code works once, for 60 seconds. Another local user reading it from the process list in that window can use it first; your browser then shows "used already" and `austere-axi login` issues a new one.
- **The key** never appears on a command line. The only output carrying it is the phone link `open` prints when Tailscale is up (see [How it works](how-it-works.md)); keep it private.
- **Other browsers:** a printed `url` works in a browser that already has the cookie. Otherwise (SSH with a forwarded port, `--no-open`, a second browser) run `austere-axi login [file]` and open its link.
- **Owner cookie** is an HMAC of the key, not the key. Browsers share `127.0.0.1` cookies across ports, so a program on another local port your browser visits can read it and open your pages and the hub as you, but cannot call `/api/*`.

## Files

- macOS and Linux: the state dir is set to mode 0700 on every run; new files in it (`owner.key`, `server.log`, `hub.db` with every note) are 0600. Files created by older versions keep their mode, behind the 0700 dir.
- Windows: file modes do not apply; only your user profile's permissions protect the state dir.

## Requests

- `Host` headers must be on an allowlist (DNS-rebinding defense).
- State-changing browser routes refuse a foreign `Origin`.
- **Share links** are random, claimed by one browser, and expire unopened. Claiming swaps the link for a fresh device secret in an `HttpOnly` cookie; `hub.db` keeps only its hash. Tokens and secrets stay out of the log. A device reaches only its page, project or all pages, and can only read and add notes. See [Team review](team-review.md).
- **Access requests** are off until the owner turns them on (per project or every page). An unknown browser sees a name form, never the page's title or content. Approval binds the asking browser (a pending secret in an `HttpOnly` cookie, hashed in `hub.db`), not its address or name. Limits: 5 requests per address per hour, 50 waiting.
- **Who a reviewer is.** Addresses and hostnames are shown as evidence only, never let anyone in. On the Tailscale listener only, the server asks `tailscale whois` about the connection's remote address (never a `Tailscale-User-*` or `X-Forwarded-For` header) and gets a login backed by the device key. Tagged devices, or a missing/failing `tailscale`, are unknown. A login you let in (`share tailscale`) works over Tailscale only; a device cookie seen over Tailscale belongs to that login from then on. See [Team review](team-review.md#who-is-this-reviewer).
- **The local-network listener serves reviewers only**, over plain HTTP others on the network can read. Owner sign-in, the owner key link, the owner cookie (also cleared), the hub and `/api/*` answer 403 there; no owner-key link points at it.
- Files are served only from the page's own directory, never dotfiles.

## Who can see a page on my network

| Where | Who |
|---|---|
| This computer | You and reviewers' devices. Other OS users reach loopback but without `owner.key` are not you. |
| Tailscale | You, devices and logins you let in. Others: 403, or (requests on) a request form with no page content. |
| Local network | Nobody until switched on; then devices you let in, over unencrypted HTTP. Never you. |
| HTTPS behind your proxy (`AUSTERE_AXI_LINK_URL`) | You and devices you let in; Tailscale names nobody. |

## Page sandbox

- Pages (and their packs) run in a sandboxed iframe without same-origin access.
- Page files are served with `Content-Security-Policy: sandbox`, so a page in a popup or its own tab stays sandboxed.
- In review, new-window links open only if external `http(s):` or `mailto:`. Other popups stay sandboxed.

## Packs

Third-party packs need `--trust` unless your trust list names them. Installed packs must match their lockfile hash; CDN loads use Subresource Integrity.

## Telemetry

OpenUI's Node side has PostHog telemetry; the CLI sets `OPENUI_TELEMETRY_DISABLED=1`. The browser runtime sends none.
