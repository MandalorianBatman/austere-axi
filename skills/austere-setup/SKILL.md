---
name: austere-setup
description: "Use when the user wants austere-axi set up, configured or checked on this machine, or when it is missing or broken: the `austere-axi` command or `/austere` is not available, Node is too old, review pages do not open (headless machine, 403 at a printed link), or the server still runs the old version after an update. Also use when the user asks for phone review over Tailscale or an always-on review server. Not for making a review page; that is the `austere` skill. Not for installing: the user installs austere-axi as its README says."
license: MIT
---

# austere-setup

Set up austere-axi for the user. Do the steps in order. Stop and tell the user when a step fails.

Ask the user only the questions in step 2. Use the default for each if they do not answer.

## 1. Check the CLI

Run `austere-axi --help`. It must print the `WORKFLOW` section.

If the command is not found, austere-axi is not installed: tell the user, point them to the "Get started" section of austere-axi's README (on GitHub or npm), and stop. Do not install it yourself. If it fails on start, show the error; austere-axi needs Node 22.18 or later (`node --version`).

**After an update.** If the user updated austere-axi, run `austere-axi --version` and `austere-axi server status`. If a server runs, run `austere-axi server restart`, so it serves the new version: its `server:` line names the version it runs. If that is still the old version, the service runs a cached copy of the CLI, not the global install: tell the user to run `austere-axi server install` at a terminal, which points the service at the global install.

## 2. Optional choices

Ask the user about each item. Default: no.

- **Phone review.** If Tailscale is running, the server also listens on the tailnet, and `open` prints a phone link. Run `tailscale status` to check.
- **Always-on server.** `austere-axi server install` makes the server a per-user service (systemd or launchd) that starts at login, so the hub and notes are there without an agent running. The user runs it at a terminal: it shows what it will write and asks first. See `docs/hub.md`.

On a machine with no screen (SSH, CI, container), tell the user to set `AUSTERE_AXI_NO_OPEN=1`, so the CLI prints links and does not try to open a browser. A browser the CLI did not open gets "403" at a printed link until it signs in: run `austere-axi login <file>` and give the user the link it prints. It works once, within 60 seconds.

## 3. Prove it works

Write `austere-setup-test.html` in the current directory from the file skeleton `--help` printed, titled `austere-axi works`, with this program:

```
root = Stack([card], "column", "l")
card = Card([CardHeader("austere-axi works", "Setup test"), text, buttons])
text = MarkDownRenderer("Click a part of this page to annotate it, or press the button.")
buttons = Buttons([Button("It works")])
```

Then:

1. `austere-axi check austere-setup-test.html` must report no errors.
2. `austere-axi austere-setup-test.html` opens the review. Give the user the printed link. If it did not open a browser (`browser: not opened`), run `austere-axi login austere-setup-test.html` and give the user that link instead.
3. `austere-axi poll austere-setup-test.html` waits for the user. Ask them to press **It works**. The poll returns an item for the button.
4. `austere-axi archive austere-setup-test.html` puts the test page away from the hub's lists, then delete the file.

If the user cannot open the page, read the server log in `~/.austere-axi/` and report it.

## 4. Report

Tell the user, in a short list:

- the austere-axi version (`austere-axi --version`)
- which optional items you set up
- that the test page worked

To make a page later, the user asks for one, or types `/austere <what to show>`.
