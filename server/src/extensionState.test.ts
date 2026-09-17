import { describe, expect, it } from "vitest";
import { stateEnabled, stateSource } from "./extensions.js";

// The extension state file has held three shapes over time: a bare boolean,
// the "uninstalled" tombstone, and now an object carrying the registry source
// an install came from. Every reader goes through these two helpers, so an
// older state file has to keep working through them unchanged.
describe("stateEnabled", () => {
  it("reads the legacy bare forms", () => {
    expect(stateEnabled(true)).toBe(true);
    expect(stateEnabled(false)).toBe(false);
    expect(stateEnabled("uninstalled")).toBe("uninstalled");
  });

  it("reads the object form", () => {
    expect(stateEnabled({ enabled: true, source: "https://example.test/" })).toBe(true);
    expect(stateEnabled({ enabled: false, source: "https://example.test/" })).toBe(false);
    expect(stateEnabled({ enabled: "uninstalled" })).toBe("uninstalled");
  });

  // Distinct from `false`: nothing recorded means "on by default", which is
  // what lets a hand-dropped extension folder work without a state entry.
  it("reports an absent entry as undefined, not disabled", () => {
    expect(stateEnabled(undefined)).toBeUndefined();
  });
});

describe("stateSource", () => {
  it("is null for every shape that records none", () => {
    expect(stateSource(true)).toBeNull();
    expect(stateSource(false)).toBeNull();
    expect(stateSource("uninstalled")).toBeNull();
    expect(stateSource(undefined)).toBeNull();
    expect(stateSource({ enabled: true })).toBeNull();
  });

  it("returns a recorded source", () => {
    expect(stateSource({ enabled: true, source: "https://example.test/" })).toBe("https://example.test/");
    expect(stateSource({ enabled: "uninstalled", source: "/srv/catalog" })).toBe("/srv/catalog");
  });

  // An empty string is not a source anyone can install from, so it reads as
  // absent rather than being handed to a fetch.
  it("treats an empty source as absent", () => {
    expect(stateSource({ enabled: true, source: "" })).toBeNull();
  });
});
