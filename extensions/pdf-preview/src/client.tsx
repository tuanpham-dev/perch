import "./style.css";
import { inlineUrl } from "../../_shared/fileApi";
import { injectStylesheet } from "../../_shared/injectStylesheet";

const basename = (p: string) => p.slice(p.lastIndexOf("/") + 1);

// inlineUrl (not downloadUrl) — an iframe *navigates* to its src, which
// honors Content-Disposition: attachment and would download the PDF instead
// of rendering it (unlike an <img>/<video> subresource load).
function PdfView({ filePath, active }: { filePath: string; active: boolean }) {
  return (
    <div className={`pdf-host${active ? "" : " hidden"}`}>
      <iframe className="pdf-frame" src={inlineUrl(filePath)} title={basename(filePath)} />
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
