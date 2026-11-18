# Security

The server binds to loopback, plus the Tailscale IP when Tailscale is up, plus one local-network address when you switch it on (`server lan`, Settings → Network; off by default). Never to all interfaces.

**Loopback is not the owner.** Other OS users on the machine can reach loopback too. The owner key (`owner.key`) is what proves ownership.

- **API:** `/api/*` answers only loopback callers that send the owner key, and refuses browser requests. `/api/health` needs no key. It proves the server holds the key with an HMAC of its port and the CLI's nonce, so the CLI never talks to, or hands the key to, another program on its port.
- **Browser sign-in:** when the CLI opens your browser, it gets a single-use login code from the server and opens the page with it. The server swaps the code for the owner cookie and removes it from the address bar. The key never appears on a command line, and the only output that carries it is the phone link `open` prints when Tailscale is up (see [How it works](how-it-works.md)): keep that link private. A code works once, for 60 seconds. Another local user who reads it from the process list in that window can use it first; your browser then shows "used already", and `austere-axi login` gives you a new one.
- **Other browsers:** a printed `url` works in a browser that already has the cookie. For any other browser (SSH with a forwarded port, `--no-open`, a second browser), run `austere-axi login [file]` and open the link it prints.
- **Owner cookie** is an HMAC of the key, not the key. Browsers share `127.0.0.1` cookies across ports, so a program on another local port that your browser visits can read it. With it, that program can open your pages and the hub as you in a browser, but cannot call `/api/*`, which needs the key.

**Files.** On macOS and Linux the state dir is set to mode 0700 on every run. New files in it (`owner.key`, `server.log`, and `hub.db`, which holds every note) are mode 0600. Files an older version created keep their old mode, behind the 0700 dir. On Windows, file modes do not apply; only your user profile's permissions protect the state dir.

**Requests.**

- `Host` headers must be on an allowlist (DNS-rebinding defense).
- Browser routes that change state refuse a foreign `Origin`.
- Share links are random, claimed by one browser only, and expire unopened. Claiming swaps the link for a fresh device secret in an `HttpOnly` cookie; `hub.db` keeps only its hash. Tokens and secrets are kept out of the log. A device reaches only the page, project or every page its link named, and only to read and add notes. See [Team review](team-review.md).
- Requests for access are off until the owner turns them on, for a project or every page. An unknown browser then sees a name form, never the page's title or content. An approval binds the browser that asked (a pending secret in an `HttpOnly` cookie, hashed in `hub.db`), not its address or name. Limits: 5 requests per address an hour, 50 waiting.
- **Who a reviewer is.** An address or hostname never lets anyone in; they are shown as evidence only. Over the Tailscale listener only, the server asks `tailscale whois` about the connection's own remote address (never a `Tailscale-User-*` or `X-Forwarded-For` header) and gets a login backed by the device's key. A tagged device, or a `tailscale` that is missing or fails, is unknown. A login you let in (`share tailscale`) opens what it reaches over Tailscale only; a device cookie seen over Tailscale belongs to that login from then on. See [Team review](team-review.md#who-is-this-reviewer).
- **The local-network listener serves reviewers only.** Its traffic is plain HTTP that others on the network can read. There, owner sign-in, the owner's key link, the owner cookie (which it also clears), the hub and `/api/*` answer 403, and no link with the owner key ever points at it.
- The server serves files only from the page's own directory, with no dotfiles.

**Who can see a page on my network.**

- **This computer:** you, and reviewers' devices. Other OS users reach loopback, but without `owner.key` they are not you.
- **Tailscale:** you, the devices you let in, and the logins you let in. Anyone else gets 403 or, where requests are on, a request form with no page content.
- **Local network:** nobody until you switch it on; then the devices you let in, over unencrypted HTTP. Never you.
- **HTTPS** behind your proxy (`AUSTERE_AXI_LINK_URL`): you and the devices you let in; Tailscale names nobody there.

**Page sandbox.** The page runs in a sandboxed iframe with no same-origin access; packs run there too. Page files are also served with `Content-Security-Policy: sandbox`, so a page opened in a popup or its own tab stays sandboxed. In review, the review page opens new-window links only if they are external `http(s):` or `mailto:` links. A popup the frame opens any other way stays sandboxed.

**Packs.** Third-party packs need `--trust` unless your trust list names them. Installed packs must match their lockfile hash; CDN loads use Subresource Integrity.

**Telemetry.** OpenUI's Node side has PostHog telemetry; the CLI sets `OPENUI_TELEMETRY_DISABLED=1`. The browser runtime sends none.
