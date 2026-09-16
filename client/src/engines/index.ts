// Engine resolution over the extension registry (plans/minimal-core-
// extension-extraction.md): engines live in extensions registered via
// ctx.registerTerminalEngine — xterm-engine is a bundled required builtin
// (the guaranteed floor and default), and ghostty-engine is an optional
// install from the perch-extensions registry. Core keeps only this
// resolution plus the seam types (./types).
import {
  activateExtensionById,
  extensionTerminalEngines,
  getInstalledExtensions,
  whenExtensionsListed,
} from "../extensions";
import type { CreateTerminalEngine } from "./types";

// The required builtin's namespaced id — the fallback for an unknown/
// stale stored engine id (e.g. its extension was uninstalled), and one
// side of the "auto" per-device resolution in TerminalView.
export const XTERM_ENGINE_ID = "ext.perch.xterm-engine.xterm";
export const GHOSTTY_ENGINE_ID = "ext.perch.ghostty-engine.ghostty";

// Which installed extension declares (via contributes.terminalEngines) the
// given namespaced engine id — resolved from the static manifest list, so
// this never has to activate anything just to find out. Namespaced the same
// way registerTerminalEngine does at activation time: ext.<extensionId>.<id>.
function findEngineOwner(engineId: string): string | null {
  for (const ext of getInstalledExtensions()) {
    if (ext.terminalEngines.some((e) => `ext.${ext.id}.${e.id}` === engineId)) return ext.id;
  }
  return null;
}

// Resolves a stored engine id to its factory, activating only that one
// engine extension's client entry — not the whole extension list, and not
// every other bundled engine (see loadExtensions' comment for why that used
// to happen). whenExtensionsListed only waits for the manifest list, so
// opening a terminal never blocks on unrelated extensions activating.
// Unknown ids fall back to the required xterm engine, activating it too if
// it hasn't run yet; null only when even that isn't registered (a corrupt/
// incomplete install), which TerminalView surfaces as an explicit error
// rather than a silent blank.
export async function loadEngine(id: string): Promise<CreateTerminalEngine | null> {
  await whenExtensionsListed();
  const owner = findEngineOwner(id);
  if (owner) await activateExtensionById(owner);
  const exact = extensionTerminalEngines.find((e) => e.id === id);
  if (exact) return exact.create;
  const xtermOwner = findEngineOwner(XTERM_ENGINE_ID);
  if (xtermOwner) await activateExtensionById(xtermOwner);
  const fallback = extensionTerminalEngines.find((e) => e.id === XTERM_ENGINE_ID);
  return (fallback ?? extensionTerminalEngines[0])?.create ?? null;
}
