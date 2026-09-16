import type { AppSettings } from "../../settings";
import { useSettingsContext } from "./context";
import { FontFamilyPicker, NumberField } from "./controls";

// ghostty-web has no native options for line height, letter spacing, bold
// weight, or minimum contrast ratio — the ghostty engine implements them
// app-side (ghosttyShims.ts, utils/fonts.ts). The xterm engine
// (plans/terminal-engine-setting.md) has native options for all of these;
// textThickness stays app-side either way (canvas shim vs
// -webkit-text-stroke — see settings.ts).
export default function TerminalSection() {
  const { settings, set, extensions } = useSettingsContext();

  // Listed from each enabled extension's declared contributes.terminalEngines
  // (ExtensionInfo.terminalEngines) rather than the live extensionTerminalEngines
  // registry — engines/index.ts now only activates whichever ONE engine a
  // session actually resolves to (see its loadEngine), so the registry no
  // longer necessarily has every installed engine's factory loaded. The
  // manifest declaration is always complete regardless of activation state,
  // and re-renders for free whenever `extensions` itself changes (a normal
  // prop, not a module-level registry needing its own subscription).
  const engineOptions = extensions
    .filter((ext) => ext.enabled)
    .flatMap((ext) => ext.terminalEngines.map((e) => ({ id: `ext.${ext.id}.${e.id}`, label: e.label })));


  return (
    <>
      <h2 className="settings-section-title">Terminal</h2>

      <label className="settings-row">
        <span className="settings-label">Engine</span>
        <select
          className="dialog-input settings-select"
          value={settings.terminalEngine}
          onChange={(e) => set("terminalEngine", e.target.value)}
        >
          {engineOptions.map((engine) => (
            <option key={engine.id} value={engine.id}>
              {engine.label}
            </option>
          ))}
          <option value="auto">Auto (xterm.js on mobile)</option>
        </select>
      </label>

      <FontFamilyPicker
        value={settings.fontFamily}
        onChange={(v) => set("fontFamily", v)}
        extensions={extensions}
      />

      <label className="settings-row">
        <span className="settings-label">Font size</span>
        <NumberField
          value={settings.fontSize}
          min={8}
          max={32}
          step={1}
          onCommit={(v) => set("fontSize", Math.round(v))}
        />
      </label>

      <label className="settings-row">
        <span className="settings-label">Font size (mobile)</span>
        <NumberField
          value={settings.fontSizeMobile}
          min={0}
          max={32}
          step={1}
          onCommit={(v) => set("fontSizeMobile", Math.round(v))}
        />
      </label>
      <div className="settings-hint">
        On phones and tablets, overrides Font size. 0 uses the desktop font
        size.
      </div>

      <label className="settings-row">
        <span className="settings-label">Line height</span>
        <NumberField
          value={settings.lineHeight}
          min={1}
          max={2}
          step={0.1}
          onCommit={(v) => set("lineHeight", v)}
        />
      </label>

      <label className="settings-row">
        <span className="settings-label">Letter spacing (px)</span>
        <NumberField
          value={settings.letterSpacing}
          min={-2}
          max={8}
          step={0.5}
          onCommit={(v) => set("letterSpacing", v)}
        />
      </label>

      <label className="settings-row">
        <span className="settings-label">Text weight</span>
        <select
          className="dialog-input settings-select"
          value={settings.fontWeight}
          onChange={(e) => set("fontWeight", e.target.value as AppSettings["fontWeight"])}
        >
          <option value="normal">normal (400)</option>
          <option value="medium">medium (500)</option>
        </select>
      </label>

      <label className="settings-row">
        <span className="settings-label">Text thickness (px)</span>
        <NumberField
          value={settings.textThickness}
          min={0}
          max={1}
          step={0.05}
          onCommit={(v) => set("textThickness", v)}
        />
      </label>

      <label className="settings-row">
        <span className="settings-label">Bold text weight</span>
        <select
          className="dialog-input settings-select"
          value={settings.fontWeightBold}
          onChange={(e) => set("fontWeightBold", e.target.value as AppSettings["fontWeightBold"])}
        >
          <option value="normal">normal</option>
          <option value="bold">bold</option>
        </select>
      </label>

      <label className="settings-row">
        <span className="settings-label">Minimum contrast ratio</span>
        <select
          className="dialog-input settings-select"
          value={String(settings.minimumContrastRatio)}
          onChange={(e) => set("minimumContrastRatio", Number(e.target.value))}
        >
          <option value="1">Off</option>
          <option value="4.5">4.5 (WCAG AA)</option>
          <option value="7">7 (WCAG AAA)</option>
          <option value="21">21 (maximum)</option>
        </select>
      </label>

      <label className="settings-row">
        <span className="settings-label">Cursor style</span>
        <select
          className="dialog-input settings-select"
          value={settings.cursorStyle}
          onChange={(e) => set("cursorStyle", e.target.value as AppSettings["cursorStyle"])}
        >
          <option value="block">block</option>
          <option value="bar">bar</option>
          <option value="underline">underline</option>
        </select>
      </label>

      <label className="settings-row checkbox-row">
        <input
          type="checkbox"
          checked={settings.cursorBlink}
          onChange={(e) => set("cursorBlink", e.target.checked)}
        />
        <span>Cursor blink</span>
      </label>

      <label className="settings-row">
        <span className="settings-label">When copying a selection</span>
        <select
          className="dialog-input settings-select"
          value={settings.copySelection}
          onChange={(e) => set("copySelection", e.target.value as AppSettings["copySelection"])}
        >
          <option value="raw">Keep lines as shown</option>
          <option value="joinWrapped">Join soft-wrapped lines</option>
          <option value="paragraph">Join into paragraphs</option>
        </select>
      </label>
      <label className="settings-row">
        <span className="settings-label">Right-click in the terminal</span>
        <select
          className="dialog-input settings-select"
          value={settings.rightClickBehavior}
          onChange={(e) => set("rightClickBehavior", e.target.value as AppSettings["rightClickBehavior"])}
        >
          <option value="menu">Show the context menu</option>
          <option value="forward">Send to mouse-aware programs</option>
          <option value="paste">Paste</option>
        </select>
      </label>
      <div className="settings-hint">
        With <em>Show the context menu</em>, hold Shift to send the click to a program using the mouse (vim,
        htop) instead; with the other two, hold Shift to get the menu.
      </div>

      <div className="settings-hint">
        Joining soft-wrapped lines undoes wraps the terminal made. Joining into paragraphs also undoes a
        program's own word-wrap, which collapses code and command output into one line - Copy as Paragraph
        does the same for a single copy without changing this.
      </div>

      <label className="settings-row checkbox-row">
        <input
          type="checkbox"
          checked={settings.scrollbackSnapToBottom}
          onChange={(e) => set("scrollbackSnapToBottom", e.target.checked)}
        />
        <span>Typing jumps back to the bottom</span>
      </label>
      <div className="settings-hint">
        Scrolled back and then type, and the pane returns to the live output first, like a normal terminal
        emulator. PageUp and PageDown still move through the scrollback, and Find and the prompt jumps still
        work while scrolled.
      </div>

      <label className="settings-row">
        <span className="settings-label">Local echo when</span>
        <input
          className="dialog-input"
          placeholder="e.g. claude (empty disables)"
          value={settings.localEchoWhen}
          onChange={(e) => set("localEchoWhen", e.target.value)}
        />
      </label>
      <div className="settings-hint">
        On mobile, typed input renders instantly and buffers until Enter
        while the pane's foreground command matches this comma-separated
        list (case-insensitive, exact match). Empty disables local echo.
      </div>
    </>
  );
}
