// ports: the PORTS accordion section, extracted from core (formerly
// client/src/components/PortsPanel.tsx). Registers as a "run"-located
// sidebar panel so it renders as an accordion section in the Run tab,
// alongside TASKS (it lived in the Explorer accordion before that tab
// existed; the panel id is unchanged, so stored order/collapse/size for it
// carries over). Host hooks
// (serverFetch for this extension's own /list & /kill routes) arrive via
// module-level bridge variables set once in activate() — same pattern as
// the search and git-scm extensions.
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import "./style.css";
import { copyText } from "../../_shared/clipboard";
import { injectStylesheet } from "../../_shared/injectStylesheet";
import Icon from "../../_shared/Icon";
import type { MenuItem } from "../../_shared/types";
import { useListNavigation } from "../../_shared/useListNavigation";
import { useLongPressMenu } from "../../_shared/useLongPressMenu";
import {
  agentWindows,
  fetchSessions,
  resolveAgentTargets,
  sendToAgent,
  type AgentTargetProgram,
} from "../../_shared/agentTarget";

// ---- Module-level host bridge ----

let serverFetch: ((path: string, init?: RequestInit) => Promise<Response>) | null = null;
let removeStylesheet: (() => void) | null = null;
let extSettings: SettingsApi | null = null;
let openViewerTab: ((viewerId: string, path: string, opts?: { title?: string }) => void) | null = null;
let getActiveContext: (() => ActiveContext) | null = null;

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

// Which panes count as an agent comes from core's registry (Settings → AI
// Providers), and from nowhere else. This extension had its own agentPrograms
// setting until the migration; it is gone, not deprecated.
function agentTargets(): Promise<AgentTargetProgram[]> {
  return resolveAgentTargets();
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

// Core routes — tunnel/proxy are core infrastructure; this panel only reads
// their config to compose URLs and the tunnel command.
function fetchTunnelAuth(): Promise<TunnelAuth> {
  return fetch("/api/tunnel-auth").then((res) => readJson<TunnelAuth>(res));
}

function fetchProxyConfig(): Promise<ProxyConfig> {
  return fetch("/api/proxy-config").then((res) => readJson<ProxyConfig>(res));
}

// ---- Panel ----

const POLL_MS = 5_000;
const NO_AUTH: TunnelAuth = { cookie: null, authorization: null };
const NO_PROXY_CONFIG: ProxyConfig = { domain: null };
const MASK = "••••";

function isLoopback(address: string): boolean {
  return address === "127.0.0.1" || address === "::1" || address.startsWith("127.");
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
function buildCommand(origin: string, auth: TunnelAuth, mask: boolean): string {
  const headers = authHeaders(auth).map((h) => ({ ...h, value: mask ? MASK : h.value }));
  const curlArgs = headers.map((h) => `-H ${shellQuote(`${h.name}: ${h.value}`)}`).join(" ");
  const nodeArgs = headers.map((h) => `--header ${shellQuote(`${h.name}: ${h.value}`)}`).join(" ");
  // The script streams from curl straight into node's stdin — no file ever
  // touches disk (no stray tunnel.mjs in the user's cwd), and no /tmp-style
  // path that breaks on Windows. --input-type=module because stdin scripts
  // default to CommonJS.
  const curl = `curl -s ${curlArgs ? `${curlArgs} ` : ""}${origin}/tunnel.mjs`;
  const node = `node --input-type=module - --url ${origin} ${nodeArgs ? `${nodeArgs} ` : ""}--all`;
  return `${curl} | ${node}`;
}

// code-server-style: a configured PROXY_DOMAIN routes "<port>.<domain>"
// straight to that port (every app works unmodified); otherwise fall back to
// the app-origin path proxy "/proxy/<port>/" (absolute-path assets need the
// Referer fallback or a domain — see core server/src/proxy.ts).
function proxyUrl(port: number, proxyConfig: ProxyConfig): string {
  if (proxyConfig.domain) {
    return `${window.location.protocol}//${port}.${proxyConfig.domain}/`;
  }
  return `${window.location.origin}/proxy/${port}/`;
}

// ---- Port proxy viewer: opens a port's app in a tab, with an element
// picker -> comment -> queue -> send flow (mirrors live-preview's, and
// git-scm's DiffView.tsx pending-comment treatment). Unlike live-preview
// (which serves static files it controls and can inject a script into),
// this iframes a live-streamed proxy response it never touches — so
// picking is done via direct DOM access on the iframe's own document
// instead of an injected script + postMessage handshake. That only works
// same-origin: the default path-based "/proxy/<port>/" URL shares this
// app's own origin, but a configured PROXY_DOMAIN routes to a real
// "<port>.<domain>" subdomain, which the browser blocks parent-frame DOM
// access to — Inspect is disabled in that case (see crossOrigin below). ----

interface ElementRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

interface PickedElement {
  selector: string;
  outerHTML: string;
  styles: Record<string, string>;
  rect: ElementRect;
}

// A drafted-but-not-yet-sent element comment — mirrors live-preview's
// PendingElementComment, queued via "Add Comment" and delivered together by
// "Send to Agent" rather than one message per pick.
interface PendingElementComment {
  id: number;
  selector: string;
  outerHTML: string;
  styles: Record<string, string>;
  text: string;
  rect: ElementRect;
}

const STYLE_PROPS = [
  "display", "position", "top", "right", "bottom", "left", "width", "height",
  "margin", "padding", "boxSizing", "color", "backgroundColor", "fontFamily", "fontSize",
  "fontWeight", "lineHeight", "flexDirection", "justifyContent", "alignItems",
] as const;

// Walks up from el to (not including) its document's <body>, building a
// short CSS-like path: tag#id (stops climbing once an id is hit) else
// tag.class1.class2 plus :nth-of-type(n) when siblings share the same tag.
// Ported from live-preview/server.js's INSPECT_SCRIPT selectorFor to operate
// directly on a live DOM node here instead of inside an injected page script.
function selectorFor(el: Element): string {
  const doc = el.ownerDocument;
  const parts: string[] = [];
  let node: Element | null = el;
  while (node && node.nodeType === 1 && node !== doc.body && node !== doc.documentElement) {
    let part = node.tagName.toLowerCase();
    if (node.id) {
      parts.unshift(`${part}#${node.id}`);
      break;
    }
    if (typeof node.className === "string" && node.className.trim()) {
      const cls = node.className.trim().split(/\s+/).filter(Boolean).slice(0, 2);
      if (cls.length) part += `.${cls.join(".")}`;
    }
    const parent: Element | null = node.parentElement;
    if (parent) {
      const siblings = Array.from(parent.children).filter((c) => c.tagName === node!.tagName);
      if (siblings.length > 1) part += `:nth-of-type(${siblings.indexOf(node) + 1})`;
    }
    parts.unshift(part);
    node = node.parentElement;
  }
  return parts.join(" > ");
}

function buildElementContextBlock(label: string, pc: PendingElementComment): string {
  const styleLines = Object.entries(pc.styles)
    .map(([k, v]) => `  ${k}: ${v};`)
    .join("\n");
  return `Element ${pc.selector} on ${label}:\n\`\`\`html\n${pc.outerHTML}\n\`\`\`\nComputed styles:\n${styleLines}\n\n${pc.text}`;
}

// Joins every pending element comment's own context block into one message —
// sent as a single review, not one send-keys call per comment (same
// combining scheme as git-scm's DiffView.tsx buildCombinedText).
function buildCombinedElementText(label: string, pending: PendingElementComment[]): string {
  return pending.map((pc) => buildElementContextBlock(label, pc)).join("\n\n---\n\n");
}

// Clamps a popover anchored to a picked element's rect so it stays fully
// inside the host container (an element near the right/bottom edge would
// otherwise render partly or fully off-screen) and doesn't render underneath
// the pending-comments footer panel when that's visible — falls back to
// placing the popover above the element when there isn't room below.
function clampPopoverPosition(
  container: HTMLElement,
  popover: HTMLElement,
  anchor: ElementRect,
): { left: number; top: number } {
  const gap = 4;
  const edge = 8;
  const cw = container.clientWidth;
  const ch = container.clientHeight;
  const pw = popover.offsetWidth;
  const ph = popover.offsetHeight;
  const footer = container.querySelector<HTMLElement>(".ports-pending-panel");
  const reservedBottom = footer ? footer.offsetHeight : 0;
  const below = anchor.top + anchor.height + gap;
  const above = anchor.top - ph - gap;
  const maxTop = ch - reservedBottom - ph - edge;
  const top = below <= maxTop ? Math.max(edge, below) : Math.max(edge, Math.min(above, maxTop));
  const left = Math.min(Math.max(anchor.left, edge), Math.max(edge, cw - pw - edge));
  return { left, top };
}

// Renders the popover once at its naive "below the element" position (so it
// has a real size to measure), then corrects it before paint — the flash of
// the naive position is never visible since useLayoutEffect runs before the
// browser paints.
function usePopoverPosition(containerRef: React.RefObject<HTMLElement | null>, anchor: ElementRect | null) {
  const popoverRef = useRef<HTMLDivElement | null>(null);
  const [corrected, setCorrected] = useState<{ left: number; top: number } | null>(null);

  useLayoutEffect(() => {
    if (!anchor) {
      setCorrected(null);
      return;
    }
    const container = containerRef.current;
    const popover = popoverRef.current;
    if (!container || !popover) return;
    setCorrected(clampPopoverPosition(container, popover, anchor));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [anchor?.left, anchor?.top, anchor?.width, anchor?.height]);

  // Re-clamp when the popover's own size changes after the initial
  // measurement (typing wraps to another line, or the textarea's resize
  // handle is dragged) instead of only once at open time.
  useLayoutEffect(() => {
    const container = containerRef.current;
    const popover = popoverRef.current;
    if (!anchor || !container || !popover) return;
    const observer = new ResizeObserver(() => {
      setCorrected(clampPopoverPosition(container, popover, anchor));
    });
    observer.observe(popover);
    return () => observer.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [anchor?.left, anchor?.top, anchor?.width, anchor?.height]);

  const fallback = anchor ? { left: anchor.left, top: anchor.top + anchor.height + 4 } : { left: 0, top: 0 };
  return { popoverRef, pos: corrected ?? fallback };
}

interface PortProxyProps {
  filePath: string;
  active: boolean;
  toolbarTarget?: HTMLDivElement | null;
}

function PortProxyView({ filePath, active, toolbarTarget }: PortProxyProps) {
  const port = Number(filePath.slice("port:".length));
  const label = `port ${port}`;

  const [proxyConfig, setProxyConfig] = useState<ProxyConfig>(NO_PROXY_CONFIG);
  const [reloadTick, setReloadTick] = useState(0);
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const hostRef = useRef<HTMLDivElement | null>(null);
  const [inspecting, setInspecting] = useState(false);
  const [activePick, setActivePick] = useState<PickedElement | null>(null);
  const [pickComment, setPickComment] = useState("");
  const [pendingComments, setPendingComments] = useState<PendingElementComment[]>([]);
  const [sendBusy, setSendBusy] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const nextPendingId = useRef(0);
  const [expandedId, setExpandedId] = useState<number | null>(null);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editText, setEditText] = useState("");

  useEffect(() => {
    let cancelled = false;
    fetchProxyConfig()
      .then((next) => {
        if (!cancelled) setProxyConfig(next);
      })
      .catch(() => {
        if (!cancelled) setProxyConfig(NO_PROXY_CONFIG);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const url = proxyUrl(port, proxyConfig);
  const crossOrigin = proxyConfig.domain !== null;
  const refresh = useCallback(() => setReloadTick((t) => t + 1), []);

  const toggleInspect = useCallback(() => {
    if (crossOrigin) return;
    setInspecting((prev) => !prev);
  }, [crossOrigin]);

  // Picks via direct DOM access on the iframe's own (same-origin) document —
  // see the file-level comment above for why this differs from
  // live-preview's injected-script + postMessage approach.
  useEffect(() => {
    if (!inspecting) return;
    const iframe = iframeRef.current;
    let doc: Document | null = null;
    try {
      doc = iframe?.contentDocument ?? null;
    } catch {
      doc = null;
    }
    if (!doc) {
      setInspecting(false);
      return;
    }
    const overlay = doc.createElement("div");
    overlay.style.cssText =
      "position:fixed;pointer-events:none;z-index:2147483647;" +
      "background:rgba(79,168,255,0.25);border:1px solid rgba(79,168,255,0.9);display:none;";
    doc.documentElement.appendChild(overlay);
    let hovered: Element | null = null;

    const onMouseMove = (e: MouseEvent) => {
      const el = doc!.elementFromPoint(e.clientX, e.clientY);
      if (!el || el === overlay) return;
      hovered = el;
      const r = el.getBoundingClientRect();
      overlay.style.left = `${r.left}px`;
      overlay.style.top = `${r.top}px`;
      overlay.style.width = `${r.width}px`;
      overlay.style.height = `${r.height}px`;
      overlay.style.display = "block";
    };

    const onClick = (e: MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      const el = hovered || doc!.elementFromPoint(e.clientX, e.clientY);
      if (!el) return;
      const cs = doc!.defaultView?.getComputedStyle(el);
      const styles: Record<string, string> = {};
      for (const p of STYLE_PROPS) styles[p] = cs ? cs[p as keyof CSSStyleDeclaration] as string : "";
      let html = el.outerHTML;
      if (html.length > 4000) html = `${html.slice(0, 4000)}…`;
      const r = el.getBoundingClientRect();
      setActivePick({
        selector: selectorFor(el),
        outerHTML: html,
        styles,
        rect: { left: r.left, top: r.top, width: r.width, height: r.height },
      });
      setPickComment("");
      setSendError(null);
      setInspecting(false);
    };

    doc.addEventListener("mousemove", onMouseMove, true);
    doc.addEventListener("click", onClick, true);
    return () => {
      doc?.removeEventListener("mousemove", onMouseMove, true);
      doc?.removeEventListener("click", onClick, true);
      overlay.remove();
    };
  }, [inspecting, reloadTick]);

  const cancelPick = useCallback(() => {
    setActivePick(null);
    setPickComment("");
  }, []);

  const addPickComment = useCallback(() => {
    if (!activePick || !pickComment.trim()) return;
    const id = nextPendingId.current++;
    setPendingComments((prev) => [
      ...prev,
      {
        id,
        selector: activePick.selector,
        outerHTML: activePick.outerHTML,
        styles: activePick.styles,
        text: pickComment.trim(),
        rect: activePick.rect,
      },
    ]);
    setActivePick(null);
    setPickComment("");
  }, [activePick, pickComment]);

  const removePendingComment = useCallback((id: number) => {
    setPendingComments((prev) => prev.filter((pc) => pc.id !== id));
    setExpandedId((prev) => (prev === id ? null : prev));
    setEditingId((prev) => (prev === id ? null : prev));
  }, []);

  const toggleExpanded = useCallback((id: number) => {
    setExpandedId((prev) => (prev === id ? null : id));
  }, []);

  const startEdit = useCallback((pc: PendingElementComment) => {
    setEditingId(pc.id);
    setEditText(pc.text);
  }, []);

  const cancelEdit = useCallback(() => {
    setEditingId(null);
    setEditText("");
  }, []);

  const saveEdit = useCallback(() => {
    const text = editText.trim();
    if (editingId === null || !text) return;
    setPendingComments((prev) => prev.map((pc) => (pc.id === editingId ? { ...pc, text } : pc)));
    setEditingId(null);
    setEditText("");
  }, [editingId, editText]);

  const sendAllComments = useCallback(async () => {
    if (pendingComments.length === 0) return;
    const text = buildCombinedElementText(label, pendingComments);
    setSendBusy(true);
    setSendError(null);
    try {
      const activeCwd = getActiveContext?.()?.cwd ?? null;
      if (!activeCwd) {
        setSendError("No active project - open a project first.");
        return;
      }
      const [sessions, agents] = await Promise.all([fetchSessions(), agentTargets()]);
      const targets = agentWindows(sessions, activeCwd, agents);
      if (targets.length === 0) {
        setSendError("No agent is running in this project - start one first.");
        return;
      }
      await sendToAgent(targets[0].sessionName, text, readSendAutoSubmit(), { windowIndex: targets[0].windowIndex });
      setPendingComments([]);
      setExpandedId(null);
      setEditingId(null);
    } catch (err) {
      setSendError(err instanceof Error ? err.message : String(err));
    } finally {
      setSendBusy(false);
    }
  }, [pendingComments, label]);

  const expandedComment = pendingComments.find((pc) => pc.id === expandedId) ?? null;
  const { popoverRef: pickPopoverRef, pos: pickPos } = usePopoverPosition(hostRef, activePick?.rect ?? null);
  const { popoverRef: commentPopoverRef, pos: commentPos } = usePopoverPosition(
    hostRef,
    expandedComment?.rect ?? null,
  );

  const controls = (
    <>
      <button className="icon-button" title="Refresh" onClick={refresh}>
        <Icon name="refresh" />
      </button>
      <button className="icon-button" title="Open in Browser" onClick={() => window.open(url, "_blank", "noopener")}>
        <Icon name="link-external" />
      </button>
      <button
        className={`icon-button${inspecting ? " active" : ""}`}
        disabled={crossOrigin}
        title={
          crossOrigin
            ? "Inspect isn't available with a custom proxy domain configured"
            : inspecting
              ? "Click an element to comment on it (click the button again to cancel)"
              : "Inspect element → add comment"
        }
        onClick={toggleInspect}
      >
        <Icon name="inspect" />
      </button>
    </>
  );

  return (
    <div ref={hostRef} className={`ports-proxy-host${active ? "" : " hidden"}`}>
      <iframe
        key={reloadTick}
        ref={iframeRef}
        className="ports-proxy-frame"
        src={url}
        title={label}
      />
      {activePick && (
        <div ref={pickPopoverRef} className="ports-pick-popover" style={{ left: pickPos.left, top: pickPos.top }}>
          <div className="ports-pick-selector">{activePick.selector}</div>
          <textarea
            autoFocus
            placeholder="What should the agent do with this element?"
            value={pickComment}
            onChange={(e) => setPickComment(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                e.preventDefault();
                cancelPick();
              } else if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
                e.preventDefault();
                addPickComment();
              }
            }}
          />
          <div className="ports-pick-buttons">
            <button
              type="button"
              className="ports-btn-primary"
              disabled={!pickComment.trim()}
              onClick={addPickComment}
            >
              Add Comment
            </button>
            <button type="button" className="ports-btn-ghost" onClick={cancelPick}>
              Cancel
            </button>
          </div>
        </div>
      )}
      {pendingComments.map((pc, index) => (
        <button
          key={pc.id}
          type="button"
          className="ports-comment-badge ports-comment-marker"
          style={{ left: pc.rect.left + pc.rect.width / 2, top: pc.rect.top + pc.rect.height / 2 }}
          title={pc.text}
          onClick={() => toggleExpanded(pc.id)}
        >
          {index + 1}
        </button>
      ))}
      {expandedComment && (
        <div
          ref={commentPopoverRef}
          className="ports-pick-popover ports-comment-popover"
          style={{ left: commentPos.left, top: commentPos.top }}
        >
          <div className="ports-pick-selector">{expandedComment.selector}</div>
          {editingId === expandedComment.id ? (
            <>
              <textarea
                autoFocus
                value={editText}
                onChange={(e) => setEditText(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Escape") {
                    e.preventDefault();
                    cancelEdit();
                  } else if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
                    e.preventDefault();
                    saveEdit();
                  }
                }}
              />
              <div className="ports-pick-buttons">
                <button
                  type="button"
                  className="ports-btn-primary"
                  disabled={!editText.trim()}
                  onClick={saveEdit}
                >
                  Save
                </button>
                <button type="button" className="ports-btn-ghost" onClick={cancelEdit}>
                  Cancel
                </button>
              </div>
            </>
          ) : (
            <>
              <div className="ports-comment-text">{expandedComment.text}</div>
              <div className="ports-pick-buttons">
                <button type="button" className="ports-btn-ghost" onClick={() => startEdit(expandedComment)}>
                  <Icon name="edit" /> Edit
                </button>
                <button
                  type="button"
                  className="ports-btn-ghost"
                  onClick={() => removePendingComment(expandedComment.id)}
                >
                  <Icon name="close" /> Remove
                </button>
              </div>
            </>
          )}
        </div>
      )}
      {pendingComments.length > 0 && (
        <div className="ports-pending-panel">
          <div className="ports-pending-summary">
            <span className="ports-pending-count">
              {pendingComments.length} comment{pendingComments.length === 1 ? "" : "s"} pending
            </span>
            <button
              type="button"
              className="ports-btn-primary"
              disabled={sendBusy}
              onClick={() => void sendAllComments()}
            >
              <Icon name="send" /> {sendBusy ? "Sending…" : "Send to Agent"}
            </button>
            <button
              type="button"
              className="ports-btn-ghost"
              disabled={sendBusy}
              onClick={() => {
                setPendingComments([]);
                setExpandedId(null);
                setEditingId(null);
              }}
            >
              Clear
            </button>
          </div>
          {sendError && <div className="ports-pending-error">{sendError}</div>}
          <ul className="ports-pending-list">
            {pendingComments.map((pc, index) => (
              <li key={pc.id} className="ports-pending-item">
                <button type="button" className="ports-comment-badge" onClick={() => toggleExpanded(pc.id)}>
                  {index + 1}
                </button>
                <span className="ports-pending-selector">{pc.selector}</span>
                <span className="ports-pending-text">{pc.text}</span>
                <button
                  type="button"
                  className="icon-button"
                  title="Remove this comment"
                  onClick={() => removePendingComment(pc.id)}
                >
                  <Icon name="close" />
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
      {active && toolbarTarget && createPortal(controls, toolbarTarget)}
    </div>
  );
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
  return fetch("/api/tunnel-status").then((res) => readJson<TunnelStatus>(res));
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

interface PanelProps {
  actionsTarget?: HTMLDivElement | null;
  showMenu?: (x: number, y: number, items: MenuItem[]) => void;
  confirmDialog?: (message: string, confirmLabel?: string) => Promise<boolean>;
}

function PortsPanel({ actionsTarget, showMenu, confirmDialog }: PanelProps) {
  // Touch/pen long-press → the same menu right-click opens.
  const bindMenu = useLongPressMenu();
  const [ports, setPorts] = useState<ListeningPort[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [copiedPort, setCopiedPort] = useState<number | null>(null);
  const [auth, setAuth] = useState<TunnelAuth>(NO_AUTH);
  const [proxyConfig, setProxyConfig] = useState<ProxyConfig>(NO_PROXY_CONFIG);
  const [killing, setKilling] = useState<Set<number>>(new Set());
  const [clickAction, setClickAction] = useState(readClickAction);

  useEffect(() => extSettings?.onDidChange(() => setClickAction(readClickAction())), []);
  // The header Refresh button (portaled into actionsTarget) bumps this to
  // force a reload — the role Sidebar's own per-panel refresh key played
  // before extraction.
  const [refreshKey, setRefreshKey] = useState(0);
  // Guards state updates from a fetch started before unmount but resolving
  // after — mirrors the effect's own `cancelled` flag, needed here too since
  // loadPorts is also invoked directly (not just from the effect) after kill.
  // Reset true on every mount (not just the initial ref value) — StrictMode's
  // dev double-invoke (mount, cleanup, mount) would otherwise leave this
  // stuck false after the cleanup from the first mount.
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const loadPorts = useCallback(() => {
    fetchPorts()
      .then((next) => {
        if (!mountedRef.current) return;
        setPorts(next);
        setError(null);

      })
      .catch((err) => {
        if (mountedRef.current) setError(err instanceof Error ? err.message : String(err));
      });
  }, []);

  useEffect(() => {
    let cancelled = false;

    const load = () => {
      loadPorts();
      // A failed auth fetch shouldn't break the ports list — fall back to no
      // headers, same as an unauthenticated deployment.
      fetchTunnelAuth()
        .then((next) => {
          if (cancelled) return;
          setAuth((prev) => {
            if (prev.cookie === next.cookie && prev.authorization === next.authorization) return prev;
            return next;
          });
        })
        .catch(() => {
          if (!cancelled) setAuth(NO_AUTH);
        });
      // Likewise for proxy config — no configured domain is a valid state,
      // not an error, so falling back is correct here too.
      fetchProxyConfig()
        .then((next) => {
          if (cancelled) return;
          setProxyConfig((prev) => (prev.domain === next.domain ? prev : next));
        })
        .catch(() => {
          if (!cancelled) setProxyConfig(NO_PROXY_CONFIG);
        });
    };

    load();
    // The initial load above and any refreshKey-triggered reload (a user
    // action, so the tab is visible) always run; only the background ticks
    // skip while hidden — resuming immediately on regaining visibility
    // instead of waiting out the rest of the interval. Ticks refresh just
    // the ports list: auth/proxy config are effectively static, so they
    // re-fetch only on the full loads above (initial, Refresh, visibility)
    // rather than every few seconds.
    const timer = window.setInterval(() => {
      if (!document.hidden) loadPorts();
    }, POLL_MS);
    const onVisibility = () => {
      if (!document.hidden) load();
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [refreshKey, loadPorts]);

  const origin = window.location.origin;

  const onCopy = () => {
    const realCommand = buildCommand(origin, auth, false);
    copyText(realCommand)
      .then(() => {
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1500);
      })
      .catch(() => {});
  };

  const openInBrowser = (port: number) => {
    window.open(proxyUrl(port, proxyConfig), "_blank", "noopener");
  };

  const openInApp = (port: number) => {
    openViewerTab?.("portProxy", `port:${port}`, { title: `Port ${port}` });
  };

  // The row's single quick-action button follows the clickAction setting;
  // the context menu below always offers both explicitly regardless of it.
  const onOpenPort = (port: number) => {
    if (readClickAction() === "browser") openInBrowser(port);
    else openInApp(port);
  };

  const onCopyPortUrl = (port: number) => {
    copyText(proxyUrl(port, proxyConfig))
      .then(() => {
        setCopiedPort(port);
        window.setTimeout(() => setCopiedPort((prev) => (prev === port ? null : prev)), 1500);
      })
      .catch(() => {});
  };

  const onKillPort = (p: ListeningPort) => {
    const confirm =
      confirmDialog ?? ((message: string) => Promise.resolve(window.confirm(message)));
    confirm(`Kill ${p.process ?? "process"} (pid ${p.pid}) listening on port ${p.port}?`, "Kill")
      .then((ok) => {
        if (!ok) return;
        setKilling((prev) => new Set(prev).add(p.port));
        return killPort(p.port)
          .then(() => loadPorts())
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

  const portRowId = (port: number) => `port:${port}`;
  const portsById = useMemo(() => new Map(ports.map((p) => [portRowId(p.port), p])), [ports]);
  const rowIds = useMemo(() => ports.map((p) => portRowId(p.port)), [ports]);

  const portMenuItems = (p: ListeningPort): MenuItem[] => {
    const items: MenuItem[] = [
      { label: "Open in App", onClick: () => openInApp(p.port) },
      { label: "Open in Browser", onClick: () => openInBrowser(p.port) },
      { label: "Copy URL", onClick: () => onCopyPortUrl(p.port) },
    ];
    if (p.pid !== undefined) {
      items.push({ label: "Kill Process", danger: true, onClick: () => onKillPort(p) });
    }
    return items;
  };

  const nav = useListNavigation({
    rowIds,
    onActivate: (id) => {
      const p = portsById.get(id);
      if (p) onOpenPort(p.port);
    },
    onContextMenuKey: (id, rect) => {
      const p = portsById.get(id);
      if (p) showMenu?.(rect.left + 8, rect.bottom, portMenuItems(p));
    },
  });

  return (
    <div className="ports-panel">
      {actionsTarget &&
        createPortal(
          <>
            <button
              className="icon-button"
              title={copied ? "Copied" : "Copy the command that forwards every port"}
              onClick={onCopy}
            >
              <Icon name={copied ? "check" : "copy"} />
            </button>
            <button
              className="icon-button"
              title="Refresh"
              onClick={() => setRefreshKey((k) => k + 1)}
            >
              <Icon name="refresh" />
            </button>
          </>,
          actionsTarget,
        )}
      {error && <div className="ports-error">{error}</div>}
      <ul className="port-list" onKeyDown={nav.onKeyDown}>
        {ports.map((p) => {
          const rowProps = nav.getRowProps(portRowId(p.port));
          return (
            <li key={p.port} className="port-row">
              <button
                className="port-item"
                title={p.pid ? `pid ${p.pid}` : undefined}
                onClick={() => onOpenPort(p.port)}
                onContextMenu={(e) => {
                  e.preventDefault();
                  nav.focusRow(portRowId(p.port));
                  showMenu?.(e.clientX, e.clientY, portMenuItems(p));
                }}
                {...bindMenu((x, y) => {
                  nav.focusRow(portRowId(p.port));
                  showMenu?.(x, y, portMenuItems(p));
                })}
                tabIndex={rowProps.tabIndex}
                ref={rowProps.ref}
                onFocus={rowProps.onFocus}
              >
                <span className="port-number">{p.port}</span>
                {p.process && <span className="port-process">{p.process}</span>}
                <span className="port-session">{p.session}</span>
                {!isLoopback(p.address) && <span className="port-address">{p.address}</span>}
              </button>
              <div className="port-actions">
                <button
                  className="icon-button port-action-button"
                  title={clickAction === "browser" ? "Open in browser" : "Open in app"}
                  tabIndex={-1}
                  onClick={() => onOpenPort(p.port)}
                >
                  <Icon name={clickAction === "browser" ? "link-external" : "open-preview"} />
                </button>
                <button
                  className="icon-button port-action-button"
                  title={copiedPort === p.port ? "Copied" : "Copy URL"}
                  tabIndex={-1}
                  onClick={() => onCopyPortUrl(p.port)}
                >
                  <Icon name={copiedPort === p.port ? "check" : "copy"} />
                </button>
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
          );
        })}
        {ports.length === 0 && !error && (
          <li className="session-empty">No listening ports in your terminals</li>
        )}
      </ul>
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
    component: (props: PanelProps) => ReturnType<typeof PortsPanel>;
  }): void;
  registerFileViewer(viewer: {
    id: string;
    extensions: string[];
    mode: "default" | "preview";
    component: typeof PortProxyView;
  }): void;
  registerStatusBarItem(item: {
    id: string;
    title?: string;
    placement?: "left" | "right";
    order?: number;
    visibilitySetting?: string;
    component: (props: StatusItemProps) => ReturnType<typeof PortsStatusItem>;
  }): void;
  serverFetch(path: string, init?: RequestInit): Promise<Response>;
  assetUrl(relPath: string): string;
  settings: SettingsApi;
  app: {
    getActiveContext(): ActiveContext;
    openViewerTab(viewerId: string, path: string, opts?: { title?: string }): void;
  };
}

// The status-bar readout: how many ports are listening, whether a tunnel is
// carrying them, and a popover listing them with the one command that
// forwards everything. Lives here rather than in core so the readout appears
// only while this extension is enabled, and so it can use the extension's own
// data, settings and proxy config.
interface StatusItemProps {
  context: {
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
  const { ports, tunnel, reload } = usePortsFeed();
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
                  ? `Forwarded - open http://localhost:${p.port}/`
                  : `Open port ${p.port}`
              }
              onClick={() => openPort(p.port)}
            >
              {forwarded.has(p.port) && <Icon name="plug" className="port-forwarded-dot" />}
              <span className="port-number">{p.port}</span>
              {p.process && <span className="port-process">{p.process}</span>}
              <span className="port-session">{p.session}</span>
            </button>
            {/* The same three row actions the panel offers. */}
            <div className="port-actions">
              <button
                className="icon-button port-action-button"
                title={forwarded.has(p.port) ? "Open at localhost" : "Open"}
                tabIndex={-1}
                onClick={() => openPort(p.port)}
              >
                <Icon name="link-external" />
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
        {ports.length === 0 && <li className="session-empty">No listening ports in your terminals</li>}
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
      // openPopover toggles: the host keys it on this item's id.
      onClick={(e) =>
        context.openPopover(
          e.currentTarget.getBoundingClientRect(),
          <PortsStatusPopover context={context} />,
        )
      }
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
  removeStylesheet = injectStylesheet(ctx.assetUrl, "dist/client.css");
  // No sidebar panel any more: the status-bar item and its popover are the
  // whole surface (the panel component is still what that popover renders).
  ctx.registerStatusBarItem({
    id: "ports",
    title: "Ports",
    placement: "right",
    order: 10,
    component: PortsStatusItem,
  });
  ctx.registerFileViewer({
    id: "portProxy",
    extensions: [],
    mode: "default",
    component: PortProxyView,
  });
}

export function deactivate(): void {
  removeStylesheet?.();
  removeStylesheet = null;
  serverFetch = null;
  extSettings = null;
  getActiveContext = null;
  openViewerTab = null;
}
