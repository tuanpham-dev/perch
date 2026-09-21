import { describe, expect, it } from "vitest";
import { outdatedExtensions } from "./extensionUpdates";
import type { ExtensionInfo, RegistryCatalogEntry, RegistrySourceResult } from "../types";

const REG = "https://registry.example.com/";
const OTHER = "https://other.example.com/";

function ext(id: string, version: string, over: Partial<ExtensionInfo> = {}): ExtensionInfo {
  return {
    id,
    displayName: id,
    version,
    description: "",
    icon: null,
    enabled: true,
    themes: [],
    iconThemes: [],
    fonts: [],
    configuration: [],
    terminalEngines: [],
    editors: [],
    clientEntry: "dist/client.js",
    hasClient: true,
    hasServer: false,
    builtin: false,
    required: false,
    uninstalled: false,
    source: REG,
    ...over,
  };
}

function entry(id: string, version: string): RegistryCatalogEntry {
  return { id, displayName: id, version, description: "", hasReadme: false, hasIcon: false };
}

function source(src: string, entries: RegistryCatalogEntry[]): RegistrySourceResult {
  return { source: src, entries };
}

describe("outdatedExtensions", () => {
  it("reports a higher offered version with the source carrying it", () => {
    const out = outdatedExtensions(
      [ext("me.thing", "1.2.0")],
      [source(REG, [entry("me.thing", "1.3.0")])],
      [REG],
    );
    expect(out.get("me.thing")).toEqual({ source: REG, version: "1.3.0" });
  });

  it("ignores an equal or lower offered version", () => {
    const installed = [ext("me.thing", "1.3.0")];
    expect(
      outdatedExtensions(installed, [source(REG, [entry("me.thing", "1.3.0")])], [REG]).size,
    ).toBe(0);
    expect(
      outdatedExtensions(installed, [source(REG, [entry("me.thing", "1.2.9")])], [REG]).size,
    ).toBe(0);
  });

  it("takes the highest version when two sources offer the same id", () => {
    const out = outdatedExtensions(
      [ext("me.thing", "1.0.0")],
      [source(REG, [entry("me.thing", "1.1.0")]), source(OTHER, [entry("me.thing", "1.4.0")])],
      [REG, OTHER],
    );
    expect(out.get("me.thing")).toEqual({ source: OTHER, version: "1.4.0" });
  });

  it("keeps the highest version regardless of source order", () => {
    const out = outdatedExtensions(
      [ext("me.thing", "1.0.0")],
      [source(OTHER, [entry("me.thing", "1.4.0")]), source(REG, [entry("me.thing", "1.1.0")])],
      [REG, OTHER],
    );
    expect(out.get("me.thing")).toEqual({ source: OTHER, version: "1.4.0" });
  });

  it("ignores a source that is no longer configured", () => {
    // A removed registry's entries linger in the fetched catalog until the
    // next refetch — they must stop counting immediately.
    const out = outdatedExtensions(
      [ext("me.thing", "1.2.0")],
      [source(OTHER, [entry("me.thing", "9.0.0")])],
      [REG],
    );
    expect(out.size).toBe(0);
  });

  it("never reports a tombstoned builtin", () => {
    const out = outdatedExtensions(
      [ext("perch.ports", "1.0.0", { builtin: true, uninstalled: true, enabled: false })],
      [source(REG, [entry("perch.ports", "2.0.0")])],
      [REG],
    );
    expect(out.size).toBe(0);
  });

  it("reports a disabled extension, which updates without needing a reload", () => {
    const out = outdatedExtensions(
      [ext("me.thing", "1.0.0", { enabled: false })],
      [source(REG, [entry("me.thing", "1.1.0")])],
      [REG],
    );
    expect(out.get("me.thing")?.version).toBe("1.1.0");
  });

  it("ignores a catalog entry for an extension that is not installed", () => {
    const out = outdatedExtensions([ext("me.thing", "1.0.0")], [source(REG, [entry("me.other", "5.0.0")])], [REG]);
    expect(out.size).toBe(0);
  });
});
