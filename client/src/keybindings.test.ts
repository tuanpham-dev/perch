import { describe, expect, it } from "vitest";
import {
  bindingMatches,
  COMMANDS,
  findMatchingBinding,
  migrateKeybindingOverrides,
  pickCommand,
  resolveBindings,
  type BindingMatch,
  type Command,
} from "./keybindings";

function ctx(values: Record<string, unknown> = {}) {
  return (key: string) => values[key];
}

describe("migrateKeybindingOverrides", () => {
  it("converts the user's real pre-multi-binding overrides losslessly", () => {
    // Exact shape captured from ~/.config/perch/settings.json before
    // multi-binding/when-clause support shipped.
    const raw = {
      "window.new": "ctrl+alt+Slash",
      "terminal.clear": "ctrl+alt+KeyL",
      "terminal.scrollToBottom": "ctrl+alt+KeyJ",
      "panel.toggle": "alt+Escape",
    };
    expect(migrateKeybindingOverrides(raw)).toEqual({
      "window.new": [{ key: "ctrl+alt+Slash" }],
      "terminal.clear": [{ key: "ctrl+alt+KeyL" }],
      "terminal.scrollToBottom": [{ key: "ctrl+alt+KeyJ" }],
      "panel.toggle": [{ key: "alt+Escape" }],
    });
  });

  it("converts an empty-string override (explicitly unbound) to an empty array", () => {
    expect(migrateKeybindingOverrides({ "tab.closeOthers": "" })).toEqual({ "tab.closeOthers": [] });
  });

  it("passes through overrides already in the new array shape", () => {
    const raw = { "tab.close": [{ key: "ctrl+KeyW" }, { key: "ctrl+alt+KeyW", when: "terminalFocus" }] };
    expect(migrateKeybindingOverrides(raw)).toEqual(raw);
  });

  it("drops malformed entries and non-object input", () => {
    expect(migrateKeybindingOverrides({ good: "ctrl+KeyA", bad: 42, alsoBad: [{ noKeyField: true }] })).toEqual({
      good: [{ key: "ctrl+KeyA" }],
    });
    expect(migrateKeybindingOverrides(null)).toEqual({});
    expect(migrateKeybindingOverrides([1, 2, 3])).toEqual({});
    expect(migrateKeybindingOverrides("not an object")).toEqual({});
  });
});

describe("resolveBindings", () => {
  it("falls back to a command's defaultBindings when there is no override", () => {
    const resolved = resolveBindings({});
    expect(resolved["sidebar.toggle"]).toEqual([{ key: "ctrl+shift+KeyB" }]);
  });

  it("an override fully replaces the default binding set", () => {
    const resolved = resolveBindings({ "sidebar.toggle": [{ key: "ctrl+alt+KeyB" }] });
    expect(resolved["sidebar.toggle"]).toEqual([{ key: "ctrl+alt+KeyB" }]);
  });

  it("an empty-array override means explicitly unbound", () => {
    const resolved = resolveBindings({ "settings.open": [] });
    expect(resolved["settings.open"]).toEqual([]);
  });

  it("merges in extension-contributed commands", () => {
    const ext: Command = {
      id: "ext.demo.run",
      label: "Demo: Run",
      defaultBindings: [{ key: "ctrl+alt+KeyD" }],
      scope: "global",
    };
    const resolved = resolveBindings({}, [ext]);
    expect(resolved["ext.demo.run"]).toEqual([{ key: "ctrl+alt+KeyD" }]);
  });

  it("resolves every built-in command id", () => {
    const resolved = resolveBindings({});
    for (const cmd of COMMANDS) {
      expect(resolved[cmd.id]).toEqual(cmd.defaultBindings);
    }
  });
});

describe("findMatchingBinding / bindingMatches", () => {
  it("matches a bare binding regardless of context", () => {
    const bindings = [{ key: "ctrl+KeyW" }];
    expect(bindingMatches(bindings, "ctrl+KeyW", ctx())).toBe(true);
    expect(bindingMatches(bindings, "ctrl+KeyQ", ctx())).toBe(false);
  });

  it("only matches a when-guarded binding when the condition passes", () => {
    const bindings = [{ key: "ctrl+KeyW", when: "terminalFocus" }];
    expect(bindingMatches(bindings, "ctrl+KeyW", ctx({ terminalFocus: true }))).toBe(true);
    expect(bindingMatches(bindings, "ctrl+KeyW", ctx({ terminalFocus: false }))).toBe(false);
  });

  it("returns the specific matching binding, not just a boolean", () => {
    const bindings = [
      { key: "ctrl+KeyW", when: "terminalFocus" },
      { key: "ctrl+KeyW" },
    ];
    const match = findMatchingBinding(bindings, "ctrl+KeyW", ctx({ terminalFocus: false }));
    expect(match).toEqual({ key: "ctrl+KeyW" });
  });

  it("handles an undefined binding list", () => {
    expect(bindingMatches(undefined, "ctrl+KeyW", ctx())).toBe(false);
  });
});

describe("pickCommand", () => {
  it("returns null for no candidates", () => {
    expect(pickCommand([])).toBeNull();
  });

  it("prefers a user-overridden command over a still-default one", () => {
    const candidates: BindingMatch[] = [
      { commandId: "a", binding: { key: "ctrl+KeyW" }, overridden: false },
      { commandId: "b", binding: { key: "ctrl+KeyW" }, overridden: true },
    ];
    expect(pickCommand(candidates)).toBe("b");
  });

  it("within the same overridden tier, prefers a binding with a when clause", () => {
    const candidates: BindingMatch[] = [
      { commandId: "a", binding: { key: "ctrl+KeyW" }, overridden: false },
      { commandId: "b", binding: { key: "ctrl+KeyW", when: "terminalFocus" }, overridden: false },
    ];
    expect(pickCommand(candidates)).toBe("b");
  });

  it("falls back to candidate order when overridden and when-ness are equal", () => {
    const candidates: BindingMatch[] = [
      { commandId: "a", binding: { key: "ctrl+KeyW" }, overridden: false },
      { commandId: "b", binding: { key: "ctrl+KeyW" }, overridden: false },
    ];
    expect(pickCommand(candidates)).toBe("a");
  });

  it("overridden status dominates even when the default-tier candidate has a when clause", () => {
    const candidates: BindingMatch[] = [
      { commandId: "a", binding: { key: "ctrl+KeyW", when: "terminalFocus" }, overridden: false },
      { commandId: "b", binding: { key: "ctrl+KeyW" }, overridden: true },
    ];
    expect(pickCommand(candidates)).toBe("b");
  });
});

describe("COMMANDS", () => {
  it("has no duplicate ids", () => {
    const ids = COMMANDS.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("scopes every projects.* command to projects and gates it on projectsListFocus", () => {
    const projectsCommands = COMMANDS.filter((c) => c.id.startsWith("projects."));
    expect(projectsCommands.length).toBe(4);
    for (const cmd of projectsCommands) {
      expect(cmd.scope).toBe("projects");
      for (const binding of cmd.defaultBindings) expect(binding.when).toBe("projectsListFocus");
    }
  });

  it("defaults projects.kill to Delete and projects.rename to F2, mirroring files.*", () => {
    expect(COMMANDS.find((c) => c.id === "projects.kill")?.defaultBindings).toEqual([
      { key: "Delete", when: "projectsListFocus" },
    ]);
    expect(COMMANDS.find((c) => c.id === "projects.rename")?.defaultBindings).toEqual([
      { key: "F2", when: "projectsListFocus" },
    ]);
  });

  it("registers sidebar.focusProjects as an unbound global command", () => {
    const cmd = COMMANDS.find((c) => c.id === "sidebar.focusProjects");
    expect(cmd?.scope).toBe("global");
    expect(cmd?.defaultBindings).toEqual([]);
  });

  it("remaps the sunset sessions-pane override ids and their when clauses", () => {
    const migrated = migrateKeybindingOverrides({
      "sessions.kill": [{ key: "Backspace", when: "sessionsListFocus" }],
      "sidebar.focusSessions": "ctrl+shift+KeyS",
    });
    expect(migrated).toEqual({
      "projects.kill": [{ key: "Backspace", when: "projectsListFocus" }],
      "sidebar.focusProjects": [{ key: "ctrl+shift+KeyS" }],
    });
  });
});
