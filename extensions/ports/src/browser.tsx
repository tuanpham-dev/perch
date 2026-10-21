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
import { makeAgentStateReader, makeScreenshotUploader, usePageAgent, usePagePicks } from "../../_shared/pageAgentHost";
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
  // The web preview's proxy (ctx.app.webPreview).
  webPreview: {
    open(url: string): Promise<{ src: string; url: string; site: string; token: string }>;
    clear(site?: string): Promise<void>;
  };
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
// means https, a bare "localhost:5173" means http. Spaces in the host part
// ("not a url") make it something other than an address.
export function parseAddress(input: string): URL | null {
  const raw = input.trim();
  if (!raw) return null;
  const hasScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw);
  const hostPart = (hasScheme ? raw.replace(/^[a-z][a-z0-9+.-]*:\/\//i, "") : raw).split(/[/?#]/)[0];
  if (/\s/.test(hostPart)) return null;
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
// A dev server keeps its own origin's storage and APIs (allow-same-origin),
// but can't navigate Perch's window away (no allow-top-navigation): a
// frame-busting script, a target="_top" link or a sign-in redirect on top
// would otherwise replace the whole app. Popups open as real windows.
const LOCAL_SANDBOX =
  "allow-scripts allow-same-origin allow-forms allow-modals allow-popups allow-popups-to-escape-sandbox allow-downloads allow-pointer-lock";

// A page as comments see it: the address without its #fragment.
function pageKey(url: string): string {
  const hash = url.indexOf("#");
  return hash === -1 ? url : url.slice(0, hash);
}

// The proxy's address for a page on an external site (server
// webProxyUrls.ts's toDocumentPath): the site's own path, with the token and
// origin in a query parameter. A token minted for one site still works for
// another; the server swaps it for that site's own.
function externalSrc(url: URL, token: string): string {
  const own = url.search.replace(/^\?/, "");
  const wp = `__wp=${encodeURIComponent(`${token}~${url.protocol.slice(0, -1)}~${url.host}`)}`;
  return `${url.pathname}?${own ? `${own}&` : ""}${wp}${url.hash}`;
}

// The last address each tab was on, so a tab reopened after a reload of the
// app comes back where it was rather than at the address it was opened with.
const LAST_URL_KEY = "perch.webPreview.lastUrl";
const MAX_LAST_URLS = 100;

function loadLastUrl(filePath: string): string | null {
  try {
    const map = JSON.parse(localStorage.getItem(LAST_URL_KEY) ?? "{}") as Record<string, string>;
    return typeof map[filePath] === "string" ? map[filePath] : null;
  } catch {
    return null;
  }
}

function saveLastUrl(filePath: string, url: string): void {
  try {
    const map = JSON.parse(localStorage.getItem(LAST_URL_KEY) ?? "{}") as Record<string, string>;
    delete map[filePath];
    map[filePath] = url;
    const keys = Object.keys(map);
    for (const k of keys.slice(0, Math.max(0, keys.length - MAX_LAST_URLS))) delete map[k];
    localStorage.setItem(LAST_URL_KEY, JSON.stringify(map));
  } catch {
    // remembered until the tab closes
  }
}

type Page =
  | { mode: "local"; port: number; src: string; base: string; crossOrigin: boolean; origin: string }
  | { mode: "external"; src: string; site: string; token: string };

interface PageError {
  title: string;
  detail?: string;
  url?: string;
  // "frame": a page in the frame says it couldn't load (it's in the frame's
  // history, so Back leaves it). "tab": the tab couldn't start loading (a
  // bad address, a closed port); the page before it is still in the frame,
  // and Back returns to it.
  source: "frame" | "tab";
}

// How the frame's address changed (webProxyRuntime.js): a load ("navigate",
// "reload", "back_forward"), the page's own history calls ("push",
// "replace", "pop"), or a change seen only by polling ("poll").
type LocationKind = "navigate" | "reload" | "back_forward" | "push" | "replace" | "pop" | "poll";

interface WebPreviewMessage {
  type?: string;
  url?: string;
  title?: string;
  detail?: string;
  path?: string;
  kind?: LocationKind;
  replaced?: boolean;
}

interface BrowserViewProps {
  filePath: string;
  active: boolean;
  toolbarTarget?: HTMLDivElement | null;
  setTitle?: (title: string) => void;
  showMenu?: (x: number, y: number, items: MenuItem[]) => void;
  reloadKey?: number;
}

export function BrowserView({ filePath, active, toolbarTarget, setTitle, showMenu, reloadKey }: BrowserViewProps) {
  const initialUrl = filePath.startsWith("port:")
    ? `http://localhost:${Number(filePath.slice("port:".length))}/`
    : filePath.slice("url:".length);
  const [startUrl] = useState(() => loadLastUrl(filePath) ?? initialUrl);

  const [page, setPage] = useState<Page | null>(null);
  const [currentUrl, setCurrentUrl] = useState(startUrl);
  const [draft, setDraft] = useState(startUrl);
  const errorRef = useRef<PageError | null>(null);
  const [error, setErrorState] = useState<PageError | null>(null);
  const setError = useCallback((next: PageError | null) => {
    errorRef.current = next;
    setErrorState(next);
  }, []);
  const [loading, setLoading] = useState(true);
  // A download the browser's popup blocker stopped (one the page started
  // without a click of the user's reaching us): offered as a button, whose
  // click is one.
  const [blockedDownload, setBlockedDownload] = useState<string | null>(null);
  const [frameKey, setFrameKey] = useState(0);
  // Picking in progress: an element (Inspect) or a text selection (quote).
  const [picking, setPicking] = useState<"element" | "text" | null>(null);
  const [activePick, setActivePick] = useState<PickedElement | null>(null);
  const [viewport, setViewport] = useViewportChoice();
  const [frame, setFrame] = useState<FrameGeometry | null>(null);
  // The page agent: installed by message into a sandboxed external page, by
  // eval into a same-origin dev server. A custom proxy domain puts the dev
  // server on another origin, where neither reaches.
  const agentMode = !page ? null : page.mode === "external" ? "post" : page.crossOrigin ? null : "eval";
  const agent = usePageAgent(() => iframeRef.current?.contentWindow ?? null, agentMode, host?.pageAgentUrl ?? "");
  const uploadScreenshot = useMemo(() => makeScreenshotUploader(host?.hookBase ?? ""), []);
  const readAgentState = useMemo(() => makeAgentStateReader(host?.hookBase ?? ""), []);
  // The side-by-side frame has its own page agent, so it can be picked in
  // and commented on too.
  const compareRef = useRef<HTMLIFrameElement | null>(null);
  const [compareFrame, setCompareFrame] = useState<FrameGeometry | null>(null);
  const compareAgent = usePageAgent(
    () => compareRef.current?.contentWindow ?? null,
    viewport.compare ? agentMode : null,
    host?.pageAgentUrl ?? "",
  );
  // The page the compare frame shows: follows the main frame's page, but not
  // its in-place address changes (a Shopify variant's replaceState), which
  // would reload it on every click.
  const [compareUrl, setCompareUrl] = useState<string | null>(null);
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const frameWrapRef = useRef<HTMLDivElement | null>(null);
  const navSeq = useRef(0);
  const editingRef = useRef(false);
  const currentUrlRef = useRef(startUrl);
  const pageRef = useRef<Page | null>(null);
  pageRef.current = page;
  const pickingRef = useRef(picking);
  pickingRef.current = picking;
  // The frame's history as the tab has seen it. A frame shares the browser
  // tab's history, so history.back() on its first page would leave Perch;
  // Back is offered only when the frame has somewhere to go back to.
  const historyRef = useRef<{ entries: string[]; index: number }>({ entries: [], index: 0 });
  const pendingCmd = useRef<"back" | "forward" | null>(null);
  const [canGo, setCanGo] = useState({ back: false, forward: false });
  // The address the frame was last on: what a tab error's Back returns to.
  const frameUrlRef = useRef<string | null>(null);

  const showUrl = useCallback(
    (url: string) => {
      currentUrlRef.current = url;
      setCurrentUrl(url);
      if (!editingRef.current) setDraft(url);
    },
    [],
  );

  const showTitle = useCallback(
    (title: string | undefined) => {
      let fallback = currentUrlRef.current;
      try {
        fallback = new URL(currentUrlRef.current).host;
      } catch {
        // an address that isn't one: keep it as typed
      }
      setTitle?.(title?.trim() || fallback);
    },
    [setTitle],
  );

  const resetHistory = useCallback(() => {
    historyRef.current = { entries: [], index: 0 };
    pendingCmd.current = null;
    setCanGo({ back: false, forward: false });
  }, []);

  // A new address in the frame: shown, remembered, and placed in the frame's
  // history.
  const recordLocation = useCallback(
    (url: string, kind: LocationKind) => {
      const h = historyRef.current;
      const pending = pendingCmd.current;
      const isPop = kind === "pop" || kind === "back_forward";
      if (kind !== "poll" || url !== h.entries[h.index]) pendingCmd.current = null;
      if (h.entries.length === 0) {
        h.entries = [url];
        h.index = 0;
      } else if (kind === "replace" || kind === "reload" || kind === "poll") {
        h.entries[h.index] = url;
      } else if (pending === "back" && h.index > 0) {
        h.index--;
        h.entries[h.index] = url;
      } else if (pending === "forward" && h.index < h.entries.length - 1) {
        h.index++;
        h.entries[h.index] = url;
      } else if (isPop && h.entries[h.index - 1] === url) {
        h.index--;
      } else if (isPop && h.entries[h.index + 1] === url) {
        h.index++;
      } else if (h.entries[h.index] !== url) {
        h.entries = [...h.entries.slice(0, h.index + 1), url];
        h.index++;
      }
      setCanGo({ back: h.index > 0, forward: h.index < h.entries.length - 1 });
      frameUrlRef.current = url;
      // While a typed address's error shows, the bar keeps that address.
      if (errorRef.current?.source !== "tab") showUrl(url);
      saveLastUrl(filePath, url);
      if (kind !== "replace" && kind !== "poll") setCompareUrl(url);
      else setCompareUrl((prev) => (prev && pageKey(prev).split("?")[0] === pageKey(url).split("?")[0] ? prev : url));
    },
    [filePath, showUrl],
  );

  const navigate = useCallback(
    async (input: string) => {
      const seq = ++navSeq.current;
      const url = parseAddress(input);
      setActivePick(null);
      setPicking(null);
      if (!url) {
        setDraft(input.trim());
        setError({
          title: "That isn't a web address",
          detail: `${input.trim()} — try something like example.com or localhost:5173.`,
          source: "tab",
        });
        setLoading(false);
        return;
      }
      setError(null);
      setLoading(true);
      showUrl(url.href);
      const fail = (title: string, detail: string) => {
        setLoading(false);
        setError({ title, detail, url: url.href, source: "tab" });
      };
      try {
        if (!host) throw new Error("The Ports extension isn't active.");
        let next: Page;
        if (isLocalDevHost(url.hostname)) {
          const port = Number(url.port || (url.protocol === "https:" ? 443 : 80));
          const listening = await host.fetchListeningPorts();
          if (seq !== navSeq.current) return;
          if (!listening.some((p) => p.port === port)) {
            fail(
              `Port ${port} isn't open in a terminal`,
              "Start the server in a Perch terminal, then reload. Local addresses open only for ports a terminal owns.",
            );
            return;
          }
          const { base, crossOrigin } = await host.localProxyBase(port);
          if (seq !== navSeq.current) return;
          const src = base.replace(/\/$/, "") + url.pathname + url.search + url.hash;
          next = { mode: "local", port, src, base, crossOrigin, origin: url.origin };
        } else {
          const data = await host.webPreview.open(url.href);
          if (seq !== navSeq.current) return;
          next = { mode: "external", src: data.src, site: data.site, token: data.token };
        }
        const prev = pageRef.current;
        const frameEl = iframeRef.current;
        if (!prev || prev.mode !== next.mode || !frameEl) {
          // A new frame (the first, or a switch between the sandboxed and
          // the local kind): its history starts empty.
          resetHistory();
          setFrameKey((k) => k + 1);
        } else if (prev.src === next.src) {
          // The same address again: the frame loads it afresh, as a typed
          // address does in a browser.
          frameEl.src = next.src;
        }
        // Otherwise the frame moves to the new src in place, so Back still
        // returns to where it was.
        setPage(next);
      } catch (err) {
        if (seq !== navSeq.current) return;
        fail(`Couldn't open ${url.host}`, err instanceof Error ? err.message : String(err));
      }
    },
    [showUrl, resetHistory],
  );

  // First load, and a re-open of this tab (an explicit open of its address:
  // a link, the PORTS Open action), which starts over at that address.
  const firstLoad = useRef(true);
  useEffect(() => {
    const url = firstLoad.current ? startUrl : initialUrl;
    firstLoad.current = false;
    void navigate(url);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filePath, reloadKey]);

  // ---- External mode: messages from the injected runtime and frame pages ----
  useEffect(() => {
    if (page?.mode !== "external") return;
    const onMessage = (e: MessageEvent) => {
      const win = iframeRef.current?.contentWindow;
      if (!win || e.source !== win) return;
      const data = e.data as { __webPreview?: WebPreviewMessage };
      const msg = data?.__webPreview;
      if (!msg?.type) return;
      if (msg.type === "location" && msg.url) {
        if (errorRef.current?.source === "frame") setError(null);
        setLoading(false);
        recordLocation(msg.url, msg.kind ?? "navigate");
        showTitle(msg.title);
      } else if (msg.type === "title") {
        showTitle(msg.title);
      } else if (msg.type === "escaped" && typeof msg.path === "string") {
        // The page navigated to a bare path on the server; it belongs to
        // the site this tab is on. The "Opening…" page it landed on gives
        // way to it, rather than staying in the frame's history.
        try {
          const next = new URL(msg.path, frameUrlRef.current ?? currentUrlRef.current);
          win.postMessage({ __webPreviewCmd: "replace", url: externalSrc(next, page.token) }, "*");
        } catch {
          setError({ title: "Couldn't follow that link", source: "frame" });
        }
      } else if (msg.type === "open" && msg.url) {
        host?.openUrlTab(msg.url);
      } else if (msg.type === "download" && msg.url) {
        // noopener makes window.open return null either way; without it the
        // opened tab is cut loose by hand.
        const opened = window.open(msg.url, "_blank");
        if (opened) opened.opener = null;
        else setBlockedDownload(msg.url);
        // The frame moved to a "Downloading" page to get here: back to the
        // page the download started from.
        if (msg.replaced) win.postMessage({ __webPreviewCmd: "back" }, "*");
        setLoading(false);
      } else if (msg.type === "error") {
        setLoading(false);
        if (msg.url) recordLocation(msg.url, msg.kind ?? "navigate");
        setError({ title: msg.title ?? "Couldn't load this page", detail: msg.detail, url: msg.url, source: "frame" });
        showTitle(undefined);
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [page, recordLocation, showTitle]);

  // ---- Local mode: read the address straight off the same-origin frame ----
  const realLocalUrl = useCallback((): string | null => {
    const p = pageRef.current;
    if (p?.mode !== "local") return null;
    try {
      const loc = iframeRef.current?.contentWindow?.location;
      if (!loc || loc.href === "about:blank") return null;
      const prefix = new URL(p.base).pathname.replace(/\/$/, "");
      let path = loc.pathname;
      if (prefix && (path === prefix || path.startsWith(`${prefix}/`))) path = path.slice(prefix.length) || "/";
      return `${p.origin}${path}${loc.search}${loc.hash}`;
    } catch {
      // navigated somewhere cross-origin; keep the last address
      return null;
    }
  }, []);

  const readLocal = useCallback(
    (kind: LocationKind) => {
      const real = realLocalUrl();
      if (!real) return;
      if (kind === "poll" && real === historyRef.current.entries[historyRef.current.index]) return;
      recordLocation(real, kind);
      try {
        showTitle(iframeRef.current?.contentWindow?.document.title);
      } catch {
        showTitle(undefined);
      }
    },
    [realLocalUrl, recordLocation, showTitle],
  );
  const readLocalRef = useRef(readLocal);
  readLocalRef.current = readLocal;

  // A dev server's page is same-origin: its history calls are watched
  // directly, so the tab knows a push from a replace from a step back.
  const watchLocalHistory = useCallback(() => {
    try {
      const win = iframeRef.current?.contentWindow as (Window & { __perchHistoryWatched?: boolean }) | null;
      if (!win || win.__perchHistoryWatched) return;
      win.__perchHistoryWatched = true;
      const h = win.history;
      for (const [name, kind] of [
        ["pushState", "push"],
        ["replaceState", "replace"],
      ] as const) {
        const native = h[name];
        h[name] = function (this: History, ...args: Parameters<History["pushState"]>) {
          const result = native.apply(this, args);
          readLocalRef.current(kind);
          return result;
        };
      }
      win.addEventListener("popstate", () => readLocalRef.current("pop"));
      win.addEventListener("hashchange", () => readLocalRef.current("push"));
      new (win as unknown as typeof globalThis).MutationObserver(() => {
        try {
          showTitle(win.document.title);
        } catch {
          // gone
        }
      }).observe(win.document.head ?? win.document.documentElement, { childList: true, subtree: true, characterData: true });
    } catch {
      // cross-origin by now: nothing to watch
    }
  }, [showTitle]);

  useEffect(() => {
    if (page?.mode !== "local" || !active) return;
    // A change the hooks above didn't see (a page that saved pushState
    // before they were in place) still shows up within a second.
    const id = window.setInterval(() => readLocalRef.current("poll"), 1000);
    return () => window.clearInterval(id);
  }, [page, active]);

  const handleLoad = useCallback(() => {
    setLoading(false);
    if (page?.mode === "local") {
      setError(null);
      watchLocalHistory();
      let kind: LocationKind = "navigate";
      try {
        const entry = iframeRef.current?.contentWindow?.performance.getEntriesByType("navigation")[0] as
          | PerformanceNavigationTiming
          | undefined;
        if (entry?.type === "reload" || entry?.type === "back_forward") kind = entry.type;
      } catch {
        // cross-origin; a plain load
      }
      readLocal(kind);
    }
    // A new document has no page agent. A pick started while it loaded
    // carries on in it (the agent link holds it until the agent is ready).
    void agent?.install();
    if (pickingRef.current) agent?.pick(pickingRef.current);
  }, [page, readLocal, watchLocalHistory, agent]);

  const cancelPicking = useCallback(() => {
    setPicking(null);
    agent?.cancelPick();
    compareAgent?.cancelPick();
  }, [agent, compareAgent]);

  const onPick = useCallback(
    (pick: PickedElement) => {
      setPicking(null);
      compareAgent?.cancelPick();
      setActivePick({ ...pick, frameId: "main" });
    },
    [compareAgent],
  );
  const onComparePick = useCallback(
    (pick: PickedElement) => {
      setPicking(null);
      agent?.cancelPick();
      setActivePick({ ...pick, frameId: "compare" });
    },
    [agent],
  );
  usePagePicks(agent, onPick, cancelPicking);
  usePagePicks(compareAgent, onComparePick, cancelPicking);

  // Esc cancels picking wherever focus is: the page's agent handles it
  // inside the frame, this outside it (the toolbar button just clicked).
  useEffect(() => {
    if (!picking) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      cancelPicking();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [picking, cancelPicking]);

  const togglePick = useCallback(
    (kind: "element" | "text") => {
      if (!page || (page.mode === "local" && page.crossOrigin)) return;
      if (picking === kind) {
        cancelPicking();
        return;
      }
      // Picking works in either frame of a side-by-side preview.
      setPicking(kind);
      agent?.pick(kind);
      compareAgent?.pick(kind);
      // Keys (Esc, Enter for a multi-pick) then reach the page's agent.
      iframeRef.current?.focus();
    },
    [page, picking, agent, compareAgent, cancelPicking],
  );

  const command = useCallback(
    (cmd: "back" | "forward" | "reload") => {
      if (error?.source === "tab" || !page) {
        // Nothing new loaded: Back returns to the page still in the frame,
        // Reload tries the address again.
        if (cmd === "reload") void navigate(error?.url ?? currentUrl);
        else if (cmd === "back" && page) {
          setError(null);
          if (frameUrlRef.current) showUrl(frameUrlRef.current);
        }
        return;
      }
      if (cmd === "back" && !canGo.back) return;
      if (cmd === "forward" && !canGo.forward) return;
      if (cmd !== "reload") pendingCmd.current = cmd;
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
        if (cmd === "reload") void navigate(currentUrl);
      }
    },
    [error, page, canGo, navigate, currentUrl, showUrl],
  );

  const clearSiteData = useCallback(async () => {
    if (page?.mode !== "external") return;
    await host?.webPreview.clear(page.site).catch(() => undefined);
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
  const openPage = useCallback((url: string) => void navigate(url), [navigate]);
  const compare = compareChoice(viewport);

  // The compare frame's address, worked out here: a local page is the same
  // path through the proxy, an external one the same token's address.
  const compareSrc = useMemo(() => {
    if (!compare || !page || !compareUrl) return null;
    let url: URL;
    try {
      url = new URL(compareUrl);
    } catch {
      return null;
    }
    if (page.mode === "local") return page.base.replace(/\/$/, "") + url.pathname + url.search;
    return externalSrc(new URL(url.pathname + url.search, url), page.token);
  }, [compare, page, compareUrl]);

  const resolveCwd = useCallback(() => host?.resolveCwd() ?? null, []);
  const readAutoSubmit = useCallback(() => host?.readSendAutoSubmit() ?? false, []);

  const inspectDisabled = !page || !!error || (page.mode === "local" && page.crossOrigin);
  const controls = (
    <>
      <ViewportButton choice={viewport} onPick={setViewport} showMenu={showMenu} />
      <CompareButton choice={viewport} onPick={setViewport} />
      <button
        className={`icon-button${picking === "element" ? " active" : ""}`}
        disabled={inspectDisabled}
        aria-pressed={picking === "element"}
        title={
          page?.mode === "local" && page.crossOrigin
            ? "Inspect isn't available with a custom proxy domain configured"
            : picking === "element"
              ? "Click an element to comment on it; Shift+click to pick several, drag for an area (click again or Esc to cancel)"
              : "Inspect element → add comment"
        }
        onClick={() => togglePick("element")}
      >
        <Icon name="inspect" />
      </button>
      <button
        className={`icon-button${picking === "text" ? " active" : ""}`}
        disabled={inspectDisabled}
        aria-pressed={picking === "text"}
        title={
          picking === "text"
            ? "Select text on the page to comment on it (click again or Esc to cancel)"
            : "Comment on the selected text (select some text on the page first, or after clicking)"
        }
        onClick={() => togglePick("text")}
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

  const backEnabled = error?.source === "tab" ? !!page : canGo.back;
  const forwardEnabled = error?.source !== "tab" && canGo.forward;

  return (
    <div className={`browser-host${active ? "" : " hidden"}`}>
      <form
        className="browser-bar"
        onSubmit={(e) => {
          e.preventDefault();
          editingRef.current = false;
          (document.activeElement as HTMLElement | null)?.blur();
          void navigate(draft);
        }}
      >
        <button type="button" className="icon-button" title="Back" disabled={!backEnabled} onClick={() => command("back")}>
          <Icon name="arrow-left" />
        </button>
        <button type="button" className="icon-button" title="Forward" disabled={!forwardEnabled} onClick={() => command("forward")}>
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
            editingRef.current = true;
            e.currentTarget.select();
          }}
          onBlur={() => {
            // A submit has already let go of the draft (it's what loads).
            if (!editingRef.current) return;
            editingRef.current = false;
            setDraft(currentUrlRef.current);
          }}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              e.preventDefault();
              setDraft(currentUrlRef.current);
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
      {blockedDownload && (
        <div className="browser-notice" role="status">
          <Icon name="cloud-download" />
          <span className="browser-notice-text" title={blockedDownload}>
            Your browser blocked the download of {blockedDownload.split("/").pop()?.split("?")[0] || blockedDownload}.
          </span>
          <button
            type="button"
            className="pc-btn pc-btn-primary"
            onClick={() => {
              window.open(blockedDownload, "_blank", "noopener,noreferrer");
              setBlockedDownload(null);
            }}
          >
            Download
          </button>
          <button type="button" className="icon-button" title="Dismiss" onClick={() => setBlockedDownload(null)}>
            <Icon name="close" />
          </button>
        </div>
      )}
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
                // storage or APIs.
                sandbox={page.mode === "external" ? EXTERNAL_SANDBOX : LOCAL_SANDBOX}
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
                    sandbox={page.mode === "external" ? EXTERNAL_SANDBOX : LOCAL_SANDBOX}
                    onLoad={() => void compareAgent?.install()}
                  />
                ) : (
                  <PreviewStatus title="Loading…" />
                )
              ) : null
            }
          />
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
        readAgentState={readAgentState}
          reloadPage={reloadPage}
          openPage={openPage}
          storageKey={`tab:${filePath}`}
          page={pageKey(currentUrl)}
          compare={compare ? { agent: compareAgent, frame: compareFrame } : null}
        />
        {error && (
          <div className="browser-error">
            <PreviewStatus error title={error.title} detail={error.detail}>
              <button type="button" className="pc-btn pc-btn-primary" onClick={() => command("reload")}>
                Try Again
              </button>
              {error.source === "tab" && page && (
                <button type="button" className="pc-btn pc-btn-secondary" onClick={() => command("back")}>
                  Go Back
                </button>
              )}
              {error.url && (
                <button
                  type="button"
                  className="pc-btn pc-btn-secondary"
                  onClick={() => window.open(error.url, "_blank", "noopener,noreferrer")}
                >
                  Open in Browser
                </button>
              )}
            </PreviewStatus>
          </div>
        )}
      </div>
      {active && toolbarTarget && createPortal(controls, toolbarTarget)}
    </div>
  );
}
