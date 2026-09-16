// Picking AI agents back up after the terminals are restored. A restart
// brings every window back as a fresh shell; a window that was running an
// agent reports what it was running (MuxWindow.restoredCommands), and if that
// agent declares a resume command ("claude --continue") it's typed in, once,
// as soon as the shell's prompt has settled. Settings → Terminal → Resume
// agents turns it off.
import { listAgents, resumeCommand } from "./agents.js";
import { getMultiplexer, type MuxWindow } from "./multiplexer.js";
import { readSettingsDoc } from "./settingsStore.js";
import { sendTextToWindow } from "./terminals.js";

const SHELLS = new Set(["bash", "zsh", "fish", "sh", "dash", "ksh", "tcsh", "csh", "pwsh", "powershell"]);

// A prompt that is still drawing (rc files, a theme's first render) would eat
// the typed line; this long without output means it has settled.
const QUIET_MS = 800;
const PASS_MS = 1_000;
// A window whose shell never settles (something else took the foreground)
// is given up on after this many passes.
const MAX_PASSES = 60;

const passes = new Map<string, number>();
let timer: NodeJS.Timeout | null = null;
let running = false;

async function pass(): Promise<boolean> {
  const mux = getMultiplexer();
  const pending = (await mux.listSessions()).flatMap((s) => s.windows.filter((w) => w.restoredCommands));
  if (pending.length === 0) return false;

  const settings = ((await readSettingsDoc()).settings ?? {}) as Record<string, unknown>;
  const agents = settings.resumeAgentsOnRestore === false ? [] : await listAgents();

  for (const w of pending) {
    const done = () => {
      passes.delete(w.id);
      return mux.clearRestored(`@${w.id}`).catch(() => {});
    };
    const agent = agentFor(w, agents);
    // Nothing to resume, or the window re-runs its own declared command.
    if (!agent || w.declaredCommand) {
      await done();
      continue;
    }
    const count = (passes.get(w.id) ?? 0) + 1;
    passes.set(w.id, count);
    if (!shellSettled(w)) {
      if (count >= MAX_PASSES) await done();
      continue;
    }
    const line = await resumeCommand(agent.id);
    // Acknowledged before typing: a failure after this point leaves a window
    // without its agent, never one with the line typed twice.
    await done();
    // Ctrl+U first clears anything already on the prompt, so stray input
    // can't turn the command into something else. PowerShell has no such
    // binding by default, so Windows types the line as it is.
    const clear = process.platform === "win32" ? "" : "\x15";
    if (line) await sendTextToWindow(w.id, `${clear}${line}`, true).catch(() => {});
  }
  return true;
}

function agentFor(w: MuxWindow, agents: Awaited<ReturnType<typeof listAgents>>) {
  const ran = new Set(w.restoredCommands ?? []);
  return agents.find((a) => a.program && a.resume && ran.has(a.program)) ?? null;
}

function shellSettled(w: MuxWindow): boolean {
  return SHELLS.has(w.command.replace(/^-/, "")) && Date.now() - w.lastOutputAt >= QUIET_MS;
}

// Runs passes until no restored window is left to deal with. Safe to call
// whenever something may have changed (startup, a sessions-changed event).
export function resumeRestoredAgents(): void {
  if (timer || running) return;
  const tick = async () => {
    timer = null;
    running = true;
    let again = false;
    try {
      again = await pass();
    } catch {
      again = true;
    } finally {
      running = false;
    }
    if (again) {
      timer = setTimeout(() => void tick(), PASS_MS);
      timer.unref?.();
    }
  };
  timer = setTimeout(() => void tick(), 0);
  timer.unref?.();
}
