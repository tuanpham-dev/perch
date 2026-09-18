// Syntax highlighting for the diff viewer, on highlight.js — the highlighter
// this repo already ships (markdown-preview bundles it, and this uses the
// same github-dark stylesheet, so a diff and a markdown code block are
// coloured alike). Core plus a fixed language set: 58KB minified, against
// the ~5MB a full editor would cost to embed.
//
// The whole file's visible code is highlighted in ONE pass and then split
// per line, rather than line by line, so a block comment or a template
// literal keeps its colour across the lines it spans. Splitting afterwards
// is done over the DOM rather than over the HTML string: highlight.js nests
// spans and lets them cross newlines, which no amount of string slicing
// survives intact.
import hljs from "highlight.js/lib/core";
import bash from "highlight.js/lib/languages/bash";
import c from "highlight.js/lib/languages/c";
import cpp from "highlight.js/lib/languages/cpp";
import csharp from "highlight.js/lib/languages/csharp";
import css from "highlight.js/lib/languages/css";
import diff from "highlight.js/lib/languages/diff";
import go from "highlight.js/lib/languages/go";
import ini from "highlight.js/lib/languages/ini";
import java from "highlight.js/lib/languages/java";
import javascript from "highlight.js/lib/languages/javascript";
import json from "highlight.js/lib/languages/json";
import kotlin from "highlight.js/lib/languages/kotlin";
import lua from "highlight.js/lib/languages/lua";
import markdown from "highlight.js/lib/languages/markdown";
import php from "highlight.js/lib/languages/php";
import python from "highlight.js/lib/languages/python";
import ruby from "highlight.js/lib/languages/ruby";
import rust from "highlight.js/lib/languages/rust";
import scss from "highlight.js/lib/languages/scss";
import shell from "highlight.js/lib/languages/shell";
import sql from "highlight.js/lib/languages/sql";
import swift from "highlight.js/lib/languages/swift";
import typescript from "highlight.js/lib/languages/typescript";
import xml from "highlight.js/lib/languages/xml";
import yaml from "highlight.js/lib/languages/yaml";

const LANGUAGES: Record<string, unknown> = {
  bash,
  c,
  cpp,
  csharp,
  css,
  diff,
  go,
  ini,
  java,
  javascript,
  json,
  kotlin,
  lua,
  markdown,
  php,
  python,
  ruby,
  rust,
  scss,
  shell,
  sql,
  swift,
  typescript,
  xml,
  yaml,
};

let registered = false;

function ensureRegistered() {
  if (registered) return;
  for (const [name, lang] of Object.entries(LANGUAGES)) {
    hljs.registerLanguage(name, lang as Parameters<typeof hljs.registerLanguage>[1]);
  }
  registered = true;
}

// File extension (or a whole filename, for the ones that have no extension)
// to the language this module registered.
const BY_EXTENSION: Record<string, string> = {
  bash: "bash",
  c: "c",
  cc: "cpp",
  cjs: "javascript",
  conf: "ini",
  cpp: "cpp",
  cs: "csharp",
  css: "css",
  cts: "typescript",
  diff: "diff",
  go: "go",
  h: "c",
  hpp: "cpp",
  htm: "xml",
  html: "xml",
  ini: "ini",
  java: "java",
  js: "javascript",
  json: "json",
  jsonc: "json",
  jsx: "javascript",
  kt: "kotlin",
  kts: "kotlin",
  lua: "lua",
  markdown: "markdown",
  md: "markdown",
  mjs: "javascript",
  mts: "typescript",
  patch: "diff",
  php: "php",
  py: "python",
  rb: "ruby",
  rs: "rust",
  scss: "scss",
  sh: "bash",
  sql: "sql",
  svg: "xml",
  swift: "swift",
  toml: "ini",
  ts: "typescript",
  tsx: "typescript",
  xml: "xml",
  yaml: "yaml",
  yml: "yaml",
  zsh: "bash",
};

const BY_FILENAME: Record<string, string> = {
  dockerfile: "bash",
  makefile: "bash",
  ".bashrc": "bash",
  ".zshrc": "bash",
  ".gitconfig": "ini",
};

export function languageFor(path: string | undefined | null): string | null {
  if (!path) return null;
  const name = path.toLowerCase().split("/").pop() ?? "";
  if (BY_FILENAME[name]) return BY_FILENAME[name];
  const dot = name.lastIndexOf(".");
  if (dot === -1) return null;
  return BY_EXTENSION[name.slice(dot + 1)] ?? null;
}

export interface HlToken {
  text: string;
  /** highlight.js class names, styled by its stylesheet. Empty for plain text. */
  cls: string;
}

// Walk the highlighted DOM, cutting at every newline, so each source line
// gets its own token list with the classes that were open at that point.
function splitByLine(root: ParentNode): HlToken[][] {
  const lines: HlToken[][] = [[]];
  const walk = (node: ParentNode, cls: string) => {
    for (const child of Array.from(node.childNodes)) {
      if (child.nodeType === Node.TEXT_NODE) {
        const parts = (child.textContent ?? "").split("\n");
        parts.forEach((part, i) => {
          if (i > 0) lines.push([]);
          if (part) lines[lines.length - 1].push({ text: part, cls });
        });
      } else if (child.nodeType === Node.ELEMENT_NODE) {
        const el = child as HTMLElement;
        // highlight.js nests spans; the innermost class is the specific one
        // and is what its stylesheet colours.
        walk(el, el.className || cls);
      }
    }
  };
  walk(root, "");
  return lines;
}

/**
 * Tokens per line for `code`, or null when the language isn't one this
 * module carries (the caller then renders plain text).
 */
export function highlightLines(code: string, language: string | null): HlToken[][] | null {
  if (!language || !code) return null;
  ensureRegistered();
  if (!hljs.getLanguage(language)) return null;
  try {
    const html = hljs.highlight(code, { language, ignoreIllegals: true }).value;
    const template = document.createElement("template");
    // highlight.js escapes the source it emits, so this is its own output
    // being re-parsed, not anything from a repository.
    template.innerHTML = html;
    return splitByLine(template.content);
  } catch {
    return null;
  }
}

// ---- Light/dark for the token stylesheet ----
//
// github-dark.css is what this module imports (the same sheet
// markdown-preview uses), so on a light theme its token colours have to be
// overridden. Which is which is decided the same way markdown-preview
// decides it: the perceived brightness of the app's own --bg.
const LIGHT_THRESHOLD = 140;

function cssColorBrightness(value: string): number | null {
  const hex = value.trim().match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i);
  if (hex) {
    const h = hex[1];
    const full = h.length === 3 ? h.split("").map((c) => c + c).join("") : h;
    const r = parseInt(full.slice(0, 2), 16);
    const g = parseInt(full.slice(2, 4), 16);
    const b = parseInt(full.slice(4, 6), 16);
    return 0.299 * r + 0.587 * g + 0.114 * b;
  }
  const rgb = value.trim().match(/^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)/i);
  if (rgb) {
    const [, r, g, b] = rgb;
    return 0.299 * Number(r) + 0.587 * Number(g) + 0.114 * Number(b);
  }
  return null;
}

export function highlightMode(): "light" | "dark" {
  const bg = getComputedStyle(document.documentElement).getPropertyValue("--bg");
  const brightness = cssColorBrightness(bg);
  return brightness !== null && brightness > LIGHT_THRESHOLD ? "light" : "dark";
}
