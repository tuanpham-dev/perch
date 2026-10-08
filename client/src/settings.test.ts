import { beforeAll, describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS, migrateSettings } from "./settings";
import { listIconThemeOptions, NO_ICON_THEME, resolveIconThemeValue } from "./utils/iconThemes";

// migrateSettings records its one-shot migrations in localStorage.
beforeAll(() => {
  const store = new Map<string, string>();
  globalThis.localStorage ??= {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
    clear: () => store.clear(),
    key: (i: number) => [...store.keys()][i] ?? null,
    get length() {
      return store.size;
    },
  };
});

describe("icon theme setting", () => {
  it("keeps None across a reload, and maps an older file's empty value to Seti", () => {
    expect(migrateSettings({ ...DEFAULT_SETTINGS, iconTheme: NO_ICON_THEME }).iconTheme).toBe(NO_ICON_THEME);
    expect(migrateSettings({ ...DEFAULT_SETTINGS, iconTheme: "" }).iconTheme).toBe(DEFAULT_SETTINGS.iconTheme);
  });

  it("offers None as its own value, which resolves to no theme", () => {
    expect(listIconThemeOptions([])[0]).toEqual({ value: NO_ICON_THEME, label: "None" });
    expect(resolveIconThemeValue(NO_ICON_THEME, [])).toBeNull();
  });
});
