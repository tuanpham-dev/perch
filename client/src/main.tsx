import { StrictMode } from "react";
import * as ReactDOM from "react-dom";
import * as ReactDOMClient from "react-dom/client";
import { createRoot } from "react-dom/client";
import * as ReactJsxRuntime from "react/jsx-runtime";
import App from "./App";
import AuthGate from "./components/AuthGate";
import "@vscode/codicons/dist/codicon.css";
import "./styles.css";
import { registerSW } from "virtual:pwa-register";
import * as ReactNS from "react";
import { ensureContrastRatio } from "./contrast";
import { isSyntheticSelectStart, markSyntheticSelectStart } from "./engines/types";
import { cellFromPoint } from "./mouseReports";
import { sendWithInkSafeEnters, whenMatches } from "./lib/terminalInput";
import { joinedSelectionText, unwrapParagraphs } from "./selectionText";
import { findCandidates, isOpenGesture, MAX_STITCH_LINES, openUrl } from "./terminalLinks";
import { consumeHandoff, IS_DETACHED, seedDetachedStorage } from "./lib/detachedWindows";

// Bundled preview extensions (image/markdown/json/csv/media/pdf) are built
// separately (see extensions/build.mjs) and must never bundle their own
// React — a second copy would break hooks/portals shared with the host.
// Their build aliases react/react-dom/react-jsx-runtime imports to thin
// shims that re-export these exact instances instead. Set before any
// extension can load (loadExtensions() only runs from an App effect, well
// after this module finishes evaluating).
// Terminal engine-support helpers for extension-implemented engines
// (xterm-engine/ghostty-engine, via the @perch/engine-support build
// alias). These must be the HOST's instances: markSyntheticSelectStart tags
// events with a module-private Symbol isSyntheticSelectStart checks — a
// bundled copy would mint a different Symbol and silently never match.
const engineSupport = {
  cellFromPoint,
  findCandidates,
  isOpenGesture,
  openUrl,
  MAX_STITCH_LINES,
  markSyntheticSelectStart,
  isSyntheticSelectStart,
  ensureContrastRatio,
  whenMatches,
  sendWithInkSafeEnters,
  joinedSelectionText,
  unwrapParagraphs,
};

declare global {
  interface Window {
    __perchModules?: {
      react: typeof ReactNS;
      "react-dom": typeof ReactDOM;
      // For extensions that mount their own floating UI (a popover) into a
      // root they own — createRoot must come from the host's copy too.
      "react-dom/client": typeof ReactDOMClient;
      "react/jsx-runtime": typeof ReactJsxRuntime;
      "@perch/engine-support": typeof engineSupport;
    };
  }
}
window.__perchModules = {
  react: ReactNS,
  "react-dom": ReactDOM,
  "react-dom/client": ReactDOMClient,
  "react/jsx-runtime": ReactJsxRuntime,
  "@perch/engine-support": engineSupport,
};

registerSW({ immediate: true });

// A detached window (plans/detach-tab-to-new-window.md) is opened with its
// tabs in the URL fragment. Seed this window's own storage from it before
// React mounts, so useTabs' state initializers restore those tabs; a reload
// has no fragment and simply restores what is already there.
if (IS_DETACHED) {
  const handoff = consumeHandoff();
  if (handoff) seedDetachedStorage(handoff, sessionStorage);
}

// Terminal engines are bundled extensions (extensions/xterm-engine,
// extensions/ghostty-engine) loaded through the extension host — nothing
// engine-related gates the app's initial render.
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <AuthGate>
      <App />
    </AuthGate>
  </StrictMode>,
);
