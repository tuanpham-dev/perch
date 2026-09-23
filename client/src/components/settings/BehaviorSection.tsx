import { useEffect, useState } from "react";
import { fetchShellIntegrationStatus } from "../../api";
import { copyText } from "../../clipboard";
import { normalizeCarryOverPath } from "../../lib/carryOverPaths";
import Icon from "../Icon";
import {
  disablePush,
  enablePush,
  getCurrentSubscription,
  pushUnavailableReason,
} from "../../pushSubscribe";
import { TAB_BAR_SCOPES, type AppSettings } from "../../settings";
import { useSettingsContext } from "./context";

// Local component state, not a synced AppSettings field — see
// pushSubscribe.ts's module comment for why a subscription can't be a
// cross-device preference. "unavailable" carries the specific reason so the
// UI can explain rather than just disappear (LESSONS-adjacent: fail loud).
type PushUiState =
  | { kind: "loading" }
  | { kind: "unavailable"; reason: string }
  | { kind: "subscribed" }
  | { kind: "unsubscribed" }
  | { kind: "busy" }
  | { kind: "error"; message: string };

function PushNotificationToggle() {
  const [state, setState] = useState<PushUiState>({ kind: "loading" });

  useEffect(() => {
    const reason = pushUnavailableReason();
    if (reason) {
      setState({ kind: "unavailable", reason });
      return;
    }
    getCurrentSubscription()
      .then((sub) => setState({ kind: sub ? "subscribed" : "unsubscribed" }))
      .catch((err) => setState({ kind: "error", message: String(err) }));
  }, []);

  const toggle = async (checked: boolean) => {
    setState({ kind: "busy" });
    try {
      if (checked) await enablePush();
      else await disablePush();
      setState({ kind: checked ? "subscribed" : "unsubscribed" });
    } catch (err) {
      setState({ kind: "error", message: err instanceof Error ? err.message : String(err) });
    }
  };

  if (state.kind === "loading") return null;
  if (state.kind === "unavailable") {
    return <div className="settings-hint">{state.reason}</div>;
  }

  return (
    <>
      <label className="settings-row checkbox-row">
        <input
          type="checkbox"
          checked={state.kind === "subscribed"}
          disabled={state.kind === "busy"}
          onChange={(e) => toggle(e.target.checked)}
        />
        <span>Push notifications on this device (terminal bell, finished commands)</span>
      </label>
      {state.kind === "error" && <div className="settings-hint">{state.message}</div>}
    </>
  );
}

// Status card for the shell-integration snippet (plans/warp-features.md).
// The app's zsh, bash and PowerShell terminals source it on their own
// (server/src/shellIntegration.ts), so the card is a status line — whether
// the server has ever received a report, the cheapest honest "is it
// working" signal — with the rc line tucked away for any other shell setup.
function ShellIntegrationCard() {
  const [status, setStatus] = useState<{ receivedAny: boolean; sourceLine: string; profile?: string } | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    fetchShellIntegrationStatus().then(setStatus).catch(() => {});
  }, []);

  if (!status) return null;

  const copy = () => {
    copyText(status.sourceLine)
      .then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      })
      .catch(() => {});
  };

  return (
    <div className="settings-row">
      <span className="settings-label">
        Shell integration{" "}
        <span className="settings-hint" style={{ display: "inline" }}>
          {status.receivedAny ? "- active" : "- not seen yet, open a new terminal"}
        </span>
      </span>
      <div className="settings-hint">
        Jump-to-previous-command, command history and finished-command notifications. Loaded automatically in
        terminals running zsh, bash or PowerShell.
      </div>
      <details className="settings-details">
        <summary className="settings-hint">Not picked up automatically?</summary>
        <div className="settings-hint">
          The automatic load covers the bundled terminal daemon. If a zsh, bash or PowerShell terminal misses it
          (another backend such as tmux, a wrapper script as the shell, or a nested shell), add this line to{" "}
          {status.profile ?? "your ~/.zshrc or ~/.bashrc"} and open a new terminal.
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <code style={{ flex: 1, overflowX: "auto", whiteSpace: "nowrap", userSelect: "all" }}>
            {status.sourceLine}
          </code>
          <button type="button" className="dialog-button secondary" onClick={copy}>
            {copied ? "Copied" : "Copy"}
          </button>
        </div>
      </details>
    </div>
  );
}

// The "Carry into new worktrees" list: one row per path with a remove button
// at its right end, and an input that adds to the end of the list.
function CarryOverList() {
  const { settings, set } = useSettingsContext();
  const [draft, setDraft] = useState("");
  const [error, setError] = useState("");
  const paths = settings.worktreeCarryOver;

  const add = () => {
    const p = normalizeCarryOverPath(draft);
    if (p === null) {
      setError(draft.trim() ? "Use a path relative to the repository root, without '..'." : "");
      return;
    }
    setError("");
    setDraft("");
    if (!paths.includes(p)) set("worktreeCarryOver", [...paths, p]);
  };

  return (
    <div className="settings-row">
      <span className="settings-label">Carry into new worktrees</span>
      <div className="settings-hint">
        Paths relative to the repository root that git ignores but a checkout needs, such as .env or
        node_modules. Each one is symlinked from the repository&apos;s main worktree into a new worktree. A
        path that is not ignored, or does not exist there, is skipped.
      </div>
      {paths.length > 0 && (
        <div className="settings-entry-list">
          {paths.map((p) => (
            <div key={p} className="settings-entry">
              <div className="settings-entry-head">
                <span className="settings-entry-path" title={p}>
                  {p}
                </span>
                <button
                  className="icon-button"
                  title="Remove"
                  aria-label={`Remove ${p}`}
                  onClick={() => set("worktreeCarryOver", paths.filter((q) => q !== p))}
                >
                  <Icon name="trash" />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
      <div className="settings-add-row">
        <input
          id="worktree-carry-over-input"
          className="dialog-input"
          placeholder="node_modules"
          aria-label="Path to carry into new worktrees"
          value={draft}
          onChange={(e) => {
            setDraft(e.target.value);
            if (error) setError("");
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              add();
            }
          }}
        />
        <button className="dialog-button secondary" onClick={add} disabled={!draft.trim()}>
          Add
        </button>
      </div>
      {error && <div className="settings-hint settings-error">{error}</div>}
    </div>
  );
}

export default function BehaviorSection() {
  const { settings, set } = useSettingsContext();

  return (
    <>
      <h2 className="settings-section-title">Behavior</h2>

      <label className="settings-row">
        <span className="settings-label">On upload name conflict</span>
        <select
          className="dialog-input settings-select"
          value={settings.uploadConflict}
          onChange={(e) => set("uploadConflict", e.target.value as AppSettings["uploadConflict"])}
        >
          <option value="rename">Keep both (rename new file)</option>
          <option value="overwrite">Overwrite existing file</option>
          <option value="ask">Ask every time</option>
        </select>
      </label>

      <label className="settings-row">
        <span className="settings-label">Maximum upload file size (MB)</span>
        <div className="settings-hint">
          Files larger than this are skipped when dropped on a terminal or the FILES tree (and on
          paste or Upload…), and reported instead of uploaded. 0 means no limit.
        </div>
        <input
          className="dialog-input"
          type="number"
          min={0}
          step={1}
          value={settings.uploadMaxSizeMb}
          onChange={(e) => {
            const value = Number(e.target.value);
            set("uploadMaxSizeMb", Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0);
          }}
        />
      </label>

      <label className="settings-row">
        <span className="settings-label">Image paste/drop upload directory</span>
        <div className="settings-hint">
          {"{tmp} is this machine's temp folder, {cwd} the terminal's folder, {gitroot} its git repo root; empty means {cwd}/uploads"}
        </div>
        <input
          className="dialog-input"
          placeholder="{cwd}/uploads"
          value={settings.pasteDropUploadDir}
          onChange={(e) => set("pasteDropUploadDir", e.target.value)}
        />
      </label>

      <label className="settings-row">
        <span className="settings-label">New worktree location</span>
        <div className="settings-hint">
          {"{repo} is the repository root, {branch} the branch name with \"/\" replaced by \"-\". A relative path resolves against the repository root. A location inside the repository is added to .git/info/exclude, never to your committed .gitignore."}
        </div>
        <input
          className="dialog-input"
          placeholder="{repo}/.worktrees/{branch}"
          value={settings.worktreeLocation}
          onChange={(e) => set("worktreeLocation", e.target.value)}
        />
      </label>

      <CarryOverList />

      <label className="settings-row">
        <span className="settings-label">Ports to list</span>
        <div className="settings-hint">
          A process keeps listening after you close the terminal you started it in. This is also what
          the proxy and the tunnel will serve: a port that is not listed cannot be opened or
          forwarded. Ports held by another user (system services like a database or ssh) are never
          listed.
        </div>
        <select
          className="dialog-input settings-select"
          value={settings.portScope}
          onChange={(e) => set("portScope", e.target.value as AppSettings["portScope"])}
        >
          <option value="open">Only while their terminal is open</option>
          <option value="launched">Anything a terminal started</option>
          <option value="user">Every port my user owns</option>
        </select>
      </label>

      <label className="settings-row checkbox-row">
        <input
          type="checkbox"
          checked={settings.confirmBeforeKill}
          onChange={(e) => set("confirmBeforeKill", e.target.checked)}
        />
        <span>Confirm before closing projects and terminals</span>
      </label>

      <label className="settings-row">
        <span className="settings-label">After closing the active tab</span>
        <select
          className="dialog-input settings-select"
          value={settings.tabCloseActivation}
          onChange={(e) =>
            set("tabCloseActivation", e.target.value as AppSettings["tabCloseActivation"])
          }
        >
          <option value="recent">Activate previously used tab</option>
          <option value="adjacent">Activate adjacent tab</option>
        </select>
      </label>

      <label className="settings-row">
        <span className="settings-label">Open new tabs</span>
        <select
          className="dialog-input settings-select"
          value={settings.newTabPlacement}
          onChange={(e) =>
            set("newTabPlacement", e.target.value as AppSettings["newTabPlacement"])
          }
        >
          <option value="end">At the end of the tab bar</option>
          <option value="afterActive">To the right of the active tab</option>
        </select>
      </label>

      <label className="settings-row checkbox-row">
        <input
          type="checkbox"
          checked={settings.tabGroupsBySession}
          onChange={(e) => set("tabGroupsBySession", e.target.checked)}
        />
        <span>Group tabs by project in the tab bar</span>
      </label>

      {settings.tabGroupsBySession && (
        <label className="settings-row">
          <span className="settings-label">Show tabs for</span>
          <select
            className="dialog-input settings-select"
            value={settings.tabBarScope}
            onChange={(e) => set("tabBarScope", e.target.value as AppSettings["tabBarScope"])}
          >
            {TAB_BAR_SCOPES.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
        </label>
      )}

      <label className="settings-row">
        <span className="settings-label">Default projects folder</span>
        <input
          className="dialog-input"
          placeholder="Home folder (~)"
          value={settings.defaultProjectsFolder}
          onChange={(e) => set("defaultProjectsFolder", e.target.value)}
        />
      </label>

      <label className="settings-row checkbox-row">
        <input
          type="checkbox"
          checked={settings.paletteSortByUsage}
          onChange={(e) => set("paletteSortByUsage", e.target.checked)}
        />
        <span>Sort command palette by most-used</span>
      </label>

      <PushNotificationToggle />

      <label className="settings-row">
        <span className="settings-label">Notify when a command finishes (seconds)</span>
        <div className="settings-hint">
          Push a notification when a command runs at least this long before finishing. 0 disables.
          Requires shell integration (below) and push notifications enabled on at least one device.
        </div>
        <input
          className="dialog-input"
          type="number"
          min={0}
          step={1}
          value={settings.notifyCommandMinDuration}
          onChange={(e) => {
            const value = Number(e.target.value);
            set("notifyCommandMinDuration", Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0);
          }}
        />
      </label>

      <ShellIntegrationCard />
    </>
  );
}
