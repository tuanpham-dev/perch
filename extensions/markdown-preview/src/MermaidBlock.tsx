import { useEffect, useRef, useState } from "react";
import { copyText } from "../../_shared/clipboard";
import Icon from "../../_shared/Icon";

type Renderer = { renderMermaid(source: string, dark: boolean): Promise<string> };

let assetUrl: ((relPath: string) => string) | null = null;
let loading: Promise<Renderer> | null = null;

export function setMermaidAssetUrl(fn: ((relPath: string) => string) | null) {
  assetUrl = fn;
  if (!fn) loading = null;
}

// One fetch of the chunk per page, shared by every diagram on it.
function loadRenderer(): Promise<Renderer> {
  if (!assetUrl) return Promise.reject(new Error("Diagrams aren't available here"));
  loading ??= import(/* @vite-ignore */ assetUrl("dist/chunks/mermaid.js")) as Promise<Renderer>;
  return loading;
}

// A ```mermaid block drawn as a diagram. A block that doesn't parse falls
// back to its source plus the parser's message (`fallback` is the ordinary
// code block, so it keeps that block's own Copy button).
export function MermaidBlock({ source, dark, fallback }: { source: string; dark: boolean; fallback: React.ReactNode }) {
  const [svg, setSvg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const timer = useRef<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    loadRenderer()
      .then((r) => r.renderMermaid(source, dark))
      .then((out) => {
        if (cancelled) return;
        setSvg(out);
        setError(null);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setSvg(null);
        setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, [source, dark]);

  useEffect(
    () => () => {
      if (timer.current !== null) window.clearTimeout(timer.current);
    },
    [],
  );

  if (error) {
    return (
      <div className="markdown-mermaid-error">
        {fallback}
        <div className="markdown-mermaid-message">Couldn't draw this diagram: {error}</div>
      </div>
    );
  }

  const copy = () => {
    copyText(source)
      .then(() => {
        setCopied(true);
        if (timer.current !== null) window.clearTimeout(timer.current);
        timer.current = window.setTimeout(() => setCopied(false), 1500);
      })
      .catch(() => {});
  };

  return (
    <div className="markdown-codeblock markdown-mermaid">
      {svg === null ? (
        <div className="markdown-mermaid-loading">Drawing diagram…</div>
      ) : (
        <div className="markdown-mermaid-svg" dangerouslySetInnerHTML={{ __html: svg }} />
      )}
      <button
        className="markdown-copy-button"
        title={copied ? "Copied" : "Copy"}
        aria-label={copied ? "Copied" : "Copy diagram source"}
        onClick={copy}
      >
        <Icon name={copied ? "check" : "copy"} />
      </button>
    </div>
  );
}
