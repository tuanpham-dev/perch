import { describe, expect, it, vi } from "vitest";
import { createDesktopBridge, desktop, fileManagerName } from "./desktop";

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
    expect(stub().bridge!.info).toEqual({ platform: "linux", version: "0.1.0", isLocal: true });
    expect(stub({ platform: "macos" }).bridge!.info).toEqual({ platform: "macos", version: "", isLocal: false });
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
