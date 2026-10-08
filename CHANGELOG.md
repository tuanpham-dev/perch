# Changelog

What changed in each Perch release. The newest is first; each entry is
drafted from the commit subjects by `npm run release`, then edited.

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
