// Past agent conversations, for the session browser: which conversations ran
// in a folder, what was said in one, and the line that reopens it.
//
// An agent gets a reader the same two ways it gets hooks. Declared: its
// manifest's `sessions` names one of the formats in agentSessionFormats/,
// which core reads itself. Provided: an extension's server hook registers a
// reader for an agent it contributed (host.agentSessions.provideReader), for
// a format core doesn't know; a provided reader wins over a declared one.
// Either way the reader is fenced: a call that throws, takes longer than
// READER_TIMEOUT_MS or answers malformed data is logged and that agent's
// conversations are left out, without failing anyone else's.
//
// Everything here reads; nothing writes to an agent's files.
import os from "node:os";
import path from "node:path";
import { agentsForSession, type AgentWindow } from "./agentWindows.js";
import { resolveAgents, withPermissions, type AgentPreset, type AgentSessionsDescriptor } from "./agents.js";
import { createClaudeReader } from "./agentSessionFormats/claudeJsonl.js";
import { createCodexReader } from "./agentSessionFormats/codexRollout.js";
import type { SessionMessage, SessionReader, SessionSummary } from "./agentSessionFormats/types.js";
import { listSessions } from "./terminals.js";

export type { SessionMessage, SessionReader, SessionSummary };

export const READER_TIMEOUT_MS = 5_000;
let readerTimeoutMs = READER_TIMEOUT_MS;

// For tests: a shorter fence, so a hanging reader doesn't hold a test up.
export function setReaderTimeout(ms: number): void {
  readerTimeoutMs = ms;
}
const MAX_SESSIONS_PER_AGENT = 2_000;
const MAX_MESSAGES = 500;

// A session id goes into a command line typed into a shell, so it is held to
// the characters real ids use (uuids, Codex's session names) before it gets
// anywhere near one.
const SAFE_SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export function isSafeSessionId(id: unknown): id is string {
  return typeof id === "string" && SAFE_SESSION_ID.test(id);
}

// ---- Readers ----

const provided = new Map<string, SessionReader>();

// Registered under the full agent id (`<extensionId>.<agentId>`).
export function registerSessionReader(fullAgentId: string, reader: SessionReader): void {
  provided.set(fullAgentId, reader);
}

export function dropSessionReaders(extensionId: string): void {
  for (const id of [...provided.keys()]) {
    if (id.startsWith(`${extensionId}.`)) provided.delete(id);
  }
}

// One instance per format and folder, so each keeps its file cache.
const builtIn = new Map<string, SessionReader>();

function builtInReader(descriptor: AgentSessionsDescriptor): SessionReader {
  const key = `${descriptor.format}\u0000${descriptor.dir ?? ""}`;
  let reader = builtIn.get(key);
  if (!reader) {
    const dir = descriptor.dir ?? undefined;
    reader = descriptor.format === "claude-jsonl" ? createClaudeReader(dir) : createCodexReader(dir);
    builtIn.set(key, reader);
  }
  return reader;
}

function readerFor(agent: AgentPreset): SessionReader | null {
  return provided.get(agent.id) ?? (agent.sessions ? builtInReader(agent.sessions) : null);
}

// For tests: forget provided readers and built-in caches.
export function resetSessionReaders(): void {
  provided.clear();
  builtIn.clear();
}

function withTimeout<T>(work: Promise<T>, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} took longer than ${readerTimeoutMs / 1000}s`)), readerTimeoutMs);
  });
  return Promise.race([work, timeout]).finally(() => clearTimeout(timer));
}

function cleanSummary(raw: unknown): SessionSummary | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (!isSafeSessionId(r.id) || typeof r.cwd !== "string") return null;
  return {
    id: r.id,
    cwd: r.cwd,
    title: typeof r.title === "string" && r.title.trim() ? r.title.slice(0, 200) : "Untitled conversation",
    lastActiveAt: typeof r.lastActiveAt === "number" && Number.isFinite(r.lastActiveAt) ? r.lastActiveAt : 0,
    messageCount: typeof r.messageCount === "number" && Number.isFinite(r.messageCount) ? Math.max(0, Math.round(r.messageCount)) : 0,
  };
}

function cleanMessage(raw: unknown): SessionMessage | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (r.role !== "user" && r.role !== "assistant" && r.role !== "tool") return null;
  if (typeof r.text !== "string") return null;
  return { role: r.role, text: r.text.slice(0, 20_000) };
}

// ---- Queries ----

export interface ListedSession extends SessionSummary {
  agentId: string;
  agentLabel: string;
  iconUrl: string;
  icon: string;
  // False when the agent declares no resumeSession line.
  canResume: boolean;
  // Set when the conversation is open in a terminal window right now.
  openIn: { sessionName: string; windowIndex: number; windowId: string } | null;
}

function expandHome(p: string): string {
  if (p === "~") return os.homedir();
  if (p.startsWith("~/") || p.startsWith("~\\")) return path.join(os.homedir(), p.slice(2));
  return p;
}

async function enabledAgents(): Promise<AgentPreset[]> {
  return (await resolveAgents()).filter((a) => a.enabled);
}

// session id -> the window running it, per agent, from each agent window's
// process. Best effort: a reader with no sessionForProcess, or a process it
// can't place, just leaves that conversation unmarked.
async function openSessions(agents: AgentPreset[]): Promise<Map<string, ListedSession["openIn"]>> {
  const open = new Map<string, ListedSession["openIn"]>();
  let windows: { sessionName: string; w: AgentWindow }[] = [];
  try {
    const sessions = (await listSessions()).filter((s) => !s.name.startsWith("perch-view-"));
    const perSession = await Promise.all(
      sessions.map(async (s) => (await agentsForSession(s.name).catch(() => [])).map((w) => ({ sessionName: s.name, w }))),
    );
    windows = perSession.flat();
  } catch {
    return open;
  }
  await Promise.all(
    windows.map(async ({ sessionName, w }) => {
      const agent = agents.find((a) => a.id === w.agentId);
      const reader = agent ? readerFor(agent) : null;
      if (!reader?.sessionForProcess || w.agentPid === null) return;
      try {
        const id = await withTimeout(reader.sessionForProcess(w.agentPid), "sessionForProcess");
        if (isSafeSessionId(id)) open.set(`${w.agentId}\u0000${id}`, { sessionName, windowIndex: w.windowIndex, windowId: w.windowId });
      } catch {
        // unplaceable: left unmarked
      }
    }),
  );
  return open;
}

// Every conversation that ran in `cwd`, across every enabled agent with a
// reader, newest first.
export async function listAgentSessions(cwd: string): Promise<ListedSession[]> {
  const folder = path.resolve(expandHome(cwd));
  const agents = await enabledAgents();
  const [perAgent, open] = await Promise.all([
    Promise.all(
      agents.map(async (agent) => {
        const reader = readerFor(agent);
        if (!reader) return [];
        try {
          const raw = await withTimeout(Promise.resolve(reader.list(folder)), `${agent.id} session list`);
          if (!Array.isArray(raw)) throw new Error("didn't return a list");
          return raw
            .slice(0, MAX_SESSIONS_PER_AGENT)
            .map(cleanSummary)
            .filter((s): s is SessionSummary => s !== null)
            .map((s) => ({ agent, s }));
        } catch (err) {
          console.warn(`agent sessions: skipping ${agent.id}: ${err instanceof Error ? err.message : String(err)}`);
          return [];
        }
      }),
    ),
    openSessions(agents),
  ]);
  return perAgent
    .flat()
    .map(({ agent, s }) => ({
      ...s,
      agentId: agent.id,
      agentLabel: agent.label,
      iconUrl: agent.iconUrl,
      icon: agent.icon,
      canResume: Boolean(agent.resumeSession),
      openIn: open.get(`${agent.id}\u0000${s.id}`) ?? null,
    }))
    .sort((a, b) => b.lastActiveAt - a.lastActiveAt);
}

// The last `limit` messages of one conversation, oldest first.
export async function agentSessionMessages(agentId: string, id: string, cwd: string, limit = 50): Promise<SessionMessage[]> {
  if (!isSafeSessionId(id)) return [];
  const agent = (await enabledAgents()).find((a) => a.id === agentId);
  const reader = agent ? readerFor(agent) : null;
  if (!reader) return [];
  const capped = Math.max(1, Math.min(MAX_MESSAGES, Math.round(limit)));
  try {
    const raw = await withTimeout(Promise.resolve(reader.messages(id, path.resolve(expandHome(cwd)), capped)), `${agentId} messages`);
    if (!Array.isArray(raw)) return [];
    return raw.map(cleanMessage).filter((m): m is SessionMessage => m !== null).slice(-capped);
  } catch (err) {
    console.warn(`agent sessions: ${agentId} messages failed: ${err instanceof Error ? err.message : String(err)}`);
    return [];
  }
}

// The line that reopens one conversation: the agent's resumeSession with the
// id filled in, plus its skip-permissions flag under Yolo. Null for an unknown
// or disabled agent, one with no resumeSession, or an id that isn't safe to
// put on a command line.
export async function resumeSessionCommand(agentId: string, id: string): Promise<string | null> {
  if (!isSafeSessionId(id)) return null;
  const agent = (await enabledAgents()).find((a) => a.id === agentId);
  if (!agent?.resumeSession) return null;
  return withPermissions(agent, agent.resumeSession.replaceAll("{id}", id));
}
