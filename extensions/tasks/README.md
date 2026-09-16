# Tasks

A TASKS section in the Run sidebar tab: every `package.json` script in the active directory's workspace, run in its own named terminal window.

## Contributes

- **Sidebar panel:** TASKS — packages grouped by workspace (the active directory's package highlighted), each script with its command, a running indicator, and click-to-run.

## Notes

Scripts run in a terminal window named `<script> [<package dir>]`, created with the workspace's package manager (detected from the lockfile: pnpm/yarn/bun, else npm). Re-running a script switches to its existing window when it's still running, and re-types the command into it when it has finished — so previous output stays in the scrollback. Only scripts declared in the target `package.json` are ever executed. Manually renaming a task window orphans the match: the next run opens a fresh window and leaves the renamed one alone.

Bundled with Perch. Unlike the other bundled extensions this one has a runtime dependency (`fast-glob`, used to expand `workspaces` globs); it is declared here and hoisted by the repo's root `npm install` because `extensions/*` are npm workspaces — a standalone `.perch` install of this extension would need its dependencies vendored into the package.
