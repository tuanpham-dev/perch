# Search

A VS Code-style SEARCH panel: search and replace across every file in the active folder.

## Contributes

- **Sidebar panel:** SEARCH — a query box with regex/case/whole-word toggles, a results tree grouped by file, inline replace, and "Find in Folder…" from the FILES tree's context menu.

## Settings

- **Max results** (`search.maxResults`, default 2000) — matches beyond this count are cut off from a single search.
- **Exclude globs** (`search.excludeGlobs`, default `node_modules,.git,dist,build`) — comma-separated directory/file globs excluded from search by default.

## Notes

Bundled with Perch.
