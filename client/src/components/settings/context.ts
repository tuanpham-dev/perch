import { createContext, useContext } from "react";
import type { AppSettings, ExtensionSettingsValues } from "../../settings";
import type { ExtensionInfo } from "../../types";

export interface SettingsContextValue {
  // Whether the Settings tab is the one on screen. Sections stay mounted
  // when it is not (SettingsView only hides them), so anything that polls
  // has to check this or it polls forever in the background.
  active: boolean;
  settings: AppSettings;
  set: <K extends keyof AppSettings>(key: K, value: AppSettings[K]) => void;
  onSettingsChange: (settings: AppSettings) => void;
  extensions: ExtensionInfo[];
  onReloadExtensions: () => void;
  extensionSettings: ExtensionSettingsValues;
  onExtensionSettingsChange: (values: ExtensionSettingsValues) => void;
}

// Scoped to the Settings dialog only — the codebase's one and only context
// (see plans/client-structure-split.md), not a pattern to reach for
// elsewhere. Section components read shared settings/extensions state
// through this instead of threading several individual props down from
// SettingsView; genuinely section-specific inputs still pass as plain props.
// Keybinding overrides moved out entirely — the Keyboard Shortcuts editor is
// now its own tab (KeyboardShortcutsView), not a Settings section, and reads
// them as plain props from App.tsx.
const SettingsContext = createContext<SettingsContextValue | null>(null);

export function useSettingsContext(): SettingsContextValue {
  const ctx = useContext(SettingsContext);
  if (!ctx) throw new Error("useSettingsContext must be used within SettingsView's provider");
  return ctx;
}

export const SettingsProvider = SettingsContext.Provider;
