// xterm-engine: the xterm.js terminal engine as a bundled extension — a
// REQUIRED builtin (manifest perch.required), since it's the app's
// guaranteed rendering floor: the engine registry always resolves to this
// engine when the selected one is missing. See src/engine.ts for the
// implementation (moved verbatim from core client/src/engines/xterm.ts).
import { injectStylesheetAndWait } from "../../_shared/injectStylesheet";
import type { CreateTerminalEngine } from "../../_shared/terminalEngineTypes";
import { createXtermEngine } from "./engine";

let removeStylesheet: (() => void) | null = null;

interface ExtensionContext {
  registerTerminalEngine(engine: { id: string; label: string; create: CreateTerminalEngine }): void;
  assetUrl(relPath: string): string;
}

export function activate(ctx: ExtensionContext): void {
  // dist/client.css carries @xterm/xterm's own stylesheet (bundled from the
  // engine's `import "@xterm/xterm/css/xterm.css"`). Awaited inside create()
  // below before the terminal DOM (including xterm's raw <textarea>) gets
  // built — activation now happens on-demand, right as a terminal opens
  // (see engines/index.ts's loadEngine), so the CSS <link>'s own fetch is no
  // longer guaranteed to have finished by the time this runs the way it
  // reliably had when every extension activated eagerly at boot minutes
  // before anyone opened a terminal.
  const { remove, ready } = injectStylesheetAndWait(ctx.assetUrl, "dist/client.css");
  removeStylesheet = remove;
  ctx.registerTerminalEngine({
    id: "xterm",
    label: "xterm.js",
    create: (options) => createXtermEngine(options, ready),
  });
}

export function deactivate(): void {
  removeStylesheet?.();
  removeStylesheet = null;
}
