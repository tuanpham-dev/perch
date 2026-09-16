// Keybinding `when`-clause context, module-level like keybindings.ts'
// recorderState — App.tsx mirrors its own React state into this store via
// effects so the keydown dispatchers (a mount-once listener, not a
// component) can read current values without threading props through.
// The full v1 key list, with descriptions, lives in CONTEXT_KEYS below —
// it's also what the Keyboard Shortcuts editor's when-input autosuggest
// reads, so a key added there automatically appears in the dropdown.
const contextStore: Record<string, unknown> = {};

// terminalFocus is derived per-event from the keydown target (see
// getContextGetter), not the store — always fresh, never stale between a
// focus change and the next render. Every other key is mirrored into the
// store from React state by effects (App.tsx, Sidebar.tsx).
export const CONTEXT_KEYS: { key: string; description: string }[] = [
  { key: "terminalFocus", description: "A terminal has keyboard focus" },
  { key: "filesTreeFocus", description: "The FILES tree has keyboard focus" },
  { key: "projectsListFocus", description: "The PROJECTS list has keyboard focus" },
  { key: "panelFocus", description: "The bottom terminal panel holds keyboard focus" },
  { key: "sidebarVisible", description: "The sidebar is shown" },
  { key: "rightSidebarVisible", description: "The right sidebar is shown" },
  { key: "sidebarFocus", description: "Focus is currently within the sidebar" },
  { key: "quickSwitcherOpen", description: "The Quick Switcher overlay is open" },
  { key: "commandPaletteOpen", description: "The Quick Switcher was opened in \">\" command mode" },
  { key: "activeSession", description: "A real session tab is active" },
  { key: "activeWindow", description: "The active tab is pinned to a specific window" },
];

export function setContextKey(key: string, value: unknown): void {
  contextStore[key] = value;
}

// `e` is passed when called from a keydown handler so terminalFocus/
// filesTreeFocus reflect the actual event target rather than a possibly-stale
// store value.
export function getContextGetter(e?: KeyboardEvent): (key: string) => unknown {
  return (key: string) => {
    if (key === "terminalFocus" && e) {
      return (e.target as HTMLElement | null)?.closest(".terminal-host") != null;
    }
    if (key === "filesTreeFocus" && e) {
      return (e.target as HTMLElement | null)?.closest(".file-tree") != null;
    }
    if (key === "projectsListFocus" && e) {
      return (e.target as HTMLElement | null)?.closest(".session-list") != null;
    }
    return contextStore[key];
  };
}
