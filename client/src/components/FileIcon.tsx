import type { IconResult } from "../utils/iconThemes";

// A font-glyph icon (Seti, most VS Code icon themes) or an SVG one
// (Material Icon Theme) — className carries the shared box sizing from
// styles.css, this only supplies what differs per icon. "none" (no icon
// theme selected, or a theme with no icon for this name) renders nothing at
// all rather than an empty spacer — .file-tree-row's flex `gap` then closes
// up on its own, so the name sits right after the chevron instead of
// leaving a blank icon-sized gutter.
export default function FileIcon({ className, result }: { className: string; result: IconResult }) {
  if (result.kind === "svg") {
    return <img className={className} src={result.url} alt="" />;
  }
  if (result.kind === "font") {
    return (
      <span className={className} style={{ color: result.color, fontFamily: result.fontFamily }}>
        {/* A left-aligned 1em box of its own, so the glyph is placed by that
            box instead of its advance width: Seti's PowerShell glyph advances
            0, and centred (the icon classes' text-align) it drew over the file
            name. VS Code's icon label places glyphs the same way. */}
        <span style={{ display: "inline-block", width: "1em", textAlign: "left" }}>{result.char}</span>
      </span>
    );
  }
  return null;
}
