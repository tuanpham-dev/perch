import { useEffect, useMemo, useState } from "react";
import type { MouseEvent as ReactMouseEvent } from "react";
import { createPortal } from "react-dom";
import { allExpanded, collapseAllNested, JsonView as JsonTree } from "react-json-view-lite";
import type { StyleProps } from "react-json-view-lite/dist/DataRenderer";
import { applyEdits, format as formatJson } from "jsonc-parser";
import { parseAllDocuments } from "yaml";
import "react-json-view-lite/dist/index.css";
import "./style.css";
import { fetchFileText, saveFileText } from "../../_shared/fileApi";
import { copyText } from "../../_shared/clipboard";
import { injectStylesheet } from "../../_shared/injectStylesheet";
import Icon from "../../_shared/Icon";
import { checkDiskConflict } from "../../_shared/diskConflict";

const YAML_EXTENSIONS = new Set(["yml", "yaml"]);

// Set once from activate() — read-through so flipping json.clickAction in
// Settings applies live (the registered mode below is a thunk, same
// mechanism as markdown-preview's markdown.clickAction).
interface SettingsApi {
  get(key: string): unknown;
}

let extSettings: SettingsApi | null = null;
// ctx.app.pickItem, for the "changed on disk" question on save.
type PickItemFn = (opts: { title: string; items: { id: string; label: string; detail?: string; icon?: string }[] }) => Promise<string | null>;
let pickItem: PickItemFn | null = null;

function readClickAction(): "edit" | "preview" {
  return extSettings?.get("json.clickAction") === "preview" ? "preview" : "edit";
}

interface Props {
  filePath: string;
  active: boolean;
  toolbarTarget?: HTMLDivElement | null;
  openInEditor?: (path: string) => void;
  fontSize?: number;
  // Bumped by the host when an open/preview action re-targets this
  // already-open tab — the tree mirrors disk (no in-memory edits to lose),
  // so just re-fetch.
  reloadKey?: number;
}

// Points every StyleProps hook at classes defined in the host's styles.css
// (against this app's own CSS variables) instead of the library's built-in
// light/dark presets, which ship their own hardcoded palette.
const jsonTheme: StyleProps = {
  container: "json-tree",
  basicChildStyle: "json-tree-child",
  label: "json-tree-label",
  clickableLabel: "json-tree-label json-tree-label-clickable",
  nullValue: "json-tree-null",
  undefinedValue: "json-tree-undefined",
  numberValue: "json-tree-number",
  stringValue: "json-tree-string",
  booleanValue: "json-tree-boolean",
  otherValue: "json-tree-other",
  punctuation: "json-tree-punctuation",
  expandIcon: "json-tree-expand-icon",
  collapseIcon: "json-tree-collapse-icon",
  collapsedContent: "json-tree-collapsed",
  childFieldsContainer: "json-tree-children",
  stringifyStringValues: true,
  ariaLables: { collapseJson: "Collapse", expandJson: "Expand" },
};

type FlatEntry = { path: string; value: unknown };

function flatten(value: unknown, path = ""): FlatEntry[] {
  if (value === null || typeof value !== "object") return [{ path: path || "(root)", value }];
  const out: FlatEntry[] = [];
  if (Array.isArray(value)) {
    out.push({ path: path || "(root)", value: `[${value.length}]` });
    value.forEach((item, i) => out.push(...flatten(item, path ? `${path}[${i}]` : `[${i}]`)));
  } else {
    const obj = value as Record<string, unknown>;
    out.push({ path: path || "(root)", value: `{${Object.keys(obj).length}}` });
    for (const [key, val] of Object.entries(obj)) out.push(...flatten(val, path ? `${path}.${key}` : key));
  }
  return out;
}

function valuePreview(v: unknown): string {
  if (v === null) return "null";
  if (typeof v === "string") return `"${v.length > 60 ? v.slice(0, 60) + "…" : v}"`;
  return String(v);
}

function extOf(filePath: string): string {
  const dot = filePath.lastIndexOf(".");
  return dot === -1 ? "" : filePath.slice(dot + 1).toLowerCase();
}

// Past this many keys and items the tree opens collapsed: expanding a huge
// document all at once freezes the page.
const EXPAND_LIMIT = 2000;

function nodeCountOver(value: unknown, limit: number): boolean {
  let count = 0;
  const stack: unknown[] = [value];
  while (stack.length > 0) {
    const v = stack.pop();
    if (++count > limit) return true;
    if (v && typeof v === "object") stack.push(...(Array.isArray(v) ? v : Object.values(v as Record<string, unknown>)));
  }
  return false;
}

// YAML text as data: one document as itself, several (a Kubernetes file
// with --- between resources) as a list of them.
function parseYamlText(text: string): unknown {
  const docs = parseAllDocuments(text);
  const list = Array.isArray(docs) ? docs : [docs];
  for (const doc of list) {
    if (doc.errors.length > 0) throw new Error(doc.errors[0].message);
  }
  const values = list.map((doc) => doc.toJS());
  return values.length === 1 ? values[0] : values;
}

function JsonView({ filePath, active, toolbarTarget, openInEditor, fontSize = 14, reloadKey }: Props) {
  const basename = filePath.slice(filePath.lastIndexOf("/") + 1);
  const isYaml = YAML_EXTENSIONS.has(extOf(filePath));
  const [content, setContent] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  // The user's Expand all / Collapse all choice, for the document it was made
  // on; until they choose, a document opens expanded only when it's small.
  const [expandChoice, setExpandChoice] = useState<{ for: string; expand: boolean } | null>(null);
  const [refreshTick, setRefreshTick] = useState(0);
  const [searchQuery, setSearchQuery] = useState("");
  const [copiedPath, setCopiedPath] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  // Re-fetched on reloadKey too: the host bumps it when an explicit open/
  // preview action lands on this already-open tab, and this view is a
  // read-only mirror of the file on disk.
  useEffect(() => {
    setLoadError(null);
    fetchFileText(filePath)
      .then(setContent)
      .catch((err) => setLoadError(err instanceof Error ? err.message : String(err)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filePath, reloadKey, refreshTick]);

  const parsed = useMemo(() => {
    if (content === null) return { ok: false as const, error: null };
    try {
      return { ok: true as const, value: isYaml ? parseYamlText(content) : JSON.parse(content) };
    } catch (err) {
      return { ok: false as const, error: err instanceof Error ? err.message : String(err) };
    }
  }, [content, isYaml]);

  // Worked out during render, not in an effect, so a big document's first
  // paint is already collapsed.
  const smallEnough = useMemo(() => parsed.ok && !nodeCountOver(parsed.value, EXPAND_LIMIT), [parsed]);
  const expandAll = expandChoice && expandChoice.for === content ? expandChoice.expand : smallEnough;
  const setExpandAll = (expand: boolean) => setExpandChoice({ for: content ?? "", expand });

  const searchResults = useMemo(() => {
    if (!searchQuery.trim() || !parsed.ok) return [];
    const q = searchQuery.toLowerCase();
    return flatten(parsed.value)
      .filter((e) => e.path.toLowerCase().includes(q) || String(e.value).toLowerCase().includes(q))
      .slice(0, 30);
  }, [searchQuery, parsed]);

  const copyPath = (path: string) => {
    copyText(path).catch(() => {});
    setCopiedPath(path);
    setTimeout(() => setCopiedPath(null), 1500);
  };

  // react-json-view-lite has no onValueClick hook (no editing API at all —
  // this stays read-only), so this is plain event delegation: every leaf
  // value is a <span> tagged with one of our own theme classes, nothing
  // else. The flash is a direct DOM class toggle rather than React state,
  // since it's transient feedback on a node React itself doesn't own the
  // identity of between re-renders.
  const handleTreeClick = (e: ReactMouseEvent) => {
    const target = (e.target as HTMLElement).closest<HTMLElement>(
      ".json-tree-string, .json-tree-number, .json-tree-boolean, .json-tree-null, .json-tree-other",
    );
    if (!target) return;
    // A string shows quoted and escaped; what's copied is its value.
    let text = target.textContent ?? "";
    if (target.classList.contains("json-tree-string")) {
      try {
        const value: unknown = JSON.parse(text);
        if (typeof value === "string") text = value;
      } catch {
        // shown some other way: copy it as shown
      }
    }
    copyText(text).catch(() => {});
    target.classList.add("json-tree-value-copied");
    setTimeout(() => target.classList.remove("json-tree-value-copied"), 400);
  };

  const handleCopy = () => {
    if (!parsed.ok) return;
    copyText(JSON.stringify(parsed.value, null, 2)).catch(() => {});
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  // Whitespace only: keys stay in their order, numbers keep their digits and
  // duplicate keys stay, unlike a parse-and-print round trip.
  const handleFormatAndSave = async () => {
    if (!parsed.ok || content === null) return;
    setSaving(true);
    setSaveError(null);
    try {
      const choice = await checkDiskConflict({
        name: basename,
        loaded: content,
        readDisk: () => fetchFileText(filePath),
        pick: pickItem ?? undefined,
      });
      if (choice === "cancel") return;
      if (choice === "reload") {
        setRefreshTick((n) => n + 1);
        return;
      }
      let formatted = applyEdits(content, formatJson(content, undefined, { tabSize: 2, insertSpaces: true, eol: "\n" }));
      if (!formatted.endsWith("\n")) formatted += "\n";
      await saveFileText(filePath, formatted);
      setContent(formatted);
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  const controls = (
    <>
      <button
        className="icon-button"
        title={expandAll ? "Collapse all" : "Expand all"}
        onClick={() => setExpandAll(!expandAll)}
      >
        <Icon name={expandAll ? "collapse-all" : "expand-all"} />
      </button>
      <button className="icon-button" title={copied ? "Copied!" : "Copy"} disabled={!parsed.ok} onClick={handleCopy}>
        <Icon name="copy" />
      </button>
      <button className="icon-button" title="Refresh" onClick={() => setRefreshTick((n) => n + 1)}>
        <Icon name="refresh" />
      </button>
      {!isYaml && (
        <button
          className="icon-button"
          title="Format & Save (changes only spacing and line breaks)"
          disabled={!parsed.ok || saving}
          onClick={() => void handleFormatAndSave()}
        >
          <Icon name="save" />
        </button>
      )}
      <button className="icon-button" title="Open in Editor" onClick={() => openInEditor?.(filePath)}>
        <Icon name="file-code" />
      </button>
    </>
  );

  return (
    <div className={`json-host${active ? "" : " hidden"}`}>
      <div className="json-scroll">
        {loadError && (
          <div className="json-status json-error">
            Couldn't load {basename}: {loadError}
          </div>
        )}
        {!loadError && content === null && <div className="json-status">Loading…</div>}
        {!loadError && content !== null && (
          <>
            {saveError && <div className="json-banner json-banner-error">Save failed: {saveError}</div>}
            <div className="json-search-bar">
              <div className="json-search-input-wrap">
                <input
                  className="json-search-input"
                  type="text"
                  placeholder="Search keys or values…"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Escape" && searchQuery) {
                      e.preventDefault();
                      e.stopPropagation();
                      setSearchQuery("");
                    }
                  }}
                />
                {searchQuery && (
                  <button className="json-search-clear" title="Clear" onClick={() => setSearchQuery("")}>
                    <Icon name="close" />
                  </button>
                )}
              </div>
              {searchQuery && (
                <span className="json-search-count">
                  {searchResults.length} result{searchResults.length !== 1 ? "s" : ""}
                </span>
              )}
            </div>
            {searchQuery && searchResults.length > 0 && (
              <div className="json-search-results">
                {searchResults.map((entry) => (
                  <button key={entry.path} className="json-search-result" onClick={() => copyPath(entry.path)}>
                    <span className="json-search-result-path">{entry.path}</span>
                    <span className="json-search-result-value">{valuePreview(entry.value)}</span>
                    <span className="json-search-result-action">
                      {copiedPath === entry.path ? (
                        <>
                          <Icon name="check" /> copied
                        </>
                      ) : (
                        "copy path"
                      )}
                    </span>
                  </button>
                ))}
              </div>
            )}
            {parsed.ok ? (
              <div className="json-tree-wrap" style={{ fontSize }} onClick={handleTreeClick}>
                <JsonTree
                  data={parsed.value as object}
                  shouldExpandNode={expandAll ? allExpanded : collapseAllNested}
                  style={jsonTheme}
                  clickToExpandNode
                />
              </div>
            ) : (
              <>
                <div className="json-banner json-banner-error">{parsed.error}</div>
                <pre className="json-raw">{content}</pre>
              </>
            )}
          </>
        )}
      </div>
      {active && toolbarTarget && createPortal(controls, toolbarTarget)}
    </div>
  );
}

let removeStylesheet: (() => void) | null = null;

export function activate(ctx: {
  registerFileViewer: (v: {
    id: string;
    extensions: string[];
    mode: "default" | "preview" | (() => "default" | "preview");
    component: typeof JsonView;
  }) => void;
  assetUrl: (relPath: string) => string;
  settings: SettingsApi;
  app?: { pickItem?: PickItemFn };
}) {
  extSettings = ctx.settings;
  pickItem = ctx.app?.pickItem ?? null;
  removeStylesheet = injectStylesheet(ctx.assetUrl, "dist/client.css");
  ctx.registerFileViewer({
    id: "jsonViewer",
    extensions: ["json", ...YAML_EXTENSIONS],
    // A thunk, so flipping json.clickAction applies live: "preview" makes a
    // FILES-tree click open this tree directly ("default" mode), "edit"
    // keeps the click on nvim with the tree behind the Preview affordances
    // — same mechanism as markdown-preview's markdown.clickAction.
    mode: () => (readClickAction() === "preview" ? "default" : "preview"),
    component: JsonView,
  });
}

export function deactivate() {
  removeStylesheet?.();
  removeStylesheet = null;
  extSettings = null;
  pickItem = null;
}
