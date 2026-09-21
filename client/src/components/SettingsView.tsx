import { useEffect, useState } from "react";
import * as api from "../api";
import { extensionSettingsComponents, useExtensionRegistryVersion } from "../extensions";
import { DEFAULT_SETTINGS, type AppSettings, type ExtensionSettingsValues } from "../settings";
import type { ExtensionInfo } from "../types";
import AiProvidersSection from "./settings/AiProvidersSection";
import BehaviorSection from "./settings/BehaviorSection";
import BackendSection from "./settings/BackendSection";
import { SettingsProvider } from "./settings/context";
import ExtensionConfigSection from "./settings/ExtensionConfigSection";
import EditorSection from "./settings/EditorSection";
import TerminalSection from "./settings/TerminalSection";
import UiSection from "./settings/UiSection";

interface Props {
  active: boolean;
  settings: AppSettings;
  onSettingsChange: (settings: AppSettings) => void;
  extensions: ExtensionInfo[];
  onReloadExtensions: () => void;
  extensionSettings: ExtensionSettingsValues;
  onExtensionSettingsChange: (values: ExtensionSettingsValues) => void;
  // Set by the Extensions detail page's "Extension Settings" shortcut
  // (App.tsx) to jump straight to that extension's config section — reset
  // to null once applied (onFocusExtensionHandled) so clicking the same
  // shortcut twice in a row (with no navigation in between) still re-fires.
  pendingFocusExtensionId?: string | null;
  onFocusExtensionHandled?: () => void;
  // Hands the picked bundle to App, which renders the preview dialog at the
  // app root beside every other dialog. It cannot be rendered from here: this
  // view lives inside a .split-content-host, whose `z-index: 0` makes it a
  // stacking context and whose overflow is hidden, so a dialog mounted in it
  // is trapped in the tab's own layer instead of sitting over the app.
  // App owns the file input, the parsing and the preview dialog; this view
  // only asks for the picker and renders whatever went wrong. The dialog has
  // to live at the app root like every other dialog (a tab's content sits in
  // a .split-content-host, a stacking context with hidden overflow), so the
  // parsed bundle's state belongs there too - and the input and its parse are
  // kept beside it rather than split across two owners.
  onRequestImport: () => void;
  importError: string | null;
}

// `ext:<id>` is a dynamic nav entry for one extension's declared
// contributes.configuration — see configurableExtensions below. Browsing,
// installing, and managing extensions themselves lives in the sidebar's
// Extensions tab (ExtensionsPanel), not here — see
// plans/extension-registry-and-extensions-tab.md.
type Section = "terminal" | "backend" | "editor" | "behavior" | "ui" | "ai" | `ext:${string}`;

const SECTIONS: { id: Section; label: string }[] = [
  { id: "terminal", label: "Terminal" },
  { id: "backend", label: "Terminal Backend" },
  { id: "editor", label: "Editor" },
  { id: "behavior", label: "Behavior" },
  { id: "ui", label: "UI" },
  // Agents used to be its own entry. It is a group inside AI Providers now:
  // "which AIs does this app have" has one answer and one place to read it
  // (plans/consolidate-agents-into-ai-providers.md).
  { id: "ai", label: "AI Providers" },
];

export default function SettingsView({
  active,
  settings,
  onSettingsChange,
  extensions,
  onReloadExtensions,
  extensionSettings,
  onExtensionSettingsChange,
  pendingFocusExtensionId,
  onFocusExtensionHandled,
  onRequestImport,
  importError,
}: Props) {
  const [section, setSection] = useState<Section>("terminal");
  // Shown in the footer rather than a toast: an export or a file that isn't
  // JSON fails right where the button that started it is.
  const [shareError, setShareError] = useState<string | null>(null);

  // The server builds the bundle, so an export is one fetch plus a download.
  // The object URL is revoked once the click has been dispatched; keeping it
  // alive would pin the whole bundle in memory for the life of the page.
  const exportSettings = async () => {
    setShareError(null);
    try {
      const bundle = await api.fetchSettingsBundle();
      const url = URL.createObjectURL(
        new Blob([JSON.stringify(bundle, null, 2)], { type: "application/json" }),
      );
      const link = document.createElement("a");
      link.href = url;
      link.download = "perch-settings.json";
      link.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      setShareError(err instanceof Error ? err.message : String(err));
    }
  };

  const set = <K extends keyof AppSettings>(key: K, value: AppSettings[K]) =>
    onSettingsChange({ ...settings, [key]: value });

  // Only enabled extensions with at least one normalized property get a nav
  // entry — a disabled extension's settings aren't in effect (parallels its
  // client entry not activating), so editing them would be misleading.
  // Re-render when an extension registers a custom settings component —
  // that alone earns it a settings section, even with no scalar properties.
  useExtensionRegistryVersion();
  const configurableExtensions = extensions.filter(
    (ext) =>
      ext.enabled &&
      (ext.configuration.length > 0 ||
        extensionSettingsComponents.some((c) => c.extensionId === ext.id)),
  );

  // If the active extension section's extension gets disabled/uninstalled
  // out from under it (in the Extensions tab, in another browser tab, or
  // after a reload), fall back to Terminal rather than rendering an empty/
  // stale panel.
  useEffect(() => {
    if (
      section.startsWith("ext:") &&
      !configurableExtensions.some((ext) => `ext:${ext.id}` === section)
    ) {
      setSection("terminal");
    }
  }, [section, configurableExtensions]);

  // Extension-page "Extension Settings" shortcut — see the Props doc above.
  useEffect(() => {
    if (!pendingFocusExtensionId) return;
    setSection(`ext:${pendingFocusExtensionId}`);
    onFocusExtensionHandled?.();
  }, [pendingFocusExtensionId, onFocusExtensionHandled]);

  const activeExtension = section.startsWith("ext:")
    ? configurableExtensions.find((ext) => `ext:${ext.id}` === section)
    : undefined;

  return (
    <SettingsProvider
      value={{
        active,
        settings,
        set,
        onSettingsChange,
        extensions,
        onReloadExtensions,
        extensionSettings,
        onExtensionSettingsChange,
      }}
    >
      <div className={`settings-host${active ? "" : " hidden"}`}>
        <nav className="settings-nav">
          {SECTIONS.map((s) => (
            <button
              key={s.id}
              className={`settings-nav-item${section === s.id ? " active" : ""}`}
              onClick={() => setSection(s.id)}
            >
              {s.label}
            </button>
          ))}
          {configurableExtensions.length > 0 && (
            <>
              <div className="settings-nav-divider" />
              {configurableExtensions.map((ext) => (
                <button
                  key={ext.id}
                  className={`settings-nav-item${section === `ext:${ext.id}` ? " active" : ""}`}
                  onClick={() => setSection(`ext:${ext.id}`)}
                >
                  {ext.displayName}
                </button>
              ))}
            </>
          )}
        </nav>

        <div className="settings-content">
          {section === "terminal" && <TerminalSection />}
          {section === "backend" && <BackendSection />}
          {section === "editor" && <EditorSection />}
          {section === "behavior" && <BehaviorSection />}
          {section === "ui" && <UiSection />}
          {section === "ai" && <AiProvidersSection />}
          {activeExtension && (
            <ExtensionConfigSection
              ext={activeExtension}
              components={extensionSettingsComponents.filter((c) => c.extensionId === activeExtension.id)}
            />
          )}

          <div className="settings-footer">
            {!activeExtension && (
              <>
                <div className="settings-footer-row">
                  <button className="dialog-button secondary" onClick={exportSettings}>
                    Export Settings…
                  </button>
                  <button className="dialog-button secondary" onClick={onRequestImport}>
                    Import Settings…
                  </button>
                </div>
                {(shareError ?? importError) && (
                  <div className="settings-share-error">{shareError ?? importError}</div>
                )}
              </>
            )}
            {activeExtension ? (
              <button
                className="dialog-button secondary"
                disabled={Object.keys(extensionSettings[activeExtension.id] ?? {}).length === 0}
                onClick={() => {
                  const next = { ...extensionSettings };
                  delete next[activeExtension.id];
                  onExtensionSettingsChange(next);
                }}
              >
                Reset {activeExtension.displayName} Settings to Defaults
              </button>
            ) : (
              <button
                className="dialog-button secondary"
                onClick={() => onSettingsChange({ ...DEFAULT_SETTINGS })}
              >
                Reset Settings to Defaults
              </button>
            )}
            {/* Ground truth for "which build is this device actually
                running" — stale service workers have served old bundles
                that were indistinguishable from deploy failures. */}
            <div className="settings-build">Build {__BUILD_TIME__}</div>
          </div>
        </div>
      </div>
    </SettingsProvider>
  );
}
