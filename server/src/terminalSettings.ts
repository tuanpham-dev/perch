// The Terminal settings that belong to the terminal engine rather than the
// browser (shell, saving history, restoring sessions), handed to it at startup
// and whenever the settings document is saved.
import { getMultiplexer } from "./multiplexer.js";
import { readSettingsDoc } from "./settingsStore.js";

let last = "";

export async function applyTerminalSettings(): Promise<void> {
  const settings = ((await readSettingsDoc()).settings ?? {}) as Record<string, unknown>;
  const next = {
    shell: typeof settings.terminalShell === "string" ? settings.terminalShell : "",
    saveScrollback: settings.saveScrollback !== false,
    restoreOnStart: settings.restoreSessionsOnStart !== false,
  };
  // The client saves the whole document on every change; only an actual
  // change to these three is worth touching the engine for.
  const key = JSON.stringify(next);
  if (key === last) return;
  await getMultiplexer().configure(next);
  last = key;
}
