# Changelog

What changed in each Perch release. The newest is first; each entry is
drafted from the commit subjects by `npm run release`, then edited.

## 0.9.2 - 2026-10-20

- **Commenting on a web preview no longer breaks the page.** The screenshot
  taken for each comment copied the site's whole stylesheet into the live
  page, which could change how it looked, and ran the site's own code for
  every custom element it copied (a Shopify theme's cart or search, say),
  leaving errors and stray listeners behind. It now only reads the page, and
  still draws it with the site's web fonts.
- **A dev server's preview stays on the dev server as it navigates.** A link
  or script going to a root path such as `/about` left Perch's proxy, so the
  next click or a reload loaded Perch itself into the preview. Reload also
  works after a single-page app moves to such a path.

## 0.9.1 - 2026-10-20

- **A window is no longer taken for Claude Code because a program in it
  started `claude`.** A remote desktop run in a terminal starts Chrome, and
  Chrome starts `claude --chrome-native-host` for the Claude in Chrome
  extension, which labelled that terminal as running Claude Code. Only an
  agent run from the window itself - in the foreground, through a wrapper, or
  left running in the background - counts now (Linux and macOS).

## 0.9.0 - 2026-10-20

- **Every extension gets its own storage.** A private SQLite database per
  extension, readable and writable from its server code (`storage`) and its
  browser code (`ctx.storage`), with each change pushed to every open browser
  within a second instead of polled. Uninstalling an extension keeps its data;
  **Settings → Extensions → Stored data** shows each one's size and deletes
  it, including data left by removed extensions. Notes, Automations, Agent
  Tasks, Jira, DB Client and HTTP Client now keep their data there, and start
  empty after updating: their old files are left as they were.
- **Extensions can say which Perch they need.** One declaring
  `perch.minPerch` above the running version shows **Needs Perch X or newer**
  and isn't loaded.
- **Perch now needs Node.js 24.** The installer, `perch doctor` and the
  server itself check for it.
- **Send to agents.** Select text in a terminal and choose **Send Selection
  to Agent…**, or run **Agents: Compose Message…**, to type a message (with
  `@file` mentions and images) into one or more agent windows, in any project.
- **Past agent conversations.** Core reads Claude Code's and Codex's
  transcripts and knows how to resume them; the optional Agent Sessions
  extension lists, previews and resumes them.
- **Project setup from a committed file.** A `.perch/project.json` in a
  repository can open its terminals, after you review and trust the exact
  commands. See [Project setup](docs/PROJECT_SETUP.md).
- **Mermaid diagrams** draw in the Markdown preview.
- **More for extensions:** terminal and viewer accessories know their window
  and file, decorations can carry an icon, the PORTS menu takes extension
  items, and extensions hear about renames made in FILES. Extension routes
  accept JSON bodies up to 17 MB.

## 0.8.0 - 2026-10-20

- **Extensions can open their own settings.** The new
  `ctx.settings.open()` opens the Settings tab at the extension's section,
  for a gear button in its panel. Remote Desktop 2.3.0 adds one.
- **Extension tabs can have their own icon.** A file viewer registered with
  `icon` shows that codicon in the tab bar instead of the generic file icon
  its path would get. Remote Desktop's display tab now shows a monitor.
- **Extensions are listed by name**, in the Extensions tab and in the
  Settings list alike.
- **No more repeated headings in extension settings.** A configuration
  section titled after its extension ("Remote Desktop" under "Remote
  Desktop") no longer repeats the page title.

## 0.7.0 - 2026-10-19

- **Terminal grids can span projects.** A grid can now hold windows from
  different projects: **Move to Grid** lists every grid, and the grid tab's
  menu has **Add Terminal from Project…** (also in the command palette).
  Each cell's title reads `project · window`, and a grid that mixes projects
  sits on its own outside the project tab groups.
- **Grid cells show window decorations**, such as an extension's status
  marks, in their headers.
- **Extensions can keep a grid of their own windows** with the new
  `registerManagedGrid` API. Windows join and leave it as the extension
  says; a cell you close stays out until the extension drops and re-adds
  it, and terminals you add yourself are never removed. Agent Monitor 1.7.0
  uses it for its Agents Grid.
- **Shopify storefronts no longer rate-limit the web preview.** Theme
  previews showed a 429 "You have sent too many requests" page after a
  request or two, and variant options on product cards silently failed.

## 0.6.0 - 2026-10-19

- **Open a port inside Perch.** In the PORTS view and the status bar's
  ports list, Ctrl+click (Cmd+click on a Mac) or middle-click a port to open
  it in a Perch preview tab instead of a browser tab, or use the new
  **Open in Perch** button on its row.
- **Ports work properly behind a proxy domain.** With `PROXY_DOMAIN` set, a
  port's address now keeps the port Perch is served on, and dev servers'
  own frames and cross-origin requests on their subdomains are no longer
  blocked. Preview tabs now load through Perch's own `/proxy/<port>/` path,
  so the address bar follows the page and Back, Reload and Inspect work.
- **Dev servers that listen only on IPv6 (`::1`) can be reached.** The port
  proxy and the tunnel used to give 502 for them.

## 0.5.0 - 2026-10-19

- **Change marks in the editor gutter, like VS Code.** With the Text Editor
  extension (2.6.0 or newer) as your editor, lines changed since the last
  commit get a bar in the gutter (green added, striped changed, a triangle
  where lines were deleted) and matching marks on the scrollbar and minimap.
  Click one to see the change as an inline diff and stage just that change,
  revert it, or step to the next one; Alt+F5 and Shift+Alt+F5 move between
  changes. Extensions can supply these marks through the new quick-diff
  extension point; the bundled Git extension does.
- **The default Plastic Legacy theme now colors the editor like Plastic in
  VS Code:** change marks, diffs, line numbers, find and selection
  highlights, and the editor's popups.

## 0.4.1 - 2026-10-19

- **Terminals no longer come back garbled after a size change.** Opening a
  terminal at another width than it was last used at (a phone picking up a
  desktop's terminal, say) could scatter a coding agent's output across the
  screen, leaving half-erased lines behind. Perch now replays the screen
  reflowed to the new size.
- **Unsaved edits to large files are kept again.** Drafts over 100 KB were
  refused, so unsaved changes to a large file weren't restored when it
  reopened.

## 0.4.0 - 2026-10-19

- **Grid tabs: several terminals of a project tiled in one tab,** the way
  tmux's tiled layout does it. Right-click a project's chip for **New Grid**
  or **Tile All Terminals**, use a terminal tab's **Move to Grid**, or drag a
  terminal tab onto a grid tab. Drag the lines between rows and columns to
  resize them, drag a cell's header onto another to swap them, and use each
  header to zoom a cell, pop it out as its own tab, or close it (the
  terminal keeps running). `Alt+Arrow` moves focus between cells while a
  grid tab is active. Splitting a grid tab shows the same grid in both
  panes, and phones stack the cells in one column.

## 0.3.0 - 2026-10-19

- **Security: the web preview no longer sends your sign-in to the sites it
  shows.** Behind a reverse proxy or tunnel that passes its basic-auth
  credentials on to Perch (a tunnel's `--forward-auth`), 0.2.0 forwarded them
  to every site opened in the web preview. If you used the web preview that
  way, change that password.
- **The web preview works behind a tunnel's basic auth.** With tunnel 0.5.0
  or newer and `--allow-cors-preflight` on the tunnel, previews load without
  asking for the password on every page: the page's own requests carry the
  tunnel's session cookie, and fonts load from their own host where it
  allows that. Perch refuses cross-origin preflights everywhere except the
  preview's own routes.
- **Unsaved edits survive.** An extension's unsaved edits are kept on the
  server, so a reload, a crash or an update doesn't lose them, and another
  device opening the same file gets them back. The CSV editor uses it, with a
  notice offering to discard and a warning when the file changed on disk.
  Extensions get it as `ctx.drafts`.
- **Terminals open faster.** Opening a terminal replays its recent output
  and says when earlier history was left out; scrolling to the top, a search
  or jumping to an earlier prompt loads the rest.
- **Git badges show in FILES for projects under your home folder.** Only the
  branch pill showed before.
- **Status bar popovers stay on screen** when their content grows after
  opening, as system stats' readings do.
- **`perch tui` finds a server that sets its port in `server/.env`,** such as
  over ssh, instead of falling back to port 3001.

## 0.2.0 - 2026-10-13

- **Preview any website inside Perch.** The PORTS tab is now a web preview
  with an address bar: local dev servers open as before, and any other site
  loads through the Perch server into a sandbox that can't reach the app.
  Sites you sign in to stay signed in across restarts (their cookies are
  kept on the server; clear them per site or in Settings), and private
  network addresses are refused unless you list them in Settings → Behavior.
  Open it from the command palette (*Web Preview: Open URL…*), from PORTS,
  or from terminal links.
- **Comment on a page for your agent.** In the web preview and the HTML
  preview, pick an element, several (Shift+click), an area (drag) or
  selected text, and write what should change. Each comment carries a
  screenshot with the subject outlined and, if you like, the errors the page
  logged. Send them all at once with *Send & Submit* or *Send Only*.
- **Viewports.** Preview at phone, tablet and desktop sizes or a custom one,
  and compare two side by side with an adjustable split; a comment can cover
  one viewport, both, or say you're not sure.
- **Comments stay put.** Badges sit where you clicked and follow the page as
  it scrolls, clicking a comment in the list scrolls to it, and pending
  comments survive a reload.
- **Check Fixes.** Sent comments move to a Sent list; once the agent has
  worked on them, Check Fixes reloads the page and shows before and after
  side by side, so you can mark each fixed or send it back.
- **Terminal links can open in Perch.** Turn on *Open terminal links in a web
  preview tab* in Settings → Behavior; Ctrl/Cmd+Shift+click opens a link the
  other way.
- **The preview comment UI follows your colour theme,** using its button and
  input colours.
- **Extensions:** `ctx.registerUrlHandler` lets an extension open web links
  inside the app (see docs/EXTENSION_API.md).

## 0.1.3 - 2026-10-12

- **The Linux and macOS installer works again.** A fresh install with
  `curl ... install.sh | bash` stopped with `SyntaxError: Unexpected token
  '.'` before installing anything, because the shell mangled the small
  script that picks the newest release. Existing installs and `perch update`
  were not affected, and neither was the Windows installer.

## 0.1.2 - 2026-10-09

- **Exiting a terminal closes only its tab.** Typing `exit` in one of a
  project's terminals also closed every other tab of that project; now only
  its own tab closes.
- **Background dev servers show up in Ports again** when Perch runs as a
  systemd user service. A dev server started with `&` or `nohup` from a shell
  that has since exited (or by an agent) was hidden as part of Perch itself;
  it's now listed under the project that started it, and the tunnel forwards
  it.

## 0.1.1 - 2026-10-08

- **The Mac app can update itself.** macOS builds now include the signed
  update bundle, which 0.1.0 left out, so the Mac app finds and installs
  new releases like the Windows and Linux ones do.
- **perch tui:** `q` closes the Ports box, as it quits from the list; keys
  typed after it no longer run as box actions. A port's link is underlined
  across the URL only, not to the box's edge.
- **README:** screenshots of the current app, including `perch tui`.

## 0.1.0 - 2026-10-08

The first release of Perch: a self-hosted workspace for terminals in the
browser, built on its own terminal daemon.

- **Terminals that outlive everything.** perch-mux keeps sessions and their
  windows running when the browser, the server or the machine restarts, and
  brings them back after a reboot.
- **A VS Code-style workspace.** Projects as folders, tabs and tab groups,
  split editor groups, a quick switcher and command palette, a files tree,
  source control, search, a bottom panel with terminals, ports, output and
  agents, and a mobile layout with a customizable touch key bar.
- **Ports.** A built-in port proxy and a one-line tunnel CLI that forwards
  every port listening in your terminals to your own machine.
- **Extensions.** A documented extension API, a registry, and bundled
  extensions for git, search, previews, ports and more.
- **The perch CLI.** Install, start, update and diagnose an install, open
  folders and files from a terminal, manage extensions and share settings.
- **perch tui.** Projects and terminals in a terminal UI, without a browser:
  attach full screen, open projects by browsing folders, and a Ports box with
  the tunnel command, forwarded links, and go-to-terminal and kill actions.
- **Links open in your own browser.** A tunnel started from a copied command
  opens the links the server sends it, from the TUI or from programs on the
  server, in the browser on your machine.
- **A desktop app** for macOS, Windows and Linux that runs or connects to
  servers, updates itself, and shows each server's version.
- **Versions and updates.** One version across the server, web app and
  desktop app, update notices, and `perch update` following releases.
