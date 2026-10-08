# The terminal UI

`perch tui` lets you use Perch's projects and terminals from any terminal,
with no browser. It shows the same projects as the web app's PROJECTS panel.
Pick a terminal, press `Enter`, and it fills your screen; press the detach key
twice to come back to the list. Terminals keep running whether or not anything
is attached to them, and the browser keeps showing them too.

```
 Perch · 127.0.0.1:3001                                              ? help
 ──────────────────────────────────────────────────────────────────────────
 ▾ perch            ~/works/perch                                        ★
     0  zsh         zsh
     1  claude      claude                                             ●
 ▸ scratch          ~                                       3 terminals
   shop-theme       ~/works/shop-theme                    not running ★
 ──────────────────────────────────────────────────────────────────────────
  ⏎ attach  n new  r rename  x kill  o open  p pin  / filter  q quit
```

- A project row is a live session, with its terminals beneath it.
- ★ marks a pinned project. A pinned project with no session still shows,
  dimmed, as "not running".
- ● means the terminal printed something while nobody was looking at it.
- A collapsed project (▸) shows how many terminals it has.

## Starting it

```bash
perch tui
```

It needs a Perch server to be running (`perch start`). It finds the server the
same way `perch open` does:

1. `--port <n>` if you give it.
2. `$PERCH_PORT`, which every Perch terminal sets, so inside one it talks to
   its own instance.
3. Otherwise the only running instance, or a prompt asking which one if
   several are running.

### Another machine

```bash
perch tui --url https://perch.example.com --token <token>
```

`--url` takes any `http://` or `https://` address. The token is only needed
when that server has `AUTH_TOKEN` set; without `--token` it uses the
`AUTH_TOKEN` environment variable, then `AUTH_TOKEN` in `server/.env`.

## Keys

| Key | What it does |
|---|---|
| `↑` `↓` or `j` `k` | Move. `g` / `G` jump to the first / last row; `PgUp` / `PgDn` page |
| `←` `→` | Collapse / expand a project. `←` on a terminal jumps to its project |
| `Enter` | Attach (see below) |
| `n` | New terminal in the selected project's folder, attached right away |
| `r` | Rename the selected terminal, or the project's session on a project row |
| `x` | Kill the selected terminal, or the whole project session. Asks first: only `y` kills |
| `o` | Open a project (see below) |
| `p` | Pin or unpin the selected project |
| `/` | Filter by name, command or path. `Enter` keeps the filter, `Esc` clears it |
| `?` | Show the keys |
| `q` or `Ctrl-C` | Quit |

In prompts (rename, filter, open), `Backspace` deletes, `Ctrl-U` clears the
line and `Esc` cancels.

## Attaching

`Enter` does different things depending on the row:

- **A terminal:** attaches to exactly that terminal. Switching windows in the
  browser doesn't move you.
- **A live project:** attaches to the project's current terminal and follows
  it when the current terminal changes (from the browser, say).
- **A pinned project that isn't running:** starts a session in that folder,
  then attaches to it.

While attached, every key goes to the terminal, including `Ctrl-C` and `q`.
The list's footer shows the detach key, so check it before you attach.

**To come back to the list, press the detach key twice:** `Ctrl-\` `Ctrl-\` by
default. A single `Ctrl-\` followed by anything else is passed through to the
program as usual. If the terminal exits (you type `exit`) or the server goes
away, you're returned to the list with a message saying so.

The detach key is the terminal daemon's `detachKey` setting, the same one
`perch attach` uses. To use another key for one run:

```bash
perch tui --detach-key C-]
```

### Window size

The terminal you attach to is resized to fit your window, and follows it when
you resize. This is the same as clicking into it in a second browser tab: a
browser showing the same terminal reflows to the new size until you click
back into it there.

### The terminal it runs in

When you run `perch tui` inside a Perch terminal, that terminal is in the
list too, labeled "this terminal - perch tui runs here". It can't be
attached to: the TUI would be watching itself, and every frame it drew would
come straight back as new output. `Enter` on it shows a message instead. The
same goes for a project whose current terminal is that one. If it's just one
of the project's terminals, `Enter` attaches to the current terminal and
stays there.

## Opening a project

`o` opens a picker for finding a folder to open as a project. It starts at
your home folder (`~/` on the server) and lists two things under the path
field:

- **Recent projects**, newest first, narrowed to those whose path contains
  what you typed. Pinned ones have a star.
- **Folders in** the folder you've typed, narrowed to names that start with
  the last part of the path. Typing `/works/pe` lists the folders in `/works/`
  whose names start with `pe`. Hidden folders appear once you type a `.`.

Browse with these keys:

| Key | What it does |
|---|---|
| Type | Edit the path. Typing `/` first replaces the `~/` it starts with |
| `↑` `↓`, `PgUp` `PgDn` | Pick a recent project or folder |
| `Tab` or `→` | Go into the highlighted folder. With nothing highlighted, `Tab` goes into the only matching folder, or completes as far as the matches agree |
| `←` | Go up to the parent folder |
| `Backspace`, `Ctrl-W`, `Ctrl-U` | Delete a character, the last folder, or everything |
| `Enter` | Open the highlighted item, or the typed path if nothing is highlighted |
| `Esc` | Close the picker |

Opening a folder attaches you to the session already running there, or
starts one in that folder, named after it. Either way the folder goes to the
top of recents, the same list as the web app's recent-projects button. A path
that isn't a folder shows an error, and the picker stays open.

## Pins and the web app

Pins and recents are stored on the server, so the TUI and the web app share
them. A pin you make in the TUI shows up in an open browser tab the next time
you switch to that tab.

## Troubleshooting

**The screen fills with random characters, or a shell prints escape codes.**
Something wrote terminal control codes where a shell was reading. Type `reset`
and press `Enter` (even if you can't see what you type). If a `perch tui` is
stuck, end it from another terminal:

```bash
pkill -f 'bin/perch tui'
```

**"needs a terminal".** `perch tui` must run in an interactive terminal, not
with its input or output piped.

**"couldn't reach the server".** Start it with `perch start`, or check
`--port` / `--url`.

**"this server has AUTH_TOKEN set".** Pass the server's token with `--token`.

**"Terminal too small".** The list needs at least 40 columns by 10 rows.

## Limits

- Linux and macOS. Windows should work in Windows Terminal but is untested.
- Two TUIs attached to each other's terminals would echo into each other.
  Don't attach a TUI to a terminal where another TUI is attached back to
  yours.
- Names with wide characters (CJK, emoji) can be truncated a column early.
