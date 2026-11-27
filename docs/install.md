# Install and quick start

Get austere-axi onto a machine and into your agent: the CLI and skills, the Claude Code plugin, or the MCP server for Claude Desktop, Cursor and Codex.

## Quick start

Needs Node.js 22.18 or later. Install the CLI once with `npm install -g austere-axi`; your agent then runs:

```sh
austere-axi spec              # component reference (read once per session)
austere-axi plan.html         # validate and open the page for review
austere-axi poll              # wait for notes on every page of this folder's project
```

- `--help` prints the file skeleton and the loop (about 1,100 tokens); `help all` adds rarer and owner-only commands and the environment.
- One `poll` covers all the agent's pages; `poll plan.html` listens on one page only.
- The agent does not look at the page: the reviewer judges how it looks, and render failures come back through `poll`.
- To have agents reach for it on their own, use the [skill, plugin or MCP server](#install).

## Install

Needs Node.js 22.18 or later.

```sh
npm install -g austere-axi                                                           # the `austere-axi` command
npx skills add MandalorianBatman/austere-axi --skill austere --skill austere-setup   # when to make a page (and /austere); setup
```

Then ask your agent to "set up austere-axi". The setup skill checks the CLI, offers phone review and an always-on server, and opens a test page.

- The skills never install anything. Without the `austere-axi` command, the agent says so and stops, or uses the MCP tools if it has them.
- The `austere` skill only points at `--help` and `spec`, so it never goes stale.
- A global install stays on its version until `npm update -g austere-axi`. Then run `austere-axi server restart` if a server runs (or ask your agent to "set up austere-axi", which restarts it).
- Without a global install, use npx (`-y` skips the npm prompt): `npx -y austere-axi --help`.
- To run the server in a container instead of `server install`: [Docker](docker.md).

### Claude Code plugin

Bundles the `austere` skill (and `/austere`), the `austere-setup` skill and the MCP server:

```sh
claude plugin marketplace add MandalorianBatman/austere-axi
claude plugin install austere@austere-axi
```

- In a session: `/plugin marketplace add MandalorianBatman/austere-axi`, then `/plugin install austere@austere-axi`.
- The MCP server runs `npx -y austere-axi mcp` (needs Node 22.18+ and npm access), so the plugin works without a global install; the `austere` skill then uses its tools.
- The setup skill needs the `austere-axi` command.
- `claude plugin update austere` updates the skill text; the CLI comes from npm each time.

### MCP

`austere-axi mcp` is an MCP server on stdio. Tools: `spec`, `check`, `open`, `poll`, `reply`, `patch`, `find`, `outline`, `show`, `history`, `restore`, `changes`, `decisions`, `components`, `sessions_list`, `run_list`, `run_log`, `attach_status`. Each runs the CLI command of the same name (`sessions_list` = `sessions list`, `run_list` = `run list`, `run_log` = `run log`, `attach_status` = `attach status`), so the loop matches the command line.

- **`poll`** with no arguments waits on every page of the project of the server's working folder; each batch names its file. `project` (name, id or folder) names another; `file` waits on that page only.
  - `agent_reply` belongs to file polls; reply to each page of a project poll with `reply`.
  - Returns `status: timeout` after 50 s by default, because many clients cancel longer calls. The agent polls again; nothing is lost. `timeout_ms: 0` waits until feedback arrives.
- `poll` and `reply` take the `cursor` a poll returned, like `--cursor`.
- `open`, `poll`, `reply` and `patch` take `session` (`<harness>:<id>`), like `--session`, for clients whose harness does not name its session in the environment.
- `sessions_list`, `run_list` and `attach_status` take a `file`, or a `project` with no file. `run_log` takes the run's `id`.
- No tool for `run stop`, `attach on|off` or `adapter set`: those are the user's.
- `find`, `outline`, `show`, `history`, `restore`, `changes` and `decisions` read and restore parts of pages ([History and reuse](cli.md#history-and-reuse)). `show` takes `plain_text` (`--text`); `patch` takes `from` (and `rev`) to copy parts from another page (`--from`, `--rev`).
- `components` takes `command` (`search`, `show`, `list` or `add`) and `args`; `show` also takes `pack` (`--pack`). `add` takes only an npm package name (no folder or `.tgz`) and has no `trust`: an untrusted third-party pack is refused, and the agent asks the user to install it.
- Pass absolute file paths. Relative paths resolve against the server's working directory, which depends on the client.
- No screen? Set `AUSTERE_AXI_NO_OPEN=1` in the server's `env` so `open` prints the link. Other [environment variables](cli.md#environment) work the same way.

**Claude Desktop** (`claude_desktop_config.json`) and **Cursor** (`~/.cursor/mcp.json`, or `.cursor/mcp.json` in a project):

```json
{
  "mcpServers": {
    "austere": {
      "command": "npx",
      "args": ["-y", "austere-axi", "mcp"]
    }
  }
}
```

**Codex** (`~/.codex/config.toml`), or `codex mcp add austere -- npx -y austere-axi mcp`:

```toml
[mcp_servers.austere]
command = "npx"
args = ["-y", "austere-axi", "mcp"]
```
