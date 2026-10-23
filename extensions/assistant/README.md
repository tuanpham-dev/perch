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

## Settings

- **Read-only** (`assistant.readOnly`): offer only the reading and on-screen tools. The rest are hidden from the MCP client and refused if called.

## Notes

Claude Code asks before each tool call unless you allow it; `kill_session` and `remove_worktree` are marked destructive. The port forward command can carry your browser's auth header, like the Ports panel's Copy.

Bundled with Perch. The protocol side lives in the CLI (`cli/perch/mcp.ts`, using `@modelcontextprotocol/sdk`); this extension owns every tool's name, schema and behavior.
