# Installing Perch

The managed install, and everything the `perch` command can do once it is on
your `PATH`. To run straight from a clone instead, see
[Development](DEVELOPMENT.md).

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

Clones to `%LOCALAPPDATA%\perch\app`, builds it, adds its `bin` folder to your user `PATH`, and adds a Task Scheduler task that starts Perch when you sign in (hidden, logging to `%LOCALAPPDATA%\perch\perch.log`). Needs Node 23+ and Git for Windows; no administrator rights. Terminals run PowerShell 7 (`pwsh`) when it's installed, else Windows PowerShell; pick another shell in Settings → Terminal Backend. Command history and prompt jumps work in those terminals out of the box (the shell integration is loaded automatically). Search works without ripgrep, but installing it (`winget install BurntSushi.ripgrep.MSVC`) makes it faster and adds full glob support.

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
| `perch ext <cmd>` | Install and manage extensions: `install`, `ls`, `uninstall`, `enable`, `disable` — see below |
| `perch settings <cmd>` | `export` your settings to a shareable file, or `import` one — see below |
| `perch ls` | List terminal sessions |
| `perch attach <session>` | Attach this terminal to a session (`work`) or one window (`work:1`); detach with `Ctrl+\` twice |
| `perch daemon status` / `stop` | The terminal daemon. Restarting or updating the server never touches it; `daemon stop` ends every terminal, and sessions come back the next time it starts |

Config (`PORT`, `AUTH_TOKEN`, `ALLOWED_HOSTS`, `NEW_SESSION_CWD`, `APP_NAME`, `PROXY_DOMAIN`, `EXTENSION_REGISTRY`) goes in `~/.local/share/perch/server/.env` — see [Deployment](DEPLOYMENT.md#production) for what each does. Without a service manager, `start`/`stop`/`restart` fall back to running the server in the background directly.

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

#### Extensions from the terminal

`perch ext install <target>` installs an extension, where the target is a registry entry's id, a path to a local `.perch` file, or an `https` URL to one:

```bash
perch ext install perch.github          # from a configured registry
perch ext install ./my-extension.perch  # from a file
perch ext ls                            # id, version, state, and where each came from
perch ext disable perch.github          # keeps it installed and its settings
perch ext uninstall perch.github
```

An id is resolved against the registries this instance has configured; if two of them offer the same id, `ext install` says so and asks you to pass a file instead rather than guessing.

These commands go through the running instance rather than writing `~/.config/perch` directly, so a newly installed extension's server hook starts working immediately with no restart. That does mean an instance has to be running (`perch start`), and on an `AUTH_TOKEN`-protected instance the CLI reads the token from `server/.env` or `$AUTH_TOKEN` — installing an extension runs its code as your user, so it stays behind the gate.

#### Sharing settings

`perch settings export` writes a bundle — preferences, keybindings, extension settings, the sidebar and status bar arrangement, registry sources, and the list of installed extensions with the registry each came from:

```bash
perch settings export my-setup.json     # or omit the file to write to stdout
perch settings import my-setup.json     # prints what would change, changes nothing
perch settings import my-setup.json --yes            # apply it and install its extensions
perch settings import my-setup.json --no-extensions  # apply the settings only
```

A bundle never contains API keys, extension credentials, project paths or command usage stats, so it is safe to hand to someone else. Importing **merges** over what you have: a setting the bundle does not mention keeps its current value. With neither `--yes` nor `--no-extensions`, `import` only reports — a settings import is not something to do by accident inside a script.

The same two actions are in the app under Settings, where the import shows a preview first and lists each extension with a checkbox. An extension with no recorded registry source (installed from a file, or before Perch tracked this) is listed but has to be installed by hand.
