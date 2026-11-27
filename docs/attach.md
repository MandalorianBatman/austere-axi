# Attach an agent

With attach on, a note you send starts an agent: austere-axi runs your coding agent's CLI headless; it reads the notes, patches the page and replies, and the page updates live. No agent session needs to stay open polling. Without attach, notes wait until an agent polls.

Only you turn it on, from the page's review tab or a terminal. An agent can read the setting but not change it.

## Turn it on from the page

The review header has an **Agent** pill beside the agent's status: `Agent: Off`, or harness · mode · model (`Agent: omp · fork · claude-haiku-4-5`). Click it for:

- **On / Off / Use project default.** On and Off set this page; Use project default follows the project (off if the project has none).
- **Mode** (see [Modes](#modes)). Modes the harness cannot run are greyed out with the reason (Copilot CLI has no fork).
- **Session.** `Author` (default): the session that wrote the page. Also lists every session that opened, patched or polled the page (harness, short id, role, last seen, whether its process runs); pick one to always resume it.
- **Harness** for a new session (omp, Copilot CLI, or a command set up with `adapter set`) and **Model** (omp's models listed when `omp models` answers within a second). Empty = harness default.
- Under Same and Fork: "Resends the whole session each run", with the session file size when known. Long sessions cost more per run.
- A warning when the harness has no [write grant](#the-write-grant), with the command and a Copy button.

Only on your own review page: invite links and hosted pages never show it, and its routes refuse anyone else. On a phone, the popover is full width and the pill's dot shows run state.

## Turn it on from a terminal

```sh
austere-axi attach status plan.html          # what applies, and what would stop a run
austere-axi attach on plan.html --mode fork  # this page: on, forking the author session
austere-axi attach off plan.html             # this page: off
austere-axi attach inherit plan.html         # this page: back to the project default
austere-axi attach on --project site         # the project default, for pages without their own
```

- `attach on|off|inherit` work only at a terminal. From an agent tool call (no terminal) they change nothing, exit 2, and print the command for you.
- `attach status` works anywhere and changes nothing.
- Flags: [CLI reference](cli.md#attach).

## What applies to a page

Page setting → else project setting → else off. Copies of a page in different worktrees share its setting.

## Modes

| Mode | What a run does |
|---|---|
| `same` (default) | Resumes the session. If it is still open in your terminal, the run waits until it exits ("Waiting for session"), so two processes never write one session. |
| `fork` | Branches a new session from it each run; your open session is untouched. Not on Copilot CLI. |
| `new` | The first run starts a session; later runs on the page continue it. |

## Sessions: author

- `author` (unless you pick one) is the session that first opened or patched the page. If omp continued it in a new session (it does when the old one was open elsewhere), `author` follows to the newest continuation.
- No author registered: a `new` session with the project's harness (omp unless set).
- Harnesses that name their session in the environment: omp, Copilot CLI, dsh. `austere-axi sessions list <file>` shows what was registered.

## The write grant

Headless omp and Copilot CLI refuse writing commands unless allowed, and still exit with success, so the run cannot `austere-axi patch` and ends without replying (`no_reply`). austere-axi never adds a permission-bypass flag itself. Grant once, at a terminal:

```sh
austere-axi adapter set omp --extra-args "--approval-mode yolo"
austere-axi adapter set copilot --extra-args "--allow-all"
```

- Both give runs full permissions on your machine.
- `attach status` and the popover warn while the attached harness has no grant.
- A command adapter counts as granted (its arguments are yours). See [Adapters](cli.md#adapters).

## Runs

Run start and end show in the side panel's **Notes** tab. Beside the pill:

- **Waiting for session:** `same`, session still open; starts when it exits.
- **Running** with elapsed time, and **Stop** (kills the run and everything it started).
- **Run failed**, with **View log** (last lines printed) and **Retry** (same notes again). Failed runs are never retried automatically.

```sh
austere-axi run list plan.html    # status, failure reason, harness and mode, notes, duration
austere-axi run log <id>          # what the run printed
austere-axi run stop plan.html    # stop the page's runs
```

Limits live in `<state>/attach.json` (only you edit it): max 15 minutes per run, 12 runs per page per hour, 2 concurrent per machine, a 5 second wait after your last note, optional cost caps. Every key and status: [Runs](cli.md#runs).

## Who gets a note

On Send, the first that can take the note gets it:

1. **A poll** on the page (or its checkout or project): delivered at once; no run.
2. **An idle agent session.** With the omp or Copilot CLI extension loaded ([Wake an idle session](cli.md#wake-an-idle-session)), the open session that wrote, edited or listened to the page starts a turn with the note. Mid-turn, it waits ("Queued · agent busy"). A delivered wake cancels an attached run not yet started.
3. **An attached run**, after the 5 second wait, if nothing above took it. While the session is busy, `fork`/`new` may start; `same` waits ("Waiting for session").
4. **The next agent that asks** (`poll` or `feedback`). Only then does the page say "Agent not listening".

The page names the recipient: "Agent listening", "Agent idle in omp · Send wakes it", the Agent pill for a run, and "Delivered to omp 14:02" under a note.

## Attach and `--auto`

A run reads only notes you sent or released. `publish --auto` and `share --auto` let reviewers' notes through without you, so they exclude attach:

- Attach does not turn on for such a page (page setting, inheriting an on project default, or turning the project default on).
- `publish --auto` and `share --auto` refuse while attach is on.

## Security notes

- Only you turn attach on: owner cookie on the review page, or a terminal. Reviewers, hosted pages, MCP tools and an agent's ordinary tool calls cannot. Attach routes refuse reviewers and cross-site requests.
- A teammate's note starts nothing until you release it.
- `adapters.json` and `attach.json` are read only from the state directory (`~/.austere-axi`), never from a project or page.
- Runs get the prompt from a private file on stdin and use the normal CLI. Run logs are mode 0600 and deleted after 30 days. Session ids stay local: not in `publish`, `export` or hosted sync.
- The terminal rule stops a careless or prompt-injected agent from turning attach on. It cannot stop a program already running as you with a terminal. See [Security](security.md).
