// Opens the "Send to agents" composer (components/AgentComposer.tsx) from
// anywhere: TerminalView's "Send Selection to Agent…" menu item, rendered in
// tabs, grid cells and the bottom panel alike, calls openComposer; App owns
// the composer's state and registers the handler. A module-level seam rather
// than a prop threaded through every TerminalView render site.
export type ComposerRequest = {
  text: string;
  // The terminal the text came from, as its attach name; App resolves it to
  // a session and window. Absent for an empty composer from the palette.
  attachName?: string;
};

let handler: ((req: ComposerRequest) => void) | null = null;

export function setComposerHandler(fn: ((req: ComposerRequest) => void) | null): void {
  handler = fn;
}

export function openComposer(req: ComposerRequest): void {
  handler?.(req);
}
