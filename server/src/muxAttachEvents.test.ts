import { describe, expect, it } from "vitest";
import { endsAttach } from "./mux.js";

describe("which daemon events end a terminal tab's attach", () => {
  it("ends when the session closes", () => {
    expect(endsAttach({ event: "session-closed", session: "app" })).toBe(true);
  });

  it("ends a pinned viewer whose own window is gone", () => {
    expect(endsAttach({ event: "window-closed", session: "app", index: -1 })).toBe(true);
  });

  it("keeps the session's other tabs open when one of its windows closes", () => {
    // Broadcast to every connection in the session, with the closed window's index.
    expect(endsAttach({ event: "window-closed", session: "app", index: 0 })).toBe(false);
    expect(endsAttach({ event: "window-closed", session: "app", index: 2 })).toBe(false);
  });

  it("ignores everything else", () => {
    expect(endsAttach({ event: "window-switch", session: "app", index: 1, name: "zsh" })).toBe(false);
  });
});
