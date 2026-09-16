// search: a VS Code-style SEARCH sidebar panel — search and replace across
// every file under the active folder. SearchPanel takes no props
// (registerSidebarPanel's component signature) and reads the small set of
// host hooks (serverFetch, active context, settings, openFileTab/
// refreshFiles) from module-level bridge variables set once in activate(),
// the same pattern git-scm's client.tsx uses.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent, MouseEvent as ReactMouseEvent, ReactNode } from "react";
import { createPortal } from "react-dom";
import "./style.css";
import { copyText } from "../../_shared/clipboard";
import { injectStylesheet } from "../../_shared/injectStylesheet";
import Icon from "../../_shared/Icon";
import type { MenuItem } from "../../_shared/types";
import { useListNavigation } from "../../_shared/useListNavigation";
import { useLongPressMenu } from "../../_shared/useLongPressMenu";

// ---- Module-level host bridge ----

interface ActiveContext {
  sessionName: string | null;
  windowIndex: number | null;
  cwd: string | null;
}
interface SettingsApi {
  get(key: string): unknown;
  onDidChange(cb: () => void): () => void;
}

let serverFetch: ((path: string, init?: RequestInit) => Promise<Response>) | null = null;
let getActiveContext: (() => ActiveContext) | null = null;
let onDidChangeContext: ((cb: (ctx: ActiveContext) => void) => () => void) | null = null;
let openFileTab: ((path: string, line?: number) => void) | null = null;
let refreshFiles: (() => void) | null = null;
let consumeFindInFolderGlob: (() => string | null) | null = null;
let extSettings: SettingsApi | null = null;
let removeStylesheet: (() => void) | null = null;

function readExcludeHint(): string {
  const raw = extSettings?.get("search.excludeGlobs");
  return typeof raw === "string" && raw.trim() ? raw : "node_modules, .git, dist, build";
}

// ---- Result types (mirrors server.js's /search response) ----

interface Submatch {
  start: number;
  end: number;
}
interface MatchEntry {
  line: number;
  column: number;
  lineText: string;
  submatches: Submatch[];
}
interface FileResult {
  file: string;
  matches: MatchEntry[];
}
interface SearchResponse {
  results: FileResult[];
  limitHit: boolean;
  engine: string;
}
interface Capabilities {
  engine: "ripgrep" | "grep" | "builtin" | "none";
  respectsGitignore: boolean;
  globSupport: "full" | "basic" | "none";
}
interface ReplaceFileResult {
  file: string;
  replaced: number;
  skipped: number;
  error?: string;
}
interface ReplaceResponse {
  results: ReplaceFileResult[];
  totalReplaced: number;
  totalSkipped: number;
}

// ---- Shared fetch helpers ----

class ApiError extends Error {}

async function apiPostJson<T>(path: string, body: unknown, signal?: AbortSignal): Promise<T> {
  const res = await serverFetch!(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });
  const data = await res.json().catch(() => ({}) as Record<string, never>);
  if (!res.ok) throw new ApiError((data as { error?: string }).error || `${res.status} ${res.statusText}`);
  return data as T;
}

async function apiGetJson<T>(path: string): Promise<T> {
  const res = await serverFetch!(path);
  const data = await res.json().catch(() => ({}) as Record<string, never>);
  if (!res.ok) throw new ApiError((data as { error?: string }).error || `${res.status} ${res.statusText}`);
  return data as T;
}

// ---- Small helpers ----

function basenameOf(p: string): string {
  return p.slice(p.lastIndexOf("/") + 1);
}
function dirOf(p: string): string {
  const slash = p.lastIndexOf("/");
  return slash === -1 ? "" : p.slice(0, slash);
}

function renderHighlighted(lineText: string, submatches: Submatch[]) {
  const parts: ReactNode[] = [];
  let last = 0;
  submatches.forEach((sm, i) => {
    if (sm.start > last) parts.push(lineText.slice(last, sm.start));
    parts.push(
      <mark key={i} className="search-match-highlight">
        {lineText.slice(sm.start, sm.end)}
      </mark>,
    );
    last = sm.end;
  });
  if (last < lineText.length) parts.push(lineText.slice(last));
  return parts;
}

function totalMatchCount(results: FileResult[]): number {
  return results.reduce((sum, r) => sum + r.matches.length, 0);
}

// ---- Per-session search state ----
// The panel is a single sidebar instance shared across every session,
// so its own React state would otherwise be one global search box that just
// gets re-scoped (and its results blown away) every time the active session
// changes. Instead, each session's query/filters/results/replace state is
// cached here and swapped in/out on session change — switching back to a
// session shows exactly what was left there, like a per-session search tab.
interface SessionSearchState {
  query: string;
  caseSensitive: boolean;
  wholeWord: boolean;
  isRegex: boolean;
  globsOpen: boolean;
  includeGlob: string;
  excludeGlob: string;
  useExcludeSettings: boolean;
  replaceOpen: boolean;
  replaceQuery: string;
  results: FileResult[] | null;
  collapsedFiles: Set<string>;
  error: string | null;
  limitHit: boolean;
}

function makeDefaultSessionState(): SessionSearchState {
  return {
    query: "",
    caseSensitive: false,
    wholeWord: false,
    isRegex: false,
    globsOpen: false,
    includeGlob: "",
    excludeGlob: "",
    useExcludeSettings: true,
    replaceOpen: false,
    replaceQuery: "",
    results: null,
    collapsedFiles: new Set(),
    error: null,
    limitHit: false,
  };
}

// Module-level (not a component ref!) because Sidebar.tsx only renders the
// active extension panel — switching to Explorer/Source Control and back
// fully unmounts and remounts SearchPanel, which would wipe a useRef-based
// cache. Same pattern as git-scm's module-level sessionCredentials.
const sessionSearchCache = new Map<string, SessionSearchState>();

// Set by a mounted SearchPanel instance (module-level, not a ref, for the
// same "unmounts on tab switch" reason as sessionSearchCache) so the
// "Search: Clear Search Results" command (activate() below) can clear live
// React state, not just the cache entry, when its target session happens to
// be the one currently shown in the panel. Null while unmounted or while
// the mounted instance is showing a different session — the command then
// falls back to clearing only the cache entry, which is picked up the next
// time that session's tab is visited.
let clearActiveSearchBridge: ((sessionKey: string) => void) | null = null;

// ---- SearchPanel (registerSidebarPanel component — no props) ----

interface PanelProps {
  actionsTarget?: HTMLDivElement | null;
  showMenu?: (x: number, y: number, items: MenuItem[]) => void;
}

function SearchPanel({ actionsTarget, showMenu }: PanelProps) {
  // Touch/pen long-press → the same menu right-click opens.
  const bindMenu = useLongPressMenu();
  const [activeContext, setActiveContext] = useState<ActiveContext>(
    () => getActiveContext?.() ?? { sessionName: null, windowIndex: null, cwd: null },
  );
  const activeCwd = activeContext.cwd;
  // Falls back to a fixed key (rather than e.g. cwd) when no session is
  // focused yet, so there's always a single well-defined bucket for the
  // "nothing selected" state instead of one per null-cwd render.
  const sessionKey = activeContext.sessionName ?? "__no-session__";

  const [caps, setCaps] = useState<Capabilities | null>(null);

  const [query, setQuery] = useState("");
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [wholeWord, setWholeWord] = useState(false);
  const [isRegex, setIsRegex] = useState(false);

  const [globsOpen, setGlobsOpen] = useState(false);
  const [includeGlob, setIncludeGlob] = useState("");
  const [excludeGlob, setExcludeGlob] = useState("");
  // VS Code's "Use Exclude Settings and Ignore Files" — on by default and
  // sent on every search regardless of globsOpen, so the default (respect
  // configured excludes + .gitignore) applies even before the user ever
  // opens the include/exclude panel.
  const [useExcludeSettings, setUseExcludeSettings] = useState(true);

  const [replaceOpen, setReplaceOpen] = useState(false);
  const [replaceQuery, setReplaceQuery] = useState("");
  const [confirmReplaceAll, setConfirmReplaceAll] = useState(false);

  const [results, setResults] = useState<FileResult[] | null>(null);
  const [collapsedFiles, setCollapsedFiles] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [limitHit, setLimitHit] = useState(false);

  const abortRef = useRef<AbortController | null>(null);
  const queryInputRef = useRef<HTMLInputElement | null>(null);
  // Session-switch restoration sets query/toggles via the load effect below,
  // which would otherwise also satisfy the as-you-type effect's dependency
  // list and fire a redundant re-search over the state we just restored.
  // Starts true for the same reason skipNextSyncRef does (see below).
  const skipNextAutoSearchRef = useRef(true);
  // Guards the cwd-rescope effect the same way — see skipNextSyncRef.
  // (A value-comparison "did sessionKey change since last run" approach
  // doesn't work here: React's development-mode double-invoke re-runs
  // every mount effect an extra time without resetting refs in between,
  // so a stored "previous sessionKey" can equal the current one on a
  // fresh mount, wrongly re-scoping instead of skipping.)
  const skipNextCwdRescopeRef = useRef(true);
  // On every mount (including a remount after an Explorer/Source Control
  // detour), ALL effects fire once regardless of declaration order or
  // dependency arrays — so the sync effect below would otherwise see this
  // instance's fresh default state (query: "", etc.) and clobber the just-
  // switched-to session's real cache entry before the load effect (which
  // fires in the very same pass) gets a chance to restore it. Starts true
  // so sync's very first run (which happens BEFORE load runs, since sync
  // is declared earlier and both fire in the same initial commit) is
  // always skipped; the load effect also re-arms it for the same-instance
  // sessionKey-change case, where load's restored values only reach sync
  // in the FOLLOWING commit.
  const skipNextSyncRef = useRef(true);

  useEffect(() => onDidChangeContext?.(setActiveContext), []);

  useEffect(() => {
    apiGetJson<Capabilities>("/capabilities")
      .then(setCaps)
      .catch(() => setCaps({ engine: "none", respectsGitignore: false, globSupport: "none" }));
  }, []);

  const runSearch = useCallback(() => {
    if (!activeCwd || !query) {
      setResults(null);
      setError(null);
      setLimitHit(false);
      return;
    }
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setLoading(true);
    setError(null);
    apiPostJson<SearchResponse>(
      "/search",
      {
        cwd: activeCwd,
        query,
        isRegex,
        caseSensitive,
        wholeWord,
        include: includeGlob,
        exclude: excludeGlob,
        useExcludeSettings,
      },
      controller.signal,
    )
      .then((data) => {
        setResults(data.results);
        setLimitHit(data.limitHit);
        setCollapsedFiles(new Set());
      })
      .catch((err: unknown) => {
        if (err instanceof DOMException && err.name === "AbortError") return;
        setResults(null);
        setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (abortRef.current === controller) setLoading(false);
      });
  }, [activeCwd, query, isRegex, caseSensitive, wholeWord, includeGlob, excludeGlob, useExcludeSettings]);

  // Hybrid trigger: 3+ characters search as-you-type (debounced); 1-2
  // characters require Enter (see handleQueryKeyDown) since a 1-2 char
  // query is the expensive, low-value case to run on every keystroke.
  // Deliberately excludes activeCwd/sessionKey — the session/folder-switch
  // effect below owns context-driven (immediate, non-debounced) re-searches,
  // so a context change doesn't fire both effects and issue two overlapping
  // requests.
  useEffect(() => {
    if (skipNextAutoSearchRef.current) {
      skipNextAutoSearchRef.current = false;
      return;
    }
    if (!activeCwd) return;
    if (query.length === 0) {
      abortRef.current?.abort();
      setResults(null);
      setError(null);
      setLimitHit(false);
      setLoading(false);
      return;
    }
    if (query.length < 3) return;
    const timer = window.setTimeout(runSearch, 300);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, caseSensitive, wholeWord, isRegex, includeGlob, excludeGlob, useExcludeSettings]);

  // Continuously mirrors this session's live state into the module-level
  // cache — deliberately NOT keyed on sessionKey itself (see below), so a
  // session switch doesn't fire this with the outgoing session's fields
  // under the incoming session's key. It naturally re-fires (writing the
  // just-loaded values right back under the new key, a harmless no-op)
  // once the load effect below applies the new session's cached fields,
  // since those setState calls touch the same dependencies listed here.
  useEffect(() => {
    if (skipNextSyncRef.current) {
      skipNextSyncRef.current = false;
      return;
    }
    sessionSearchCache.set(sessionKey, {
      query,
      caseSensitive,
      wholeWord,
      isRegex,
      globsOpen,
      includeGlob,
      excludeGlob,
      useExcludeSettings,
      replaceOpen,
      replaceQuery,
      results,
      collapsedFiles,
      error,
      limitHit,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    query,
    caseSensitive,
    wholeWord,
    isRegex,
    globsOpen,
    includeGlob,
    excludeGlob,
    useExcludeSettings,
    replaceOpen,
    replaceQuery,
    results,
    collapsedFiles,
    error,
    limitHit,
  ]);

  // Loads whatever the incoming session last had cached — fires on every
  // sessionKey change AND on mount (including a remount after switching
  // back from Explorer/Source Control, since Sidebar.tsx unmounts inactive
  // extension panels; the cache above is module-level specifically so it
  // survives that). Each session keeps its own independent search instead
  // of one search box shared/reset across all of them.
  useEffect(() => {
    abortRef.current?.abort();
    setLoading(false);
    const restored = sessionSearchCache.get(sessionKey) ?? makeDefaultSessionState();
    skipNextAutoSearchRef.current = true;
    skipNextSyncRef.current = true;
    skipNextCwdRescopeRef.current = true;
    setQuery(restored.query);
    setCaseSensitive(restored.caseSensitive);
    setWholeWord(restored.wholeWord);
    setIsRegex(restored.isRegex);
    setGlobsOpen(restored.globsOpen);
    setIncludeGlob(restored.includeGlob);
    setExcludeGlob(restored.excludeGlob);
    setUseExcludeSettings(restored.useExcludeSettings);
    setReplaceOpen(restored.replaceOpen);
    setReplaceQuery(restored.replaceQuery);
    setResults(restored.results);
    setCollapsedFiles(restored.collapsedFiles);
    setError(restored.error);
    setLimitHit(restored.limitHit);
    setConfirmReplaceAll(false);

    // "Find in Folder…" (FILES-tree folder context menu) — overrides the
    // just-restored include scope with the requested folder and clears the
    // query so the user types fresh into it, mirroring VS Code. Consumed
    // (not just read) so it only ever applies to the mount it was intended
    // for, never to a later unrelated session switch.
    const pendingGlob = consumeFindInFolderGlob?.();
    if (pendingGlob !== null && pendingGlob !== undefined) {
      setIncludeGlob(pendingGlob);
      setGlobsOpen(true);
      setQuery("");
      setResults(null);
      setError(null);
      setLimitHit(false);
      queryInputRef.current?.focus();
    }
  }, [sessionKey]);

  // A same-session cwd change (e.g. `cd`ing within the same window, rather
  // than switching to a different session) re-scopes the existing
  // query against the new folder instead of loading cached state — that's
  // the load effect's job. Guarded by skipNextCwdRescopeRef so the mount/
  // session-switch case (where load's restoration should stand as-is)
  // doesn't get immediately overwritten by this effect also reacting to
  // the very same activeCwd change.
  useEffect(() => {
    if (skipNextCwdRescopeRef.current) {
      skipNextCwdRescopeRef.current = false;
      return;
    }
    if (query) runSearch();
    else setResults(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeCwd]);

  const handleQueryKeyDown = (e: ReactKeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") runSearch();
    if (e.key === "ArrowDown" && resultRowIds.length > 0) {
      e.preventDefault();
      resultNav.focusRow(resultRowIds[0]);
    }
  };

  const clearSearch = () => {
    abortRef.current?.abort();
    setQuery("");
    setResults(null);
    setError(null);
    setLimitHit(false);
  };

  const toggleCollapseAll = () => {
    if (!results) return;
    setCollapsedFiles((prev) => (prev.size > 0 ? new Set() : new Set(results.map((r) => r.file))));
  };

  const toggleFileCollapsed = (file: string) => {
    setCollapsedFiles((prev) => {
      const next = new Set(prev);
      if (next.has(file)) next.delete(file);
      else next.add(file);
      return next;
    });
  };

  const dismissFile = (file: string) => {
    setResults((prev) => (prev ? prev.filter((r) => r.file !== file) : prev));
  };

  const dismissMatch = (file: string, match: MatchEntry) => {
    setResults((prev) =>
      prev
        ? prev
            .map((r) =>
              r.file !== file
                ? r
                : { ...r, matches: r.matches.filter((m) => !(m.line === match.line && m.column === match.column)) },
            )
            .filter((r) => r.matches.length > 0)
        : prev,
    );
  };

  const runReplace = useCallback(
    async (targets: { file: string; matches?: { line: number; start: number }[] }[]) => {
      if (!activeCwd) return;
      setLoading(true);
      setError(null);
      try {
        await apiPostJson<ReplaceResponse>("/replace", {
          cwd: activeCwd,
          query,
          isRegex,
          caseSensitive,
          wholeWord,
          replacement: replaceQuery,
          targets,
        });
        refreshFiles?.();
        runSearch();
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
        setLoading(false);
      }
    },
    [activeCwd, query, isRegex, caseSensitive, wholeWord, replaceQuery, runSearch],
  );

  const replaceOneMatch = (file: string, match: MatchEntry) =>
    runReplace([{ file, matches: [{ line: match.line, start: match.submatches[0]?.start ?? match.column - 1 }] }]);

  const replaceFile = (file: string) => runReplace([{ file }]);

  const replaceAll = () => {
    if (!results) return;
    runReplace(results.map((r) => ({ file: r.file })));
    setConfirmReplaceAll(false);
  };

  const openMatch = (file: string, line: number) => {
    if (!activeCwd) return;
    openFileTab?.(`${activeCwd}/${file}`, line);
  };

  // Read by the "Search: Clear Search Results" command (activate() below)
  // via clearActiveSearchBridge — see that variable's doc comment.
  const sessionKeyRef = useRef(sessionKey);
  sessionKeyRef.current = sessionKey;
  useEffect(() => {
    clearActiveSearchBridge = (key: string) => {
      if (key === sessionKeyRef.current) clearSearch();
    };
    return () => {
      clearActiveSearchBridge = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---- Keyboard navigation + context menus (result rows) ----
  // Rows = one per file-group header plus its visible match rows, in
  // render order — kept in sync by construction with the results.map JSX
  // below, same "flattened list mirrors the render walk" approach
  // FileTree.tsx uses for visibleRows.
  type ResultRow =
    | { kind: "header"; id: string; file: string }
    | { kind: "match"; id: string; file: string; match: MatchEntry };

  const resultRows = useMemo<ResultRow[]>(() => {
    if (!results) return [];
    const out: ResultRow[] = [];
    for (const r of results) {
      out.push({ kind: "header", id: `header:${r.file}`, file: r.file });
      if (!collapsedFiles.has(r.file)) {
        for (const m of r.matches) {
          out.push({ kind: "match", id: `match:${r.file}:${m.line}:${m.column}`, file: r.file, match: m });
        }
      }
    }
    return out;
  }, [results, collapsedFiles]);

  const resultRowsById = useMemo(() => new Map(resultRows.map((r) => [r.id, r])), [resultRows]);
  const resultRowIds = useMemo(() => resultRows.map((r) => r.id), [resultRows]);

  const headerMenuItems = useCallback(
    (file: string): MenuItem[] => {
      const items: MenuItem[] = [{ label: "Open File", onClick: () => openMatch(file, 1) }];
      if (replaceOpen) items.push({ label: "Replace All in File", onClick: () => replaceFile(file) });
      items.push(
        { label: "Copy Path", onClick: () => activeCwd && void copyText(`${activeCwd}/${file}`) },
        { label: "Copy Relative Path", onClick: () => void copyText(file) },
        { label: "Dismiss", onClick: () => dismissFile(file) },
      );
      return items;
    },
    [replaceOpen, activeCwd, openMatch, replaceFile, dismissFile],
  );

  const matchMenuItems = useCallback(
    (file: string, match: MatchEntry): MenuItem[] => {
      const items: MenuItem[] = [{ label: "Open", onClick: () => openMatch(file, match.line) }];
      if (replaceOpen) items.push({ label: "Replace", onClick: () => replaceOneMatch(file, match) });
      items.push(
        { label: "Copy Line Text", onClick: () => void copyText(match.lineText) },
        { label: "Dismiss", onClick: () => dismissMatch(file, match) },
      );
      return items;
    },
    [replaceOpen, openMatch, replaceOneMatch, dismissMatch],
  );

  const resultNav = useListNavigation({
    rowIds: resultRowIds,
    onActivate: (id) => {
      const row = resultRowsById.get(id);
      if (!row) return;
      if (row.kind === "header") toggleFileCollapsed(row.file);
      else openMatch(row.file, row.match.line);
    },
    onExpand: (id) => {
      const row = resultRowsById.get(id);
      if (row?.kind === "header" && collapsedFiles.has(row.file)) toggleFileCollapsed(row.file);
    },
    onCollapse: (id) => {
      const row = resultRowsById.get(id);
      if (row?.kind === "header" && !collapsedFiles.has(row.file)) toggleFileCollapsed(row.file);
    },
    onDelete: (id) => {
      const row = resultRowsById.get(id);
      if (!row) return;
      if (row.kind === "header") dismissFile(row.file);
      else dismissMatch(row.file, row.match);
    },
    onContextMenuKey: (id, rect) => {
      const row = resultRowsById.get(id);
      if (!row) return;
      const items = row.kind === "header" ? headerMenuItems(row.file) : matchMenuItems(row.file, row.match);
      showMenu?.(rect.left + 8, rect.bottom, items);
    },
  });

  const matchCount = useMemo(() => (results ? totalMatchCount(results) : 0), [results]);
  const globPlaceholderHint =
    caps?.engine === "ripgrep" || !caps ? "e.g. *.ts, src/**" : "e.g. *.js, src/** (simple wildcards only)";

  const headerActions = (
    <>
      <button className="icon-button" title="Refresh" disabled={loading || !query} onClick={runSearch}>
        <Icon name="refresh" />
      </button>
      <button
        className="icon-button"
        title={collapsedFiles.size > 0 ? "Expand All" : "Collapse All"}
        disabled={!results || results.length === 0}
        onClick={toggleCollapseAll}
      >
        <Icon name="collapse-all" />
      </button>
      <button className="icon-button" title="Clear Search" disabled={!query} onClick={clearSearch}>
        <Icon name="close-all" />
      </button>
    </>
  );

  if (!activeCwd) {
    return <div className="search-empty">No active directory.</div>;
  }

  return (
    <div className="search-panel">
      {actionsTarget && createPortal(headerActions, actionsTarget)}

      <div className="search-input-row">
        <button
          className="icon-button search-replace-toggle"
          title={replaceOpen ? "Hide Replace" : "Show Replace"}
          onClick={() => setReplaceOpen((v) => !v)}
        >
          <Icon name={replaceOpen ? "chevron-down" : "chevron-right"} />
        </button>
        <div className="search-input-wrap">
          <input
            ref={queryInputRef}
            className="search-text-input"
            placeholder="Search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={handleQueryKeyDown}
            autoFocus
          />
          <div className="search-input-toggles">
            <button
              className={`icon-button search-toggle${caseSensitive ? " active" : ""}`}
              title="Match Case"
              onClick={() => setCaseSensitive((v) => !v)}
            >
              <Icon name="case-sensitive" />
            </button>
            <button
              className={`icon-button search-toggle${wholeWord ? " active" : ""}`}
              title="Match Whole Word"
              onClick={() => setWholeWord((v) => !v)}
            >
              <Icon name="whole-word" />
            </button>
            <button
              className={`icon-button search-toggle${isRegex ? " active" : ""}`}
              title="Use Regular Expression"
              onClick={() => setIsRegex((v) => !v)}
            >
              <Icon name="regex" />
            </button>
          </div>
        </div>
      </div>

      {replaceOpen && (
        <div className="search-input-row">
          <span className="search-replace-spacer" />
          <div className="search-input-wrap">
            <input
              className="search-text-input"
              placeholder="Replace"
              value={replaceQuery}
              onChange={(e) => setReplaceQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") setConfirmReplaceAll(true);
              }}
            />
          </div>
          <button
            className="icon-button"
            title="Replace All"
            disabled={!results || matchCount === 0 || loading}
            onClick={() => setConfirmReplaceAll(true)}
          >
            <Icon name="replace-all" />
          </button>
        </div>
      )}

      <div className="search-details-row">
        <button
          className={`icon-button search-toggle${globsOpen ? " active" : ""}`}
          title={globsOpen ? "Hide Search Details" : "Toggle Search Details"}
          onClick={() => setGlobsOpen((v) => !v)}
        >
          <Icon name="ellipsis" />
        </button>
      </div>

      {globsOpen && (
        <div className="search-globs">
          <label className="search-glob-label" htmlFor="search-include-input">
            files to include
          </label>
          <input
            id="search-include-input"
            className="search-text-input search-glob-input"
            placeholder={globPlaceholderHint}
            value={includeGlob}
            onChange={(e) => setIncludeGlob(e.target.value)}
          />

          <label className="search-glob-label" htmlFor="search-exclude-input">
            files to exclude
          </label>
          <div className="search-input-wrap search-exclude-wrap">
            <input
              id="search-exclude-input"
              className="search-text-input search-glob-input"
              placeholder={globPlaceholderHint}
              value={excludeGlob}
              onChange={(e) => setExcludeGlob(e.target.value)}
            />
            <div className="search-input-toggles search-exclude-toggle">
              <button
                className={`icon-button search-toggle${useExcludeSettings ? " active" : ""}`}
                title="Use Exclude Settings and Ignore Files"
                onClick={() => setUseExcludeSettings((v) => !v)}
              >
                <Icon name="exclude" />
              </button>
            </div>
          </div>
          <div className="search-globs-hint">always excludes: {readExcludeHint()}</div>
        </div>
      )}

      {confirmReplaceAll && (
        <div className="search-confirm">
          <div className="search-confirm-text">
            Replace {matchCount} match{matchCount === 1 ? "" : "es"} in {results?.length ?? 0} file
            {results?.length === 1 ? "" : "s"}?
          </div>
          <div className="search-confirm-buttons">
            <button className="search-confirm-cancel" onClick={() => setConfirmReplaceAll(false)}>
              Cancel
            </button>
            <button className="search-confirm-replace" onClick={replaceAll}>
              Replace All
            </button>
          </div>
        </div>
      )}

      {error && (
        <div className="search-error" onClick={() => setError(null)}>
          {error}
        </div>
      )}

      <div className="search-results" onKeyDown={resultNav.onKeyDown}>
        {loading && !results && <div className="search-empty">Searching…</div>}

        {!loading && results && results.length === 0 && !error && (
          <div className="search-empty">No results found.</div>
        )}

        {results && results.length > 0 && (
          <>
            <div className="search-summary">
              {matchCount} result{matchCount === 1 ? "" : "s"} in {results.length} file
              {results.length === 1 ? "" : "s"}
              {limitHit && " (limit reached — refine your search)"}
            </div>
            {results.map((fileResult) => {
              const collapsed = collapsedFiles.has(fileResult.file);
              const headerId = `header:${fileResult.file}`;
              const headerRowProps = resultNav.getRowProps(headerId);
              return (
                <div className="search-file-group" key={fileResult.file}>
                  <div
                    className="search-group-header"
                    onClick={() => toggleFileCollapsed(fileResult.file)}
                    onContextMenu={(e: ReactMouseEvent) => {
                      e.preventDefault();
                      resultNav.focusRow(headerId);
                      showMenu?.(e.clientX, e.clientY, headerMenuItems(fileResult.file));
                    }}
                    {...bindMenu((x, y) => {
                      resultNav.focusRow(headerId);
                      showMenu?.(x, y, headerMenuItems(fileResult.file));
                    })}
                    tabIndex={headerRowProps.tabIndex}
                    ref={headerRowProps.ref}
                    onFocus={headerRowProps.onFocus}
                  >
                    <Icon name={collapsed ? "chevron-right" : "chevron-down"} />
                    <span className="search-group-name">{basenameOf(fileResult.file)}</span>
                    <span className="search-group-dir">{dirOf(fileResult.file)}</span>
                    <span className="search-group-count">{fileResult.matches.length}</span>
                    <span className="search-group-actions" onClick={(e) => e.stopPropagation()}>
                      {replaceOpen && (
                        <button
                          className="icon-button"
                          title="Replace All in File"
                          disabled={loading}
                          tabIndex={-1}
                          onClick={() => replaceFile(fileResult.file)}
                        >
                          <Icon name="replace-all" />
                        </button>
                      )}
                      <button
                        className="icon-button"
                        title="Dismiss"
                        tabIndex={-1}
                        onClick={() => dismissFile(fileResult.file)}
                      >
                        <Icon name="close" />
                      </button>
                    </span>
                  </div>
                  {!collapsed &&
                    fileResult.matches.map((match) => {
                      const matchId = `match:${fileResult.file}:${match.line}:${match.column}`;
                      const matchRowProps = resultNav.getRowProps(matchId);
                      return (
                        <div
                          className="search-match-row"
                          key={`${match.line}:${match.column}`}
                          onClick={() => openMatch(fileResult.file, match.line)}
                          onContextMenu={(e: ReactMouseEvent) => {
                            e.preventDefault();
                            resultNav.focusRow(matchId);
                            showMenu?.(e.clientX, e.clientY, matchMenuItems(fileResult.file, match));
                          }}
                          {...bindMenu((x, y) => {
                            resultNav.focusRow(matchId);
                            showMenu?.(x, y, matchMenuItems(fileResult.file, match));
                          })}
                          tabIndex={matchRowProps.tabIndex}
                          ref={matchRowProps.ref}
                          onFocus={matchRowProps.onFocus}
                        >
                          <span className="search-match-text">
                            {renderHighlighted(match.lineText, match.submatches)}
                          </span>
                          <span className="search-match-actions" onClick={(e) => e.stopPropagation()}>
                            {replaceOpen && (
                              <button
                                className="icon-button"
                                title="Replace"
                                disabled={loading}
                                tabIndex={-1}
                                onClick={() => replaceOneMatch(fileResult.file, match)}
                              >
                                <Icon name="replace" />
                              </button>
                            )}
                            <button
                              className="icon-button"
                              title="Dismiss"
                              tabIndex={-1}
                              onClick={() => dismissMatch(fileResult.file, match)}
                            >
                              <Icon name="close" />
                            </button>
                          </span>
                        </div>
                      );
                    })}
                </div>
              );
            })}
          </>
        )}
      </div>

      {caps?.engine === "grep" && (
        <div className="search-footer-notice">
          Using grep (ripgrep not found) — search is slower, ignores .gitignore, and file globs are simpler than
          ripgrep's. Install ripgrep (rg) for full functionality.
        </div>
      )}
      {caps?.engine === "builtin" && (
        <div className="search-footer-notice">
          Using the built-in search (ripgrep not found) - slower on large folders, and file globs are simpler than
          ripgrep's. Install ripgrep (rg) for full functionality.
        </div>
      )}
      {caps?.engine === "none" && (
        <div className="search-footer-notice search-footer-error">
          Neither ripgrep nor grep was found on this system — search is unavailable.
        </div>
      )}
    </div>
  );
}

// ---- activate() ----

export function activate(ctx: {
  registerSidebarPanel: (p: {
    id: string;
    title: string;
    icon?: string;
    focusBinding?: string;
    component: typeof SearchPanel;
  }) => void;
  registerCommand: (cmd: { id: string; label: string; defaultBinding?: string; run: () => void }) => void;
  app: {
    getActiveContext: () => ActiveContext;
    onDidChangeContext: (cb: (ctx: ActiveContext) => void) => () => void;
    openFileTab: (path: string, line?: number) => void;
    refreshFiles: () => void;
    consumeFindInFolderGlob: () => string | null;
  };
  serverFetch: (path: string, init?: RequestInit) => Promise<Response>;
  assetUrl: (relPath: string) => string;
  settings: SettingsApi;
}) {
  serverFetch = ctx.serverFetch;
  getActiveContext = ctx.app.getActiveContext;
  onDidChangeContext = ctx.app.onDidChangeContext;
  openFileTab = ctx.app.openFileTab;
  refreshFiles = ctx.app.refreshFiles;
  consumeFindInFolderGlob = ctx.app.consumeFindInFolderGlob;
  extSettings = ctx.settings;

  removeStylesheet = injectStylesheet(ctx.assetUrl, "dist/client.css");
  ctx.registerSidebarPanel({
    id: "search",
    title: "Search",
    icon: "search",
    focusBinding: "ctrl+shift+KeyF",
    component: SearchPanel,
  });

  // Clears whether or not the Search tab is the active sidebar tab — see
  // clearActiveSearchBridge's doc comment for how the mounted-panel case is
  // handled.
  ctx.registerCommand({
    id: "clear",
    label: "Search: Clear Search Results",
    run: () => {
      const active = getActiveContext?.();
      const key = active?.sessionName ?? "__no-session__";
      sessionSearchCache.delete(key);
      clearActiveSearchBridge?.(key);
    },
  });
}

export function deactivate() {
  removeStylesheet?.();
  removeStylesheet = null;
}
