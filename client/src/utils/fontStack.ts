// Parse/serialize helpers for the CSS font-family stack stored as the plain
// string settings.fontFamily — shared by SettingsView's structured picker
// (which needs to read/write individual family names) and utils/fonts.ts
// (which needs to know which extension-contributed families are actually
// selected). The stack itself stays the single source of truth; these are
// pure functions, not state.

// Splits on top-level commas and strips wrapping quotes for display. Font-
// family values never contain a comma inside a single family name, so a
// plain split is safe (matches the CSS spec's own comma-separated-list
// grammar for this property).
export function parseFontStack(stack: string): string[] {
  return stack
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => {
      if ((s.startsWith("'") && s.endsWith("'")) || (s.startsWith('"') && s.endsWith('"'))) {
        return s.slice(1, -1);
      }
      return s;
    });
}

// Re-quotes any family containing whitespace, a comma, or a quote character
// so the result round-trips losslessly through parseFontStack.
export function serializeFontStack(families: string[]): string {
  return families
    .map((f) => (/[\s,'"]/.test(f) ? `'${f.replace(/'/g, "\\'")}'` : f))
    .join(", ");
}

// Appends a freeform fallback CSS stack (as typed into the Settings fallback
// field) after the primary and secondary families a font-picker option
// resolved to (one family for a plain font, several for an extension group)
// — re-quoting the whole result so it round-trips through parseFontStack
// regardless of how the fallback text was formatted.
export function composeFontStack(
  primaryFamilies: string[],
  secondaryFamilies: string[],
  fallbackCss: string,
): string {
  return serializeFontStack([...primaryFamilies, ...secondaryFamilies, ...parseFontStack(fallbackCss)]);
}

export interface FontStackOption {
  value: string;
  // Empty for the "use fallback fonts" option (see FALLBACK_ONLY_VALUE) —
  // contributes nothing to the primary portion of the stack, and is never a
  // match target in splitFontStack below (a 0-length prefix always "matches"
  // trivially, which would make it win over every real option).
  families: string[];
}

// The primary select's escape valve: no built-in/extension font picked, the
// entire stack comes from the freeform fallback field instead. Also what
// splitFontStack falls back to when the stored stack's leading family (or
// families) don't match any currently available option — e.g. a font typed
// by hand, or one whose extension got disabled/uninstalled — so there's
// always a valid select value with no separate "custom" mode to fall into.
export const FALLBACK_ONLY_VALUE = "__fallback_only__";

// The secondary select's default — no second font picked, same idea as
// FALLBACK_ONLY_VALUE but for the secondary slot (which is optional
// regardless of what the primary resolved to, so it needs its own sentinel
// rather than reusing the primary's).
export const NO_SECONDARY_VALUE = "__no_secondary__";

export interface FontStackSplit {
  // Always one of the passed-in options' `value`s (including, commonly,
  // FALLBACK_ONLY_VALUE) — never an arbitrary string, so the select always
  // has a matching <option>.
  primaryValue: string;
  primaryFamilies: string[];
  // Same idea, one slot further in — NO_SECONDARY_VALUE when nothing beyond
  // the primary families matched a listed option (including when there's no
  // primary match at all, e.g. "Use fallback fonts").
  secondaryValue: string;
  secondaryFamilies: string[];
  // Whatever's left after primary + secondary, re-serialized — shown
  // verbatim in the Settings fallback text field.
  fallback: string;
}

// Longest matching prefix wins — e.g. a 2-family group is preferred over a
// single-family option that only matches its first member.
function matchLongestPrefix(tokens: string[], options: FontStackOption[]): FontStackOption | null {
  let best: FontStackOption | null = null;
  for (const option of options) {
    if (option.families.length === 0 || option.families.length > tokens.length) continue;
    const matches = option.families.every((family, i) => tokens[i] === family);
    if (matches && (!best || option.families.length > best.families.length)) best = option;
  }
  return best;
}

// Splits a stored settings.fontFamily stack into "primary" (the leading
// family or families, matched against a font option so a multi-family
// extension group round-trips as one selection), "secondary" (the next
// family or families after that, matched the same way — e.g. a powerline/
// Nerd Font companion picked deliberately rather than typed by hand), and
// "fallback" (everything left over). The stack itself is the only state;
// this is a pure derivation, not stored separately, so the picker and a
// hand-edited stack can never drift.
export function splitFontStack(stack: string, options: FontStackOption[]): FontStackSplit {
  const tokens = parseFontStack(stack);

  const primaryMatch = matchLongestPrefix(tokens, options);
  const primaryValue = primaryMatch ? primaryMatch.value : FALLBACK_ONLY_VALUE;
  const primaryFamilies = primaryMatch ? primaryMatch.families : [];
  const afterPrimary = primaryMatch ? tokens.slice(primaryFamilies.length) : tokens;

  // Excludes the primary's own option so the same group can't be picked
  // twice in a row (picking it again would just duplicate its families).
  const secondaryOptions = options.filter((o) => o.value !== primaryValue);
  const secondaryMatch = matchLongestPrefix(afterPrimary, secondaryOptions);
  const secondaryValue = secondaryMatch ? secondaryMatch.value : NO_SECONDARY_VALUE;
  const secondaryFamilies = secondaryMatch ? secondaryMatch.families : [];
  const afterSecondary = secondaryMatch ? afterPrimary.slice(secondaryFamilies.length) : afterPrimary;

  return {
    primaryValue,
    primaryFamilies,
    secondaryValue,
    secondaryFamilies,
    fallback: serializeFontStack(afterSecondary),
  };
}
