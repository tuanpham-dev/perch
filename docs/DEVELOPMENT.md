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

## Desktop app

The desktop app lives in `desktop/`, a separate npm package (not a workspace) with a Tauri 2 shell in `desktop/src-tauri` and the launcher window in `desktop/launcher`. You need Rust and, on Linux, `libwebkit2gtk-4.1-dev libayatana-appindicator3-dev librsvg2-dev`.

```bash
npm install                      # the repo, once
cd desktop && npm install
npm run stage                    # build the web app, stage Node + the server into src-tauri/resources/perch
npm run dev                      # run the app (debug build)
npm run build                    # stage, then build this platform's packages into src-tauri/target/release/bundle
```

`PERCH_DESKTOP_BUNDLE=<dir>` points the app at another staged server. On a headless Linux host, run it under `xvfb-run`, or use `desktop/scripts/spike.sh`, which starts a virtual display and can type, run JS in the window and take screenshots. A debug build also evaluates any `<window label>.js` dropped in `PERCH_DESKTOP_QA_DIR` in that window. A manual run of the Desktop app workflow (`.github/workflows/desktop.yml`) builds every platform's packages as the run's artifacts; a release tag does that and drafts the release (see Releasing).

## Releasing

Perch has one SemVer version, kept identical in the root, `server`, `client`, `mux` and `desktop` `package.json` files, both lockfiles, `desktop/src-tauri/Cargo.toml` (and `Cargo.lock`) and `desktop/src-tauri/tauri.conf.json`. `npm test` fails, naming the file, if any of them differ. Don't change them by hand: the release command does.

```bash
npm run release -- 0.2.0           # or 0.2.0-rc.1 for a pre-release
```

On a clean tree, it sets the version in every manifest, drafts a `CHANGELOG.md` entry from the commit subjects since the previous release tag and opens it in `$EDITOR` to edit, then makes a "Release 0.2.0" commit and an annotated `v0.2.0` tag. It doesn't push. It refuses a dirty tree, a version that isn't newer than the current one, and a tag that already exists. `--yes` skips the editing step.

Then push the commit and the tag:

```bash
git push origin main v0.2.0
```

The tag runs the Desktop app workflow. It builds every platform, signs the app's update files, and creates a **draft** GitHub release "Perch 0.2.0". The release notes are that version's `CHANGELOG.md` entry, and the release carries every package plus `latest.json`, the file installed apps check. A tag with a suffix (`-rc.1`) makes a pre-release. Review the draft and publish it. Publishing is what makes it count: `install.sh`, `perch update`, the servers' update check and the apps' updater only see published releases.

Compatibility minimums change only when a change breaks the other side: `MIN_DESKTOP_VERSION` in `server/src/version.ts` (the oldest app a server works with) and `MIN_SERVER_VERSION` in `desktop/src-tauri/src/compat.rs` (the oldest server the app works with).

### The update key

The desktop app installs only updates signed with the project's update key (minisign, made with `npx tauri signer generate`). Its public half is `plugins.updater.pubkey` in `tauri.conf.json`. The private key and its password are the repository secrets `TAURI_SIGNING_PRIVATE_KEY` and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`, which the workflow uses. The maintainer's backup copy is in `.backups/` at the repo root (`perch-updater.key`, `.key.password` and `.key.pub`), which git ignores; keep another copy somewhere safe off the machine. Without the private key, a release can't be signed, so installed apps can't update themselves. A new key would need every user to install one release by hand.

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
desktop/    The desktop app (Tauri) - see Desktop app above
examples/   hello-extension — a reference extension covering every surface in [EXTENSION_API.md](EXTENSION_API.md)
plans/      Design docs written during development
```
