import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import "./style.css";
import { fileLoadProblem, inlineUrl } from "../../_shared/fileApi";
import Icon from "../../_shared/Icon";
import { injectStylesheet } from "../../_shared/injectStylesheet";

const basename = (p: string) => p.slice(p.lastIndexOf("/") + 1);

// inlineUrl (not downloadUrl) — an iframe *navigates* to its src, which
// honors Content-Disposition: attachment and would download the PDF instead
// of rendering it (unlike an <img>/<video> subresource load). An iframe
// can't report a failed load, so the file is checked first: a missing one
// shows the reason instead of the server's raw error in the frame.
function PdfView({
  filePath,
  active,
  toolbarTarget,
  reloadKey,
}: {
  filePath: string;
  active: boolean;
  toolbarTarget?: HTMLDivElement | null;
  reloadKey?: number;
}) {
  const [version, setVersion] = useState(0);
  const [problem, setProblem] = useState<string | null | undefined>(undefined);
  const src = `${inlineUrl(filePath)}&v=${version}`;
  useEffect(() => {
    setVersion((v) => v + 1);
  }, [filePath, reloadKey]);
  useEffect(() => {
    let cancelled = false;
    setProblem(undefined);
    void fileLoadProblem(src).then((why) => {
      if (!cancelled) setProblem(why);
    });
    return () => {
      cancelled = true;
    };
  }, [src]);
  const controls = (
    <button className="icon-button" title="Refresh" onClick={() => setVersion((v) => v + 1)}>
      <Icon name="refresh" />
    </button>
  );
  return (
    <div className={`pdf-host${active ? "" : " hidden"}`}>
      {problem ? (
        <div className="pdf-status pdf-error">
          Couldn't open {basename(filePath)}: {problem}
        </div>
      ) : problem === null ? (
        <iframe key={version} className="pdf-frame" src={src} title={basename(filePath)} />
      ) : (
        <div className="pdf-status">Loading…</div>
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
    editorFallback?: boolean;
    component: typeof PdfView;
  }) => void;
  assetUrl: (relPath: string) => string;
}) {
  removeStylesheet = injectStylesheet(ctx.assetUrl, "dist/client.css");
  ctx.registerFileViewer({
    id: "pdfViewer",
    extensions: ["pdf"],
    mode: "default",
    // nvim on PDF bytes isn't useful — no "Open in Editor" escape hatch,
    // unlike image-preview's (for editing e.g. an SVG's source).
    editorFallback: false,
    component: PdfView,
  });
}

export function deactivate() {
  removeStylesheet?.();
  removeStylesheet = null;
}
