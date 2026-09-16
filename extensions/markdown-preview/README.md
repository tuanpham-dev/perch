# Markdown Preview

A rendered Markdown preview tab with GitHub-flavored formatting and syntax-highlighted code blocks.

## Contributes

- **File viewer:** `.md`/`.markdown` files render via [react-markdown](https://github.com/remarkjs/react-markdown) with GFM (tables, task lists, strikethrough), syntax highlighting for ~40 languages, heading anchors, and sanitized embedded HTML.

## Settings

- **Preview font size** (`markdown.previewFontSize`, default 14px) — font size for the rendered preview body.
- **Click action** (`markdown.clickAction`, default "edit") — what a FILES-tree click on a Markdown file opens: the editor, or the rendered preview. The other one stays behind the hover icon and context menu.

## Notes

Bundled with Perch — disable it from the Extensions view and Markdown files only ever open in the editor.
