// Copied from client/src/components/FileIcon.tsx — see extensions/_shared's
// module comment on why this is a copy, not a shared runtime import. The
// IconResult shape below must stay structurally identical to the host's
// client/src/utils/iconThemes.ts IconResult, since ctx.app.getFileIcon/
// getFolderIcon (client/src/extensions.ts) return exactly that type.
export type IconResult =
  | { kind: "font"; char: string; color: string; fontFamily: string }
  | { kind: "svg"; url: string }
  | { kind: "none" };

// A font-glyph icon (Seti, most VS Code icon themes) or an SVG one
// (Material Icon Theme) — className carries the shared box sizing from
// styles.css, this only supplies what differs per icon. "none" (no icon
// theme selected, or a theme with no icon for this name) renders nothing at
// all rather than an empty spacer — the row's own flex `gap` then closes up
// on its own, so the name sits right after the chevron instead of leaving a
// blank icon-sized gutter.
export default function FileIcon({ className, result }: { className: string; result: IconResult }) {
  if (result.kind === "svg") {
    return <img className={className} src={result.url} alt="" />;
  }
  if (result.kind === "font") {
    return (
      <span className={className} style={{ color: result.color, fontFamily: result.fontFamily }}>
        {result.char}
      </span>
    );
  }
  return null;
}
