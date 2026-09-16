import { useCallback, useEffect, useRef, useState, type HTMLAttributes } from "react";
import { createPortal } from "react-dom";
import ReactMarkdown from "react-markdown";
import rehypeHighlight from "rehype-highlight";
import rehypeRaw from "rehype-raw";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";
import rehypeSlug from "rehype-slug";
import remarkGfm from "remark-gfm";
import { common } from "lowlight";
import apache from "highlight.js/lib/languages/apache";
import dockerfile from "highlight.js/lib/languages/dockerfile";
import ini from "highlight.js/lib/languages/ini";
import nginx from "highlight.js/lib/languages/nginx";
import "highlight.js/styles/github-dark.css";
import "./style.css";
import { fetchFileText, downloadUrl } from "../../_shared/fileApi";
import { copyText } from "../../_shared/clipboard";
import { injectStylesheet } from "../../_shared/injectStylesheet";
import Icon from "../../_shared/Icon";

// Set once from activate() — see the module comment on extSettings below.
interface SettingsApi {
  get(key: string): unknown;
  onDidChange(cb: () => void): () => void;
}

let extSettings: SettingsApi | null = null;
// Host bridge for opening a relative link's target inside the app — an .md
// target goes straight to this viewer (openViewerTab), anything else through
// the normal FILES-tree dispatch (openFileTab).
let openFileTab: ((path: string, line?: number) => void) | null = null;
let openViewerTab: ((viewerId: string, path: string, opts?: { title?: string }) => void) | null = null;

// lowlight's default "common" set (~35 languages) excludes several
// devops/config languages that show up in READMEs — nginx, dockerfile,
// apache all fall back to unhighlighted plain text otherwise (rehype-
// highlight silently no-ops on an unregistered language, no error). Curated
// rather than lowlight's "all" (~192 languages): +6KB vs. +1.18MB bundled.
const rehypeHighlightPlugin: [typeof rehypeHighlight, { languages: Record<string, unknown> }] = [
  rehypeHighlight,
  { languages: { ...common, nginx, dockerfile, apache, toml: ini } },
];

// rehypeRaw parses embedded HTML (e.g. <details>/<summary>, which react-
// markdown otherwise drops) into real elements; rehypeSlug then gives every
// heading a GitHub-style id (react-markdown doesn't do this on its own, so
// in-document `[text](#heading)` links otherwise have nothing to jump to);
// rehypeSanitize then strips anything dangerous (script tags, event
// handlers, javascript: URLs) since this pane renders into the host app's
// own DOM/origin, not a sandboxed iframe — the previewed file may be
// untrusted content, unlike an installed extension. defaultSchema's
// clobberPrefix rewrites every id/name (including rehypeSlug's) to
// "user-content-<slug>" as a DOM-clobbering defense — same as GitHub's own
// renderer — so links to those ids need the same prefix; see resolveHref.
const rehypeSanitizePlugin: [typeof rehypeSanitize, typeof defaultSchema] = [rehypeSanitize, defaultSchema];

// GitHub's own renderer resolves an in-document `#heading` link against the
// clobber-prefixed id above by rewriting the link href, not by leaving the
// id unprefixed — mirrored here so `[text](#heading)` actually scrolls.
// External/absolute links and non-fragment paths pass through untouched.
function resolveHref(href: string): string {
  if (!href.startsWith("#") || href.startsWith("#user-content-")) return href;
  return `#user-content-${href.slice(1)}`;
}

// True for anything the browser should handle itself in a new tab: a URL
// with a scheme (http(s):, mailto:, data:, …) or a protocol-relative URL.
function isExternalHref(href: string): boolean {
  return /^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith("//");
}

// Joins a relative (or root-absolute) path against the markdown file's
// directory and collapses ""/"."/".." segments — shared by image srcs and
// relative link targets.
function resolveRelativePath(markdownFilePath: string, relPath: string): string {
  const dir = markdownFilePath.slice(0, markdownFilePath.lastIndexOf("/"));
  const full = relPath.startsWith("/") || /^[A-Za-z]:\//.test(relPath) ? relPath : `${dir}/${relPath}`;
  // A Windows drive ("C:") is the root to keep; everything else joins under "/".
  const drive = /^([A-Za-z]:)\//.exec(full)?.[1];
  const parts: string[] = [];
  for (const part of (drive ? full.slice(drive.length) : full).split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") parts.pop();
    else parts.push(part);
  }
  return `${drive ?? ""}/${parts.join("/")}`;
}

// react-markdown renders an image's `src` verbatim, so a relative path like
// "docs/screenshots/foo.png" would otherwise resolve against the app's own
// URL in the browser rather than the previewed file's directory on disk.
// Absolute URLs (http(s):, data:, etc.) and root-relative paths pass through
// as-is; everything else is joined against the markdown file's directory and
// routed through the download API, same as image-preview's <img src>.
function resolveImageSrc(markdownFilePath: string, src: string): string {
  if (isExternalHref(src)) return src;
  return downloadUrl(resolveRelativePath(markdownFilePath, src));
}

function readFontSize(): number {
  return Number(extSettings?.get("markdown.previewFontSize")) || 14;
}

function readClickAction(): "edit" | "preview" {
  return extSettings?.get("markdown.clickAction") === "preview" ? "preview" : "edit";
}

// ---- Cross-file anchors ----
// `docs/other.md#section` opens other.md's preview and must scroll it after
// that tab's content renders — the target can be a brand-new mount or an
// already-open tab openViewerTab just re-activated. Both ends live in this
// module, so a tiny store beats host plumbing: the link click records the
// request here, and every mounted MarkdownView watches for requests
// targeting its own file (consuming once it's active with content rendered).
const pendingAnchors = new Map<string, string>();
const anchorListeners = new Set<(path: string) => void>();

function requestAnchor(path: string, anchor: string): void {
  pendingAnchors.set(path, anchor);
  for (const listener of anchorListeners) listener(path);
}

// Perceived brightness (ITU-R BT.601): >THRESHOLD reads as a light theme.
// Tunable in isolation if a mid-tone theme ever lands on the wrong side.
const LIGHT_THRESHOLD = 140;

function parseCssColorBrightness(value: string): number | null {
  const hex = value.trim().match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i);
  if (hex) {
    const h = hex[1];
    const full = h.length === 3 ? h.split("").map((c) => c + c).join("") : h;
    const r = parseInt(full.slice(0, 2), 16);
    const g = parseInt(full.slice(2, 4), 16);
    const b = parseInt(full.slice(4, 6), 16);
    return 0.299 * r + 0.587 * g + 0.114 * b;
  }
  const rgb = value.trim().match(/^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)/i);
  if (rgb) {
    const [, r, g, b] = rgb;
    return 0.299 * Number(r) + 0.587 * Number(g) + 0.114 * Number(b);
  }
  return null;
}

function computeHl(): "light" | "dark" {
  const bg = getComputedStyle(document.documentElement).getPropertyValue("--bg");
  const brightness = parseCssColorBrightness(bg);
  return brightness !== null && brightness > LIGHT_THRESHOLD ? "light" : "dark";
}

// Fenced code block with an overlay Copy button. innerText (not textContent)
// so soft-wrapped rendering still yields the source's own line structure.
function CodeBlock(props: HTMLAttributes<HTMLPreElement>) {
  const preRef = useRef<HTMLPreElement | null>(null);
  const [copied, setCopied] = useState(false);
  const timer = useRef<number | null>(null);

  useEffect(
    () => () => {
      if (timer.current !== null) window.clearTimeout(timer.current);
    },
    [],
  );

  const copy = () => {
    copyText(preRef.current?.innerText ?? "")
      .then(() => {
        setCopied(true);
        if (timer.current !== null) window.clearTimeout(timer.current);
        timer.current = window.setTimeout(() => setCopied(false), 1500);
      })
      .catch(() => {
        // Both clipboard paths failed (denied permission) — leave the icon.
      });
  };

  return (
    <div className="markdown-codeblock">
      <pre ref={preRef} {...props} />
      <button
        className="markdown-copy-button"
        title={copied ? "Copied" : "Copy"}
        aria-label={copied ? "Copied" : "Copy code"}
        onClick={copy}
      >
        <Icon name={copied ? "check" : "copy"} />
      </button>
    </div>
  );
}

interface Props {
  filePath: string;
  active: boolean;
  // The tab bar's actions container (TabBar's .tab-bar-actions) — same
  // portal mechanism as image-preview's zoom toolbar, only one viewer's
  // controls ever render into it since only one tab is active at a time.
  toolbarTarget?: HTMLDivElement | null;
  // Escape hatch back to the default (nvim) view of this same file —
  // markdown's primary click already opens the editor, so unlike images
  // this is surfaced directly in the tab bar rather than only the context
  // menu, since the user had to opt out of the editor to get here.
  openInEditor?: (path: string) => void;
  // Bumped by the host when an open/preview action re-targets this
  // already-open tab — the preview is read-only, so just re-fetch.
  reloadKey?: number;
}

function MarkdownView({ filePath, active, toolbarTarget, openInEditor, reloadKey }: Props) {
  const basename = filePath.slice(filePath.lastIndexOf("/") + 1);
  const hostRef = useRef<HTMLDivElement | null>(null);
  const [content, setContent] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [fontSize, setFontSize] = useState(readFontSize);
  const [hl, setHl] = useState(computeHl);
  const [linkNotice, setLinkNotice] = useState<string | null>(null);
  const noticeTimer = useRef<number | null>(null);

  useEffect(() => extSettings?.onDidChange(() => setFontSize(readFontSize())), []);

  // The host applies color themes as CSS var overrides directly on <html>
  // (see theme.ts's applyColorThemeCssVars) with no light/dark class to read
  // instead — so react to any style mutation there and recompute from --bg.
  useEffect(() => {
    setHl(computeHl());
    const observer = new MutationObserver(() => setHl(computeHl()));
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["style"] });
    return () => observer.disconnect();
  }, []);

  // No auto-refresh/polling — fetched once on mount, plus the portaled
  // Refresh button below and the host-bumped reloadKey (an explicit open/
  // preview action landing on this already-open tab) for picking up
  // on-disk edits.
  const load = useCallback(() => {
    setError(null);
    fetchFileText(filePath)
      .then(setContent)
      .catch((err) => setError(err instanceof Error ? err.message : String(err)));
  }, [filePath]);

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filePath, reloadKey]);

  useEffect(
    () => () => {
      if (noticeTimer.current !== null) window.clearTimeout(noticeTimer.current);
    },
    [],
  );

  const showLinkNotice = useCallback((message: string) => {
    setLinkNotice(message);
    if (noticeTimer.current !== null) window.clearTimeout(noticeTimer.current);
    noticeTimer.current = window.setTimeout(() => setLinkNotice(null), 4000);
  }, []);

  // Consumes a pending cross-file anchor for this file — only once this view
  // is on screen with content rendered (scrollIntoView inside display:none
  // is a no-op, and there's nothing to scroll to before the first render).
  // Re-run on `active` so a request against an open-but-background tab
  // lands when openViewerTab's activation flips it visible.
  useEffect(() => {
    const consume = () => {
      if (!active || content === null) return;
      const anchor = pendingAnchors.get(filePath);
      if (anchor === undefined) return;
      pendingAnchors.delete(filePath);
      hostRef.current
        ?.querySelector(`#${CSS.escape(`user-content-${anchor}`)}`)
        ?.scrollIntoView();
    };
    consume();
    const listener = (path: string) => {
      if (path === filePath) consume();
    };
    anchorListeners.add(listener);
    return () => {
      anchorListeners.delete(listener);
    };
  }, [filePath, active, content]);

  // Relative/root-absolute file links open inside the app: an .md target in
  // another preview tab (staying in preview-land regardless of the
  // clickAction setting), anything else through the normal dispatch. The
  // target is existence-checked first so a dangling link surfaces a notice
  // instead of an empty preview or a fresh nvim buffer.
  const openLinkTarget = useCallback(
    async (href: string) => {
      const hash = href.indexOf("#");
      const pathPart = hash === -1 ? href : href.slice(0, hash);
      const anchor = hash === -1 ? null : href.slice(hash + 1);
      const target = resolveRelativePath(filePath, pathPart);
      let ok = false;
      try {
        ok = (await fetch(downloadUrl(target), { method: "HEAD" })).ok;
      } catch {
        ok = false;
      }
      if (!ok) {
        showLinkNotice(`Linked file not found: ${pathPart}`);
        return;
      }
      const dot = target.lastIndexOf(".");
      const ext = dot === -1 ? "" : target.slice(dot + 1).toLowerCase();
      if (ext === "md" || ext === "markdown") {
        if (anchor) requestAnchor(target, anchor);
        openViewerTab?.("markdownViewer", target);
      } else {
        openFileTab?.(target);
      }
    },
    [filePath, showLinkNotice],
  );

  const controls = (
    <>
      <button className="icon-button" title="Refresh" onClick={load}>
        <Icon name="refresh" />
      </button>
      {/* file-code, not edit/pencil — matches code-server's own markdown
          extension, which uses $(file-code) for showSource/reopenAsSource
          (its "back to editor from preview" action). */}
      <button className="icon-button" title="Open in Editor" onClick={() => openInEditor?.(filePath)}>
        <Icon name="file-code" />
      </button>
    </>
  );

  return (
    <div className={`markdown-host${active ? "" : " hidden"}`} ref={hostRef}>
      {linkNotice && (
        <div className="markdown-link-notice" onClick={() => setLinkNotice(null)}>
          {linkNotice}
        </div>
      )}
      <div className="markdown-scroll">
        {error && <div className="markdown-status markdown-error">Couldn't load {basename}</div>}
        {!error && content === null && <div className="markdown-status">Loading…</div>}
        {!error && content !== null && (
          <div className="markdown-body" data-hl={hl} style={{ fontSize: `${fontSize}px` }}>
            <ReactMarkdown
              remarkPlugins={[remarkGfm]}
              rehypePlugins={[rehypeRaw, rehypeSlug, rehypeSanitizePlugin, rehypeHighlightPlugin]}
              components={{
                img: ({ src, ...props }) => (
                  <img {...props} src={src ? resolveImageSrc(filePath, src) : src} />
                ),
                // Three link kinds: in-document fragments keep the existing
                // clobber-prefix scroll; external URLs open a new browser
                // tab; everything else is a file path opened in-app.
                a: ({ href, ...props }) => {
                  if (!href || href.startsWith("#")) {
                    return <a {...props} href={href ? resolveHref(href) : href} />;
                  }
                  if (isExternalHref(href)) {
                    return <a {...props} href={href} target="_blank" rel="noopener noreferrer" />;
                  }
                  return (
                    <a
                      {...props}
                      href={href}
                      onClick={(e) => {
                        e.preventDefault();
                        openLinkTarget(href);
                      }}
                    />
                  );
                },
                pre: (props) => <CodeBlock {...props} />,
              }}
            >
              {content}
            </ReactMarkdown>
          </div>
        )}
      </div>
      {active && toolbarTarget && createPortal(controls, toolbarTarget)}
    </div>
  );
}

let removeStylesheet: (() => void) | null = null;

export function activate(ctx: {
  registerFileViewer: (v: {
    id: string;
    extensions: string[];
    mode: "default" | "preview" | (() => "default" | "preview");
    component: typeof MarkdownView;
  }) => void;
  app: {
    openFileTab: (path: string, line?: number) => void;
    openViewerTab: (viewerId: string, path: string, opts?: { title?: string }) => void;
  };
  assetUrl: (relPath: string) => string;
  settings: SettingsApi;
}) {
  extSettings = ctx.settings;
  openFileTab = ctx.app.openFileTab;
  openViewerTab = ctx.app.openViewerTab;
  removeStylesheet = injectStylesheet(ctx.assetUrl, "dist/client.css");
  ctx.registerFileViewer({
    id: "markdownViewer",
    extensions: ["md", "markdown"],
    // A thunk, so flipping markdown.clickAction applies live: "preview"
    // makes a FILES-tree click open this viewer directly ("default" mode),
    // "edit" keeps the click on nvim with this viewer behind the Preview
    // affordances — see the host's FileViewerModeSource.
    mode: () => (readClickAction() === "preview" ? "default" : "preview"),
    component: MarkdownView,
  });
}

export function deactivate() {
  removeStylesheet?.();
  removeStylesheet = null;
  openFileTab = null;
  openViewerTab = null;
  pendingAnchors.clear();
}
