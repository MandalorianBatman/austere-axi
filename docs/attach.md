# Attach an agent

Without attach, your notes wait until an agent polls the page. With attach on, a note you send starts an agent for you: austere-axi runs your coding agent's CLI headless, the agent reads the notes, patches the page and replies, and the page updates in front of you. You do not have to keep an agent session open and polling.

Only you turn it on: from the page's review tab, or at a terminal. An agent can read the setting, but cannot change it.

## Turn it on from the page

The review page's header has an **Agent** pill, beside the agent's status. It reads `Agent: Off`, or, when on, the harness, the mode and the model: `Agent: omp · fork · claude-haiku-4-5`. Click it:

- **On / Off / Use project default.** On and Off give this page its own setting. Use project default drops it, and the page follows its project's setting (off when the project has none).
- **Mode.** How a run relates to the agent session that wrote the page (see [Modes](#modes)). A mode the harness cannot run is greyed out, with the reason: Copilot CLI has no fork.
- **Session.** `Author`, the default, is the session that wrote the page. The list also shows every agent session that opened, patched or polled the page (harness, short id, role, when it was last seen, and whether its process still runs); pick one to always resume that one.
- **Harness** (omp, Copilot CLI, or a command you set up with `adapter set`) for a new session, and the **Model**, with a list of omp's models when `omp models` answers within a second. Empty means the harness's own default.
- Under Same and Fork: "Resends the whole session each run", with the size of the session file when it is known. Every run sends the whole conversation again, so a long session costs more per run.
- A warning when the harness has no write grant (see [The write grant](#the-write-grant)), with the command to run, and a Copy button.

The pill and its popover are only on your own review page. A teammate's invite link and a hosted page never show them, and the routes behind it refuse anyone but you.

On a phone, the popover opens across the full width of the screen, and the pill's dot shows a run's state.

## Turn it on from a terminal

```sh
austere-axi attach status plan.html          # what applies to the page, and what would stop a run
austere-axi attach on plan.html --mode fork  # this page: on, forking the author session
austere-axi attach off plan.html             # this page: off
austere-axi attach inherit plan.html         # this page: back to the project's default
austere-axi attach on --project site         # the project's default, for its pages without their own
```

`attach on`, `off` and `inherit` work only at a terminal. Run from an agent's tool call (no terminal), they change nothing, exit 2, and print the command for you to run. `attach status` works anywhere and changes nothing. The flags are in the [CLI reference](cli.md#attach).

## What applies to a page

A page's own setting wins. A page that has none, or was set back to the project default, follows its project's setting. With neither, attach is off. Copies of the same page in different worktrees share the page's setting.

## Modes

| Mode | What a run does |
|---|---|
| `same` (default) | Resumes the session. If that session is still open in your terminal, the run waits until it exits ("Waiting for session"), so two processes never write to one session. |
| `fork` | Branches a new session from it each run; your open session is left alone. Copilot CLI cannot fork. |
| `new` | The first run starts a session; later runs on the page continue that one. |

## Sessions: author

The session is `author` unless you pick one: the agent session that first opened or patched the page. When omp continued that session in a new one (it does when the old one was open elsewhere), `author` follows to the newest continuation. A page with no author registered gets a `new` session with the project's harness (omp unless set). A harness names its session in the environment (omp, Copilot CLI, dsh); `austere-axi sessions list <file>` shows what was registered.

## The write grant

omp and Copilot CLI, run headless, refuse commands that write unless you allow them, and still exit with success. Such a run cannot use `austere-axi patch`, so it ends without replying (`no_reply`). austere-axi does not add a permission-bypass flag on its own. Grant it once, at a terminal:

```sh
austere-axi adapter set omp --extra-args "--approval-mode yolo"
austere-axi adapter set copilot --extra-args "--allow-all"
```

Both give the run full permissions on your machine, like any harness you run with them. `attach status` and the popover warn while the harness you attached has no grant. A command adapter counts as granted: its arguments are your own. More in [Adapters](cli.md#adapters).

## Runs

When a run starts and ends, the side panel's **Notes** tab shows it. Beside the pill:

- **Waiting for session** — `same`, and the session is still open; the run starts when it exits.
- **Running** with the time so far, and **Stop**, which kills the run and everything it started.
- **Run failed**, with **View log** (the last lines the run printed) and **Retry**, which runs the same notes again. A failed run is never retried on its own.

At a terminal:

```sh
austere-axi run list plan.html    # status, why it failed, harness and mode, the notes, how long
austere-axi run log <id>          # what the run printed
austere-axi run stop plan.html    # stop the page's runs
```

Limits are in `<state>/attach.json`, which only you edit: at most 15 minutes per run, 12 runs per page per hour, 2 at once on the machine, a 5 second wait after your last note, and optional cost caps. See [Runs](cli.md#runs) for every key and status.

## Who gets a note

When you press Send, the first of these that can take the note gets it:

1. **A poll.** An agent that polls the page (or its checkout or project) gets the note at once. No run starts.
2. **An idle agent session.** With the omp extension loaded (see [Wake an idle session](cli.md#wake-an-idle-session)), the open omp session that wrote, edited or listened to the page starts a turn with your note. If that session is in the middle of a turn, the note waits for the turn to end ("Queued · agent busy"). A delivered wake stops an attached run that has not started yet.
3. **An attached run.** With attach on, a run starts after the 5 second wait, if nothing above took the note first. While the session is busy, a `fork` or `new` run can start before its turn ends; a `same` run waits for the session ("Waiting for session"), so the session gets the note when its turn ends.
4. **The next agent that asks.** Otherwise the note waits for a `poll` or `feedback`. Only then does the page say "Agent not listening".

The review page names the one that has it: "Agent listening", "Agent idle in omp · Send wakes it", the Agent pill for a run, and under a note "Delivered to omp 14:02".

## Attach and `--auto`

A run reads only notes you sent or released. A page published with `publish --auto`, or shared with `share --auto`, lets reviewers' notes through without you, so the two exclude each other: attach does not turn on for such a page (from the page or the terminal, whether by its own setting, by going back to a project default that is on, or by turning the project's default on), and `publish --auto` and `share --auto` refuse while attach is on.

## Security notes

- Turning attach on is your act: the owner cookie on the review page, or a terminal. Reviewers, hosted pages, MCP tools and an agent's ordinary tool calls cannot. The page's attach routes refuse a reviewer, and a request from another site.
- A note from a teammate starts nothing until you release it.
- `adapters.json` and `attach.json` are read only from the state directory (`~/.austere-axi`), never from a project or a page.
- A run gets the prompt from a private file on stdin and works through the normal CLI. Its log is private (mode 0600) and is deleted after 30 days. Session ids stay on your machine: they are not in `publish`, `export` or hosted sync.
- The terminal rule stops a careless or prompt-injected agent from turning attach on in passing. It does not stop a program that already runs as you with a terminal; nothing inside austere-axi could. More in [Security](security.md).
