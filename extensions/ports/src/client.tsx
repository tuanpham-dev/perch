// ports: the listening ports inside your terminals, shown three ways — a
// status-bar readout with a popover listing them, the PORTS view of the
// bottom panel (a table), and the built-in browser tab (browser.tsx) that
// opens them (and any site). Host hooks (serverFetch for this extension's own
// /list & /kill routes, and ctx.app's tunnel, proxy and web-preview state)
// arrive via module-level bridge variables set once in activate() — same
// pattern as the search and git-scm extensions.
import {
  useEffect,
  useState,
  useSyncExternalStore,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import "./style.css";
import { copyText } from "../../_shared/clipboard";
import { injectStylesheet } from "../../_shared/injectStylesheet";
import Icon from "../../_shared/Icon";
import type { MenuItem } from "../../_shared/types";
import { BrowserView, browserTabPath, configureBrowser, parseAddress } from "./browser";
import { setViewportPrompt } from "../../_shared/viewports";

// ---- Module-level host bridge ----

let serverFetch: ((path: string, init?: RequestInit) => Promise<Response>) | null = null;
let removeStylesheet: (() => void) | null = null;
let extSettings: SettingsApi | null = null;
let openViewerTab: ((viewerId: string, path: string, opts?: { title?: string }) => void) | null = null;
let getActiveContext: (() => ActiveContext) | null = null;
// Both optional on the host: an older app has no bottom-panel views and no
// session opener for extensions, and the status item then keeps its popover.
let openSessionWindow: ((sessionName: string, opts?: { windowIndex?: number }) => void) | null = null;
let togglePanelView: ((viewId: string) => boolean) | null = null;
// The core state this extension reads (ctx.app's tunnels, proxy config and
// web preview).
let coreApp: Pick<ExtensionContext["app"], "tunnels" | "proxyConfig" | "webPreview"> | null = null;
// Other extensions' items for a port's menu (ctx.app.portMenuItems); null on a host
// that predates ctx.registerPortMenuItem.
let extraPortMenuItems:
  | ((port: { port: number; address: string; pid?: number; process?: string }) => { label: string; onClick: () => void }[])
  | null = null;

// This extension's PORTS view, by the id the host assigns it
// (ext.<publisher>.<name>.<view id>) - what the status item toggles.
const PORTS_VIEW_ID = "ext.perch.ports.ports";

interface SettingsApi {
  get(key: string): unknown;
  onDidChange(cb: () => void): () => void;
}

interface ActiveContext {
  sessionName: string | null;
  windowIndex: number | null;
  cwd: string | null;
}

function readClickAction(): "app" | "browser" {
  return extSettings?.get("ports.clickAction") === "browser" ? "browser" : "app";
}

// A secondary click on a port's open action (Shift+click, Perch's secondary
// click everywhere, or the middle button) opens it the other way: in Perch's
// own web preview tab where a click opens the browser, and the reverse.
function isSecondaryClick(e: ReactMouseEvent): boolean {
  return e.button === 1 || e.shiftKey;
}

// The tooltip's note on what a secondary click does with the current setting.
function secondaryHint(): string {
  return readClickAction() === "app" ? "Shift+click: in the browser" : "Shift+click: in Perch";
}

function openPortInApp(port: number): void {
  openViewerTab?.("portProxy", `port:${port}`, { title: `Port ${port}` });
}

// Click and middle-click handlers for a port's open action: a plain click
// opens it where ports.clickAction says (an app tab by default, or the
// browser), a secondary click (Shift, the middle button) the other way.
// The middle button's own autoscroll is kept from starting.
function openActionProps(openInBrowser: () => void, port: number) {
  const open = (secondary: boolean) => {
    const inApp = readClickAction() === "app";
    if (secondary !== inApp) openPortInApp(port);
    else openInBrowser();
  };
  return {
    onClick: (e: ReactMouseEvent) => open(isSecondaryClick(e)),
    onAuxClick: (e: ReactMouseEvent) => {
      if (e.button !== 1) return;
      e.preventDefault();
      open(true);
    },
    onMouseDown: (e: ReactMouseEvent) => {
      if (e.button === 1) e.preventDefault();
    },
  };
}

function readSendAutoSubmit(): boolean {
  return extSettings?.get("ports.sendAutoSubmit") === true;
}

// ---- Types (mirror the server responses) ----

interface ListeningPort {
  port: number;
  address: string;
  process?: string;
  pid?: number;
  session: string;
  // The process outlived the terminal it was started in (or no terminal
  // started it): `session` is then the name it remembers, or empty.
  orphan?: boolean;
}

interface TunnelAuth {
  cookie: string | null;
  authorization: string | null;
}

// First configured PROXY_DOMAIN (core /api/proxy-config), or null when
// unset — decides whether a port's URL is "<port>.<domain>" or the
// app-origin "/proxy/<port>/" fallback.
interface ProxyConfig {
  domain: string | null;
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

function fetchPorts(): Promise<ListeningPort[]> {
  if (!serverFetch) return Promise.reject(new Error("extension not activated"));
  return serverFetch("/list").then((res) => readJson<ListeningPort[]>(res));
}

function killPort(port: number): Promise<void> {
  if (!serverFetch) return Promise.reject(new Error("extension not activated"));
  return serverFetch(`/kill/${port}`, { method: "POST" }).then((res) => readJson<void>(res));
}

// Tunnel and proxy are core infrastructure; this panel only reads their
// config (ctx.app.tunnels / proxyConfig) to compose URLs and the tunnel
// command.
function fetchTunnelAuth(): Promise<TunnelAuth> {
  if (!coreApp) return Promise.reject(new Error("extension not activated"));
  return coreApp.tunnels.auth();
}

function fetchProxyConfig(): Promise<ProxyConfig> {
  if (!coreApp) return Promise.reject(new Error("extension not activated"));
  return coreApp.proxyConfig();
}

// ---- Panel ----

const POLL_MS = 5_000;
const NO_AUTH: TunnelAuth = { cookie: null, authorization: null };
const NO_PROXY_CONFIG: ProxyConfig = { domain: null };
const MASK = "••••";

// Which terminal a port belongs to. A process that outlived its terminal
// still says which one it was started in, and reads as faded rather than as
// a live session; one no terminal started has nothing to name at all.
function SessionBadge({ port }: { port: ListeningPort }) {
  if (!port.orphan) return <span className="port-session">{port.session}</span>;
  return (
    <span
      className="port-session port-session-orphan"
      title={
        port.session
          ? `Still listening after the "${port.session}" terminal closed`
          : "Listening outside your terminals"
      }
    >
      {port.session || "no terminal"}
    </span>
  );
}

// Wraps a value in single quotes for a POSIX shell, escaping embedded single
// quotes with the standard '\'' idiom — cookie values can legally contain them.
function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function authHeaders(auth: TunnelAuth): { name: string; value: string }[] {
  const headers: { name: string; value: string }[] = [];
  if (auth.cookie) headers.push({ name: "Cookie", value: auth.cookie });
  if (auth.authorization) headers.push({ name: "Authorization", value: auth.authorization });
  return headers;
}

// Builds the copy-pasteable tunnel command. When `mask` is set, header values
// are replaced with a placeholder for on-screen display; `mask: false` is
// what actually gets copied to the clipboard. Always the --all auto-forward
// variant (see cli/tunnel.mjs): forwarding a fixed snapshot of ports went
// stale the moment a dev server restarted on a new port, so the panel no
// longer asks which ports you meant.
// This browser's own id for tunnel pairing: the copied command passes it to
// the CLI (--client), and the status asks only about tunnels carrying it, so
// a tunnel shows as forwarded in the browser that started it and nowhere
// else. The server can't tell machines apart any other way behind a reverse
// proxy, where every connection arrives from the proxy. Kept per browser
// (localStorage) so a copied command keeps matching across reloads; when
// storage is unavailable it lasts for this page only.
// getRandomValues rather than randomUUID, which needs a secure context and
// so fails on a plain-http LAN address.
const TUNNEL_CLIENT_KEY = "perch.ports.tunnelClient";
let tunnelClientId: string | null = null;

function tunnelClient(): string {
  if (tunnelClientId) return tunnelClientId;
  try {
    const stored = localStorage.getItem(TUNNEL_CLIENT_KEY);
    if (stored && /^[A-Za-z0-9_-]{1,64}$/.test(stored)) return (tunnelClientId = stored);
  } catch {
    // storage blocked: fall through to a page-lifetime id
  }
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  tunnelClientId = [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
  try {
    localStorage.setItem(TUNNEL_CLIENT_KEY, tunnelClientId);
  } catch {
    // keep the in-memory id
  }
  return tunnelClientId;
}

function buildCommand(origin: string, auth: TunnelAuth, mask: boolean): string {
  const headers = authHeaders(auth).map((h) => ({ ...h, value: mask ? MASK : h.value }));
  const curlArgs = headers.map((h) => `-H ${shellQuote(`${h.name}: ${h.value}`)}`).join(" ");
  const nodeArgs = headers.map((h) => `--header ${shellQuote(`${h.name}: ${h.value}`)}`).join(" ");
  // The script streams from curl straight into node's stdin — no file ever
  // touches disk (no stray tunnel.mjs in the user's cwd), and no /tmp-style
  // path that breaks on Windows. --input-type=module because stdin scripts
  // default to CommonJS.
  const curl = `curl -s ${curlArgs ? `${curlArgs} ` : ""}${origin}/tunnel.mjs`;
  const node = `node --input-type=module - --url ${origin} ${nodeArgs ? `${nodeArgs} ` : ""}--client ${tunnelClient()} --all`;
  return `${curl} | ${node}`;
}

// code-server-style: a configured PROXY_DOMAIN routes "<port>.<domain>"
// straight to that port (every app works unmodified); otherwise fall back to
// the app-origin path proxy "/proxy/<port>/" (absolute-path assets need the
// Referer fallback or a domain — see core server/src/proxy.ts).
function proxyUrl(port: number, proxyConfig: ProxyConfig): string {
  if (proxyConfig.domain) {
    // The subdomains are served by this same server, so on the same port
    // the app was reached on (none for 80/443).
    const appPort = window.location.port ? `:${window.location.port}` : "";
    return `${window.location.protocol}//${port}.${proxyConfig.domain}${appPort}/`;
  }
  return `${window.location.origin}/proxy/${port}/`;
}

// Tunnel state, for the status-bar readout and the forwarded markers. A
// port is only "forwarded" once a connected tunnel client has reported
// binding it locally — the CLI skips ports it can't bind, so mere
// connectedness would put a live-looking marker on a dead localhost link.
interface TunnelStatus {
  connected: boolean;
  ports: number[];
  allForwarded: boolean;
}

const NO_TUNNEL: TunnelStatus = { connected: false, ports: [], allForwarded: false };

function fetchTunnelStatus(): Promise<TunnelStatus> {
  if (!coreApp) return Promise.reject(new Error("extension not activated"));
  return coreApp.tunnels.status(tunnelClient());
}

// The ports list plus the tunnel state, on one timer for the whole extension.
// A module singleton rather than per-component state: the status-bar readout
// and the popover it opens are two separate subscribers (the host holds the
// popover's content as a node captured at click time, so it cannot be fed by
// the item's own render), and each polling the same two endpoints on its own
// interval would double the traffic for nothing. It also means the popover's
// list is live — a killed process leaves it on the next tick without the
// popover having to be closed and reopened.
interface PortsFeed {
  ports: ListeningPort[];
  tunnel: TunnelStatus;
  error: string | null;
}

let feed: PortsFeed = { ports: [], tunnel: NO_TUNNEL, error: null };
const feedListeners = new Set<() => void>();
let feedTimer: number | null = null;

function setFeed(patch: Partial<PortsFeed>): void {
  feed = { ...feed, ...patch };
  for (const listener of feedListeners) listener();
}

function loadFeed(): void {
  fetchPorts()
    .then((next) => setFeed({ ports: next, error: null }))
    .catch((err) => setFeed({ error: err instanceof Error ? err.message : String(err) }));
  // A failed tunnel-status read means "no tunnel" rather than an error — it
  // is decoration, not the panel's purpose.
  fetchTunnelStatus()
    .then((next) => setFeed({ tunnel: next }))
    .catch(() => setFeed({ tunnel: NO_TUNNEL }));
}

function onFeedVisibility(): void {
  if (!document.hidden) loadFeed();
}

function subscribeFeed(onChange: () => void): () => void {
  feedListeners.add(onChange);
  // First subscriber starts the timer; the rest ride it, and a late one (the
  // popover opening) paints immediately from the last reading.
  if (feedListeners.size === 1) {
    loadFeed();
    feedTimer = window.setInterval(() => {
      if (!document.hidden) loadFeed();
    }, POLL_MS);
    document.addEventListener("visibilitychange", onFeedVisibility);
  }
  return () => {
    feedListeners.delete(onChange);
    if (feedListeners.size === 0) {
      if (feedTimer !== null) window.clearInterval(feedTimer);
      feedTimer = null;
      document.removeEventListener("visibilitychange", onFeedVisibility);
    }
  };
}

function usePortsFeed(): PortsFeed & { reload: () => void } {
  const state = useSyncExternalStore(subscribeFeed, () => feed);
  return { ...state, reload: loadFeed };
}

// ---- The PORTS bottom-panel view ----

interface PanelViewProps {
  context: {
    mobilePointer: boolean;
    showMenu(x: number, y: number, items: MenuItem[]): void;
    confirmDialog(message: string, confirmLabel?: string): Promise<boolean>;
    // The panel header's slot for this view's buttons (portal), null until
    // mounted.
    actionsTarget: HTMLElement | null;
  };
}

// The same list as the popover, laid out as a table for the panel's width:
// one column per fact, the Session cell a link to that session's window,
// and the popover's own three row actions in a column of their own, doing
// exactly what they do there (Open in the browser, at localhost when the
// tunnel forwards the port; Copy URL copies the proxy URL; Kill). Subscribes
// to the shared feed like the popover does, so it only polls while it is
// the view showing (the host unmounts it otherwise) and a killed row leaves
// the table on the next server answer rather than on local optimism.
function PortsTableView({ context }: PanelViewProps) {
  const { ports, tunnel, error: feedError, reload } = usePortsFeed();
  const [auth, setAuth] = useState<TunnelAuth>(NO_AUTH);
  const [proxyConfig, setProxyConfig] = useState<ProxyConfig>(NO_PROXY_CONFIG);
  const [copiedPort, setCopiedPort] = useState<number | null>(null);
  const [copied, setCopied] = useState(false);
  const [killing, setKilling] = useState<Set<number>>(new Set());
  const [error, setError] = useState<string | null>(null);

  // Neither changes while the app runs (see the popover).
  useEffect(() => {
    fetchTunnelAuth()
      .then(setAuth)
      .catch(() => setAuth(NO_AUTH));
    fetchProxyConfig()
      .then(setProxyConfig)
      .catch(() => setProxyConfig(NO_PROXY_CONFIG));
  }, []);

  const forwarded = new Set(tunnel.ports);
  const urlFor = (port: number): string =>
    forwarded.has(port) ? `http://localhost:${port}/` : proxyUrl(port, proxyConfig);
  // A forwarded port is reachable directly, which beats the proxy (see the
  // popover's openPort).
  const openPort = (port: number) => {
    window.open(urlFor(port), "_blank", "noopener");
  };
  const onCopyPortUrl = (port: number) => {
    copyText(proxyUrl(port, proxyConfig))
      .then(() => {
        setCopiedPort(port);
        window.setTimeout(() => setCopiedPort((prev) => (prev === port ? null : prev)), 1500);
      })
      .catch(() => {});
  };
  const onCopyCommand = () => {
    copyText(buildCommand(window.location.origin, auth, false))
      .then(() => {
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1500);
      })
      .catch(() => {});
  };
  // The row's right-click menu: the row's own buttons, then other
  // extensions' items for the port (ctx.registerPortMenuItem).
  const tableMenuItems = (p: ListeningPort): MenuItem[] => {
    const items: MenuItem[] = [
      { label: "Open", onClick: () => openPort(p.port) },
      { label: "Open in Perch", onClick: () => openPortInApp(p.port) },
      { label: "Copy URL", onClick: () => onCopyPortUrl(p.port) },
    ];
    for (const extra of extraPortMenuItems?.({ port: p.port, address: p.address, pid: p.pid, process: p.process }) ?? []) {
      items.push({ label: extra.label, onClick: extra.onClick });
    }
    if (p.pid !== undefined) items.push({ label: "Kill Process", danger: true, onClick: () => onKillPort(p) });
    return items;
  };
  // Same prompt and SIGTERM-then-SIGKILL route as the popover's Kill.
  const onKillPort = (p: ListeningPort) => {
    context
      .confirmDialog(`Kill ${p.process ?? "process"} (pid ${p.pid}) listening on port ${p.port}?`, "Kill")
      .then((ok) => {
        if (!ok) return;
        setKilling((prev) => new Set(prev).add(p.port));
        setError(null);
        return killPort(p.port)
          .then(() => reload())
          .catch((err) => setError(err instanceof Error ? err.message : String(err)))
          .finally(() => {
            setKilling((prev) => {
              const next = new Set(prev);
              next.delete(p.port);
              return next;
            });
          });
      })
      .catch(() => {});
  };
  const openSession = (p: ListeningPort) => {
    if (!p.orphan && p.session) openSessionWindow?.(p.session);
  };

  // Every listed process whose terminal is gone, killed in one go: the
  // leftovers of closed sessions are what this view mostly shows, and one
  // confirm beats one per row. Same route as the row's Kill, port by port,
  // and the list is asked again once at the end.
  const exited = ports.filter((p) => p.orphan && p.pid !== undefined);
  const onKillExited = () => {
    if (exited.length === 0) return;
    const what =
      exited.length === 1
        ? `Kill ${exited[0].process ?? "process"} (pid ${exited[0].pid}) on port ${exited[0].port}, whose terminal has exited?`
        : `Kill ${exited.length} processes whose terminals have exited (ports ${exited.map((p) => p.port).join(", ")})?`;
    context
      .confirmDialog(what, "Kill")
      .then(async (ok) => {
        if (!ok) return;
        setKilling((prev) => {
          const next = new Set(prev);
          for (const p of exited) next.add(p.port);
          return next;
        });
        setError(null);
        const failed: string[] = [];
        for (const p of exited) {
          try {
            await killPort(p.port);
          } catch (err) {
            failed.push(`${p.port}: ${err instanceof Error ? err.message : String(err)}`);
          }
        }
        if (failed.length > 0) setError(`Couldn't kill ${failed.join("; ")}`);
        reload();
        setKilling((prev) => {
          const next = new Set(prev);
          for (const p of exited) next.delete(p.port);
          return next;
        });
      })
      .catch(() => {});
  };

  const shownError = error ?? feedError;

  const tunnelHint = tunnel.allForwarded
    ? "All ports forwarded to this machine."
    : tunnel.connected
      ? "Tunnel connected - run the command again to pick up new ports."
      : "Run the forward command locally to reach every port at localhost.";

  return (
    <div className="ports-table-view">
      {/* The view's buttons live in the panel header, where TERMINAL keeps
          its own: Kill exited (only while there is something to kill), the
          forward command, Refresh. */}
      {context.actionsTarget &&
        createPortal(
          <>
            {exited.length > 0 && (
              <button
                className="icon-button ports-header-kill-exited"
                title={`Kill every process whose terminal has exited (${exited.length})`}
                disabled={exited.some((p) => killing.has(p.port))}
                onClick={onKillExited}
              >
                <Icon name="trash" />
                <span className="ports-header-count">{exited.length}</span>
              </button>
            )}
            <button
              className="icon-button"
              title={copied ? "Copied" : `Copy the command that forwards every port. ${tunnelHint}`}
              onClick={onCopyCommand}
            >
              <Icon name={copied ? "check" : "copy"} />
            </button>
            <button className="icon-button" title="Refresh" onClick={() => reload()}>
              <Icon name="refresh" />
            </button>
          </>,
          context.actionsTarget,
        )}
      {shownError && (
        <div className="ports-error ports-table-error">
          <span>Couldn't load Ports: {shownError}</span>
          <button className="ports-btn-ghost" onClick={() => reload()}>
            Retry
          </button>
        </div>
      )}
      {ports.length === 0 && !shownError ? (
        <div className="ports-table-empty">No ports are listening in your terminals.</div>
      ) : (
        <table className="ports-table">
          <thead>
            <tr>
              <th>Port</th>
              <th>Process</th>
              <th>Session</th>
              <th>Address</th>
              <th aria-label="Actions" />
            </tr>
          </thead>
          <tbody>
            {ports.map((p) => (
              <tr
                key={p.port}
                className="ports-table-row"
                onContextMenu={(e) => {
                  e.preventDefault();
                  context.showMenu(e.clientX, e.clientY, tableMenuItems(p));
                }}
              >
                <td className="ports-table-port">
                  {/* The port opens on click, as the popover's row does. */}
                  <button
                    className="ports-table-link"
                    title={
                      forwarded.has(p.port)
                        ? `Forwarded - open http://localhost:${p.port}/ (${secondaryHint()})`
                        : `Open port ${p.port} (${secondaryHint()})`
                    }
                    {...openActionProps(() => openPort(p.port), p.port)}
                  >
                    {forwarded.has(p.port) && <Icon name="plug" className="port-forwarded-dot" />}
                    {p.port}
                  </button>
                </td>
                <td className="ports-table-process">{p.process ?? ""}</td>
                <td>
                  {!p.orphan && p.session ? (
                    <button
                      className="ports-table-link"
                      title={`Open the ${p.session} session`}
                      onClick={() => openSession(p)}
                    >
                      {p.session}
                    </button>
                  ) : (
                    <span
                      className="ports-table-exited"
                      title={
                        p.session
                          ? `Started in ${p.session}, which has since exited`
                          : "Not started from a terminal of this app"
                      }
                    >
                      (exited)
                    </span>
                  )}
                </td>
                <td className="ports-table-address" title={`Bound to ${p.address}`}>
                  {urlFor(p.port)}
                </td>
                <td className="ports-table-actions">
                  <div className="ports-table-action-row">
                  <button
                    className="icon-button port-action-button"
                    title={`${forwarded.has(p.port) ? "Open at localhost" : "Open"} (${secondaryHint()})`}
                    {...openActionProps(() => openPort(p.port), p.port)}
                  >
                    <Icon name="link-external" />
                  </button>
                  <button
                    className="icon-button port-action-button"
                    title="Open in Perch"
                    onClick={() => openPortInApp(p.port)}
                  >
                    <Icon name="open-preview" />
                  </button>
                  <button
                    className="icon-button port-action-button"
                    title={copiedPort === p.port ? "Copied" : "Copy URL"}
                    onClick={() => onCopyPortUrl(p.port)}
                  >
                    <Icon name={copiedPort === p.port ? "check" : "copy"} />
                  </button>
                  {p.pid !== undefined && (
                    <button
                      className="icon-button port-action-button"
                      title="Kill process"
                      disabled={killing.has(p.port)}
                      onClick={() => onKillPort(p)}
                    >
                      <Icon name="trash" />
                    </button>
                  )}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

// ---- Activation ----

interface ExtensionContext {
  registerFileViewer(viewer: {
    id: string;
    extensions: string[];
    mode: "default" | "preview";
    component: typeof BrowserView;
    icon?: string;
  }): void;
  registerCommand?(command: { id: string; label: string; defaultBinding?: string; run: () => void }): void;
  registerUrlHandler?(handler: (url: string) => boolean): void;
  registerStatusBarItem(item: {
    id: string;
    title?: string;
    placement?: "left" | "right";
    order?: number;
    visibilitySetting?: string;
    component: (props: StatusItemProps) => ReturnType<typeof PortsStatusItem>;
  }): void;
  // Optional: an older host has no bottom-panel views.
  registerPanelView?(view: {
    id: string;
    title: string;
    icon?: string;
    order?: number;
    component: (props: PanelViewProps) => ReturnType<typeof PortsTableView>;
  }): void;
  serverFetch(path: string, init?: RequestInit): Promise<Response>;
  assetUrl(relPath: string): string;
  settings: SettingsApi;
  app: {
    getActiveContext(): ActiveContext;
    openViewerTab(viewerId: string, path: string, opts?: { title?: string }): void;
    promptDialog?(message: string, defaultValue?: string): Promise<string | null>;
    openSessionWindow?(sessionName: string, opts?: { createCwd?: string; windowIndex?: number }): void;
    togglePanelView?(viewId: string): boolean;
    portMenuItems?(port: { port: number; address: string; pid?: number; process?: string }): { label: string; onClick: () => void }[];
    tunnels: {
      auth(): Promise<TunnelAuth>;
      status(client: string): Promise<TunnelStatus>;
    };
    proxyConfig(): Promise<ProxyConfig>;
    webPreview: {
      open(url: string): Promise<{ src: string; url: string; site: string; token: string }>;
      clear(site?: string): Promise<void>;
    };
  };
}

// The status-bar readout: how many ports are listening, whether a tunnel is
// carrying them, and a popover listing them with the one command that
// forwards everything. Lives here rather than in core so the readout appears
// only while this extension is enabled, and so it can use the extension's own
// data, settings and proxy config.
interface StatusItemProps {
  context: {
    mobilePointer: boolean;
    openPopover(anchor: DOMRect, content: ReactNode): void;
    closePopover(): void;
    confirmDialog(message: string, confirmLabel?: string): Promise<boolean>;
  };
}

// The popover's body is its own component rather than a tree built inside the
// item: the host keeps whatever node it was handed at click time, so a tree
// closing over the item's render would freeze the moment it opened. As a
// component it subscribes to the ports feed itself and stays live — which is
// what makes Kill usable here, since the killed row has to leave the list
// while the user is still looking at it.
function PortsStatusPopover({ context }: StatusItemProps) {
  const { ports, tunnel, error: feedError, reload } = usePortsFeed();
  const [auth, setAuth] = useState<TunnelAuth>(NO_AUTH);
  const [proxyConfig, setProxyConfig] = useState<ProxyConfig>(NO_PROXY_CONFIG);
  const [copiedPort, setCopiedPort] = useState<number | null>(null);
  const [copied, setCopied] = useState(false);
  const [killing, setKilling] = useState<Set<number>>(new Set());
  const [error, setError] = useState<string | null>(null);

  // Neither changes while the app runs, so they're read once per opening
  // rather than on the feed's timer.
  useEffect(() => {
    fetchTunnelAuth()
      .then(setAuth)
      .catch(() => setAuth(NO_AUTH));
    fetchProxyConfig()
      .then(setProxyConfig)
      .catch(() => setProxyConfig(NO_PROXY_CONFIG));
  }, []);

  const forwarded = new Set(tunnel.ports);
  const openPort = (port: number) => {
    // A forwarded port is reachable directly, which beats the proxy: no path
    // rewriting, no subdomain, and absolute asset paths just work.
    if (forwarded.has(port)) window.open(`http://localhost:${port}/`, "_blank", "noopener");
    else window.open(proxyUrl(port, proxyConfig), "_blank", "noopener");
  };

  const onCopy = () => {
    copyText(buildCommand(window.location.origin, auth, false))
      .then(() => {
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1500);
      })
      .catch(() => {});
  };

  const onCopyPortUrl = (port: number) => {
    copyText(proxyUrl(port, proxyConfig))
      .then(() => {
        setCopiedPort(port);
        window.setTimeout(() => setCopiedPort(null), 1500);
      })
      .catch(() => {});
  };

  // Same action, prompt and SIGTERM-then-SIGKILL route as the panel's Kill.
  // The host's own confirm dialog rather than window.confirm: the native one
  // blurs the window, and the popover closes on blur — the user would
  // confirm into a panel that had already vanished.
  const onKillPort = (p: ListeningPort) => {
    context
      .confirmDialog(
        `Kill ${p.process ?? "process"} (pid ${p.pid}) listening on port ${p.port}?`,
        "Kill",
      )
      .then((ok) => {
        if (!ok) return;
        setKilling((prev) => new Set(prev).add(p.port));
        setError(null);
        return killPort(p.port)
          // The row only leaves once the server has been asked again — the
          // process gets a grace period before SIGKILL, so a list refreshed
          // from local optimism could well be wrong.
          .then(() => reload())
          .catch((err) => setError(err instanceof Error ? err.message : String(err)))
          .finally(() => {
            setKilling((prev) => {
              const next = new Set(prev);
              next.delete(p.port);
              return next;
            });
          });
      })
      .catch(() => {});
  };

  return (
    <div className="ports-status-popover">
      {/* The panel's own error styling — a failed kill reads the same here. */}
      {error && <div className="ports-error">{error}</div>}
      <ul className="port-list">
        {ports.map((p) => (
          <li key={p.port} className="port-row">
            <button
              className="port-item"
              title={
                forwarded.has(p.port)
                  ? `Forwarded - open http://localhost:${p.port}/ (${secondaryHint()})`
                  : `Open port ${p.port} (${secondaryHint()})`
              }
              {...openActionProps(() => openPort(p.port), p.port)}
            >
              {forwarded.has(p.port) && <Icon name="plug" className="port-forwarded-dot" />}
              <span className="port-number">{p.port}</span>
              {p.process && <span className="port-process">{p.process}</span>}
              <SessionBadge port={p} />
            </button>
            {/* The same row actions the PORTS view offers. */}
            <div className="port-actions">
              <button
                className="icon-button port-action-button"
                title={`${forwarded.has(p.port) ? "Open at localhost" : "Open"} (${secondaryHint()})`}
                tabIndex={-1}
                {...openActionProps(() => openPort(p.port), p.port)}
              >
                <Icon name="link-external" />
              </button>
              <button
                className="icon-button port-action-button"
                title="Open in Perch"
                tabIndex={-1}
                onClick={() => openPortInApp(p.port)}
              >
                <Icon name="open-preview" />
              </button>
              <button
                className="icon-button port-action-button"
                title={copiedPort === p.port ? "Copied" : "Copy URL"}
                tabIndex={-1}
                onClick={() => onCopyPortUrl(p.port)}
              >
                <Icon name={copiedPort === p.port ? "check" : "copy"} />
              </button>
              {/* No pid, nothing to signal — the port is held by something
                  outside the terminals this extension can see. */}
              {p.pid !== undefined && (
                <button
                  className="icon-button port-action-button"
                  title="Kill process"
                  disabled={killing.has(p.port)}
                  tabIndex={-1}
                  onClick={() => onKillPort(p)}
                >
                  <Icon name="trash" />
                </button>
              )}
            </div>
          </li>
        ))}
        {/* A list that failed to load isn't an empty one: say so, with Retry. */}
        {ports.length === 0 && feedError && (
          <li className="session-empty ports-feed-error">
            Couldn't list the ports: {feedError}{" "}
            <button className="ports-btn-ghost" onClick={reload}>
              Retry
            </button>
          </li>
        )}
        {ports.length === 0 && !feedError && <li className="session-empty">No listening ports in your terminals</li>}
      </ul>
      <div className="ports-status-popover-footer">
        <span className="ports-status-hint">
          {tunnel.allForwarded
            ? "All ports forwarded to this machine."
            : tunnel.connected
              ? "Tunnel connected - run the command again to pick up new ports."
              : "Run the forward command locally to reach every port at localhost."}
        </span>
        <button
          className="icon-button"
          title={copied ? "Copied" : "Copy the command that forwards every port"}
          onClick={onCopy}
        >
          <Icon name={copied ? "check" : "copy"} />
        </button>
      </div>
    </div>
  );
}

function PortsStatusItem({ context }: StatusItemProps) {
  const { ports, tunnel } = usePortsFeed();

  return (
    <button
      className="status-bar-item"
      data-menu-trigger="true"
      aria-haspopup="dialog"
      title={
        tunnel.allForwarded
          ? `${ports.length} listening port${ports.length === 1 ? "" : "s"}, all forwarded to this machine`
          : `${ports.length} listening port${ports.length === 1 ? "" : "s"} in your terminals`
      }
      // Desktop: the PORTS view in the bottom panel, toggled (the host hides
      // the panel when that view is already showing). Phones keep the
      // popover, since the panel is as wide as the screen there, and so does
      // a desktop where the user switched the view off (the toggle then
      // answers false). openPopover toggles too: the host keys it on this
      // item's id.
      onClick={(e) => {
        if (!context.mobilePointer && togglePanelView?.(PORTS_VIEW_ID)) return;
        context.openPopover(e.currentTarget.getBoundingClientRect(), <PortsStatusPopover context={context} />);
      }}
    >
      <Icon name="plug" className={tunnel.allForwarded ? "port-forwarded-icon" : undefined} />
      <span>{ports.length}</span>
    </button>
  );
}


export function activate(ctx: ExtensionContext): void {
  serverFetch = ctx.serverFetch;
  extSettings = ctx.settings;
  getActiveContext = ctx.app.getActiveContext;
  openViewerTab = ctx.app.openViewerTab;
  openSessionWindow = ctx.app.openSessionWindow ?? null;
  togglePanelView = ctx.app.togglePanelView ?? null;
  extraPortMenuItems = ctx.app.portMenuItems ?? null;
  coreApp = ctx.app;
  removeStylesheet = injectStylesheet(ctx.assetUrl, "dist/client.css");
  // The wide table, for hosts that have a bottom panel to put it in.
  ctx.registerPanelView?.({
    id: "ports",
    title: "Ports",
    icon: "plug",
    order: 10,
    component: PortsTableView,
  });
  // No sidebar panel any more: the status-bar item and its popover are the
  // whole surface (the panel component is still what that popover renders).
  ctx.registerStatusBarItem({
    id: "ports",
    title: "Ports",
    placement: "right",
    order: 10,
    component: PortsStatusItem,
  });
  // The web preview tab (browser.tsx). Still "portProxy": tabs the PORTS Open
  // action opened before it grew an address bar restore into it.
  ctx.registerFileViewer({
    id: "portProxy",
    extensions: [],
    mode: "default",
    component: BrowserView,
    // Every tab is a web page, whatever its address ends in.
    icon: "globe",
  });
  configureBrowser({
    fetchListeningPorts: () => fetchPorts(),
    // Always the app-origin path, even with a PROXY_DOMAIN configured: a
    // "<port>.<domain>" subdomain is another origin, where the tab can't
    // follow the page's address, step back or forward, or pick elements.
    // Opening in the browser keeps the subdomain, where every app works
    // unmodified.
    localProxyBase: async (port) => ({ base: proxyUrl(port, NO_PROXY_CONFIG), crossOrigin: false }),
    openUrlTab: (url) => openUrlTab(url),
    resolveCwd: () => getActiveContext?.()?.cwd ?? null,
    readSendAutoSubmit,
    hookBase: (ctx.assetUrl("x").match(/^(\/api\/extensions\/[^/]+)\/file\//)?.[1] ?? "").replace("/extensions/", "/ext/"),
    pageAgentUrl: ctx.assetUrl("dist/page-agent.js"),
    webPreview: ctx.app.webPreview,
  });
  if (ctx.app.promptDialog) setViewportPrompt(ctx.app.promptDialog);
  ctx.registerCommand?.({
    id: "openUrl",
    label: "Web Preview: Open URL…",
    run: () => {
      void ctx.app.promptDialog?.("Open a web address in a preview tab", "https://").then((input) => {
        if (!input?.trim()) return;
        const url = parseAddress(input);
        openUrlTab(url ? url.href : input.trim());
      });
    },
  });
  // Terminal links the user chose to open inside Perch (core's openUrl).
  ctx.registerUrlHandler?.((url) => {
    if (!openViewerTab) return false;
    openUrlTab(url);
    return true;
  });
}

function openUrlTab(url: string): void {
  let title = url;
  try {
    title = new URL(url).host;
  } catch {
    // an address the tab will report as invalid
  }
  openViewerTab?.("portProxy", browserTabPath(url), { title });
}

export function deactivate(): void {
  removeStylesheet?.();
  removeStylesheet = null;
  openSessionWindow = null;
  coreApp = null;
  togglePanelView = null;
  extraPortMenuItems = null;
  serverFetch = null;
  extSettings = null;
  getActiveContext = null;
  openViewerTab = null;
  configureBrowser(null);
}
