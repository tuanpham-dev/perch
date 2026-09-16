// tasks: the TASKS accordion section of the Run tab — every package.json
// script in the active window's workspace, run in reusable named terminal windows
// (see server.js for the window-name scheme that makes reuse and the running
// dots work). Host hooks (serverFetch for this extension's own /scripts &
// /run routes, the active-context subscription, panel visibility) arrive via
// module-level bridge variables set once in activate(), the same pattern
// ports/git-scm use.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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

let serverFetch: ((path: string, init?: RequestInit) => Promise<Response>) | null = null;
let setSidebarPanelVisible: ((panelId: string, visible: boolean) => void) | null = null;
let removeStylesheet: (() => void) | null = null;
let removeContextListener: (() => void) | null = null;

// The panel needs the active session/cwd, but React context can't cross the
// activate() bridge — so the context lives here as a tiny store the mounted
// panel subscribes to (useActiveContext below).
const NO_CONTEXT: ActiveContext = { sessionName: null, windowIndex: null, cwd: null };
let activeContext: ActiveContext = NO_CONTEXT;
const contextListeners = new Set<() => void>();
// Last value pushed to setSidebarPanelVisible; null before the first push so
// the initial state is always sent. Tracked because that host call notifies
// the whole panel registry unconditionally, while onDidChangeContext fires on
// every sessions poll tick (~3s) with a value-identical context.
let panelVisible: boolean | null = null;

function applyContext(next: ActiveContext): void {
  // windowIndex is deliberately not part of the comparison — nothing here
  // depends on which window is active, only on its session and directory.
  const changed = next.sessionName !== activeContext.sessionName || next.cwd !== activeContext.cwd;
  activeContext = next;
  const visible = next.cwd !== null;
  if (visible !== panelVisible) {
    panelVisible = visible;
    setSidebarPanelVisible?.("tasks", visible);
  }
  if (changed) for (const listener of contextListeners) listener();
}

function useActiveContext(): ActiveContext {
  const [ctx, setCtx] = useState(activeContext);
  useEffect(() => {
    const listener = () => setCtx(activeContext);
    contextListeners.add(listener);
    // Covers a context change between this component's render and the
    // subscription landing.
    listener();
    return () => {
      contextListeners.delete(listener);
    };
  }, []);
  return ctx;
}

// ---- Types (mirror the server responses) ----

interface TaskScript {
  name: string;
  command: string;
  // A window named for this script exists and its foreground process
  // isn't a shell — see server.js's taskWindowName/isRunning.
  running: boolean;
}

interface TaskPackage {
  dir: string;
  name: string;
  // Path relative to the workspace root; "." for the root package itself.
  relDir: string;
  // The package containing the active window's cwd.
  active: boolean;
  scripts: TaskScript[];
}

interface ScriptsResponse {
  // null only when no package.json was found at all.
  packageManager: string | null;
  packages: TaskPackage[];
}

// ---- Fetch helpers ----

async function readJson<T>(res: Response): Promise<T> {
  if (!res.ok) {
    let message = `${res.status} ${res.statusText}`;
    try {
      const body = await res.json();
      if (body?.error) message = body.error;
    } catch {
      // non-JSON error body; keep the status message
    }
    throw new Error(message);
  }
  const text = await res.text();
  return text ? (JSON.parse(text) as T) : (undefined as T);
}

function fetchScripts(cwd: string, session: string): Promise<ScriptsResponse> {
  if (!serverFetch) return Promise.reject(new Error("extension not activated"));
  const query = `?cwd=${encodeURIComponent(cwd)}&session=${encodeURIComponent(session)}`;
  return serverFetch(`/scripts${query}`).then((res) => readJson<ScriptsResponse>(res));
}

function runScriptRequest(session: string, dir: string, script: string): Promise<void> {
  if (!serverFetch) return Promise.reject(new Error("extension not activated"));
  return serverFetch("/run", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ session, dir, script }),
  }).then((res) => readJson<void>(res));
}

// ---- Panel ----

const POLL_MS = 5_000;
const EMPTY_RESPONSE: ScriptsResponse = { packageManager: null, packages: [] };
// NUL can't occur in a directory path or a script name, so it's a safe
// composite-key separator (git-scm's row keys use the same trick).
const KEY_SEP = "\u0000";

function rowKey(dir: string, script: string): string {
  return `${dir}${KEY_SEP}${script}`;
}

interface PanelProps {
  actionsTarget?: HTMLDivElement | null;
  showMenu?: (x: number, y: number, items: MenuItem[]) => void;
  confirmDialog?: (message: string, confirmLabel?: string) => Promise<boolean>;
}

function TasksPanel({ actionsTarget, showMenu }: PanelProps) {
  // Touch/pen long-press → the same menu right-click opens.
  const bindMenu = useLongPressMenu();
  const { sessionName, cwd } = useActiveContext();
  const [data, setData] = useState<ScriptsResponse>(EMPTY_RESPONSE);
  const [error, setError] = useState<string | null>(null);
  // Only the groups the user has toggled; everything else falls back to
  // "expanded if it's the active package" (see isCollapsed), so switching to
  // another package's window opens its group without wiping manual toggles.
  const [collapseOverrides, setCollapseOverrides] = useState<Map<string, boolean>>(new Map());
  // Rows with a /run request in flight — their action is disabled until it
  // settles, mirroring ports' `killing` set.
  const [starting, setStarting] = useState<Set<string>>(new Set());
  // The header Refresh button (portaled into actionsTarget) bumps this to
  // force a reload, same as ports'.
  const [refreshKey, setRefreshKey] = useState(0);
  // Guards state updates from a fetch that resolves after unmount. Reset on
  // every mount, not just at ref creation, so StrictMode's dev double-invoke
  // (mount, cleanup, mount) doesn't leave it stuck false.
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const loadScripts = useCallback(() => {
    // The section is hidden without a cwd (activate() drives that), so this
    // is only the belt-and-braces path for a render before the first context.
    if (!cwd) {
      setData(EMPTY_RESPONSE);
      return;
    }
    fetchScripts(cwd, sessionName ?? "")
      .then((next) => {
        if (!mountedRef.current) return;
        setData(next);
        setError(null);
      })
      .catch((err) => {
        if (mountedRef.current) setError(err instanceof Error ? err.message : String(err));
      });
  }, [cwd, sessionName]);

  useEffect(() => {
    loadScripts();
    // The load above (mount, context change, Refresh) always runs; only the
    // background ticks skip while hidden, resuming immediately on regaining
    // visibility instead of waiting out the rest of the interval.
    const timer = window.setInterval(() => {
      if (!document.hidden) loadScripts();
    }, POLL_MS);
    const onVisibility = () => {
      if (!document.hidden) loadScripts();
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [refreshKey, loadScripts]);

  // When only one package has scripts it needs no group: its scripts are
  // listed on their own, always expanded, and script-less packages are left
  // out.
  const { packages, flat } = useMemo(() => {
    const withScripts = data.packages.filter((pkg) => pkg.scripts.length > 0);
    if (withScripts.length === 1) return { packages: withScripts, flat: true };
    return { packages: data.packages, flat: data.packages.length === 1 };
  }, [data.packages]);
  const pm = data.packageManager ?? "npm";

  const isCollapsed = (pkg: TaskPackage) => !flat && (collapseOverrides.get(pkg.dir) ?? !pkg.active);

  const toggleGroup = (pkg: TaskPackage) => {
    setCollapseOverrides((prev) => {
      const next = new Map(prev);
      next.set(pkg.dir, !isCollapsed(pkg));
      return next;
    });
  };

  const runScript = (pkg: TaskPackage, script: TaskScript) => {
    const key = rowKey(pkg.dir, script.name);
    if (starting.has(key)) return;
    if (!sessionName) {
      setError("Open a terminal session to run this task in");
      return;
    }
    setStarting((prev) => new Set(prev).add(key));
    runScriptRequest(sessionName, pkg.dir, script.name)
      .then(() => {
        setError(null);
        // The window was just created/reused, so `running` is stale — don't
        // wait out the poll interval to light up the dot.
        loadScripts();
      })
      .catch((err) => setError(err instanceof Error ? err.message : String(err)))
      .finally(() => {
        setStarting((prev) => {
          const next = new Set(prev);
          next.delete(key);
          return next;
        });
      });
  };

  // Flattened, in render order: only scripts of expanded groups are
  // focusable, and group headers are plain buttons outside the roving
  // tabindex.
  const visibleRows = useMemo(() => {
    const rows: { pkg: TaskPackage; script: TaskScript; key: string }[] = [];
    for (const pkg of packages) {
      if (!flat && (collapseOverrides.get(pkg.dir) ?? !pkg.active)) continue;
      for (const script of pkg.scripts) {
        rows.push({ pkg, script, key: rowKey(pkg.dir, script.name) });
      }
    }
    return rows;
  }, [packages, flat, collapseOverrides]);
  const rowIds = useMemo(() => visibleRows.map((row) => row.key), [visibleRows]);
  const rowsByKey = useMemo(() => new Map(visibleRows.map((row) => [row.key, row])), [visibleRows]);

  const scriptMenuItems = (pkg: TaskPackage, script: TaskScript): MenuItem[] => [
    {
      label: script.running ? "Show Running Task" : "Run",
      onClick: () => runScript(pkg, script),
    },
    {
      label: "Copy Command",
      onClick: () => {
        copyText(`${pm} run ${script.name}`).catch(() => {});
      },
    },
  ];

  const nav = useListNavigation({
    rowIds,
    onActivate: (id) => {
      const row = rowsByKey.get(id);
      if (row) runScript(row.pkg, row.script);
    },
    onContextMenuKey: (id, rect) => {
      const row = rowsByKey.get(id);
      if (row) showMenu?.(rect.left + 8, rect.bottom, scriptMenuItems(row.pkg, row.script));
    },
  });

  const totalScripts = packages.reduce((sum, pkg) => sum + pkg.scripts.length, 0);

  return (
    <div className="tasks-panel">
      {actionsTarget &&
        createPortal(
          <button
            className="icon-button"
            title="Refresh"
            onClick={() => setRefreshKey((k) => k + 1)}
          >
            <Icon name="refresh" />
          </button>,
          actionsTarget,
        )}
      {error && <div className="tasks-error">{error}</div>}
      <div className="tasks-list" onKeyDown={nav.onKeyDown}>
        {packages.map((pkg) => {
          const collapsed = isCollapsed(pkg);
          return (
            <div className="tasks-group" key={pkg.dir}>
              {!flat && (
                <button
                  className={`tasks-group-header${pkg.active ? " active" : ""}`}
                  title={pkg.dir}
                  onClick={() => toggleGroup(pkg)}
                >
                  <Icon name={collapsed ? "chevron-right" : "chevron-down"} />
                  <span className="tasks-group-name">{pkg.name}</span>
                  {pkg.relDir !== "." && <span className="tasks-group-dir">{pkg.relDir}</span>}
                </button>
              )}
              {!collapsed && (
                <ul className={`tasks-scripts${flat ? " flat" : ""}`}>
                  {pkg.scripts.map((script) => {
                    const key = rowKey(pkg.dir, script.name);
                    const rowProps = nav.getRowProps(key);
                    const action = script.running ? "Show running task" : `${pm} run ${script.name}`;
                    return (
                      <li key={script.name} className="tasks-row">
                        <button
                          className="tasks-item"
                          title={action}
                          onClick={() => runScript(pkg, script)}
                          onContextMenu={(e) => {
                            e.preventDefault();
                            nav.focusRow(key);
                            showMenu?.(e.clientX, e.clientY, scriptMenuItems(pkg, script));
                          }}
                          {...bindMenu((x, y) => {
                            nav.focusRow(key);
                            showMenu?.(x, y, scriptMenuItems(pkg, script));
                          })}
                          tabIndex={rowProps.tabIndex}
                          ref={rowProps.ref}
                          onFocus={rowProps.onFocus}
                        >
                          {/* Always rendered (transparent when idle) so a row
                              lighting up doesn't shift its neighbours' text. */}
                          <span className={`tasks-dot${script.running ? " running" : ""}`} />
                          <span className="tasks-name">{script.name}</span>
                          <span className="tasks-command">{script.command}</span>
                        </button>
                        <div className="tasks-actions">
                          <button
                            className="icon-button tasks-action-button"
                            title={action}
                            disabled={starting.has(key)}
                            tabIndex={-1}
                            onClick={() => runScript(pkg, script)}
                          >
                            <Icon name="play" />
                          </button>
                        </div>
                      </li>
                    );
                  })}
                  {pkg.scripts.length === 0 && totalScripts > 0 && (
                    <li className="tasks-empty">No scripts</li>
                  )}
                </ul>
              )}
            </div>
          );
        })}
        {!error && packages.length === 0 && <div className="tasks-empty">No package.json found</div>}
        {!error && packages.length > 0 && totalScripts === 0 && (
          <div className="tasks-empty">No scripts in package.json</div>
        )}
      </div>
    </div>
  );
}

// ---- Activation ----

interface ExtensionContext {
  registerSidebarPanel(panel: {
    id: string;
    title: string;
    icon?: string;
    location?: "tab" | "explorer" | "run";
    defaultCollapsed?: boolean;
    // Default placement weight among this location's sections — lower
    // renders higher; see core RegisteredSidebarPanel.order.
    order?: number;
    focusBinding?: string;
    component: (props: PanelProps) => ReturnType<typeof TasksPanel>;
  }): void;
  app: {
    getActiveContext(): ActiveContext;
    onDidChangeContext(cb: (ctx: ActiveContext) => void): () => void;
    setSidebarPanelVisible(panelId: string, visible: boolean): void;
  };
  serverFetch(path: string, init?: RequestInit): Promise<Response>;
  assetUrl(relPath: string): string;
}

export function activate(ctx: ExtensionContext): void {
  serverFetch = ctx.serverFetch;
  setSidebarPanelVisible = ctx.app.setSidebarPanelVisible;
  removeStylesheet = injectStylesheet(ctx.assetUrl, "dist/client.css");
  ctx.registerSidebarPanel({
    id: "tasks",
    title: "Tasks",
    icon: "checklist",
    location: "run",
    order: 10,
    defaultCollapsed: false,
    component: TasksPanel,
  });
  // After registerSidebarPanel — setSidebarPanelVisible no-ops for a panel
  // that isn't registered yet. Seeds both the store and the section's
  // visibility from the context that already exists at activation time.
  applyContext(ctx.app.getActiveContext());
  removeContextListener = ctx.app.onDidChangeContext(applyContext);
}

export function deactivate(): void {
  removeStylesheet?.();
  removeStylesheet = null;
  removeContextListener?.();
  removeContextListener = null;
  serverFetch = null;
  setSidebarPanelVisible = null;
  // A later re-activate starts from scratch: no stale cwd, and the first
  // applyContext pushes visibility again rather than deduping against the
  // previous run's value.
  activeContext = NO_CONTEXT;
  panelVisible = null;
}
