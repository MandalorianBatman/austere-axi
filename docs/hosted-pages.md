# Hosted pages

`publish` uploads a page to [austere-cloud](https://github.com/MandalorianBatman/austere-cloud) and prints one link per invited reviewer. Nothing is sent until you run it; after that, the local server keeps your published pages in sync (below).

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
- **Owner token:** created on the first `publish`, stored in `~/.austere-axi/cloud.json` (mode 0600). It only controls your pages. Copying the file to another machine makes that machine a peer: it gets the same notes, and a note you send on one machine arrives sent on the other. `cloud.json` maps pages by absolute path, so the file must sit at the same path on both machines.

## Who can see a published page

- **Invite-only by default.** Without a live invite, the service answers 403 to the page's content, its notes and its row feed.
- **The plain URL shows only an empty shell.** Its tab title reads "Shared page · austere"; the page title, the content and the notes arrive only after the service accepts an invite (or the owner's sign-in, or the open link of an `--unlisted` page).
- **Links are bearer secrets.** Each `--invite <name>` link carries its own token in the URL fragment (`#i=…`), which browsers never send to the server. Whoever holds a link reads the page and posts notes under that name, so send each person only their own link.
- **`--expires <dur>`** sets the lifetime of new invites (`30m`, `12h`, `7d`, `2w`); without it they last as long as the page (30 days after the last publish). Re-publishing without `--expires` preserves each existing invite's expiry.
- **`publish revoke <file> <name>`** stops one link at once and disconnects any page open with it; `publish rm <file>` stops every link.
- **`--unlisted`** is the one mode where anyone with the plain URL may read and post notes, naming themselves.
- **You, the owner,** open the page with `publish login <file>`: it prints a single-use link (valid 60 s). Opening it signs that browser in to this page for 30 days, without an invite. Notes you add there carry the name Owner and reach `poll` like a reviewer's. Do not forward the link; an expired or used one answers 403.

The protocol is in [docs/hosted-share-links.md](hosted-share-links.md).
