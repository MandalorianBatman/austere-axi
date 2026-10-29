---
name: austere-setup
description: Set up austere-axi on this machine for the user. Checks Node, installs the `austere` skill, optionally installs the CLI globally and turns on the hub, then proves the review loop works with a test page. Use when the user asks to install, set up or configure austere-axi.
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

## 3. Install the `austere` skill

This skill tells agents when to make a page, and adds the `/austere` command.

Ask: install it for all projects (global), or only this project? Default: global.

```sh
npx skills add MandalorianBatman/austere-axi --skill austere -g   # global
npx skills add MandalorianBatman/austere-axi --skill austere      # this project
```

If the `skills` tool asks which agents to install for, pick the agent the user works with.

## 4. Optional choices

Ask the user about each item. Default: no.

- **Global command.** `npm install -g austere-axi`. Then `austere-axi` works without `npx -y`. Update it later with `npm update -g austere-axi`.
- **Hub.** `npx -y austere-axi hub on`. It keeps the server running and lists every page at `http://127.0.0.1:4388/`.
- **Phone review.** If Tailscale is running, the server also listens on the tailnet, and `open` prints a phone link. Nothing to install. Run `tailscale status` to check.

On a machine with no screen (SSH, CI, container), tell the user to set `AUSTERE_AXI_NO_OPEN=1`, so the CLI prints links and does not try to open a browser.

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
2. `npx -y austere-axi austere-setup-test.html` opens the review. Give the user the printed link.
3. `npx -y austere-axi poll austere-setup-test.html` waits for the user. Ask them to press **It works**. The poll returns an item for the button.
4. `npx -y austere-axi end austere-setup-test.html`, then delete the file.

If the user cannot open the page, read the server log in `~/.austere-axi/` and report it.

## 6. Report

Tell the user, in a short list:

- the Node version
- where the `austere` skill is installed
- which optional items you set up
- that the test page worked

To make a page later, the user asks for one, or types `/austere <what to show>`.
