# Security

The server binds to loopback, plus the Tailscale IP when Tailscale is up. Never to all interfaces.

**Loopback is not the owner.** Other OS users on the machine can reach loopback too. The owner key (`owner.key`) is what proves ownership.

- **API:** `/api/*` answers only loopback callers that send the owner key, and refuses browser requests. `/api/health` needs no key. It proves the server holds the key with an HMAC of its port and the CLI's nonce, so the CLI never talks to, or hands the key to, another program on its port.
- **Browser sign-in:** when the CLI opens your browser, it gets a single-use login code from the server and opens the page with it. The server swaps the code for the owner cookie and removes it from the address bar. The key never appears on a command line or in output. A code works once, for 60 seconds. Another local user who reads it from the process list in that window can use it first; your browser then shows "used already", and `austere-axi login` gives you a new one.
- **Other browsers:** a printed `url` works in a browser that already has the cookie. For any other browser (SSH with a forwarded port, `--no-open`, a second browser), run `austere-axi login [file]` and open the link it prints.
- **Owner cookie** is an HMAC of the key, not the key. Browsers share `127.0.0.1` cookies across ports, so a program on another local port that your browser visits can read it. With it, that program can open your pages and the hub as you in a browser, but cannot call `/api/*`, which needs the key.

**Files.** On macOS and Linux the state dir is set to mode 0700 on every run. New files in it (`owner.key`, `server.log`, and `hub.db`, which holds every note) are mode 0600. Files an older version created keep their old mode, behind the 0700 dir. On Windows, file modes do not apply; only your user profile's permissions protect the state dir.

**Requests.**

- `Host` headers must be on an allowlist (DNS-rebinding defense).
- Browser routes that change state refuse a foreign `Origin`.
- Share links are random, claimed by one browser only, and expire unopened. Claiming swaps the link for a fresh device secret in an `HttpOnly` cookie; `hub.db` keeps only its hash. Tokens and secrets are kept out of the log. A device reaches only the page, project or every page its link named, and only to read and add notes. See [Team review](team-review.md).
- Requests for access are off until the owner turns them on, for a project or every page. An unknown browser then sees a name form, never the page's title or content. An approval binds the browser that asked (a pending secret in an `HttpOnly` cookie, hashed in `hub.db`), not its address or name. Limits: 5 requests per address an hour, 50 waiting.
- The server serves files only from the page's own directory, with no dotfiles.

**Page sandbox.** The page runs in a sandboxed iframe with no same-origin access; packs run there too. Page files are also served with `Content-Security-Policy: sandbox`, so a page opened in a popup or its own tab stays sandboxed. In review, the review page opens new-window links only if they are external `http(s):` or `mailto:` links. A popup the frame opens any other way stays sandboxed.

**Packs.** Third-party packs need `--trust` unless your trust list names them. Installed packs must match their lockfile hash; CDN loads use Subresource Integrity.

**Telemetry.** OpenUI's Node side has PostHog telemetry; the CLI sets `OPENUI_TELEMETRY_DISABLED=1`. The browser runtime sends none.
