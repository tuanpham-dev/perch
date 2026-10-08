import { describe, expect, it, vi } from "vitest";
import { createDesktopBridge, desktop, fileManagerName, newWindowRoute, parseButtonLayout } from "./desktop";

function stub(info: Record<string, unknown> = { platform: "linux", version: "0.1.0", isLocal: true }) {
  const invoke = vi.fn(async (cmd: string) => (cmd === "pick_folder" ? "/home/me/code" : cmd === "window_is_maximized" ? true : null));
  const bridge = createDesktopBridge({ __TAURI_INTERNALS__: { invoke }, __PERCH_DESKTOP__: info });
  return { invoke, bridge };
}

describe("desktop bridge", () => {
  it("is null outside the desktop app", () => {
    expect(desktop).toBeNull();
    expect(createDesktopBridge(undefined)).toBeNull();
    expect(createDesktopBridge({})).toBeNull();
  });

  it("needs both the IPC and the app's window info", () => {
    expect(createDesktopBridge({ __TAURI_INTERNALS__: { invoke: async () => null } })).toBeNull();
    expect(stub({ platform: "beos" }).bridge).toBeNull();
  });

  it("reads the window info", () => {
    const right = { left: [], right: ["minimize", "maximize", "close"] };
    expect(stub().bridge!.info).toEqual({ platform: "linux", version: "0.1.0", isLocal: true, buttonLayout: right });
    expect(stub({ platform: "macos" }).bridge!.info).toEqual({ platform: "macos", version: "", isLocal: false, buttonLayout: right });
  });

  it("follows the desktop's button layout on Linux only", () => {
    const globals: Record<string, unknown> = {
      __TAURI_INTERNALS__: { invoke: async () => null },
      __PERCH_DESKTOP__: { platform: "linux", buttonLayout: "close,minimize,maximize:" },
    };
    const bridge = createDesktopBridge(globals)!;
    expect(bridge.info.buttonLayout).toEqual({ left: ["close", "minimize", "maximize"], right: [] });
    const seen: unknown[] = [];
    bridge.onButtonLayoutChange((l) => seen.push(l));
    (globals.__perchDesktopButtonLayout as (l: string) => void)("appmenu:close");
    expect(seen).toEqual([{ left: [], right: ["close"] }]);
    expect(bridge.info.buttonLayout).toEqual({ left: [], right: ["close"] });
    const win = createDesktopBridge({
      __TAURI_INTERNALS__: { invoke: async () => null },
      __PERCH_DESKTOP__: { platform: "windows", buttonLayout: "close:" },
    })!;
    expect(win.info.buttonLayout).toEqual({ left: [], right: ["minimize", "maximize", "close"] });
  });

  it("parses gtk-decoration-layout", () => {
    expect(parseButtonLayout(":minimize,maximize,close")).toEqual({ left: [], right: ["minimize", "maximize", "close"] });
    expect(parseButtonLayout("close,minimize,maximize:")).toEqual({ left: ["close", "minimize", "maximize"], right: [] });
    expect(parseButtonLayout("appmenu:close")).toEqual({ left: [], right: ["close"] });
    expect(parseButtonLayout("icon:minimize,spacer,maximize,close")).toEqual({ left: [], right: ["minimize", "maximize", "close"] });
    expect(parseButtonLayout("close:menu")).toEqual({ left: ["close"], right: [] });
    // No buttons at all: the window would have no way to close.
    expect(parseButtonLayout("")).toEqual({ left: [], right: ["minimize", "maximize", "close"] });
    expect(parseButtonLayout("appmenu:")).toEqual({ left: [], right: ["minimize", "maximize", "close"] });
    expect(parseButtonLayout(undefined)).toEqual({ left: [], right: ["minimize", "maximize", "close"] });
  });

  it("maps each method to its app command and arguments", async () => {
    const { invoke, bridge } = stub();
    await bridge!.minimize();
    await bridge!.toggleMaximize();
    await bridge!.close();
    await bridge!.startDragging();
    await bridge!.setDecorations(false);
    await bridge!.openExternal("https://example.com/");
    await bridge!.revealPath("~/code/a.txt");
    await bridge!.openWithDefault("/tmp/a.pdf");
    expect(invoke.mock.calls).toEqual([
      ["window_minimize", undefined],
      ["window_toggle_maximize", undefined],
      ["window_close", undefined],
      ["window_start_dragging", undefined],
      ["window_set_decorations", { on: false }],
      ["open_external", { url: "https://example.com/" }],
      ["reveal_path", { path: "~/code/a.txt" }],
      ["open_with_default", { path: "/tmp/a.pdf" }],
    ]);
  });

  it("returns the picked folder and the maximized state", async () => {
    const { invoke, bridge } = stub();
    expect(await bridge!.pickFolder("~/code")).toBe("/home/me/code");
    expect(invoke).toHaveBeenLastCalledWith("pick_folder", { start: "~/code" });
    expect(await bridge!.isMaximized()).toBe(true);
  });

  it("names the file manager per platform", () => {
    expect(fileManagerName("macos")).toBe("Finder");
    expect(fileManagerName("windows")).toBe("File Explorer");
    expect(fileManagerName("linux")).toBe("Files");
  });
});

describe("newWindowRoute", () => {
  const page = "http://127.0.0.1:3101";
  it("sends another site's new-window links to the default browser", () => {
    expect(newWindowRoute("https://example.com/", "_blank", page)).toBe("external");
    expect(newWindowRoute("mailto:a@b.c", "_blank", page)).toBe("external");
  });

  it("opens this site's own in a window of its own", () => {
    expect(newWindowRoute("http://127.0.0.1:3101/?file=x", "_blank", page)).toBe("popup");
  });

  it("leaves other links alone", () => {
    expect(newWindowRoute("https://example.com/", "", page)).toBeNull();
    expect(newWindowRoute("javascript:alert(1)", "_blank", page)).toBeNull();
    expect(newWindowRoute("file:///etc/passwd", "_blank", page)).toBeNull();
  });
});
