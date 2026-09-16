// Which agent is running in a terminal window, and which process it is.
//
// Every extension that wants this has been working it out for itself: some
// compare a window's foreground command with each agent's `program`
// (extensions/_shared/agentTarget.ts and its vendored copies), which misses
// an agent started through a wrapper or running under a shell prompt; one
// walked /proc directly, which only works on Linux and only while terminals
// run in tmux. Core already holds both halves of the answer — the registry's
// programs and a portable process map (processes.ts: /proc, ps, CIM) — so it
// answers once, here, for everyone.
//
// Nothing here signals or writes: `agentPid` is for finding the files an
// agent keeps about itself.
import { resolveAgents } from "./agents.js";
import { buildProcessMap, findDescendants, type ProcInfo } from "./processes.js";
import { listSessionPanes, listSessions } from "./terminals.js";

export interface AgentWindow {
  agentId: string;
  label: string;
  // The registry `program` that matched.
  program: string;
  windowIndex: number;
  windowId: string;
  // The window's own process: its shell.
  windowPid: number;
  // The agent's process, or null when only the foreground name matched and
  // no process could be pinned down (a host with no readable process list).
  agentPid: number | null;
  cwd: string | null;
  matchedBy: "foreground" | "descendant";
  // The agent's own mark (see AgentSummary): a URL, with a codicon name to
  // fall back on.
  iconUrl: string;
  icon: string;
}

interface WindowFacts {
  windowIndex: number;
  windowId: string;
  pid: number;
  command: string;
  cwd: string | null;
}

interface AgentFacts {
  id: string;
  label: string;
  program: string;
  iconUrl?: string;
  icon?: string;
}

// One process map serves every window of a call, and calls that land within
// this window reuse it: a status-bar item polling every few seconds must not
// make the host enumerate its processes each time. Short enough that an
// agent started a moment ago is found on the next poll.
const PROCESS_MAP_TTL_MS = 2_000;
let processCache: { at: number; map: Promise<Map<number, ProcInfo>> } | null = null;

function processMap(): Promise<Map<number, ProcInfo>> {
  const now = Date.now();
  if (!processCache || now - processCache.at >= PROCESS_MAP_TTL_MS) {
    processCache = { at: now, map: buildProcessMap() };
  }
  return processCache.map;
}

// Exported for the tests: the whole decision, given the facts. A window
// matches on its foreground command first (the cheap, exact case), then on
// any descendant process named after an agent's program — which is what
// catches a wrapper script, or an agent left running under a shell prompt.
export function resolveAgentWindows(
  windows: readonly WindowFacts[],
  agents: readonly AgentFacts[],
  map: Map<number, ProcInfo>,
): AgentWindow[] {
  const matchable = agents.filter((a) => a.program !== "");
  if (matchable.length === 0) return [];
  const byProgram = new Map(matchable.map((a) => [a.program, a]));
  const out: AgentWindow[] = [];

  for (const window of windows) {
    const foreground = byProgram.get(window.command);
    if (foreground) {
      // The window's own pid is its shell; the agent named as the foreground
      // command is a process under it (or, on a host with no process list,
      // nothing we can point at).
      const pids = findDescendants(window.pid, map, (comm) => comm === foreground.program);
      out.push(entry(window, foreground, pids[0] ?? null, "foreground"));
      continue;
    }
    // Nothing recognisable in front: look for an agent anywhere below.
    const found = firstDescendantAgent(window.pid, map, byProgram);
    if (found) out.push(entry(window, found.agent, found.pid, "descendant"));
  }
  return out;
}

function entry(
  window: WindowFacts,
  agent: AgentFacts,
  agentPid: number | null,
  matchedBy: AgentWindow["matchedBy"],
): AgentWindow {
  return {
    agentId: agent.id,
    label: agent.label,
    program: agent.program,
    windowIndex: window.windowIndex,
    windowId: window.windowId,
    windowPid: window.pid,
    agentPid,
    cwd: window.cwd,
    matchedBy,
    iconUrl: agent.iconUrl ?? "",
    icon: agent.icon ?? "",
  };
}

// Breadth-first, so an agent that started another agent reports the outer
// one — the one the window is "running".
function firstDescendantAgent(
  rootPid: number,
  map: Map<number, ProcInfo>,
  byProgram: Map<string, AgentFacts>,
): { agent: AgentFacts; pid: number } | null {
  const matches = findDescendants(rootPid, map, (comm) => byProgram.has(comm));
  for (const pid of matches) {
    const agent = byProgram.get(map.get(pid)?.comm ?? "");
    if (agent) return { agent, pid };
  }
  return null;
}

async function enabledAgents(): Promise<AgentFacts[]> {
  const agents = await resolveAgents();
  return agents
    .filter((a) => a.enabled && a.program !== "")
    .map(({ id, label, program, iconUrl, icon }) => ({ id, label, program, iconUrl, icon }));
}

async function windowFacts(session: string): Promise<WindowFacts[]> {
  // Panes carry the pid and foreground command; the session listing carries
  // each window's cwd. Neither alone has both.
  const [panes, sessions] = await Promise.all([listSessionPanes(session), listSessions()]);
  const windows = sessions.find((s) => s.name === session)?.windows ?? [];
  const cwdByIndex = new Map(windows.map((w) => [w.index, w.cwd]));
  return panes.map((pane) => ({
    windowIndex: pane.windowIndex,
    windowId: pane.id,
    pid: pane.pid,
    command: pane.command,
    cwd: cwdByIndex.get(pane.windowIndex) ?? null,
  }));
}

// Every window of a session that is running an agent, in window order. A
// session that isn't there is simply no windows, not an error: a caller
// asking about a terminal that has just closed is ordinary.
export async function agentsForSession(session: string): Promise<AgentWindow[]> {
  let windows: WindowFacts[];
  try {
    windows = await windowFacts(session);
  } catch {
    return [];
  }
  if (windows.length === 0) return [];
  const [agents, map] = await Promise.all([enabledAgents(), processMap()]);
  return resolveAgentWindows(windows, agents, map);
}

export async function agentForWindow(session: string, windowIndex: number): Promise<AgentWindow | null> {
  const windows = await agentsForSession(session);
  return windows.find((w) => w.windowIndex === windowIndex) ?? null;
}
