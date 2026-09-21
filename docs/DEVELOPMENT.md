# Development

Running Perch from a clone, and what lives where.

## Manual setup (from source)

Prefer the [managed install](INSTALL.md) for an updatable install. To run from a clone directly instead:

```bash
npm install
```

## Development

Runs the server (`:3001`) and Vite dev server (`:5173`, proxying `/api` and `/ws` to the server) together:

```bash
npm run dev
```

Open http://localhost:5173.

## Project layout

```
mux/        The terminal daemon — owns every terminal (node-pty), replays history on attach, snapshots to disk
server/     Express + ws — REST API and the WS bridge to the daemon; talks to it only through server/src/multiplexer.ts
client/     React + TypeScript — the browser UI; the terminal-engine seam under src/engines/ (engines are extensions: the bundled xterm-engine lives in extensions/)
extensions/ Bundled extensions (previews, git, search, ports, tasks, snippets, touch keys, agents, default theme/icons/font) — see [Extensions](EXTENSIONS.md#bundled-extensions)
cli/        tunnel.mjs — standalone port-forwarding client, served at GET /tunnel.mjs
bin/        perch — entry point of the CLI for managing an installed instance, see [Install](INSTALL.md)
cli/        perch/ — that CLI (Node; systemd and launchd behind one service-manager interface)
systemd/    perch.service — the user-mode systemd unit installed by install.sh
examples/   hello-extension — a reference extension covering every surface in [EXTENSION_API.md](EXTENSION_API.md)
plans/      Design docs written during development
```
