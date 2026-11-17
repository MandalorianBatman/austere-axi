# Install and quick start

How to get austere-axi onto a machine and into your agent: the setup skill, the Claude Code plugin, or the MCP server for Claude Desktop, Cursor and Codex.

## Quick start

Needs Node.js 22.18 or later. Your agent runs:

```sh
npx -y austere-axi spec              # component reference (read once per session)
npx -y austere-axi plan.html         # validate and open the page for review
npx -y austere-axi poll              # wait for notes on every page of this folder's project
```

`--help` prints the file skeleton and the loop (about 1,100 tokens); `help all` adds the rarer and owner-only commands and the environment. The agent runs one `poll` for all its pages (`poll plan.html` listens on one page only). The agent does not look at the page itself: the reviewer judges how it looks, and render failures come back through `poll`. To have agents reach for it on their own, use the [skill, plugin or MCP server](#install).

## Install

Needs Node.js 22.18 or later.

**Let your agent do it.** Install the setup skill, then ask your agent to "set up austere-axi":

```sh
npx skills add MandalorianBatman/austere-axi --skill austere-setup
```

It checks Node, installs the `austere` skill, offers the optional items below, and opens a test page.

**Or do it yourself.** Agents can run the CLI with no install (`-y` skips the npm prompt):

```sh
npx -y austere-axi --help
```

Optional:

```sh
npm install -g austere-axi                                     # `austere-axi` command, no npx
npx skills add MandalorianBatman/austere-axi --skill austere   # tells agents when to make a page; adds /austere
```

The `austere` skill only points at `--help` and `spec`, so it never goes stale. A global install stays on its version until `npm update -g austere-axi`.

### Claude Code plugin

Bundles the `austere` skill (and `/austere`), the `austere-setup` skill and the MCP server:

```sh
claude plugin marketplace add MandalorianBatman/austere-axi
claude plugin install austere@austere-axi
```

In a session: `/plugin marketplace add MandalorianBatman/austere-axi`, then `/plugin install austere@austere-axi`. The MCP server runs `npx -y austere-axi mcp` (needs Node 22.18+ and npm access). `claude plugin update austere` updates the skill text; the CLI comes from npm each time.

### MCP

`austere-axi mcp` is an MCP server on stdio. Tools: `spec`, `check`, `open`, `poll`, `reply`, `patch`, `components`, `sessions_list`, `run_list`, `run_log`, `attach_status`. Each one runs the CLI command of the same name (`sessions_list` is `sessions list`, `run_list` is `run list`, `run_log` is `run log`, `attach_status` is `attach status`), so the loop is the same as on the command line.

- `poll` with no arguments waits on every page of the project of the MCP server's working folder, each batch naming its file; `project` (a name, an id or a folder) names another, and `file` waits on that page only. `agent_reply` belongs to file polls; reply to each page of a project poll with `reply`. `poll` returns `status: timeout` after 50 s by default, because many clients cancel longer calls. The agent polls again; nothing is lost. `timeout_ms: 0` waits until feedback arrives.
- `poll` and `reply` take the `cursor` a poll returned, like `--cursor`.
- `open`, `poll`, `reply` and `patch` take `session` (`<harness>:<id>`), like `--session`, for a client whose harness does not name its session in the environment. `sessions_list`, `run_list` and `attach_status` take a `file`, or a `project` with no file, like `sessions list`, `run list` and `attach status`; `run_log` takes the run's `id`. There is no tool for `run stop`, `attach on|off` or `adapter set`: those are the user's.
- `components` takes `command` (`search`, `show`, `list` or `add`) and `args`; `show` also takes `pack`, like `--pack`. `add` takes only an npm package name, never a folder or `.tgz`, and has no `trust`: a third-party pack the user has not trusted is refused, and the agent asks the user to install it.
- Pass absolute file paths. The server resolves relative paths against its own working directory, which depends on the client.
- No screen? Set `AUSTERE_AXI_NO_OPEN=1` in the server's `env` so `open` prints the link instead. Other [environment variables](cli.md#environment) work the same way.

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
