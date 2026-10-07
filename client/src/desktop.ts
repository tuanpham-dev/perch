// The Perch desktop app (desktop/, Tauri) loads each server's own page in a
// native window. This module is the only part of the client that knows: it
// is `null` in every browser and installed PWA, so every desktop branch
// elsewhere is `if (desktop)` and dead code there. See plans/desktop-app.md.
//
// The app injects two globals before the page's own scripts run: Tauri's IPC
// (`__TAURI_INTERNALS__`, whose `invoke` reaches the app's commands) and
// `__PERCH_DESKTOP__`, what this window is. The client calls `invoke`
// directly rather than depending on @tauri-apps/api, which would put Tauri
// code in every browser's bundle. Which commands a page may call is decided
// by the app per window: the bundled local server's page may also reach the
// file commands, no other server's may.

export type DesktopPlatform = "macos" | "windows" | "linux";

export type WindowButton = "minimize" | "maximize" | "close";

// Which window buttons the title bar draws, in order, on each side.
export interface ButtonLayout {
  left: WindowButton[];
  right: WindowButton[];
}

export interface DesktopInfo {
  platform: DesktopPlatform;
  version: string;
  // This window shows the server bundled with the app, on this machine.
  isLocal: boolean;
  // Where the desktop puts window buttons (Linux follows its setting;
  // Windows is always minimize, maximize, close at the right).
  buttonLayout: ButtonLayout;
}

const BUTTONS: readonly WindowButton[] = ["minimize", "maximize", "close"];

/**
 * GTK's gtk-decoration-layout, the setting GNOME, KDE, XFCE, Cinnamon and
 * MATE use for where window buttons go: buttons before the colon sit at the
 * left, after it at the right ("close,minimize,maximize:" is macOS-style,
 * GNOME's default "appmenu:close" shows only close). Anything that isn't a
 * button (appmenu, icon, menu, spacer) is skipped.
 */
export function parseButtonLayout(layout: string | undefined): ButtonLayout {
  if (typeof layout !== "string") return { left: [], right: [...BUTTONS] };
  const [before, after = ""] = layout.split(":");
  const pick = (side: string) =>
    side.split(",").map((b) => b.trim()).filter((b): b is WindowButton => BUTTONS.includes(b as WindowButton));
  return { left: pick(before), right: pick(after) };
}

type Invoke = (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;

export interface DesktopBridge {
  info: DesktopInfo;
  minimize(): Promise<void>;
  toggleMaximize(): Promise<void>;
  close(): Promise<void>;
  isMaximized(): Promise<boolean>;
  // Calls `cb` whenever the window's maximized state changes. Returns an
  // unsubscribe function.
  onMaximizedChange(cb: (maximized: boolean) => void): () => void;
  startDragging(): Promise<void>;
  setDecorations(on: boolean): Promise<void>;
  openExternal(url: string): Promise<void>;
  revealPath(path: string): Promise<void>;
  openWithDefault(path: string): Promise<void>;
  // The chosen folder, or null when the user cancelled.
  pickFolder(start?: string): Promise<string | null>;
  // Calls `cb` when the desktop's button layout changes (Linux). Returns an
  // unsubscribe function.
  onButtonLayoutChange(cb: (layout: ButtonLayout) => void): () => void;
}

interface DesktopGlobals {
  __TAURI_INTERNALS__?: { invoke?: Invoke };
  __PERCH_DESKTOP__?: Partial<Omit<DesktopInfo, "buttonLayout">> & { buttonLayout?: string };
  __perchDesktop?: DesktopPageHooks;
  // The app calls this with the new layout string when the desktop's
  // setting changes.
  __perchDesktopButtonLayout?: (layout: string) => void;
}

const PLATFORMS: readonly DesktopPlatform[] = ["macos", "windows", "linux"];

export function createDesktopBridge(globals: DesktopGlobals | undefined): DesktopBridge | null {
  const invoke = globals?.__TAURI_INTERNALS__?.invoke;
  const raw = globals?.__PERCH_DESKTOP__;
  if (typeof invoke !== "function" || !raw || !PLATFORMS.includes(raw.platform as DesktopPlatform)) return null;
  const info: DesktopInfo = {
    platform: raw.platform as DesktopPlatform,
    version: typeof raw.version === "string" ? raw.version : "",
    isLocal: raw.isLocal === true,
    buttonLayout: raw.platform === "linux" ? parseButtonLayout(raw.buttonLayout) : parseButtonLayout(undefined),
  };
  const layoutListeners = new Set<(layout: ButtonLayout) => void>();
  if (info.platform === "linux") {
    globals!.__perchDesktopButtonLayout = (layout) => {
      info.buttonLayout = parseButtonLayout(layout);
      for (const cb of layoutListeners) cb(info.buttonLayout);
    };
  }
  const call = (cmd: string, args?: Record<string, unknown>) => invoke(cmd, args);
  const run = async (cmd: string, args?: Record<string, unknown>) => {
    await call(cmd, args);
  };
  return {
    info,
    minimize: () => run("window_minimize"),
    toggleMaximize: () => run("window_toggle_maximize"),
    close: () => run("window_close"),
    isMaximized: async () => (await call("window_is_maximized")) === true,
    onMaximizedChange(cb) {
      // No event from the app for this: a maximize or restore always resizes
      // the page, so asking on resize is enough.
      let last: boolean | null = null;
      const check = () => {
        void call("window_is_maximized").then((v) => {
          const maximized = v === true;
          if (maximized !== last) {
            last = maximized;
            cb(maximized);
          }
        }, () => {});
      };
      check();
      window.addEventListener("resize", check);
      return () => window.removeEventListener("resize", check);
    },
    startDragging: () => run("window_start_dragging"),
    setDecorations: (on) => run("window_set_decorations", { on }),
    openExternal: (url) => run("open_external", { url }),
    revealPath: (path) => run("reveal_path", { path }),
    openWithDefault: (path) => run("open_with_default", { path }),
    pickFolder: async (start) => {
      const picked = await call("pick_folder", start ? { start } : {});
      return typeof picked === "string" ? picked : null;
    },
    onButtonLayoutChange(cb) {
      layoutListeners.add(cb);
      return () => layoutListeners.delete(cb);
    },
  };
}

export const desktop: DesktopBridge | null = createDesktopBridge(
  typeof window === "undefined" ? undefined : (window as unknown as DesktopGlobals),
);

// What the app calls back into the page, by evaluating
// `window.__perchDesktop?.<hook>(...)` once the page has loaded: a perch://
// link or `perch-desktop` opening a path, and a notification click
// switching to the terminal it was about.
export interface DesktopPageHooks {
  openPath(path: string, line?: number, action?: "editor" | "preview"): void;
  focusTerminal(windowId: string): void;
}

export function installDesktopHooks(hooks: DesktopPageHooks): void {
  if (!desktop) return;
  (window as unknown as DesktopGlobals).__perchDesktop = hooks;
}

// The file manager's name on this platform, for "Reveal in ..." items.
export function fileManagerName(platform: DesktopPlatform): string {
  if (platform === "macos") return "Finder";
  if (platform === "windows") return "File Explorer";
  return "Files";
}
