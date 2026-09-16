import { useEffect, useMemo, useRef, useState } from "react";
import * as api from "../api";
import { getContextGetter } from "../contextKeys";
import { getQuickSwitcherResults, useExtensionRegistryVersion } from "../extensions";
import { bindingMatches, serializeEvent, type Keybinding } from "../keybindings";
import type { Tab, TerminalSession } from "../types";
import { isSecondaryClick } from "../utils/platform";

// A palette row — built by App.tsx from keybindings.ts' COMMANDS plus
// extension commands (see paletteCommands there). `enabled` false means the
// command has no context to act on right now (e.g. Window: Rename with no
// active window) — the row renders muted and runEntry ignores it.
export interface PaletteCommand {
  id: string;
  label: string;
  binding: string;
  enabled: boolean;
  run: () => void;
}

interface Props {
  sessions: TerminalSession[];
  tabs: Tab[];
  // Canonical per-tab display label (App.tsx's useTabs hook) — same one
  // TabBar renders, so settings/keyboard-shortcuts/extension-page tabs (no
  // sessionName of their own) get their real title instead of falling
  // through to an empty string.
  tabLabel: (tab: Tab) => string;
  // Folder-derived project label for a session (useTabs' resolver) — the
  // terminal/project rows below never show raw session names.
  projectLabel: (session: string) => string;
  filesRootDir: string | null;
  // Seeds the input on open — "" for a plain switch, ">" to land straight in
  // command-palette mode (see App.tsx's commandPalette.toggle handler).
  initialQuery: string;
  commands: PaletteCommand[];
  // Resolved command-id → combo map (keybindings.ts), same prop TerminalView
  // takes for its terminal.* commands — quickSwitcher.selectNext/Previous are
  // compared against it directly here rather than through the window-level
  // dispatcher (useGlobalKeybindings), since they only make sense while this
  // component owns the input.
  bindings: Record<string, Keybinding[]>;
  onActivateTab: (id: string) => void;
  onOpenWindow: (session: string, index: number) => void;
  onOpenSession: (name: string) => void;
  onOpenFile: (path: string) => void;
  onOpenFileSecondary: (path: string) => void;
  onClose: () => void;
}

interface Entry {
  key: string;
  label: string;
  // Core groups plus extension providers' free-form tags (see
  // registerQuickSwitcherProvider) — the tag renders as the row's chip and
  // feeds the chip's color class.
  group: string;
  // secondary is true for Shift+Enter/Shift+click — see utils/platform.ts's
  // isSecondaryClick. Only file entries branch on it (see App.tsx's
  // openFileOrViewerSecondary); tab/window/session/command entries ignore
  // the argument since they have no secondary action.
  run: (secondary: boolean) => void;
  // Command entries only: shown as a chip on the right, and false disables
  // the row (muted, Enter/click inert) — see PaletteCommand.
  binding?: string;
  disabled?: boolean;
}

// Subsequence match (VS Code Ctrl+P style): every query character must
// appear in the text in order, not necessarily contiguous, so "twsh" matches
// "tw-search:zsh". Returns null on no match, otherwise a score where higher
// is a better match — consecutive runs and matches right after a path/word
// separator score higher, so "term" ranks "TerminalView" above
// "src/other-mismatch". Kept in sync with the server copy in
// server/src/files.ts, which uses it to rank file search results.
const SEPARATORS = new Set(["/", "-", "_", ".", " "]);

function fuzzyScore(query: string, text: string): number | null {
  if (!query) return 0;
  const q = query.toLowerCase();
  const t = text.toLowerCase();
  let qi = 0;
  let score = 0;
  let run = 0;
  let lastTi = -1;
  for (let ti = 0; ti < t.length && qi < q.length; ti++) {
    if (t[ti] !== q[qi]) continue;
    if (lastTi === ti - 1) {
      run++;
      score += run * 5;
    } else {
      run = 0;
    }
    if (ti === 0 || SEPARATORS.has(t[ti - 1])) score += 10;
    lastTi = ti;
    qi++;
  }
  if (qi !== q.length) return null;
  return score - t.length * 0.1;
}

export default function QuickSwitcher({
  sessions,
  tabs,
  tabLabel,
  projectLabel,
  filesRootDir,
  initialQuery,
  commands,
  bindings,
  onActivateTab,
  onOpenWindow,
  onOpenSession,
  onOpenFile,
  onOpenFileSecondary,
  onClose,
}: Props) {
  const [query, setQuery] = useState(initialQuery);
  const [selected, setSelected] = useState(0);
  // Re-render when a quick-switcher provider registers or refresh()es —
  // providerEntries below reads the registry imperatively.
  const registryTick = useExtensionRegistryVersion();
  const [files, setFiles] = useState<string[]>([]);
  const [filesLoading, setFilesLoading] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const isCommandMode = query.startsWith(">");

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // Files are searched server-side per query (debounced): the server
  // fuzzy-filters and returns only the top matches, so a big repo never ships
  // its whole file list to the client. Skipped with no query (the switcher
  // shows files only once a query narrows them) or in command mode (the
  // palette never lists files). Previous results stay visible while the next
  // query is in flight; a stale guard drops a response the query moved past.
  useEffect(() => {
    if (!filesRootDir || isCommandMode || !query) {
      setFiles([]);
      setFilesLoading(false);
      return;
    }
    setFilesLoading(true);
    let stale = false;
    const timer = window.setTimeout(() => {
      api
        .listFiles(filesRootDir, query)
        .then((listing) => {
          if (!stale) setFiles(listing.files);
        })
        .catch(() => {
          if (!stale) setFiles([]);
        })
        .finally(() => {
          if (!stale) setFilesLoading(false);
        });
    }, 150);
    return () => {
      stale = true;
      window.clearTimeout(timer);
    };
  }, [filesRootDir, isCommandMode, query]);

  // Group precedence (open tabs, then windows, then whole sessions) doubles
  // as the ranking: entries are built in that order and the filter is
  // stable, so it's preserved without extra scoring. Windows/sessions
  // already open as a tab are skipped — the tab entry above already reaches
  // them.
  const entries = useMemo<Entry[]>(() => {
    const list: Entry[] = [];
    for (const tab of tabs) {
      list.push({ key: `tab:${tab.id}`, label: tabLabel(tab), group: "tab", run: () => onActivateTab(tab.id) });
    }
    for (const session of sessions) {
      for (const win of session.windows) {
        const alreadyOpen = tabs.some(
          (t) => t.sessionName === session.name && t.windowIndex === win.index,
        );
        if (alreadyOpen) continue;
        list.push({
          key: `window:${session.name}:${win.index}`,
          label: `${projectLabel(session.name)} · ${win.name}`,
          group: "terminal",
          run: () => onOpenWindow(session.name, win.index),
        });
      }
    }
    for (const session of sessions) {
      const alreadyOpen = tabs.some(
        (t) => t.sessionName === session.name && t.windowIndex === undefined,
      );
      if (alreadyOpen) continue;
      list.push({
        key: `session:${session.name}`,
        label: projectLabel(session.name),
        group: "project",
        run: () => onOpenSession(session.name),
      });
    }
    return list;
  }, [sessions, tabs, tabLabel, projectLabel, onActivateTab, onOpenWindow, onOpenSession]);

  // Files arrive already fuzzy-filtered and capped by the server (see the
  // search effect above), ranked after the tab/window/session groups — so
  // this just maps them to rows. Still gated on a non-empty query and
  // non-command mode so nothing shows before a query narrows the list.
  const fileEntries = useMemo<Entry[]>(() => {
    if (isCommandMode || !query || !filesRootDir) return [];
    return files.map((rel) => ({
      key: `file:${rel}`,
      label: rel,
      group: "file",
      run: (secondary) => (secondary ? onOpenFileSecondary : onOpenFile)(`${filesRootDir}/${rel}`),
    }));
  }, [isCommandMode, files, query, filesRootDir, onOpenFile, onOpenFileSecondary]);

  // Extension provider results — non-command mode only (extensions reach
  // the palette through registerCommand already). Ranked between the core
  // tab/window/session groups and file matches.
  const providerEntries = useMemo<Entry[]>(() => {
    if (isCommandMode) return [];
    return getQuickSwitcherResults(query).map(({ provider, item }, i) => ({
      key: `ext:${provider.id}:${i}`,
      label: item.label,
      group: item.tag ?? "ext",
      run: (secondary: boolean) => item.run(secondary),
    }));
    // registryTick re-runs this when a provider registers or refresh()es.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isCommandMode, query, registryTick]);

  // Command mode ("> …"): fuzzy-match the part after ">" against every
  // palette command's label instead of the tab/window/session/file list,
  // ranked best-match-first rather than the commands' declaration order.
  const commandEntries = useMemo<Entry[]>(() => {
    if (!isCommandMode) return [];
    const q = query.slice(1).trim();
    return commands
      .map((c) => ({ c, score: fuzzyScore(q, c.label) }))
      .filter((m): m is { c: PaletteCommand; score: number } => m.score !== null)
      .sort((a, b) => b.score - a.score)
      .map(({ c }) => ({
        key: `command:${c.id}`,
        label: c.label,
        group: "command" as const,
        binding: c.binding,
        disabled: !c.enabled,
        run: () => c.run(),
      }));
  }, [isCommandMode, commands, query]);

  const filtered = useMemo(
    () =>
      isCommandMode
        ? commandEntries
        : [...entries.filter((e) => fuzzyScore(query, e.label) !== null), ...providerEntries, ...fileEntries],
    [isCommandMode, commandEntries, entries, providerEntries, fileEntries, query],
  );

  const showFilesLoading = !isCommandMode && filesRootDir !== null && query.length > 0 && filesLoading;

  // Filtering can shrink the list out from under a selection made against a
  // longer one — clamp rather than let it point past the end.
  const clampedSelected = Math.min(selected, Math.max(0, filtered.length - 1));

  useEffect(() => {
    listRef.current?.children[clampedSelected]?.scrollIntoView({ block: "nearest" });
  }, [clampedSelected]);

  const runEntry = (entry: Entry | undefined, secondary: boolean) => {
    if (!entry || entry.disabled) return;
    // Close before running: a kill/rename command's confirm dialog
    // autofocuses on mount, and that only sticks if the switcher has already
    // unmounted rather than stealing focus back afterward.
    onClose();
    entry.run(secondary);
  };

  return (
    <div className="quick-switcher-overlay" onMouseDown={onClose}>
      <div className="quick-switcher" onMouseDown={(e) => e.stopPropagation()}>
        <input
          ref={inputRef}
          className="quick-switcher-input"
          placeholder={isCommandMode ? "Type a command…" : "Go to tab, terminal, or project… (\">\" for commands)"}
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setSelected(0);
          }}
          onKeyDown={(e) => {
            const combo = serializeEvent(e.nativeEvent);
            const get = getContextGetter(e.nativeEvent);
            if (
              e.key === "ArrowDown" ||
              (combo && bindingMatches(bindings["quickSwitcher.selectNext"], combo, get))
            ) {
              e.preventDefault();
              setSelected((s) => Math.min(s + 1, filtered.length - 1));
            } else if (
              e.key === "ArrowUp" ||
              (combo && bindingMatches(bindings["quickSwitcher.selectPrevious"], combo, get))
            ) {
              e.preventDefault();
              setSelected((s) => Math.max(s - 1, 0));
            } else if (e.key === "Enter") {
              e.preventDefault();
              runEntry(filtered[clampedSelected], e.shiftKey);
            } else if (e.key === "Escape") {
              e.preventDefault();
              onClose();
            }
          }}
        />
        <div className="quick-switcher-list" ref={listRef}>
          {filtered.length === 0 && !showFilesLoading && (
            <div className="quick-switcher-empty">No matches</div>
          )}
          {filtered.map((entry, i) => (
            <div
              key={entry.key}
              className={`quick-switcher-item${i === clampedSelected ? " selected" : ""}${entry.disabled ? " disabled" : ""}`}
              onMouseEnter={() => setSelected(i)}
              onClick={(e) => runEntry(entry, isSecondaryClick(e))}
            >
              <span className={`quick-switcher-tag quick-switcher-tag-${entry.group}`}>
                {entry.group}
              </span>
              <span className="quick-switcher-label">{entry.label}</span>
              {entry.binding && <span className="quick-switcher-binding">{entry.binding}</span>}
            </div>
          ))}
          {showFilesLoading && (
            <div className="quick-switcher-item quick-switcher-loading">loading files…</div>
          )}
        </div>
      </div>
    </div>
  );
}
