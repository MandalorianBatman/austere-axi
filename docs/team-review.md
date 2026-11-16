# Team review

Teammates on your tailnet can review a page and leave notes under their own name. The server still runs on your machine. No accounts, no hosted service.

```sh
austere-axi share plan.html --as "Ana"           # prints a link; notes wait for you
austere-axi share plan.html --as "Bo" --auto     # Bo's notes go straight to the agent
austere-axi share list [--links]                 # who has a link
austere-axi share revoke Ana                     # name or id; takes effect at once
```

Send the link to the teammate. It needs Tailscale (or `AUSTERE_AXI_HOST`); without one, `share` stops with an error.

- **Hold (default):** a teammate's note waits in your side panel. **Send** one note, **Send all**, or **Discard**. The agent does not see held notes (`poll` and `feedback` skip them) until you send them. Up to 200 held notes per teammate; more are refused until you send or discard some.
- **Auto:** the note goes to the agent without your approval.
- **Author:** `poll` and `feedback` show `from: <name>` on a teammate's note. Your own notes have no `from`. The hub Notes view shows the author and can filter on it.
- **Reviewers can** read the page and the conversation, and add notes. They cannot archive the page, export, or send held notes.

**Trust model.** Anyone with the link who can reach your machine on the tailnet can post notes under that name until you revoke it. Share only with people you trust, and revoke when the review is done.

- The link holds a random 192-bit token. Opening it shows a "Continue as <name>" button. Pressing it (a same-origin POST) trades the token for a cookie and removes it from the address bar, so a link opened from another site cannot turn your browser into a reviewer.
- A request without a valid invite or the owner key is refused, on loopback too. The hub and its Notes view are yours only. A reverse proxy on the same machine gets no owner rights from looking local.
- Your own phone link carries the owner key (`~/.austere-axi/owner.key`); do not forward it. To revoke all old phone links and owner cookies, delete that file and restart the server.
