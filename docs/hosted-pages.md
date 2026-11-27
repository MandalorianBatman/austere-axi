# Hosted pages

`publish` uploads a page to [austere-cloud](https://github.com/MandalorianBatman/austere-cloud) and prints one link per invited reviewer. Nothing is sent until you run it.

- Sent: the page, its packs, the project's name (folder or repository) and the page's path in the project, so the cloud hub can group your pages.
- Afterwards the local server keeps published pages in sync.
- Cloud is off by default and publishing needs an account: `cloud on`, then `cloud login` (see [Accounts](#accounts)).

## Cloud switch

```sh
austere-axi cloud on       # publish, clone, cloud login|whoami and hosted-page sync work
austere-axi cloud off      # default: only local features work
austere-axi cloud status
```

- Same as the hub's **Settings → Cloud**. Stored in `<state dir>/settings.json` (`{ "cloud": true }`); missing file or anything else = off.
- Off: every request and socket to the service is refused before it is made.
  - `publish`, `publish list|invites|revoke|login|rm`, `clone`, `cloud login|whoami` fail with `cloud features are off`.
  - The local server opens no socket, queues no reply, Send or Discard for hosted pages, and treats published files as local.
  - `cloud logout` still works (it only edits `cloud.json`).
  - Published pages stay up until they expire; to remove them first, `publish rm` while cloud is on.
- Turning cloud on again pulls every published page; nothing done while off is sent.

## Publish

```sh
austere-axi publish plan.html --invite Ana --invite Ben   # prints https://austere.blundertech.com/p/<id>#i=<token> for each
austere-axi publish plan.html                    # again: same page, new version; links keep working. Repeat --unlisted or --no-presence, or they reset.
austere-axi publish plan.html --invite Cy --expires 7d   # one more reviewer, for a week
austere-axi publish invites plan.html            # who is invited (live, expired, revoked), with links
austere-axi publish revoke plan.html Ben         # Ben's link stops; his open page disconnects
austere-axi publish login plan.html              # single-use link signing your own browser in
austere-axi publish plan.html --unlisted         # opt-in open link: anyone with the plain URL may review
austere-axi publish plan.html --new              # a fresh page
austere-axi publish list                         # your pages, expiry, note counts
austere-axi publish rm plan.html                 # or the page id; every link stops at once
```

- **Uploaded:** the file (runtime tag pointed at the service's copy of this CLI version), the installed packs it declares, and adjacent images, inlined as by `export`. A declared pack not installed at that version, or an image that cannot be inlined, is an error. Max 1 MB per upload after gzip.
- **Notes** reach `poll` and `feedback` like any other, with the reviewer's name and `remote: true`. Held by default: Send or Discard in the review page; `--auto` on publish sends them straight to the agent. Picked up while a `poll` listens, at server start, and on `feedback`; offline, retried (up to every 60 s) while local review continues.
- **Replies:** `reply` (and `poll --agent-reply`) on a published file also post to the hosted page. If unreachable, `reply` warns and sends later.
- **Hosted page `⋯` menu:** "Download standalone HTML" saves the page with runtime and packs inlined (same as `export`). On `--unlisted` pages, "Copy page link" copies the open link; on invite-only pages the menu explains how the owner invites someone.
- **Presence:** everyone sees who is there: your chip first (ringed, with your posting name), then one per viewer (viewing, away, writing), and the part each last clicked in Annotate mode, outlined with their name. While your local review page is open you are present too: hosted viewers show as chips there, your clicks as outlines for them. Nothing is stored. `--no-presence` turns it off for that page.
- **Expiry:** 30 days after the last publish.
- **Sign-in required:** `publish`, `publish list|invites|revoke|login|rm` and `clone` need `cloud login` on this machine; otherwise they fail with `code: login_required` and `next: austere-axi cloud login` before any request. `--help` and `help all` then omit `publish` and `clone` (`publish --help` still prints its flags, with a note). The local server does not sync until you sign in. The CLI never signs in by itself. There is no anonymous owner token; the service accepts only an account.

## Accounts

Local review needs no account. For hosted review the owner signs in once per machine; reviewers sign in in the browser.

```sh
austere-axi cloud login      # prints and opens the sign-in link with its code; approve there or on any device (email code, Google, GitHub or passkey)
austere-axi cloud whoami     # the account this machine is signed in as
austere-axi clone            # your hosted pages, from every machine you published on
austere-axi clone <id> plan.html   # one as a local file, attached: notes sync here, publish updates the same link
austere-axi cloud logout     # this machine forgets the account
```

- **You own all your pages.** Logged in, `publish`, `publish list|invites|revoke|rm` and sync use the account. Signed in on the service's page with that account, you are owner on every hosted page (no `publish login`, no invite); your notes there are named Owner.
- **Pages published without an account** (with an anonymous owner token in `cloud.json`) were taken down and no owner token works. `cloud login` forgets their entries in `cloud.json`, so `publish` on such a file makes a new link.
- **One account per page list:** `cloud.json` records which account owns its published files. Signing in as another account forgets them (`cloud login` says how many), so `publish` makes new links. Signing out and back in as the same account keeps them.
- **Reviewers with an account:** on the service's dashboard (its home page, signed in), grant a page to an email. That person signs in with it and comments under their account name. Removing the grant cuts them off at once. Nobody can take the name Owner. A signed-in account without a grant gets the same 403 as a visitor without an invite.
- **Sidebar on a hosted page:** signed in to an account that may open the page (owner, or a reviewer with a grant), the page sits beside the service's projects sidebar (your pages by project, plus Shared), with Go to page (**Ctrl+K**) and the link back to the service's home. Opened with an invite link or the open link and no account, the page has none of these.
- **Invite links** (`--invite`) and the open link (`--unlisted`) keep working for people without an account.
- **Tokens:** `cloud.json` (mode 0600) holds the access and refresh tokens. The CLI refreshes the access token before expiry and stores each new refresh token; if the service ends the session, it says so and `cloud login` starts again. The CLI holds no secret: it uses the service's public WorkOS client id.

## Who can see a published page

- **Invite-only by default.** Without a live invite, the service answers 403 for content, notes and row feed.
- **The plain URL is an empty shell** titled "Shared page · austere"; title, content and notes arrive only after an accepted invite, owner sign-in, or the open link of an `--unlisted` page.
- **Links are bearer secrets.** Each `--invite <name>` link carries its token in the URL fragment (`#i=…`, never sent to the server). Whoever holds it reads the page and posts as that name; send each person only their own link.
- **`--expires <dur>`** sets new invites' lifetime (`30m`, `12h`, `7d`, `2w`); default: the page's (30 days after last publish). Re-publishing without `--expires` keeps existing expiries.
- **`publish revoke <file> <name>`** stops one link at once and disconnects pages open with it; `publish rm <file>` stops every link.
- **`--unlisted`:** anyone with the plain URL may read and post, naming themselves.
- **Owner access:** `publish login <file>` prints a single-use link (valid 60 s) that signs that browser in to this page for 30 days, no invite. Your notes there are named Owner and reach `poll` like a reviewer's. Do not forward it; an expired or used link answers 403.

Protocol: [sync-protocol.md](sync-protocol.md).
