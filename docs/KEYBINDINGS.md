# Keyboard & mouse

Every default shortcut, and the mouse gestures the terminal understands.
All of them are remappable from the Keyboard Shortcuts editor (gear menu →
Keyboard Shortcuts).

| Shortcut | Action |
|---|---|
| `Ctrl+Shift+B` | Toggle sidebar |
| `Ctrl+Alt+B` | Toggle right sidebar |
| `Ctrl+Shift+E` | Focus Explorer |
| `Ctrl+Shift+G` | Focus Source Control (`git-scm` extension) |
| `Ctrl+Shift+F` | Focus Search (`search` extension) when no terminal has focus |
| `Ctrl+Shift+X` | Focus Extensions |
| `Ctrl+P` | Toggle quick switcher |
| `Alt+J` / `Alt+K` | Select next / previous item in the open quick switcher |
| `Ctrl+Shift+P` † | Show command palette |
| `Ctrl+Tab` * | Next tab |
| `Ctrl+Shift+Tab` * | Previous tab |
| `Ctrl+W` * | Close active tab |
| `Ctrl+,` | Open Settings |
| `Ctrl+Shift+C` | Copy terminal selection |
| `Ctrl+Shift+Alt+C` | Copy terminal selection as one paragraph |
| `Ctrl+Shift+F` | Scrollback search (terminal focused) |
| `Shift+Enter` | Insert a literal newline in the terminal |
| `Ctrl+Alt+↑` / `Ctrl+Alt+↓` | Jump to the previous / next command (needs shell integration) |
| `Alt+1`…`Alt+9` ‡ | Jump straight to the 1st…9th tab |
| `Ctrl+Shift+PageUp` / `Ctrl+Shift+PageDown` | Move the active tab left / right |
| `Shift+Alt+T` | Reopen the last closed tab |
| `Ctrl+=` / `Ctrl+-` | Increase / decrease terminal font size |
| `Ctrl+0` | Reset terminal font size |
| `Ctrl+\` | Split editor right |
| `Ctrl+1`…`Ctrl+8` * | Focus the 1st…8th editor group (split pane) |
| `Ctrl+Alt+←` / `Ctrl+Alt+→` § | Move the active tab into the previous / next editor group |
| ``Ctrl+` `` | Toggle the bottom terminal panel |
| ``Ctrl+Shift+` `` | New terminal in the bottom panel |
| `Ctrl+C` / `Ctrl+X` / `Ctrl+V` | Copy / cut / paste files in the FILES tree (tree focused) |
| `Ctrl+F` | Search file names in the FILES tree (tree focused) |
| `F2` | Rename the focused file in FILES, or the focused terminal in PROJECTS |
| `Delete` | Delete the selected files in FILES, or close the focused terminal or project in PROJECTS |

\* Browser-reserved outside the installed PWA — bind a different combo in Keyboard Shortcuts if you're using Perch as a regular browser tab.

† Firefox reserves `Ctrl+Shift+P` for opening a private window and won't let pages intercept it — rebind it in Keyboard Shortcuts, or just type `>` into the `Ctrl+P` quick switcher instead.

‡ Firefox on Linux also binds `Alt+1`…`Alt+9` to its own tab switching and may not let pages intercept them — rebind in Keyboard Shortcuts if that's in the way.

§ GNOME on Linux binds `Ctrl+Alt+←`/`Ctrl+Alt+→` to virtual-desktop switching by default and may not let pages intercept them — rebind in Keyboard Shortcuts if that's in the way.

The command palette also lists seven project/terminal actions — **Project: New…** (the Open Folder dialog), **Project: Close Current**, **Session: Pin/Unpin Current** (adds or removes the current session's folder as a pinned project), **Terminal: New**, **Terminal: Close Current**, **Terminal: Rename Current…**, and **Tab: Close Others** — that ship with no default key so they don't collide with anything; bind any of them from Keyboard Shortcuts if you use them often. They stay accessible from the sidebar's context menus and hover buttons either way. **Terminal: Clear Scrollback** and **Terminal: Scroll to Bottom** likewise ship unbound — assign a chord in Keyboard Shortcuts if you want one.

- **`Ctrl`+click** (`Cmd`+click on Mac) a URL, local file path, or hyperlink in the terminal to open it; add `Shift` to open a file in its preview viewer instead of the editor.
- **Drag** in the terminal selects text; when a program is using the mouse (vim, htop), **Shift+drag** selects instead of sending the drag to it.
- **Copy modes** (Settings → Terminal → *When copying a selection*) — *Join soft-wrapped lines* (the default) undoes the wraps the terminal itself made, while keeping newlines the program actually emitted. *Keep lines as shown* copies the rows verbatim. *Join into paragraphs* also undoes a program's own word-wrap, so a paragraph Claude Code or `git log` wrapped for the pane width comes back as one paragraph — that one is lossy (a code block collapses onto one line), so prefer **Copy as Paragraph** (`Ctrl+Shift+Alt+C`, or the terminal's right-click menu) to apply it to a single copy without changing the default.
- **Shift+scroll** (or a trackpad's horizontal scroll) sends horizontal scroll events to `nvim`.
- **Clipboard** - copying inside a terminal lands in your browser's clipboard with nothing to configure. Any OSC 52 clipboard-set sequence a program emits is written straight to the browser clipboard, and the terminal advertises that ability (XTGETTCAP `Ms`), so `nvim` turns on its built-in OSC 52 provider by itself: `"+y`, or plain `y` with `clipboard=unnamedplus`, just works. Tools that copy by piping into `xclip`, `xsel`, `wl-copy` or `pbcopy` (like `gh auth login` copying its one-time code) work too: every terminal has `~/.config/perch/bin` first on its PATH, where stand-ins for those tools send the text as OSC 52 when the host has no display, and step aside for the real tool when it has one (the `xdg-open` stand-in does the same). Copying only goes one way: pasting from the browser clipboard back into a program is not supported, so `xclip -o` and nvim's `"+p` come back empty. Paste into the terminal with your browser's paste shortcut or the right-click menu's Paste instead.

All of the above are defaults — remap any of them, including extension-contributed commands, from Keyboard Shortcuts.
