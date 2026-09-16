// esbuild emits a sibling dist/client.css when an extension's entry imports
// CSS (see ../build.mjs) but never auto-links it — call this once from
// activate() to add it to <head>. A no-op ctx.assetUrl check isn't needed:
// this is only ever called by an extension whose build actually produced a
// CSS file.
function inject(assetUrl: (relPath: string) => string, relPath: string): { remove: () => void; ready: Promise<void> } {
  const link = document.createElement("link");
  link.rel = "stylesheet";
  link.href = assetUrl(relPath);
  // Never rejects/hangs: an `error` (bad path, offline) still resolves so a
  // caller awaiting readiness degrades to "proceed unstyled" rather than
  // stalling forever on a stylesheet that will never load.
  const ready = new Promise<void>((resolve) => {
    link.addEventListener("load", () => resolve(), { once: true });
    link.addEventListener("error", () => resolve(), { once: true });
  });
  document.head.appendChild(link);
  return { remove: () => link.remove(), ready };
}

// Returns a disposer — call it from the extension's deactivate() export so
// disabling the extension removes the stylesheet instead of leaving it in
// <head> for the rest of the page's life. Fire-and-forget: most callers
// only need the stylesheet applied *eventually*, not before anything else
// proceeds.
export function injectStylesheet(assetUrl: (relPath: string) => string, relPath: string): () => void {
  return inject(assetUrl, relPath).remove;
}

// Same as injectStylesheet, but also hands back a promise that resolves
// once the stylesheet has actually loaded (or failed) — for a caller whose
// DOM construction is visually sensitive to the CSS not being applied yet
// (e.g. xterm-engine's raw, unstyled <textarea> flashing before its own
// xterm.css hides/positions it, if the terminal mounts before the
// stylesheet's <link> has loaded).
export function injectStylesheetAndWait(
  assetUrl: (relPath: string) => string,
  relPath: string,
): { remove: () => void; ready: Promise<void> } {
  return inject(assetUrl, relPath);
}
