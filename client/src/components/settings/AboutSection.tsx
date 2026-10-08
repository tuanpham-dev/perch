import { checkedAgo, useUpdates } from "../../hooks/useUpdates";
import { UpdateSummary } from "../AboutDialog";
import { useSettingsContext } from "./context";

// Settings → About (plans/app-versioning.md R4): which Perch this is, whether
// a newer one exists, and how the server looks for one.
export default function AboutSection() {
  const { settings, set } = useSettingsContext();
  const { status, checking, check } = useUpdates(`${settings.updateChannel}:${settings.checkForUpdates}`);

  return (
    <>
      <h2 className="settings-section-title">About</h2>

      <div className="settings-row">
        <span className="settings-label">Version</span>
        <span>
          Perch {status?.current ?? ""}
          {status?.commit && <span className="about-commit">commit {status.commit}</span>}
        </span>
      </div>

      <div className="settings-hint about-settings-status">
        <UpdateSummary status={status} />
        <div className="about-line muted">{checkedAgo(status?.checkedAt ?? null)}</div>
        <button className="dialog-button secondary" disabled={checking} onClick={() => void check()}>
          {checking ? "Checking..." : "Check for updates"}
        </button>
      </div>

      <label className="settings-row checkbox-row">
        <input
          type="checkbox"
          checked={settings.checkForUpdates}
          onChange={(e) => set("checkForUpdates", e.target.checked)}
        />
        <span>Automatically check for updates</span>
      </label>
      <div className="settings-hint">
        The server asks GitHub for the newest Perch release a few times a day, and shows a notice when there is one. Turn
        this off to check only when you click the button above.
      </div>

      <label className="settings-row">
        <span className="settings-label">Update channel</span>
        <select
          className="dialog-input settings-select"
          value={settings.updateChannel}
          onChange={(e) => set("updateChannel", e.target.value === "beta" ? "beta" : "stable")}
        >
          <option value="stable">Stable</option>
          <option value="beta">Beta (includes pre-releases)</option>
        </select>
      </label>
      <div className="settings-hint">
        Which releases count for the notice and for <code>perch update</code>. Beta adds release candidates, for trying a
        version before it's released.
      </div>
    </>
  );
}
