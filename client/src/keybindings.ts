// Keybindings, VS Code-style: each command can have zero or more bindings, a
// binding is a single chord plus an optional `when` clause. A chord
// serializes to e.g. "ctrl+shift+KeyB": modifiers in fixed order (ctrl,
// shift, alt, meta), then the physical key's KeyboardEvent.code. e.code is
// used for ALL keys (letters, digits, punctuation, Tab, Enter…): it's
// keyboard-layout-stable, and named keys' codes match their key values on
// standard keyboards anyway. Multi-chord sequences (e.g. VS Code's Ctrl+K
// Ctrl+S) are out of scope — a chord-prefix state machine conflicts with a
// terminal app where Ctrl+K is a live shell key.
import { evaluateWhen } from "./whenClause";

export interface Keybinding {
  key: string;
  when?: string;
}

export interface Command {
  id: string;
  label: string;
  defaultBindings: Keybinding[];
  // Terminal-scoped commands are dispatched from the terminal's own key handler
  // in TerminalView; files-scoped commands are dispatched from the FILES tree's
  // own key handler in FileTree.tsx; sessions-scoped commands are dispatched
  // from ProjectList.tsx’s own key handler. None of these go through the
  // global window dispatcher (useGlobalKeybindings), which yields to all
  // three scopes instead.
  scope: "global" | "terminal" | "files" | "projects";
  // When-expression gating this command's *palette row* (not its keybinding
  // dispatch — a binding's own `when` on Keybinding does that). Evaluated
  // against context keys the same way a binding's when is; absent means
  // always enabled. VS Code calls this "enablement".
  enablement?: string;
}

export const COMMANDS: Command[] = [
  { id: "sidebar.toggle", label: "Toggle Sidebar", defaultBindings: [{ key: "ctrl+shift+KeyB" }], scope: "global" },
  // VS Code's secondary-sidebar chord. The right sidebar exists only once a
  // tab has been dragged there, so this is a no-op until then.
  { id: "sidebar.toggleRight", label: "Toggle Right Sidebar", defaultBindings: [{ key: "ctrl+alt+KeyB" }], scope: "global" },
  { id: "sidebar.focusExplorer", label: "Sidebar: Focus Explorer", defaultBindings: [{ key: "ctrl+shift+KeyE" }], scope: "global" },
  // Unbound by default: the Run tab is optional (it only exists while an
  // extension contributes a section), so it doesn't claim a chord.
  { id: "sidebar.focusRun", label: "Sidebar: Focus Run", defaultBindings: [], scope: "global" },
  { id: "sidebar.focusCommands", label: "Sidebar: Focus Commands", defaultBindings: [], scope: "global" },
  { id: "sidebar.focusExtensions", label: "Sidebar: Focus Extensions", defaultBindings: [{ key: "ctrl+shift+KeyX" }], scope: "global" },
  { id: "quickSwitcher.toggle", label: "Toggle Quick Switcher", defaultBindings: [{ key: "ctrl+KeyP" }], scope: "global" },
  { id: "commandPalette.toggle", label: "Show Command Palette", defaultBindings: [{ key: "ctrl+shift+KeyP" }], scope: "global" },
  { id: "quickSwitcher.selectNext", label: "Quick Switcher: Select Next Item", defaultBindings: [{ key: "alt+KeyJ", when: "quickSwitcherOpen" }], scope: "global" },
  { id: "quickSwitcher.selectPrevious", label: "Quick Switcher: Select Previous Item", defaultBindings: [{ key: "alt+KeyK", when: "quickSwitcherOpen" }], scope: "global" },
  { id: "tab.next", label: "Next Tab", defaultBindings: [{ key: "ctrl+Tab" }], scope: "global" },
  { id: "tab.previous", label: "Previous Tab", defaultBindings: [{ key: "ctrl+shift+Tab" }], scope: "global" },
  { id: "tab.close", label: "Close Tab", defaultBindings: [{ key: "ctrl+KeyW" }], scope: "global" },
  { id: "tab.closeOthers", label: "Tab: Close Others", defaultBindings: [], scope: "global" },
  { id: "tab.focus1", label: "Tab: Focus 1st Tab", defaultBindings: [{ key: "alt+Digit1" }], scope: "global" },
  { id: "tab.focus2", label: "Tab: Focus 2nd Tab", defaultBindings: [{ key: "alt+Digit2" }], scope: "global" },
  { id: "tab.focus3", label: "Tab: Focus 3rd Tab", defaultBindings: [{ key: "alt+Digit3" }], scope: "global" },
  { id: "tab.focus4", label: "Tab: Focus 4th Tab", defaultBindings: [{ key: "alt+Digit4" }], scope: "global" },
  { id: "tab.focus5", label: "Tab: Focus 5th Tab", defaultBindings: [{ key: "alt+Digit5" }], scope: "global" },
  { id: "tab.focus6", label: "Tab: Focus 6th Tab", defaultBindings: [{ key: "alt+Digit6" }], scope: "global" },
  { id: "tab.focus7", label: "Tab: Focus 7th Tab", defaultBindings: [{ key: "alt+Digit7" }], scope: "global" },
  { id: "tab.focus8", label: "Tab: Focus 8th Tab", defaultBindings: [{ key: "alt+Digit8" }], scope: "global" },
  { id: "tab.focus9", label: "Tab: Focus 9th Tab", defaultBindings: [{ key: "alt+Digit9" }], scope: "global" },
  { id: "tab.moveLeft", label: "Tab: Move Left", defaultBindings: [{ key: "ctrl+shift+PageUp" }], scope: "global" },
  { id: "tab.moveRight", label: "Tab: Move Right", defaultBindings: [{ key: "ctrl+shift+PageDown" }], scope: "global" },
  { id: "tab.reopenClosed", label: "Tab: Reopen Closed Tab", defaultBindings: [{ key: "shift+alt+KeyT" }], scope: "global" },
  { id: "split.right", label: "Split Editor Right", defaultBindings: [{ key: "ctrl+Backslash" }], scope: "global" },
  { id: "split.down", label: "Split Editor Down", defaultBindings: [], scope: "global" },
  { id: "split.left", label: "Split Editor Left", defaultBindings: [], scope: "global" },
  { id: "split.up", label: "Split Editor Up", defaultBindings: [], scope: "global" },
  { id: "group.focusNext", label: "Focus Next Editor Group", defaultBindings: [], scope: "global" },
  { id: "group.focusPrevious", label: "Focus Previous Editor Group", defaultBindings: [], scope: "global" },
  { id: "group.focus1", label: "Focus 1st Editor Group", defaultBindings: [{ key: "ctrl+Digit1" }], scope: "global" },
  { id: "group.focus2", label: "Focus 2nd Editor Group", defaultBindings: [{ key: "ctrl+Digit2" }], scope: "global" },
  { id: "group.focus3", label: "Focus 3rd Editor Group", defaultBindings: [{ key: "ctrl+Digit3" }], scope: "global" },
  { id: "group.focus4", label: "Focus 4th Editor Group", defaultBindings: [{ key: "ctrl+Digit4" }], scope: "global" },
  { id: "group.focus5", label: "Focus 5th Editor Group", defaultBindings: [{ key: "ctrl+Digit5" }], scope: "global" },
  { id: "group.focus6", label: "Focus 6th Editor Group", defaultBindings: [{ key: "ctrl+Digit6" }], scope: "global" },
  { id: "group.focus7", label: "Focus 7th Editor Group", defaultBindings: [{ key: "ctrl+Digit7" }], scope: "global" },
  { id: "group.focus8", label: "Focus 8th Editor Group", defaultBindings: [{ key: "ctrl+Digit8" }], scope: "global" },
  { id: "tab.moveToNextGroup", label: "Move Editor into Next Group", defaultBindings: [{ key: "ctrl+alt+ArrowRight" }], scope: "global" },
  { id: "tab.moveToPreviousGroup", label: "Move Editor into Previous Group", defaultBindings: [{ key: "ctrl+alt+ArrowLeft" }], scope: "global" },
  { id: "panel.toggle", label: "Panel: Toggle Terminal Panel", defaultBindings: [{ key: "ctrl+Backquote" }], scope: "global" },
  { id: "panel.new", label: "Panel: New Terminal", defaultBindings: [{ key: "ctrl+shift+Backquote" }], scope: "global" },
  { id: "panel.split", label: "Panel: Split Terminal Right", defaultBindings: [], scope: "global" },
  { id: "settings.open", label: "Open Settings", defaultBindings: [{ key: "ctrl+Comma" }], scope: "global" },
  { id: "settings.openKeyboardShortcuts", label: "Preferences: Open Keyboard Shortcuts", defaultBindings: [], scope: "global" },
  { id: "session.new", label: "Project: New…", defaultBindings: [], scope: "global" },
  { id: "session.kill", label: "Project: Close Current", defaultBindings: [], scope: "global", enablement: "activeSession" },
  { id: "session.togglePin", label: "Session: Pin/Unpin Current", defaultBindings: [], scope: "global", enablement: "activeSession" },
  { id: "window.new", label: "Terminal: New", defaultBindings: [], scope: "global", enablement: "activeSession" },
  { id: "window.kill", label: "Terminal: Close Current", defaultBindings: [], scope: "global", enablement: "activeSession && activeWindow" },
  { id: "window.rename", label: "Terminal: Rename Current…", defaultBindings: [], scope: "global", enablement: "activeSession && activeWindow" },
  { id: "terminal.copy", label: "Terminal: Copy Selection", defaultBindings: [{ key: "ctrl+shift+KeyC", when: "terminalFocus" }], scope: "terminal" },
  // Paragraph mode for ONE copy, whatever settings.copySelection is — the
  // right-click menu shows this binding on its own "Copy as Paragraph" row.
  { id: "terminal.copyAsParagraph", label: "Terminal: Copy Selection as Paragraph", defaultBindings: [{ key: "ctrl+shift+alt+KeyC", when: "terminalFocus" }], scope: "terminal" },
  { id: "terminal.find", label: "Terminal: Find", defaultBindings: [{ key: "ctrl+shift+KeyF", when: "terminalFocus" }], scope: "terminal" },
  { id: "terminal.newline", label: "Terminal: Insert Newline", defaultBindings: [{ key: "shift+Enter", when: "terminalFocus" }], scope: "terminal" },
  { id: "terminal.fontSizeIncrease", label: "Terminal: Increase Font Size", defaultBindings: [{ key: "ctrl+Equal" }], scope: "global" },
  { id: "terminal.fontSizeDecrease", label: "Terminal: Decrease Font Size", defaultBindings: [{ key: "ctrl+Minus" }], scope: "global" },
  { id: "terminal.fontSizeReset", label: "Terminal: Reset Font Size", defaultBindings: [{ key: "ctrl+Digit0" }], scope: "global" },
  { id: "terminal.clear", label: "Terminal: Clear Scrollback", defaultBindings: [], scope: "terminal" },
  { id: "terminal.scrollToBottom", label: "Terminal: Scroll to Bottom", defaultBindings: [], scope: "terminal" },
  // Prompt jumps ride the shell integration's OSC 133 prompt marks (plans/warp-features.md) —
  // no-ops until the shell-integration snippet is sourced.
  { id: "terminal.previousCommand", label: "Terminal: Jump to Previous Command", defaultBindings: [{ key: "ctrl+alt+ArrowUp", when: "terminalFocus" }], scope: "terminal" },
  { id: "terminal.nextCommand", label: "Terminal: Jump to Next Command", defaultBindings: [{ key: "ctrl+alt+ArrowDown", when: "terminalFocus" }], scope: "terminal" },
  { id: "files.copy", label: "Files: Copy", defaultBindings: [{ key: "ctrl+KeyC", when: "filesTreeFocus" }], scope: "files" },
  { id: "files.cut", label: "Files: Cut", defaultBindings: [{ key: "ctrl+KeyX", when: "filesTreeFocus" }], scope: "files" },
  { id: "files.paste", label: "Files: Paste", defaultBindings: [{ key: "ctrl+KeyV", when: "filesTreeFocus" }], scope: "files" },
  { id: "files.delete", label: "Files: Delete", defaultBindings: [{ key: "Delete", when: "filesTreeFocus" }], scope: "files" },
  { id: "files.rename", label: "Files: Rename…", defaultBindings: [{ key: "F2", when: "filesTreeFocus" }], scope: "files" },
  // Filename search *inside* the FILES tree — distinct from files.findInFolder
  // below, which hands a glob to the SEARCH panel's content search.
  { id: "files.search", label: "Files: Search Files…", defaultBindings: [{ key: "ctrl+KeyF", when: "filesTreeFocus" }], scope: "files" },
  { id: "files.findInFolder", label: "Files: Find in Folder…", defaultBindings: [], scope: "files" },
  { id: "files.newFile", label: "Files: New File…", defaultBindings: [], scope: "files" },
  { id: "files.newFolder", label: "Files: New Folder…", defaultBindings: [], scope: "files" },
  { id: "files.copyPath", label: "Files: Copy Path", defaultBindings: [], scope: "files" },
  { id: "files.copyRelativePath", label: "Files: Copy Relative Path", defaultBindings: [], scope: "files" },
  { id: "projects.kill", label: "Projects: Close Focused", defaultBindings: [{ key: "Delete", when: "projectsListFocus" }], scope: "projects" },
  { id: "projects.rename", label: "Projects: Rename Focused Terminal…", defaultBindings: [{ key: "F2", when: "projectsListFocus" }], scope: "projects" },
  { id: "projects.newWindow", label: "Projects: New Terminal in Focused Project", defaultBindings: [], scope: "projects" },
  { id: "projects.togglePin", label: "Projects: Pin/Unpin Focused Project", defaultBindings: [], scope: "projects" },
  { id: "sidebar.focusProjects", label: "Sidebar: Focus Projects", defaultBindings: [], scope: "global" },
];

// Overrides only (command id → its full replacement binding set, [] meaning
// explicitly unbound); resolveBindings() merges over defaults. A command
// with no entry here keeps tracking future defaultBindings changes — the
// sparse-override philosophy predates multi-binding support and still
// holds, just one level up (whole binding lists, not single combos).
// Persisted via settings.ts and the server settings doc.
export type KeybindingOverrides = Record<string, Keybinding[]>;

// extraCommands is the extension command registry (extensions.ts) — kept as
// a parameter rather than imported directly so this module (loaded at
// startup, before extension activation) has no dependency on it.
export function resolveBindings(
  overrides: KeybindingOverrides,
  extraCommands: Command[] = [],
): Record<string, Keybinding[]> {
  const map: Record<string, Keybinding[]> = {};
  for (const cmd of [...COMMANDS, ...extraCommands]) {
    map[cmd.id] = overrides[cmd.id] ?? cmd.defaultBindings ?? [];
  }
  return map;
}

function isKeybinding(value: unknown): value is Keybinding {
  if (typeof value !== "object" || value === null) return false;
  const b = value as Record<string, unknown>;
  if (typeof b.key !== "string") return false;
  return b.when === undefined || typeof b.when === "string";
}

// Migrates the pre-multi-binding override shape (command id → single combo
// string, "" meaning explicitly unbound) to the current Keybinding[] shape.
// Both localStorage and the server settings doc may still hold the old
// shape from before this landed. Anything else malformed is dropped, same
// as the old string-only loader's tolerant-parse behavior.
// Command ids that moved when their feature was extracted into a bundled
// extension — a user's stored override for the old id carries over to the
// extension's namespaced command so their custom binding keeps working.
const RENAMED_COMMAND_IDS: Record<string, string> = {
  "sidebar.focusPorts": "ext.perch.ports.ports.focus",
  // The SESSIONS pane became the PROJECTS pane (plans/projects-not-sessions.md)
  // — pane-scoped ids and its focus command renamed with it.
  "sessions.kill": "projects.kill",
  "sessions.rename": "projects.rename",
  "sessions.newWindow": "projects.newWindow",
  "sessions.togglePin": "projects.togglePin",
  "sidebar.focusSessions": "sidebar.focusProjects",
};

// Context keys renamed alongside the commands above — a stored override's
// custom `when` clause keeps evaluating against the live key.
const RENAMED_CONTEXT_KEYS: Record<string, string> = {
  sessionsListFocus: "projectsListFocus",
};

function migrateWhen(binding: Keybinding): Keybinding {
  if (!binding.when) return binding;
  let when = binding.when;
  for (const [from, to] of Object.entries(RENAMED_CONTEXT_KEYS)) {
    when = when.replace(new RegExp(`\\b${from}\\b`, "g"), to);
  }
  return when === binding.when ? binding : { ...binding, when };
}

export function migrateKeybindingOverrides(raw: unknown): KeybindingOverrides {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return {};
  const result: KeybindingOverrides = {};
  for (const [id, value] of Object.entries(raw as Record<string, unknown>)) {
    const targetId = RENAMED_COMMAND_IDS[id] ?? id;
    if (typeof value === "string") {
      result[targetId] = value === "" ? [] : [{ key: value }];
    } else if (Array.isArray(value) && value.every(isKeybinding)) {
      result[targetId] = value.map(migrateWhen);
    }
  }
  return result;
}

// The first binding in `bindings` whose key matches `combo` and whose `when`
// (if any) evaluates true against `get` — or undefined if none match.
export function findMatchingBinding(
  bindings: Keybinding[] | undefined,
  combo: string,
  get: (key: string) => unknown,
): Keybinding | undefined {
  return bindings?.find((b) => b.key === combo && (!b.when || evaluateWhen(b.when, get)));
}

export function bindingMatches(
  bindings: Keybinding[] | undefined,
  combo: string,
  get: (key: string) => unknown,
): boolean {
  return findMatchingBinding(bindings, combo, get) !== undefined;
}

export interface BindingMatch {
  commandId: string;
  binding: Keybinding;
  overridden: boolean;
}

// Dispatch precedence when more than one command's binding matches the same
// combo: a user-overridden binding beats a still-default one (a deliberate
// customization wins over an incidental collision with someone else's
// default), then a binding with a `when` clause beats a bare one (more
// specific wins), otherwise the first candidate wins — callers pass
// candidates in COMMANDS/extraCommands order, so this is the original
// registration order as a final tiebreak.
export function pickCommand(candidates: BindingMatch[]): string | null {
  if (candidates.length === 0) return null;
  let best = candidates[0];
  for (const c of candidates) {
    if (c === best) continue;
    if (c.overridden !== best.overridden) {
      if (c.overridden) best = c;
      continue;
    }
    if (!!c.binding.when !== !!best.binding.when && c.binding.when) {
      best = c;
    }
  }
  return best.commandId;
}

// Keydowns of a modifier alone (or synthetic events with no code) can't
// form a chord.
const NON_CHORD_CODES = new Set([
  "",
  "ControlLeft",
  "ControlRight",
  "ShiftLeft",
  "ShiftRight",
  "AltLeft",
  "AltRight",
  "MetaLeft",
  "MetaRight",
  "CapsLock",
]);

export function serializeEvent(e: KeyboardEvent): string | null {
  if (NON_CHORD_CODES.has(e.code)) return null;
  const parts: string[] = [];
  if (e.ctrlKey) parts.push("ctrl");
  if (e.shiftKey) parts.push("shift");
  if (e.altKey) parts.push("alt");
  if (e.metaKey) parts.push("meta");
  parts.push(e.code);
  return parts.join("+");
}

const CODE_LABELS: Record<string, string> = {
  Comma: ",",
  Period: ".",
  Slash: "/",
  Backslash: "\\",
  BracketLeft: "[",
  BracketRight: "]",
  Semicolon: ";",
  Quote: "'",
  Backquote: "`",
  Minus: "-",
  Equal: "=",
  ArrowUp: "↑",
  ArrowDown: "↓",
  ArrowLeft: "←",
  ArrowRight: "→",
};

export function formatBinding(binding: string): string {
  return binding
    .split("+")
    .map((part) => {
      switch (part) {
        case "ctrl":
          return "Ctrl";
        case "shift":
          return "Shift";
        case "alt":
          return "Alt";
        case "meta":
          return "Meta";
        default:
          if (part.startsWith("Key")) return part.slice(3);
          if (part.startsWith("Digit")) return part.slice(5);
          return CODE_LABELS[part] ?? part;
      }
    })
    .join("+");
}

// True while the Keyboard Shortcuts recorder is capturing a chord. The
// global dispatcher and TerminalView's key handler both check this so the
// combo being recorded doesn't also trigger the command it currently
// belongs to (e.g. recording Ctrl+W must not close the settings tab). A
// module-level flag rather than React state: the dispatcher lives in a
// mount-once listener and this avoids threading one more ref through three
// components.
export const recorderState = { recording: false };
