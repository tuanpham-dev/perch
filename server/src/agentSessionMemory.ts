// Which conversation each agent window was running, kept on disk so a restart
// resumes that one ("claude --resume <id>") rather than whatever "--continue"
// finds newest in the folder - which, with two agents in one project, is the
// same conversation for both. Window ids survive a restore, so they are the
// key. Best effort throughout: a missing entry just means the old resume line.
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { agentsForAllSessions } from "./agentWindows.js";
import { sessionIdForAgentWindow, isSafeSessionId } from "./agentSessions.js";
import { configDir } from "./configDir.js";
import { listSessions } from "./terminals.js";

const FILE = path.join(configDir, "agent-sessions.json");
const POLL_MS = 5_000;

interface Entry {
  agentId: string;
  sessionId: string;
}

let memory: Map<string, Entry> | null = null;
let saving: Promise<void> = Promise.resolve();
let timer: NodeJS.Timeout | null = null;

async function load(): Promise<Map<string, Entry>> {
  if (memory) return memory;
  memory = new Map();
  try {
    const raw = JSON.parse(await readFile(FILE, "utf8")) as Record<string, Entry>;
    for (const [windowId, e] of Object.entries(raw)) {
      if (e && typeof e.agentId === "string" && isSafeSessionId(e.sessionId)) memory.set(windowId, e);
    }
  } catch {
    // none yet, or unreadable: start empty
  }
  return memory;
}

function save(map: Map<string, Entry>): void {
  const body = JSON.stringify(Object.fromEntries(map));
  saving = saving
    .then(async () => {
      await mkdir(configDir, { recursive: true });
      const tmp = `${FILE}.${process.pid}.tmp`;
      await writeFile(tmp, body);
      await rename(tmp, FILE);
    })
    .catch(() => {});
}

// The conversation a window was last seen running for this agent, if any.
export async function rememberedSession(windowId: string, agentId: string): Promise<string | null> {
  const e = (await load()).get(windowId);
  return e && e.agentId === agentId ? e.sessionId : null;
}

async function record(): Promise<void> {
  const map = await load();
  let changed = false;
  const live = new Set<string>();
  const sessions = await listSessions();
  for (const s of sessions) for (const w of s.windows) live.add(w.id);
  // Only prune once windows are listed: before the terminal engine is up the
  // list is empty, and that must not forget everything.
  if (live.size > 0) {
    for (const id of [...map.keys()]) {
      if (!live.has(id)) {
        map.delete(id);
        changed = true;
      }
    }
  }
  for (const w of await agentsForAllSessions()) {
    const sessionId = await sessionIdForAgentWindow(w);
    if (!sessionId) continue;
    const prev = map.get(w.windowId);
    if (prev?.agentId === w.agentId && prev.sessionId === sessionId) continue;
    map.set(w.windowId, { agentId: w.agentId, sessionId });
    changed = true;
  }
  if (changed) save(map);
}

export function startAgentSessionMemory(): void {
  if (timer) return;
  const tick = () => {
    record()
      .catch(() => {})
      .finally(() => {
        timer = setTimeout(tick, POLL_MS);
        timer.unref?.();
      });
  };
  timer = setTimeout(tick, POLL_MS);
  timer.unref?.();
}
