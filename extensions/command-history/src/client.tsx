// command-history: the COMMANDS accordion section of the Run tab plus a "!"
// quick-switcher mode — per-pane shell command history (exit codes,
// durations) from core's GET /api/command-events, which is fed by the
// shell-integration snippet. Primary action re-runs a command in the active
// session's pane (via this extension's own /type server route — see
// server.js); secondary inserts it at the prompt without running. Host hooks
// arrive via module-level bridge variables set once in activate(), the same
// pattern tasks/ports/git-scm use.
import { useEffect, useState } from "react";
import "./style.css";
import { copyText } from "../../_shared/clipboard";
import { injectStylesheet } from "../../_shared/injectStylesheet";
import Icon from "../../_shared/Icon";
import type { MenuItem } from "../../_shared/types";
import { useLongPressMenu } from "../../_shared/useLongPressMenu";

interface CompletedCommand {
  command: string;
  cwd: string;
  startedAt: number;
  endedAt: number;
  exitCode: number;
  durationMs: number;
}

interface PaneHistory {
  pane: string;
  windowIndex: number;
  paneIndex: number;
  active: boolean;
  currentCommand: string;
  title: string;
  running: { command: string; cwd: string; startedAt: number } | null;
  history: CompletedCommand[];
}

interface ActiveContext {
  sessionName: string | null;
  windowIndex: number | null;
  cwd: string | null;
}

// ---- Module-level host bridge ----

let serverFetch: ((path: string, init?: RequestInit) => Promise<Response>) | null = null;
let setSidebarPanelVisible: ((panelId: string, visible: boolean) => void) | null = null;
let refreshSwitcher: (() => void) | null = null;
let removeStylesheet: (() => void) | null = null;
let removeContextListener: (() => void) | null = null;
let removeEventListener_: (() => void) | null = null;

const NO_CONTEXT: ActiveContext = { sessionName: null, windowIndex: null, cwd: null };
let activeContext: ActiveContext = NO_CONTEXT;

// ---- History cache ----
// The switcher's provideResults is synchronous, so history lives here as a
// small store: refetched on context change and (debounced) on every live
// commandEvent for the active session, subscribed to by the mounted panel.

let cachedPanes: PaneHistory[] = [];
const cacheListeners = new Set<() => void>();
let panelVisible: boolean | null = null;
let fetchSeq = 0;
let refetchTimer: number | undefined;

function notifyCache(): void {
  for (const listener of cacheListeners) listener();
  refreshSwitcher?.();
}

async function refetch(): Promise<void> {
  const session = activeContext.sessionName;
  const seq = ++fetchSeq;
  if (!session) {
    cachedPanes = [];
    notifyCache();
    return;
  }
  try {
    const res = await fetch(`/api/command-events?session=${encodeURIComponent(session)}`);
    if (!res.ok) return;
    const data = (await res.json()) as { panes?: PaneHistory[] };
    // A context switch mid-flight would otherwise land stale panes over the
    // newer session's fetch.
    if (seq !== fetchSeq) return;
    cachedPanes = data.panes ?? [];
    notifyCache();
  } catch {
    // Server unreachable — keep whatever we had.
  }
}

function scheduleRefetch(): void {
  if (refetchTimer !== undefined) return;
  refetchTimer = window.setTimeout(() => {
    refetchTimer = undefined;
    void refetch();
  }, 300);
}

function applyContext(next: ActiveContext): void {
  const changed = next.sessionName !== activeContext.sessionName;
  activeContext = next;
  const visible = next.sessionName !== null;
  if (visible !== panelVisible) {
    panelVisible = visible;
    setSidebarPanelVisible?.("command-history", visible);
  }
  if (changed) void refetch();
}

// ---- Actions ----

function typeIntoActivePane(text: string, submit: boolean): void {
  const session = activeContext.sessionName;
  if (!session || !serverFetch) return;
  void serverFetch("/type", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ session, text, submit }),
  }).catch(() => {});
}

// ---- Formatting ----

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return `${m}m ${s - m * 60}s`;
}

function formatAgo(at: number): string {
  const s = Math.round((Date.now() - at) / 1000);
  if (s < 60) return "just now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

function paneLabel(p: PaneHistory): string {
  return `${p.windowIndex}.${p.paneIndex} ${p.currentCommand}${p.active ? " (active)" : ""}`;
}

// The active pane's history is what both the switcher and the panel default
// to; fall back to the first pane that has any, so a lone shell that isn't
// window-active still shows something.
function defaultPane(panes: PaneHistory[]): PaneHistory | undefined {
  return panes.find((p) => p.active && p.history.length > 0) ?? panes.find((p) => p.history.length > 0);
}

// ---- Panel ----

interface PanelProps {
  actionsTarget?: HTMLDivElement | null;
  showMenu?: (x: number, y: number, items: MenuItem[]) => void;
}

function CommandHistoryPanel({ showMenu }: PanelProps) {
  const bindMenu = useLongPressMenu();
  const [, forceRender] = useState(0);
  // Pane picker selection; "" = follow the active pane.
  const [selectedPane, setSelectedPane] = useState("");

  useEffect(() => {
    const listener = () => forceRender((v) => v + 1);
    cacheListeners.add(listener);
    void refetch();
    return () => {
      cacheListeners.delete(listener);
    };
  }, []);

  const panesWithHistory = cachedPanes.filter((p) => p.history.length > 0 || p.running !== null);
  const shown =
    (selectedPane ? panesWithHistory.find((p) => p.pane === selectedPane) : undefined) ??
    defaultPane(cachedPanes);

  const menuFor = (entry: CompletedCommand): MenuItem[] => [
    { label: "Re-run", onClick: () => typeIntoActivePane(entry.command, true) },
    { label: "Insert without running", onClick: () => typeIntoActivePane(entry.command, false) },
    { label: "Copy command", onClick: () => void copyText(entry.command).catch(() => {}) },
  ];

  const openMenu = (e: { clientX: number; clientY: number }, entry: CompletedCommand) => {
    showMenu?.(e.clientX, e.clientY, menuFor(entry));
  };

  return (
    <div className="cmdhist-panel">
      {panesWithHistory.length > 1 && (
        <select
          className="cmdhist-pane-select"
          value={selectedPane}
          onChange={(e) => setSelectedPane(e.target.value)}
          aria-label="Pane"
        >
          <option value="">Active pane</option>
          {panesWithHistory.map((p) => (
            <option key={p.pane} value={p.pane}>
              {paneLabel(p)}
            </option>
          ))}
        </select>
      )}
      <ul className="cmdhist-list">
        {shown?.running && (
          <li className="cmdhist-row running">
            <span className="cmdhist-spinner" aria-hidden="true" />
            <span className="cmdhist-command" title={shown.running.command}>
              {shown.running.command}
            </span>
            <span className="cmdhist-meta">{formatAgo(shown.running.startedAt)}</span>
          </li>
        )}
        {(shown?.history ?? []).map((entry, i) => (
          <li
            key={`${entry.endedAt}-${i}`}
            className="cmdhist-row"
            onContextMenu={(e) => {
              e.preventDefault();
              openMenu(e, entry);
            }}
            {...bindMenu((x, y) => showMenu?.(x, y, menuFor(entry)))}
          >
            <span
              className={`cmdhist-exit ${entry.exitCode === 0 ? "ok" : "fail"}`}
              title={`exit ${entry.exitCode}`}
            >
              {entry.exitCode === 0 ? "✓" : entry.exitCode}
            </span>
            <button
              type="button"
              className="cmdhist-command"
              title={`${entry.command}\n${entry.cwd}`}
              onClick={() => typeIntoActivePane(entry.command, false)}
            >
              {entry.command}
            </button>
            <span className="cmdhist-meta">{formatDuration(entry.durationMs)}</span>
            <span className="cmdhist-actions">
              <button
                type="button"
                className="cmdhist-action"
                title="Re-run in active pane"
                onClick={() => typeIntoActivePane(entry.command, true)}
              >
                <Icon name="play" />
              </button>
              <button
                type="button"
                className="cmdhist-action"
                title="Copy command"
                onClick={() => void copyText(entry.command).catch(() => {})}
              >
                <Icon name="copy" />
              </button>
            </span>
          </li>
        ))}
        {!shown?.running && (shown?.history ?? []).length === 0 && (
          <li className="cmdhist-empty">
            No commands yet - shell integration reports them (Settings → Behavior).
          </li>
        )}
      </ul>
    </div>
  );
}

// ---- Activation ----

interface QuickSwitcherItem {
  label: string;
  tag?: string;
  run: (secondary: boolean) => void;
}

interface ExtensionContext {
  registerSidebarPanel(panel: {
    id: string;
    title: string;
    icon?: string;
    location?: "tab" | "explorer" | "run" | "commands";
    defaultCollapsed?: boolean;
    order?: number;
    component: (props: PanelProps) => ReturnType<typeof CommandHistoryPanel>;
  }): void;
  registerQuickSwitcherProvider(provider: {
    id: string;
    provideResults: (query: string) => QuickSwitcherItem[];
  }): { refresh(): void };
  app: {
    getActiveContext(): ActiveContext;
    onDidChangeContext(cb: (ctx: ActiveContext) => void): () => void;
    setSidebarPanelVisible(panelId: string, visible: boolean): void;
  };
  serverFetch(path: string, init?: RequestInit): Promise<Response>;
  assetUrl(relPath: string): string;
}

const SWITCHER_LIMIT = 20;

export function activate(ctx: ExtensionContext): void {
  serverFetch = ctx.serverFetch;
  setSidebarPanelVisible = ctx.app.setSidebarPanelVisible;
  removeStylesheet = injectStylesheet(ctx.assetUrl, "dist/client.css");

  ctx.registerSidebarPanel({
    id: "command-history",
    title: "History",
    icon: "history",
    location: "commands",
    order: 10,
    defaultCollapsed: false,
    component: CommandHistoryPanel,
  });

  // "!" mode: Enter re-runs, Shift+Enter inserts without running. Searches
  // the active pane's cached history only — the panel has the pane picker.
  const handle = ctx.registerQuickSwitcherProvider({
    id: "history",
    provideResults: (query: string) => {
      if (!query.startsWith("!")) return [];
      const term = query.slice(1).trim().toLowerCase();
      const pane = defaultPane(cachedPanes);
      if (!pane) return [];
      const seen = new Set<string>();
      const items: QuickSwitcherItem[] = [];
      for (let i = pane.history.length - 1; i >= 0 && items.length < SWITCHER_LIMIT; i--) {
        const entry = pane.history[i];
        if (seen.has(entry.command)) continue;
        if (term && !entry.command.toLowerCase().includes(term)) continue;
        seen.add(entry.command);
        items.push({
          label: entry.command,
          tag: entry.exitCode === 0 ? "✓" : `✗ ${entry.exitCode}`,
          run: (secondary) => typeIntoActivePane(entry.command, !secondary),
        });
      }
      return items;
    },
  });
  refreshSwitcher = handle.refresh;

  applyContext(ctx.app.getActiveContext());
  removeContextListener = ctx.app.onDidChangeContext(applyContext);

  // Live refresh: TerminalView relays every commandEvent WS frame app-wide
  // (see TerminalCommandEvent in client/src/extensions.ts). Only the active
  // session's events matter here; the debounce absorbs bursts.
  const onCommandEvent = (e: Event) => {
    const detail = (e as CustomEvent<{ sessionName?: string }>).detail;
    if (detail?.sessionName && detail.sessionName === activeContext.sessionName) scheduleRefetch();
  };
  window.addEventListener("perch:command-event", onCommandEvent);
  removeEventListener_ = () => window.removeEventListener("perch:command-event", onCommandEvent);
}

export function deactivate(): void {
  removeStylesheet?.();
  removeStylesheet = null;
  removeContextListener?.();
  removeContextListener = null;
  removeEventListener_?.();
  removeEventListener_ = null;
  if (refetchTimer !== undefined) {
    window.clearTimeout(refetchTimer);
    refetchTimer = undefined;
  }
  serverFetch = null;
  setSidebarPanelVisible = null;
  refreshSwitcher = null;
  cachedPanes = [];
  activeContext = NO_CONTEXT;
  panelVisible = null;
}
