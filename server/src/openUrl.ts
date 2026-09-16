// Browser-opener bridge (plans/browser-opener-bridge.md): a $BROWSER shim in
// terminals relays server-side "open a URL" attempts (xdg-open falls back to
// $BROWSER on headless boxes) to POST /api/open-url, which fans out to every
// connected client over SSE — the focused app tab then opens the URL in the
// user's actual browser, rewriting loopback ports to the app's port proxy.
import { chmod, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Response } from "express";
import { configDir } from "./configDir.js";
import { toClientPaths } from "./clientPaths.js";

// Where every shim terminals use lives: the browser opener, the clipboard
// tools (clipboardShims.ts), the agent hook. First on PATH in every terminal
// the app starts (mux.ts's terminalEnv).
export const shimBinDir = path.join(configDir, "bin");

// POSIX single quotes, for baking a path into a generated sh script.
export function shQuote(text: string): string {
  return `'${text.replace(/'/g, `'\\''`)}'`;
}

// The start of a shim standing in for a real tool: with a display, the tool
// this shim is named after runs instead, found on PATH past the shim folder.
// A desktop host keeps its own opener and clipboard; only a headless one
// needs the bridge.
export function displayFallback(name: string, dir: string = shimBinDir): string {
  return `if [ -n "\${DISPLAY-}" ] || [ -n "\${WAYLAND_DISPLAY-}" ]; then
  set -f; IFS=:
  for d in $PATH; do
    if [ -n "$d" ] && [ "$d" != ${shQuote(dir)} ] && [ -x "$d/${name}" ]; then
      unset IFS; set +f
      exec "$d/${name}" "$@"
    fi
  done
  unset IFS; set +f
fi
`;
}

// The canonical shim path — what every terminal's BROWSER points at (see
// mux.ts's daemon environment). Port-independent (the port is baked into the
// script body). On Windows it's a .cmd that runs a small Node script, since
// there's no sh or (reliably) curl.
export const openShimPath = path.join(shimBinDir, process.platform === "win32" ? "open-in-browser.cmd" : "open-in-browser");

// $BROWSER/xdg-open convention: the URL arrives as $1. The custom header is
// the CSRF guard — a cross-origin browser request carrying it needs a CORS
// preflight the server never approves, while curl sends it freely. -m 2
// mirrors the bell hook: a slow/dead server must never hang the caller.
function shimScript(port: number, fallback = ""): string {
  return `#!/bin/sh
# Written by Perch at startup — relays a URL open to the app's browser
# tab (loopback-only POST /api/open-url). Also installed as xdg-open, first
# on PATH in the app's terminals; that copy runs the real xdg-open when the
# host has a display.
${fallback}[ -n "$1" ] || exit 1
exec curl -s -m 2 -X POST -H 'X-Perch-Open: 1' --data-urlencode "url=$1" "http://127.0.0.1:${port}/api/open-url"
`;
}

// The Windows form: a Node script doing what the sh one does with curl, and a
// .cmd that runs it with the node that runs this server.
export function windowsOpenShim(port: number, node: string): { script: string; cmd: string } {
  return {
    script: `// Written by perch at startup - relays a URL open to the app's browser tab.
const url = process.argv[2];
if (!url) process.exit(1);
fetch("http://127.0.0.1:${port}/api/open-url", {
  method: "POST",
  headers: { "X-Perch-Open": "1" },
  body: new URLSearchParams({ url }),
  signal: AbortSignal.timeout(2000),
}).catch(() => process.exit(1));
`,
    cmd: `@echo off\r\n"${node}" "%~dp0open-in-browser.mjs" %*\r\n`,
  };
}

// Best-effort at boot: a read-only config dir shouldn't stop the server, it
// just disables the bridge (index.ts logs and continues).
export async function ensureOpenShim(port: number): Promise<string> {
  await mkdir(shimBinDir, { recursive: true });
  if (process.platform === "win32") {
    const { script, cmd } = windowsOpenShim(port, process.execPath);
    await writeFile(path.join(shimBinDir, "open-in-browser.mjs"), script);
    await writeFile(openShimPath, cmd);
    return openShimPath;
  }
  // BROWSER always relays to the app; only the xdg-open copy steps aside for
  // a real display, since it now shadows the system opener on PATH.
  for (const [file, script] of [
    [openShimPath, shimScript(port)],
    [path.join(shimBinDir, "xdg-open"), shimScript(port, displayFallback("xdg-open"))],
  ] as const) {
    await writeFile(file, script);
    await chmod(file, 0o755);
  }
  return openShimPath;
}

const HEARTBEAT_MS = 30_000;

const subscribers = new Set<Response>();

export function subscribeOpenUrl(res: Response): void {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  res.write(": connected\n\n");
  subscribers.add(res);
  // Per-connection heartbeat so intermediaries (the WS tunnel's HTTP path,
  // reverse proxies) don't reap an idle stream between real events.
  const heartbeat = setInterval(() => res.write(": ping\n\n"), HEARTBEAT_MS);
  heartbeat.unref();
  res.on("close", () => {
    clearInterval(heartbeat);
    subscribers.delete(res);
  });
}

// Fire-and-forget by design (plan: no queue) — an open with no connected
// client is dropped, matching what a native headless terminal would do.
export function broadcastOpenUrl(url: string, serverPort: number): void {
  const frame = `data: ${JSON.stringify({ url, serverPort })}\n\n`;
  for (const res of subscribers) res.write(frame);
}

// `perch open` bridge (plans/cli-open-command.md): the CLI POSTs
// /api/open-target, which broadcasts one of these as a *named* SSE event on
// this same subscriber set — reusing the open-url stream instead of a
// second connection per client. `path`/`projectCwd` are already
// `~`-shortened by the caller so they compare directly against
// TerminalSession.path.
export interface OpenTargetPayload {
  kind: "dir" | "file";
  path: string;
  projectCwd: string;
  line?: number;
  action?: "editor" | "preview";
}

export function broadcastOpenTarget(payload: OpenTargetPayload): number {
  const frame = `event: open-target\ndata: ${JSON.stringify(toClientPaths(payload))}\n\n`;
  for (const res of subscribers) res.write(frame);
  return subscribers.size;
}
