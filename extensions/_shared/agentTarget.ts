// Finds windows running an agent under a repo path, and sends text into
// one — the shared "hand this to the project's agent pane" primitive behind
// the worktrees agent launcher, git-scm's diff comments, and live-preview's
// element picker. Structural copies of the TerminalSession/TerminalWindow shape the
// host already fetches via /api/sessions — see extensions/_shared's module
// comment on why this is a copy, not a shared runtime import. The github
// extension (in the separate perch-extensions registry repo) vendors
// its own copy of this file for the same reason.

export interface TerminalWindow {
  index: number;
  name: string;
  command: string;
}

export interface TerminalSession {
  name: string;
  path: string;
  windows: TerminalWindow[];
}

export interface AgentWindow {
  sessionName: string;
  windowIndex: number;
  windowName: string;
  command: string;
}

const WINDOW_TAB_PREFIX = "perch-view-";

// Anything carrying the foreground command the terminal reports for an agent —
// satisfied structurally by a core registry entry (GET /api/agents) and by
// the deprecated per-extension CSV, so agentWindows never has to know which
// it was handed. An entry with an empty program is launch-preset only and
// matches nothing, which is why the filter below drops it rather than
// matching every window whose command happens to be "".
export interface AgentTargetProgram {
  program: string;
}

// A core registry entry as GET /api/agents returns it. `program` is the
// foreground command the terminal reports (detection), `command` the full launch
// line (presets) — see server/src/agents.ts.
export interface AgentRegistryEntry extends AgentTargetProgram {
  id: string;
  label: string;
  command: string;
  // Appended to `command` for this agent's no-prompts mode. Empty means it
  // has none, so a caller offering the choice hides it rather than showing a
  // checkbox that would do nothing.
  skipPermissionsArgs: string;
}

function matchesProgram(command: string, agents: readonly AgentTargetProgram[]): boolean {
  return agents.some((agent) => agent.program !== "" && agent.program === command);
}

// The core agent registry: the one list of "what is an AI agent", edited in
// Settings → AI Providers and shared by every extension that needs to find an
// agent pane (plans/agent-platform-core.md). A plain same-origin fetch of a
// public core route, like fetchSessions below.
export interface AgentRegistry {
  agents: AgentRegistryEntry[];
  // The app's one Yolo/Manual choice (Settings → AI Providers). Carried with
  // the list so no caller has to ask the user again - see resolveAgentPresets.
  skipPermissions: boolean;
}

export function fetchAgents(): Promise<AgentRegistry> {
  return fetch("/api/agents").then((res) => {
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    return res.json().then((body: { agents?: AgentRegistryEntry[]; skipPermissions?: boolean }) => ({
      agents: body.agents ?? [],
      skipPermissions: body.skipPermissions === true,
    }));
  });
}

// What to match panes against: the core registry, and nothing else. A core
// without /api/agents makes this reject, and that is the intended answer -
// there is no older shape to fall back to any more.
//
// There used to be two fallbacks ahead of that rejection: each extension's
// own agentPrograms setting, and a hard-coded pre-registry floor. Both are
// gone, so the registry is the only place an agent is named.
export async function resolveAgentTargets(): Promise<AgentTargetProgram[]> {
  return (await fetchAgents()).agents;
}

// repoPath and session.path are both `~`-shortened server display paths (the
// same convention core hands the client) — string comparison is enough since
// both sides come from the same source, never mixed with a raw absolute path.
function isUnderRepo(sessionPath: string, repoPath: string): boolean {
  if (!sessionPath || !repoPath) return false;
  if (sessionPath === repoPath) return true;
  const prefix = repoPath.endsWith("/") ? repoPath : `${repoPath}/`;
  return sessionPath.startsWith(prefix);
}

// One agent as a LAUNCH preset: what to call it in a picker, and the command
// line that starts it. The other half of a registry entry from the detection
// half above, and the shape the "Start work" flows want.
export interface AgentLaunchPreset {
  name: string;
  command: string;
  // See AgentRegistryEntry. Carried through so a caller can offer "start it
  // without permission prompts" as a checkbox beside the preset rather than
  // as a second preset - which is what this used to be.
  skipPermissionsArgs: string;
}


// The presets to offer: the core registry's enabled entries that have a
// command. Rejects on a core without the registry, like resolveAgentTargets.
export async function resolveAgentPresets(): Promise<AgentLaunchPreset[]> {
  const registry = await fetchAgents();
  return registry.agents
    .filter((agent) => agent.command !== "")
    .map((agent) => {
      const skipArgs = agent.skipPermissionsArgs ?? "";
      return {
        name: agent.label || agent.command,
        // The Yolo/Manual choice is already applied. A caller launches
        // `command` as given and never decides this for itself.
        command: registry.skipPermissions && skipArgs ? `${agent.command} ${skipArgs}` : agent.command,
        skipPermissionsArgs: skipArgs,
      };
    });
}

// Every window, across every session rooted at or under repoPath, whose
// foreground command matches one of the agents' `program` —
// synthetic perch-view-* sessions are skipped since they mirror a real
// session's windows and would otherwise double-list every match. Callers
// fetch /api/sessions and the agent list themselves (providers must be
// sync-from-cache; this stays a plain function over whatever lists they
// already have — see resolveAgentTargets).
export function agentWindows(
  sessions: TerminalSession[],
  repoPath: string,
  agents: readonly AgentTargetProgram[],
): AgentWindow[] {
  const out: AgentWindow[] = [];
  for (const session of sessions) {
    if (session.name.startsWith(WINDOW_TAB_PREFIX)) continue;
    if (!isUnderRepo(session.path, repoPath)) continue;
    for (const window of session.windows) {
      if (matchesProgram(window.command, agents)) {
        out.push({
          sessionName: session.name,
          windowIndex: window.index,
          windowName: window.name,
          command: window.command,
        });
      }
    }
  }
  return out;
}

// Fetches the live session list from core's public /api/sessions route (a
// plain same-origin fetch — no server hook of this extension's own is
// involved, per docs/EXTENSION_API.md's ctx.serverFetch section).
export function fetchSessions(): Promise<TerminalSession[]> {
  return fetch("/api/sessions").then((res) => {
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    return res.json();
  });
}

export interface SendToAgentOptions {
  // Retries a 404 (session not created yet) at a fixed interval — the
  // agent-launcher's race with a freshly created session. Not applied to any
  // other error status.
  retries?: number;
  retryDelayMs?: number;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// POSTs to the core send-text route (docs/EXTENSION_API.md: a public core
// route, fine to hit with a plain fetch). Throws with the server's error
// message on failure. windowIndex targets a specific window within the
// session — omitting it targets the session's own "current" (last-focused) window
// for that session, not necessarily the one the caller resolved via
// agentWindows() (a repo session can have several windows, only one of
// them running the agent). Every AgentWindow agentWindows() returns already
// carries its own windowIndex; pass it through rather than dropping it.
export async function sendToAgent(
  sessionName: string,
  text: string,
  submit: boolean,
  opts?: SendToAgentOptions & { windowIndex?: number },
): Promise<void> {
  const retries = opts?.retries ?? 0;
  const retryDelayMs = opts?.retryDelayMs ?? 0;
  let attempt = 0;
  for (;;) {
    const res = await fetch(`/api/sessions/${encodeURIComponent(sessionName)}/send-text`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text, submit, windowIndex: opts?.windowIndex }),
    });
    if (res.ok) return;
    if (res.status === 404 && attempt < retries) {
      attempt++;
      await sleep(retryDelayMs);
      continue;
    }
    let message = `${res.status} ${res.statusText}`;
    try {
      const body = await res.json();
      if (body?.error) message = body.error;
    } catch {
      // non-JSON error body; keep the status message
    }
    throw new Error(message);
  }
}
