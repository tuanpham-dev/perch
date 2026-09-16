// touch-keys: the mobile touch-key bar, floating key toggle, voice-input
// mic key, and the drag-and-drop layout editor — extracted from core
// (TouchKeyBar/FloatingTouchKeys/TouchKeysEditor + touchKeys.ts/
// voiceInput.ts) onto the terminal-accessory and settings-component
// extension points. Ordinary builtin: disabling it is the legitimate
// "I don't want the touch bar" choice.
import { useEffect, useState } from "react";
import "./style.css";
import { injectStylesheet } from "../../_shared/injectStylesheet";
import { DEFAULT_TOUCH_KEYS, type TouchKey } from "./touchKeys";
import FloatingTouchKeys from "./FloatingTouchKeys";
import TouchKeyBar from "./TouchKeyBar";
import TouchKeysEditor from "./TouchKeysEditor";

// ---- Module-level host bridge ----

interface SettingsApi {
  get(key: string): unknown;
  set(key: string, value: unknown): void;
  onDidChange(cb: () => void): () => void;
}

let extSettings: SettingsApi | null = null;
let removeStylesheet: (() => void) | null = null;
let removeSettingsListener: (() => void) | null = null;

// One host subscription fanned out to local component listeners, so every
// consumer re-reads on a Settings edit (including another device's, via the
// server-synced doc).
const settingsListeners = new Set<() => void>();

export function readShow(): "auto" | "always" | "never" {
  const v = extSettings?.get("touchKeys.show");
  return v === "always" || v === "never" ? v : "auto";
}

export function readStyle(): "bar" | "floating" {
  return extSettings?.get("touchKeys.style") === "floating" ? "floating" : "bar";
}

// The layout persists as a JSON string setting (extension configuration
// properties are scalar-only); a malformed stored value falls back to the
// defaults rather than rendering a broken bar.
export function readKeys(): TouchKey[] {
  const raw = extSettings?.get("touchKeys.keys");
  if (typeof raw !== "string" || !raw.trim()) return DEFAULT_TOUCH_KEYS;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (
      Array.isArray(parsed) &&
      parsed.every(
        (k) =>
          typeof k === "object" &&
          k !== null &&
          typeof (k as TouchKey).label === "string" &&
          typeof (k as TouchKey).send === "string" &&
          typeof (k as TouchKey).when === "string",
      )
    ) {
      return parsed as TouchKey[];
    }
  } catch {
    // fall through to defaults
  }
  return DEFAULT_TOUCH_KEYS;
}

export function writeKeys(keys: TouchKey[]): void {
  extSettings?.set("touchKeys.keys", JSON.stringify(keys));
}

// Re-render nudge for components reading the settings above.
export function useTouchKeySettingsTick(): number {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const cb = () => setTick((t) => t + 1);
    settingsListeners.add(cb);
    return () => {
      settingsListeners.delete(cb);
    };
  }, []);
  return tick;
}

// ---- Accessory wrappers ----
//
// Both placements register unconditionally; each renders null unless the
// style setting selects it, so flipping the style applies live without
// re-registration.

interface TerminalAccessoryContext {
  focused: boolean;
  mobilePointer: boolean;
  command: string;
  stickyCtrl: boolean;
  toggleStickyCtrl(): void;
  sendInput(data: string): void;
  sendText(text: string): void;
  uploadImage(file: File): void;
  uploadImages(files: File[]): void;
  containerRef: React.RefObject<HTMLDivElement | null>;
}

function isVisible(ctx: TerminalAccessoryContext): boolean {
  const show = readShow();
  return ctx.focused && (show === "always" || (show === "auto" && ctx.mobilePointer));
}

function BarAccessory({ context }: { context: TerminalAccessoryContext }) {
  useTouchKeySettingsTick();
  if (readStyle() === "floating") return null;
  return (
    <TouchKeyBar
      visible={isVisible(context)}
      keys={readKeys()}
      currentCommand={context.command}
      stickyCtrl={context.stickyCtrl}
      onToggleStickyCtrl={context.toggleStickyCtrl}
      onSendInput={context.sendInput}
      onSendVoiceText={context.sendText}
      onUploadImages={context.uploadImages}
    />
  );
}

function OverlayAccessory({ context }: { context: TerminalAccessoryContext }) {
  useTouchKeySettingsTick();
  if (readStyle() !== "floating") return null;
  return (
    <FloatingTouchKeys
      visible={isVisible(context)}
      keys={readKeys()}
      currentCommand={context.command}
      stickyCtrl={context.stickyCtrl}
      onToggleStickyCtrl={context.toggleStickyCtrl}
      onSendInput={context.sendInput}
      onSendVoiceText={context.sendText}
      onUploadImages={context.uploadImages}
      containerRef={context.containerRef}
    />
  );
}

// ---- Activation ----

interface ExtensionContext {
  registerTerminalAccessory(accessory: {
    id: string;
    placement: "bar" | "overlay";
    component: (props: { context: TerminalAccessoryContext }) => ReturnType<typeof BarAccessory>;
  }): void;
  registerSettingsComponent(component: { id: string; component: typeof TouchKeysEditor }): void;
  settings: SettingsApi;
  assetUrl(relPath: string): string;
}

export function activate(ctx: ExtensionContext): void {
  extSettings = ctx.settings;
  removeStylesheet = injectStylesheet(ctx.assetUrl, "dist/client.css");
  removeSettingsListener = ctx.settings.onDidChange(() => {
    for (const cb of settingsListeners) cb();
  });
  ctx.registerTerminalAccessory({ id: "bar", placement: "bar", component: BarAccessory });
  ctx.registerTerminalAccessory({ id: "floating", placement: "overlay", component: OverlayAccessory });
  ctx.registerSettingsComponent({ id: "layout-editor", component: TouchKeysEditor });
}

export function deactivate(): void {
  removeSettingsListener?.();
  removeSettingsListener = null;
  removeStylesheet?.();
  removeStylesheet = null;
  extSettings = null;
  settingsListeners.clear();
}
