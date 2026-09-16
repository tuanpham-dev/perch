// The `editor` picker — which editor opens files, git diffs and merge
// conflicts. Same shape as TerminalSection's engine select, and for the same
// reason: options come from each enabled extension's *declared*
// contributes.editors (ExtensionInfo.editors) rather than the live
// extensionEditors registry, because resolution only ever activates the one
// editor a given open actually needs, so the registry isn't necessarily
// populated. The manifest declaration is always complete regardless of
// activation state.
import { EDITOR_NVIM_ID } from "../../editors";
import { useSettingsContext } from "./context";

export default function EditorSection() {
  const { settings, set, extensions } = useSettingsContext();

  const editorOptions = [
    // Core's own editor, always present — it can't be uninstalled, and it's
    // the fallback for any capability the selection doesn't claim.
    { id: EDITOR_NVIM_ID, label: "nvim (terminal window)" },
    ...extensions
      .filter((ext) => ext.enabled)
      .flatMap((ext) => ext.editors.map((e) => ({ id: `ext.${ext.id}.${e.id}`, label: e.label }))),
  ];

  return (
    <>
      <h2 className="settings-section-title">Editor</h2>

      <label className="settings-row">
        <span className="settings-label">Editor</span>
        <select
          className="dialog-input settings-select"
          value={settings.editor}
          onChange={(e) => set("editor", e.target.value)}
        >
          {editorOptions.map((editor) => (
            <option key={editor.id} value={editor.id}>
              {editor.label}
            </option>
          ))}
        </select>
      </label>
      <div className="settings-hint">
        Which editor opens files, git diffs and merge conflicts. An extension&apos;s editor only handles what it
        declares; anything else falls back to nvim.
      </div>
    </>
  );
}
