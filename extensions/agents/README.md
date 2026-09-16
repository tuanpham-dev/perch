# Agents

The two agent CLIs the app assumes most people have: **Claude Code** and
**OpenAI Codex**. It contributes them through `contributes.agents`, which is the
only way an agent reaches the registry - core itself ships none.

Uninstall this and Settings → AI Providers is empty: nothing is detected as an agent,
and "Start work" offers nothing to launch. That is the architecture working, not
a fault.

## What an entry supplies

| Field | What it answers |
| --- | --- |
| `program` | what the terminal reports as a window's foreground command, so a window can be recognised as this agent |
| `command` | the line that starts it, for "Start work" and new worktree sessions |
| `skipPermissionsArgs` | what to append for its no-prompts mode. Codex does not spell it like Claude |
| `hooks` | where and how core writes this agent's hook config, so the app can show working / waiting / done |

## Codex needs its hooks trusted

Codex refuses to run a hook whose handler is not trusted in
`~/.codex/config.toml`, and it does so **silently** - no warning, nothing in the
log, the hook simply never fires. Installing Codex hooks therefore writes two
files: `hooks.json`, and a trust block per handler in `config.toml`:

```toml
[hooks.state."<abs path to hooks.json>:<event_label>:<group>:<handler>"]
enabled = true
trusted_hash = "sha256:<hex>"
```

`server.js` computes those. The hash covers the handler as codex normalises it,
with every object's keys sorted; the event label is snake_case even though the
key in `hooks.json` is PascalCase. Verified against codex-cli 0.146.1 on
2026-09-11: with the block absent no hook fires at all, with it present they
fire - including on a run that fails to authenticate, so this has nothing to do
with quota or login.

## Adding another agent

Write another extension with its own `contributes.agents`. Nothing here is
privileged; this extension is ordinary and bundled only so the common case works
out of the box. See `docs/EXTENSION_API.md` for the descriptor, including the
flat-wrapper shape that CLIs like Antigravity's use.

## Agent marks

The images beside each agent are the products' own marks, used to identify the
product they name - the same nominative use a launcher or an IDE makes of them.
They are **not** this project's artwork and remain the trademarks of their
owners, so treat them as vendored third-party assets when redistributing.

| File | Agent | Source | License of the file |
| --- | --- | --- | --- |
| `claude.svg` | Claude Code | [Simple Icons](https://simpleicons.org/?q=claude), slug `claude` | CC0-1.0 (the icon file); the mark is Anthropic's trademark |
| `codex.svg` | OpenAI Codex | Wikimedia Commons, *OpenAI logo 2025 (symbol)* | Public domain per Commons; the mark is OpenAI's trademark |

`codex.svg` was edited in one way only: `fill="currentColor"` was added so the
monochrome mark follows the row's text colour instead of rendering black on a
dark theme.
