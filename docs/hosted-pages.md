# Hosted pages

`publish` uploads a page to [austere-cloud](https://github.com/MandalorianBatman/austere-cloud) and prints one link per invited reviewer. Nothing is sent until you run it; after that, the local server keeps your published pages in sync (below). Cloud features are off by default, and publishing needs an account: turn cloud on and sign in first (`cloud on`, then `cloud login`; see [Accounts](#accounts)).

## Cloud switch

```sh
austere-axi cloud on       # publish, clone, cloud login|whoami and hosted-page sync work
austere-axi cloud off      # the default: only local features work
austere-axi cloud status
```

The hub's **Settings → Cloud** is the same switch. It is kept in `<state dir>/settings.json` (`{ "cloud": true }`); without that file, or with anything else in it, cloud features are off. Off, every request and socket to the service is refused before it is made: `publish`, `publish list|invites|revoke|login|rm`, `clone` and `cloud login|whoami` fail with `cloud features are off`, and the local server opens no socket, queues no reply, Send or Discard for a hosted page, and treats published files as local ones. `cloud logout` works either way, since it only edits `cloud.json`. Pages you published stay up on the service until they expire; to take them down first, run `publish rm` while cloud is on. Turning cloud on again pulls every published page and sends nothing that was done while it was off.

## Publish

```sh
austere-axi publish plan.html --invite Ana --invite Ben   # prints https://austere.blundertech.com/p/<id>#i=<token> for each
austere-axi publish plan.html                    # again: same page, new version; Ana's and Ben's links keep working. Repeat --unlisted or --no-presence, or they reset.
austere-axi publish plan.html --invite Cy --expires 7d   # one more reviewer, for a week
austere-axi publish invites plan.html            # who is invited (live, expired, revoked), with their links
austere-axi publish revoke plan.html Ben         # Ben's link stops working; his open page is disconnected
austere-axi publish login plan.html              # single-use link that signs your own browser in to the hosted page
austere-axi publish plan.html --unlisted         # opt-in open link: anyone with the plain URL may review
austere-axi publish plan.html --new              # a fresh page
austere-axi publish list                         # your pages, expiry, note counts
austere-axi publish rm plan.html                 # or the page id; every link stops working at once
```

- **What is uploaded:** the file with its runtime tag pointed at the service's copy of this CLI version, the installed packs it declares, and the images beside it, inlined by the same rules as `export`. A declared pack that is not installed at that version, or an image that cannot be inlined, is an error. Each upload is limited to 1 MB after gzip.
- **Who can see it:** see [Who can see a published page](#who-can-see-a-published-page).
- **Notes:** reviewers' notes reach `poll` and `feedback` like any other, from the reviewer's name and with `remote: true`. They are held for you by default: press Send (or Discard) in the review page. With `--auto` on the publish they go straight to the agent. The local server picks them up while a `poll` listens, when it starts, and when you run `feedback`; offline, it keeps retrying (up to every 60 s) and local review goes on.
- **Replies:** `reply` (and `poll --agent-reply`) on a published file also posts the reply to the hosted page. If the service cannot be reached, `reply` warns and the reply is sent when it can.
- **The ⋯ menu on a hosted page:** "Download standalone HTML" saves the published page with its runtime and packs inlined, the same file `export` writes. On an `--unlisted` page, "Copy page link" copies the open link for every viewer, invited or not. On an invite-only page each link is one reviewer's alone, so the menu says how the owner invites someone instead.
- **Presence:** everyone on the page sees who is there: your own chip first, ringed, with the name you post under, then a chip per other viewer (viewing, away or writing) and the part each one last clicked in Annotate mode, outlined with their name. You are on the page too while your local review page is open: hosted viewers show as chips there, and your clicks show as an outline for them. Nothing about it is stored. `--no-presence` on a publish turns it off for that page.
- **Expiry:** 30 days after the last publish.
- **Signed in first:** `publish`, `publish list|invites|revoke|login|rm` and `clone` need this machine signed in (`cloud login`). Without it they fail with `code: login_required` and `next: austere-axi cloud login` before any request, and `--help` and `help all` leave `publish` and `clone` out (`publish --help` still prints its flags, with a note). The local server does not sync hosted pages either until you sign in. The CLI never signs in by itself: `cloud login` is always run by a person. Since 0.17 there is no anonymous owner token, and the service accepts only an account.

## Accounts

Local review needs no account. Hosted review does: the owner signs in once per machine, reviewers sign in in the browser.

```sh
austere-axi cloud login      # prints the sign-in link with its code and opens the browser; approve it there or on any other device (email code, Google, GitHub or passkey)
austere-axi cloud whoami     # the account this machine is signed in as
austere-axi clone            # your hosted pages, from every machine you published them on
austere-axi clone <id> plan.html   # one of them as a local file, attached: notes sync here, publish updates the same link
austere-axi cloud logout     # this machine forgets the account
```

- **You are the owner of all your pages.** Once logged in, `publish`, `publish list|invites|revoke|rm` and the local server's sync use the account. Sign in on the service's page in the browser with the same account and you are the owner on every one of your hosted pages: no `publish login`, no invite. Your notes there carry the name Owner.
- **Pages published without an account** (before 0.17, with the anonymous owner token in `cloud.json`) are not moved to an account: the service took them down, and no owner token works any more. `cloud login` forgets their entries in `cloud.json`, so `publish` on such a file makes a new link. Pages an account claimed with 0.15 or 0.16 stay the account's.
- **One account per machine's page list:** `cloud.json` remembers which account its published files belong to. Signing in as another account forgets them (`cloud login` says how many), so `publish` makes new links instead of failing on the other account's pages. Signing out and in again as the same account keeps them.
- **Reviewers with an account:** on the service's dashboard (its home page, signed in), grant a page to an email, as you would add a reviewer to a pull request. That person signs in with that email and comments under their account name. Removing the grant cuts them off at once. Nobody can take the name Owner. A signed-in account without a grant gets the same 403 as a visitor without an invite.
- **Invite links** (`--invite`) and the open link (`--unlisted`) keep working for people without an account, until a later release decides otherwise.
- **The tokens:** `cloud.json` (mode 0600) keeps the account's access token and refresh token. The CLI refreshes the access token before it expires and stores the new refresh token each time; if the service ends the session, the CLI says so and `cloud login` starts again. The CLI holds no secret of its own: it signs in with the service's public WorkOS client id.

## Who can see a published page

- **Invite-only by default.** Without a live invite, the service answers 403 to the page's content, its notes and its row feed.
- **The plain URL shows only an empty shell.** Its tab title reads "Shared page · austere"; the page title, the content and the notes arrive only after the service accepts an invite (or the owner's sign-in, or the open link of an `--unlisted` page).
- **Links are bearer secrets.** Each `--invite <name>` link carries its own token in the URL fragment (`#i=…`), which browsers never send to the server. Whoever holds a link reads the page and posts notes under that name, so send each person only their own link.
- **`--expires <dur>`** sets the lifetime of new invites (`30m`, `12h`, `7d`, `2w`); without it they last as long as the page (30 days after the last publish). Re-publishing without `--expires` preserves each existing invite's expiry.
- **`publish revoke <file> <name>`** stops one link at once and disconnects any page open with it; `publish rm <file>` stops every link.
- **`--unlisted`** is the one mode where anyone with the plain URL may read and post notes, naming themselves.
- **You, the owner,** open the page with `publish login <file>`: it prints a single-use link (valid 60 s). Opening it signs that browser in to this page for 30 days, without an invite. Notes you add there carry the name Owner and reach `poll` like a reviewer's. Do not forward the link; an expired or used one answers 403.

The protocol is in [docs/hosted-share-links.md](hosted-share-links.md).
