import { useEffect, useRef, type MutableRefObject } from "react";
import { getContextGetter } from "../contextKeys";
import type { RegisteredCommand } from "../extensions";
import {
  bindingMatches,
  COMMANDS,
  findMatchingBinding,
  pickCommand,
  recorderState,
  serializeEvent,
  type BindingMatch,
  type Keybinding,
  type KeybindingOverrides,
} from "../keybindings";

// Extension commands are always scope "global" (see KeyboardShortcutsView.tsx's
// extCommandDefs), so terminal-scoped and files-scoped ids only ever come from
// the static built-in list — safe to compute once at module scope.
const TERMINAL_COMMAND_IDS = COMMANDS.filter((c) => c.scope === "terminal").map((c) => c.id);
const FILES_COMMAND_IDS = COMMANDS.filter((c) => c.scope === "files").map((c) => c.id);
const PROJECTS_COMMAND_IDS = COMMANDS.filter((c) => c.scope === "projects").map((c) => c.id);

// Every global shortcut in one capture-phase dispatcher, driven by the
// rebindable keybindings map (keybindings.ts). A matched combo gets
// preventDefault + stopPropagation so it wins over both browser defaults
// (Ctrl+P print; Ctrl+Tab/Ctrl+W are overridable only in the installed
// PWA) and the terminal's own key handling — Ctrl+Tab reaching the terminal would
// feed it a literal Tab, Ctrl+W would send ^W to the shell. The terminal.*
// combos are dispatched inside TerminalView's custom key handler instead —
// the terminal-yield check below bails out for them, and that handler does
// its own preventDefault + the actual copy. Whatever combo terminal.copy is
// bound to (key only, ignoring `when`) additionally gets a window-level
// preventDefault when no command claims it, to suppress Chrome/Firefox's
// Ctrl+Shift+C "inspect element" default outside a terminal too — but only
// while that combo is unclaimed; a user who rebinds it to another command
// gets that command instead of silent suppression. Freshness via refs so
// the mount-once listener always sees current bindings and handlers.
//
// `handlers` is built by the caller (App.tsx), which owns every action hook
// (session/window CRUD, tab management) this dispatcher needs to invoke —
// keeping the construction there avoids this hook's parameter list growing
// with every new command, and lets App.tsx reuse the exact same record for
// the command palette's entries.
export function useGlobalKeybindings(
  bindingsRef: MutableRefObject<Record<string, Keybinding[]>>,
  overridesRef: MutableRefObject<KeybindingOverrides>,
  handlers: Record<string, () => void>,
  extCommands: RegisteredCommand[],
) {
  const globalCommandsRef = useRef<Record<string, () => void>>({});
  globalCommandsRef.current = {
    ...handlers,
    ...Object.fromEntries(extCommands.map((c) => [c.id, c.run])),
  };

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      // The Keyboard Shortcuts recorder owns the keyboard while capturing a
      // chord — recording Ctrl+W must not also close the tab.
      if (recorderState.recording) return;
      const combo = serializeEvent(e);
      if (!combo) return;
      const bindings = bindingsRef.current;
      const get = getContextGetter(e);
      // A global command (e.g. a sidebar-focus shortcut) can legitimately
      // share a chord with a terminal-scoped one (e.g. Ctrl+Shift+F is both
      // Search-focus and terminal.find) — when the keystroke originates
      // inside a focused terminal, the terminal command wins: bail here
      // (no preventDefault/stopPropagation) so the event reaches the terminal's
      // own attachCustomKeyEventHandler (TerminalView.tsx) exactly as if this
      // dispatcher didn't exist.
      const target = e.target as HTMLElement | null;
      if (
        target?.closest(".terminal-host") &&
        TERMINAL_COMMAND_IDS.some((id) => bindingMatches(bindings[id], combo, get))
      ) {
        return;
      }
      // Same yield, for the FILES tree's own key handler (FileTree.tsx) — a
      // global command that happens to share a combo with a files.* one
      // (e.g. a user rebinding something onto Ctrl+C) must not steal the
      // keystroke from the tree while it has focus.
      if (
        target?.closest(".file-tree") &&
        FILES_COMMAND_IDS.some((id) => bindingMatches(bindings[id], combo, get))
      ) {
        return;
      }
      // Same yield, for the PROJECTS list’s own key handler (ProjectList.tsx)
      // — a global command sharing a combo with a projects.* one must not
      // steal the keystroke from the list while it has focus.
      if (
        target?.closest(".session-list") &&
        PROJECTS_COMMAND_IDS.some((id) => bindingMatches(bindings[id], combo, get))
      ) {
        return;
      }
      // Several commands can match the same combo (e.g. a user's own
      // rebind colliding with another command's still-default binding) —
      // collect every match and let pickCommand's precedence rules settle
      // it, rather than firing whichever happens to iterate first.
      const overrides = overridesRef.current;
      const candidates: BindingMatch[] = [];
      for (const id of Object.keys(globalCommandsRef.current)) {
        const binding = findMatchingBinding(bindings[id], combo, get);
        if (binding) {
          candidates.push({ commandId: id, binding, overridden: Object.hasOwn(overrides, id) });
        }
      }
      const winner = pickCommand(candidates);
      if (winner) {
        e.preventDefault();
        e.stopPropagation();
        globalCommandsRef.current[winner]();
        return;
      }
      // Nothing claimed this combo — if it's assigned to terminal.copy
      // (key only, ignoring `when`: we're not inside a terminal here, the
      // yield check above already sent that case to the terminal), suppress the
      // browser's inspect-element default so it doesn't resurface just
      // because no terminal happens to be focused right now.
      if (bindings["terminal.copy"]?.some((b) => b.key === combo)) {
        e.preventDefault();
      }
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, []);
}
