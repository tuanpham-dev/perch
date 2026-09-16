import { useEffect, useRef, useState } from "react";
import * as api from "../api";
import type { RegisteredCommand } from "../extensions";
import { migrateKeybindingOverrides, resolveBindings, type Command, type KeybindingOverrides } from "../keybindings";
import {
  DEFAULT_SETTINGS,
  loadCommandUsage,
  loadExtensionRegistries,
  loadExtensionSettings,
  loadKeybindingOverrides,
  adoptWorktreeExtensionSettings,
  loadProjects,
  loadSettings,
  loadSidebarLayout,
  migrateSettings,
  projectsFromPins,
  sanitizeProjects,
  saveCommandUsage,
  saveExtensionRegistries,
  saveExtensionSettings,
  saveKeybindingOverrides,
  saveProjects,
  saveSettings,
  saveSidebarLayout,
  parseSidebarLayout,
  type StoredSidebarLayout,
  type AppSettings,
  type CommandUsage,
  type ExtensionSettingsValues,
} from "../settings";
import type { Project } from "../types";

// Owns settings/keybindingOverrides/extensionSettings: localStorage-first
// load, skip-initial-persist write-back, and the server-doc GET (server
// wins once fetched) + debounced read-merge-write-back. extCommands comes
// from useExtensionRegistry() in App (shared with the global command
// dispatcher and file-opener wiring), so keybindings can resolve extension-
// contributed commands without duplicating that registry subscription here.
export function useSettingsSync(extCommands: RegisteredCommand[]) {
  const [settings, setSettings] = useState<AppSettings>(loadSettings);
  const settingsRef = useRef(settings);
  settingsRef.current = settings;

  // Skip persisting on the initial mount: loadSettings() already merged in
  // whatever DEFAULT_SETTINGS shipped, and writing that back immediately
  // would lock a returning visitor onto today's defaults forever — any
  // future default change (e.g. adding a fallback font) would then never
  // reach them, since their localStorage entry would already have every key.
  const settingsMounted = useRef(false);
  useEffect(() => {
    if (!settingsMounted.current) {
      settingsMounted.current = true;
      return;
    }
    saveSettings(settings);
  }, [settings]);

  // Keybinding overrides (command id → its full replacement binding set),
  // resolved over the defaults in keybindings.ts. Same localStorage flow as
  // settings above, including the skip-initial-persist rationale.
  const [keybindingOverrides, setKeybindingOverrides] =
    useState<KeybindingOverrides>(loadKeybindingOverrides);
  // Extension-registered commands (extensions.ts) — join the built-in list
  // (always "global" scope in v1, namespaced ext.<extensionId>.<cmd> so they
  // can't collide with a built-in id). The public extension API still
  // registers a single defaultBinding string; multi-binding is a built-in-
  // command-only capability for now.
  const extCommandDefs: Command[] = extCommands.map((c) => ({
    id: c.id,
    label: c.label,
    defaultBindings: c.defaultBinding ? [{ key: c.defaultBinding }] : [],
    scope: "global",
  }));
  const resolvedBindings = resolveBindings(keybindingOverrides, extCommandDefs);
  const bindingsRef = useRef(resolvedBindings);
  bindingsRef.current = resolvedBindings;
  // Raw overrides (not the merged resolvedBindings above) — the global
  // dispatcher's pickCommand needs to know whether a match came from a
  // user's own rebind or a still-default binding (see keybindings.ts'
  // BindingMatch precedence).
  const overridesRef = useRef(keybindingOverrides);
  overridesRef.current = keybindingOverrides;

  const keybindingsMounted = useRef(false);
  useEffect(() => {
    if (!keybindingsMounted.current) {
      keybindingsMounted.current = true;
      return;
    }
    saveKeybindingOverrides(keybindingOverrides);
  }, [keybindingOverrides]);

  // Sparse per-extension setting overrides (extensionId -> key -> value) —
  // same localStorage flow as settings/keybindings above, including the
  // skip-initial-persist rationale.
  const [extensionSettings, setExtensionSettings] =
    useState<ExtensionSettingsValues>(loadExtensionSettings);
  const extensionSettingsRef = useRef(extensionSettings);
  extensionSettingsRef.current = extensionSettings;

  const extensionSettingsMounted = useRef(false);
  useEffect(() => {
    if (!extensionSettingsMounted.current) {
      extensionSettingsMounted.current = true;
      return;
    }
    saveExtensionSettings(extensionSettings);
  }, [extensionSettings]);

  // Projects (recents + pins) — same localStorage-first + skip-initial-
  // persist + server-doc flow as the three states above, but stored as its
  // own top-level doc key rather than inside AppSettings (see settings.ts).
  const [projects, setProjects] = useState<Project[]>(loadProjects);
  const projectsMounted = useRef(false);
  useEffect(() => {
    if (!projectsMounted.current) {
      projectsMounted.current = true;
      return;
    }
    saveProjects(projects);
  }, [projects]);

  // Extension registry sources — same localStorage-first + skip-initial-
  // persist + server-doc flow as projects above, and its own top-level
  // doc key for the same reason: a settings reset must not drop a user's
  // configured registries.
  const [extensionRegistries, setExtensionRegistries] = useState<string[]>(loadExtensionRegistries);
  const extensionRegistriesMounted = useRef(false);
  useEffect(() => {
    if (!extensionRegistriesMounted.current) {
      extensionRegistriesMounted.current = true;
      return;
    }
    saveExtensionRegistries(extensionRegistries);
  }, [extensionRegistries]);

  // Sidebars' arrangement (which tabs on which side, plus any relocated
  // section) — same localStorage-first + skip-initial-persist + server-doc
  // flow as extensionRegistries above. Starts null (see loadSidebarLayout)
  // and is only ever set by a deliberate drag or move, so a device that has
  // never synced keeps its own defaults instead of being handed nothing.
  const [sidebarLayout, setSidebarLayout] = useState<StoredSidebarLayout | null>(loadSidebarLayout);
  const sidebarLayoutMounted = useRef(false);
  useEffect(() => {
    if (!sidebarLayoutMounted.current) {
      sidebarLayoutMounted.current = true;
      return;
    }
    if (sidebarLayout) saveSidebarLayout(sidebarLayout);
  }, [sidebarLayout]);

  // Command palette usage stats (count/last per command id) — same
  // localStorage-first + skip-initial-persist + server-doc flow as
  // projects above, and for the same reason: its own top-level doc key
  // outside AppSettings so a settings reset can't erase it.
  const [commandUsage, setCommandUsage] = useState<CommandUsage>(loadCommandUsage);
  const commandUsageMounted = useRef(false);
  useEffect(() => {
    if (!commandUsageMounted.current) {
      commandUsageMounted.current = true;
      return;
    }
    saveCommandUsage(commandUsage);
  }, [commandUsage]);

  // Server-side persistence (~/.config/perch/settings.json via
  // /api/settings): localStorage renders instantly at mount, then the server
  // copy — the cross-device source of truth — wins once fetched. Write-backs
  // are held until that first GET resolves, so a stale localStorage snapshot
  // can never clobber the server doc.
  const serverSyncReady = useRef(false);
  useEffect(() => {
    let cancelled = false;
    api
      .fetchSettingsDoc()
      .then((doc) => {
        if (cancelled) return;
        if (doc.settings && typeof doc.settings === "object") {
          // Worktree settings used to live in the worktrees extension; a
          // value the user customised there is adopted here once.
          setSettings(
            adoptWorktreeExtensionSettings(
              migrateSettings({ ...DEFAULT_SETTINGS, ...(doc.settings as Partial<AppSettings>) }),
              doc.extensionSettings as ExtensionSettingsValues | undefined,
            ),
          );
        }
        if (doc.keybindings && typeof doc.keybindings === "object") {
          setKeybindingOverrides(migrateKeybindingOverrides(doc.keybindings));
        }
        if (
          doc.extensionSettings &&
          typeof doc.extensionSettings === "object" &&
          !Array.isArray(doc.extensionSettings)
        ) {
          setExtensionSettings(doc.extensionSettings as ExtensionSettingsValues);
        }
        if (Array.isArray(doc.projects)) {
          setProjects(sanitizeProjects(doc.projects));
        } else if (Array.isArray(doc.pinnedSessions)) {
          // A doc last written by a pre-projects build: migrate its pins
          // (same conversion as settings.ts's loadProjects). The old key is
          // preserved by the read-merge write-back below, never rewritten.
          setProjects(projectsFromPins(doc.pinnedSessions));
        }
        if (Array.isArray(doc.extensionRegistries)) {
          setExtensionRegistries(doc.extensionRegistries.filter((s): s is string => typeof s === "string"));
        }
        // Unlike the arrays above, an absent/empty synced layout is left
        // alone (rather than applied) — it means "never arranged on any
        // device", and useSidebarLayout's own defaults should stay in charge
        // rather than being wiped out by nothing (see loadSidebarLayout).
        // A doc written by a pre-right-sidebar build carries only the old
        // sidebarTabsOrder key; read that as a left-side-only layout.
        const syncedLayout =
          parseSidebarLayout(doc.sidebarLayout) ??
          (Array.isArray(doc.sidebarTabsOrder) && doc.sidebarTabsOrder.length > 0
            ? parseSidebarLayout({ left: doc.sidebarTabsOrder, right: [], panelHome: {} })
            : null);
        if (syncedLayout) setSidebarLayout(syncedLayout);
        if (doc.commandUsage && typeof doc.commandUsage === "object" && !Array.isArray(doc.commandUsage)) {
          const usage: CommandUsage = {};
          for (const [id, entry] of Object.entries(doc.commandUsage as Record<string, unknown>)) {
            if (
              typeof entry === "object" &&
              entry !== null &&
              typeof (entry as { count?: unknown }).count === "number" &&
              typeof (entry as { last?: unknown }).last === "number"
            ) {
              usage[id] = entry as { count: number; last: number };
            }
          }
          setCommandUsage(usage);
        }
        serverSyncReady.current = true;
      })
      .catch(() => {
        // Server unreachable (offline PWA) — localStorage stays authoritative
        // for this visit, and nothing gets pushed up.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Debounced write-back of the whole doc. Read-merge-write: fetches the
  // current doc first and preserves any top-level key this client doesn't
  // own (e.g. extensionSettings written by a newer client while an older
  // tab is still open) instead of blindly overwriting it — falls back to
  // writing just the three known keys if the pre-fetch fails. Last-write-
  // wins across devices for the keys this client does own — accepted for a
  // single-user tool. Errors are swallowed: localStorage already has the
  // change, and a persistent server failure would otherwise toast on every
  // keystroke in a settings input.
  useEffect(() => {
    if (!serverSyncReady.current) return;
    const timer = window.setTimeout(() => {
      api
        .fetchSettingsDoc()
        .then((doc) => ({
          ...doc,
          settings,
          keybindings: keybindingOverrides,
          extensionSettings,
          projects,
          commandUsage,
          extensionRegistries,
          sidebarLayout,
        }))
        .catch(() => ({
          settings,
          keybindings: keybindingOverrides,
          extensionSettings,
          projects,
          commandUsage,
          extensionRegistries,
          sidebarLayout,
        }))
        .then((doc) => api.putSettingsDoc(doc))
        .catch(() => {});
    }, 400);
    return () => window.clearTimeout(timer);
  }, [
    settings,
    keybindingOverrides,
    extensionSettings,
    projects,
    commandUsage,
    extensionRegistries,
    sidebarLayout,
  ]);

  return {
    settings,
    setSettings,
    settingsRef,
    keybindingOverrides,
    setKeybindingOverrides,
    resolvedBindings,
    bindingsRef,
    overridesRef,
    extensionSettings,
    setExtensionSettings,
    extensionSettingsRef,
    projects,
    setProjects,
    commandUsage,
    setCommandUsage,
    extensionRegistries,
    setExtensionRegistries,
    sidebarLayout,
    setSidebarLayout,
  };
}
