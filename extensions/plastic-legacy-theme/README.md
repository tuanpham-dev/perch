# Plastic Legacy

Perch's default dark color theme — extracted from the app's own original hardcoded palette, so picking it (or never touching Settings → UI → Color theme at all) looks pixel-identical to every earlier version of the app.

## Contributes

- **Color theme:** Plastic Legacy — a dark theme covering the editor, terminal ANSI palette, sidebar, tabs, git-status colors, and syntax highlighting (`tokenColors`) for any extension that tokenizes code against the active theme (e.g. `text-editor`).

## Source

Based on [hadialqattan/plastic-legacy](https://github.com/hadialqattan/plastic-legacy), MIT-licensed — see `LICENSE.txt`. Both `colors` and `tokenColors` are carried over from the upstream `themes/main.json`; earlier versions of this extension only ported `colors`, which made syntax highlighting flat for any consumer that reads the theme's `tokenColors` (there was none, until `text-editor` added real TextMate tokenization).

## Notes

Bundled with Perch as the default theme; pick a different one from Settings → UI → Color theme (once another theme extension is installed).
