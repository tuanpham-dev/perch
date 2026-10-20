import { useCallback, useEffect, useState } from "react";
import { deleteStoredData, fetchStoredData, type StoredDataInfo } from "../../api";
import type { ExtensionInfo } from "../../types";
import { useSettingsContext } from "./context";

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

// What each extension keeps in its storage (server/src/extensionStorage.ts):
// uninstalling leaves it in place so a reinstall brings it back, so this is
// where it is deleted on purpose — and where data from extensions that are
// gone shows up.
function StoredData({
  extensions,
  confirmDialog,
}: {
  extensions: ExtensionInfo[];
  confirmDialog?: (message: string, confirmLabel?: string) => Promise<boolean>;
}) {
  const [data, setData] = useState<StoredDataInfo[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    fetchStoredData()
      .then((d) => {
        setData(d);
        setError(null);
      })
      .catch((err: Error) => setError(err.message));
  }, []);

  useEffect(load, [load]);

  const nameOf = (id: string) => extensions.find((e) => e.id === id)?.displayName || id;

  const remove = async (id: string) => {
    const message = `Delete everything ${nameOf(id)} has stored? Its records and files are removed, and it starts empty. This can't be undone.`;
    if (confirmDialog && !(await confirmDialog(message, "Delete"))) return;
    try {
      await deleteStoredData(id);
    } catch (err) {
      setError((err as Error).message);
    }
    load();
  };

  const installed = (data ?? []).filter((d) => d.installed && d.bytes > 0);
  const removed = (data ?? []).filter((d) => !d.installed);

  return (
    <>
      <h3 className="settings-subsection-title">Stored data</h3>
      <div className="settings-hint">
        What extensions keep on this server. It stays when an extension is uninstalled, so reinstalling brings it back.
      </div>
      {error && <div className="settings-hint stored-data-error">{error}</div>}
      {data && installed.length === 0 && removed.length === 0 && <div className="settings-hint">No extension has stored anything yet.</div>}
      {installed.length > 0 && (
        <div className="stored-data-list" role="list">
          {installed.map((d) => (
            <div key={d.id} className="stored-data-row" role="listitem">
              <span className="stored-data-name">{nameOf(d.id)}</span>
              <span className="stored-data-size">{formatBytes(d.bytes)}</span>
              <button className="dialog-button secondary stored-data-delete" onClick={() => void remove(d.id)}>
                Delete stored data…
              </button>
            </div>
          ))}
        </div>
      )}
      {removed.length > 0 && (
        <>
          <div className="stored-data-group">Data from removed extensions</div>
          <div className="stored-data-list" role="list">
            {removed.map((d) => (
              <div key={d.id} className="stored-data-row" role="listitem">
                <span className="stored-data-name">{d.id}</span>
                <span className="stored-data-size">{formatBytes(d.bytes)}</span>
                <button className="dialog-button secondary stored-data-delete" onClick={() => void remove(d.id)}>
                  Delete…
                </button>
              </div>
            ))}
          </div>
        </>
      )}
    </>
  );
}

// Preferences ABOUT extensions. Browsing, installing and managing the
// extensions themselves still lives in the sidebar's Extensions tab
// (ExtensionsPanel) — this is the one setting that decides how that tab
// behaves when nobody is looking at it. The same checkbox is repeated in
// that panel's gear popover, where you are already looking at registries.
// Below it, what each extension has stored, with a way to delete it.
export default function ExtensionsSection({
  extensions,
  confirmDialog,
}: {
  extensions: ExtensionInfo[];
  confirmDialog?: (message: string, confirmLabel?: string) => Promise<boolean>;
}) {
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

      <StoredData extensions={extensions} confirmDialog={confirmDialog} />
    </>
  );
}
