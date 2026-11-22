---
name: austere-setup
description: "Use when the user wants austere-axi installed, set up, configured, updated or checked on this machine, or when it is missing or broken: the `austere` skill or `/austere` command is not available, `npx austere-axi` fails, Node is too old, or review pages do not open (headless machine, 403 at a printed link). Also use when the user asks for phone review over Tailscale or an always-on review server. Not for making a review page; that is the `austere` skill."
license: MIT
---

# austere-setup

Set up austere-axi for the user. Do the steps in order. Stop and tell the user when a step fails.

Ask the user only the questions in steps 3 and 4. Use the default for each if they do not answer.

## 1. Check Node

Run `node --version`.

- Node 22.18 or later is necessary.

If Node is older than 22.18, stop. Tell the user to install a current Node LTS.

## 2. Check the CLI

Run `npx -y austere-axi --help`. It must print the `WORKFLOW` section. If npm cannot reach the registry, stop and show the error.

**Update.** If the user asked to update and `npm ls -g austere-axi` lists a global install, run `npm update -g austere-axi`, then `austere-axi --version`, and tell the user the new version. `npx -y austere-axi` does not change a global install. Then run `austere-axi server status`: if a server runs, run `austere-axi server restart`, so it serves the new version. Its `server:` line names the version it runs. If that is still the old version, the service runs a CLI from npx's cache: tell the user to run `austere-axi server install` at a terminal, which points the service at the global install.

## 3. Install the `austere` skill

This skill tells agents when to make a page, and adds the `/austere` command.

If the `austere` skill is already available (for example from the austere Claude Code plugin), skip this step.

Ask: install it for all projects (global), or only this project? Default: global.

```sh
npx skills add MandalorianBatman/austere-axi --skill austere -g   # global
npx skills add MandalorianBatman/austere-axi --skill austere      # this project
```

If the `skills` tool asks which agents to install for, pick the agent the user works with.

## 4. Optional choices

Ask the user about each item. Default: no.

- **Global command.** `npm install -g austere-axi`. Then `austere-axi` works without `npx -y`. Update it later with `npm update -g austere-axi`, then `austere-axi server restart` if a server runs.
- **Phone review.** If Tailscale is running, the server also listens on the tailnet, and `open` prints a phone link. Nothing to install. Run `tailscale status` to check.
- **Always-on server.** `austere-axi server install` makes the server a per-user service (systemd or launchd) that starts at login, so the hub and notes are there without an agent running. The user runs it at a terminal: it shows what it will write and asks first. See `docs/hub.md`.

On a machine with no screen (SSH, CI, container), tell the user to set `AUSTERE_AXI_NO_OPEN=1`, so the CLI prints links and does not try to open a browser. A browser the CLI did not open gets "403" at a printed link until it signs in: run `npx -y austere-axi login <file>` and give the user the link it prints. It works once, within 60 seconds.

## 5. Prove it works

Write `austere-setup-test.html` in the current directory:

```html
<!doctype html>
<html><head><meta charset="utf-8"><title>austere-axi works</title>
<script src="https://cdn.jsdelivr.net/npm/austere-axi@0/dist/austere.js"></script></head>
<body><script type="text/openui">
root = Stack([card], "column", "l")
card = Card([CardHeader("austere-axi works", "Setup test"), text, buttons])
text = MarkDownRenderer("Click a part of this page to annotate it, or press the button.")
buttons = Buttons([Button("It works")])
</script></body></html>
```

Then:

1. `npx -y austere-axi check austere-setup-test.html` must report no errors.
2. `npx -y austere-axi austere-setup-test.html` opens the review. Give the user the printed link. If it did not open a browser (`browser: not opened`), run `npx -y austere-axi login austere-setup-test.html` and give the user that link instead.
3. `npx -y austere-axi poll austere-setup-test.html` waits for the user. Ask them to press **It works**. The poll returns an item for the button.
4. `npx -y austere-axi archive austere-setup-test.html` puts the test page away from the hub's lists, then delete the file.

If the user cannot open the page, read the server log in `~/.austere-axi/` and report it.

## 6. Report

Tell the user, in a short list:

- the Node version
- where the `austere` skill is installed
- which optional items you set up
- that the test page worked

To make a page later, the user asks for one, or types `/austere <what to show>`.
