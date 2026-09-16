import type { TerminalTheme } from "./engines/types";
import { extensionFileUrl } from "./api";
import type { ExtensionInfo } from "./types";

// Plastic Legacy (hadialqattan.plastic-legacy-1.0.0), extracted from the
// user's code-server instance. Terminal background/cursor/selection use VS
// Code's fallback chain since the theme doesn't define them. This stays the
// built-in default and the ultimate fallback for every workbench key below.
export const terminalTheme: TerminalTheme = {
  background: "#21252B",
  foreground: "#A9B2C3",
  cursor: "#A9B2C3",
  cursorAccent: "#21252B",
  selectionBackground: "#A9B2C333",
  black: "#21252B",
  red: "#E06C75",
  green: "#98C379",
  yellow: "#D19A66",
  blue: "#61AFEF",
  magenta: "#B57EDC",
  cyan: "#56B6C2",
  white: "#A9B2C3",
  brightBlack: "#5F6672",
  brightRed: "#D74E42",
  brightGreen: "#69c52e",
  brightYellow: "#E9D16C",
  brightBlue: "#1085FF",
  brightMagenta: "#8B00FF",
  brightCyan: "#08E8DE",
  brightWhite: "#D4D7D9",
};

// terminal.* / terminalCursor.* keys, each with VS Code's own documented
// fallback chain — ANSI colors have no workbench-level fallback, so a theme
// missing them keeps the built-in Plastic Legacy ANSI palette. Keyed by
// string rather than `keyof TerminalTheme`: this object only fills the
// terminal.* chains, not every TerminalTheme field (cursorAccent,
// selectionForeground, …), so typing it against the full interface would
// force populating those too.
const TERMINAL_KEY_CHAINS: Record<string, string[]> = {
  background: ["terminal.background", "editor.background"],
  foreground: ["terminal.foreground", "editor.foreground"],
  cursor: ["terminalCursor.foreground", "terminal.foreground"],
  cursorAccent: ["terminalCursor.background", "terminal.background"],
  selectionBackground: ["terminal.selectionBackground", "editor.selectionBackground"],
  black: ["terminal.ansiBlack"],
  red: ["terminal.ansiRed"],
  green: ["terminal.ansiGreen"],
  yellow: ["terminal.ansiYellow"],
  blue: ["terminal.ansiBlue"],
  magenta: ["terminal.ansiMagenta"],
  cyan: ["terminal.ansiCyan"],
  white: ["terminal.ansiWhite"],
  brightBlack: ["terminal.ansiBrightBlack"],
  brightRed: ["terminal.ansiBrightRed"],
  brightGreen: ["terminal.ansiBrightGreen"],
  brightYellow: ["terminal.ansiBrightYellow"],
  brightBlue: ["terminal.ansiBrightBlue"],
  brightMagenta: ["terminal.ansiBrightMagenta"],
  brightCyan: ["terminal.ansiBrightCyan"],
  brightWhite: ["terminal.ansiBrightWhite"],
};

function pick(colors: Record<string, string>, keys: string[]): string | undefined {
  for (const key of keys) {
    if (colors[key]) return colors[key];
  }
  return undefined;
}

function buildTerminalTheme(colors: Record<string, string>): TerminalTheme {
  const builtIn = terminalTheme as unknown as Record<string, string>;
  const result: Record<string, string> = {};
  for (const [field, chain] of Object.entries(TERMINAL_KEY_CHAINS)) {
    result[field] = pick(colors, chain) ?? builtIn[field];
  }
  return result as unknown as TerminalTheme;
}

// Workbench key chains for the UI CSS vars in styles.css. Each entry is
// tried in order; the first key present in the theme's `colors` wins. A var
// with no match here is left unset by applyColorTheme, so it keeps
// resolving through styles.css's own var(--base-tone) chain — e.g. a theme
// that only sets editor.background (--bg) but not tab.activeBackground
// still recolors --tab-active-bg for free, since --tab-active-bg: var(--bg)
// is itself re-evaluated against the (now overridden) --bg.
const CSS_VAR_KEY_CHAINS: Record<string, string[]> = {
  "--bg": ["editor.background"],
  "--fg": ["editor.foreground"],
  "--fg-bright": ["foreground"],
  "--fg-inactive": ["descriptionForeground", "disabledForeground"],
  "--panel-bg": ["sideBar.background", "panel.background"],
  "--titlebar-bg": ["titleBar.activeBackground"],
  "--titlebar-fg": ["titleBar.activeForeground"],
  "--commandcenter-bg": ["commandCenter.background"],
  "--commandcenter-fg": ["commandCenter.foreground", "titleBar.activeForeground"],
  "--commandcenter-border": ["commandCenter.border"],
  "--commandcenter-active-bg": ["commandCenter.activeBackground"],
  "--commandcenter-active-border": ["commandCenter.activeBorder"],
  "--border": ["panel.border", "sideBar.border", "widget.border"],
  "--input-bg": ["input.background"],
  "--accent": ["focusBorder"],
  // Distinct from --accent: focusBorder is a border/outline color (VS Code
  // itself only ever renders it as a thin ring or 1-2px edge), so a theme is
  // free to make it low-contrast against the editor background — One Dark
  // Pro's focusBorder (#3e4452 on #282c34, ~1.4:1) is nearly invisible as
  // body text. textLink.foreground is the workbench key VS Code themes
  // actually design to be read as text, so anything rendering an accent
  // color AS TEXT (not a border) should use --fg-accent instead.
  "--fg-accent": ["textLink.foreground"],
  "--button": ["button.background"],
  "--error": ["errorForeground"],
  "--hover": ["list.hoverBackground"],
  "--selection": ["list.activeSelectionBackground", "list.inactiveSelectionBackground"],

  "--tab-bar-bg": ["editorGroupHeader.tabsBackground"],
  "--tab-inactive-bg": ["tab.inactiveBackground"],
  "--tab-inactive-fg": ["tab.inactiveForeground"],
  "--tab-active-bg": ["tab.activeBackground"],
  "--tab-active-fg": ["tab.activeForeground"],
  "--tab-active-border": ["tab.activeBorderTop", "tab.activeBorder"],
  "--tab-border": ["tab.border"],

  "--list-hover-bg": ["list.hoverBackground"],
  "--list-active-bg": ["list.activeSelectionBackground"],
  "--list-active-fg": ["list.activeSelectionForeground"],
  "--sidebar-header-bg": ["sideBarSectionHeader.background"],

  // Deliberately --statusbar-* and not --status-*: --status-idle-bg /
  // --status-active-bg above are the session activity dots, a different
  // thing entirely.
  "--statusbar-bg": ["statusBar.background"],
  "--statusbar-fg": ["statusBar.foreground"],
  "--statusbar-border": ["statusBar.border"],

  "--scrollbar-thumb-bg": ["scrollbarSlider.background"],
  "--scrollbar-thumb-hover-bg": ["scrollbarSlider.hoverBackground"],

  "--input-border": ["input.border"],
  "--focus-border": ["focusBorder"],

  "--button-bg": ["button.background"],
  "--button-fg": ["button.foreground"],
  // extensionButton.* is VS Code's actual key for Disable/Uninstall on an
  // extension's page — button.secondaryBackground is a different, more
  // opaque control (dialog/prompt buttons) and only used as a fallback here
  // for a theme that defines one family but not the other.
  "--button-secondary-bg": ["extensionButton.background", "button.secondaryBackground"],
  "--button-secondary-fg": ["extensionButton.foreground", "button.secondaryForeground"],
  "--button-secondary-border": ["extensionButton.border", "button.border"],
  "--button-secondary-hover-bg": ["extensionButton.hoverBackground"],

  "--badge-bg": ["badge.background"],
  "--badge-fg": ["badge.foreground"],

  "--git-modified-fg": ["gitDecoration.modifiedResourceForeground"],
  "--git-added-fg": ["gitDecoration.addedResourceForeground"],
  "--git-untracked-fg": ["gitDecoration.untrackedResourceForeground"],
  "--git-renamed-fg": ["gitDecoration.renamedResourceForeground"],
  "--status-idle-bg": ["charts.yellow"],
  "--status-active-bg": ["charts.green"],
  "--warning": ["editorWarning.foreground"],
};

// ---- tokenColors (syntax highlighting) ----
//
// VS Code's tokenColors are TextMate scope rules, resolved via full
// scope-stack matching against a real grammar — this app doesn't attempt
// that resolution itself. It just parses and exposes the raw rules (below)
// so a consumer that DOES run a real TextMate tokenizer (extensions/
// text-editor, via Shiki) can resolve them properly. See
// getActiveTokenColors/subscribeColorTheme.

export interface TokenColorRule {
  scope?: string | string[];
  settings?: { foreground?: string; fontStyle?: string };
}

function scopesOf(rule: TokenColorRule): string[] {
  const s = rule.scope;
  if (!s) return [];
  return Array.isArray(s) ? s : s.split(",").map((x) => x.trim());
}

// ---- active-theme module state ----
//
// Same subscribe-from-a-module-var shape as utils/iconThemes.ts's
// active/listeners/notify — extensions (text-editor's Shiki tokenizer) read
// the active theme's raw colors/tokenColors through this rather than
// re-fetching the theme file themselves (they can't: ctx.assetUrl only
// resolves paths within their OWN extension, not the active theme
// extension's).
let activeColors: Record<string, string> = {};
let activeTokenColors: TokenColorRule[] = [];
const themeListeners = new Set<() => void>();
function notifyThemeListeners(): void {
  for (const l of themeListeners) l();
}
export function subscribeColorTheme(cb: () => void): () => void {
  themeListeners.add(cb);
  return () => themeListeners.delete(cb);
}
export function setActiveTokenTheme(colors: Record<string, string>, tokenColors: TokenColorRule[]): void {
  activeColors = colors;
  activeTokenColors = tokenColors;
  notifyThemeListeners();
}
export function getActiveThemeColors(): Record<string, string> {
  return activeColors;
}
export function getActiveTokenColors(): TokenColorRule[] {
  return activeTokenColors;
}

const ALL_THEME_VAR_NAMES = Object.keys(CSS_VAR_KEY_CHAINS);

function buildCssVars(colors: Record<string, string>): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [varName, chain] of Object.entries(CSS_VAR_KEY_CHAINS)) {
    const value = pick(colors, chain);
    if (value) result[varName] = value;
  }
  return result;
}

// Comments/trailing commas only — not a full JSON5 parser, but VS Code
// theme files in the wild stick to these two extensions of plain JSON.
function stripJsonComments(input: string): string {
  let out = "";
  let inString = false;
  let inLineComment = false;
  let inBlockComment = false;
  let escaped = false;
  for (let i = 0; i < input.length; i++) {
    const c = input[i];
    const next = input[i + 1];
    if (inLineComment) {
      if (c === "\n") {
        inLineComment = false;
        out += c;
      }
      continue;
    }
    if (inBlockComment) {
      if (c === "*" && next === "/") {
        inBlockComment = false;
        i++;
      }
      continue;
    }
    if (inString) {
      out += c;
      if (escaped) escaped = false;
      else if (c === "\\") escaped = true;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') {
      inString = true;
      out += c;
      continue;
    }
    if (c === "/" && next === "/") {
      inLineComment = true;
      i++;
      continue;
    }
    if (c === "/" && next === "*") {
      inBlockComment = true;
      i++;
      continue;
    }
    out += c;
  }
  return out;
}

// Shared with utils/iconThemes.ts — icon theme JSON follows the same
// comments-and-trailing-commas convention as color theme JSON.
export function parseJsonc(text: string): unknown {
  const stripped = stripJsonComments(text).replace(/,(\s*[}\]])/g, "$1");
  return JSON.parse(stripped);
}

interface ThemeJson {
  colors?: Record<string, string>;
  include?: string;
  tokenColors?: TokenColorRule[];
}

function parseThemeJson(text: string): ThemeJson {
  return parseJsonc(text) as ThemeJson;
}

// Resolves `include` (and any other extension-relative path found inside a
// theme file) relative to the *theme file's own* directory, not the
// extension root — matching VS Code's own resolution rule. Exported for
// utils/iconThemes.ts, which resolves icon/font paths the same way.
export function joinRelPath(fromRelPath: string, relOrDotPath: string): string {
  const baseDir = fromRelPath.includes("/") ? fromRelPath.slice(0, fromRelPath.lastIndexOf("/")) : "";
  const combined = baseDir ? `${baseDir}/${relOrDotPath}` : relOrDotPath;
  const resolved: string[] = [];
  for (const part of combined.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") resolved.pop();
    else resolved.push(part);
  }
  return resolved.join("/");
}

async function fetchThemeFile(extensionId: string, relPath: string): Promise<ThemeJson> {
  const res = await fetch(extensionFileUrl(extensionId, relPath));
  if (!res.ok) throw new Error(`failed to load theme file: ${res.status}`);
  return parseThemeJson(await res.text());
}

export interface ResolvedColorTheme {
  terminalTheme: TerminalTheme;
  cssVars: Record<string, string>;
  colors: Record<string, string>;
  tokenColors: TokenColorRule[];
}

const themeCache = new Map<string, Promise<ResolvedColorTheme>>();

export function loadColorTheme(extensionId: string, themeRelPath: string): Promise<ResolvedColorTheme> {
  const cacheKey = `${extensionId} ${themeRelPath}`;
  const cached = themeCache.get(cacheKey);
  if (cached) return cached;

  const promise = (async () => {
    const doc = await fetchThemeFile(extensionId, themeRelPath);
    let colors: Record<string, string> = {};
    let tokenColors: TokenColorRule[] = [];
    if (typeof doc.include === "string") {
      try {
        const includeRelPath = joinRelPath(themeRelPath, doc.include);
        const includeDoc = await fetchThemeFile(extensionId, includeRelPath);
        colors = { ...includeDoc.colors };
        tokenColors = [...(includeDoc.tokenColors ?? [])];
      } catch {
        // Missing/unreadable include — fall through with just this theme's
        // own colors rather than failing the whole theme.
      }
    }
    colors = { ...colors, ...doc.colors };
    // Concatenated, not merged-by-key like colors: an includer's own rules
    // are appended after the base file's, matching real VS Code's own
    // "include's rules first, this file's own after" order (colorThemeData.ts's
    // tokenColors getter processes an include before the includer for the
    // same reason) — a real TextMate resolver's specificity-then-last-wins
    // rule picks the includer's override for any scope both define.
    tokenColors = [...tokenColors, ...(doc.tokenColors ?? [])];
    return {
      terminalTheme: buildTerminalTheme(colors),
      cssVars: buildCssVars(colors),
      colors,
      tokenColors,
    };
  })();
  themeCache.set(cacheKey, promise);
  return promise;
}

// The page's theme-color paints the phone status bar, the installed app's
// normal title bar, and - with the title bar hidden - the band behind the
// window controls, so it follows the active theme's title bar color instead
// of staying on the built-in dark value. Read back computed, so a theme
// without titleBar.activeBackground lands on --titlebar-bg's own fallback.
export function syncThemeColorMeta(): void {
  const color = getComputedStyle(document.documentElement).getPropertyValue("--titlebar-bg").trim();
  if (!color) return;
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", color);
}

// Sets/clears the CSS var overrides on <html> — call with null to fall back
// to the hard-coded Plastic Legacy values in styles.css's :root (still the
// rendering floor for an unresolvable theme — extension disabled/
// uninstalled — even though Plastic Legacy is no longer itself a selectable
// option; see extensions/plastic-legacy-theme for the selectable version).
export function applyColorThemeCssVars(cssVars: Record<string, string> | null): void {
  const root = document.documentElement.style;
  for (const name of ALL_THEME_VAR_NAMES) root.removeProperty(name);
  if (!cssVars) return;
  for (const [name, value] of Object.entries(cssVars)) root.setProperty(name, value);
}

export interface ColorThemeOption {
  value: string; // `${extensionId}:${themeLabel}` — no built-in "" entry
  label: string;
}

export function listColorThemeOptions(extensions: ExtensionInfo[]): ColorThemeOption[] {
  const options: ColorThemeOption[] = [];
  for (const ext of extensions) {
    if (!ext.enabled) continue;
    for (const theme of ext.themes) {
      options.push({ value: `${ext.id}:${theme.label}`, label: `${theme.label} - ${ext.displayName}` });
    }
  }
  return options;
}

// Extension ids never contain ":" (see extensions.ts's SAFE_ID), so the
// first colon unambiguously separates the id from the theme label even if
// the label itself contains one.
export function resolveColorThemeValue(
  value: string,
  extensions: ExtensionInfo[],
): { extensionId: string; path: string } | null {
  if (!value) return null;
  const idx = value.indexOf(":");
  if (idx === -1) return null;
  const extensionId = value.slice(0, idx);
  const label = value.slice(idx + 1);
  const ext = extensions.find((e) => e.id === extensionId && e.enabled);
  const theme = ext?.themes.find((t) => t.label === label);
  return theme ? { extensionId, path: theme.path } : null;
}
