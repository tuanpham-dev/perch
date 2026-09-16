import { useEffect, useState } from "react";
import "./style.css";
import { downloadUrl } from "../../_shared/fileApi";
import { injectStylesheet } from "../../_shared/injectStylesheet";
import Icon from "../../_shared/Icon";
import FileIcon, { type IconResult } from "../../_shared/FileIcon";

// ---- Module-level host bridge ----

interface SettingsApi {
  get(key: string): unknown;
  onDidChange(cb: () => void): () => void;
}

let serverFetch: ((path: string, init?: RequestInit) => Promise<Response>) | null = null;
let extSettings: SettingsApi | null = null;
let getFileIcon: ((fileName: string) => IconResult) | null = null;
let removeStylesheet: (() => void) | null = null;

function maxSizeBytes(): number {
  const mb = Number(extSettings?.get("fileGuard.maxSizeMB")) || 10;
  return mb * 1024 * 1024;
}

interface StatResult {
  size: number;
  binary: boolean;
}

async function fetchStat(filePath: string): Promise<StatResult> {
  const res = await serverFetch!(`/stat?path=${encodeURIComponent(filePath)}`);
  if (!res.ok) {
    const data = await res.json().catch(() => ({}) as { error?: string });
    throw new Error(data.error || `${res.status} ${res.statusText}`);
  }
  return (await res.json()) as StatResult;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = "B";
  for (const next of units) {
    if (value < 1024) break;
    value /= 1024;
    unit = next;
  }
  return `${value >= 100 ? Math.round(value) : value.toFixed(1)} ${unit}`;
}

interface Props {
  filePath: string;
  active: boolean;
  // Escape hatch for a large-but-text file the user wants in nvim anyway —
  // same host prop the other viewers get.
  openInEditor?: (path: string) => void;
}

// The tab the open interceptor routes a binary/oversized file to: says why
// the file didn't open in the editor and offers Download (always the right
// answer for binary) plus Open in Editor Anyway (for large text files).
function GuardView({ filePath, active, openInEditor }: Props) {
  const basename = filePath.slice(filePath.lastIndexOf("/") + 1);
  const [result, setResult] = useState<StatResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Re-fetched on mount rather than handed over from the interceptor —
  // survives a tab restore in a fresh session, where no interceptor ran.
  useEffect(() => {
    let cancelled = false;
    setResult(null);
    setError(null);
    fetchStat(filePath)
      .then((r) => {
        if (!cancelled) setResult(r);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, [filePath]);

  const reason = result
    ? result.binary
      ? "This is a binary file - it can't be displayed as text."
      : `This file is ${formatSize(result.size)} - too large to open in the editor.`
    : null;

  return (
    <div className={`file-guard-host${active ? "" : " hidden"}`}>
      <div className="file-guard-card">
        <div className="file-guard-icon">
          <FileIcon className="file-guard-file-icon" result={getFileIcon?.(basename) ?? { kind: "none" }} />
        </div>
        <div className="file-guard-name">{basename}</div>
        {result !== null && <div className="file-guard-size">{formatSize(result.size)}</div>}
        {error && <div className="file-guard-reason file-guard-error">{error}</div>}
        {!error && result === null && <div className="file-guard-reason">Loading…</div>}
        {!error && reason && <div className="file-guard-reason">{reason}</div>}
        <div className="file-guard-actions">
          <a className="file-guard-download" href={downloadUrl(filePath)} download={basename}>
            <Icon name="desktop-download" />
            Download
          </a>
          <button className="file-guard-open-editor" onClick={() => openInEditor?.(filePath)}>
            <Icon name="file-code" />
            Open in Editor Anyway
          </button>
        </div>
      </div>
    </div>
  );
}

export function activate(ctx: {
  registerFileViewer: (v: {
    id: string;
    extensions: string[];
    mode: "default" | "preview";
    component: typeof GuardView;
  }) => void;
  registerFileOpenInterceptor: (intercept: (path: string) => Promise<boolean>) => void;
  app: {
    openViewerTab: (viewerId: string, path: string, opts?: { title?: string }) => void;
    getFileIcon: (fileName: string) => IconResult;
  };
  serverFetch: (path: string, init?: RequestInit) => Promise<Response>;
  assetUrl: (relPath: string) => string;
  settings: SettingsApi;
}) {
  serverFetch = ctx.serverFetch;
  extSettings = ctx.settings;
  getFileIcon = ctx.app.getFileIcon;
  removeStylesheet = injectStylesheet(ctx.assetUrl, "dist/client.css");
  // extensions: [] — never matched from a FILES-tree click; only ever
  // reached through the interceptor's openViewerTab below (and tab restore).
  ctx.registerFileViewer({
    id: "fileGuard",
    extensions: [],
    mode: "default",
    component: GuardView,
  });
  // Runs on every path headed for nvim (see useFileOpeners.openFileOrViewer).
  // Fail open everywhere: a stat error must never block the editor.
  ctx.registerFileOpenInterceptor(async (path) => {
    let statResult: StatResult;
    try {
      statResult = await fetchStat(path);
    } catch {
      return false;
    }
    if (!statResult.binary && statResult.size <= maxSizeBytes()) return false;
    ctx.app.openViewerTab("fileGuard", path);
    return true;
  });
}

export function deactivate() {
  removeStylesheet?.();
  removeStylesheet = null;
  serverFetch = null;
  extSettings = null;
  getFileIcon = null;
}
