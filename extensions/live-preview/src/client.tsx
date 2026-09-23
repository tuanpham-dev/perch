import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import "./style.css";
import { injectStylesheet } from "../../_shared/injectStylesheet";
import Icon from "../../_shared/Icon";
import {
  agentWindows,
  fetchSessions,
  resolveAgentTargets,
  sendToAgent,
  type AgentTargetProgram,
} from "../../_shared/agentTarget";

interface SettingsApi {
  get(key: string): unknown;
  onDidChange(cb: () => void): () => void;
}

interface ActiveContext {
  sessionName: string | null;
  windowIndex: number | null;
  cwd: string | null;
}

let extSettings: SettingsApi | null = null;
let getActiveContext: (() => ActiveContext) | null = null;

// Parsed from ctx.assetUrl() at activate() time rather than hardcoded —
// ctx exposes no direct "this extension's server-hook base" accessor, but
// assetUrl(relPath) always returns "/api/extensions/<id>/file/<relPath>",
// so extracting <id> and rebuilding "/api/ext/<id>" survives a manifest
// rename at the cost of coupling to that URL shape.
let hookBase = "";

function readAutoRefresh(): boolean {
  const value = extSettings?.get("livePreview.autoRefresh");
  return value === undefined ? true : Boolean(value);
}

function readPollInterval(): number {
  const value = Number(extSettings?.get("livePreview.pollInterval"));
  if (!Number.isFinite(value)) return 1000;
  return Math.min(10000, Math.max(250, value));
}

// Which panes count as an agent comes from core's registry (Settings → AI
// Providers), and from nowhere else. This extension had its own agentPrograms
// setting until the migration; it is gone, not deprecated.
function agentTargets(): Promise<AgentTargetProgram[]> {
  return resolveAgentTargets();
}

function readSendAutoSubmit(): boolean {
  return extSettings?.get("livePreview.sendAutoSubmit") === true;
}

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

// A drafted-but-not-yet-sent element comment — mirrors DiffView.tsx's
// PendingComment (git-scm), queued via "Add Comment" and delivered together
// by "Send to Agent" rather than one message per pick. Keeps the element's
// rect so its numbered badge can stay anchored on the page.
interface PendingElementComment {
  id: number;
  selector: string;
  outerHTML: string;
  styles: Record<string, string>;
  text: string;
  rect: ElementRect;
}

function buildElementContextBlock(basename: string, pc: PendingElementComment): string {
  const styleLines = Object.entries(pc.styles)
    .map(([k, v]) => `  ${k}: ${v};`)
    .join("\n");
  return `Element ${pc.selector} in ${basename}:\n\`\`\`html\n${pc.outerHTML}\n\`\`\`\nComputed styles:\n${styleLines}\n\n${pc.text}`;
}

// Joins every pending element comment's own context block into one message —
// sent as a single review, not one send-keys call per comment (same
// combining scheme as git-scm's DiffView.tsx buildCombinedText).
function buildCombinedElementText(basename: string, pending: PendingElementComment[]): string {
  return pending.map((pc) => buildElementContextBlock(basename, pc)).join("\n\n---\n\n");
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
  const footer = container.querySelector<HTMLElement>(".live-preview-pending-panel");
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
    // Re-clamp whenever the anchor moves (a fresh pick) — width/height changes
    // (textarea resize, edit<->view toggle) are covered by the ResizeObserver
    // below rather than this dependency list.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [anchor?.left, anchor?.top, anchor?.width, anchor?.height]);

  // The popover's own size can change after the initial measurement (typing
  // more comment text wraps to another line, or the user drags the
  // textarea's resize handle) — re-clamp on any such change instead of only
  // once at open time, so it can't drift back off-screen mid-edit.
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

interface Props {
  filePath: string;
  active: boolean;
  toolbarTarget?: HTMLDivElement | null;
  openInEditor?: (path: string) => void;
}

function HtmlPreview({ filePath, active, toolbarTarget, openInEditor }: Props) {
  const slash = filePath.lastIndexOf("/");
  const dir = filePath.slice(0, slash);
  const basename = filePath.slice(slash + 1);

  const [token, setToken] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reloadTick, setReloadTick] = useState(0);
  const [autoRefresh, setAutoRefresh] = useState(readAutoRefresh);
  const [pollInterval, setPollInterval] = useState(readPollInterval);
  // Watched file -> mtime as of the last poll (see server.js's servedPaths).
  const lastMtimes = useRef<Record<string, number>>({});
  const scrollRef = useRef<[number, number] | null>(null);
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const hostRef = useRef<HTMLDivElement | null>(null);
  const [inspecting, setInspecting] = useState(false);
  // An element just picked, awaiting a typed comment before it's queued —
  // mirrors DiffView.tsx's selection+commentOpen (git-scm).
  const [activePick, setActivePick] = useState<PickedElement | null>(null);
  const [pickComment, setPickComment] = useState("");
  // Comments drafted via "Add Comment" but not yet sent — "Send to Agent"
  // delivers all of them together in one message.
  const [pendingComments, setPendingComments] = useState<PendingElementComment[]>([]);
  const [sendBusy, setSendBusy] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const nextPendingId = useRef(0);
  // Each queued comment shows as a small numbered badge over its element;
  // clicking one toggles a popover with its text and an edit option —
  // mirrors DiffView.tsx's comment-badge treatment (git-scm).
  const [expandedId, setExpandedId] = useState<number | null>(null);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editText, setEditText] = useState("");

  useEffect(
    () =>
      extSettings?.onDidChange(() => {
        setAutoRefresh(readAutoRefresh());
        setPollInterval(readPollInterval());
      }),
    [],
  );

  const refresh = useCallback(() => setReloadTick((t) => t + 1), []);

  // Mints (or reuses) a capability token for this folder via a normal
  // same-origin fetch from the app's own page — see server.js and
  // security.ts's isOriginExemptPath for why the iframe itself can't do
  // this (its opaque origin fails the app's Origin check by design).
  useEffect(() => {
    let cancelled = false;
    setToken(null);
    setError(null);
    lastMtimes.current = {};
    setActivePick(null);
    setPickComment("");
    setPendingComments([]);
    setSendError(null);
    setExpandedId(null);
    setEditingId(null);
    setEditText("");
    fetch(`${hookBase}/token?dir=${encodeURIComponent(dir)}`)
      .then((res) => res.json())
      .then((data: { token?: string; error?: string }) => {
        if (cancelled) return;
        if (data.token) setToken(data.token);
        else setError(data.error ?? "failed to start preview");
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, [dir]);

  // Reload-on-change poll over the files the preview actually loaded (the
  // HTML and whatever it requested, subfolders included), only while this
  // tab is visible and autoRefresh is on. Anything else in the folder can
  // change without resetting the page. No general file-watcher exists in
  // this app; this is a deliberate tradeoff (see plans/live-preview-extension.md).
  useEffect(() => {
    if (!active || !autoRefresh || !token) return;
    let cancelled = false;
    const poll = () => {
      fetch(`${hookBase}/public/mtime?token=${token}`)
        .then((res) => res.json())
        .then((data: { files?: Record<string, number> }) => {
          if (cancelled || !data.files) return;
          const seen = lastMtimes.current;
          // A path missing from `seen` is newly loaded, not changed.
          const changed = Object.entries(data.files).some(([rel, mtime]) => rel in seen && seen[rel] !== mtime);
          lastMtimes.current = data.files;
          if (changed) refresh();
        })
        .catch(() => {
          // Transient fetch failure — next tick retries; no need to surface.
        });
    };
    poll();
    const id = window.setInterval(poll, pollInterval);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [active, autoRefresh, pollInterval, token, refresh]);

  // Scroll-position handshake with the previewed page's injected script
  // (see server.js's SCROLL_SCRIPT) — restores position after a reload
  // instead of snapping back to the top every auto-refresh.
  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      if (e.source !== iframeRef.current?.contentWindow) return;
      const pos = (e.data as { __livePreviewScroll?: [number, number] })?.__livePreviewScroll;
      if (Array.isArray(pos)) scrollRef.current = pos;
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, []);

  const handleIframeLoad = useCallback(() => {
    if (scrollRef.current) {
      iframeRef.current?.contentWindow?.postMessage({ __livePreviewRestore: scrollRef.current }, "*");
    }
    // A reload (auto-refresh, manual Reload, or navigating within the
    // iframe) drops the previewed page's own armed state along with its
    // whole document — re-arm here if the toggle is still on.
    if (inspecting) {
      iframeRef.current?.contentWindow?.postMessage({ __livePreviewInspect: true }, "*");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const toggleInspect = useCallback(() => {
    setInspecting((prev) => {
      const next = !prev;
      iframeRef.current?.contentWindow?.postMessage({ __livePreviewInspect: next }, "*");
      return next;
    });
  }, []);

  // Element picker: server.js's INSPECT_SCRIPT posts back the clicked
  // element (plus its viewport rect) once armed. Rather than sending
  // immediately, park it as activePick so the popover below can collect a
  // comment — same two-step "pick, then annotate" as DiffView.tsx's line
  // selection + comment box (git-scm).
  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      if (e.source !== iframeRef.current?.contentWindow) return;
      const picked = (e.data as { __livePreviewPicked?: PickedElement })?.__livePreviewPicked;
      if (!picked) return;
      setInspecting(false);
      setActivePick(picked);
      setPickComment("");
      setSendError(null);
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, []);

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

  // Resolves an agent pane in the active project and delivers every queued
  // comment as one combined message — mirrors DiffView.tsx's sendAllComments
  // (git-scm), minus the multi-target menu picker (Live Preview has no
  // context-menu surface; several candidates just target the first, same as
  // the picker's previous single-shot send).
  const sendAllComments = useCallback(async () => {
    if (pendingComments.length === 0) return;
    const text = buildCombinedElementText(basename, pendingComments);
    setSendBusy(true);
    setSendError(null);
    try {
      const activeCwd = getActiveContext?.()?.cwd ?? dir;
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
  }, [pendingComments, basename, dir]);

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
      <button className="icon-button" title="Open in Editor" onClick={() => openInEditor?.(filePath)}>
        <Icon name="file-code" />
      </button>
      <button
        className={`icon-button${inspecting ? " active" : ""}`}
        title={
          inspecting
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
    <div ref={hostRef} className={`live-preview-host${active ? "" : " hidden"}`}>
      {error && <div className="live-preview-status live-preview-error">Couldn't load {basename}</div>}
      {!error && !token && <div className="live-preview-status">Loading…</div>}
      {!error && token && (
        <iframe
          key={reloadTick}
          ref={iframeRef}
          className="live-preview-frame"
          src={`${hookBase}/public/serve/${token}/${encodeURIComponent(basename)}`}
          title={basename}
          // allow-scripts only, no allow-same-origin — the previewed page
          // runs its own scripts but in an opaque origin, so it can't reach
          // this app's localStorage/APIs (its fetches carry Origin: null,
          // rejected everywhere except the token-gated /public/ routes it
          // needs — see security.ts's isOriginExemptPath).
          sandbox="allow-scripts"
          onLoad={handleIframeLoad}
        />
      )}
      {activePick && (
        <div
          ref={pickPopoverRef}
          className="live-preview-pick-popover"
          style={{ left: pickPos.left, top: pickPos.top }}
        >
          <div className="live-preview-pick-selector">{activePick.selector}</div>
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
          <div className="live-preview-pick-buttons">
            <button
              type="button"
              className="live-preview-btn-primary"
              disabled={!pickComment.trim()}
              onClick={addPickComment}
            >
              Add Comment
            </button>
            <button type="button" className="live-preview-btn-ghost" onClick={cancelPick}>
              Cancel
            </button>
          </div>
        </div>
      )}
      {pendingComments.map((pc, index) => (
        <button
          key={pc.id}
          type="button"
          className="live-preview-comment-badge live-preview-comment-marker"
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
          className="live-preview-pick-popover live-preview-comment-popover"
          style={{ left: commentPos.left, top: commentPos.top }}
        >
          <div className="live-preview-pick-selector">{expandedComment.selector}</div>
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
              <div className="live-preview-pick-buttons">
                <button
                  type="button"
                  className="live-preview-btn-primary"
                  disabled={!editText.trim()}
                  onClick={saveEdit}
                >
                  Save
                </button>
                <button type="button" className="live-preview-btn-ghost" onClick={cancelEdit}>
                  Cancel
                </button>
              </div>
            </>
          ) : (
            <>
              <div className="live-preview-comment-text">{expandedComment.text}</div>
              <div className="live-preview-pick-buttons">
                <button type="button" className="live-preview-btn-ghost" onClick={() => startEdit(expandedComment)}>
                  <Icon name="edit" /> Edit
                </button>
                <button
                  type="button"
                  className="live-preview-btn-ghost"
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
        <div className="live-preview-pending-panel">
          <div className="live-preview-pending-summary">
            <span className="live-preview-pending-count">
              {pendingComments.length} comment{pendingComments.length === 1 ? "" : "s"} pending
            </span>
            <button
              type="button"
              className="live-preview-btn-primary"
              disabled={sendBusy}
              onClick={() => void sendAllComments()}
            >
              <Icon name="send" /> {sendBusy ? "Sending…" : "Send to Agent"}
            </button>
            <button
              type="button"
              className="live-preview-btn-ghost"
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
          {sendError && <div className="live-preview-pending-error">{sendError}</div>}
          <ul className="live-preview-pending-list">
            {pendingComments.map((pc, index) => (
              <li key={pc.id} className="live-preview-pending-item">
                <button type="button" className="live-preview-comment-badge" onClick={() => toggleExpanded(pc.id)}>
                  {index + 1}
                </button>
                <span className="live-preview-pending-selector">{pc.selector}</span>
                <span className="live-preview-pending-text">{pc.text}</span>
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

let removeStylesheet: (() => void) | null = null;

export function activate(ctx: {
  registerFileViewer: (v: {
    id: string;
    extensions: string[];
    mode: "default" | "preview";
    component: typeof HtmlPreview;
  }) => void;
  assetUrl: (relPath: string) => string;
  settings: SettingsApi;
  app: { getActiveContext: () => ActiveContext };
}) {
  extSettings = ctx.settings;
  getActiveContext = ctx.app.getActiveContext;
  const match = ctx.assetUrl("x").match(/^(\/api\/extensions\/[^/]+)\/file\//);
  hookBase = match ? match[1].replace("/extensions/", "/ext/") : "";
  removeStylesheet = injectStylesheet(ctx.assetUrl, "dist/client.css");
  ctx.registerFileViewer({
    id: "livePreview",
    extensions: ["html", "htm"],
    mode: "preview",
    component: HtmlPreview,
  });
}

export function deactivate() {
  removeStylesheet?.();
  removeStylesheet = null;
}
