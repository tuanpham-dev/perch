# Live Preview

A live-reloading HTML preview tab — edit an `.html` file in a terminal (or any editor) and watch the preview refresh automatically.

## Contributes

- **File viewer:** `.html`/`.htm` files open as a rendered preview (from the FILES tree's hover icon or "Preview" context-menu item; a plain click still opens the editor) alongside a small server-side watcher for the file and the assets it loads (CSS/JS/images/fetched data, subfolders included).

## Settings

- **Auto-refresh** (`livePreview.autoRefresh`, default on) — reload the preview automatically when the HTML file or anything it loaded changes. Other files in the folder can change without reloading the page (and losing its state).
- **Poll interval** (`livePreview.pollInterval`, default 1000ms) — how often those files are checked for changes when auto-refresh is on.
- **Auto-submit picked elements** (`livePreview.sendAutoSubmit`, default off) — the preview's element picker sends a picked element's context to an agent pane; off types it in for you to review before pressing Enter, on submits it immediately.

## Notes

Bundled with Perch. The preview renders in a sandboxed frame — scripts in the previewed page run, but can't reach the rest of the app.
