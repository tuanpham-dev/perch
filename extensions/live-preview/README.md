# Live Preview

A live-reloading HTML preview tab — edit an `.html` file in a terminal (or any editor) and watch the preview refresh automatically.

## Contributes

- **File viewer:** `.html` files open as a rendered preview alongside a small server-side watcher for the file and its sibling assets (CSS/JS/images in the same folder).

## Settings

- **Auto-refresh** (`livePreview.autoRefresh`, default on) — reload the preview automatically when the HTML file or a sibling file changes.
- **Poll interval** (`livePreview.pollInterval`, default 1000ms) — how often the previewed folder is checked for changes when auto-refresh is on.

## Notes

Bundled with Perch. The preview renders in a sandboxed frame — scripts in the previewed page run, but can't reach the rest of the app.
