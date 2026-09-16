import { useEffect, useState } from "react";
import type { ExtensionInfo } from "../../types";
import { listExtensionFontOptions } from "../../utils/fonts";
import {
  composeFontStack,
  FALLBACK_ONLY_VALUE,
  NO_SECONDARY_VALUE,
  splitFontStack,
  type FontStackOption,
} from "../../utils/fontStack";

// Shared form controls used by more than one settings section (TerminalSection's
// font pickers and ExtensionConfigSection's generic property renderer both use
// NumberField) — kept out of any single section file so neither "owns" the other.

// Draft so intermediate keystrokes ("1" on the way to "18") don't get
// rejected by validation and snap the controlled input back — same pattern
// the old settings dialog used for font size.
export function NumberField({
  value,
  min,
  max,
  step,
  onCommit,
}: {
  value: number;
  min: number;
  max: number;
  step: number;
  onCommit: (value: number) => void;
}) {
  const [draft, setDraft] = useState(String(value));
  useEffect(() => {
    setDraft(String(value));
  }, [value]);
  return (
    <input
      className="dialog-input settings-number"
      type="number"
      min={min}
      max={max}
      step={step}
      value={draft}
      onChange={(e) => {
        setDraft(e.target.value);
        const v = Number(e.target.value);
        if (Number.isFinite(v) && v >= min && v <= max) onCommit(v);
      }}
      onBlur={() => setDraft(String(value))}
    />
  );
}

interface FontOption extends FontStackOption {
  label: string;
}

// Only fonts this app actually ships — every one, including IBM Plex Mono,
// is now an extension (see extensions/ibm-plex-mono and friends), bundled
// and enabled by default but otherwise no different from a third-party
// font extension. A locally installed system font (Menlo, JetBrains Mono,
// …) isn't guaranteed to exist on whatever machine opens this page next, so
// it's not offered as a selectable option; type it into the fallback field
// instead. "Use fallback fonts" always leads (the neutral/no-pick state —
// see FALLBACK_ONLY_VALUE), then extension-contributed groups (a group of
// 2+ families — e.g. a mono font plus a Nerd Font symbols companion — is
// ONE option here, expanding to every family in the group when selected).
function buildFontOptions(extensions: ExtensionInfo[]): FontOption[] {
  const options: FontOption[] = [{ value: FALLBACK_ONLY_VALUE, families: [], label: "Use fallback fonts" }];
  const seen = new Set<string>();
  const push = (value: string, families: string[], label: string) => {
    if (seen.has(value)) return;
    seen.add(value);
    options.push({ value, families, label });
  };
  for (const opt of listExtensionFontOptions(extensions)) {
    push(opt.value, opt.families, opt.label);
  }
  return options;
}

// Font family selector + an optional secondary-font selector (e.g. a
// powerline/Nerd Font companion picked deliberately rather than typed by
// hand) + a plain fallback-fonts text field, all reading and writing the
// same settings.fontFamily CSS stack string via splitFontStack/
// composeFontStack — there's only one stored value, so the three views can
// never drift from each other or from a stack a user hand-edited elsewhere.
// A stored value that doesn't match any option (a font typed by hand, or
// whose extension got disabled) just shows as "Use fallback fonts" (primary)
// or "None" (secondary) with the leftover sitting in the fallback field —
// no separate custom-entry mode.
export function FontFamilyPicker({
  value,
  onChange,
  extensions,
}: {
  value: string;
  onChange: (next: string) => void;
  extensions: ExtensionInfo[];
}) {
  const options = buildFontOptions(extensions);
  const split = splitFontStack(value, options);

  return (
    <>
      <label className="settings-row">
        <span className="settings-label">Font family</span>
        <select
          className="dialog-input settings-select"
          value={split.primaryValue}
          onChange={(e) => {
            const opt = options.find((o) => o.value === e.target.value);
            if (opt) {
              onChange(composeFontStack(opt.families, split.secondaryFamilies, split.fallback));
            }
          }}
        >
          {options.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      </label>

      <label className="settings-row">
        <span className="settings-label">Secondary font</span>
        <select
          className="dialog-input settings-select"
          value={split.secondaryValue}
          onChange={(e) => {
            if (e.target.value === NO_SECONDARY_VALUE) {
              onChange(composeFontStack(split.primaryFamilies, [], split.fallback));
              return;
            }
            const opt = options.find((o) => o.value === e.target.value);
            if (opt) {
              onChange(composeFontStack(split.primaryFamilies, opt.families, split.fallback));
            }
          }}
        >
          <option value={NO_SECONDARY_VALUE}>None</option>
          {options
            .filter((o) => o.value !== split.primaryValue && o.families.length > 0)
            .map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
        </select>
      </label>

      <FallbackFontsField
        // Remounts (resetting its own draft state) when the primary or
        // secondary selection changes — the fallback text is only ever
        // meant to track its own edits, not a picker swap that just
        // happened.
        key={`${split.primaryValue}:${split.secondaryValue}`}
        value={split.fallback}
        onChange={(next) => onChange(composeFontStack(split.primaryFamilies, split.secondaryFamilies, next))}
      />
    </>
  );
}

// Draft-buffered like NumberField above: keystrokes shouldn't fight a value
// that's re-derived (via splitFontStack) from what was just typed. Commits
// on blur/Enter rather than every keystroke, so mid-edit text (an unfinished
// family name before its trailing comma) is never re-parsed and reformatted
// out from under the user.
function FallbackFontsField({ value, onChange }: { value: string; onChange: (next: string) => void }) {
  const [draft, setDraft] = useState(value);
  const commit = () => {
    if (draft !== value) onChange(draft);
  };
  return (
    <label className="settings-row">
      <span className="settings-label">Fallback fonts</span>
      <input
        className="dialog-input"
        value={draft}
        placeholder="e.g. Menlo, monospace"
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") (e.target as HTMLInputElement).blur();
        }}
      />
    </label>
  );
}
