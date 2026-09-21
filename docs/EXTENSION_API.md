# Extension API reference

Everything an extension can do, in one place. For *why* the app is split the
way it is — what belongs in core versus an extension — see
[ARCHITECTURE.md](ARCHITECTURE.md). For a worked example that exercises the
basic surfaces with zero build tooling, see
[`examples/hello-extension`](../examples/hello-extension); the bundled
extensions under [`extensions/`](../extensions) are the reference
implementations for every advanced surface (each section below names the one
to read).

- [Anatomy and lifecycle](#anatomy-and-lifecycle)
- [The manifest (`package.json`)](#the-manifest-packagejson)
  - [`perch`](#perch)
  - [`contributes.themes`](#contributesthemes)
  - [`contributes.iconThemes`](#contributesiconthemes)
  - [`contributes.fonts`](#contributesfonts)
  - [`contributes.terminalEngines`](#contributesterminalengines)
  - [`contributes.editors`](#contributeseditors)
  - [`contributes.agents`](#contributesagents)
  - [`contributes.configuration`](#contributesconfiguration)
- [Client API](#client-api)
  - [`activate(ctx)` / `deactivate()`](#activatectx--deactivate)
  - [Commands](#commands--registercommand)
  - [File viewers](#file-viewers--registerfileviewer)
  - [File-open interceptors](#file-open-interceptors--registerfileopeninterceptor)
  - [Sidebar panels](#sidebar-panels--registersidebarpanel)
  - [Sidebar tabs](#sidebar-tabs--registersidebartab)
  - [Sidebar tab menu items](#sidebar-tab-menu-items--registersidebartabmenuitem)
  - [File menu items](#file-menu-items--registerfilemenuitem)
  - [Tab group menu items](#tab-group-menu-items--registertabgroupmenuitem)
  - [Window actions](#window-actions--registerwindowaction)
  - [File decorations](#file-decorations--registerfiledecorationprovider)
  - [Session decorations](#session-decorations--registersessiondecorationprovider)
  - [Terminal engines](#terminal-engines--registerterminalengine)
  - [Editors](#editors--registereditor)
  - [Terminal accessories](#terminal-accessories--registerterminalaccessory)
  - [App overlays](#app-overlays--registerappoverlay)
  - [Status bar items](#status-bar-items--registerstatusbaritem)
  - [Quick-switcher providers](#quick-switcher-providers--registerquickswitcherprovider)
  - [Settings components](#settings-components--registersettingscomponent)
  - [The `ctx.app` host API](#the-ctxapp-host-api)
  - [`ctx.serverFetch` / `ctx.assetUrl`](#ctxserverfetch--ctxasseturl)
  - [`ctx.settings`](#ctxsettings)
- [Server API](#server-api)
- [Agent hooks](#agent-hooks)
- [Sharing the host runtime](#sharing-the-host-runtime)
- [Building and packaging](#building-and-packaging)
- [Security model](#security-model)
- [Terminals without tmux](#terminals-without-tmux)

---

## Anatomy and lifecycle

An extension is a folder with a `package.json` manifest, discovered from two
places:

1. **Bundled** — the repo's own `extensions/<folder>/` (shipped with the
   app; shows a *Built-in* badge in the Extensions tab).
2. **User-installed** — `~/.config/perch/extensions/<folder>/`
   (`$XDG_CONFIG_HOME` respected), either dropped in directly or unpacked
   from a `.perch` installed through the Extensions tab's Install from .perch.

A user-installed extension with the same id **always wins** over a bundled
one — that's how you override a built-in preview, and one way to restore a
tombstoned builtin (installing it from the Available section, below, is the
other).

**Extension id** = `<publisher>.<name>` from the manifest (falling back to
the folder name if either is missing or unsafe). Ids are used as URL path
segments (`/api/ext/<id>`, `/api/extensions/<id>/file/*`), so they must
match `[a-zA-Z0-9][a-zA-Z0-9._-]*`.

**State** lives in `~/.config/perch/extensions-state.json`: `true` /
`false` per id for enabled/disabled, or `"uninstalled"` to tombstone a
builtin (its repo files are never deleted). A tombstoned builtin stays
inactive (`enabled: false`, `uninstalled: true` in its `ExtensionInfo`) but
surfaces in the Extensions tab's **Available** section like a normal
installable extension — its **Install** clears the tombstone back to enabled
— rather than vanishing from the list. A *required builtin* (see
[`perch.required`](#perch)) ignores this file entirely and can't be
disabled or uninstalled.

**Lifecycle timing:**

- Server hooks mount at server startup (for everything enabled) and on
  enable; they unmount on disable/uninstall. The ES module itself stays
  resident until the server restarts — Node can't unload it — so a server
  entry may export an optional `deactivate()`, which runs after its routes
  unmount, to stop its own timers and watchers.
- Client entries dynamic-import and `activate()` once per page load, after
  the extension list and settings have loaded. Disable/enable while the page
  is open calls the module's optional `deactivate()` and re-`activate()`s
  live — every `register*` contribution is automatically unregistered on
  deactivation, but anything you created outside the registries (injected
  stylesheets, your own DOM roots, timers, subscriptions) is yours to tear
  down in `deactivate()`.
- Terminal-engine extensions are excluded from that page-load pass and
  activated on demand once the extension list is known. The sidebar waits on
  an internal *extensions-settled* gate (every activation finished, or 5s)
  before showing panes homed in extension tabs — your `activate()` should do
  its `register*` calls synchronously so contributions are present when the
  gate opens.
- Themes, icon themes, and fonts are **data-only** manifest contributions:
  the host reads them straight from the extension list without running any
  extension code, and they apply without a reload.

---

## The manifest (`package.json`)

A VS Code-shaped manifest. Unknown fields are ignored, and malformed
entries inside `contributes` are skipped individually rather than failing
the whole extension.

```jsonc
{
  "name": "my-extension",          // required for .perch install; part of the id
  "publisher": "me",               // id becomes "me.my-extension"
  "version": "1.0.0",
  "displayName": "My Extension",   // shown in Settings (falls back to name)
  "description": "One line shown in the extension list.",
  "icon": "./icon.svg",            // extension-relative; served via the file route

  "contributes": {
    "themes": [ ... ],             // color themes
    "iconThemes": [ ... ],         // file-icon themes
    "fonts": [ ... ],              // terminal font groups
    "terminalEngines": [ ... ],    // terminal engines (with registerTerminalEngine)
    "editors": [ ... ],            // editors (with registerEditor)
    "agents": [ ... ],             // AI agents for the app's registry (declared only)
    "configuration": { ... }       // settings (object, or an array of them)
  },

  "perch": {
    "client": "./dist/client.js",  // ESM client entry (omit if none)
    "server": "./server.js",       // ESM server entry (omit if none)
    "required": true               // bundled-only; see below
  }
}
```

### `perch`

| Field | Meaning |
| --- | --- |
| `client` | Extension-relative path to the browser entry — an ESM module exporting `activate(ctx)` (and optionally `deactivate()`). Dynamic-imported by the host; see [Client API](#client-api). |
| `server` | Extension-relative path to the server entry — an ESM module exporting `activate({ router, log, getSettings, ai, secrets, host })` (and optionally `deactivate()`); see [Server API](#server-api). |
| `required` | **Bundled extensions only** (silently ignored on user-installed ones, which could otherwise claim it). Marks the extension as a *required builtin*: the server refuses `disable`/`uninstall`, ignores stale state-file entries for it, and the UI shows a **Required** chip instead of those actions. Reserved for surfaces the app cannot function without — currently only `xterm-engine`, the terminal rendering floor. |

### `contributes.themes`

```jsonc
"themes": [
  { "label": "My Dark", "uiTheme": "vs-dark", "path": "./themes/my-dark.json" }
]
```

VS Code color-theme JSON, resolved relative to the theme file's own
directory (`include` supported). The Settings → UI color-theme dropdown
lists each entry as `<extensionId>:<label>`. Themes drive both the app's
CSS variables and the terminal palette; keys the theme doesn't set keep the
core hard-fallback values. Reference: `extensions/plastic-legacy-theme`.

### `contributes.iconThemes`

```jsonc
"iconThemes": [
  { "id": "my-icons", "label": "My Icons", "path": "./themes/my-icon-theme.json" }
]
```

VS Code file-icon-theme JSON (icon definitions, font glyphs, per-extension/
per-name mappings). `iconPath`/font paths resolve relative to the theme
JSON's own directory. Reference: `extensions/seti-icons`.

### `contributes.fonts`

Not a VS Code concept — Perch's own extension of `contributes`, for
terminal fonts:

```jsonc
"fonts": [
  {
    "group": "My Mono",                    // the font picker's unit of selection
    "fonts": [
      {
        "family": "My Mono",
        "src": [{ "path": "./fonts/my-mono-400.woff2", "format": "woff2" }],
        "weight": "400",                   // optional
        "style": "normal",                 // optional
        "unicodeRange": "U+0000-00FF"      // optional; per-script splitting
      }
    ]
  }
]
```

Within a group, entries sharing a `family` register different
weights/styles/unicode-ranges of one font (include a bold face — xterm
renders bold cells with it); entries with distinct families bundle
companion fonts (e.g. a Nerd Font symbols face) that ride along in the
stack when the group is picked. Reference: `extensions/ibm-plex-mono`.

### `contributes.terminalEngines`

```jsonc
"contributes": {
  "terminalEngines": [
    { "id": "xterm", "label": "xterm.js" }
  ]
}
```

Declares that this extension supplies a terminal engine for the
`terminalEngine` setting. Data-only: Settings → Terminal lists every enabled
extension's entries as `ext.<extensionId>.<id>` without running any extension
code, and the implementation arrives from
[`registerTerminalEngine`](#terminal-engines--registerterminalengine) under the
same id. Entries missing `id` or `label` are dropped.

Declaring one changes how the extension activates: it is left out of the
page-load activation pass and activated only when a terminal resolves to one
of its engines. Keep unrelated contributions in a separate extension, or they
won't exist until then. Reference: `extensions/xterm-engine`.

### `contributes.editors`

```jsonc
"contributes": {
  "editors": [
    { "id": "monaco", "label": "Monaco (Text Editor)", "capabilities": ["file", "diff", "merge"] }
  ]
}
```

Declares that this extension can act as **the** editor — what opens a file, a
git diff, or a merge conflict — for the app-wide `editor` setting. Data-only,
like `terminalEngines`: the Settings picker lists every installed editor from
this declaration without running any extension code, and the implementation
arrives separately from [`registerEditor`](#editors--registereditor) at
activation. The stored setting value is the namespaced `ext.<extensionId>.<id>`.

`capabilities` is what this editor can open. Anything it leaves out falls back
to nvim, which core provides and which handles all three — so an editor that
only declares `"file"` simply never receives diffs or conflicts. An entry
declaring none of the three is dropped.

### `contributes.agents`

An extension can add agents to the app's own registry (**Settings → AI Providers**),
so a plugin can teach the app about an agent core has never heard of without
the user defining one by hand. Declared, not activated: these are read from
the manifest, so a contributed agent is detected and offered for launching
whether or not your extension has a client or server entry.

```json
"contributes": {
  "agents": [
    {
      "id": "opencode",
      "label": "OpenCode",
      "program": "opencode",
      "command": "opencode",
      "resume": "opencode --continue",
      "skipPermissionsArgs": "--yolo",
      "docsUrl": "https://example.com/opencode",
      "icon": "hubot",
      "hooks": {
        "file": "~/.opencode/settings.json",
        "events": { "session-start": "SessionStart", "stop": "Stop" }
      }
    }
  ]
}
```

| Field | Meaning |
| --- | --- |
| `id` | Required. Namespaced with your extension id when merged (`<publisher>.<name>.<id>`), so two extensions cannot collide. |
| `label` | The name shown for the agent. Falls back to `program`, then `command`. |
| `program` | The foreground command a window running it reports — how a window is recognised as this agent. Omit for launch-only. |
| `command` | The full launch line. Omit for detection-only. An entry with neither is dropped. |
| `resume` | The line that picks the agent back up in the same folder (`claude --continue`). Typed into a window that was running the agent when terminals are restored after a restart, if **Resume agents** is on. Omit and a restored window stays at its shell prompt. |
| `skipPermissionsArgs` | Appended for the agent's no-prompts mode (also to `resume`). Empty means it has none, and no "skip permissions" choice is offered for it. |
| `hooks` | How the app should write this agent's hook config — see **The hooks descriptor** below. Omit it for an agent whose CLI has none; a malformed one costs the agent its hooks, not its row. |
| `oneShot` | How to run this CLI for a single prompt — see **The one-shot form** below. Declaring it also lists this agent as an AI provider under Settings → AI Providers. |
| `docsUrl` | Where to read about it, or how to install it — the row's link, and the only useful action for an agent whose CLI is absent. |
| `icon` | A codicon name for the row. Unknown or omitted falls back to a generic robot. |
| `iconUrl` | An image for the row — extension-relative or an absolute URL. Takes precedence over `icon`. |

Contributed agents are **not editable** in Settings — whoever contributed
them owns the command line — but the user can enable and disable them like
any other. The settings document records only that choice: an agent's
identity, including its hook descriptor, always comes from the manifest, and
an entry in the document that no installed extension contributes is dropped
rather than shown as a dead row. An agent whose `program` is not on `PATH` is
shown dimmed rather than offered as if it would run.

The app itself ships **no** agents. Claude Code and OpenAI Codex come from the
bundled `agents` extension, which is an ordinary extension using exactly the
contribution documented here — uninstall it and the list is empty.

#### The hooks descriptor

An agent's `hooks` says which file to write, in what shape, and what that CLI
calls each event. Only `file` and `events` are required; every other field
defaults to the commonest shape.

| Field | Default | Meaning |
| --- | --- | --- |
| `file` | required | The config file to write. `~` is expanded. A path outside `$HOME` is refused and the descriptor is dropped. |
| `events` | required | Maps the app's normalized event names (see the table further down) to what this CLI calls them. An event you leave out is one the app will never install or claim. An empty map drops the descriptor. |
| `ownership` | `"merged"` | `"merged"` — the file holds other things and the app only adds its own part. `"whole-file"` — the file is the app's, so the UI warns that replacing it discards what was there. |
| `container` | `{"key": "hooks"}` | Where the event map lives: under a top-level key, or `{"wrapper": "<name>", "extra": {…}}` for a CLI that wants a named wrapper object carrying its own fields. |
| `entry` | `"nested"` | The shape of one event's value. `"nested"` — a list of entries each with its own `hooks` array. `"flat"` — a list of handlers directly. |
| `matcherEvents` | `[]` | Raw event names that take `matcher: "*"`. Putting a matcher on an event that does not accept one is how a config file gets rejected at startup. |
| `extraFields` | `{}` | Top-level fields the CLI's parser requires. Written only when absent — a value the user put there is theirs. |
| `companion` | none | A second file to write alongside the hooks; see **Companions** below. Must sit in the same directory as `file`. |

The app writes only its own entries, recognised by the command being its own
hook shim and nothing else. A hand-written hook in the same file is never
read, rewritten or removed, whatever it points at, and every write is preceded
by a timestamped backup and performed as a temp-file rename.

A worked example of the other shape — a named wrapper whose event value is a
flat handler array, with no inner `hooks`. Antigravity's CLI is the real CLI
that reads this form:

```json
"hooks": {
  "file": "~/.gemini/config/hooks.json",
  "container": { "wrapper": "perch", "extra": { "enabled": true } },
  "entry": "flat",
  "events": {
    "session-start": "SessionStart",
    "prompt-submit": "PreInvocation",
    "stop": "Stop"
  }
}
```

which produces:

```json
{
  "perch": {
    "enabled": true,
    "SessionStart": [{ "type": "command", "command": "<shim> <agent> SessionStart", "timeout": 5 }],
    "Stop": [{ "type": "command", "command": "<shim> <agent> Stop", "timeout": 5 }]
  }
}
```

#### The one-shot form

An agent's `command` starts an interactive session in a pane. Answering one
prompt and printing a reply is a different invocation, and the app needs it for
text jobs — commit messages, AI command search, prompt refine. Declare it and
your agent appears as an AI provider automatically; there is no second list to
add it to.

```json
"oneShot": {
  "args": ["exec", "{modelArgs}", "{prompt}"],
  "modelArgs": ["-m", "{model}"],
  "listModelsArgs": ["models"]
}
```

| Field | Default | Meaning |
| --- | --- | --- |
| `args` | required | The argv after the binary. `{prompt}` is replaced by the prompt and **must** appear, or the whole form is dropped. `{modelArgs}` is a splice point: it expands to `modelArgs` below, or to nothing at all when no model is set. |
| `modelArgs` | `[]` | Included only when a model is named; `{model}` is replaced by it. It is a separate list, and `args` says where it goes, because CLIs disagree — `claude` takes `--model`, `codex` takes `-m` before the prompt. |
| `listModelsArgs` | none | A subcommand that prints the available models, one per line. Omit it and the app scrapes `--help` instead. |

The binary is the agent's `program`. The prompt is always its own argv entry —
never concatenated into a string, never passed through a shell — so a prompt
that looks like a flag stays a prompt. Non-string tokens in either list are
dropped rather than coerced.


#### Companions

Some CLIs need a second file before they will run a hook at all. Codex is the
example: it refuses to run a handler that is not trusted in
`~/.codex/config.toml`, and it does so **silently** — no warning, nothing in
its log, the hook simply never fires.

Declare the path as `companion` on the descriptor and register a transform
from your server entry:

```js
export function activate({ host }) {
  host.agentHooks.provideCompanion("codex", ({ hookFile, handlers, current }) => {
    // `current` is the file's existing text ("" when absent). Return what it
    // should become. `handlers` is what was just installed — each with
    // `rawEvent`, `command`, `timeoutSeconds`, `group` and `handler` — and is
    // EMPTY on uninstall, which is how you know to remove your entries.
    return rewrite(current, hookFile, handlers);
  });
}
```

The app does the reading and the writing, under the same backup and
temp-then-rename rules as the hook file, so a transform is a pure string
function. It is fenced accordingly: the path comes from the manifest and must
be in the hook file's own directory, output is capped at 64KB, and a transform
that throws, hangs or returns anything else is logged and skipped rather than
failing the install. Register one for an agent you did not contribute and
nothing happens.

### `contributes.configuration`

VS Code-shaped settings, rendered automatically in the extension's own
Settings section and readable from both entries:

```jsonc
"configuration": {
  "title": "My Extension",
  "properties": {
    "myExt.limit": {
      "type": "integer",                   // boolean | number | integer | string
      "default": 100,
      "minimum": 1,                        // number/integer only
      "maximum": 1000,
      "description": "Shown under the control."
    },
    "myExt.mode": {
      "type": "string",
      "default": "fast",
      "enum": ["fast", "thorough"],
      "enumItemLabels": ["Fast", "Thorough"],       // visible labels
      "enumDescriptions": ["…", "…"]                // option tooltips
    },
    "myExt.aiProfile": {
      "type": "string",
      "format": "ai-profile",              // renders a picker of Settings → AI Providers' list
      "default": "",                       // "" = the user's default AI
      "description": "Which configured AI this feature uses."
    },
    "myExt.aiModel": {
      "type": "string",
      "format": "ai-model",                // text box whose placeholder names the fallback
      "default": "",                       // "" = that AI's own configured model
      "description": "Model for this feature."
    }
  }
}
```

- Property keys are the **full dotted name** — declare your own prefix;
  nothing is prepended.
- Only scalar types render; `array`/`object` properties are dropped. For
  richer config, store a JSON **string** property and edit it with a
  [settings component](#settings-components--registersettingscomponent)
  (that's how `touch-keys` persists its key layout).
- An array of `{ title, properties }` sections is accepted and flattened in
  order.
- Values are server-synced: manifest defaults overridden by the user's
  stored values, shared across the user's devices.
- `"format": "ai-profile"` on a string property renders a dropdown of the
  AIs configured in **Settings → AI Providers** instead of a text box. The stored
  value is a profile id — pass it straight to `ai.run`'s `profileId`
  (`""` means "the user's default AI", which is also what an omitted
  `profileId` does). That is the sanctioned way to let someone point your
  feature at a cheaper or faster model than their everyday one, without
  your extension asking for keys or knowing what a provider is.
- `"format": "ai-model"` pairs with it: a text box for a per-feature model,
  whose placeholder names what an empty value falls back to (the model
  configured on the profile the sibling `"ai-profile"` property points at,
  else the user's default AI). Unless that AI is a custom
  command, the field also offers a **Fetch models** button, filling its
  suggestions from whatever the provider will say — an API endpoint's
  `/models` route, a CLI's own list subcommand, or the model names its
  `--help` documents — so whoever configures your extension picks from a
  real list instead of typing an id from memory. Pass the value
  as `ai.run`'s `model` — empty means "whatever that AI is set to", which is
  exactly what omitting it does.

---

## Client API

### `activate(ctx)` / `deactivate()`

`perch.client` is an ESM module. Without a build step, use
`ctx.React` and `React.createElement`; with one, alias React to the host's
instance instead of bundling a copy (see
[Sharing the host runtime](#sharing-the-host-runtime)).

```js
export function activate(ctx) {
  // synchronous register* calls; stash ctx pieces in module-level
  // variables for your components (the pattern every bundled extension uses)
}

export function deactivate() {
  // optional: remove stylesheets/timers/roots you created yourself;
  // register* contributions are removed for you
}
```

All `register*` ids are auto-namespaced to `ext.<extensionId>.<id>` — write
the short id, and expect the namespaced form anywhere the host reports ids
back (keybindings UI, sidebar state, the engine setting).

The **sync-from-cache + `refresh()`** contract, used by every `provide*`
API below: providers are called synchronously during render and must be
plain lookups — never fetch inside one. Keep your own cache (poll your
server hook, subscribe to events), and call the `{ refresh() }` handle
returned by the registration after the cache changes; the host re-renders
every consumer.

### Commands — `registerCommand`

```ts
ctx.registerCommand({
  id: string,
  label: string,            // palette text, e.g. "Git: Stage All Changes"
  defaultBinding?: string,  // keybindings combo, e.g. "ctrl+alt+KeyH"
  run: () => void,
});
```

Joins the command palette (`Ctrl+Shift+P`) and the Keyboard Shortcuts
settings, where users can rebind it. Combos use the keybindings.ts syntax:
modifiers + `KeyX`/`Digit1`/named keys, e.g. `"ctrl+shift+KeyG"`.

### File viewers — `registerFileViewer`

```ts
ctx.registerFileViewer({
  id: string,
  extensions: string[],       // lowercase, no dot: ["md", "markdown"] — [] = openViewerTab-only
  mode?: "default" | "preview" | (() => "default" | "preview"), // default "default"; a thunk is re-read on every lookup
  editorFallback?: boolean,       // default true; "default"-mode only
  component: React.ComponentType<FileViewerHostProps>,
});
```

- `"default"`: a FILES-tree click opens this viewer directly (image/media/
  pdf). `"preview"`: a click still opens nvim; the viewer is reached via
  the hover icon, the "Preview" context-menu item, or Shift+Enter
  (markdown/json/csv).
- `editorFallback` controls whether the context menu offers "Open in
  Editor" as an escape hatch from a `"default"`-mode viewer.
- Among same-extension matches, a user-installed viewer beats a bundled
  one; otherwise first registered wins.

```ts
interface FileViewerHostProps {
  filePath: string;
  active: boolean;                       // is this the focused tab
  toolbarTarget?: HTMLDivElement | null; // portal tab-bar controls here
  openInEditor?: (path: string) => void;
  showMenu?: (x: number, y: number, items: MenuItem[]) => void;
  setDirty?: (dirty: boolean) => void;   // closing a dirty tab confirms first
  reloadKey?: number;                    // bumped when an explicit open re-targets this tab
  setTitle?: (title: string) => void;   // rename this tab in place (no activate, no remount)
  fontSize?: number;                     // the configured terminal font size, px
}
```

Reference: any of the preview extensions; `git-scm` for `extensions: []`
viewers opened only via `ctx.app.openViewerTab`.

#### Context menus — `showMenu`

`showMenu`, passed to file viewers here and also to
[sidebar panels](#sidebar-panels--registersidebarpanel) and
[status bar items](#status-bar-items--registerstatusbaritem), opens the app's
own context menu at a point. Its items:

```ts
interface MenuItem {
  label: string;
  onClick: () => void;
  danger?: boolean;     // destructive styling
  checked?: boolean;    // leading check icon — for a toggle row. Setting it on
                        // ANY item (true or false) reserves the gutter, so a
                        // menu's labels stay aligned
  icon?: string;        // leading codicon name, same gutter; `checked` wins
  disabled?: boolean;   // dimmed and inert
  separator?: boolean;  // a divider row; label/onClick are placeholders
}
```

A menu closes on any click, including a `checked` toggle — so a toggle that
should stay visible after flipping has to reopen the menu itself.

### File-open interceptors — `registerFileOpenInterceptor`

```ts
ctx.registerFileOpenInterceptor(
  (path: string) => Promise<boolean>,   // true = handled, open nothing else
);
```

Gets a shot at every open that would otherwise reach the editor: a FILES-tree
click, `ctx.app.openFileTab`, a terminal link, the quick switcher, `perch open`
(`ctx.app.openInEditor` bypasses it). It runs **after**
`"default"`-mode viewer matching (so image/media/pdf keep their paths) and
before the editor the `editor` setting selects. Resolve `true` once you've
opened something yourself, typically your own `extensions: []` viewer via
`ctx.app.openViewerTab`; resolve `false` to pass. Interceptors run in
registration order and the first `true` wins.

It must **fail open**: a thrown error or rejection counts as `false` and falls
through to the next interceptor, then the editor, so a broken interceptor can
never make files unopenable. It is awaited on every open, so keep it fast and
cheap. This is the seam for decisions an extension list can't express, such as
content-sniffing a file server-side. There is no id and nothing to refresh;
it's removed on deactivation. Reference: `file-guard` (binary and oversized
files get a guard tab instead of nvim).

### Sidebar panels — `registerSidebarPanel`

```ts
ctx.registerSidebarPanel({
  id: string,
  title: string,
  icon?: string,                    // codicon name; default "extensions"
  location?: "tab" | "explorer" | "run" | "commands",  // default "tab"
  defaultCollapsed?: boolean,       // accordion locations only
  order?: number,                   // accordion locations only: default placement weight
  focusBinding?: string,            // default binding for the focus command
  defaultTab?: string,              // home as a pane of another panel of this extension
  component: React.ComponentType<SidebarPanelHostProps>,
});
```

Locations:

- **`"tab"`** — its own full-height sidebar tab in the icon strip (SOURCE
  CONTROL, SEARCH). The auto-registered "Sidebar: Focus *title*" command
  reveals/switches to the tab, or hides the sidebar if it's already active
  (VS Code's toggle). The command only exists if `focusBinding` or `defaultTab` is given.
- **`"explorer"`** — an accordion section inside the Explorer tab, beside
  the built-in PROJECTS/FILES sections. It participates fully in the
  accordion's drag-reorder, collapse, and splitter-resize persistence under
  its namespaced id; `defaultCollapsed` sets the state for users with no
  stored entry. The focus command is **always** registered (unbound unless
  `focusBinding` is given) and expands the section, then focuses its first
  focusable row.
- **`"run"`** — an accordion section inside the Run tab (TASKS).
  Same accordion semantics as `"explorer"`. The Run tab has no built-in
  sections: it appears in the strip only while some extension contributes a
  visible run panel.
- **`"commands"`** — an accordion section inside the Commands tab (the
  bundled command-history HISTORY and snippets SNIPPETS sections). Same
  contract as `"run"`: accordion semantics, tab visible only while a
  non-hidden panel exists.

```ts
interface SidebarPanelHostProps {
  actionsTarget?: HTMLDivElement | null;  // portal header-row buttons here
  showMenu?: (x: number, y: number, items: MenuItem[]) => void;
  confirmDialog?: (message: string, confirmLabel?: string) => Promise<boolean>;
}
```

`actionsTarget` is the panel header's actions container — portal refresh/
sync buttons into it (`createPortal`) so they sit beside the title instead
of inside the scrollable body. `confirmDialog` is the app's shared confirm
dialog, for destructive actions (e.g. killing a process). `showMenu` opens the app's
context menu; see [Context menus](#context-menus--showmenu) for its items.

Badge counts on `"tab"` panels are set later via
[`ctx.app.setSidebarBadge`](#the-ctxapp-host-api), not at registration.

References: `search` (tab), `tasks` (run), `command-history` / `snippets` (commands).

### Sidebar tabs — `registerSidebarTab`

```ts
const tab = ctx.registerSidebarTab({
  id: string,
  title: string,                    // tooltip, "Move to <title>", empty-tab hint
  icon: string,                     // codicon name for the tab strip
  side?: "left" | "right",          // where a newly placed tab goes; default "left"
});

interface SidebarTabHandle {
  id: string;                       // namespaced ext.<extensionId>.<id>
  update(patch: { title?: string; icon?: string }): void;
  reveal(): void;                   // show its sidebar and switch to it
  remove(): void;                   // delete the tab (see below)
}
```

A tab with **no panel of its own**: a container the user fills by moving
panes into it (dropping a pane header on its icon, or a pane's *Move to*
menu). Unlike a `"tab"` panel's tab it stays in the strip while empty, and
the sidebar shows a hint explaining how to fill it. The panes inside keep the
usual accordion behavior (collapse, reorder, resize).

- **Ids** are namespaced like panels, so they never collide with a panel's
  tab. Re-registering an id updates its title and icon.
- **Placement.** `side` only applies the first time the tab joins the layout;
  after that it stays wherever it sits (the user may have dragged it), and
  that placement syncs across devices like every other tab. `reveal()` right
  after registering works: it waits until the tab has been placed.
- **`remove()` deletes.** The tab leaves both strips and every pane that was
  in it returns to its default home. Call it when the user deletes the tab.
- **Deactivation doesn't delete.** When the extension is disabled or
  uninstalled its tabs simply stop being registered. Panes that were in them
  keep that as their stored home, show at their default home meanwhile, and
  go back into the tab when it is registered again.
- **Missing tabs in general.** The same rule applies to any tab whose owner
  is gone, including a pane moved into another extension's own tab. Until
  extension loading has finished (all activations done, or 5 seconds,
  whichever comes first) such panes aren't shown anywhere, so nothing jumps
  between tabs while extensions are still activating.
- **Feature detection.** Hosts older than this API don't have it; check
  `typeof ctx.registerSidebarTab === "function"` before using it.

Reference: `custom-tabs` in the
[perch-extensions](https://github.com/tuanpham-dev/perch-extensions)
registry.

### Sidebar tab menu items — `registerSidebarTabMenuItem`

```ts
ctx.registerSidebarTabMenuItem({
  id: string,
  label: string,
  order?: number,                   // ascending; unset sorts last
  isVisible: (ctx: SidebarTabMenuContext) => boolean,
  onClick: (ctx: SidebarTabMenuContext) => void,
});

interface SidebarTabMenuContext {
  tabId: string | null;             // the right-clicked tab, or null for the strip's empty area
  side: "left" | "right";
}
```

Adds an item to the sidebar tab strip's right-click menu, after the built-in
*Move to … Sidebar* item behind a separator. On the strip's empty area only
extension items show, and no menu opens when none is visible. `isVisible` runs
on every open; one that throws hides its item. Compare `tabId` with your
handles' `id` to offer actions for your own tabs only.

### File menu items — `registerFileMenuItem`

```ts
ctx.registerFileMenuItem({
  id: string,
  label: string,
  icon?: string,                    // codicon name for the menu's leading gutter
  order?: number,                   // ascending among extension items; unset sorts last
  isVisible: (path: string, isDir: boolean) => boolean,
  onClick: (path: string) => void,
});
```

Adds an item to the FILES tree's right-click menu for a single file or folder
row, after the built-in items behind a separator. `path` is absolute. The menu
is built on every open, so `isVisible` can read whatever state you keep; one
that throws hides only its own item. The bulk menu shown for a multi-row
selection is not a contribution point. Reference: `prompts` in the
[perch-extensions](https://github.com/tuanpham-dev/perch-extensions)
registry.

### Tab group menu items — `registerTabGroupMenuItem`

```ts
ctx.registerTabGroupMenuItem({
  id: string,
  label: string,
  icon?: string,
  order?: number,                   // ascending among extension items; unset sorts last
  isVisible: (ctx: TabGroupContext) => boolean,
  onClick: (ctx: TabGroupContext) => void,
});

interface TabGroupContext {
  sessionName: string;
  cwd: string | null;               // the session's active window's directory; null with no live window
}
```

Adds an item to a tab-group chip's windows dropdown (the chip's arrow button),
below the window list and *New Window* behind a separator. It is that dropdown,
not the chip's right-click menu, because the dropdown is where per-session
actions live; the right-click menu is about the group itself. Same per-open
evaluation and fail-safe `isVisible` as file menu items. Check
`typeof ctx.registerTabGroupMenuItem === "function"` (and the same for
`registerFileMenuItem`) if you support older hosts. Reference: `prompts` in the
[perch-extensions](https://github.com/tuanpham-dev/perch-extensions)
registry ("New Prompt Here", scoped to the group's `cwd`).

### Window actions — `registerWindowAction`

```ts
ctx.registerWindowAction({
  id: string,
  icon: string | ((ctx: WindowActionContext) => string), // codicon name
  title: string,                        // tooltip
  isVisible: (ctx: WindowActionContext) => boolean,
  onClick: (ctx: WindowActionContext) => void,
  showInTabBar?: boolean,               // default false
}): { refresh(): void };

interface WindowActionContext {
  sessionName: string;
  windowIndex: number;
  cwd: string;
  command: string;   // the pane's current foreground command
}
```

An icon button on PROJECTS-tree window rows (next to the built-in kill
button), shown only where `isVisible` returns true — `command` lets an
action target e.g. only windows running `claude`. `isVisible` re-evaluates
on the session list's own ~3s poll, so it's reactive for free.
`showInTabBar: true` also renders it in the tab bar when the matching
terminal window's tab is focused. `icon` may also be a function of the
same context returning a codicon name, evaluated on each render, so an
action can show state (a waiting bell, say) without re-registering. Call
the returned `refresh()` when that state changes, so rows re-render before
the next session poll.

### File decorations — `registerFileDecorationProvider`

```ts
const handle = ctx.registerFileDecorationProvider({
  id: string,
  provideDecoration: (path: string, isDir: boolean) => FileDecoration | undefined,
  provideRootDecoration?: (rootPath: string) => RootDecoration | undefined,
});
// handle.refresh() — call after your cached answers change

interface FileDecoration {
  badge?: string;      // short text at the row's right edge, e.g. "M"
  tooltip?: string;    // falls back to the badge text
  className?: string;  // extra class(es) on the whole row — colors/dimming
                       // come from YOUR stylesheet, not a color value here
}

interface RootDecoration {
  label: string;       // the tree-header pill text (the branch pill's slot)
  tooltip?: string;
}
```

Called per **visible row** on every FILES-tree render with **absolute**
paths — resolve them against whatever roots you know about and answer from
cache. `provideRootDecoration` is called with the tree's current root
directory on every sidebar render; it doubles as your signal for *which*
root is on screen (git-scm records it there and fetches that root's status
from its server hook). First provider with an answer wins per path;
decorations don't merge.

The badge element itself is core's `.file-tree-git-badge`; your
`className` lands on the row, so ship the color rules in your own
stylesheet. Reference: `git-scm` (`provideDecoration` +
`statusModel.mjs`).

### Session decorations — `registerSessionDecorationProvider`

```ts
const handle = ctx.registerSessionDecorationProvider({
  id: string,
  provideWindowDecoration: (ctx: SessionDecorationContext) => SessionDecoration | undefined,
  onClick?: (anchorRect: DOMRect, ctx: SessionDecorationContext) => void,
});

interface SessionDecorationContext {  // same snapshot shape as WindowActionContext
  sessionName: string;
  windowIndex: number;
  cwd: string;
  command: string;
}

interface SessionDecoration {
  badge: string;        // the pill text, e.g. a count
  tooltip?: string;
  className?: string;
}
```

Renders a clickable badge on PROJECTS-tree window rows (styled like the core
`.window-decoration-badge` pill). A window row can carry one badge per
provider. `onClick` receives the badge's bounding rect — position your own
popover from it, rendered into a root **you** own (via the
`react-dom/client` shim's `createRoot`) and torn down in `deactivate()`;
there is no host-rendered popover surface. Reference: `subagent-viewer`
(badge + popover + the "learn cwds from provide calls, poll, refresh"
cache pattern).

### Terminal engines — `registerTerminalEngine`

```ts
ctx.registerTerminalEngine({
  id: string,      // the engine setting stores "ext.<extId>.<id>"
  label: string,   // Settings → Terminal engine select text
  create: CreateTerminalEngine,
});
```

`CreateTerminalEngine` is the full terminal-engine seam —
`(options: TerminalEngineOptions) => Promise<TerminalEngineHandle>` — typed
in [`extensions/_shared/terminalEngineTypes.ts`](../extensions/_shared/terminalEngineTypes.ts)
(a structural copy of `client/src/engines/types.ts`; read that file for the
per-method contracts — write/fit/selection/link-hover/IME/etc.). This is
the deepest extension point in the app: implementing an engine means
satisfying every handle method TerminalView calls. One handle method is
optional: `setSoftKeyboardSuppressed(suppressed)` — set/remove
`inputmode="none"` on your hidden input element (the bundled xterm engine
does exactly that on `term.textarea`); it backs the accessory context's
soft-keyboard suppression, and the host calls it defensively plus
re-applies the standing value after engine creation.

Resolution: the `terminalEngine` setting stores a namespaced engine id (or
`"auto"`, which picks xterm on mobile pointers and ghostty elsewhere when
that optional engine is installed, else xterm).
TerminalView resolves it against the registry **once the extension list
is known**, activating only the engine's own extension; an unknown/stale id falls back to the required
`xterm-engine`, and an empty registry renders an explicit error surface.
Runtime helpers your engine will need (cell math, link candidates, the
synthetic-selection marker) come from the
[`@perch/engine-support` shim](#sharing-the-host-runtime).
References: `xterm-engine`, `ghostty-engine` (in the `perch-extensions` registry).

### Editors — `registerEditor`

```ts
ctx.registerEditor({
  id: string,          // the editor setting stores "ext.<extId>.<id>"
  label: string,       // Settings → Editor select text
  capabilities: ("file" | "diff" | "merge")[],
  openFile(path: string, line?: number): Promise<void>,
  openDiff?(req: DiffRequest): Promise<void>,
  openMerge?(req: MergeRequest): Promise<void>,
});
```

Supplies the implementation behind this extension's
[`contributes.editors`](#contributeseditors) declaration. Each callback opens
whatever UI it likes — in practice a tab of the extension's own registered
viewer, via `ctx.app.openViewerTab`.

Resolution is **per capability**, not per editor. When the user selects this
editor, a file open calls `openFile`, but a diff only reaches `openDiff` if
`"diff"` is declared *and* the callback exists; otherwise it falls through to
nvim, the core-provided editor that claims all three and can't be uninstalled.
Declare only what you implement.

`DiffRequest` and `MergeRequest` carry content rather than git revisions, so an
editor needs no git access of its own:

```ts
interface DiffRequest {
  title: string;
  original: { content: string; label: string };
  // `path` set = the modified side is a real file the editor may save to.
  // Absent = read-only, with readOnlyReason (when given) explaining why.
  modified: { content: string; label: string; path?: string; readOnlyReason?: string };
}

interface MergeRequest {
  title: string;
  path: string;   // the conflicted working file, markers and all
  ours: { content: string; label: string };
  theirs: { content: string; label: string };
  base?: { content: string; label: string };
  markResolved: () => Promise<void>;  // stage it, once no markers remain
}
```

Registrations are dropped when the extension deactivates, so disabling the
selected editor sends the next open back to nvim. Reference: the optional
`text-editor` extension (Monaco).

### Terminal accessories — `registerTerminalAccessory`

```ts
ctx.registerTerminalAccessory({
  id: string,
  placement: "bar" | "overlay",
  component: React.ComponentType<{ context: TerminalAccessoryContext }>,
});

interface TerminalAccessoryContext {
  focused: boolean;        // is this the focused terminal
  mobilePointer: boolean;  // matchMedia("(pointer: coarse) and (hover: none)")
  command: string;         // the pane's foreground command
  lastCommandEvent: TerminalCommandEvent | null; // latest shell-integration event, or null
  stickyCtrl: boolean;     // the app's sticky-Ctrl state for this terminal
  toggleStickyCtrl(): void;
  sendInput(data: string): void;   // raw bytes to the pty
  sendText(text: string): void;    // local-echo-aware text (voice, paste-like)
  uploadImage(file: File): void;   // the terminal's upload pipeline
  uploadImages(files: File[]): void; // multi-image: uploads all, inserts paths as one no-submit block
  setSoftKeyboardSuppressed(suppressed: boolean): void; // see below
  containerRef: React.RefObject<HTMLDivElement | null>; // the terminal body,
                                   // for "overlay" positioning
}
```

Rendered **per terminal**: `"bar"` accessories render after the terminal
body, in document flow (the docked touch-key bar's slot); `"overlay"`
accessories render inside the terminal body's positioning context (the
floating toggle's slot). Your component receives a fresh `context` each
render — return `null` whenever you shouldn't show (unfocused terminal,
your own settings say off), and register both placements unconditionally
if a setting picks between them, so flipping it applies live.

`sendInput` is the raw keystroke channel (sticky-Ctrl is applied by the
host's input pipeline, not here); `sendText` routes through the local-echo
overlay when it's active — use it for anything that's *typed prose* rather
than a control sequence. Reference: `touch-keys`.

`setSoftKeyboardSuppressed(true)` stops the OS soft keyboard from opening
when the user taps the terminal, without breaking input: the engine sets
`inputmode="none"` on its hidden input element, which stays focusable —
hardware keys and your accessory's own buttons keep working. It's for
accessories that *replace* the system keyboard (a full on-screen keyboard).
The request survives engine remounts (the host re-applies it to each new
engine instance) and no-ops on an engine that doesn't implement the seam's
optional `setSoftKeyboardSuppressed`. Two rules of thumb: make it
**opt-in behind one of your own settings** — while suppressed, your
accessory is the only on-screen text input, so users lose OS
autocomplete/dictation/IME — and call `setSoftKeyboardSuppressed(false)`
in `deactivate()` so disabling your extension restores normal behavior.

`lastCommandEvent` comes from shell integration and stays `null` until the
first event, or for good when the user hasn't sourced the snippet:

```ts
interface TerminalCommandEvent {
  pane: string;
  sessionName: string;
  event: "start" | "end";
  command: string;
  cwd: string;
  exitCode?: number;    // "end" only
  durationMs?: number;  // "end" only
}
```

The same object is also dispatched app-wide as a `perch:command-event`
`CustomEvent` on `window` (`detail` is the event), for code that isn't an
accessory, such as a panel that refetches history when a command finishes.
It is relayed by each open terminal view that receives it, so debounce rather
than count. Remove the listener in `deactivate()`. Reference:
`command-history`.

#### Opting out of the sidebar swipe — `data-no-sidebar-swipe`

On touch devices a fast horizontal flick anywhere toggles the sidebar
(left→right opens, right→left closes) or the right drawer when it has tabs. The host already skips flicks that
start inside a horizontally scrollable element, so tab strips and terminal
hscroll keep their gestures. UI whose own gesture is a *free* horizontal
drag rather than a scroll — a draggable floating control, a slider, a
swipeable card — is not detectable that way: put `data-no-sidebar-swipe` on
it (or on any ancestor) and touches starting inside are ignored by the
gesture. The host listens on `document` in the capture phase, so an
extension cannot preempt it from its own handlers; this attribute is the
seam. The bundled touch-keys extension uses it on its floating one-handed
toggle and key cluster.

### App overlays — `registerAppOverlay`

```ts
ctx.registerAppOverlay({
  id: string,
  component: React.ComponentType<{ context: AppOverlayContext }>,
});

interface AppOverlayContext {
  mobilePointer: boolean;  // matchMedia("(pointer: coarse) and (hover: none)")
  containerRef: React.RefObject<HTMLDivElement | null>; // the overlay layer
}
```

Renders your component **once**, over the editor area, on top of whatever tab
is active: a terminal, Settings, a viewer. That is the difference from a
terminal accessory, which mounts per terminal and only inside a terminal tab.
There is deliberately no `focused` or per-tab state.

The host draws every overlay into one `.app-overlay-layer`: absolutely
positioned over the editor area (right of the sidebar), `pointer-events: none`,
and stacked above tab content (including terminal accessories) but below menus,
dialogs and the quick switcher. Because the layer ignores the pointer, **your
component must set `pointer-events: auto` on its own interactive parts**, and
should leave the rest transparent so tabs underneath keep working.
`containerRef` is that layer, for positioning or clamping against the editor
bounds. Gate visibility yourself (return `null`), e.g. on `mobilePointer` or
your own setting. Reference: `one-hand` in the
[perch-extensions](https://github.com/tuanpham-dev/perch-extensions)
registry (a bottom swipe bar that runs commands through
`ctx.app.executeCommand`).

### Status bar items — `registerStatusBarItem`

```ts
ctx.registerStatusBarItem({
  id: string,
  title?: string,                   // name in the Status Bar show/hide list; default: extension display name
  placement?: "left" | "right",     // default "right"
  order?: number,                   // ascending within the group, default 0; ties break on id
  visibilitySetting?: string,       // a boolean key from your own contributes.configuration
  component: React.ComponentType<{ context: StatusBarItemContext }>,
});

interface StatusBarItemContext {
  mobilePointer: boolean;           // phone/tablet: the bar is compact
  showMenu(x: number, y: number, items: MenuItem[]): void;
  confirmDialog(message: string, confirmLabel?: string): Promise<boolean>;
  openPopover(anchor: DOMRect, content: React.ReactNode): void;
  closePopover(): void;
}
```

A compact readout, with an optional click action, in the app's bottom status
bar (22px tall, shown while Settings → UI → *Show status bar* is on). The
context is small on purpose: a menu (`showMenu`, see
[Context menus](#context-menus--showmenu)), a confirm, a popover. Anything richer
belongs in a sidebar panel the item can
[reveal](#the-ctxapp-host-api). Core's own terminal count closes the right
group, after any right-placed extension items.

Render a `<button className="status-bar-item">` (the host's own item styling;
put a codicon and a short number inside) and mark it
`data-menu-trigger="true"` whenever it opens a menu or popover. Clicks on
such an element don't count as outside clicks, so a second click toggles the
popover closed instead of dismissing it and immediately reopening it.

- **Popovers.** `openPopover(rect, content)` shows `content` in a floating
  panel anchored above the bar, clamped to the viewport. Pass the trigger's
  `getBoundingClientRect()`. The host owns positioning and dismissal (outside
  click, Escape, window blur), and the popover closes by itself when the item
  goes away. Calling it again while **this** item's popover is open closes it,
  so a button toggles without tracking state; another item's call replaces it.
  `content` is kept as the node it was at click time, so pass a **component**
  (`<MyPopover />`) that subscribes to its own data rather than a tree closing
  over the item's current state, which would freeze when the popover opened.
- **Confirm.** Use `confirmDialog` rather than `window.confirm` for a
  destructive action in a popover: the native dialog blurs the window, and blur
  closes the popover.
- **Phones.** The bar stays on phones, compact (`.status-bar.compact`), so your
  item renders there too. Drop it to its icon and number: either branch on
  `mobilePointer`, or put wordy parts in an element with the `full-only` class,
  which the compact bar hides. Long-pressing an item on touch picks it up to
  drag, so don't give an item a long-press gesture of its own.
- **User control.** Users drag any item to reorder it or move it between
  groups, and switch items off from the bar's right-click menu, the gear menu's
  **Status Bar** list, or a long-press on an empty stretch of the bar on a phone.
  The arrangement and the plain hidden list are stored per device, so
  `placement` and `order` are only defaults. With `visibilitySetting`, that
  boolean setting **is** the item's switch: the list reads and writes it, and
  the item renders unless the value is `false`, so an extension that already
  offers "show this in the status bar" keeps one control rather than two. Your
  component doesn't need to check it.

References: `ports` (popover with a confirmed kill), `git-scm` (`visibilitySetting:
"gitScm.statusBar"`), `examples/hello-extension` (no-build), and `system-stats` in the
[perch-extensions](https://github.com/tuanpham-dev/perch-extensions)
registry (`full-only` in a compact bar).

### Quick-switcher providers — `registerQuickSwitcherProvider`

```ts
const handle = ctx.registerQuickSwitcherProvider({
  id: string,
  provideResults: (query: string) => QuickSwitcherItem[],
});

interface QuickSwitcherItem {
  label: string;
  tag?: string;                    // the row's chip text; default "ext"
  run: (secondary: boolean) => void;  // secondary = Shift+Enter/Shift+click
}
```

Contributes rows to the quick switcher's **non-command** mode (`Ctrl+P`;
command mode already lists your `registerCommand`s). Called synchronously
per keystroke with the raw query — do your own matching against cached
data and **self-limit** result counts (core caps its own file matches at
50 for a reason). Ranked after the core tab/window/session groups and
before file matches. `refresh()` re-queries an open switcher when your
cache changes. A provider that throws contributes nothing rather than
breaking the list.

### Settings components — `registerSettingsComponent`

```ts
ctx.registerSettingsComponent({
  id: string,
  component: React.ComponentType,   // no props
});
```

Renders your component inside your extension's own Settings section,
**below** its scalar `contributes.configuration` controls. Registering one
earns the extension a Settings section even with zero scalar properties.
The component takes no props — read and write through `ctx.settings`
(stash it module-level in `activate()`), typically persisting rich state
as a JSON-string configuration property. The section's "Reset … Settings
to Defaults" button clears every stored value for the extension, so treat
"value absent" as "use defaults". Reference: `touch-keys`
(`TouchKeysEditor` + its `readKeys`/`writeKeys` JSON round-trip).

### The `ctx.app` host API

```ts
ctx.app.getActiveContext(): { sessionName: string | null; windowIndex: number | null; cwd: string | null }
ctx.app.onDidChangeContext(cb): () => void   // returns unsubscribe
```
The active tab's identity — the "current directory" for panels that follow
the user around (git-scm's status, search's scope).

```ts
ctx.app.openFileTab(path: string, line?: number): void
```
Opens a path through the same dispatch a FILES-tree click uses (whichever
`"default"`-mode viewer claims it, else a file-open interceptor such as
`file-guard`, else the editor the `editor` setting selects); `line` jumps
there when that editor supports it.

```ts
ctx.app.openViewerTab(viewerId: string, path: string, opts?: { title?: string }): void
```
Opens (or re-activates) a tab for one of **this extension's own**
registered viewers directly, bypassing extension matching — the route for
viewers registered with `extensions: []` (git-scm's diff view). Re-calling
for an open `(viewerId, path)` tab updates its title in place.

```ts
ctx.app.closeViewerTab(viewerId: string, path: string): void
```
Closes a tab of one of **this extension's own** viewers, the counterpart of
`openViewerTab`. It closes **without** the unsaved-changes confirm, even if the
viewer reported `setDirty(true)`. It's meant for a draft-style tab your own save
flow has just dealt with (save, then close). No-op when no such
`(viewerId, path)` tab is open. Reference: `prompts` and `text-editor` in the
[perch-extensions](https://github.com/tuanpham-dev/perch-extensions)
registry.

```ts
ctx.app.refreshFiles(): void
```
Bumps the FILES tree's refresh key so listings refetch now instead of on
the next poll — call it after mutating the working tree.

```ts
ctx.app.setSidebarBadge(panelId: string, badge: number | null): void
```
Sets/clears the count badge on one of this extension's own `"tab"` sidebar
panels (short id, un-namespaced). No-ops if the panel isn't registered.

```ts
ctx.app.setSidebarPanelVisible(panelId: string, visible: boolean): void
```
Hides or shows one of this extension's own panels (short id, un-namespaced)
for **context**: a panel with nothing to show right now, like TASKS with no
active directory. A hidden panel isn't rendered in whatever tab it currently
lives in, and a tab left with no visible sections (the Run tab, say) drops out
of the strip. This is separate from the user's own hide in the gear menu's
Panes list, and the two are ORed: you can't show a panel the user hid. It
notifies the whole sidebar on every call, so call it when the value changes,
not on every context event. No-ops if the panel isn't registered.
References: `tasks`, `command-history`.

```ts
ctx.app.revealSidebarPanel(panelId: string): void
```
Reveals one of this extension's own sidebar panels (short id, un-namespaced):
reveals the sidebar if hidden, switches to the panel's tab, and expands and
focuses its accordion section. This is what the panel's auto-registered
"Sidebar: Focus &lt;title&gt;" command does, minus that command's
toggle-hide-when-already-active branch — a command that opens a panel's UI
should never end with it hidden. No-ops if the panel isn't registered.

```ts
ctx.app.newWorktree(opts?: { runCommandIndex?: number }): void
ctx.app.cleanUpWorktrees(): void
```
The PROJECTS tree's own worktree flows, for commands that start them. Both
reveal the PROJECTS panel first, wherever it lives. `newWorktree` opens the
tree's create-worktree form on the active project (or the first repository
project); `runCommandIndex` preselects one of the configured run agents from
**Settings → AI Providers**, and omitting it preselects none. `cleanUpWorktrees`
starts *Clean Up Worktrees* on the active repository project (or the first with
linked worktrees): it lists the worktrees that are safe to remove (folder
already gone, or clean and merged, with no session) and removes them once the
user confirms, keeping their branches. A no-op when no project has worktrees.
To create or remove a worktree **without** UI, use
[`host.worktrees`](#server-api) from a server hook. Reference: `worktrees`.

```ts
ctx.app.openSessionWindow(sessionName: string, opts?: { createCwd?: string; windowIndex?: number }): void
```
Opens a session's active window as a window-tab, or the window at
`opts.windowIndex` when that window exists (focusing its tab if it is already
open). If no session by that
name exists, `opts.createCwd` creates it rooted there first — the same
create-then-open path the sidebar's pinned-session restore uses — and without
`createCwd`, a missing session surfaces an error to the user. A name that
collides with an existing session surfaces the backend's own "duplicate session"
error, so let the user pick or edit the name.

```ts
ctx.app.killSession(sessionName: string): void
```
Kills a session and closes its tabs. Prefer this over killing the session from
your server hook: window-tabs attach to synthetic grouped
`perch-view-*` sessions whose shared windows outlive the real session, so
killing it behind the app's back leaves them as live but orphaned tabs. Unlike the
sidebar's own Close Project (confirmed per `confirmBeforeKill`), this runs **no confirmation of its own** — the
caller owns the prompt, so an extension that already confirmed a larger
destructive action doesn't double-prompt. Confirm before calling.

```ts
ctx.app.confirmDialog(message: string, confirmLabel?: string): Promise<boolean>
ctx.app.promptDialog(message: string, defaultValue?: string): Promise<string | null>
ctx.app.pickItem(opts: { title: string; items: PickItem[]; current?: string; placeholder?: string }): Promise<string | null>
ctx.app.pickIcon(opts?: { title?: string; current?: string }): Promise<string | null>

interface PickItem {
  id: string;
  label: string;
  icon?: string;        // codicon drawn before the label
  detail?: string;      // dimmer text after it
  keywords?: string[];  // matched by the filter, never shown
}
```
The app's own dialogs, for flows that start outside a panel (a command, a
menu item). `confirmDialog` resolves `true` on confirm; `promptDialog`
resolves the entered text, or `null` on cancel (the text is not trimmed).
`pickItem` shows a filterable list: typing matches label, id and keywords,
labels starting with the query first; arrow keys and Enter choose; it resolves
the chosen `id`, or `null` on cancel. `current` starts that row highlighted.
`pickIcon` is `pickItem` over every codicon, searchable by name and by its
descriptive tags (typing "person" finds `account`), and resolves the icon
name. Each resolves `false`/`null` if the app isn't mounted yet.

```ts
ctx.app.getFileIcon(fileName: string): IconResult
ctx.app.getFolderIcon(folderName: string, expanded: boolean): IconResult
ctx.app.onDidChangeIconTheme(cb): () => void
```
Read-only queries against the *active* icon theme's resolver — the same
icons the FILES tree shows — so a panel can render file rows that match.
`IconResult` is `{ kind: "none" }` or a resolvable icon (see
`extensions/_shared/FileIcon.tsx` for a ready-made renderer).

```ts
ctx.app.getThemeColors(): Record<string, string>
ctx.app.getTokenColors(): TokenColorRule[]
ctx.app.onDidChangeColorTheme(cb: () => void): () => void

interface TokenColorRule {
  scope?: string | string[];
  settings?: { foreground?: string; fontStyle?: string };
}
```
The active color theme's raw workbench `colors` and TextMate `tokenColors`
rules, for an extension that runs its own scope-resolving highlighter rather
than styling with the app's CSS variables. Both are empty (`{}` / `[]`) when no
theme is active or it defines neither. `onDidChangeColorTheme` fires with no
arguments once a theme finishes loading or the user switches it; call the
getters again. It returns an unsubscribe and is dropped on deactivation.
Reference: `text-editor` in the
[perch-extensions](https://github.com/tuanpham-dev/perch-extensions)
registry (Monaco and Shiki themes built from these).

```ts
ctx.app.openInEditor(path: string, line?: number): void
```
Opens a path in whichever editor the `editor` setting selects — nvim by
default. This is `openFileTab`'s dispatch minus the viewer matching: use it
when you specifically mean "edit this", not "show this however the app
normally would".

```ts
ctx.app.openDiff(req: DiffRequest): Promise<boolean>
ctx.app.openMerge(req: MergeRequest): Promise<boolean>
```
Shows a two-sided diff, or opens a conflicted working file, in the selected
editor. Both resolve **`false`** when no editor claims that capability, which
is your cue to fall back to your own view — `git-scm` keeps its unified diff
and conflict resolver for exactly that, and offers them as a secondary action
either way. See [`registerEditor`](#editors--registereditor) for the request
shapes.

```ts
ctx.app.canPreview(path: string): boolean
ctx.app.openPreview(path: string): void
```
Whether some registered viewer can show a *rendered* preview of this path
(Markdown, JSON/YAML, CSV…), and opening it. The same question the FILES tree
asks before drawing its hover Preview icon, and the same action that icon
performs. Unlike `openViewerTab` this reaches **another** extension's viewer,
which is the point — an editor tab showing a `.md` file has no way to render it
itself. `openPreview` is a no-op when nothing can preview the path, so an
extension can offer the action wherever `canPreview` says yes.

```ts
ctx.app.agentForWindow(session: string, windowIndex: number): Promise<AgentWindow | null>
ctx.app.agentForSession(session: string): Promise<AgentWindow[]>

interface AgentWindow {
  agentId: string;          // registry id, as GET /api/agents lists it
  label: string;            // "Claude Code"
  program: string;          // the registry program that matched
  iconUrl: string;          // the agent's own mark, a loadable URL ("" if none)
  icon: string;             // codicon fallback
  windowIndex: number;
  windowId: string;         // stable id, the same value listPanes() gives
  windowPid: number;        // the window's own process: its shell
  agentPid: number | null;  // the agent process itself
  cwd: string | null;
  matchedBy: "foreground" | "descendant";
}
```
Which agent is running in a terminal, and which process it is. A window
matches when its foreground command is an agent's `program`, or when a
process below it is — so an agent started through a wrapper, or left running
under a shell prompt, is still found. The answer doesn't depend on the
terminal backend: nothing here reads a tmux pane. `agentPid` is for reading
the files an agent keeps about itself (a session index, a transcript), never
for signalling it; it is null only where the host reports no process list.
A session that isn't there resolves to null / an empty array rather than
throwing. Server hooks get the same pair as
[`host.agents.forWindow`/`forSession`](#server-api), and both sit on one
process map cached for about two seconds, so polling costs one scan rather
than one per window. Reference: `agent-usage-monitor` in the
[perch-extensions](https://github.com/tuanpham-dev/perch-extensions)
registry.

```ts
ctx.app.executeCommand(commandId: string): void
ctx.app.getCommands(): { id: string; label: string }[]
```
Runs a command by id, and lists the ones it can run. Ids are a built-in
command's (`"tab.next"`, `"quickSwitcher.toggle"`) or an extension command's
**namespaced** id (`ext.<extensionId>.<id>`). Only commands that can be
dispatched globally are runnable: terminal-, files- and sessions-scoped
built-ins are left out of `getCommands` and ignored by `executeCommand`, as is
an unknown id. `getCommands` is a snapshot of every runnable global built-in
plus every registered extension command; call it again when you need a fresh
list. Useful for letting the user bind your own gesture or button to any
command. Reference: `one-hand` in the
[perch-extensions](https://github.com/tuanpham-dev/perch-extensions)
registry.

```ts
ctx.app.focusActiveTerminal(): void
```
Gives keyboard focus back to the focused terminal, for extension UI (a dialog,
an overlay) that took focus and should hand it back on close, so the user can
keep typing at the prompt (press Enter on a command your extension just typed
there, say). No-op when no terminal tab is focused. Reference: `ai-command` in
the [perch-extensions](https://github.com/tuanpham-dev/perch-extensions)
registry.

```ts
ctx.app.consumeFindInFolderGlob(): string | null
```
One-shot handoff from the FILES tree's "Find in Folder…" menu item — only
the search extension is expected to call this.

### `ctx.serverFetch` / `ctx.assetUrl`

```ts
ctx.serverFetch(path: string, init?: RequestInit): Promise<Response>
```
`fetch()` scoped to this extension's own server hook — `serverFetch("/list")`
hits `/api/ext/<id>/list`. 404s if the extension has no server entry or is
disabled. Plain `fetch("/api/…")` still works for public core routes
(same origin), but prefer your own hook + the server `host` API over
depending on core route shapes.

```ts
ctx.assetUrl(relPath: string): string
```
Resolves an extension-relative path to a fetchable URL (the same
`/api/extensions/<id>/file/*` route your client entry loads from). Use it
with `extensions/_shared/injectStylesheet.ts` to attach `dist/client.css`,
images, etc. Traversal outside the extension folder is rejected.

### `ctx.settings`

```ts
ctx.settings.get(key: string): unknown          // full dotted key
ctx.settings.set(key: string, value: unknown): void
ctx.settings.onDidChange(cb: () => void): () => void
```

Your `contributes.configuration` values: manifest default overridden by the
user's stored value. `set` writes to the same server-synced store the
Settings UI edits — the value persists, syncs across the user's devices,
and fires `onDidChange` (which also fires for edits made in Settings or on
another device; it passes no arguments — re-`get` whatever you care
about). Only write keys you declared.

`ctx.React` is the host's own React instance, for no-build extensions.

---

## Server API

`perch.server` is a plain ESM module (no build step — the server runs
TypeScript via tsx, but extension server entries are plain JS):

```js
export function activate({ router, log, getSettings, host, ai, secrets }) {
  router.get("/list", async (req, res) => { ... });
}
```

| Piece | Contract |
| --- | --- |
| `router` | An Express router mounted at `/api/ext/<extensionId>` while the extension is enabled. JSON bodies are parsed (`req.body`); send errors as `res.status(4xx/5xx).json({ error: "…" })` — client helpers surface the `error` field. Routes 404 immediately on disable/uninstall. |
| `log(...args)` | `console.log` prefixed with `[ext:<id>]`. |
| `getSettings()` | `Promise<Record<string, unknown>>` — this extension's current configuration values (defaults + user overrides), read fresh per call. |
| `host.ports.list()` | `Promise<ListeningPort[]>` — listening ports attributed to terminal sessions (`{ port, address, process?, pid?, session, orphan? }`). How far past the still-open terminals it reaches is the user's `portScope` setting; `orphan` marks a process that outlived its terminal (`session` is then the name it remembers, empty when no terminal started it). The same attribution data the WS tunnel's security gate uses; consume it rather than re-scanning `/proc`. |
| `host.ports.find(port)` | `Promise<ListeningPort \| null>` — one port's fresh attribution (kill-confirmation flows). |
| `ai.run(prompt, opts?)` | `Promise<string>` — prompt in, text out, through whatever the user configured in **Settings → AI Providers** (an agent that answers a single prompt, a keyed API, a custom command). Your extension never sees a provider, a binary or a key. `opts.profileId` picks one configured AI (see `listProfiles`, and the `"ai-profile"` config format above); `opts.model` overrides that profile's model for one call; `opts.cwd` is the directory a CLI provider runs in — pass the project, since some CLIs refuse to run outside a trusted directory. Rejects with an `AiError` whose `code` separates "not configured yet" (`missing-binary`/`missing-key`/`missing-model`/`missing-command`) from a real failure (`provider-failed`/`empty-reply`) or a provider that can't do this (`unsupported`), so the first can be surfaced as guidance instead of an error. Also on `host.ai`. |
| `ai.listProfiles()` | `Promise<{ id, label, provider, program, model, isDefault }[]>` — the AIs the user has configured and enabled, for an extension that builds its own picker. Prefer the `"ai-profile"` config property, which renders one for you. Also on `host.ai`. |
| `host.agents.list()` | `Promise<AgentSummary[]>` — the AI agents the user has configured and enabled, in their own order, from the one core registry behind **Settings → AI Providers**. Each entry is `{ id, label, program, command, skipPermissionsArgs, resume, hooks, oneShot, iconUrl, icon }`: `program` is the foreground command a window running it reports (match a window's `command` against it to find the agent's window), `command` is the full launch line (offer it as a "start work with" preset), and `hooks` is a boolean — whether core can install hooks for it at all (the descriptor itself stays in core, since it names a file in the user's home). Read this instead of declaring an agent-programs or agent-presets setting of your own. |
| `host.agents.forWindow(session, windowIndex)` | `Promise<AgentWindow \| null>` - which agent runs in that terminal and which process it is; `host.agents.forSession(session)` returns one entry per window that has one. Matched by the window's foreground command, else by a descendant process named after an agent's `program`, so a wrapper (or an agent under a shell prompt) is still found, whichever terminal backend runs the window. `agentPid` is for reading the agent's own files, never for signalling it. See [`ctx.app.agentForWindow`](#the-ctxapp-host-api) for the shape. |
| `host.agents.launchCommand(id)` | `Promise<string \| null>` - the line that starts one enabled agent (ids are `<extensionId>.<agentId>`, e.g. `perch.agents.claude`), with the user's global Yolo/Manual choice from **Settings → AI Providers** already applied: the agent's `skipPermissionsArgs` is appended only under Yolo. `null` for an unknown or disabled id, or an agent with no launch command. Use this, not `list()`'s `command`, whenever a server hook types an agent into a window itself - it is the same rule the client-side launch presets apply, and there is no other place a server hook can read the global choice from. |
| `host.sessions.list()` | `Promise<TerminalSession[]>` - every terminal session with its windows, the same listing as `GET /api/sessions` (paths `~`-shortened). Each window carries a stable `id`. |
| `host.sessions.create(name?, cwd?, exactCwd?)` | `Promise<TerminalSession>` - starts a session. It is named after its folder when `name` is omitted. `cwd` may be `~`-shortened; the session starts at the git root containing it unless `exactCwd` is true. Rejects when the name is taken. |
| `host.sessions.createWindow(session, cwd?, name?)` | `Promise<number>` - opens a window in `session`, makes it current, and returns its index. Without `cwd`, the session's own path. A `name` is kept as given; without one the window is named after what runs in it. |
| `host.sessions.selectWindow(session, index)` | `Promise<void>` - makes a window the session's current one. |
| `host.sessions.sendText(session, text, submit, windowIndex?)` | `Promise<void>` - types `text` literally into the session's window, then presses Enter when `submit` is true (after a short settle, so Ink-based TUIs do not drop it). **Without `windowIndex` it targets the session's current window** - whichever window last had focus, not necessarily the one you created - so pass it whenever you know which window you mean. |
| `host.sessions.sendTextToWindow(windowId, text, submit)` | `Promise<void>` - the same, addressed by window id, which survives renumbering and renames. |
| `host.sessions.kill(name)` | `Promise<void>` - kills the session by exact name. **No confirmation of any kind runs**; a panel that offers it should ask first (`confirmDialog`). A session that is already gone is not an error. |
| `host.sessions.listPanes(session)` | `Promise<SessionPane[]>` - one entry per window of `session` (a window is one terminal): `{ windowIndex, paneIndex, paneActive, active, id, command, pid, title }`. `id` is the window's stable id, the same value its shell sees as `$PERCH_WINDOW` and `host.agentHooks` events carry as `paneId`; `title` is the window's name; `paneIndex` is always 0. Rejects when the session does not exist. |
| `host.sessions.capture(windowId, opts?)` | `Promise<string>` - the window's screen as plain text: its visible rows plus `opts.scrollback` history lines above them, one line per row joined with `\n`, trailing blank rows dropped. Rows are not re-joined where a long line wrapped. With `opts.styles: true`, each row keeps its colors and attributes as SGR escapes (`\x1b[0;1;44m`), every style change starting with a reset and a styled row ending with `\x1b[0m`: for text a TUI tells apart only by color, like a highlighted tab. Strip the escapes to get the plain text back; a backend that can't style returns plain text. Works on the bundled daemon and on any terminal backend that implements `capture`; rejects when the window is gone or the backend cannot read screens. Read-only: pair it with `sendTextToWindow` to act on what a TUI shows. |
| `host.notifications.push({ title, body, windowId })` | `Promise<void>` - a web push to every browser that subscribed to notifications in Settings, the same channel as the bell notification. Rate limited per window (a second push for one window within 5 seconds is dropped). Resolves quietly when no browser ever subscribed; never creates push keys itself. |
| `host.worktrees.list(dir, opts?)` | `Promise<{ repo, worktrees, branches }>` - the worktrees of the repository containing `dir` (`~` expanded). `repo` is the main worktree's path, `null` outside a repository. `opts.dirty` adds per-worktree uncommitted-changes state and `opts.branches` the local branch list; both cost extra git calls. Paths are absolute. |
| `host.worktrees.create({ cwd, branch, base?, mode, location? })` | `Promise<{ path, branch }>` - `mode: "new"` creates `branch` off `base` (default HEAD), `"existing"` checks an existing branch out. `location` is a template over `{repo}` and `{branch}`, default `{repo}/.worktrees/{branch}`; an in-repo location is added to `.git/info/exclude`. Stops at the checkout - no session is created. Refusals reject with an error whose `status` is 400 (not a repo, no branch) or 409 (the target already exists). |
| `host.worktrees.remove({ cwd, path, force? })` | `Promise<{ removed }>` - removes a worktree's checkout and keeps its branch. Only a path git reports as a worktree of that repository, never the main one (404/400 otherwise). Kill any session inside it first. |
| `host.agentHooks.subscribe({ events, onEvent })` | Subscribe to normalized AI agent hook events — core installs the hooks, receives them at one endpoint and fans them out (see [Agent hooks](#agent-hooks)). Returns an unsubscribe; all of an extension's subscriptions are dropped when its hook unmounts. |
| `host.agentHooks.provideCompanion(agentId, transform)` | Registers a transform for the `companion` file named by the hooks descriptor of an agent **this extension** contributes (`agentId` is the bare manifest id). Core runs it after writing that agent's hooks, passing `{ hookFile, handlers, current }`, and writes back the string it returns or resolves; `handlers` is empty on uninstall. A throw, hang or oversized result is logged and skipped. Registering for an agent you didn't contribute does nothing. See [Companions](#companions). |
| `secrets.get(name)` | `Promise<string \| null>` — one of this extension's stored credentials, or null. Also on `host.secrets`. |
| `secrets.set(name, value)` | `Promise<void>` — stores a credential under `name` (1-64 chars of `[A-Za-z0-9._-]`); a null or blank `value` clears it. |
| `secrets.list()` | `Promise<string[]>` — the names this extension has stored, **never** the values. The shape a "set / not set" UI needs, and the one that's safe to send to a client. |
| `host.terminalEngines.register({ id, label, description?, create })` | Adds a terminal engine: another implementation of the multiplexer interface (`server/src/multiplexer.ts`) that the user can pick in **Settings → Terminal Backend**. The choice takes effect on the next server start; `description` (a sentence or two) is shown under the picker when the engine is chosen. `create({ port, env })` runs the first time the engine is needed and returns the engine; `env` is the environment new terminals should start with. Throwing from `create` keeps the server on the bundled daemon. Window ids must be unique and stable for a window's life; a shell finds its own id in `$PERCH_WINDOW`, or for the tmux backend `tmux-<n>` derived from `$TMUX_PANE`. Returns an unregister; an engine is also dropped when its hook unmounts, and a server running on it falls back to the daemon. Reference: `tmux-engine` in the [perch-extensions](https://github.com/tuanpham-dev/perch-extensions) registry. |
| `host.events.onApiMutation(cb)` | Fires after **any** mutating (non-GET/HEAD) core API request finishes — the signal that on-disk state probably changed. Use it to invalidate caches that mirror the filesystem (git-scm drops its status-scan cache here). Returns an unsubscribe; all of an extension's subscriptions are dropped when its hook unmounts. |

The `host` object is the **only** sanctioned way to reach core services —
never import core modules from an extension (it would bypass
enable/disable and break when core refactors).

**`host.sessions` and `host.worktrees` are real power.** Any enabled
extension with a server entry can create, type into and kill sessions,
and create and remove worktrees, through them. That is no more than the
browser-facing `/api/sessions` and `/api/git/worktrees` routes already allow
anyone holding the app's auth; what is new is that a server hook reaches it
with **no browser open** - from a timer, a socket, or an agent hook callback.
Installing an extension that has a server entry is trusting it with that.

#### Credentials — `secrets`

A `contributes.configuration` string property is the wrong home for an API
token. Configuration values live in the settings document, which the client
GETs, merges client-side, and PUTs back **whole** — so a token there is
readable by anything with access to the app.

`secrets` is a store scoped to your extension id that no client can read.
Values are stripped from `GET /api/settings` and restored from disk on every
document write, so an incoming document can neither read them back, overwrite
them, nor smuggle one in — the same protection core's own AI provider keys
get (see `server/src/settingsStore.ts`).

Core deliberately serves **no route** for them. An extension that wants a
browser-facing field defines its own route and calls `secrets.set` there,
answering the "is it set?" question with a boolean:

```js
export function activate({ router, secrets }) {
  router.get("/token", async (_req, res) => {
    res.json({ set: !!(await secrets.get("apiToken")) });   // presence, never the value
  });
  router.put("/token", async (req, res) => {
    const value = req.body?.value;
    if (typeof value !== "string") return res.status(400).json({ error: "value must be a string" });
    await secrets.set("apiToken", value || null);           // "" clears it
    res.status(204).end();
  });
}
```

Pair that with a [settings component](#settings-components--registersettingscomponent)
rendering a password field, and the credential never reaches the settings
document at all.

Values survive a disable/enable cycle, and survive an "uninstall" of a
**builtin** (which is a reversible tombstone — the files stay and the UI
offers Reinstall). Uninstalling a non-builtin deletes its folder and clears
its secrets with it.

Caveats:

- Route handlers may be `async`. A handler that throws or rejects - before
  or after an `await` - answers that one request with
  `500 { "error": "<message>" }` (logged with your extension's id) and the
  server keeps serving; `router.get/post/put/patch/delete/all/use` and
  `router.route(...)` are all covered, and your own 4-argument error
  middleware still sees its errors first. Anything outside a route - a timer,
  a socket server, an `onEvent` callback - has no request to fail: core logs
  an unhandled rejection there and keeps running, but catch your own errors
  anyway. **Cores older than this change exit the whole server on a rejected
  route handler**, so an extension that may be installed on one should still
  wrap its async handlers itself.
- One activation per process per enable — but a disable→enable cycle
  within one server process calls `activate` again on the already-resident
  module. Module-level state persists across that; guard one-time setup
  (e.g. a unix-socket listener) accordingly, or key it per-activation.
- Export an optional `deactivate()` from the server entry and the host calls
  it when the extension is disabled or uninstalled, after your routes and
  `agentHooks` subscriptions are already gone. Close sockets, clear timers
  and stop children there - without it they keep running in the resident
  module after a disable. It may be async; the host does not wait for it,
  and a throw or rejection is logged, never surfaced to the user's disable.
  A later re-enable calls `activate` again on the same module. See
  `git-scm/server.js` for process-group management; no bundled server entry
  exports `deactivate()` today.
- `cwd`-style parameters may arrive `~`-shortened (the client displays
  them that way) — expand before touching the filesystem.

References: `ports/server.js` (minimal, `host`-driven),
`subagent-viewer/server.js` (on-demand filesystem reads with TTL caches),
`git-scm/server.js` (the full works).

---

## Agent hooks

An AI agent's own hooks (Claude Code's `Stop`, Codex's `PermissionRequest`,
or Antigravity's `PreInvocation` when an extension contributing Antigravity is
installed) are core's business, not yours. Core reads each agent's config file
and hook schema from its `contributes.agents` hooks descriptor, generates the snippet, installs it on an
explicit press in **Settings → AI Providers**, receives every event at one
loopback-only endpoint, normalizes it, and hands it to whoever subscribed.
An extension that only consumes events ships no snippet, no schema, no route
and no settings component for any of that — it subscribes:

```js
const unsubscribe = host.agentHooks.subscribe({
  events: ["stop", "permission"],
  onEvent(event) {
    if (event.event === "stop") finish(event.paneId);
  },
});
```

`events` are core's own names, never the agent's, so the same subscription
works for every agent:

| Event | Fires when |
| --- | --- |
| `session-start` | The agent started a session in that pane. |
| `prompt-submit` | A turn began (Antigravity's `PreInvocation` maps here, when an extension contributes Antigravity). |
| `tool-start` / `tool-end` | One tool call began or finished. **Only delivered while the user has turned on per-tool-call hooks** in Settings → AI Providers — they fire once per tool call, so they are off by default. Subscribe if you want them, and keep working without them. |
| `permission` | The agent is waiting on a permission prompt. Antigravity (when contributed by an installed extension) never sends this: its CLI has no permission event at all. |
| `stop` | The turn ended. |
| `subagent-stop` | A subagent finished (Claude Code, Codex). |

Each `onEvent` receives:

| Field | Meaning |
| --- | --- |
| `event` | One of the names above, or **`null`** for a raw event core has no mapping for. A `null` event is delivered, not dropped — with `rawEvent` intact, so an extension that knows what it means can act on it and core never has to guess. Antigravity's `PostInvocation` is the live example (when an extension contributing Antigravity is installed): it fires when the model's tool calls finish, which is neither `tool-end` nor `stop`. |
| `rawEvent` | What the agent called it (`"Stop"`, `"PreInvocation"`). Always present. |
| `agent` | The registry id of the agent whose hook fired. Informational: hooks live in one config file per CLI, so two presets sharing a CLI share one installed hook, and this names whichever of them was installed last. **Correlate by `paneId`, not by this.** |
| `paneId` | The id of the window the agent is running in, from `$PERCH_WINDOW` in its own environment. The correlation key: it is the one identifier every agent's hook can supply, which is why keying on the agent's own session id only ever worked for Claude Code. Empty when the hook did not run in one of the app's terminals. |
| `sessionName` | The session that window belongs to, resolved per event, or `null` if the window is gone. |
| `payload` | The agent's own event JSON, verbatim, or `null` if it sent something that was not JSON. |
| `receivedAt` | `Date.now()` when core received it. |

Core installs only the **union of events its enabled subscribers asked for**,
so subscribing to something new makes the user's installed hooks stale, and
Settings → AI Providers says so and offers to reinstall. That panel also lists who
is subscribed to what, so a user can see why.

Hook events are transient: core normalizes and fans out, and stores nothing.
Whether anything is remembered is your extension's business.

## Sharing the host runtime

Bundled-style extensions are built by `extensions/build.mjs` (esbuild) with
these import aliases, each a thin re-export of the host's own instance via
`window.__perchModules` (set in `client/src/main.tsx` before any
extension loads):

| Alias | Provides |
| --- | --- |
| `react`, `react-dom`, `react/jsx-runtime` | The host's React. Two React copies break hooks and portals — never bundle your own. |
| `react-dom/client` | `createRoot` — for extension-owned floating UI (popovers) mounted into your own DOM node and unmounted in `deactivate()`. |
| `@perch/engine-support` | Host terminal helpers (below). |

`@perch/engine-support` exports (typed in
[`extensions/_shared/engine-support.d.ts`](../extensions/_shared/engine-support.d.ts)):

| Export | For |
| --- | --- |
| `cellFromPoint(x, y, rect, charW, charH, cols, rows)` | Pixel → 1-based cell math (mouse reports, touch selection). |
| `findCandidates(text)` / `Candidate` | The host's URL/path link detector — engines feed stitched lines through it. |
| `isOpenGesture(event)` / `openUrl(url)` | The app-wide Ctrl/Cmd+click convention and safe `window.open`. |
| `MAX_STITCH_LINES` | Cap for wrapped-line stitching walks. |
| `markSyntheticSelectStart(e)` / `isSyntheticSelectStart(e)` | Tags an engine's synthetic selection mousedown so the host's capture layer lets it pass. **Symbol-keyed — must be the host's instance**, which is the whole reason this ships as a shim. |
| `ensureContrastRatio(fg, bg, ratio)` / `Rgb` | WCAG minimum-contrast math (ghostty's renderer shims use it; xterm has it natively). |
| `whenMatches(when, command)` | The comma-separated program-list matcher (touch-key `when` clauses; same rule as core local echo). |
| `sendWithInkSafeEnters(data, send)` | Splits text at `\r` with 80ms gaps so Ink-based TUIs don't drop input. |
| `joinedSelectionText(term, range)` / `unwrapParagraphs(text)` | Selection copy text with soft-wrapped rows joined, and paragraph unwrapping for copied prose. |

The rule of thumb: anything with **identity or shared state** (React, the
selection Symbol, the link detector) must come through a shim; small
**stateless** helpers live in `extensions/_shared/` as plain source
(`Icon.tsx`, `FileIcon.tsx`, `useListNavigation.ts`,
`useMarqueeSelection.ts`, `clipboard.ts`, `injectStylesheet.ts`,
`types.ts`, `terminalEngineTypes.ts`, `fileApi.ts`, `useLongPressMenu.ts`,
`agentTarget.ts`) — each extension's build inlines its
own copy, and structural typing keeps host-passed values compatible.

If you bundle with your own tooling instead of `build.mjs`, replicate the
aliases: map those module names to thin files re-exporting from
`window.__perchModules`. A plain no-build ESM `client.js` (like
hello-extension's) needs none of this — use `ctx.React` and skip JSX.

---

## Building and packaging

- **Bundled-style** (JSX/npm deps): put sources in `src/client.tsx`;
  `node extensions/build.mjs` (or `--watch`; `npm run dev` runs it for you)
  emits `dist/client.js` + `dist/client.css` (when the entry imports CSS —
  attach it in `activate()` via `injectStylesheet(ctx.assetUrl,
  "dist/client.css")` and detach in `deactivate()`). Bundled extensions
  are npm workspaces — declare npm deps in the extension's own
  `package.json`; they hoist to the root `node_modules` and esbuild inlines
  them into `dist/client.js`.
- **No-build**: a plain ESM `client.js`/`server.js` works as-is —
  hello-extension is the template.
- **Distribution**: a `.perch` is a zip whose contents live under an
  `extension/` folder inside the archive. Installing through Settings
  unpacks it into `~/.config/perch/extensions/<name>/` and enables
  it. Registries (Settings → Extensions → Available) serve an `index.json`
  catalog of `.perch` URLs.

## Security model

There is no sandbox. A `perch.server` entry runs as the server
process's user; a `perch.client` entry runs with full page access
(same origin, same DOM, same auth). That's identical in kind to what the
app already hands you through the terminal itself — but it means:
**only install extensions you trust**, and as an author, treat your
`/api/ext/<id>` routes with the same care as core routes (they sit behind
the app's Host/Origin gate and auth, but validate paths and inputs — see
`git-scm/server.js`'s `resolveSafePath` for the pattern).

Agent hook payloads are **untrusted process input**. They come from an AI
agent's own hook, over a loopback-only endpoint that any local process can
reach, and core does not validate their contents — only their shape and size.
Treat every field of `event.payload` as unvalidated: never interpolate one
into a shell command, a path, or SQL, and do not assume a field is present or
of the type the vendor documents. The trustworthy parts are the ones core
derives itself: `event.event`, `paneId` and `sessionName`.

## Terminals without tmux

Terminals are no longer tmux sessions: the app runs its own terminal daemon, and a
window is one terminal (splits are editor groups in the UI, not panes). An extension
written against tmux changes in four places:

- **Don't run `tmux`.** Use `host.sessions` from a server hook: `list`, `createWindow`,
  `selectWindow`, `sendText`, `sendTextToWindow`, `listPanes`.
- **`$TMUX_PANE` is now `$PERCH_WINDOW`**, a uuid rather than `%3`. It is in every
  process started in a window, and it is what `paneId` and `listPanes()[].id` carry.
- **Window names can contain spaces and brackets**, but not `:`, a leading `@`, or only
  digits.
- **There is no copy mode.** Scrollback lives in the browser's terminal.
