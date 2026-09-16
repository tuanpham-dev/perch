# Architecture: minimal core, extendable via extensions

Perch's guiding structural rule:

> **New feature work starts as an extension.** The core only grows when a
> feature needs an *extension point* that doesn't exist yet — in which case
> the point is added to core and the feature still lands as an extension.

"Core" is the infrastructure a browser terminal workspace cannot exist without; every
feature *surface* — panels, viewers, decorations, previews, SCM, search,
even the terminal rendering engines themselves — ships as a bundled
extension under [`extensions/`](../extensions), uninstallable and
overridable like any user-installed one.

## What is core

| Area | Why it stays core |
| --- | --- |
| Terminal attach (server `terminals.ts`, `multiplexer.ts`, `wsAttach.ts`; client `TerminalView`) | The product itself: session/window listing, WS attach, input pipeline (sticky Ctrl, local echo, mouse reports). |
| The terminal engine **seam** (`client/src/engines/`) | Only the `CreateTerminalEngine` types and registry resolution — both implementations are extensions (see below). |
| File tree + file operations (server `files.ts`; client `FileTree`) | Browse/create/rename/delete/copy/upload, plus `listRepoFiles` — the quick switcher's gitignore-aware file listing, a files-feature fast path that shells out to git as an implementation detail (not SCM UI). |
| Settings / keybindings / theme host (`settings.ts`, `keybindings.ts`, `theme.ts`, `SettingsView`) | Host surfaces that render extension contributions (themes, fonts, configuration, custom settings components). |
| Quick switcher (`QuickSwitcher`) | A host surface like Settings — core sources (tabs/windows/sessions/files) plus extension-provided results. |
| Extension host (`extensions.ts` both sides) | Discovery, manifests, enable/disable/install, the client registries, the server `host` API, and the required-builtin mechanism. |
| Security, proxy, tunnel, push (server `security.ts`, `proxy.ts`, `wsTunnel.ts`, `push.ts`; client `sw.ts`) | Origin gating, port forwarding, and web push are PWA/network infrastructure. **Port attribution** (`ports.ts`) stays core because `getTunnelablePorts()` is the WS tunnel's security gate — the ports *extension* consumes the same data via `host.ports` instead of re-scanning. |
| Engine-support helpers (`mouseReports.ts`, `terminalLinks.ts`, `contrast.ts`, `lib/terminalInput.ts`) | Shared by core (TerminalView, touchSelect, localEcho) *and* extension engines/accessories — exposed to extension bundles through the `@perch/engine-support` shim (below), never duplicated. |

## What is an extension

Everything else. The bundled set (all under `extensions/`):

- **Previews** — `image-preview`, `media-preview`, `pdf-preview`, `markdown-preview`, `json-preview`, `csv-preview`, `live-preview`
- **git-scm** — the SOURCE CONTROL panel, diff/conflict viewers, **and** the FILES-tree git status decorations + branch pill (file-decoration provider; its server hook runs the repo status scan)
- **search** — the SEARCH panel
- **ports** — the PORTS explorer section (list/kill via the server `host.ports` API)
- **subagent-viewer** — Claude Code subagent count badges on session windows + the details popover (session-decoration provider; its server hook reads Claude Code's on-disk transcripts)
- **worktrees** — palette commands that open the PROJECTS tree's create-worktree form (`ctx.app.newWorktree`) and start Clean Up Worktrees (`ctx.app.cleanUpWorktrees`). Worktrees themselves are core: `server/src/gitWorktrees.ts` owns every `git worktree` call, `/api/git/worktrees` serves the tree's middle level, and `client/src/lib/projects.ts`'s `projectTree` groups sessions by repository — an extension can't contribute rows to a core tree. See `plans/worktrees-into-projects.md`
- **xterm-engine** — the xterm.js terminal engine and the default. **Required builtin** (`perch.required: true`): it is the app's rendering floor, so the platform refuses to disable or uninstall it, and ignores stale state-file entries for it. The engine registry falls back to it whenever the selected engine is missing. (The alternative `ghostty-engine`, the ghostty-web WASM engine, is no longer bundled — it lives in the `perch-extensions` registry as an optional install.)
- **touch-keys** — the mobile touch-key bar / floating toggle / voice input / image-upload key, with its drag-and-drop layout editor rendered via a custom settings component
- **Assets** — `plastic-legacy-theme`, `seti-icons`, `ibm-plex-mono` / `mono-fonts` (default look; hard fallbacks in core cover the gap when disabled)

## Extension points

One-line contracts below; the full API reference — signatures, host props,
lifecycle rules, and worked examples per point — is
[EXTENSION_API.md](EXTENSION_API.md).

Client (`client/src/extensions.ts`, handed to `activate(ctx)`):

| Point | Contract (one line) |
| --- | --- |
| `registerCommand` | Palette/keybinding command, auto-namespaced. |
| `registerFileViewer` | Full-tab viewer for file extensions (`mode: "default" \| "preview"`). |
| `registerSidebarPanel` | A sidebar surface — `location: "tab"` (own tab, default) or `"explorer"` (accordion section beside SESSIONS/FILES, with persisted order/collapse/size under its namespaced id and an always-registered focus command). |
| `registerWindowAction` | Icon button on SESSIONS window rows (+ optionally the tab bar). |
| `registerFileDecorationProvider` | Per-path `{ badge, tooltip, className }` for the FILES tree plus a root decoration (the branch pill). Sync from provider-owned cache; `refresh()` to re-render. |
| `registerSessionDecorationProvider` | Badges on SESSIONS window rows with an `onClick(anchorRect, ctx)` for extension-owned popovers. |
| `registerTerminalEngine` | A `CreateTerminalEngine` factory (the seam in `client/src/engines/types.ts`); resolved against the terminal-engine setting after the extensions-settled gate. |
| `registerTerminalAccessory` | Per-terminal UI in the `"bar"` (below the terminal) or `"overlay"` (inside the terminal body) slot, receiving a context with send-input/send-text/upload, sticky-Ctrl, foreground command, focus, mobile-pointer state, and soft-keyboard suppression (`setSoftKeyboardSuppressed` — for accessories that replace the OS keyboard). |
| `registerQuickSwitcherProvider` | Result rows for the quick switcher's non-command mode (sync from cache + `refresh()`). |
| `registerSettingsComponent` | A custom React component rendered inside the extension's Settings section, below its scalar `contributes.configuration` controls — for config that outgrows scalars (persist via `ctx.settings.set`, e.g. as a JSON-string property). |
| `ctx.settings.get/set/onDidChange` | The extension's own configuration values (manifest defaults + user overrides, server-synced). |
| Manifest contributions | `contributes.themes` / `iconThemes` / `fonts` / `configuration` — data-only, no code runs. |

Server (`activate({ router, log, getSettings, host })`):

| Piece | Contract |
| --- | --- |
| `router` | Express router mounted at `/api/ext/<extensionId>` while enabled. |
| `getSettings()` | The extension's current configuration values. |
| `host.ports.list()/find(port)` | Core port attribution (listening ports owned by terminals) — shared with the tunnel gate. |
| `host.events.onApiMutation(cb)` | Fires after any mutating core API call — invalidate caches that mirror on-disk state (git-scm's decoration scan uses this to match the old core cache-invalidation behavior). Returns an unsubscribe; all of an extension's subscriptions drop on unmount. |

### Sharing code with extensions

Bundled extensions never import core modules. Two mechanisms instead:

- **Host-instance shims** (`extensions/_shared/shims/`, aliased by `extensions/build.mjs`): `react`, `react-dom`, `react-dom/client`, `react/jsx-runtime`, and `@perch/engine-support` re-export the host's own instances via `window.__perchModules` (set in `client/src/main.tsx`). Anything with identity or shared state — React, the synthetic-select-start Symbol, `findCandidates`, `whenMatches` — must come from here, never a bundled copy.
- **Source copies** (`extensions/_shared/*.ts(x)`): small stateless helpers (Icon, `useListNavigation`, clipboard, the `terminalEngineTypes` seam copy) each extension inlines at build time; structural typing keeps them interoperable with the host's originals.

### The required-builtin mechanism

`perch.required: true` in a manifest — honored **only** for bundled
extensions (a user-installed extension claiming it is ignored) — makes an
extension non-disableable and non-uninstallable: `setExtensionEnabled` /
`uninstallExtension` reject it, `listExtensions` ignores stale tombstones or
`false` entries for it, and the extension page shows a "Required" chip in
place of those actions. Today only `xterm-engine` carries it: the app can
degrade to "no badges" or "no panel", but never to "no terminal".

## Future candidates

- Quick-switcher sources in bundled extensions: git-scm branch switching,
  search text-jump results (`registerQuickSwitcherProvider` is live and
  scratch-verified; no bundled extension adopts it yet).
