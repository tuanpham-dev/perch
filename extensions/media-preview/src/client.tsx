import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import "./style.css";
import { downloadUrl, fileLoadProblem } from "../../_shared/fileApi";
import Icon from "../../_shared/Icon";
import { injectStylesheet } from "../../_shared/injectStylesheet";

const AUDIO_EXTENSIONS = new Set(["mp3", "wav", "ogg", "m4a", "flac", "aac", "opus"]);
const VIDEO_EXTENSIONS = new Set(["mp4", "webm", "ogv", "mov"]);

function extOf(filePath: string): string {
  const dot = filePath.lastIndexOf(".");
  return dot === -1 ? "" : filePath.slice(dot + 1).toLowerCase();
}

// The native <video>/<audio> controls cover play/pause/seek/volume; the tab
// bar adds Refresh. Media elements ignore Content-Disposition: attachment
// (only an <iframe> navigation honors it, see pdf-preview), so the plain
// download URL works here with no server changes.
function MediaView({
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
  // Bumped by Refresh, a re-open (reloadKey) or a new file: the element is
  // replaced and the URL changes, so the new file is fetched, not the cache.
  const [version, setVersion] = useState(0);
  const [problem, setProblem] = useState<string | null>(null);
  useEffect(() => {
    setVersion((v) => v + 1);
    setProblem(null);
  }, [filePath, reloadKey]);
  const src = `${downloadUrl(filePath)}&v=${version}`;
  const onError = () => {
    void fileLoadProblem(src).then((why) => setProblem(why ?? "This browser can't play this file's format."));
  };
  const controls = (
    <button
      className="icon-button"
      title="Refresh"
      onClick={() => {
        setProblem(null);
        setVersion((v) => v + 1);
      }}
    >
      <Icon name="refresh" />
    </button>
  );
  return (
    <div className={`media-host${active ? "" : " hidden"}`}>
      {problem ? (
        <div className="media-status media-error">
          Couldn't play {filePath.slice(filePath.lastIndexOf("/") + 1)}: {problem}
        </div>
      ) : AUDIO_EXTENSIONS.has(extOf(filePath)) ? (
        <audio key={version} className="media-audio" src={src} controls onError={onError} />
      ) : (
        <video key={version} className="media-video" src={src} controls onError={onError} />
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
