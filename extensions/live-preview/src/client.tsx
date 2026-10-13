import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import "./style.css";
import { injectStylesheet } from "../../_shared/injectStylesheet";
import Icon from "../../_shared/Icon";
import { ElementComments, PreviewStatus, type PickedElement } from "../../_shared/ElementComments";
import type { MenuItem } from "../../_shared/types";
import { makeScreenshotUploader, usePageAgent, usePagePicks } from "../../_shared/pageAgentHost";
import {
  CompareButton,
  CompareSplit,
  ViewportButton,
  setViewportPrompt,
  useViewportChoice,
  type FrameGeometry,
} from "../../_shared/viewports";

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
// The page agent bundle (built into dist/ by extensions/build.mjs).
let pageAgentUrl = "";

function readAutoRefresh(): boolean {
  const value = extSettings?.get("livePreview.autoRefresh");
  return value === undefined ? true : Boolean(value);
}

function readPollInterval(): number {
  const value = Number(extSettings?.get("livePreview.pollInterval"));
  if (!Number.isFinite(value)) return 1000;
  return Math.min(10000, Math.max(250, value));
}

function readSendAutoSubmit(): boolean {
  return extSettings?.get("livePreview.sendAutoSubmit") === true;
}

interface Props {
  filePath: string;
  active: boolean;
  toolbarTarget?: HTMLDivElement | null;
  openInEditor?: (path: string) => void;
  showMenu?: (x: number, y: number, items: MenuItem[]) => void;
}

function HtmlPreview({ filePath, active, toolbarTarget, openInEditor, showMenu }: Props) {
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
  // An element just picked, awaiting a typed comment (see ElementComments).
  const [activePick, setActivePick] = useState<PickedElement | null>(null);
  const [viewport, setViewport] = useViewportChoice();
  const [frame, setFrame] = useState<FrameGeometry | null>(null);
  const agent = usePageAgent(() => iframeRef.current?.contentWindow ?? null, "post", pageAgentUrl);
  // The side-by-side frame has its own page agent, so it can be picked in
  // and commented on too.
  const compareRef = useRef<HTMLIFrameElement | null>(null);
  const [compareFrame, setCompareFrame] = useState<FrameGeometry | null>(null);
  const compareAgent = usePageAgent(
    () => compareRef.current?.contentWindow ?? null,
    viewport.compare ? "post" : null,
    pageAgentUrl,
  );
  const uploadScreenshot = useMemo(() => makeScreenshotUploader(hookBase), []);

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
    // A reload (auto-refresh, manual Reload) is a new document: install the
    // page agent again. Picking starts over.
    setInspecting(false);
    void agent?.install();
  }, [agent]);

  // Picking works in either frame of a side-by-side preview.
  const toggleInspect = useCallback(() => {
    setInspecting((prev) => {
      const next = !prev;
      for (const a of [agent, compareAgent]) {
        if (next) a?.pick("element");
        else a?.cancelPick();
      }
      return next;
    });
  }, [agent, compareAgent]);

  // Picks from the page agent park as activePick, so the popover can collect
  // a comment — the same two-step "pick, then annotate" as DiffView.tsx's
  // line selection + comment box (git-scm).
  const onPick = useCallback(
    (pick: PickedElement) => {
      setInspecting(false);
      compareAgent?.cancelPick();
      setActivePick({ ...pick, frameId: "main" });
    },
    [compareAgent],
  );
  const onComparePick = useCallback(
    (pick: PickedElement) => {
      setInspecting(false);
      agent?.cancelPick();
      setActivePick({ ...pick, frameId: "compare" });
    },
    [agent],
  );
  const onPickCancel = useCallback(() => {
    setInspecting(false);
    agent?.cancelPick();
    compareAgent?.cancelPick();
  }, [agent, compareAgent]);
  usePagePicks(agent, onPick, onPickCancel);
  usePagePicks(compareAgent, onComparePick, onPickCancel);

  const clearPick = useCallback(() => setActivePick(null), []);
  const src = token ? `${hookBase}/public/serve/${token}/${encodeURIComponent(basename)}` : "";
  const resolveCwd = useCallback(() => getActiveContext?.()?.cwd ?? dir, [dir]);

  const controls = (
    <>
      <ViewportButton choice={viewport} onPick={setViewport} showMenu={showMenu} />
      <button className="icon-button" title="Refresh" onClick={refresh}>
        <Icon name="refresh" />
      </button>
      <button className="icon-button" title="Open in Editor" onClick={() => openInEditor?.(filePath)}>
        <Icon name="file-code" />
      </button>
      <CompareButton choice={viewport} onPick={setViewport} />
      <button
        className={`icon-button${inspecting ? " active" : ""}`}
        title={
          inspecting
            ? "Click an element to comment on it; Shift+click to pick several, drag for an area (click again or Esc to cancel)"
            : "Inspect element → add comment"
        }
        onClick={toggleInspect}
      >
        <Icon name="inspect" />
      </button>
      <button
        className="icon-button"
        title="Comment on the selected text (select some text on the page first, or after clicking)"
        onClick={() => {
          agent?.pick("text");
          compareAgent?.pick("text");
        }}
      >
        <Icon name="quote" />
      </button>
    </>
  );

  return (
    <div ref={hostRef} className={`live-preview-host${active ? "" : " hidden"}`}>
      {error && <PreviewStatus error title={`Couldn't load ${basename}`} detail={error} />}
      {!error && !token && <PreviewStatus title="Loading…" />}
      {!error && token && (
        <CompareSplit
          choice={viewport}
          onMainGeometry={setFrame}
          onCompareGeometry={setCompareFrame}
          main={
            <iframe
              key={reloadTick}
              ref={iframeRef}
              className="live-preview-frame"
              src={src}
              title={basename}
              // allow-scripts only, no allow-same-origin — the previewed page
              // runs its own scripts but in an opaque origin, so it can't reach
              // this app's localStorage/APIs (its fetches carry Origin: null,
              // rejected everywhere except the token-gated /public/ routes it
              // needs — see security.ts's isOriginExemptPath).
              sandbox="allow-scripts"
              onLoad={handleIframeLoad}
            />
          }
          compare={
            viewport.compare ? (
              <iframe
                key={`compare-${reloadTick}`}
                ref={compareRef}
                className="live-preview-frame"
                src={src}
                title={`${basename} (compare)`}
                sandbox="allow-scripts"
                onLoad={() => void compareAgent?.install()}
              />
            ) : null
          }
        />
      )}
      <ElementComments
        containerRef={hostRef}
        activePick={activePick}
        onPickDone={clearPick}
        where={`in ${basename}`}
        readAutoSubmit={readSendAutoSubmit}
        resolveCwd={resolveCwd}
        storageKey={`file:${filePath}`}
        frame={frame}
        agent={agent}
        uploadScreenshot={uploadScreenshot}
        reloadPage={refresh}
        compare={viewport.compare ? { agent: compareAgent, frame: compareFrame } : null}
      />
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
  app: {
    getActiveContext: () => ActiveContext;
    promptDialog?: (message: string, defaultValue?: string) => Promise<string | null>;
  };
}) {
  extSettings = ctx.settings;
  getActiveContext = ctx.app.getActiveContext;
  const match = ctx.assetUrl("x").match(/^(\/api\/extensions\/[^/]+)\/file\//);
  hookBase = match ? match[1].replace("/extensions/", "/ext/") : "";
  removeStylesheet = injectStylesheet(ctx.assetUrl, "dist/client.css");
  pageAgentUrl = ctx.assetUrl("dist/page-agent.js");
  if (ctx.app.promptDialog) setViewportPrompt(ctx.app.promptDialog);
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
