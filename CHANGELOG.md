# Changelog

What changed in each Perch release. The newest is first; each entry is
drafted from the commit subjects by `npm run release`, then edited.

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
