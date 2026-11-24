# Docker

Run the review server in a container instead of `server install`. The agent keeps running the `austere-axi` CLI on the host; the CLI finds the container's server the way it finds any running server, through the state dir and the port.

Linux only. The container uses the host's network: Docker Desktop on macOS and Windows does not give a container the host's loopback.

## Run it

From a checkout of austere-axi:

```sh
mkdir -p ~/.austere-axi                         # else Docker creates it, owned by root
export AUSTERE_UID=$(id -u) AUSTERE_GID=$(id -g)
export AUSTERE_AXI_WORKSPACE=$HOME/src          # the folder your pages live under
docker compose up -d --build
austere-axi server status                       # server: v…, pid …, port 4388, not run by a service
```

Put the three variables in a `.env` file beside `compose.yaml` to keep them. `AUSTERE_AXI_PORT` picks another port; set it on the host too.

The same with `docker run`:

```sh
docker build -t austere-axi:local .
docker run -d --name austere-axi --restart unless-stopped --init \
  --network host --pid host --user "$(id -u):$(id -g)" \
  -e AUSTERE_AXI_STATE_DIR="$HOME/.austere-axi" \
  -v "$HOME/.austere-axi:$HOME/.austere-axi" \
  -v "$HOME/src:$HOME/src" \
  austere-axi:local
```

## Why it runs this way

Each setting follows from a rule of the server ([Security](security.md)):

| Setting | Why |
|---|---|
| `--network host` | The server binds to loopback, never `0.0.0.0`, and `/api/*` answers loopback callers only. On a bridge network the host's CLI would reach it from the bridge address and get 403. |
| `--pid host` | The CLI checks the pid in `server.lock`. With the container's own PIDs it would judge a live server dead, or a dead one alive. |
| `--user` the host user | `owner.key` and `hub.db` are mode 0600: the host's CLI must be able to read what the server writes. |
| State dir at the same path | The CLI checks that the server it reaches serves its own state dir, by path. |
| Page folders at the same path | The CLI sends absolute file paths; the server reads the page there. A page outside the mounted folders does not open. |

## Limits

- **Keep the versions equal.** A host CLI newer than the image stops the container's server and starts its own on the host (a server no service runs is replaced; see [Always on](hub.md#always-on)); with `restart: unless-stopped` the container then comes back and fails to take the port while the host's server runs. Rebuild the image when you update the CLI (`docker compose up -d --build`), or run the CLI from the image: `docker exec -w "$PWD" austere-axi austere-axi <command>` (the folder must be mounted).
- **Attach and triggers run in the container.** A [run](attach.md) or a [trigger](cli.md#triggers) starts its command in the container, which has Node and npm but no coding agent. Use `server install` on the host if you need them.
- **Tailscale.** The image has no `tailscale` CLI, so the server listens on loopback only and phone review over the tailnet is off. `AUSTERE_AXI_HOST` and the local-network switch in Settings still work, since the container shares the host's addresses.
- **`server install` and `server restart`** manage a systemd unit on the host, not the container; `server status` reports the container's server as `not run by a service`. Use `docker compose restart` and `docker compose logs`; the server also writes `server.log` in the state dir.
