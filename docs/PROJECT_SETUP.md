# Project setup file

A project can say which terminals it wants: put a `.perch/project.json` in the project folder and commit it, and anyone who opens the folder in Perch is offered those terminals, each running its command.

```json
{
  "terminals": [
    { "name": "dev",    "command": "shopify theme dev --store acme" },
    { "name": "claude", "command": "claude" },
    { "name": "tests",  "command": "npm run test -- --watch", "cwd": "tests" },
    { "name": "shell" }
  ],
  "grid": true
}
```

| Field | Meaning |
| --- | --- |
| `terminals` | The terminals to open, in order. Up to 24. |
| `terminals[].name` | Required. The terminal's name; names must be unique. A terminal of that name already open in the project is reused rather than opened twice. |
| `terminals[].command` | Optional. One line, typed into the terminal's shell when it opens, and again whenever Perch restores the terminal after a restart. Omit it for a plain shell. |
| `terminals[].cwd` | Optional. A folder inside the project, relative to it. Defaults to the project folder. A path that leads outside the project is refused. |
| `grid` | Optional. `true` opens the terminals together in one grid tab. |

## When it's offered

When opening a folder starts a new session and the folder has this file:

- **The first time**, or **when the file has changed** since you last opened it, Perch shows every terminal's name, folder and exact command before running anything, with **Open Terminals**, **Not Now** and **Never for This Folder**. The commands come from the repository, so only open them if you trust it.
- **When the file is unchanged** since you approved it, a small notice offers **Open** in one click instead.
- **Never for This Folder** stops the offers. Settings → Behavior → *Terminal setup files never offered* lists those folders, with Remove to undo it.

Approval is tied to the file's exact contents, so any edit to it, by you or anyone else, brings the full review back. Approvals are kept on the Perch server, so they're the same in every browser, and they aren't part of an exported settings bundle.

A file that isn't valid JSON or doesn't follow the format opens nothing; Perch says what's wrong and where.

## Commands

- **Project: Open Terminal Setup** opens the active project's setup at any time. It shows the review when the file is new or changed, and also undoes a *Never for This Folder*.
- **Project: Save Terminal Setup** writes the project's current terminals into `.perch/project.json`: their names, folders, and the commands they were started with. It shows the file before writing and asks before replacing one. A file you saved this way counts as approved.
