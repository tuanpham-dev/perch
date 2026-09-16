import { useSettingsContext } from "./context";
import DaemonSettings from "./DaemonSettings";
import { useTerminalBackends } from "./useTerminalBackends";

// Where terminals run: the bundled daemon, or an engine an extension
// registers (host.terminalEngines). The server reads the choice at startup.
// The daemon's own settings follow the picker while it is the chosen one.
export default function BackendSection() {
  const { settings, set, extensions } = useSettingsContext();

  const backends = useTerminalBackends(extensions);
  const running = backends.find((b) => b.active);
  const backendOptions = backends.some((b) => b.id === settings.terminalBackend)
    ? backends
    : [...backends, { id: settings.terminalBackend, label: `${settings.terminalBackend} (not installed)`, description: "", selected: true, active: false }];
  const chosen = backendOptions.find((b) => b.id === settings.terminalBackend);

  return (
    <>
      <h2 className="settings-section-title">Terminal Backend</h2>

      <label className="settings-row">
        <span className="settings-label">Backend</span>
        <select
          className="dialog-input settings-select"
          value={settings.terminalBackend}
          onChange={(e) => set("terminalBackend", e.target.value)}
        >
          {backendOptions.map((b) => (
            <option key={b.id} value={b.id}>
              {b.label}
            </option>
          ))}
        </select>
      </label>
      <div className="settings-hint">
        Where terminals run. Changing this takes effect when the server restarts
        {running && running.id !== settings.terminalBackend ? ` - running on ${running.label} now` : ""}.
      </div>
      {chosen?.description && <div className="settings-hint">{chosen.description}</div>}
      <div className="settings-hint">Extensions can add more backends, for example tmux Terminal Backend.</div>

      {settings.terminalBackend === "daemon" && <DaemonSettings />}
    </>
  );
}
