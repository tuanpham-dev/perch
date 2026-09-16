// Generalizes the old setiIcons.ts (bundled Seti-only) into a loader for any
// VS Code icon theme JSON — font-glyph icons (fontCharacter/fontColor, VS
// Code's Seti/vscode-icons style) and SVG icons (iconPath, Material Icon
// Theme's style), with runtime FontFace loading for an extension's own
// bundled font. Seti itself is now the perch.seti-icons bundled
// extension (see extensions/seti-icons) rather than statically imported
// here; every icon theme, built-in or third-party, loads the same way.
import * as ReactNS from "react";
import { extensionFileUrl } from "../api";
import { joinRelPath, parseJsonc } from "../theme";
import type { ExtensionInfo } from "../types";
import { getFileExtension } from "./fileExtension";

interface IconDef {
  fontCharacter?: string;
  fontColor?: string;
  iconPath?: string;
  fontId?: string;
}

interface FontDef {
  id: string;
  src: { path: string; format: string }[];
  weight?: string;
  style?: string;
}

interface IconThemeDoc {
  fonts?: FontDef[];
  iconDefinitions: Record<string, IconDef>;
  fileExtensions?: Record<string, string>;
  fileNames?: Record<string, string>;
  folderNames?: Record<string, string>;
  folderNamesExpanded?: Record<string, string>;
  languageIds?: Record<string, string>;
  file?: string;
  folder?: string;
  folderExpanded?: string;
}

// Maps a file extension to the VS Code languageId an icon theme's
// `languageIds` map keys on — covers common languages that lack a dedicated
// `fileExtensions` entry in some icon themes (e.g. vscode-icons keys several
// less-common extensions only by languageId). Not exhaustive: an extension
// missing from this table just falls through to the theme's own default file
// icon, same as today.
const LANGUAGE_ID_BY_EXTENSION: Record<string, string> = {
  ts: "typescript",
  tsx: "typescriptreact",
  js: "javascript",
  jsx: "javascriptreact",
  mjs: "javascript",
  cjs: "javascript",
  py: "python",
  rs: "rust",
  go: "go",
  rb: "ruby",
  php: "php",
  java: "java",
  kt: "kotlin",
  kts: "kotlin",
  swift: "swift",
  c: "c",
  h: "c",
  cpp: "cpp",
  cc: "cpp",
  cxx: "cpp",
  hpp: "cpp",
  cs: "csharp",
  css: "css",
  scss: "scss",
  less: "less",
  html: "html",
  htm: "html",
  json: "json",
  jsonc: "jsonc",
  yaml: "yaml",
  yml: "yaml",
  xml: "xml",
  md: "markdown",
  sh: "shellscript",
  bash: "shellscript",
  zsh: "shellscript",
  ps1: "powershell",
  sql: "sql",
  lua: "lua",
  pl: "perl",
  r: "r",
  dart: "dart",
  vue: "vue",
  toml: "toml",
  ini: "ini",
};

export type IconResult =
  | { kind: "font"; char: string; color: string; fontFamily: string }
  | { kind: "svg"; url: string }
  | { kind: "none" };

interface LoadedIconTheme {
  doc: IconThemeDoc;
  fontFamilyFor(fontId: string | undefined): string;
  resolveAssetUrl(relPath: string): string;
}

// The "no icon theme" state — an empty iconDefinitions map means
// resolveIconKey always falls through to `kind: "none"`, and FileTree's
// FileIcon already renders an empty spacer <span> for that case, so file
// rows stay aligned with no font/asset loading at all.
const NONE: LoadedIconTheme = {
  doc: { iconDefinitions: {} },
  fontFamilyFor: () => "monospace",
  resolveAssetUrl: (relPath) => relPath,
};

let active: LoadedIconTheme = NONE;
const listeners = new Set<() => void>();
function notify(): void {
  for (const l of listeners) l();
}
export function subscribeIconTheme(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

// FileTree re-renders on icon-theme change even though it reads the `active`
// module var directly (not React state) — same subscribe-to-force-render
// shape as extensions.ts's useExtensionRegistry.
export function useIconThemeVersion(): number {
  const [version, setVersion] = ReactNS.useState(0);
  ReactNS.useEffect(() => subscribeIconTheme(() => setVersion((v) => v + 1)), []);
  return version;
}

const loadedFontFamilies = new Map<string, string>();

// font.src / iconPath entries are relative to the icon theme file's own
// directory, not the extension root — same resolution rule as a color
// theme's `include` (see theme.ts's joinRelPath).
async function loadFontFace(extensionId: string, themeRelPath: string, font: FontDef): Promise<string> {
  const cacheKey = `${extensionId}:${font.id}`;
  const cached = loadedFontFamilies.get(cacheKey);
  if (cached) return cached;
  const family = `ext-icon-font-${extensionId.replace(/[^a-zA-Z0-9]/g, "-")}-${font.id}`;
  const sources = font.src
    .map(
      (s) =>
        `url(${JSON.stringify(extensionFileUrl(extensionId, joinRelPath(themeRelPath, s.path)))}) format(${JSON.stringify(s.format)})`,
    )
    .join(", ");
  const face = new FontFace(family, sources, { weight: font.weight ?? "normal", style: font.style ?? "normal" });
  await face.load();
  document.fonts.add(face);
  loadedFontFamilies.set(cacheKey, family);
  return family;
}

const themeCache = new Map<string, Promise<LoadedIconTheme>>();

function loadIconTheme(extensionId: string, relPath: string): Promise<LoadedIconTheme> {
  const cacheKey = `${extensionId} ${relPath}`;
  const cached = themeCache.get(cacheKey);
  if (cached) return cached;
  const promise = (async () => {
    const res = await fetch(extensionFileUrl(extensionId, relPath));
    if (!res.ok) throw new Error(`failed to load icon theme: ${res.status}`);
    const doc = parseJsonc(await res.text()) as IconThemeDoc;
    const fontFamilies = new Map<string, string>();
    for (const font of doc.fonts ?? []) {
      try {
        fontFamilies.set(font.id, await loadFontFace(extensionId, relPath, font));
      } catch (err) {
        console.error(`icon theme ${extensionId}: failed to load font "${font.id}":`, err);
      }
    }
    const defaultFontId = doc.fonts?.[0]?.id;
    return {
      doc,
      fontFamilyFor: (fontId: string | undefined) => fontFamilies.get(fontId ?? defaultFontId ?? "") ?? "monospace",
      resolveAssetUrl: (assetRelPath: string) => extensionFileUrl(extensionId, joinRelPath(relPath, assetRelPath)),
    };
  })();
  themeCache.set(cacheKey, promise);
  return promise;
}

// "" / an unresolvable value both mean "no icon theme" — mirrors
// applyColorThemeCssVars(null) in theme.ts.
export async function setActiveIconTheme(target: { extensionId: string; path: string } | null): Promise<void> {
  if (!target) {
    active = NONE;
    notify();
    return;
  }
  try {
    active = await loadIconTheme(target.extensionId, target.path);
  } catch (err) {
    console.error("failed to activate icon theme:", err);
    active = NONE;
  }
  notify();
}

function convertGlyph(fontChar: string | undefined): string {
  if (!fontChar) return "";
  return String.fromCharCode(parseInt(fontChar.replace(/\\/g, ""), 16));
}

function resolveIconKey(iconKey: string | undefined, fallbackColor: string): IconResult {
  if (!iconKey) return { kind: "none" };
  const def = active.doc.iconDefinitions[iconKey];
  if (!def) return { kind: "none" };
  if (def.iconPath) return { kind: "svg", url: active.resolveAssetUrl(def.iconPath) };
  return {
    kind: "font",
    char: convertGlyph(def.fontCharacter),
    color: def.fontColor || fallbackColor,
    fontFamily: active.fontFamilyFor(def.fontId),
  };
}

export function getFileIconResult(fileName: string): IconResult {
  const lowerName = fileName.toLowerCase();
  const doc = active.doc;
  let iconKey = doc.fileNames?.[lowerName];
  const lastExt = getFileExtension(lowerName);
  if (!iconKey) {
    const parts = lowerName.split(".");
    if (parts.length > 2) iconKey = doc.fileExtensions?.[parts.slice(-2).join(".")];
    if (!iconKey && lastExt) iconKey = doc.fileExtensions?.[lastExt];
  }
  if (!iconKey && lastExt) {
    const languageId = LANGUAGE_ID_BY_EXTENSION[lastExt];
    if (languageId) iconKey = doc.languageIds?.[languageId];
  }
  if (!iconKey) iconKey = doc.file;
  return resolveIconKey(iconKey, "#d4d7d6");
}

export function getFolderIconResult(folderName: string, isExpanded: boolean): IconResult {
  const lowerName = folderName.toLowerCase();
  const doc = active.doc;
  const map = isExpanded ? doc.folderNamesExpanded : doc.folderNames;
  let iconKey = map?.[lowerName];
  if (!iconKey) iconKey = isExpanded ? doc.folderExpanded : doc.folder;
  return resolveIconKey(iconKey, "#ccc");
}

export interface IconThemeOption {
  value: string; // "" = no icon theme; else `${extensionId}:${iconThemeId}`
  label: string;
}

export function listIconThemeOptions(extensions: ExtensionInfo[]): IconThemeOption[] {
  const options: IconThemeOption[] = [{ value: "", label: "None" }];
  for (const ext of extensions) {
    if (!ext.enabled) continue;
    for (const theme of ext.iconThemes) {
      options.push({ value: `${ext.id}:${theme.id}`, label: `${theme.label} - ${ext.displayName}` });
    }
  }
  return options;
}

export function resolveIconThemeValue(
  value: string,
  extensions: ExtensionInfo[],
): { extensionId: string; path: string } | null {
  if (!value) return null;
  const idx = value.indexOf(":");
  if (idx === -1) return null;
  const extensionId = value.slice(0, idx);
  const themeId = value.slice(idx + 1);
  const ext = extensions.find((e) => e.id === extensionId && e.enabled);
  const theme = ext?.iconThemes.find((t) => t.id === themeId);
  return theme ? { extensionId, path: theme.path } : null;
}
