import "./style.css";
import { downloadUrl } from "../../_shared/fileApi";
import { injectStylesheet } from "../../_shared/injectStylesheet";

const AUDIO_EXTENSIONS = new Set(["mp3", "wav", "ogg", "m4a", "flac", "aac", "opus"]);
const VIDEO_EXTENSIONS = new Set(["mp4", "webm", "ogv", "mov"]);

function extOf(filePath: string): string {
  const dot = filePath.lastIndexOf(".");
  return dot === -1 ? "" : filePath.slice(dot + 1).toLowerCase();
}

// No portaled tab-bar controls — the native <video>/<audio> controls already
// cover play/pause/seek/volume, matching how a browser tab handles the same
// file. Media elements ignore Content-Disposition: attachment (only an
// <iframe> navigation honors it, see pdf-preview), so the plain download URL
// works here with no server changes.
function MediaView({ filePath, active }: { filePath: string; active: boolean }) {
  const src = downloadUrl(filePath);
  return (
    <div className={`media-host${active ? "" : " hidden"}`}>
      {AUDIO_EXTENSIONS.has(extOf(filePath)) ? (
        <audio className="media-audio" src={src} controls />
      ) : (
        <video className="media-video" src={src} controls />
      )}
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
    component: typeof MediaView;
  }) => void;
  assetUrl: (relPath: string) => string;
}) {
  removeStylesheet = injectStylesheet(ctx.assetUrl, "dist/client.css");
  ctx.registerFileViewer({
    id: "mediaViewer",
    extensions: [...AUDIO_EXTENSIONS, ...VIDEO_EXTENSIONS],
    mode: "default",
    // nvim on audio/video bytes isn't useful — no "Open in Editor" escape
    // hatch, unlike image-preview's (for editing e.g. an SVG's source).
    editorFallback: false,
    component: MediaView,
  });
}

export function deactivate() {
  removeStylesheet?.();
  removeStylesheet = null;
}
