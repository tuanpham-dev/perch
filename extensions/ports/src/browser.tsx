// The web preview tab: an address bar over a frame, showing either a local
// dev server or any site, with the shared element picker and comments.
//
// Two modes, picked from the address:
// - Local: a loopback address on a port a terminal owns. Loaded through core's
//   /proxy/<port>/ on the app's own origin, as the PORTS Open action always
//   has, so the dev app runs unsandboxed and the picker reads its DOM directly.
// - External: anything else. Loaded through core's web proxy
//   (server/src/webProxy.ts) into a sandboxed frame with an opaque origin, so
//   the site can't reach the app. An injected runtime reports its address and
//   picks back over postMessage.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import Icon from "../../_shared/Icon";
import { ElementComments, PreviewStatus, type PickedElement } from "../../_shared/ElementComments";
import type { MenuItem } from "../../_shared/types";
import { makeScreenshotUploader, usePageAgent, usePagePicks } from "../../_shared/pageAgentHost";
import {
  CompareButton,
  CompareSplit,
  ViewportButton,
  compareChoice,
  useViewportChoice,
  type FrameGeometry,
} from "../../_shared/viewports";

export interface BrowserHost {
  fetchListeningPorts(): Promise<{ port: number }[]>;
  // The app-origin URL a local port is served at, ending in "/".
  localProxyBase(port: number): Promise<{ base: string; crossOrigin: boolean }>;
  openUrlTab(url: string): void;
  resolveCwd(): string | null;
  readSendAutoSubmit(): boolean;
  // The extension's server hook ("/api/ext/<id>"), for screenshots.
  hookBase: string;
  // The page agent bundle (dist/page-agent.js).
  pageAgentUrl: string;
}

let host: BrowserHost | null = null;

export function configureBrowser(next: BrowserHost | null): void {
  host = next;
}

// The tab path for an address: "url:<href>", or "port:<n>" for the PORTS
// Open action's tabs (kept so tabs from before the address bar restore).
export function browserTabPath(url: string): string {
  return `url:${url}`;
}

// What someone typed into an address bar, as a URL: a bare "example.com"
// means https, a bare "localhost:5173" means http.
export function parseAddress(input: string): URL | null {
  const raw = input.trim();
  if (!raw) return null;
  const hasScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw);
  const local = /^(localhost|127\.|\[::1\])/i.test(raw);
  try {
    const url = new URL(hasScheme ? raw : `${local ? "http" : "https"}://${raw}`);
    return url.protocol === "http:" || url.protocol === "https:" ? url : null;
  } catch {
    return null;
  }
}

// The addresses core's /proxy/<port>/ actually reaches (it connects to
// 127.0.0.1). Another loopback address such as 127.0.0.2 goes through the web
// proxy instead, where the private-address rules decide.
function isLocalDevHost(hostname: string): boolean {
  const h = hostname.replace(/^\[(.*)\]$/, "$1").toLowerCase();
  return h === "localhost" || h === "127.0.0.1" || h === "::1";
}

const EXTERNAL_SANDBOX = "allow-scripts allow-forms allow-modals allow-pointer-lock";

// A page as comments see it: the address without its #fragment.
function pageKey(url: string): string {
  const hash = url.indexOf("#");
  return hash === -1 ? url : url.slice(0, hash);
}

type Page =
  | { mode: "local"; port: number; src: string; base: string; crossOrigin: boolean; origin: string }
  | { mode: "external"; src: string; site: string };

interface PageError {
  title: string;
  detail?: string;
  url?: string;
}

interface WebPreviewMessage {
  type?: string;
  url?: string;
  title?: string;
  detail?: string;
}

interface BrowserViewProps {
  filePath: string;
  active: boolean;
  toolbarTarget?: HTMLDivElement | null;
  setTitle?: (title: string) => void;
  showMenu?: (x: number, y: number, items: MenuItem[]) => void;
}

export function BrowserView({ filePath, active, toolbarTarget, setTitle, showMenu }: BrowserViewProps) {
  const initialUrl = filePath.startsWith("port:")
    ? `http://localhost:${Number(filePath.slice("port:".length))}/`
    : filePath.slice("url:".length);

  const [page, setPage] = useState<Page | null>(null);
  const [currentUrl, setCurrentUrl] = useState(initialUrl);
  const [draft, setDraft] = useState(initialUrl);
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState<PageError | null>(null);
  const [loading, setLoading] = useState(true);
  const [frameKey, setFrameKey] = useState(0);
  const [inspecting, setInspecting] = useState(false);
  const [activePick, setActivePick] = useState<PickedElement | null>(null);
  const [viewport, setViewport] = useViewportChoice();
  const [frame, setFrame] = useState<FrameGeometry | null>(null);
  // The page agent: installed by message into a sandboxed external page, by
  // eval into a same-origin dev server. A custom proxy domain puts the dev
  // server on another origin, where neither reaches.
  const agentMode = !page ? null : page.mode === "external" ? "post" : page.crossOrigin ? null : "eval";
  const agent = usePageAgent(() => iframeRef.current?.contentWindow ?? null, agentMode, host?.pageAgentUrl ?? "");
  const uploadScreenshot = useMemo(() => makeScreenshotUploader(host?.hookBase ?? ""), []);
  const [compareSrc, setCompareSrc] = useState<string | null>(null);
  // The side-by-side frame has its own page agent, so it can be picked in
  // and commented on too.
  const compareRef = useRef<HTMLIFrameElement | null>(null);
  const [compareFrame, setCompareFrame] = useState<FrameGeometry | null>(null);
  const compareAgent = usePageAgent(
    () => compareRef.current?.contentWindow ?? null,
    viewport.compare ? agentMode : null,
    host?.pageAgentUrl ?? "",
  );
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const frameWrapRef = useRef<HTMLDivElement | null>(null);
  const navSeq = useRef(0);
  const currentUrlRef = useRef(initialUrl);
  currentUrlRef.current = currentUrl;

  const showUrl = useCallback(
    (url: string) => {
      setCurrentUrl(url);
      if (!editing) setDraft(url);
      try {
        setTitle?.(new URL(url).host);
      } catch {
        // keep the tab's title
      }
    },
    [editing, setTitle],
  );

  const navigate = useCallback(
    async (input: string) => {
      const seq = ++navSeq.current;
      const url = parseAddress(input);
      setActivePick(null);
      setInspecting(false);
      if (!url) {
        setError({ title: "That isn't a web address", detail: `${input.trim()} — try something like example.com or localhost:5173.` });
        setLoading(false);
        return;
      }
      setError(null);
      setLoading(true);
      showUrl(url.href);
      try {
        if (!host) throw new Error("The Ports extension isn't active.");
        if (isLocalDevHost(url.hostname)) {
          const port = Number(url.port || (url.protocol === "https:" ? 443 : 80));
          const listening = await host.fetchListeningPorts();
          if (seq !== navSeq.current) return;
          if (!listening.some((p) => p.port === port)) {
            setPage(null);
            setLoading(false);
            setError({
              title: `Port ${port} isn't open in a terminal`,
              detail: "Start the server in a Perch terminal, then reload. Local addresses open only for ports a terminal owns.",
            });
            return;
          }
          const { base, crossOrigin } = await host.localProxyBase(port);
          if (seq !== navSeq.current) return;
          const src = base.replace(/\/$/, "") + url.pathname + url.search + url.hash;
          setPage({ mode: "local", port, src, base, crossOrigin, origin: url.origin });
        } else {
          const res = await fetch("/api/web-preview/open", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ url: url.href }),
          });
          const data = (await res.json().catch(() => ({}))) as { src?: string; url?: string; site?: string; error?: string };
          if (seq !== navSeq.current) return;
          if (!res.ok || !data.src || !data.site) throw new Error(data.error ?? `${res.status} ${res.statusText}`);
          setPage({ mode: "external", src: data.src, site: data.site });
        }
        setFrameKey((k) => k + 1);
      } catch (err) {
        if (seq !== navSeq.current) return;
        setPage(null);
        setLoading(false);
        setError({ title: `Couldn't open ${url.host}`, detail: err instanceof Error ? err.message : String(err), url: url.href });
      }
    },
    [showUrl],
  );

  // First load, and a re-target of this tab (same path, opened again).
  useEffect(() => {
    void navigate(initialUrl);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filePath]);

  // ---- External mode: messages from the injected runtime ----
  useEffect(() => {
    if (page?.mode !== "external") return;
    const onMessage = (e: MessageEvent) => {
      if (!iframeRef.current || e.source !== iframeRef.current.contentWindow) return;
      const data = e.data as { __webPreview?: WebPreviewMessage };
      const msg = data?.__webPreview;
      if (!msg?.type) return;
      if (msg.type === "location" && msg.url) {
        setError(null);
        setLoading(false);
        showUrl(msg.url);
      } else if (msg.type === "escaped" && typeof (msg as { path?: string }).path === "string") {
        // The page navigated to a bare path on the server; it belongs to
        // the site this tab is on.
        try {
          void navigate(new URL((msg as { path: string }).path, currentUrlRef.current).href);
        } catch {
          setError({ title: "Couldn't follow that link" });
        }
      } else if (msg.type === "open" && msg.url) {
        host?.openUrlTab(msg.url);
      } else if (msg.type === "download" && msg.url) {
        window.open(msg.url, "_blank", "noopener,noreferrer");
        setLoading(false);
      } else if (msg.type === "error") {
        setLoading(false);
        setError({ title: msg.title ?? "Couldn't load this page", detail: msg.detail, url: msg.url });
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [page, showUrl, navigate]);

  // ---- Local mode: read the address straight off the same-origin frame ----
  const readLocalLocation = useCallback(() => {
    if (page?.mode !== "local") return;
    try {
      const loc = iframeRef.current?.contentWindow?.location;
      if (!loc || loc.href === "about:blank") return;
      const base = new URL(page.base);
      let path = loc.pathname;
      if (base.pathname !== "/" && path.startsWith(base.pathname.replace(/\/$/, ""))) {
        path = path.slice(base.pathname.replace(/\/$/, "").length) || "/";
      }
      const real = `${page.origin}${path}${loc.search}${loc.hash}`;
      if (real !== currentUrl) showUrl(real);
    } catch {
      // navigated somewhere cross-origin; keep the last address
    }
  }, [page, currentUrl, showUrl]);

  useEffect(() => {
    if (page?.mode !== "local" || !active) return;
    // A single-page app changes its address without loading, so look now
    // and then rather than only on load.
    const id = window.setInterval(readLocalLocation, 1000);
    return () => window.clearInterval(id);
  }, [page, active, readLocalLocation]);

  const handleLoad = useCallback(() => {
    setLoading(false);
    if (page?.mode === "local") readLocalLocation();
    // A new document has no page agent; picking starts over.
    setInspecting(false);
    void agent?.install();
  }, [page, readLocalLocation, agent]);

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

  const toggleInspect = useCallback(() => {
    if (!page || (page.mode === "local" && page.crossOrigin)) return;
    // Picking works in either frame of a side-by-side preview.
    setInspecting((prev) => {
      const next = !prev;
      for (const a of [agent, compareAgent]) {
        if (next) a?.pick("element");
        else a?.cancelPick();
      }
      return next;
    });
  }, [page, agent, compareAgent]);

  const command = useCallback(
    (cmd: "back" | "forward" | "reload") => {
      if (error || !page) {
        if (cmd === "reload") void navigate(currentUrl);
        return;
      }
      if (page.mode === "external") {
        if (cmd === "reload") setLoading(true);
        iframeRef.current?.contentWindow?.postMessage({ __webPreviewCmd: cmd }, "*");
        return;
      }
      try {
        const win = iframeRef.current?.contentWindow;
        if (cmd === "back") win?.history.back();
        else if (cmd === "forward") win?.history.forward();
        else if (win && !win.location.pathname.startsWith(new URL(page.base).pathname)) {
          // A single-page app pushed a root path ("/about"), outside the
          // proxy: reloading it there would load the app itself. Load the
          // same page through the proxy instead.
          const loc = win.location;
          win.location.replace(page.base.replace(/\/$/, "") + loc.pathname + loc.search + loc.hash);
        } else win?.location.reload();
      } catch {
        if (cmd === "reload") setFrameKey((k) => k + 1);
      }
    },
    [error, page, navigate, currentUrl],
  );

  const clearSiteData = useCallback(async () => {
    if (page?.mode !== "external") return;
    await fetch("/api/web-preview/clear", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ site: page.site }),
    }).catch(() => undefined);
    command("reload");
  }, [page, command]);

  const openInBrowser = useCallback(() => {
    // A local port means the server's own loopback, which the viewer's
    // machine may not share; the app-origin proxy URL works from anywhere.
    let href = currentUrl;
    if (page?.mode === "local") {
      try {
        href = iframeRef.current?.contentWindow?.location.href ?? page.src;
      } catch {
        href = page.src;
      }
    }
    window.open(href, "_blank", "noopener,noreferrer");
  }, [currentUrl, page]);

  const clearPick = useCallback(() => setActivePick(null), []);
  const reloadPage = useCallback(() => command("reload"), [command]);
  const compare = compareChoice(viewport);

  // The compare frame follows the page the main one is on. An external page
  // needs its own proxy address for it; a local one is the same path.
  useEffect(() => {
    if (!compare || !page || error) {
      setCompareSrc(null);
      return;
    }
    let url: URL;
    try {
      url = new URL(currentUrl);
    } catch {
      return;
    }
    if (page.mode === "local") {
      setCompareSrc(page.base.replace(/\/$/, "") + url.pathname + url.search);
      return;
    }
    let cancelled = false;
    const timer = window.setTimeout(() => {
      fetch("/api/web-preview/open", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ url: url.href }),
      })
        .then((res) => res.json())
        .then((data: { src?: string }) => {
          if (!cancelled && data.src) setCompareSrc(data.src);
        })
        .catch(() => undefined);
    }, 300);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [!!compare, page, error, pageKey(currentUrl)]);
  const resolveCwd = useCallback(() => host?.resolveCwd() ?? null, []);
  const readAutoSubmit = useCallback(() => host?.readSendAutoSubmit() ?? false, []);

  const inspectDisabled = !page || !!error || (page.mode === "local" && page.crossOrigin);
  const controls = (
    <>
      <ViewportButton choice={viewport} onPick={setViewport} showMenu={showMenu} />
      <CompareButton choice={viewport} onPick={setViewport} />
      <button
        className={`icon-button${inspecting ? " active" : ""}`}
        disabled={inspectDisabled}
        title={
          page?.mode === "local" && page.crossOrigin
            ? "Inspect isn't available with a custom proxy domain configured"
            : inspecting
              ? "Click an element to comment on it; Shift+click to pick several, drag for an area (click again or Esc to cancel)"
              : "Inspect element → add comment"
        }
        onClick={toggleInspect}
      >
        <Icon name="inspect" />
      </button>
      <button
        className="icon-button"
        disabled={inspectDisabled}
        title="Comment on the selected text (select some text on the page first, or after clicking)"
        onClick={() => {
          agent?.pick("text");
          compareAgent?.pick("text");
        }}
      >
        <Icon name="quote" />
      </button>
      {page?.mode === "external" && (
        <button className="icon-button" title={`Clear site data for ${page.site} (signs you out)`} onClick={() => void clearSiteData()}>
          <Icon name="clear-all" />
        </button>
      )}
      <button className="icon-button" title="Open in Browser" onClick={openInBrowser}>
        <Icon name="link-external" />
      </button>
    </>
  );

  return (
    <div className={`browser-host${active ? "" : " hidden"}`}>
      <form
        className="browser-bar"
        onSubmit={(e) => {
          e.preventDefault();
          (document.activeElement as HTMLElement | null)?.blur();
          void navigate(draft);
        }}
      >
        <button type="button" className="icon-button" title="Back" onClick={() => command("back")}>
          <Icon name="arrow-left" />
        </button>
        <button type="button" className="icon-button" title="Forward" onClick={() => command("forward")}>
          <Icon name="arrow-right" />
        </button>
        <button type="button" className="icon-button" title="Reload" onClick={() => command("reload")}>
          <Icon name={loading ? "loading" : "refresh"} className={loading ? "codicon-modifier-spin" : undefined} />
        </button>
        <input
          className="browser-address"
          aria-label="Address"
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          value={draft}
          onFocus={(e) => {
            setEditing(true);
            e.currentTarget.select();
          }}
          onBlur={() => {
            setEditing(false);
            setDraft(currentUrl);
          }}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              e.preventDefault();
              setDraft(currentUrl);
              e.currentTarget.blur();
            }
          }}
        />
        {page && (
          <span
            className={`browser-mode ${page.mode}`}
            title={
              page.mode === "local"
                ? "A dev server in your terminals, loaded as-is through the app"
                : "Loaded through the Perch server in a sandbox; it can't reach the app"
            }
          >
            {page.mode === "local" ? "Local" : "External"}
          </span>
        )}
      </form>
      <div ref={frameWrapRef} className="browser-frame-wrap">
        {page && (
          <CompareSplit
            choice={viewport}
            onMainGeometry={setFrame}
            onCompareGeometry={setCompareFrame}
            main={
              <iframe
                key={`${page.mode}:${frameKey}`}
                ref={iframeRef}
                className="browser-frame"
                src={page.src}
                title={currentUrl}
                onLoad={handleLoad}
                // External sites: scripts, but an opaque origin (no
                // allow-same-origin), so the page can't reach this app's
                // storage or APIs. Local dev servers keep today's
                // unsandboxed frame.
                sandbox={page.mode === "external" ? EXTERNAL_SANDBOX : undefined}
              />
            }
            compare={
              compare ? (
                compareSrc ? (
                  <iframe
                    key={compareSrc}
                    ref={compareRef}
                    className="browser-frame"
                    src={compareSrc}
                    title={`${currentUrl} (compare)`}
                    sandbox={page.mode === "external" ? EXTERNAL_SANDBOX : undefined}
                    onLoad={() => void compareAgent?.install()}
                  />
                ) : (
                  <PreviewStatus title="Loading…" />
                )
              ) : null
            }
          />
        )}
        {error && (
          <PreviewStatus error title={error.title} detail={error.detail}>
            <button type="button" className="pc-btn pc-btn-primary" onClick={() => void navigate(error.url ?? currentUrl)}>
              Try Again
            </button>
            {(error.url ?? currentUrl) && (
              <button
                type="button"
                className="pc-btn pc-btn-secondary"
                onClick={() => window.open(error.url ?? currentUrl, "_blank", "noopener,noreferrer")}
              >
                Open in Browser
              </button>
            )}
          </PreviewStatus>
        )}
        {!error && !page && loading && <PreviewStatus title="Loading…" />}
        <ElementComments
          containerRef={frameWrapRef}
          activePick={activePick}
          onPickDone={clearPick}
          where={`on ${currentUrl}`}
          readAutoSubmit={readAutoSubmit}
          resolveCwd={resolveCwd}
          frame={frame}
          agent={agent}
          uploadScreenshot={uploadScreenshot}
          reloadPage={reloadPage}
          storageKey={`tab:${filePath}`}
          page={pageKey(currentUrl)}
          compare={compare ? { agent: compareAgent, frame: compareFrame } : null}
        />
      </div>
      {active && toolbarTarget && createPortal(controls, toolbarTarget)}
    </div>
  );
}
