// First: server/.env has to be in process.env before any other module loads.
import "./loadEnv.js";
import { existsSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import type net from "node:net";
import path from "node:path";
import express from "express";
import { WebSocketServer } from "ws";
import { agentHookBodyParser, ensureAgentHookShim } from "./agentHooks.js";
import { resumeRestoredAgents } from "./agentResume.js";
import { applyTerminalSettings } from "./terminalSettings.js";
import { api } from "./api.js";
import { clientPathsMiddleware } from "./clientPaths.js";
import { writeInstanceRecord } from "./instanceRecord.js";
import { subscribeCommandEvents } from "./commandEvents.js";
import { loadEnabledServerHooks } from "./extensions.js";
import { activeEngineId, DAEMON_ENGINE_ID, enginesSettled, getMultiplexer, selectEngine, whenEngineReady } from "./multiplexer.js";
import { startDaemonLink, terminalEnv } from "./mux.js";
import { ensureOpenShim } from "./openUrl.js";
import { ensureClipboardShims } from "./clipboardShims.js";
import { notifyBell, notifyCommandDone } from "./push.js";
import { readSettingsDoc, readSettingSync } from "./settingsStore.js";
import { ensureShellIntegration } from "./shellIntegration.js";
import { spawnEnv } from "./spawnEnv.js";
import { getTunnelablePorts } from "./ports.js";
import { windowAddress } from "./terminals.js";
import {
  handleProxyRequest,
  handleProxyUpgrade,
  parseProxyPath,
  portFromReferer,
} from "./proxy.js";
import {
  AUTH_COOKIE_NAME,
  cookieDomainFor,
  isAllowedHost,
  isAllowedOrigin,
  isAuthExemptPath,
  isAuthGateEnabled,
  isOriginExemptPath,
  isValidAuthToken,
  portFromProxyHost,
  tokenFromRequest,
} from "./security.js";
import { handleAttach } from "./wsAttach.js";
import { handleTunnel } from "./wsTunnel.js";


// Backstop for a rejected promise nobody awaited - an extension's socket
// server, timer or hook callback, where no request exists to fail. Node's
// default is to exit the process, which takes every session's terminal down
// over one stray rejection. Route handlers are already covered where they
// enter (extensions.ts's createExtensionRouter); this is the net under
// everything else. Deliberately NOT paired with an uncaughtException handler:
// a synchronous throw can leave state half-updated, and keeping the process
// alive after one is a different decision.
process.on("unhandledRejection", (reason) => {
  console.error("unhandled promise rejection (server kept running):", reason);
});

const HOST = "127.0.0.1";
const PORT = Number(process.env.PORT ?? 3001);

const HTML_ESCAPES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;" };
function escapeHtml(s: string): string {
  return s.replace(/[&<>]/g, (c) => HTML_ESCAPES[c]);
}

const app = express();
// Host guards against DNS rebinding; Origin guards against a browser tab on
// some other site making a request here (WebSockets ignore same-origin
// policy entirely, and a handful of no-body POST endpoints are reachable
// cross-origin as "simple requests"). Requests with no Origin (curl, the
// tunnel CLI) aren't from a browser context this protects against, so they
// pass — see security.ts.
app.use((req, res, next) => {
  if (!isAllowedHost(req.headers.host)) {
    res.status(403).json({ error: "forbidden host" });
    return;
  }
  // /public/ routes (e.g. live-preview's serve/mtime) enforce their own
  // capability-token authorization instead of trusting Origin — see
  // isOriginExemptPath's module comment for why that's safe.
  if (!isOriginExemptPath(req.path) && !isAllowedOrigin(req.headers.origin)) {
    res.status(403).json({ error: "forbidden origin" });
    return;
  }
  next();
});
// Optional shared-secret gate (off unless AUTH_TOKEN is set — see
// security.ts). A valid ?token= on ANY path (not just /api) mints the
// cookie, since the entry point is typically the SPA shell at "/". Only
// /api/* is actually rejected without it: the SPA shell and /tunnel.mjs are
// public code with nothing to protect, and /api/ext/*/public/* enforces its
// own capability token (see isAuthExemptPath).
app.use((req, res, next) => {
  if (!isAuthGateEnabled()) {
    next();
    return;
  }
  const queryToken = typeof req.query.token === "string" ? req.query.token : undefined;
  if (queryToken && isValidAuthToken(queryToken)) {
    const forwardedProto = req.headers["x-forwarded-proto"];
    const proto = Array.isArray(forwardedProto) ? forwardedProto[0] : forwardedProto;
    res.cookie(AUTH_COOKIE_NAME, queryToken, {
      httpOnly: true,
      sameSite: "lax",
      secure: proto?.split(",")[0]?.trim() === "https",
      maxAge: 30 * 24 * 60 * 60 * 1000,
      path: "/",
      // Undefined when PROXY_DOMAIN is unset or the current host isn't one
      // of its configured domains — leaves the cookie host-only, today's
      // behavior. Set, this shares the cookie across every "<port>.<domain>"
      // origin so a proxied dev server on a different subdomain is already
      // authenticated.
      domain: cookieDomainFor(req.headers.host),
    });
  }
  // Gated the same as /api/*: a /proxy or /absproxy path, or a
  // PROXY_DOMAIN subdomain request naming a port — both reach a local
  // process, same as an API call would.
  const isProxyRequest =
    parseProxyPath(req.path) !== null || portFromProxyHost(req.headers.host) !== null;
  if ((!req.path.startsWith("/api/") && !isProxyRequest) || isAuthExemptPath(req.path)) {
    next();
    return;
  }
  const authHeader = req.headers["x-auth-token"];
  const token = tokenFromRequest(
    req.headers.cookie,
    Array.isArray(authHeader) ? authHeader[0] : authHeader,
    queryToken,
  );
  if (!isValidAuthToken(token)) {
    res.status(401).json({ error: "unauthorized" });
    return;
  }
  next();
});
// Reverse proxy to a locally-listening port, code-server style — mounted
// ahead of express.json() so proxied request bodies stream through
// untouched rather than being buffered/parsed here. Restricted to ports a
// terminal actually owns (getTunnelablePorts, same allowlist the WS tunnel
// CLI uses) — otherwise any page open in a browser on this machine could
// reach arbitrary localhost services (a database, another user's daemon)
// merely by knowing its port number, bypassing whatever access control that
// service itself relies on.
app.use((req, res, next) => {
  const subdomainPort = portFromProxyHost(req.headers.host);
  if (subdomainPort !== null) {
    if (subdomainPort === PORT) {
      res.status(400).json({ error: "cannot proxy the server's own port" });
      return;
    }
    getTunnelablePorts()
      .then((allowed) => {
        if (!allowed.has(subdomainPort)) {
          res.status(403).json({ error: `port ${subdomainPort} is not open to a terminal session` });
          return;
        }
        handleProxyRequest(req, res, subdomainPort, req.url ?? "/", null);
      })
      .catch(next);
    return;
  }
  const parsed = parseProxyPath(req.path);
  if (parsed) {
    if (parsed.port === PORT) {
      res.status(400).json({ error: "cannot proxy the server's own port" });
      return;
    }
    getTunnelablePorts()
      .then((allowed) => {
        if (!allowed.has(parsed.port)) {
          res.status(403).json({ error: `port ${parsed.port} is not open to a terminal session` });
          return;
        }
        const search = req.url && req.url.includes("?") ? req.url.slice(req.url.indexOf("?")) : "";
        const prefix = parsed.absolute ? null : `/proxy/${parsed.port}`;
        handleProxyRequest(req, res, parsed.port, parsed.rest + search, prefix);
      })
      .catch(next);
    return;
  }
  next();
});
// The agent-hook report endpoint takes its body raw, with its own size cap
// (server/src/agentHooks.ts) — registered ahead of express.json() for the
// same reason the proxy routes are: whichever parser runs first consumes the
// stream.
app.use("/api/agent-hooks/report", agentHookBodyParser);
app.use(express.json());
app.use(clientPathsMiddleware);
app.use("/api", api);

const tunnelCli = path.resolve(import.meta.dirname, "../../cli/tunnel.mjs");
app.get("/tunnel.mjs", (_req, res) => {
  res.type("text/javascript").sendFile(tunnelCli);
});

const clientDist = path.resolve(import.meta.dirname, "../../client/dist");
if (existsSync(clientDist)) {
  const manifestPath = path.join(clientDist, "manifest.webmanifest");
  const indexHtmlPath = path.join(clientDist, "index.html");

  // Registered ahead of express.static below so a custom APP_NAME (see
  // server/.env) can override the name baked into these two files at build
  // time — read fresh each request since both files are tiny and this is a
  // low-traffic personal tool, not worth caching.
  app.get("/manifest.webmanifest", (_req, res, next) => {
    const appName = process.env.APP_NAME;
    if (!appName || !existsSync(manifestPath)) {
      next();
      return;
    }
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    manifest.name = appName;
    manifest.short_name = appName;
    res.type("application/manifest+json").send(JSON.stringify(manifest));
  });

  // index: false — otherwise express.static serves index.html for "/"
  // itself (its default behavior), bypassing the templated catch-all below.
  app.use(express.static(clientDist, { index: false }));
  // Fallback for absolute-path assets (e.g. "/assets/x.js") requested by a
  // page served through /proxy/<port>/ or /absproxy/<port>/ — express.static
  // just missed above, so route it to the port named in the Referer instead
  // of falling through to the SPA shell. Same-origin Referer only (see
  // portFromReferer) and HTTP only (WebSocket upgrades rarely carry one).
  // A soft fallback, unlike the proxy middleware above: an untunnelable
  // inferred port just falls through to the SPA shell rather than erroring.
  app.use((req, res, next) => {
    if (
      req.path.startsWith("/api/") ||
      req.path.startsWith("/ws/") ||
      req.path === "/tunnel.mjs" ||
      parseProxyPath(req.path) !== null
    ) {
      next();
      return;
    }
    const refererPort = portFromReferer(req.headers.referer, req.headers.host);
    if (refererPort === null || refererPort === PORT) {
      next();
      return;
    }
    getTunnelablePorts()
      .then((allowed) => {
        if (!allowed.has(refererPort)) {
          next();
          return;
        }
        handleProxyRequest(req, res, refererPort, req.url ?? "/", null);
      })
      .catch(next);
  });
  app.get(/^\/(?!api|ws).*/, (_req, res) => {
    const appName = process.env.APP_NAME;
    if (!appName) {
      res.sendFile(indexHtmlPath);
      return;
    }
    const html = readFileSync(indexHtmlPath, "utf8").replace(
      /<title>.*?<\/title>/,
      `<title>${escapeHtml(appName)}</title>`,
    );
    res.type("html").send(html);
  });
}

const server = createServer(app);
const wss = new WebSocketServer({ noServer: true });

server.on("upgrade", (req, socket, head) => {
  if (!isAllowedHost(req.headers.host) || !isAllowedOrigin(req.headers.origin)) {
    socket.destroy();
    return;
  }
  const { pathname, searchParams } = new URL(req.url ?? "", "http://localhost");
  if (isAuthGateEnabled()) {
    const authHeader = req.headers["x-auth-token"];
    const token = tokenFromRequest(
      req.headers.cookie,
      Array.isArray(authHeader) ? authHeader[0] : authHeader,
      searchParams.get("token") ?? undefined,
    );
    if (!isValidAuthToken(token)) {
      socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
  }
  const subdomainPort = portFromProxyHost(req.headers.host);
  const parsedProxy = subdomainPort === null ? parseProxyPath(pathname) : null;
  if (pathname === "/ws/attach") {
    wss.handleUpgrade(req, socket, head, (ws) => {
      handleAttach(ws, req);
    });
  } else if (pathname === "/ws/tunnel") {
    // The id of the browser whose command started this tunnel, which is
    // what pairs the two - see wsTunnel's tunnelStatus.
    const client = searchParams.get("client");
    wss.handleUpgrade(req, socket, head, (ws) => {
      handleTunnel(ws, client);
    });
  } else if (subdomainPort !== null) {
    if (subdomainPort === PORT) {
      socket.destroy();
      return;
    }
    getTunnelablePorts()
      .then((allowed) => {
        if (!allowed.has(subdomainPort)) {
          socket.destroy();
          return;
        }
        handleProxyUpgrade(req, socket, head, subdomainPort, req.url ?? "/");
      })
      .catch(() => socket.destroy());
  } else if (parsedProxy) {
    if (parsedProxy.port === PORT) {
      socket.destroy();
      return;
    }
    getTunnelablePorts()
      .then((allowed) => {
        if (!allowed.has(parsedProxy.port)) {
          socket.destroy();
          return;
        }
        handleProxyUpgrade(req, socket, head, parsedProxy.port, parsedProxy.rest);
      })
      .catch(() => socket.destroy());
  } else {
    socket.destroy();
  }
});

// Without this, a listen failure (e.g. EADDRINUSE from two rapid tsx-watch
// restarts racing on shutdown) throws uncaught and kills the process with an
// opaque stack trace — tsx watch only respawns on the next file save, so it
// stays dead. Logging plainly at least makes the cause diagnosable.
server.on("error", (err) => {
  console.error(`server failed to start: ${err.message}`);
  process.exit(1);
});

server.listen(PORT, HOST, () => {
  console.log(`perch server listening on http://${HOST}:${PORT}`);
  writeInstanceRecord(PORT, path.resolve(import.meta.dirname, "../.."));
});

// The terminal daemon: tell it which server its shells report to, and turn
// its bells into push notifications. A bell is keyed "session:index", the
// address a notification opens.
// Shell-integration snippet (OSC 133 marks + command reports — see
// server/src/shellIntegration.ts), plus the zsh wrappers terminalEnv points
// ZDOTDIR at, so they exist before the engine's first terminal. Same
// contract as the shims below: failure only disables the feature.
await ensureShellIntegration(PORT).catch((err) => {
  console.error("failed to write shell integration:", err);
});
// The engine chosen in Settings -> Terminal, before anything asks for a
// terminal; an engine an extension provides registers when hooks load below.
const backend = readSettingSync("terminalBackend");
selectEngine(typeof backend === "string" ? backend : DAEMON_ENGINE_ID, {
  port: PORT,
  env: Object.fromEntries(
    Object.entries({ ...spawnEnv(), ...terminalEnv(PORT) }).filter((e): e is [string, string] => e[1] !== undefined),
  ),
});
startDaemonLink(PORT, () => whenEngineReady().then(() => activeEngineId() === DAEMON_ENGINE_ID));
applyTerminalSettings().catch((err) => console.error("failed to apply terminal settings:", err));
resumeRestoredAgents();
getMultiplexer().onEvent((event) => {
  if (event.event === "sessions-changed") resumeRestoredAgents();
  if (event.event !== "bell") return;
  windowAddress(event.windowId)
    .then((addr) => (addr ? notifyBell(`${addr.session}:${addr.index}`) : undefined))
    .catch(() => {});
});
loadEnabledServerHooks()
  .catch((err) => {
    console.error("failed to load extension server hooks:", err);
  })
  .finally(enginesSettled);
// Browser-opener bridge shim ($BROWSER target for terminals — see
// server/src/openUrl.ts). Failure just disables the bridge, never the server.
ensureOpenShim(PORT).catch((err) => {
  console.error("failed to write browser-opener shim:", err);
});
// Clipboard-tool shims (xclip and friends writing OSC 52, see
// server/src/clipboardShims.ts). Same contract: failure only disables them.
ensureClipboardShims().catch((err) => {
  console.error("failed to write clipboard shims:", err);
});
// Agent-hook shim (what an AI agent's own hooks exec to report a turn
// ending, a permission prompt, a tool call — see server/src/agentHooks.ts).
// Same contract as the two shims around it: failure disables the pipeline,
// never the server.
ensureAgentHookShim(PORT).catch((err) => {
  console.error("failed to write agent-hook shim:", err);
});
// Finished-command notifications (plans/warp-features.md Phase 2): every
// shell-integration end event checks the user's threshold. The 1s floor
// skips the settings-file read for the torrent of instant commands —
// sub-second thresholds aren't offered by the UI anyway.
subscribeCommandEvents((frame) => {
  if (frame.event !== "end" || frame.durationMs === undefined || frame.durationMs < 1000) return;
  readSettingsDoc()
    .then((doc) => {
      // The synced doc nests the AppSettings fields under a "settings" key
      // (client/src/settings.ts's document shape), alongside keybindings,
      // extensionSettings, etc.
      const settings = doc.settings as Record<string, unknown> | undefined;
      const threshold = Number(settings?.notifyCommandMinDuration);
      if (!Number.isFinite(threshold) || threshold <= 0) return;
      if (frame.durationMs! < threshold * 1000) return;
      return notifyCommandDone(
        frame.pane,
        frame.sessionName,
        frame.command,
        frame.exitCode ?? 0,
        frame.durationMs!,
      );
    })
    .catch(() => {});
});
