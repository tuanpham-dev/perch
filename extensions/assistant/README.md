# Assistant

Perch as tools for Claude Code (or any MCP client), served by `perch mcp`.

## Setup

```sh
claude mcp add perch -- perch mcp
```

Run it once. `perch mcp` finds the instance like every other `perch` command: `--port`, then `$PERCH_PORT` (set in Perch's own terminals), then the one running instance.

## Tools

| Kind | Tools |
| --- | --- |
| Reading | `list_projects`, `agent_status`, `agent_conversation`, `read_terminal`, `list_ports`, `list_conversations`, `list_worktrees`, `list_commands`, `wait_for_agent` |
| On screen | `open_web_preview`, `open_file_preview`, `port_forward_command`, `run_command`, `focus_window` |
| Changes | `send_to_agent`, `create_session`, `create_window`, `create_worktree`, `resume_conversation`, `kill_session`, `remove_worktree` |

A project is a terminal session; a window is one terminal in it, named `project:index` or by its id (`$PERCH_WINDOW`). Tools that take a project or window also accept a path inside the project.

Agent status comes from the agent's hooks (Settings → AI Providers → Install hooks): **working** once a turn starts, **needs-input** at a permission prompt, **idle** when the turn ends, **unknown** until the first event after the server starts.

On-screen tools act in one Perch browser window: one showing the terminal Claude Code runs in, else the one focused last. Each leaves a short notice over the editor area, with Copy when there is text to take.

## Relay: agents on other machines

Join this Perch to a relay group and the tools reach the group's other machines (set it up in Settings → Assistant → Relay or with `perch relay`; see [docs/RELAY.md](../../docs/RELAY.md)). Two more tools are always listed on a Perch with the relay code, joined or not (`list_machines` says how to join until you do; `reply_to_agent` is hidden under Read-only):

| Tool | Does |
| --- | --- |
| `list_machines` | The group: name, whether it is this machine, online or last seen, verified or not, and what it accepts from others (off, read-only, read and send). |
| `reply_to_agent` | Types a reply into an agent on another machine: the one that last messaged this window, or any agent given as `to` (`machine/project:index`, as printed in the message). |

`list_projects`, `agent_status`, `agent_conversation`, `read_terminal`, `wait_for_agent` and `send_to_agent` take an optional `machine`, a name from `list_machines`; without it they act here. The other tools only work on this machine. A call that gets no answer fails after 30 seconds; `wait_for_agent` waits its own limit (default 120 s, at most 600 s) plus 30 s.

Text sent to another machine is typed only into a window where an AI agent is running, as one prompt that names the sending machine and says it comes from another agent, not the user. Anything else is refused.

**Others may** controls what other machines may do here, and is kept with the group, not in the settings file: **Off** refuses every call, **Read-only** allows reading but not `send_to_agent` or `reply_to_agent`, **Read and send** (the default on joining) allows both. A change applies to the next call. The Relay section lists what other machines did here, newest first, with no text or results.

## Settings

- **Read-only** (`assistant.readOnly`): offer only the reading and on-screen tools. The rest are hidden from the MCP client and refused if called. This includes `reply_to_agent`, and it also stops other machines from typing into agents here, whatever **Others may** says.

## Notes

Claude Code asks before each tool call unless you allow it; `kill_session` and `remove_worktree` are marked destructive. The port forward command can carry your browser's auth header, like the Ports panel's Copy.

Bundled with Perch. The protocol side lives in the CLI (`cli/perch/mcp.ts`, using `@modelcontextprotocol/sdk`); this extension owns every tool's name, schema and behavior.
