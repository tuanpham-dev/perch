import { useCallback, useEffect, useState, type MutableRefObject } from "react";
import {
  loadExtensions,
  setExtensionSettingsOverrides,
} from "../extensions";
import type { AppSettings, ExtensionSettingsValues } from "../settings";
import {
  applyColorThemeCssVars,
  syncThemeColorMeta,
  loadColorTheme,
  resolveColorThemeValue,
  setActiveTokenTheme,
  terminalTheme as builtInTerminalTheme,
  type ResolvedColorTheme,
} from "../theme";
import type { ExtensionInfo } from "../types";
import { applyExtensionFonts, useExtensionFontsVersion } from "../utils/fonts";
import { resolveIconThemeValue, setActiveIconTheme } from "../utils/iconThemes";

// Extensions list + reload, color/icon theme resolution+application, extension
// fonts, and the terminal-metrics CSS vars — everything that resolves
// settings + the installed-extensions list into applied visual assets on
// <html>/the terminal. Takes the live `settings` object and the extensionSettings
// state (+ its ref, for reloadExtensions' pre-activation push) from
// useSettingsSync, since asset resolution depends on both.
export function useThemeAssets(
  settings: AppSettings,
  extensionSettings: ExtensionSettingsValues,
  extensionSettingsRef: MutableRefObject<ExtensionSettingsValues>,
) {
  // Extensions: fetches the installed list and activates every enabled
  // client entry (commands/viewers/panels register themselves into
  // extensions.ts's module-level registries — see useExtensionRegistry).
  // reloadExtensions is re-called after install/uninstall/enable/disable in
  // the Settings dialog so this list and the color/icon theme dropdowns
  // stay current without a full page reload.
  const [extensions, setExtensions] = useState<ExtensionInfo[]>([]);
  // True once the installed list is actually known (not the pre-fetch []) —
  // the color-theme effect below gates on it so an extension theme never
  // spuriously resolves to "builtin" against the empty list.
  const [extensionsLoaded, setExtensionsLoaded] = useState(false);
  const reloadExtensions = useCallback(() => {
    // Pushes the current (localStorage-seeded, or already-merged-with-server)
    // overrides into extensions.ts's module-level store as soon as the list
    // is fetched — before any client entry's activate() runs — so
    // ctx.settings.get() already resolves correctly the first time an
    // extension reads it, rather than only after this component re-renders.
    // The list state is set from the same pre-activation callback: the theme
    // resolution (and the terminal first-build gate riding on it) only needs
    // the list, and must not wait behind every other extension activating.
    loadExtensions((list) => {
      setExtensionSettingsOverrides(extensionSettingsRef.current, list);
      setExtensions(list);
      setExtensionsLoaded(true);
    }).catch(() => {});
  }, []);
  useEffect(() => {
    reloadExtensions();
  }, [reloadExtensions]);

  // Keeps the module-level resolved-settings store (and any already-
  // activated extension's onDidChange subscribers) current whenever the
  // overrides themselves change (a user edit, or the server doc arriving)
  // or the extension list changes (enable/disable, install/uninstall).
  useEffect(() => {
    setExtensionSettingsOverrides(extensionSettings, extensions);
  }, [extensionSettings, extensions]);

  // Active color theme: resolves settings.colorTheme against the installed
  // extension list, loads+parses the theme JSON (cached in theme.ts), then
  // applies its CSS vars to <html> and hands its terminal palette to every
  // TerminalView. "" or an unresolvable value both mean "built-in".
  const [colorTheme, setColorTheme] = useState<ResolvedColorTheme | null>(null);
  // False until the FIRST resolution against the real installed list has
  // fully completed (theme JSON loaded, or resolved to builtin/failed).
  // Never goes false again — later theme switches keep the previous theme
  // live while the new JSON loads, same as before.
  const [themeSettled, setThemeSettled] = useState(false);
  useEffect(() => {
    if (!extensionsLoaded) return;
    const target = resolveColorThemeValue(settings.colorTheme, extensions);
    if (!target) {
      setColorTheme(null);
      applyColorThemeCssVars(null);
      syncThemeColorMeta();
      setActiveTokenTheme({}, []);
      setThemeSettled(true);
      return;
    }
    let cancelled = false;
    loadColorTheme(target.extensionId, target.path)
      .then((resolved) => {
        if (cancelled) return;
        setColorTheme(resolved);
        applyColorThemeCssVars(resolved.cssVars);
        syncThemeColorMeta();
        setActiveTokenTheme(resolved.colors, resolved.tokenColors);
        setThemeSettled(true);
      })
      .catch((err) => {
        console.error(`failed to load color theme "${settings.colorTheme}":`, err);
        if (!cancelled) {
          setColorTheme(null);
          applyColorThemeCssVars(null);
          syncThemeColorMeta();
          setActiveTokenTheme({}, []);
          setThemeSettled(true);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [settings.colorTheme, extensions, extensionsLoaded]);
  // null until the initial resolution settles. TerminalView holds its first
  // engine build on this: an extension terminal theme used to arrive AFTER
  // the terminal had already built with the builtin palette, and the theme
  // flip remounts the whole terminal (ghostty can't swap themes at runtime)
  // — every first load visibly built, tore down, and rebuilt each terminal.
  const activeTerminalTheme = themeSettled ? (colorTheme?.terminalTheme ?? builtInTerminalTheme) : null;

  // Active icon theme: same resolve-against-installed-extensions shape as
  // color themes above, but applied through iconThemes.ts's own module
  // state (FileTree subscribes to it directly via useIconThemeVersion)
  // rather than App-level React state, since nothing here needs the result.
  useEffect(() => {
    setActiveIconTheme(resolveIconThemeValue(settings.iconTheme, extensions)).catch(() => {});
  }, [settings.iconTheme, extensions]);

  // Extension-contributed terminal fonts: loads only the families actually
  // present in settings.fontFamily (primary or fallback) — same selected-
  // only asset policy as the color/icon theme effects above. Reconciles on
  // both a font-picker change and an extension enable/disable/install/
  // uninstall, so a font's FontFace is added/removed through one path.
  // fontsVersion is handed to every TerminalView so it can force a re-
  // measure once a face it's configured to use actually finishes loading.
  useEffect(() => {
    applyExtensionFonts(extensions, settings.fontFamily, {
      medium: settings.fontWeight === "medium",
      boldIsNormal: settings.fontWeightBold === "normal",
    }).catch(() => {});
  }, [settings.fontFamily, settings.fontWeight, settings.fontWeightBold, extensions]);
  const fontsVersion = useExtensionFontsVersion();

  // Non-terminal UI elements that want "whatever monospace metrics the user
  // actually configured for the terminal" (styles.css's .terminal-link-
  // tooltip; git-scm's diff viewer) read these vars instead of hard-coding
  // their own — keeps them in sync with the Settings pickers without
  // needing their own settings plumbing. Units are baked in here (fontSize/
  // letterSpacing are plain pixel numbers, lineHeight a unitless multiplier
  // — same as CSS's own line-height) so a consumer never has to guess.
  useEffect(() => {
    const root = document.documentElement.style;
    root.setProperty("--terminal-font", settings.fontFamily);
    root.setProperty("--terminal-font-size", `${settings.fontSize}px`);
    root.setProperty("--terminal-line-height", `${settings.lineHeight}`);
    root.setProperty("--terminal-letter-spacing", `${settings.letterSpacing}px`);
  }, [settings.fontFamily, settings.fontSize, settings.lineHeight, settings.letterSpacing]);

  return { extensions, reloadExtensions, colorTheme, activeTerminalTheme, fontsVersion };
}
