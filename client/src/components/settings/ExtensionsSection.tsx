import { useSettingsContext } from "./context";

// Preferences ABOUT extensions. Browsing, installing and managing the
// extensions themselves still lives in the sidebar's Extensions tab
// (ExtensionsPanel) — this is the one setting that decides how that tab
// behaves when nobody is looking at it. The same checkbox is repeated in
// that panel's gear popover, where you are already looking at registries.
export default function ExtensionsSection() {
  const { settings, set } = useSettingsContext();

  return (
    <>
      <h2 className="settings-section-title">Extensions</h2>

      <label className="settings-row checkbox-row">
        <input
          type="checkbox"
          checked={settings.autoUpdateExtensions}
          onChange={(e) => set("autoUpdateExtensions", e.target.checked)}
        />
        <span>Automatically update extensions</span>
      </label>
      <div className="settings-hint">
        Installs new versions from your registries in the background, as each update check finds them.
        A reload is needed before the new code runs - the Extensions tab says which extensions are
        waiting for one.
      </div>
    </>
  );
}
