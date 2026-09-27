// Pure model for the bottom panel's view tabs (plans/bottom-panel-views.md):
// which views the header lists, in what order, and which stored id still
// names one of them. No React, no registry access — BottomPanel and App turn
// this into tabs.
//
// TERMINAL is always first and never contributed; OUTPUT is core's own second
// view; everything after comes from extensions (registerPanelView), sorted
// the way status bar items are so activation order can't reshuffle the row.

export const TERMINAL_VIEW_ID = "terminal";
export const OUTPUT_VIEW_ID = "core.output";

export interface PanelViewDescriptor {
  id: string;
  title: string;
  // A codicon name.
  icon: string;
  order: number;
}

export const TERMINAL_VIEW: PanelViewDescriptor = {
  id: TERMINAL_VIEW_ID,
  title: "Terminal",
  icon: "terminal",
  order: 0,
};

export const OUTPUT_VIEW: PanelViewDescriptor = {
  id: OUTPUT_VIEW_ID,
  title: "Output",
  icon: "output",
  order: 0,
};

export function orderPanelViews(
  extViews: readonly PanelViewDescriptor[],
  includeOutput = true,
): PanelViewDescriptor[] {
  const ext = [...extViews].sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
  return includeOutput ? [TERMINAL_VIEW, OUTPUT_VIEW, ...ext] : [TERMINAL_VIEW, ...ext];
}

// A stored view id survives only while something still renders it: an
// extension view whose extension was disabled falls back to TERMINAL.
export function resolveActiveView(
  stored: string | null | undefined,
  views: readonly PanelViewDescriptor[],
): string {
  if (typeof stored === "string" && views.some((v) => v.id === stored)) return stored;
  return TERMINAL_VIEW_ID;
}
