// assistant: the browser half of `perch mcp`. The server picks one page (one
// browser window) for each UI action - see lib.mjs's chooseTarget - so every
// page tells it, on /presence, whether it has focus and which terminal it
// shows, and carries out the actions addressed to it: open a web or file
// preview, run a palette command, show a terminal, build the forward command.
// Each action is answered on /reply and announced in a small notice over the
// editor area, with a Copy button when there is text to take away.
import { useState } from "react";
import "./style.css";
import { copyText } from "../../_shared/clipboard";
import { injectStylesheet } from "../../_shared/injectStylesheet";
import { buildCommand, type TunnelAuth } from "../../_shared/tunnelCommand";
import { NoticeOverlay, resetNotice, showNotice } from "./notice";
import { RelaySection } from "./relay/RelaySection";
import { makeRelayStatusItem } from "./relay/RelayStatusItem";
import { fireRelayChanged, requestStateNow, setRelayHost } from "./relay/relayApi";

interface ActiveContext {
  sessionName: string | null;
  windowIndex: number | null;
  cwd: string | null;
}

interface EventSourceLike {
  addEventListener(type: string, listener: (e: MessageEvent) => void): void;
  close(): void;
}

interface ExtensionContext {
  registerAppOverlay(overlay: { id: string; component: () => JSX.Element | null }): void;
  registerSettingsComponent(component: { id: string; component: () => JSX.Element | null }): void;
  registerStatusBarItem?(item: { id: string; title?: string; placement?: "left" | "right"; order?: number; component: (props: { context: { mobilePointer: boolean } }) => JSX.Element | null }): void;
  settings?: { open?(): void; get?(key: string): unknown; onDidChange?(cb: () => void): () => void };
  serverFetch(path: string, init?: RequestInit): Promise<Response>;
  serverEventSource?(path: string): EventSourceLike;
  assetUrl(relPath: string): string;
  app: {
    getActiveContext(): ActiveContext;
    onDidChangeContext(cb: (ctx: ActiveContext) => void): () => void;
    openUrlInApp?(url: string): boolean;
    canPreview(path: string): boolean;
    openPreview(path: string): void;
    openFileTab(path: string, line?: number): void;
    openSessionWindow(sessionName: string, opts?: { createCwd?: string; windowIndex?: number }): void;
    executeCommand(commandId: string): void;
    confirmDialog?(message: string, confirmLabel?: string): Promise<boolean>;
    getCommands(): { id: string; label: string }[];
    tunnels: { auth(): Promise<TunnelAuth> };
  };
}

interface Action {
  id: string;
  target: string;
  type: string;
  args: Record<string, unknown>;
}

const SETUP_COMMAND = "claude mcp add perch -- perch mcp";
const PRESENCE_MS = 30_000;

// One id per page load. serverEventSource relays every event to every window
// of this browser, so the server addresses actions to a page, not a browser.
const pageId = (() => {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
})();

let host: ExtensionContext | null = null;
let teardown: (() => void)[] = [];

// ---- Settings ----

function SetupSection() {
  const [copied, setCopied] = useState(false);
  const onCopy = () => {
    copyText(SETUP_COMMAND)
      .then(() => setCopied(true))
      .catch(() => setCopied(false));
  };
  return (
    <div className="settings-row assistant-setup">
      <span className="settings-label">Connect Claude Code</span>
      <p className="assistant-setup-text">
        Run this once, then ask Claude Code about your projects from any terminal. With more than one Perch
        running, add <code>--port &lt;n&gt;</code> after <code>perch mcp</code>.
      </p>
      <div className="assistant-setup-command">
        <code>{SETUP_COMMAND}</code>
        <button type="button" className="dialog-button secondary" onClick={onCopy}>
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <p className="assistant-setup-text">Things to ask:</p>
      <ul className="assistant-setup-examples">
        <li>What is the agent in my-app doing? Tell me when it's done.</li>
        <li>Open a preview of the app in my-app.</li>
        <li>Give me the port forward command.</li>
        <li>Open a terminal in my-app and run npm test, then hide the sidebar.</li>
      </ul>
    </div>
  );
}

// ---- Presence ----

let lastContextKey = "";

function reportPresence(extra: { focused?: boolean; bye?: boolean } = {}): void {
  if (!host) return;
  const ctx = host.app.getActiveContext();
  const body = JSON.stringify({
    page: pageId,
    focused: extra.focused ?? document.hasFocus(),
    visible: document.visibilityState === "visible",
    session: ctx.sessionName,
    windowIndex: ctx.windowIndex,
    bye: extra.bye === true,
  });
  // keepalive lets the goodbye outlive the page that sends it.
  host.serverFetch("/presence", { method: "POST", headers: { "content-type": "application/json" }, body, keepalive: extra.bye === true }).catch(() => {
    // The server is restarting; the next report catches it up.
  });
}

function startPresence(ctx: ExtensionContext): void {
  const onFocus = () => reportPresence({ focused: true });
  const onVisibility = () => reportPresence();
  const onHide = () => reportPresence({ bye: true });
  window.addEventListener("focus", onFocus);
  document.addEventListener("visibilitychange", onVisibility);
  window.addEventListener("pagehide", onHide);
  // onDidChangeContext fires on every sessions poll; report only real moves.
  const offContext = ctx.app.onDidChangeContext((next) => {
    const key = `${next.sessionName}\u0000${next.windowIndex}`;
    if (key === lastContextKey) return;
    lastContextKey = key;
    reportPresence();
  });
  const timer = setInterval(() => {
    if (document.visibilityState === "visible") reportPresence();
  }, PRESENCE_MS);
  reportPresence();
  teardown.push(() => {
    window.removeEventListener("focus", onFocus);
    document.removeEventListener("visibilitychange", onVisibility);
    window.removeEventListener("pagehide", onHide);
    offContext();
    clearInterval(timer);
    reportPresence({ bye: true });
  });
}

// ---- Actions ----

async function perform(ctx: ExtensionContext, action: Action): Promise<unknown> {
  const { app } = ctx;
  const args = action.args;
  switch (action.type) {
    case "openUrl": {
      const url = String(args.url);
      if (!app.openUrlInApp?.(url)) throw new Error("Nothing in Perch can show web pages: turn on the Ports extension.");
      showNotice({ title: "Opened web preview", detail: url, copy: url });
      return null;
    }
    case "openFile": {
      const path = String(args.path);
      const preview = app.canPreview(path);
      if (preview) app.openPreview(path);
      else app.openFileTab(path);
      showNotice({ title: preview ? "Opened preview" : "Opened file", detail: path });
      return preview ? "preview" : "file";
    }
    case "listCommands":
      return app.getCommands();
    case "runCommand": {
      const id = String(args.id);
      const command = app.getCommands().find((c) => c.id === id);
      if (!command) throw new Error(`"${id}" is not a command Perch can run from here. Use list_commands for the ids.`);
      app.executeCommand(id);
      showNotice({ title: `Ran ${command.label}` });
      return null;
    }
    case "focusWindow": {
      const session = String(args.session);
      const windowIndex = Number(args.windowIndex);
      app.openSessionWindow(session, { windowIndex });
      showNotice({ title: "Showing terminal", detail: `${session}:${windowIndex}` });
      return null;
    }
    case "forwardCommand": {
      const auth = await app.tunnels.auth();
      const command = buildCommand(window.location.origin, auth, false);
      showNotice({ title: "Port forward command", detail: buildCommand(window.location.origin, auth, true), copy: command });
      return command;
    }
    default:
      throw new Error(`This Perch window doesn't know the action "${action.type}". Reload it to pick up the new version.`);
  }
}

function reply(ctx: ExtensionContext, id: string, outcome: { ok: true; result: unknown } | { ok: false; error: string }): void {
  ctx
    .serverFetch("/reply", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id, ...outcome }) })
    .catch(() => {
      // The tool call times out on its own.
    });
}

function startActions(ctx: ExtensionContext): void {
  if (!ctx.serverEventSource) return;
  const source = ctx.serverEventSource("/events");
  source.addEventListener("action", (e) => {
    let action: Action;
    try {
      action = JSON.parse(e.data) as Action;
    } catch {
      return;
    }
    if (action.target !== "*" && action.target !== pageId) return;
    perform(ctx, action).then(
      (result) => reply(ctx, action.id, { ok: true, result: result ?? null }),
      (err: unknown) => reply(ctx, action.id, { ok: false, error: err instanceof Error ? err.message : String(err) }),
    );
  });
  // The relay link changed (state, members, invites, activity): sections and the status item reload.
  source.addEventListener("relay", () => fireRelayChanged());
  source.addEventListener("relay-notice", (e) => {
    // The notice is what the user sees first (a removal says "removed"); the
    // section behind it must not lag by the 200 ms the coalesced reload waits.
    requestStateNow();
    let data: { title?: unknown; detail?: unknown };
    try {
      data = JSON.parse(e.data) as { title?: unknown; detail?: unknown };
    } catch {
      return;
    }
    if (typeof data.title !== "string") return;
    showNotice({ title: data.title, detail: typeof data.detail === "string" && data.detail ? data.detail : undefined, prose: true });
  });
  // A reopened stream means the server restarted and forgot this page.
  source.addEventListener("open", () => {
    reportPresence();
    fireRelayChanged();
  });
  teardown.push(() => source.close());
}

export function activate(ctx: ExtensionContext): void {
  host = ctx;
  teardown.push(injectStylesheet(ctx.assetUrl, "dist/client.css"));
  ctx.registerAppOverlay({ id: "notice", component: NoticeOverlay });
  ctx.registerSettingsComponent({ id: "setup", component: SetupSection });
  setRelayHost({
    serverFetch: (path, init) => ctx.serverFetch(path, init),
    confirmDialog: ctx.app.confirmDialog?.bind(ctx.app),
    openSettings: () => ctx.settings?.open?.(),
    hasEvents: !!ctx.serverEventSource,
  });
  // Assistant Read-only changes what this machine accepts (R51); the server
  // does not announce that, so refresh when the setting moves.
  if (ctx.settings?.onDidChange) {
    let readOnly = ctx.settings.get?.("assistant.readOnly");
    let later: ReturnType<typeof setTimeout> | undefined;
    teardown.push(
      ctx.settings.onDidChange(() => {
        const next = ctx.settings?.get?.("assistant.readOnly");
        if (next === readOnly) return;
        readOnly = next;
        fireRelayChanged();
        // The server reads the saved setting, which lands a moment after this one.
        clearTimeout(later);
        later = setTimeout(fireRelayChanged, 1500);
      }),
      () => clearTimeout(later),
    );
  }
  ctx.registerSettingsComponent({ id: "relay", component: RelaySection });
  ctx.registerStatusBarItem?.({ id: "relay", title: "Relay", placement: "right", component: makeRelayStatusItem(() => ctx.settings?.open?.()) });
  startPresence(ctx);
  startActions(ctx);
}

export function deactivate(): void {
  for (const fn of teardown.reverse()) fn();
  teardown = [];
  setRelayHost(null);
  host = null;
  resetNotice();
  lastContextKey = "";
}
