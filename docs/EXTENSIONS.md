# Extensions

Where extensions live, what ships bundled, and how to build one. The
manifest, every API surface and the security model are documented in
[EXTENSION_API.md](EXTENSION_API.md); the core-versus-extension boundary is
explained in [ARCHITECTURE.md](ARCHITECTURE.md).

Extensions live as folders under `~/.config/perch/extensions/<folder>/` — either drop one in directly (the server picks it up on next scan/restart), or install a packed `.perch` from the sidebar's **Extensions** tab, which also lists what's installed and lets you enable/disable or uninstall each one. A worked example covering the basic surfaces is in [`examples/hello-extension`](../examples/hello-extension), and **[EXTENSION_API.md](EXTENSION_API.md) is the complete API reference**.

Every built-in file preview (image, media, PDF, markdown, JSON/YAML, CSV, HTML) — the SOURCE CONTROL, SEARCH, TASKS, SNIPPETS, and HISTORY panels — the status bar's port list — the FILES-tree git decorations — the subagent activity badges — the touch key bar — the default (xterm) terminal engine — the built-in Claude Code and Codex agent definitions — and the app's default color theme, icon theme, and terminal font — is itself a bundled extension under the repo's own [`extensions/`](../extensions) directory, discovered alongside `~/.config/perch/extensions/` — see [Bundled extensions](#bundled-extensions) below and [ARCHITECTURE.md](ARCHITECTURE.md) for the core-vs-extension boundary. A user-installed extension with the same id always takes precedence over a bundled one.

## Bundled extensions

Two shapes of bundled extension live under `extensions/<name>/`:

- **Functionality extensions** (one per built-in preview — `image-preview`, `media-preview`, `pdf-preview`, `markdown-preview`, `json-preview`, `csv-preview` — plus `git-scm` (the SOURCE CONTROL panel **and** the FILES-tree git status decorations/branch pill), `search`, `live-preview` (the sandboxed HTML preview), `ports` (the status-bar port readout, its port list, and the in-app port proxy tab), `tasks` (the TASKS section of the Run tab), `snippets` (the SNIPPETS section of the Commands tab), `command-history` (the HISTORY section of the Commands tab and the `!` quick-switcher mode), `file-guard` (the info tab for binary or oversized files), `subagent-viewer` (Claude Code subagent badges + popover), `worktrees` (palette entry points for the tree's create-worktree form), `touch-keys` (the mobile touch key bar and its layout editor), and the `xterm-engine` terminal engine — a **required builtin** (`perch.required`): the app's rendering floor, so it can't be disabled or uninstalled and is the automatic fallback whenever the selected engine is missing (the optional `ghostty-engine` lives in the extensions registry, not bundled)) ship a normal extension manifest plus a `src/client.tsx` built by `extensions/build.mjs` into `dist/client.js` (+ `dist/client.css` if it imports any CSS). `npm run build`/`npm run dev` build these automatically (`prebuild`/`predev` hooks); `npm run build:extensions` builds them standalone, and `node extensions/build.mjs --watch` rebuilds on save (what `npm run dev` runs in the background).
- **Asset-only extensions** (`plastic-legacy-theme`, `seti-icons`, `ibm-plex-mono` — the app's default color theme, icon theme, and terminal font) have no `src/client.tsx`, so `build.mjs` skips them entirely; their manifest just points at theme/font files directly. All three are enabled by default, giving a fresh install the same look it always had, but each is now independently disable-/uninstallable/overridable like any other extension — a hard-coded fallback (styles.css's `:root` values, "no icon theme", generic `monospace`) covers the gap if one is off. `agents` (the Claude Code and Codex agent definitions) is likewise skipped by `build.mjs`: it's a manifest plus a plain `server.js`, with no client entry.

Bundled extensions are enabled by default and show a **Built-in** badge on their page in the Extensions tab. Uninstalling one doesn't delete repo files — it's tombstoned in `~/.config/perch/extensions-state.json` and goes inactive, then reappears in the Extensions tab's **Available** section like any other installable extension, with an **Install** button that restores it (installing a `.perch` with the same id, which overrides the bundled copy, also restores it). Required builtins can't be uninstalled at all.

A bundled-style extension's own sources (`src/client.tsx`, npm deps, the
`extensions/_shared/` helpers and the React shims every bundle must alias
through) are covered by
[Sharing the host runtime](EXTENSION_API.md#sharing-the-host-runtime) and
[Building and packaging](EXTENSION_API.md#building-and-packaging).

## Writing one

Start from [`examples/hello-extension`](../examples/hello-extension) - a
plain ESM `client.js` with no build step - and reach for
[EXTENSION_API.md](EXTENSION_API.md) for the rest:

| | |
|---|---|
| [The manifest](EXTENSION_API.md#the-manifest-packagejson) | `perch.client`/`perch.server`, and every `contributes` key: color themes, icon themes, fonts, terminal engines, editors, agents, settings |
| [Client API](EXTENSION_API.md#client-api) | Everything `activate(ctx)` can register, plus the `ctx.app` host API |
| [Server API](EXTENSION_API.md#server-api) | The Express router at `/api/ext/<id>`, settings, secrets, and the `host` services |
| [Agent hooks](EXTENSION_API.md#agent-hooks) | Reporting back from an AI agent's own hooks |
| [Sharing the host runtime](EXTENSION_API.md#sharing-the-host-runtime) | Why React must be aliased, not bundled |
| [Building and packaging](EXTENSION_API.md#building-and-packaging) | `dist/client.js`, and what a `.perch` archive is |
| [Security model](EXTENSION_API.md#security-model) | There is no sandbox - what that means for authors and installers |
