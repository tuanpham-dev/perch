# Perch

A VSCode-style web UI for your terminals. Open folders as projects — each backed by its own terminal session — browse them in a sidebar, open them as tabbed terminals, and manage sessions/windows — all from the browser over WebSockets. Terminals live in a bundled daemon, so they keep running when the server restarts, redeploys or crashes, and come back (history, working directories, names) after a reboot. Rendered rendered by [xterm.js](https://xtermjs.org/) — or the optional [ghostty-web](https://www.npmjs.com/package/ghostty-web) (Ghostty's WASM terminal core) engine, installable from the extensions registry — selectable in Settings.

![Sidebar, FILES panel, Source Control panel, and an nvim tab with inline git blame](docs/screenshots/overview.png)

<details>
<summary>More screenshots</summary>

| | |
|---|---|
| ![Colorized terminal output in a tab](docs/screenshots/tabs-and-logs.png) | ![git log and status in a terminal tab](docs/screenshots/git-shell.png) |
| ![Extensions settings panel](docs/screenshots/extensions.png) | ![Ctrl+P quick switcher for tabs, terminals, and projects](docs/screenshots/quick-switcher.png) |

</details>

## Features

- **Sidebar** — VS Code-style icon tabs across the top switch between views: **Explorer** (the PROJECTS tree of projects and their terminals, plus FILES and PORTS — panels reorderable by drag and independently resizable) and one tab per extension-contributed panel, like SOURCE CONTROL. Drag a tab to reorder it, or drag it to the opposite screen edge (or right-click it) to move it to a **second sidebar on the right** — open it any time with the layout buttons in the left sidebar's footer (settings, bottom panel, left sidebar, right sidebar) or `Ctrl+Alt+B`, and it shows a drop hint until a tab lands there — drop a dragged tab anywhere in it, not just on its tab strip. Each side has its own width and its own toggle (`Ctrl+Shift+B` for the left, `Ctrl+Alt+B` for the right). Any panel can live in any tab, in both directions: drag a section's header onto a tab icon, or drag a whole tab into another tab's panel area to fold it in as a section — every header also has a right-click **Move to …** menu, with **Reset Location** putting it back. So PORTS can sit in Explorer, or SEARCH and SOURCE CONTROL can share one tab. Resizable, collapsible (`Ctrl+Shift+B`), shows attached/activity status. The footer's gear button opens a **Manage menu** — Command Palette, Settings, Extensions, Keyboard Shortcuts, plus **Sidebars** (show or hide either sidebar and the bottom panel), **Panes** (show or hide any pane, including ones whose tab has retired) and **Theme** (switch color theme in place). On phones that same menu is a gear at the right end of the status bar, since the sidebar it normally lives in starts closed there — and the footer drops its own gear there rather than offering the menu twice. The footer's right end carries **back and forward arrows** that step through the tabs you've been in, VS Code's Go Back/Go Forward: a new tab ends the forward trail, and an entry whose tab has since been closed is skipped. In the installed desktop app, hide the browser's title bar (its ^ button) and the app draws its own in that strip instead: back and forward, a **command center** centered on the window that shows the current title and opens the Quick Switcher (or the Command Palette, per Settings → UI), then the layout toggles and Manage — the footer steps aside while it's up, and the window controls stay wherever your OS puts them. Settings → UI → Use custom title bar turns it off. Jump straight to a tab with its shortcut — `Ctrl+Shift+E` for Explorer, `Ctrl+Shift+G` for Source Control, `Ctrl+Shift+F` for Search (which yields to the terminal's own find when a terminal is focused) — revealing the sidebar first if it's hidden, and re-pressing the active tab's shortcut hides it again. Every panel — PROJECTS, FILES, PORTS, Search, Source Control, Extensions — is fully keyboard-navigable (arrow keys, `Shift+F10`/menu-key context menus). On phones both sidebars float over the terminal as drawers instead of squeezing it, dismissed by tapping outside or a flick — only one opens at a time, and both start closed on a first visit, since a drawer would otherwise cover the terminal you came for. Whatever you last chose is what you get back.
- **Quick switcher (`Ctrl+P`)** — fuzzy-search and jump to any open tab, terminal, or project, or search files by name. `Enter` opens a file in the editor; `Shift+Enter` opens it in its preview viewer instead; `Alt+J`/`Alt+K` move the selection (in addition to the arrow keys). Type `>` as the first character (or press `Ctrl+Shift+P`) to switch it into a **command palette** — every keyboard-bindable command, including extension-contributed ones, searchable by name and runnable without a bound key. The command you last ran from the palette always appears first; enable "Sort command palette by most-used" in Settings → Behavior to order the rest by usage instead of their default order.
- **Tabbed terminals** — open a whole project or a single terminal as its own tab (labeled `project · terminal`), switch between them, close individually or all-but-one. Drag to reorder (long-press then drag on touch), middle-click to close, double-click a tab to toggle the sidebar. Background tabs with new output get an activity dot; closing the active tab reactivates the most-recently-used one. In the installed PWA: `Ctrl+Tab`/`Ctrl+Shift+Tab` to cycle tabs, `Ctrl+W` to close the active one. Chrome-style **tab groups** (Settings → Behavior, on by default) collect each project's tabs — plus any preview tab opened from it — behind a colored, collapsible chip named after the project; click the chip to collapse/expand, or its arrow for a dropdown of the project's terminals (open-as-a-tab ones checked, the group's active tab starred) that opens/focuses any of them; pick the chip's color or reorder groups from its context menu, or drag a chip to reorder it directly. One folder = one chip, even when several sessions are rooted in it.
- **Split editor groups** — split the terminal area into side-by-side or stacked panes, VS Code-style, each with its own tab bar. `Ctrl+\` splits the active pane right; a tab's context menu also offers Split Up/Down/Left/Right and Move into Next Group (creating one if none exists). A split **duplicates** the active tab into the new pane rather than moving it — for a terminal, that's a second live attachment to the same session/window (the window takes the size of whichever view you last typed in, clicked or resized; the other shows the same grid); for an editable viewer (CSV/JSON), it's an independent instance that doesn't sync with the original — last save wins. Drag a tab onto another pane's tab strip to move it there, or onto its content area: drop in the center to move, on an edge to split that pane and move the tab into the new one. Drag the sash between panes to resize (double-click to even out); `Ctrl+1`…`Ctrl+8` jump straight to the 1st…8th pane, `Ctrl+Alt+←`/`Ctrl+Alt+→` move the active tab into the previous/next pane.
- **Projects** — a project is a folder: open one via the PROJECTS panel's "+" (a code-server-style **Open Folder** dialog with a browsable listing and editable path input) and a terminal session is created *in exactly that folder*, named after it. The panel lists every live project by its folder name, terminals nested under each (opened/renamed/closed via context menu or hover buttons; several sessions rooted in one folder merge into a single row). Projects have no rename — a project's name is its folder's — and **Close Project** closes every terminal across all of the project's sessions. The session name appears only in tooltips — **Pin a project** (context menu) and it survives its session dying: a dimmed row named by the folder restores the session in the same folder with one click. Pins are keyed by the folder the session started in, so renaming a session can't orphan one, and a session started from a pinned folder outside the app still shows its pin. Every folder you open lands in a **recent projects** list (the panel header's history button) — reopen one with a click, forget one with its row's × (or "Clear Recently Opened", which keeps pinned entries). When a project is a git repository with **more than one worktree**, the tree grows a middle level — **project → worktree → terminal** — so every branch checked out of one repo lives under one row instead of appearing as unrelated siblings named after their checkout folders. Every worktree of the repo is listed, including ones with no session running (click to start one, named after the branch); each shows a dot when it has uncommitted changes. Sessions are attributed to the deepest worktree containing them, which matters because worktrees nest inside the repo by default. A repository with a single checkout looks exactly as it always did, with terminals directly under the project.
- **FILES panel** — browse the active window's working directory, drag-and-drop upload (files or folders, with conflict handling and progress), git status badges, and a context menu for creating, renaming, deleting, downloading (folders as zip), and copying paths. Multi-select with `Ctrl`/`Shift`+click or a rubber-band drag from empty space; **Copy/Cut/Paste** entries (`Ctrl+C/X/V`) through a server-held clipboard, so paste works across browsers and devices — files copied in your OS file manager paste in too, via the upload pipeline; or just **drag rows** onto a folder to move them (`Ctrl+drag` to copy). Every tree operation is a rebindable command in its own "files" keybinding scope. Clicking a file opens it in the pane's running `nvim`, or a new window if it's busy; hovering a previewable file (image, PDF, Markdown, JSON/YAML, CSV, HTML) shows a Preview icon that opens it in a rendered tab instead. The current git branch shows as a pill in the FILES header — click it to open (or jump to) `lazygit` as a tab.
- **File viewer tabs** — image (zoom/pan), audio/video, PDF, and rendered Markdown previews, plus editable CSV and JSON/YAML tree viewers with save-back to disk.
- **SOURCE CONTROL tab** — stage/unstage/discard changes, commit, push/pull/sync with ahead/behind counts, publish a new branch, manage stashes (apply/pop/drop from the STASH pane), and open a unified diff view — all without leaving the browser. Multi-select rows (`Ctrl`/`Shift`+click or rubber-band drag) for bulk stage/unstage/discard from the hover buttons or a right-click menu. Bundled as the `git-scm` extension.
- **Live Preview** — a sandboxed, auto-reloading preview tab for local HTML files. Bundled as the `live-preview` extension.
- **Two terminal engines** — xterm.js (bundled, the default) or ghostty-web (Ghostty's WASM terminal core, an optional engine installable from the extensions registry), switchable in Settings → Terminal; "auto" resolves to xterm.js on mobile (where its native IME/soft-keyboard handling is more mature) and, on desktop, ghostty-web when it's installed (else xterm.js). Each engine loads on demand, so the one you're not using never ships to the browser.
- **Terminal niceties** — **right-click** opens a context menu: Open Link / Open File / Preview / Copy Link or Path over a URL, file path, or OSC 8 hyperlink, plus Copy, Copy as Paragraph, Paste, Select All, and Clear anywhere (`Shift+F10` or the Menu key opens it at the cursor). Hold `Shift` while right-clicking to send the click to a program that's using the mouse (vim, htop) instead — or swap that around, or make right-click paste, in Settings → Terminal. `Ctrl+click` (`Cmd+click` on Mac) opens URLs, local file paths (with `:line[:col]` jumping), and hyperlinked text; scrollback search (`Ctrl+Shift+F`); Shift+drag for browser text selection. **Paste or drop an image** onto a terminal and it's uploaded (to the system temp folder by default, configurable in Settings → Behavior, or `<cwd>/uploads` when that setting is cleared) with the saved path typed at the prompt — made for handing screenshots to Claude Code; ordinary text paste is untouched.
- **Mobile & touch** — swipe to scroll, a fast horizontal flick anywhere to open/close the sidebar, and the layout tracks the on-screen keyboard via `visualViewport` so the prompt and key bar never hide behind it. The **touch key bar** (defaults: Esc, Tab, sticky Ctrl, arrows, `^C`, mic, image upload) is fully customizable in Settings → Touch Keys (the bundled touch-keys extension's own section): each key has a label, a send sequence in brace-token notation (`{esc}:wq{enter}`, `{^c}` for Ctrl-C, `{{` for a literal brace), and an optional "when" filter that shows it only while a given program (`claude`, `nvim`, …) runs in the pane — reorder keys by drag with a live tag-filterable preview, and render them as the fixed bar below the terminal or a draggable AssistiveTouch-style floating toggle. A 🎤 **voice input** key (Web Speech API, hidden on browsers without it) types dictated text. A 📷 **image upload** key (default: visible while `claude` runs) opens the native photo/camera picker and uploads through the same pipeline as desktop paste/drop — the mobile equivalent of dragging a screenshot onto the terminal.
- **Pluggable editor** — Settings → Editor picks what opens a file, a git diff, or a merge conflict: `nvim` in a terminal window (the default, and always available) or any editor an extension contributes, such as Monaco from the optional Text Editor extension. The choice is per capability — an editor that only handles files still sends diffs and conflicts to nvim — and the Source Control panel keeps its own diff and conflict views as a secondary action either way.
- **Zero-lag local echo** — on mobile, typing into a pane whose foreground command matches a filter (default: `claude`) is echoed instantly by a type-ahead overlay (in the spirit of VS Code's remote-terminal type-ahead): every keystroke is sent immediately, the overlay covers the round trip, and it clears itself once the real echo catches up; backspace takes effect instantly, and in-progress IME/predictive-keyboard words show underlined before they commit. Configure or disable via Settings → Terminal's "Local echo when" filter.
- **Push notifications** — opt in per device (Settings → Behavior) to get a web-push notification whenever a pane rings the terminal bell — e.g. Claude Code waiting for permission — even with the tab closed. VAPID keys are generated server-side automatically; a per-pane cooldown keeps a busy pane from spamming.
- **Status bar** — an optional strip along the bottom (Settings → UI) showing the active directory's git branch (with a `*` when it's dirty and the ahead/behind counts beside it — click to open SOURCE CONTROL), plus counts of open terminals and listening ports. Host memory, with a popover of CPU history, disks and network, comes from the installable System Stats extension. Clicking the terminal count opens the live terminals list, with the same row actions the PROJECTS panel has; clicking the port count lists every listening port with its forward-all command. Drag any readout to reorder it or move it between the bar's two ends. Switch one off from the gear menu's Status Bar list, by right-clicking the bar, or on a phone by long-pressing an empty spot on it — a hidden readout keeps its place for whenever you bring it back. Extensions can add their own (`ctx.registerStatusBarItem`) — the bundled Claude usage extension puts its 5-hour and weekly limit meters here. On phones the bar stays, compact: every item drops to its icon and number, and the row scrolls if it has to.
- **Shell integration** — an optional, generated rc snippet (`~/.config/perch/shell-integration.sh`; the exact source line to add to `~/.zshrc`/`~/.bashrc` is shown with a Copy button in Settings → Behavior) that marks every prompt with OSC 133, reports the working directory (OSC 7), and reports each command's start, end, exit code, and duration to the server. It powers **jump to previous/next command** in the scrollback, per-window **command history** with exit codes and durations, and **finished-command notifications**: set a threshold in Settings → Behavior and any command running at least that long triggers a web-push notification (with the command, exit status, and duration) through the same pipeline as bell notifications. Reports are fire-and-forget background requests that never block the prompt, and everything degrades to a no-op when the snippet isn't sourced.
- **Worktree sessions** — worktrees are a level of the PROJECTS tree, not a separate panel (see **Projects** above). Create one from a project row's "+" → **New Worktree…** (or the command palette's "Worktrees: New Worktree Session…"): pick a new or existing branch, a base, a session name, and optionally a command to run in the new session, and the branch is checked out and opened as its own session in one step — the clean way to run several agents or branches side by side without colliding in one checkout. Removing a worktree is confirm-gated, offers to kill its sessions with it, asks again before discarding uncommitted changes, and always keeps the branch. Worktrees land in `.worktrees/<branch>` by default (configurable in Settings → Behavior; kept out of `git status` via `.git/info/exclude`, never your committed `.gitignore`).
- **Subagent activity badges** — sessions running Claude Code show a live count of running subagents in the sidebar, with a read-only popover detailing each one — read from Claude Code's own on-disk transcripts, nothing injected into the session.
- **Scrollback in the browser** — history is replayed exactly as it was written (colors, hyperlinks, prompt marks) whenever a tab attaches, and scrolling, search and prompt jumps all work locally with no round trip. A draggable overlay scrollbar, and touch swipes on phones.
- **Theming** — matches VS Code's Plastic Legacy theme and IBM Plex Mono by default; configurable via the in-app Settings dialog (font, size, cursor style, line height, a medium text-weight option, and a fractional text-thickness stroke for in-between weights). Settings are persisted server-side, so they follow you across browsers/devices.
- **Rebindable keybindings** — every shortcut can be remapped from Settings → Keyboard; see [Keyboard & mouse](#keyboard--mouse) below for the defaults.
- **AI, configured once** — Settings → AI Providers holds every AI you want available: any agent that can answer a single prompt (Claude Code and Codex come with the app; an extension can add more), a keyed API (Anthropic's or OpenAI's wire format, pointed at the vendor or at any compatible endpoint — OpenRouter, Groq, Together, LiteLLM, a local Ollama), or any custom command that prints a reply. Add as many as you like and mark one the default; API keys are stored server-side and never sent back to a browser. A CLI that isn't installed on the server is greyed out rather than offered, and the **Model** field fetches whatever the provider will tell it: the endpoint's own `/models` list for the API providers (Anthropic's or OpenAI's, against whatever base URL you set — so a compatible service lists *its* models), whatever an agent declares as its model-listing command, and the aliases `claude` documents in its own `--help`. It still accepts any id you type, since a list is never the whole truth. Everything that asks for an AI — the commit-message button in SOURCE CONTROL, AI Command Search, the prompt editor's Refine — goes through that list, and an extension can point its own feature at a different entry — and at a different model on it (a cheaper, faster one for short jobs) — from its own settings section.
- **Agents, defined once** - Settings → AI Providers is the app's one list of AI agents, next to AI Providers. Each entry carries the three facts that always travel together: the foreground command a window running it reports (that's how the app knows which window your agent is in - SOURCE CONTROL's "Send to Agent", the element pickers in LIVE PREVIEW and PORTS, AGENT MONITOR), the full launch line (what "Start work" offers when you open a branch or a ticket in a fresh worktree), and which hook format its CLI reads. It ships knowing Claude Code, Claude Code with permissions skipped, Codex and Antigravity; add your own wrapper script with an Add. Extensions read this list instead of each carrying a copy, so the same CLI is named once rather than in every extension that cares.
- **Agent hooks, installed for you** - the same panel writes the hooks that let an agent report back: it generates the exact snippet for that agent's own config file (`~/.claude/settings.json`, `~/.codex/hooks.json`, `~/.gemini/config/hooks.json`), with a **Copy** button if you would rather paste it yourself, and an **Install for me** button if you would not. Installing is surgical: a timestamped backup goes beside the file first, only entries pointing at the app's own hook shim are ever replaced, hooks you wrote by hand are never touched, and installing twice leaves exactly one entry. Uninstall takes out exactly what it put in. The app installs only the events something is actually listening for, tells you when that set has changed and the hooks need reinstalling, and keeps the once-per-tool-call events behind a toggle that is off by default.
- **Extensions** — install VS Code color themes and icon themes unchanged, contribute custom terminal fonts, or a small custom extension that adds a command, a file viewer, a sidebar panel, a session-window action, and a server route. See [Extensions](#extensions) below.
- **Auto-reconnect** — a dropped connection (server restart, laptop sleep) reconnects automatically instead of losing the tab; open tabs also survive a browser reload.
- **Installable PWA** — installable app shell with offline caching for the UI; terminal/session traffic (`/api`, `/ws`) is always network-only.
- **Agent orchestration (optional extensions)** - install **Agent Tasks** from the extensions registry to hand several agents owned, dependency-ordered work from one AGENT TASKS tab: each worker gets its own session and worktree, reports back through an `agent-task` command and its own hooks, asks you decisions you answer in the panel, and is marked lost if its pane dies. **Automations** adds scheduled and event-triggered agent work (a daily or cron prompt, or a task started when another fails) that runs on the server with no browser open. Extensions reach sessions, worktrees and an agent's launch command through `host.sessions`, `host.worktrees` and `host.agents.launchCommand` (see [docs/EXTENSION_API.md](docs/EXTENSION_API.md)).

## Keyboard & mouse

| Shortcut | Action |
|---|---|
| `Ctrl+Shift+B` | Toggle sidebar |
| `Ctrl+P` | Toggle quick switcher |
| `Ctrl+Shift+P` † | Show command palette |
| `Ctrl+Tab` * | Next tab |
| `Ctrl+Shift+Tab` * | Previous tab |
| `Ctrl+W` * | Close active tab |
| `Ctrl+,` | Open Settings |
| `Ctrl+Shift+C` | Copy terminal selection |
| `Ctrl+Shift+Alt+C` | Copy terminal selection as one paragraph |
| `Ctrl+Shift+F` | Scrollback search |
| `Shift+Enter` | Insert a literal newline in the terminal |
| `Alt+1`…`Alt+9` ‡ | Jump straight to the 1st…9th tab |
| `Ctrl+Shift+PageUp` / `Ctrl+Shift+PageDown` | Move the active tab left / right |
| `Shift+Alt+T` | Reopen the last closed tab |
| `Ctrl+=` / `Ctrl+-` | Increase / decrease terminal font size |
| `Ctrl+0` | Reset terminal font size |
| `Ctrl+\` | Split editor right |
| `Ctrl+1`…`Ctrl+8` * | Focus the 1st…8th editor group (split pane) |
| `Ctrl+Alt+←` / `Ctrl+Alt+→` § | Move the active tab into the previous / next editor group |

\* Browser-reserved outside the installed PWA — bind a different combo in Settings → Keyboard if you're using Perch as a regular browser tab.

† Firefox reserves `Ctrl+Shift+P` for opening a private window and won't let pages intercept it — rebind it in Settings → Keyboard, or just type `>` into the `Ctrl+P` quick switcher instead.

‡ Firefox on Linux also binds `Alt+1`…`Alt+9` to its own tab switching and may not let pages intercept them — rebind in Settings → Keyboard if that's in the way.

§ GNOME on Linux binds `Ctrl+Alt+←`/`Ctrl+Alt+→` to virtual-desktop switching by default and may not let pages intercept them — rebind in Settings → Keyboard if that's in the way.

The command palette also lists seven project/terminal actions — **Project: New…** (the Open Folder dialog), **Project: Close Current**, **Pin/Unpin Current** (adds or removes the current session's folder as a pinned project), **Terminal: New**, **Terminal: Close Current**, **Terminal: Rename Current…**, and **Close Other Tabs** — that ship with no default key so they don't collide with anything; bind any of them from Settings → Keyboard if you use them often. They stay accessible from the sidebar's context menus and hover buttons either way. **Terminal: Clear Scrollback** and **Terminal: Scroll to Bottom** likewise ship unbound — assign a chord in Settings → Keyboard if you want one.

- **`Ctrl`+click** (`Cmd`+click on Mac) a URL, local file path, or hyperlink in the terminal to open it; add `Shift` to open a file in its preview viewer instead of the editor.
- **Drag** in the terminal selects text; when a program is using the mouse (vim, htop), **Shift+drag** selects instead of sending the drag to it.
- **Copy modes** (Settings → Terminal → *When copying a selection*) — *Join soft-wrapped lines* (the default) undoes the wraps the terminal itself made, while keeping newlines the program actually emitted. *Keep lines as shown* copies the rows verbatim. *Join into paragraphs* also undoes a program's own word-wrap, so a paragraph Claude Code or `git log` wrapped for the pane width comes back as one paragraph — that one is lossy (a code block collapses onto one line), so prefer **Copy as Paragraph** (`Ctrl+Shift+Alt+C`, or the terminal's right-click menu) to apply it to a single copy without changing the default.
- **Shift+scroll** (or a trackpad's horizontal scroll) sends horizontal scroll events to `nvim`.
- **Clipboard** - copying inside a terminal lands in your browser's clipboard with nothing to configure. Any OSC 52 clipboard-set sequence a program emits is written straight to the browser clipboard, and the terminal advertises that ability (XTGETTCAP `Ms`), so `nvim` turns on its built-in OSC 52 provider by itself: `"+y`, or plain `y` with `clipboard=unnamedplus`, just works. Tools that copy by piping into `xclip`, `xsel`, `wl-copy` or `pbcopy` (like `gh auth login` copying its one-time code) work too: every terminal has `~/.config/perch/bin` first on its PATH, where stand-ins for those tools send the text as OSC 52 when the host has no display, and step aside for the real tool when it has one (the `xdg-open` stand-in does the same). Copying only goes one way: pasting from the browser clipboard back into a program is not supported, so `xclip -o` and nvim's `"+p` come back empty. Paste into the terminal with your browser's paste shortcut or the right-click menu's Paste instead.

All of the above are defaults — remap any of them, including extension-contributed commands, from Settings → Keyboard.

## Requirements

- Node.js 23+
- A C/C++ toolchain (`node-pty` compiles a native addon on install)

## Install

```bash
curl -fsSL https://raw.githubusercontent.com/tuanpham-dev/perch/main/install.sh | bash
```

Clones the repo to `~/.local/share/perch`, builds it, and symlinks a `perch` command into `~/.local/bin`. It also installs and starts a user service, so it survives logout and starts on boot: a systemd user unit (`~/.config/systemd/user/perch.service`, with linger enabled) on Linux, a launchd agent (`~/Library/LaunchAgents/dev.perch.plist`) on macOS. No `sudo`, nothing written outside `$HOME`. Re-running the same command later updates an existing install instead of failing.

The installer checks for Node 23+, `git`, and a C/C++ toolchain up front and exits with distro-specific hints if anything's missing, rather than trying to install them itself.

### Windows

```powershell
irm https://raw.githubusercontent.com/tuanpham-dev/perch/main/install.ps1 | iex
```

Clones to `%LOCALAPPDATA%\perch\app`, builds it, adds its `bin` folder to your user `PATH`, and adds a Task Scheduler task that starts Perch when you sign in (hidden, logging to `%LOCALAPPDATA%\perch\perch.log`). Needs Node 23+ and Git for Windows; no administrator rights. Terminals run PowerShell 7 (`pwsh`) when it's installed, else Windows PowerShell; pick another shell in Settings → Terminal. For command history and prompt jumps, add the line Settings → Behavior shows to your PowerShell profile (`$PROFILE`). Search works without ripgrep, but installing it (`winget install BurntSushi.ripgrep.MSVC`) makes it faster and adds full glob support.

### The `perch` command

| Command | What it does |
|---|---|
| `perch start` / `stop` / `restart` | Start, stop, or restart the service |
| `perch status` | Whether it's running, and whether it's actually responding |
| `perch instances` | List every running instance — any port, any launch method (`npm run dev`, `npm start`, the service, or a `start --port` one-off) |
| `perch logs` | Follow the server's logs |
| `perch enable` / `disable` | Install and enable (or disable) the system service (systemd or launchd) |
| `perch update` | Pull the latest code, reinstall, rebuild, and restart |
| `perch doctor` | Check dependencies and install health, and troubleshoot problems |
| `perch open [path]` | Open a folder or file in the app, like `code`/`code-server` — see below |
| `perch ls` | List terminal sessions |
| `perch attach <session>` | Attach this terminal to a session (`work`) or one window (`work:1`); detach with `Ctrl+\` twice |
| `perch daemon status` / `stop` | The terminal daemon. Restarting or updating the server never touches it; `daemon stop` ends every terminal, and sessions come back the next time it starts |

Config (`PORT`, `AUTH_TOKEN`, `ALLOWED_HOSTS`, `NEW_SESSION_CWD`, `APP_NAME`, `PROXY_DOMAIN`, `EXTENSION_REGISTRY`) goes in `~/.local/share/perch/server/.env` — see [Production](#production) below for what each does. Without a service manager, `start`/`stop`/`restart` fall back to running the server in the background directly.

#### Flags instead of env vars

`start` and `restart` also accept the same config as flags — `perch start --help` shows the full list (`--port`, `--app-name`, `--allowed-hosts`, `--auth-token`, `--new-session-cwd`, `--proxy-domain`; both `--flag value` and `--flag=value` work):

```bash
perch start --port=8040 --app-name="Perch - Work"
```

- **With a service** (the default managed install): flags are written into `server/.env` and the service is restarted — they persist across future restarts, same as editing `server/.env` by hand.
- **Without one** (background mode): flags start an *additional* background instance on the given port, alongside anything already running — handy for running a second, differently-configured instance (e.g. a "work" one on another port) without disturbing the main one. Starting on a port that's already in use is refused.

`perch stop` stops the only running instance automatically; if more than one instance is running, it lists them and asks which to stop (or pass `--port <n>` or `--all` to skip the prompt). See `perch stop --help`.

#### Opening a folder or file

`perch open [path[:line]] [editor|preview]` opens a folder as a project, or a file in the editor — like `code`/`code-server`, but for every browser tab currently connected to that instance. With no path, opens the current directory; a bare `perch <path>` works the same as `perch open <path>`. A file's default action mirrors a click in the FILES panel (nvim, or its preview viewer when one applies); pass `editor` or `preview` as a second argument to force one or the other. Run from inside a terminal this app created (e.g. a `claude` session opened as a project), `open` targets that terminal's own instance automatically — otherwise it auto-detects the running instance, or asks which one if more than one is up (`--port <n>` skips that).

If no browser tab is connected, `open` prints a link (`?folder=`/`?file=`) you can open manually instead — note that link carries no auth token, so on an `AUTH_TOKEN`-protected instance it only works in a browser that's already logged in.

## Manual setup (from source)

Prefer [Install](#install) above for a managed, updatable install. To run from a clone directly instead:

```bash
npm install
```

## Development

Runs the server (`:3001`) and Vite dev server (`:5173`, proxying `/api` and `/ws` to the server) together:

```bash
npm run dev
```

Open http://localhost:5173.

## Production

Builds the client and serves everything — static assets, `/api`, and `/ws` — from a single Express server:

```bash
npm run build
npm start          # listens on 127.0.0.1:3001 by default
```

Override the port with `PORT=<port> npm start`. The server always binds to `127.0.0.1` and has no authentication by default, so it's meant to be used locally, fronted by a reverse-proxy auth layer, or gated with `AUTH_TOKEN` (see [Authentication](#authentication) below). Set `NEW_SESSION_CWD` to change the working directory new sessions start in — without it, new sessions start in your home directory. (The client's own "default new session directory" setting, if set, wins over both.)

Set `APP_NAME` to rebrand the browser tab title and PWA name away from the "Perch" default — e.g. `APP_NAME="My Server" npm start`. It's applied dynamically as the server templates `index.html` and `manifest.webmanifest` per request, so (like the other config above) a restart is all it takes — no rebuild needed. `APP_NAME=... npm run dev` retitles the dev server's tab too, but the PWA manifest is only active in the production build (Vite's PWA plugin doesn't run in dev by default).

To run a second instance beside the one you use (a test build, say), give it its own `PORT`, `PERCH_CONFIG_DIR` and `PERCH_STATE_DIR`: the config directory (default `~/.config/perch`) holds settings, extensions and the shims terminals use to reach the server, and the state directory (default `~/.local/state/perch`) holds the terminal daemon's socket and saved sessions. Two instances sharing either would rewrite each other's shims or share one set of terminals.

The app ships with a built-in **default extension registry** so extensions are installable out of the box from the **Extensions** tab (`Ctrl+Shift+X`) — no manual setup. It appears there as a non-removable source tagged "default". Override it with `EXTENSION_REGISTRY` (a registry URL serving an `index.json`, or a local directory path); set `EXTENSION_REGISTRY=` (empty) to disable it entirely and ship no default. Users can still add their own registries alongside it. Read at request time, so a restart applies changes with no rebuild.

### Behind nginx

```nginx
location / {
    proxy_pass http://127.0.0.1:3001;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;

    # Terminals are long-lived WebSocket connections.
    proxy_read_timeout 1d;
    proxy_send_timeout 1d;
}
```

If you add `auth_basic` (nginx-level HTTP Basic Auth) in front of this, exempt the manifest and service worker from it — Chrome's internal PWA-installability check fetches them without your browser's cached Basic Auth credentials, so they'll get a 401 and the "Install app" option won't appear even though the site itself loads fine:

```nginx
location = /manifest.webmanifest {
    auth_basic off;
    proxy_pass http://127.0.0.1:3001;
}
location = /sw.js {
    auth_basic off;
    proxy_pass http://127.0.0.1:3001;
}
location ~ ^/workbox-.*\.js$ {
    auth_basic off;
    proxy_pass http://127.0.0.1:3001;
}
```

`AUTH_TOKEN` (see [Authentication](#authentication) below) doesn't have this problem, since it's cookie-based and cookies ride along on every request automatically — it's the simpler option if you don't need Basic Auth for another reason.

The server only accepts requests whose `Host` (and, for browser requests, `Origin`) resolve to `localhost`, `127.0.0.1`, or `::1` by default — this blocks other websites' pages from reaching it via your browser (WebSockets ignore same-origin policy). Set `ALLOWED_HOSTS` to a comma-separated list of the hostname(s) you expose it as, e.g.:

```bash
ALLOWED_HOSTS=perch.example.com npm start
```

The `Host $host` line in the nginx config above forwards the real hostname through, so this only needs to be set once per domain. The `X-Forwarded-Proto` line lets the server mark the auth cookie (see below) `Secure` when you're serving over HTTPS.

### Authentication

Set `AUTH_TOKEN` to require a shared secret before anything under `/api` or either WebSocket endpoint (`/ws/attach`, `/ws/tunnel`) is reachable:

```bash
AUTH_TOKEN=<a-long-random-secret> npm start
```

Open the app with the token in the URL once:

```
https://perch.example.com/?token=<a-long-random-secret>
```

The server mints an HttpOnly cookie from that request and strips `?token=` from the address bar; every later request in that browser rides the cookie automatically. Visiting without a valid token shows a login form asking for it instead of the app.

Notes:

- **Off by default.** Leaving `AUTH_TOKEN` unset disables the gate entirely — identical to today's behavior.
- **The token appears once in plaintext** — in the URL you opened, and in your browser history unless you clear it. Treat that URL like a credential; don't paste it into chat or a public issue.
- **Scripts and the tunnel CLI** can't hold a cookie across invocations — pass the token as a header instead: `curl -H 'x-auth-token: <secret>' ...` or `node tunnel.mjs --header 'x-auth-token: <secret>' ...`. The PORTS panel's copy button already bakes in whatever `Cookie`/`Authorization` your browser session is carrying (see [Port forwarding](#port-forwarding) below), so the auth cookie — including one minted by `AUTH_TOKEN` — rides along automatically when you copy its generated command.
- **Static assets and `/tunnel.mjs`** stay reachable without a token — they're public code with nothing to protect. An extension's own `/api/ext/<id>/public/*` routes are likewise exempt from the gate, the same way they're exempt from the Origin check.

## Port forwarding

If something on the server listens on a port (a dev server, a database) and you want `localhost:PORT` on your own machine to reach it — like `ssh -L`, but without SSH access — pipe the tunnel CLI from the server straight into Node (nothing is written to disk):

```bash
curl -s http://<host>:3001/tunnel.mjs | node --input-type=module - --url http://<host>:3001 3000
```

Now `http://localhost:3000` on your machine reaches `127.0.0.1:3000` on the server. Forward multiple ports in one command, and use `LOCAL:REMOTE` when you want a different local port:

```bash
curl -s http://<host>:3001/tunnel.mjs | node --input-type=module - --url http://<host>:3001 3000 8080:80
```

Or skip the port list entirely with `--all`, which forwards every port currently listening inside the server's terminal sessions and keeps watching: a dev server you start later appears as a new local forward within seconds, and forwards whose remote port goes away are closed — no restart, no editing arguments:

```bash
curl -s http://<host>:3001/tunnel.mjs | node --input-type=module - --url http://<host>:3001 --all
```

A port that can't be bound locally (something on your machine already uses it) is reported once and skipped; explicit specs can be mixed in and keep priority over `--all` for their local ports. Run `--all` from your own machine, not from a shell inside one of the server's own terminals — there the tunnel's own listeners are indistinguishable from servers started in those terminals and would keep vanished ports alive.

The command works as-is on Windows too (`cmd` or PowerShell 7+): `curl` ships with Windows 10+, and nothing is stored on disk, so there's no Unix-only path involved. (On legacy Windows PowerShell 5.1, write `curl.exe` — bare `curl` is aliased to `Invoke-WebRequest` there.) If you'd rather keep a saved copy, `curl -O http://<host>:3001/tunnel.mjs` then `node tunnel.mjs ...` works the same way.

`--url` defaults to `$PERCH_URL`, then `http://127.0.0.1:3001`. All forwards share a single WebSocket connection, multiplexed per-connection — the CLI is a single dependency-free file (Node 20+, stdlib only), always served fresh from the server it's connecting to, so it never drifts out of sync with the server's protocol.

The **PORTS** panel in the sidebar lists the server's listening ports and builds this command for you — just copy it and run it locally. It always forwards **everything** (`--all`, auto-forwarding whatever is listening at any moment) rather than a fixed set you pick: a snapshot went stale the moment a dev server restarted on a different port. The same list and copy button are one click away from the status bar's port readout.

While a tunnel is connected, the app shows which ports it has actually bound locally — a marker on those rows, and a highlighted plug in the status bar once every listening port is covered. Clicking a forwarded port opens `http://localhost:<port>` directly instead of routing through the proxy. The CLI reports only ports it really bound (it skips any whose local port is already taken), so the marker never points at a dead address; a tunnel started from a command copied before this feature existed reports nothing and simply shows no marker. If your browser session is carrying a `Cookie` or `Authorization` header (because Perch is fronted by a reverse-proxy auth layer), the panel automatically bakes it into the copied command via `-H`/`--header`, so the download and the tunnel both authenticate the same way your browser did. Values are masked on screen (click the eye icon to reveal them before copying) — but the pasted command still contains the real secret, so it lands in your shell history like any credential-bearing command.

If you're running the CLI by hand instead of using the panel's copy button, pass auth through yourself with URL credentials or headers (once for the download, once for the tunnel):

```bash
curl -su user:pass https://myhost/tunnel.mjs | node --input-type=module - --url https://user:pass@myhost 3000
curl -s -H 'Cookie: session=...' https://myhost/tunnel.mjs | node --input-type=module - --url https://myhost --header 'Cookie: session=...' 3000
```

The nginx config above needs no changes — `/ws/tunnel` is covered by the same `location /` WebSocket proxy block as terminal sessions. Note that if a proxy strips the `Cookie`/`Authorization` header before forwarding upstream (some hardening configs explicitly clear `Authorization`), the panel has no way to detect that and will silently omit the header — same as if there were no auth layer at all.

### Browser-native proxy (no CLI download)

Each row in the **PORTS** panel also has three one-click actions — no CLI, no download, works from a phone:

- **Open in browser** — opens the port in a new tab.
- **Copy URL** — copies the same URL to your clipboard.
- **Kill process** — sends the owning process `SIGTERM` (after a confirmation), escalating to `SIGKILL` after 5 seconds if it's still holding the port.

This works because the server itself proxies local ports — code-server's `--proxy-domain` model — with two ways to reach a port:

```
https://perch.example.com/proxy/3000/       # always available, prefix stripped before forwarding
https://perch.example.com/absproxy/3000/    # prefix kept — for an app configured with a matching base path
```

`/proxy/<port>/` works with zero setup, but an app that references its own assets by absolute path (e.g. `/assets/index.js` rather than `./assets/index.js`) will 404 under a stripped prefix unless it's configured with a matching base path (Vite's `base`, Next's `basePath`, etc.) — the server also falls back to routing an absolute-path request to whichever port referred it (via the `Referer` header), which covers most dev servers without any config at all. `/absproxy/<port>/` is the escape hatch for apps you *have* configured with a base path.

For the case where every app should work completely unmodified, set `PROXY_DOMAIN` to route by subdomain instead of path prefix — same idea as code-server's `--proxy-domain`:

```bash
PROXY_DOMAIN=proxy.example.com npm start
# or: perch start --proxy-domain proxy.example.com
```

A request to `3000.proxy.example.com` now reaches port 3000 directly, with no path rewriting — comma-separate multiple domains if you need more than one. This requires wildcard DNS (`*.proxy.example.com` → this server) and, if you're serving over HTTPS, a wildcard TLS certificate for that domain too — a browser only sends a `Secure` cookie back to HTTPS subdomains, so without wildcard TLS the auth cookie (see [Authentication](#authentication) above) won't reach them. If you hit that, opening `https://3000.proxy.example.com/?token=<secret>` once mints the cookie for that specific subdomain directly.

All of this sits behind the same gates as everything else: `ALLOWED_HOSTS`/`PROXY_DOMAIN` decide which Host headers are accepted, and `AUTH_TOKEN` (when set) gates proxied requests exactly like `/api/*` — a proxied port is never reachable without a valid token any more than the app itself is.

## Extensions

Extensions live as folders under `~/.config/perch/extensions/<folder>/` — either drop one in directly (the server picks it up on next scan/restart), or install a packed `.perch` from the Settings dialog's **Extensions** section, which also lists what's installed and lets you enable/disable or uninstall each one. A worked example covering the basic surfaces is in [`examples/hello-extension`](examples/hello-extension); the sections below are a summary — **the complete, detailed API reference is [docs/EXTENSION_API.md](docs/EXTENSION_API.md)**.

Every built-in file preview (image, media, PDF, markdown, JSON/YAML, CSV, HTML) — the SOURCE CONTROL, SEARCH, and PORTS panels — the FILES-tree git decorations — the subagent activity badges — the touch key bar — **both terminal engines** — and the app's default color theme, icon theme, and terminal font — is itself a bundled extension under the repo's own [`extensions/`](extensions) directory, discovered alongside `~/.config/perch/extensions/` — see [Bundled extensions](#bundled-extensions) below and [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the core-vs-extension boundary. A user-installed extension with the same id always takes precedence over a bundled one.

### Bundled extensions

Two shapes of bundled extension live under `extensions/<name>/`:

- **Functionality extensions** (one per built-in preview — `image-preview`, `media-preview`, `pdf-preview`, `markdown-preview`, `json-preview`, `csv-preview` — plus `git-scm` (the SOURCE CONTROL panel **and** the FILES-tree git status decorations/branch pill), `search`, `live-preview` (the sandboxed HTML preview), `ports` (the PORTS explorer section), `subagent-viewer` (Claude Code subagent badges + popover), `worktrees` (palette entry points for the tree's create-worktree form), `touch-keys` (the mobile touch key bar and its layout editor), and the `xterm-engine` terminal engine — a **required builtin** (`perch.required`): the app's rendering floor, so it can't be disabled or uninstalled and is the automatic fallback whenever the selected engine is missing (the optional `ghostty-engine` lives in the extensions registry, not bundled)) ship a normal extension manifest plus a `src/client.tsx` built by `extensions/build.mjs` into `dist/client.js` (+ `dist/client.css` if it imports any CSS). `npm run build`/`npm run dev` build these automatically (`prebuild`/`predev` hooks); `npm run build:extensions` builds them standalone, and `node extensions/build.mjs --watch` rebuilds on save (what `npm run dev` runs in the background).
- **Asset-only extensions** (`plastic-legacy-theme`, `seti-icons`, `ibm-plex-mono` — the app's default color theme, icon theme, and terminal font) have no `src/client.tsx`, so `build.mjs` skips them entirely; their manifest just points at theme/font files directly. All three are enabled by default, giving a fresh install the same look it always had, but each is now independently disable-/uninstallable/overridable like any other extension — a hard-coded fallback (styles.css's `:root` values, "no icon theme", generic `monospace`) covers the gap if one is off.

Bundled extensions are enabled by default and show a **Built-in** badge in Settings. Uninstalling one doesn't delete repo files — it's tombstoned in `~/.config/perch/extensions-state.json` and goes inactive, then reappears in the Extensions tab's **Available** section like any other installable extension, with an **Install** button that restores it (installing a `.perch` with the same id, which overrides the bundled copy, also restores it). Required builtins (see below) can't be uninstalled at all.

Small helpers shared across the bundled extensions (an `Icon` component, clipboard/file-fetch wrappers, a `MenuItem` type) live in `extensions/_shared/` as plain source — each extension's build inlines its own copy rather than sharing a runtime module, per `_shared`'s own comments. `extensions/_shared/shims/` holds the react/react-dom/react-dom-client/react-jsx-runtime aliases described below, plus `@perch/engine-support` — the host's terminal engine-support helpers (link detection, cell math, input utilities) for extension-implemented engines and accessories.

Writing your own bundled-style extension with JSX or npm dependencies (not required — a plain ESM `client.js` like hello-extension's works with zero build step) means following the same convention: bundle with a tool of your choice, but alias `react`/`react-dom`/`react/jsx-runtime` to thin re-exports of `window.__perchModules` (set by `client/src/main.tsx` before any extension activates) instead of bundling real copies — two React instances break hooks and portals shared with the host. See `extensions/build.mjs` and `extensions/_shared/shims/*.mjs` for the reference implementation.

### Manifest format

Each extension has a `package.json` — a subset of the real VS Code extension manifest, plus one custom field:

```json
{
  "name": "my-extension",
  "publisher": "me",
  "version": "1.0.0",
  "displayName": "My Extension",
  "description": "What it does",
  "contributes": {
    "themes": [{ "label": "My Theme", "uiTheme": "vs-dark", "path": "./themes/my-theme-color-theme.json" }],
    "iconThemes": [{ "id": "my-icons", "label": "My Icons", "path": "./themes/my-icon-theme.json" }],
    "fonts": [{ "group": "My Fonts", "fonts": [{ "family": "My Mono", "src": [{ "path": "./fonts/MyMono-Regular.woff2", "format": "woff2" }] }] }],
    "configuration": {
      "title": "My Extension",
      "properties": {
        "myExtension.greeting": { "type": "string", "default": "Hello!", "description": "Greeting text" }
      }
    }
  },
  "perch": {
    "client": "./client.js",
    "server": "./server.js"
  }
}
```

The extension's id is `publisher.name` (falling back to its folder name). `contributes.themes`/`contributes.iconThemes` point at real, unmodified VS Code color-theme / icon-theme JSON — comments and trailing commas are tolerated, and one level of `include` is resolved. `perch.client`/`perch.server` are both optional; either, neither, or both may be set.

### Color themes

A theme JSON's `colors` map is read via VS Code's own workbench keys (`editor.background`, `tab.activeBackground`, `list.hoverBackground`, `button.background`, `terminal.ansiRed`, …) — anything not set falls back to the hard-coded Plastic Legacy value for that slot (styles.css's `:root`), so a partial theme never breaks the UI. That hard fallback is pixel-identical to the bundled `plastic-legacy-theme` extension, which is what's actually selected by default. Applies live, no reload — both the app chrome and the terminal palette.

### Icon themes

Both icon styles VS Code themes use are supported: font-glyph (`fontCharacter`/`fontColor`, the bundled `seti-icons` extension's style — the theme's own font is loaded at runtime via `FontFace`) and SVG (`iconPath`, the Material Icon Theme style). Matched by filename, then extension, then a theme-wide default, same as VS Code. Selecting no icon theme ("None") shows blank spacer icons rather than falling back to Seti.

### Fonts

Not a VS Code manifest concept (VS Code's own font contributions are icon-theme glyph fonts only) — `contributes.fonts` is Perch's own extension of the manifest, for terminal text fonts. Each entry is a named **group** bundling one or more font families:

```json
"contributes": {
  "fonts": [
    {
      "group": "My Fonts",
      "fonts": [
        { "family": "My Mono", "src": [{ "path": "./fonts/MyMono-Regular.woff2", "format": "woff2" }] },
        { "family": "My Mono", "src": [{ "path": "./fonts/MyMono-Bold.woff2", "format": "woff2" }], "weight": "bold" },
        { "family": "My Nerd Symbols", "src": [{ "path": "./fonts/MyNerdSymbols.woff2", "format": "woff2" }] }
      ]
    }
  ]
}
```

Within a group's `fonts`, entries sharing a `family` register different weights/styles of the same font (worth including a `"weight": "bold"` face — xterm renders bold cells with it, falling back to synthetic bold otherwise); entries with distinct `family` values bundle separate fonts into that one group, e.g. a mono text font plus a Nerd Font symbols companion. A group is the Settings → Terminal font picker's unit of selection: picking "My Fonts" writes **every** family in the group into the font stack at once (mono as the primary font, the symbols font riding along as an implicit fallback) — no separate step to combine them. One extension can contribute several groups (e.g. the same symbols font offered both bundled into a combo group and on its own).

The font-family select only lists fonts this app can actually guarantee: "Use fallback fonts" (contributes nothing itself — the whole stack comes from the fallback field), its own bundled fonts, and whatever enabled extensions contribute. A locally-installed system font isn't offered there (it isn't guaranteed to exist wherever the page is next opened) — type it into the fallback field instead, same as any other font-family string. A stored stack whose leading font doesn't match a listed option (typed by hand, or from an extension that's since been disabled) just shows as "Use fallback fonts" with the whole thing sitting in that field.

Unlike themes, fonts aren't mutually exclusive and aren't all loaded up front: a family's `FontFace`s are only fetched once that family is actually present in the stack — whether it got there via a group selection or a hand-typed fallback — and are dropped again if it's removed or its extension is disabled/uninstalled, the same selected-only-loads policy color and icon themes already follow; this is per-family, so a stack that keeps only one member of a group never loads the other. Registers under each family's real name (unlike icon-theme fonts, which load under an internal namespaced family), so you can reference it directly in the fallback field. Applies live, no reload.

### Settings

`contributes.configuration` is VS Code's real manifest shape — a single object or an array of them (each with an optional `title` and a `properties` map), which lets one extension group its settings under more than one heading. Each property key is the full dotted name the extension will read back (no shared prefix is required, but `myExtension.foo` is the usual convention):

```json
"contributes": {
  "configuration": {
    "title": "My Extension",
    "properties": {
      "myExtension.greeting": { "type": "string", "default": "Hello!", "description": "Greeting text" },
      "myExtension.shout": { "type": "boolean", "default": false, "description": "Shout the greeting" },
      "myExtension.repeatCount": { "type": "integer", "default": 1, "minimum": 1, "maximum": 5 },
      "myExtension.mood": {
        "type": "string",
        "enum": ["neutral", "excited"],
        "enumItemLabels": ["Neutral", "Excited"],
        "enumDescriptions": ["Plain greeting", "Adds an exclamation"],
        "default": "neutral"
      }
    }
  }
}
```

Supported `type`s are `boolean`, `number`, `integer`, and `string` (with `enum` for a picker) — a property with any other `type` (or missing one) is dropped; `array`/`object` values aren't supported. An `enum` property's options are labeled with `enumItemLabels[i]` (falling back to the raw value) with `enumDescriptions[i]` shown as that option's tooltip, matching VS Code. `description` (or `markdownDescription`, rendered as plain text) is shown as the setting's label.

Extensions with at least one enabled, valid property get their own entry in the Settings nav (below a divider, under the built-in sections), titled by the manifest's `displayName`. Only non-default values are ever persisted — same as keybinding overrides — so a later change to an extension's declared default still reaches a user who never touched that setting; a value survives the extension being disabled or uninstalled. Applies live, no reload, on both sides:

- Client: `ctx.settings.get(key)` returns the current value (declared default, or the user's override); `ctx.settings.onDidChange(cb)` fires `cb()` (no arguments — call `get()` again for whatever you care about) whenever any of this extension's settings change, returning an unsubscribe function.
- Server: the server hook's `activate({ router, log, getSettings })` gains `getSettings()`, returning a `Promise` of this extension's full key→value map (declared defaults merged with the user's overrides). Read fresh on every call, so there's no cache to invalidate — a change reaches the next request without a server restart.

### Functionality

`perch.client` is a plain ESM module (no JSX, no bundler) exporting `activate(ctx)`:

- `ctx.React` — the app's own React instance (use `React.createElement`, or a JSX build step of your own that targets it — see [Bundled extensions](#bundled-extensions))
- `ctx.registerCommand({ id, label, defaultBinding?, run })` — joins the built-in command list and the Keyboard settings section, auto-namespaced to `ext.<extensionId>.<id>`
- `ctx.registerFileViewer({ id, extensions, mode?, editorFallback?, component })` — a component rendered full-tab for files with one of the given extensions:
  - `mode` (default `"default"`): `"default"` means a FILES-tree click opens this viewer directly; `"preview"` means a click still opens the file in nvim as usual, and this viewer is reached instead via the FILES-tree hover icon, the "Preview" context-menu item, or Shift+Enter in the quick switcher
  - `editorFallback` (default `true`, `"default"`-mode only): whether the context menu offers an "Open in Editor" item to fall back to nvim — the bundled image-preview leaves this on (for editing e.g. an SVG's source), media-preview/pdf-preview turn it off (nvim on binary content isn't useful)
  - among same-path matches, a third-party (user-installed) viewer takes precedence over a bundled one, so you can override a built-in preview by registering for the same extension
  - the component receives `{ filePath, active }` plus optional host props: `toolbarTarget` (a `HTMLDivElement | null` to portal tab-bar controls into), `openInEditor(path)`, `showMenu(x, y, items)`, `setDirty(dirty)` (report unsaved edits so closing the tab confirms first), `fontSize` (px)
- `ctx.registerSidebarPanel({ id, title, icon?, location?, defaultCollapsed?, focusBinding?, component })` — a sidebar surface. `location: "tab"` (the default) adds its own tab to the sidebar's tab strip, alongside the built-in Explorer tab; `location: "explorer"` renders it as an accordion section inside the Explorer tab beside PROJECTS/FILES (how the bundled ports extension restores the PORTS section), taking part in the accordion's drag-reorder/collapse/resize persistence under its namespaced id, starting collapsed when `defaultCollapsed` is set, and always registering a "Sidebar: Focus `<title>`" command. `location` sets only the panel's *default* home — the user can move any panel into any tab from its header's context menu, and both the panel's focus command and `ctx.app.revealSidebarPanel` follow it wherever it ends up. `icon` is a codicon name (default `"extensions"`); `focusBinding` (a keybindings.ts-style combo, e.g. `"ctrl+shift+KeyG"`) gives that focus command a default binding — for `"tab"` panels, omitting it omits the command entirely. The component receives optional host props: `actionsTarget` (a `HTMLDivElement | null` to portal header-row buttons into — same portal mechanism `registerFileViewer`'s `toolbarTarget` uses), `showMenu(x, y, items)` (the shared context menu), and `confirmDialog(message, confirmLabel?)` (the app's confirm dialog, resolving `true` on confirm)
- `ctx.registerWindowAction({ id, icon, title, isVisible, onClick, showInTabBar? })` — an icon button on PROJECTS-tree terminal rows (next to the built-in kill button), shown only where `isVisible({ sessionName, windowIndex, cwd, command })` returns true — `command` is the window's current foreground command, so an action can target e.g. only windows running `claude`; `showInTabBar: true` also renders it in the tab bar next to whichever terminal window tab is focused
- `ctx.registerFileDecorationProvider({ id, provideDecoration, provideRootDecoration? })` — per-path FILES-tree decorations: `provideDecoration(path, isDir)` returns `{ badge?, tooltip?, className? }` (row colors come from the extension's own stylesheet via `className`), `provideRootDecoration(rootPath)` returns `{ label, tooltip? }` for the tree header's branch-pill slot. Both are synchronous — answer from a cache the extension maintains and call the returned handle's `refresh()` when it changes (how git-scm supplies git badges and the branch pill)
- `ctx.registerSessionDecorationProvider({ id, provideWindowDecoration, onClick? })` — badges on PROJECTS terminal rows: `provideWindowDecoration({ sessionName, windowIndex, cwd, command })` returns `{ badge, tooltip?, className? }`; `onClick(anchorRect, ctx)` lets the extension open its own popover (how subagent-viewer shows agent counts and its details panel). Same sync-from-cache + `refresh()` contract
- `ctx.registerEditor({ id, label, capabilities, openFile, openDiff?, openMerge? })` — supplies an editor for the Settings → Editor picker (declared in the manifest as `contributes.editors`, so the picker lists it without activating anything). `capabilities` is any of `"file"`, `"diff"`, `"merge"`; whatever isn't declared falls back to core's nvim editor. Callers reach it through `ctx.app.openInEditor/openDiff/openMerge` — see [docs/EXTENSION_API.md](docs/EXTENSION_API.md#editors--registereditor)
- `ctx.registerTerminalEngine({ id, label, create })` — supplies a terminal engine (`create` implements the `CreateTerminalEngine` seam — see `extensions/_shared/terminalEngineTypes.ts`); the Settings → Terminal engine select lists it and the engine setting stores its namespaced id (how the bundled xterm-engine and the registry's ghostty-engine ship)
- `ctx.registerTerminalAccessory({ id, placement, component })` — per-terminal UI in the `"bar"` slot (below the terminal, in flow) or `"overlay"` slot (inside the terminal body's positioning context); the component receives a `context` prop with `focused`, `mobilePointer`, `command` (foreground program), `stickyCtrl`/`toggleStickyCtrl()`, `sendInput(data)`, `sendText(text)` (local-echo-aware), `uploadImage(file)`, and `containerRef` (how touch-keys renders the key bar and floating toggle)
- `ctx.registerQuickSwitcherProvider({ id, provideResults })` — contributes result rows to the quick switcher's non-command mode: `provideResults(query)` returns `{ label, tag?, run(secondary) }[]`, synchronously from extension-owned cache (self-limit counts; `refresh()` re-queries an open switcher)
- `ctx.registerAppOverlay({ id, component })` — renders a component once over the editor area, on top of whatever tab is active (unlike a terminal accessory, which mounts only inside a focused terminal); the host draws it into a `pointer-events: none` layer, so the component opts its own interactive parts back in
- `ctx.registerStatusBarItem({ id, title?, placement?, order?, visibilitySetting?, component })` — a compact readout in the bottom status bar. `placement` is `"left"` or `"right"` (default `"right"`, where the app's own terminal count also sits) and `order` sorts within that group. `title` names the item in the gear menu's Status Bar list, where the user switches it on and off (default: the extension's display name). `visibilitySetting` is the dotted key of a boolean setting from your own manifest; give one and that setting becomes the item's switch — the list reads and writes it instead of the app's own hidden list, and the item renders unless the value is `false` — so an extension that already offers "show this in the status bar" keeps one control rather than gaining a second (the bundled Git extension does this with `gitScm.statusBar`). The component receives a `context` prop with `mobilePointer`, `showMenu(x, y, items)`, and `openPopover(anchorRect, content)` / `closePopover()` — a floating panel above the bar that the host positions and dismisses, and that `openPopover` toggles when the same item calls it again (how the bundled ports extension shows its port list and forward command, and how the external Claude usage extension shows its token counter). The whole bar is hidden on phones and tablets, so an item never renders there
- `ctx.registerSettingsComponent({ id, component })` — renders a custom React component inside this extension's Settings section, below its scalar `contributes.configuration` controls — for configuration that outgrows scalar properties (how touch-keys hosts its drag-and-drop layout editor, persisting the layout through `ctx.settings.set` as a JSON-string property)
- `ctx.app.getActiveContext()` / `ctx.app.onDidChangeContext(cb)` — the active tab's session name / window index / cwd
- `ctx.app.openFileTab(path, line?)` — opens a path through the same dispatch a FILES-tree click uses; `line` jumps to that line when it opens in nvim
- `ctx.app.openViewerTab(viewerId, path, opts?: { title? })` — opens (or activates) a tab for one of this extension's own `registerFileViewer` components directly, bypassing extension-based matching — for a viewer registered with `extensions: []` that's only ever reached this way (e.g. a diff view opened from a source-control panel). `opts.title` overrides the tab-bar label (default: the path's basename); calling it again for an already-open `(viewerId, path)` tab updates its title in place
- `ctx.app.refreshFiles()` — bumps the FILES tree's refresh key, so its git-status badges reflect a change this extension just made (stage, commit, discard, pull) without waiting for its own poll
- `ctx.app.revealSidebarPanel(panelId)` — reveals one of this extension's own sidebar panels (reveals the sidebar, switches to its tab, expands and focuses its section) — what a command that opens the panel's UI should call, since unlike the panel's own focus command it never toggles an already-active panel shut
- `ctx.app.openSessionWindow(sessionName, opts?: { createCwd? })` — opens a session's current window as a window-tab; with `createCwd`, a session that doesn't exist yet is created there first (how a fresh checkout becomes a session in one step)
- `ctx.app.killSession(sessionName)` — kills a session and closes its tabs. Runs **no** confirmation of its own — the caller owns the prompt, so confirm before calling
- `ctx.serverFetch(path, init?)` — `fetch()` scoped to this extension's own server route
- `ctx.assetUrl(relPath)` — resolves an extension-relative path (e.g. a bundled stylesheet) to a fetchable URL, the same route the client entry itself is loaded from
- `ctx.settings.get(key)` / `ctx.settings.set(key, value)` / `ctx.settings.onDidChange(cb)` — this extension's `contributes.configuration` values (`set` writes to the same server-synced store the Settings UI edits) — see [Settings](#settings) above

`perch.server` is a plain ESM module exporting `activate({ router, log, getSettings, host })` — `router` is an Express router mounted at `/api/ext/<extensionId>` for as long as the extension stays enabled; disabling/uninstalling unmounts the routes immediately, though the loaded module itself stays resident until the server restarts (Node can't unload an ES module) — the Settings dialog shows a restart hint for this case. `getSettings()` returns this extension's current settings — see [Settings](#settings) above. `host` is the curated core-services API: `host.ports.list()`/`host.ports.find(port)` (listening ports attributed to terminals, the same data the WS tunnel's security gate uses) and `host.events.onApiMutation(cb)` (fires after any mutating core API call — invalidate caches that mirror on-disk state; returns an unsubscribe, and all of an extension's subscriptions drop when its hook unmounts).

A client entry activates once at page load; enabling, disabling, or installing one takes a page reload to fully apply. Themes and icon themes need no reload.

### Security

Installing an extension with a `perch.server` entry runs its code as the server process's user, and a `perch.client` entry runs with full access to the page (same origin, same DOM) — identical in kind to the access this app already gives you through the terminal itself, but only install extensions you trust.

## Project layout

```
mux/        The terminal daemon — owns every terminal (node-pty), replays history on attach, snapshots to disk
server/     Express + ws — REST API and the WS bridge to the daemon; talks to it only through server/src/multiplexer.ts
client/     React + TypeScript — the browser UI; the terminal-engine seam under src/engines/ (both engine implementations live in extensions/)
extensions/ Bundled extensions (image/media/pdf/markdown/json/csv/html preview, git source control) — see Bundled extensions
cli/        tunnel.mjs — standalone port-forwarding client, served at GET /tunnel.mjs
bin/        perch — entry point of the CLI for managing an installed instance, see Install
cli/        perch/ — that CLI (Node; systemd and launchd behind one service-manager interface)
systemd/    perch.service — the user-mode systemd unit installed by install.sh
examples/   hello-extension — a reference extension covering every surface in Extensions
plans/      Design docs written during development
```

## License

MIT — see [LICENSE](LICENSE).
