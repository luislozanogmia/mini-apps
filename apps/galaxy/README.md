# Galaxy

A local map of machines and terminal sessions. Planets represent machines; bases are remote tmux sessions; ships are open terminal connections.

## Start

Requires Node.js 22+ and npm. `node-pty` may require native build tools for your OS.

```sh
npm ci
npm start
```

Open **http://127.0.0.1:8420**. The first run creates ignored `config.json` and `planets.json` with generic labels and no machines. Use **Add world** to configure a machine and an SSH target from your own SSH configuration. SSH authentication stays with your system's SSH client. Nothing connects to a remote host until you configure one.

You can also copy `config.example.json` and `planets.example.json` before starting. Configuration changes create local backups under ignored `backups/`. Never commit your working configuration or backups.

Remote terminals and deployments require SSH locally and tmux remotely. The imported local terminal and process-monitoring implementation targets Windows/PowerShell; those features have not been ported to macOS/Linux. The web server can run on macOS/Linux.

## Optional settings

| Environment variable | Default |
| --- | --- |
| `PORT` | `8420` |
| `GALAXY_SSH_BIN` | `ssh` on PATH |
| `GALAXY_TASKLIST_BIN` | `tasklist.exe` on PATH (Windows) |
| `GALAXY_TASKKILL_BIN` | `taskkill.exe` on PATH (Windows) |
| `GALAXY_DOCUMENT_PATH` | Unset; document endpoint disabled. Set to a file you explicitly want displayed. |

The optional desktop wrapper is in [electron/](electron/). The server binds to loopback only and rejects unrelated browser origins and Host headers, including on WebSocket upgrades. It is a trusted local terminal controller, not an authenticated multi-user server: do not expose it through a tunnel, reverse proxy, or public network.

## Checks

```sh
node --test tests/*.test.cjs
```

Configuration and request-boundary checks run locally; remote SSH, VNC, and Windows terminal workflows require your own configured hosts.

MIT; see [LICENSE](LICENSE). The Three.js renderer includes its dependency notice under `public/render3d/vendor/`.
