// Loads/unloads extension-contributed terminal fonts (contributes.fonts —
// see server/src/extensions.ts's FontGroupContribution comment) as runtime
// FontFaces, same mechanism as utils/iconThemes.ts's loadFontFace but with a
// different policy: icon fonts always load for the active icon theme, text
// fonts load ONLY when their family is actually present in the configured
// settings.fontFamily stack — matching the selected-only asset policy color
// and icon themes already follow. Faces register under their real family
// names (unlike icon fonts' namespaced ext-icon-font-* families) so the
// stack string can reference them directly.
//
// A manifest group (e.g. "Hello" bundling a mono font + a Nerd Font symbols
// companion) is purely a Settings-picker concept — selecting it writes every
// family in the group into the stack at once (see fontStack.ts's
// composeFontStack). Loading itself stays per-family: this module flattens
// every enabled extension's groups into a single family → entries map and
// loads/unloads each family independently based on whether it's literally
// present in the stack, so a hand-edited stack that keeps only one family
// from a group never loads the other.
import * as ReactNS from "react";
import { extensionFileUrl } from "../api";
import type { ExtensionFontEntry, ExtensionInfo } from "../types";
import { parseFontStack } from "./fontStack";

// The fontWeight/fontWeightBold-derived registration mode. A mode flip
// re-registers the family (see applyExtensionFontsInternal).
export interface WeightMode {
  // Ordinary text renders in the font's medium (500) face when available.
  medium: boolean;
  // Bold text renders in the same face as ordinary text.
  boldIsNormal: boolean;
}

function modeKey(mode: WeightMode): string {
  return `${mode.medium ? "medium" : "normal"}/${mode.boldIsNormal ? "boldIsNormal" : "boldIsBold"}`;
}

interface LoadedFamily {
  faces: FontFace[];
  mode: string;
}

// Keyed by `${extensionId}::${family}` — the same family name contributed by
// two different extensions is tracked (and can be unloaded) independently.
const loaded = new Map<string, LoadedFamily>();

const listeners = new Set<() => void>();
function notify(): void {
  for (const l of listeners) l();
}

// TerminalView subscribes (via useExtensionFontsVersion) to force a
// re-measure once a font it's configured to use actually finishes loading —
// see App.tsx's fontsVersion plumbing.
export function subscribeExtensionFonts(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

export function useExtensionFontsVersion(): number {
  const [tick, setTick] = ReactNS.useState(0);
  ReactNS.useEffect(() => subscribeExtensionFonts(() => setTick((t) => t + 1)), []);
  return tick;
}

function isRegularWeight(weight: string | undefined): boolean {
  return !weight || weight === "normal" || weight === "400";
}

function isMediumWeight(weight: string | undefined): boolean {
  return weight === "500" || weight === "medium";
}

function isBoldishWeight(weight: string | undefined): boolean {
  if (weight === "bold") return true;
  const n = Number(weight);
  return Number.isFinite(n) && n >= 600;
}

// Weight-mode support: ghostty-web draws cells with a plain
// `<size>px <family>` canvas font (`bold <size>px <family>` for bold cells)
// and lets the browser's font matching pick the face, so both weight
// settings are implemented purely by choosing which declared sources get
// registered under which weight descriptors. Only the faces the current
// settings can actually match are registered — and since a skipped entry
// never becomes a FontFace, its file is never fetched:
//  - fontWeight "medium": each style's 500-weight sources become the text
//    face; regular sources are skipped (they'd win the weight-400 match).
//    Styles without a 500 source fall back to their regular one.
//  - fontWeightBold "normal": the chosen text face spans ALL weights
//    ("1 1000") so bold lookups resolve to it too; bold sources are
//    skipped and their files never download.
//  - fontWeightBold "bold": the text face covers "1 599", declared bold
//    (600+) sources keep their own weights, and everything in between
//    (e.g. an unused 500 when fontWeight is "normal") is skipped.
// A style with no text-face candidate at all keeps its declared faces
// as-is. System fonts later in the stack aren't registered here at all, so
// they keep their native weights — documented limitation of both settings.
export function entriesForMode(
  entries: ExtensionFontEntry[],
  mode: WeightMode,
): { entry: ExtensionFontEntry; weight: string }[] {
  const byStyle = new Map<string, ExtensionFontEntry[]>();
  for (const entry of entries) {
    const style = entry.style ?? "normal";
    byStyle.set(style, [...(byStyle.get(style) ?? []), entry]);
  }
  const out: { entry: ExtensionFontEntry; weight: string }[] = [];
  for (const styleEntries of byStyle.values()) {
    const regulars = styleEntries.filter((e) => isRegularWeight(e.weight));
    const mediums = styleEntries.filter((e) => isMediumWeight(e.weight));
    const text = mode.medium && mediums.length > 0 ? mediums : regulars;
    if (text.length === 0) {
      for (const entry of styleEntries) out.push({ entry, weight: entry.weight ?? "normal" });
      continue;
    }
    if (mode.boldIsNormal) {
      for (const entry of text) out.push({ entry, weight: "1 1000" });
      continue;
    }
    for (const entry of text) out.push({ entry, weight: "1 599" });
    for (const entry of styleEntries) {
      if (isBoldishWeight(entry.weight)) out.push({ entry, weight: entry.weight ?? "normal" });
    }
  }
  return out;
}

async function loadFamily(
  extensionId: string,
  family: string,
  entries: ExtensionFontEntry[],
  mode: WeightMode,
): Promise<LoadedFamily> {
  const faces = await Promise.all(
    entriesForMode(entries, mode).map(async ({ entry, weight }) => {
      const sources = entry.src
        .map((s) => `url(${JSON.stringify(extensionFileUrl(extensionId, s.path))}) format(${JSON.stringify(s.format)})`)
        .join(", ");
      const face = new FontFace(family, sources, {
        weight,
        style: entry.style ?? "normal",
        ...(entry.unicodeRange ? { unicodeRange: entry.unicodeRange } : {}),
      });
      await face.load();
      document.fonts.add(face);
      return face;
    }),
  );
  return { faces, mode: modeKey(mode) };
}

// Reconciles registered FontFaces against "families present in
// fontFamilyStack that an enabled extension contributes" — loads whatever's
// newly selected/enabled, deletes whatever's been deselected/disabled/
// uninstalled. Call from App.tsx on both settings.fontFamily changes and
// extension-list reloads, so every transition (pick a font, remove it from
// the stack, disable its extension, uninstall it) goes through one path.
//
// Queued through fontsQueue rather than called directly: two overlapping
// calls (e.g. React StrictMode's dev double-invoke of the same effect) would
// otherwise both see the same family as "not yet loaded" — both check
// `loaded` before either awaits its face load — and each register its own
// FontFace for it, leaving duplicates. Serializing means the second call's
// read of `loaded` happens after the first call's write.
let fontsQueue: Promise<void> = Promise.resolve();

export function applyExtensionFonts(
  extensions: ExtensionInfo[],
  fontFamilyStack: string,
  mode: WeightMode,
): Promise<void> {
  // Swallowed here (not left to the caller) so one failed reconcile can't
  // permanently wedge the queue — every later call chains off a resolved
  // promise regardless of how this one turns out.
  const run = fontsQueue.then(() =>
    applyExtensionFontsInternal(extensions, fontFamilyStack, mode),
  );
  fontsQueue = run.catch(() => {});
  return run;
}

async function applyExtensionFontsInternal(
  extensions: ExtensionInfo[],
  fontFamilyStack: string,
  mode: WeightMode,
): Promise<void> {
  const wanted = new Set(parseFontStack(fontFamilyStack));

  const shouldLoad = new Map<
    string,
    { extensionId: string; family: string; entries: ExtensionFontEntry[] }
  >();
  for (const ext of extensions) {
    if (!ext.enabled) continue;
    const byFamily = new Map<string, ExtensionFontEntry[]>();
    // The same underlying font entry can legitimately appear in more than
    // one group (e.g. a symbols font offered both bundled into a combo group
    // and on its own — see hello-extension) — dedupe by its actual content
    // rather than by which group referenced it, or picking that family loads
    // one redundant duplicate FontFace per extra group it's listed in.
    const seenEntryKeys = new Set<string>();
    for (const group of ext.fonts) {
      for (const font of group.fonts) {
        if (!wanted.has(font.family)) continue;
        const entryKey = `${font.family} ${font.weight ?? "normal"} ${font.style ?? "normal"} ${JSON.stringify(font.src)}`;
        if (seenEntryKeys.has(entryKey)) continue;
        seenEntryKeys.add(entryKey);
        const entries = byFamily.get(font.family) ?? [];
        entries.push(font);
        byFamily.set(font.family, entries);
      }
    }
    for (const [family, entries] of byFamily) {
      shouldLoad.set(`${ext.id}::${family}`, { extensionId: ext.id, family, entries });
    }
  }

  let changed = false;

  for (const [key, entry] of loaded) {
    // A fontWeight/fontWeightBold flip re-registers everything: the same
    // family needs different faces/weight descriptors under another mode.
    if (!shouldLoad.has(key) || entry.mode !== modeKey(mode)) {
      for (const face of entry.faces) document.fonts.delete(face);
      loaded.delete(key);
      changed = true;
    }
  }

  const toLoad = [...shouldLoad.entries()].filter(([key]) => !loaded.has(key));
  await Promise.all(
    toLoad.map(async ([key, { extensionId, family, entries }]) => {
      try {
        loaded.set(key, await loadFamily(extensionId, family, entries, mode));
        changed = true;
      } catch (err) {
        console.error(`extension ${extensionId}: failed to load font "${family}":`, err);
      }
    }),
  );

  if (changed) notify();
}

// Manifest-only listing for the Settings font-family select — no font bytes
// fetched, just the group names/family lists every enabled extension
// declares. Each group is ONE selectable option even though it can expand to
// several families at once (see composeFontStack).
export interface ExtensionFontOption {
  value: string;
  label: string;
  families: string[];
}

export function listExtensionFontOptions(extensions: ExtensionInfo[]): ExtensionFontOption[] {
  const options: ExtensionFontOption[] = [];
  for (const ext of extensions) {
    if (!ext.enabled) continue;
    for (const group of ext.fonts) {
      const families: string[] = [];
      for (const font of group.fonts) {
        if (!families.includes(font.family)) families.push(font.family);
      }
      if (families.length === 0) continue;
      options.push({
        value: `${ext.id}::${group.group}`,
        label: `${group.group} - ${ext.displayName}`,
        families,
      });
    }
  }
  return options;
}
