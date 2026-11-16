# Hosted pages

`publish` uploads a page to [austere-cloud](https://github.com/MandalorianBatman/austere-cloud) and prints one link per invited reviewer. Nothing is sent until you run it; after that, the local server keeps your published pages in sync (below).

```sh
austere-axi publish plan.html --invite Ana --invite Ben   # prints https://austere.kasat.xyz/p/<id>#i=<token> for each
austere-axi publish plan.html                    # again: same page, new version; Ana's and Ben's links keep working. Repeat --unlisted or --no-presence, or they reset.
austere-axi publish plan.html --invite Cy --expires 7d   # one more reviewer, for a week
austere-axi publish invites plan.html            # who is invited (live, expired, revoked), with their links
austere-axi publish revoke plan.html Ben         # Ben's link stops working; his open page is disconnected
austere-axi publish plan.html --unlisted         # opt-in open link: anyone with the plain URL may review
austere-axi publish plan.html --new              # a fresh page
austere-axi publish list                         # your pages, expiry, note counts
austere-axi publish rm plan.html                 # or the page id; every link stops working at once
```

- **What is uploaded:** the file with its runtime tag pointed at the service's copy of this CLI version, the installed packs it declares, and the images beside it, inlined by the same rules as `export`. A declared pack that is not installed at that version, or an image that cannot be inlined, is an error. Each upload is limited to 1 MB after gzip.
- **Who can see it:** pages are invite-only. Each `--invite <name>` gets its own link; the token is in the URL fragment (`#i=…`), which browsers never send to the server, and the reviewer's notes carry that name. Send each person only their link. `--unlisted` opts a page into an open link where reviewers name themselves.
- **Notes:** reviewers' notes reach `poll` and `feedback` like any other, from the reviewer's name and with `remote: true`. They are held for you by default: press Send (or Discard) in the review page. With `--auto` on the publish they go straight to the agent. The local server picks them up while a `poll` listens, when it starts, and when you run `feedback`; offline, it keeps retrying (up to every 60 s) and local review goes on.
- **Replies:** `reply` (and `poll --agent-reply`) on a published file also posts the reply to the hosted page. If the service cannot be reached, `reply` warns and the reply is sent when it can.
- **The ⋯ menu on a hosted page:** "Download standalone HTML" saves the published page with its runtime and packs inlined, the same file `export` writes. On an `--unlisted` page, "Copy page link" copies the open link for every viewer, invited or not. On an invite-only page each link is one reviewer's alone, so the menu says how the owner invites someone instead.
- **Presence:** everyone on the page sees who is there: your own chip first, ringed, with the name you post under, then a chip per other viewer (viewing, away or writing) and the part each one last clicked in Annotate mode, outlined with their name. You are on the page too while your local review page is open: hosted viewers show as chips there, and your clicks show as an outline for them. Nothing about it is stored. `--no-presence` on a publish turns it off for that page.
- **Expiry:** 30 days after the last publish.
- **Owner token:** created on the first `publish`, stored in `~/.austere-axi/cloud.json` (mode 0600). It only controls your pages. Copying the file to another machine makes that machine a peer: it gets the same notes, and a note you send on one machine arrives sent on the other. `cloud.json` maps pages by absolute path, so the file must sit at the same path on both machines.

The protocol is in [docs/hosted-share-links.md](hosted-share-links.md).
