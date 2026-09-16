// The agent-hook pipeline: one endpoint every AI agent's hooks report to,
// one normalizer, one subscriber table (plans/agent-platform-core.md).
//
// An agent hook used to be each extension's own business — its own pasted
// snippet, its own route, its own correlation scheme. Core owning it end to
// end buys three things no extension could do for itself:
//
//   One hook entry per event, not one per extension. Two extensions both
//   wanting "the turn ended" is one installed hook and one process per turn,
//   not two of each.
//
//   Auth that holds up. agent-monitor's hook curled its extension route with
//   no credentials at all — it worked only because a request with no Origin
//   passes the gate, and would have failed outright on an AUTH_TOKEN server.
//   The endpoint here follows the /api/command-events/report precedent
//   instead: auth-exempt by exact path, gated on loopback plus a custom
//   header it can only be reached with.
//
//   $PERCH_WINDOW as the correlation key. It is in every terminal's
//   environment, so the shim can capture it and core can resolve it to a
//   session. Every consumer used to correlate by the agent's own session id,
//   which only Claude Code sends — which is why nothing but Claude Code ever
//   worked.
//
// Events are transient here: core normalizes and fans out, and nothing is
// stored. Whether anything is remembered is each subscriber's business.
import { raw, type RequestHandler } from "express";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  agentHookShimPath,
  findAgent,
  HIGH_FREQUENCY_EVENTS,
  normalizeRawEvent,
  type AgentEvent,
} from "./agents.js";
import { readSettingsDoc } from "./settingsStore.js";
import { listAllWindowPids } from "./terminals.js";

// Derived from the one place the shim's location is defined (agents.ts owns
// that path because it is also core's signature inside an agent's config
// file), rather than rebuilding the same XDG lookup a second time.
const shimBinDir = path.dirname(agentHookShimPath);

// Everything the agent supplies travels as the request BODY (its own JSON,
// forwarded byte for byte) or as a header — never spliced into a command
// line or a URL.
//
// Always exits 0: a hook that fails is an agent that reports an error, and
// for a pre-tool event a non-zero exit can block the tool outright. Core
// missing an event must never be the agent's problem.
function shimScript(port: number): string {
  return `#!/bin/sh
# Written by Perch at startup — relays one AI agent hook event to the
# app (see server/src/agentHooks.ts). $1 is the agent's id in Settings ->
# AI Providers, $2 the agent's own name for the event, and the event JSON arrives
# on stdin. -m 2 mirrors the bell hook: a slow or dead server must never
# stall an agent mid-turn.
[ -n "$1" ] || exit 0
# A pane of the tmux backend has no PERCH_WINDOW; its id comes from tmux's.
[ -z "\${PERCH_WINDOW-}" ] && [ -n "\${TMUX_PANE-}" ] && PERCH_WINDOW="tmux-\${TMUX_PANE#%}"
curl -s -m 2 -X POST \\
  -H 'Content-Type: application/json' \\
  -H 'X-Perch-Hook: 1' \\
  -H "X-Perch-Agent: $1" \\
  -H "X-Perch-Event: $2" \\
  -H "X-Perch-Pane: $PERCH_WINDOW" \\
  --data-binary @- \\
  "http://127.0.0.1:${port}/api/agent-hooks/report" >/dev/null 2>&1
exit 0
`;
}

// The Windows form of the same relay: a Node script (no sh, no curl) behind a
// .cmd. Reads the event JSON from stdin, always exits 0.
export function windowsHookShim(port: number, node: string): { script: string; cmd: string } {
  return {
    script: `// Written by Perch at startup - relays one AI agent hook event to the app.
const [agent, event] = process.argv.slice(2);
if (!agent) process.exit(0);
const chunks = [];
process.stdin.on("data", (c) => chunks.push(c));
process.stdin.on("end", () => {
  fetch("http://127.0.0.1:${port}/api/agent-hooks/report", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Perch-Hook": "1",
      "X-Perch-Agent": agent,
      "X-Perch-Event": event ?? "",
      "X-Perch-Pane": process.env.PERCH_WINDOW ?? "",
    },
    body: Buffer.concat(chunks),
    signal: AbortSignal.timeout(2000),
  }).catch(() => {}).finally(() => process.exit(0));
});
`,
    cmd: `@echo off\r\n"${node}" "%~dp0agent-hook.mjs" %*\r\n`,
  };
}

// Best-effort at boot, like ensureOpenShim: a read-only config dir disables
// the feature (index.ts logs and carries on), it does not stop the server.
// Port-independent path with the port baked into the body, so several
// instances share it last-boot-wins — the same tradeoff the browser shim
// already accepts.
export async function ensureAgentHookShim(port: number): Promise<string> {
  await mkdir(shimBinDir, { recursive: true });
  if (process.platform === "win32") {
    const { script, cmd } = windowsHookShim(port, process.execPath);
    await writeFile(path.join(shimBinDir, "agent-hook.mjs"), script);
    await writeFile(agentHookShimPath, cmd);
    return agentHookShimPath;
  }
  await writeFile(agentHookShimPath, shimScript(port));
  await chmod(agentHookShimPath, 0o755);
  return agentHookShimPath;
}

// ---- Subscribers --------------------------------------------------------

// One normalized event, as a subscriber receives it.
export interface AgentHookEvent {
  // Core's own vocabulary, or null when this agent's raw event has no clean
  // mapping. Null is a real delivery, not a dropped one: the raw name is
  // right there, so a subscriber that knows better than core can act on it,
  // and core never has to guess (agy's PostInvocation is the live example —
  // it fires when the model's tool calls finish, which is neither tool-end
  // nor stop).
  event: AgentEvent | null;
  // What the agent called it. Always present.
  rawEvent: string;
  // The registry id of the agent whose hook fired.
  agent: string;
  // The window id ($PERCH_WINDOW) from the terminal's own environment:
  // the correlation key. Called paneId because extensions are built on the
  // name. Empty when the hook did not run in one of the app's terminals.
  paneId: string;
  // The session that window belongs to, or null when the window is gone or
  // was never ours. Resolved per event.
  sessionName: string | null;
  // The agent's own event JSON, verbatim, or null when it sent something
  // that was not JSON. Untrusted input from a process core does not control
  // — a subscriber must treat every field as unvalidated.
  payload: unknown;
  receivedAt: number;
}

export interface AgentHookSubscription {
  // Which normalized events to deliver. An event outside this list is not
  // delivered; an unmapped event (event: null) is delivered to a subscriber
  // that asked for anything at all, since core cannot know whose it is.
  events: readonly AgentEvent[];
  onEvent(event: AgentHookEvent): void;
}

// Keyed by extension id so unmountServerHook can drop exactly this
// extension's subscriptions — the module itself stays resident (ESM has no
// unload), so without this a disabled extension's callback would keep firing
// into dead code. The same accounting apiMutationListeners already does.
const subscribers = new Map<string, Set<AgentHookSubscription>>();

export function subscribeAgentHooks(extensionId: string, sub: AgentHookSubscription): () => void {
  let set = subscribers.get(extensionId);
  if (!set) {
    set = new Set();
    subscribers.set(extensionId, set);
  }
  set.add(sub);
  return () => set.delete(sub);
}

export function dropAgentHookSubscriptions(extensionId: string): void {
  subscribers.delete(extensionId);
}

// Every event some enabled subscriber asked for, minus the high-frequency
// ones while the user has not opted into them. This is what core installs —
// installing PreToolUse when nothing listens is pure overhead — and what
// Settings → AI Providers compares an installed hook against to call it stale.
//
// The filtering is deliberately visible rather than silent: a subscriber
// that asked for tool-start while the setting is off simply never receives
// it, and the Agents panel says so.
export async function subscribedEvents(): Promise<AgentEvent[]> {
  const wanted = new Set<AgentEvent>();
  for (const set of subscribers.values()) {
    for (const sub of set) {
      for (const event of sub.events) wanted.add(event);
    }
  }
  if (!(await highFrequencyEventsEnabled())) {
    for (const event of HIGH_FREQUENCY_EVENTS) wanted.delete(event);
  }
  return [...wanted];
}

// Which extension is subscribed to what, for the Agents panel — so "why did
// this hook turn stale" is answerable in the panel rather than by reasoning
// about which extensions are enabled.
export function subscriberSummary(): { extensionId: string; events: AgentEvent[] }[] {
  const out: { extensionId: string; events: AgentEvent[] }[] = [];
  for (const [extensionId, set] of subscribers) {
    const events = new Set<AgentEvent>();
    for (const sub of set) for (const event of sub.events) events.add(event);
    out.push({ extensionId, events: [...events] });
  }
  return out;
}

async function highFrequencyEventsEnabled(): Promise<boolean> {
  const doc = await readSettingsDoc();
  const settings = (doc.settings ?? {}) as Record<string, unknown>;
  return settings.agentHooksHighFrequencyEvents === true;
}

// ---- Report -------------------------------------------------------------

// A turn's worth of agent JSON is a few KB; the cap is what keeps a wedged
// or hostile local process from streaming into the server.
const MAX_HOOK_BODY_BYTES = 64 * 1024;

// The report body is the agent's own JSON, forwarded verbatim by the shim,
// and is taken raw for two reasons: a malformed payload should still be a
// delivered event (rawEvent plus the pane id is most of what a subscriber
// acts on) rather than a 400 from the body parser, and the cap above has to
// hold whatever content type the agent claims.
//
// Registered in index.ts AHEAD of the app-wide express.json(), the same way
// the proxy routes are: whichever parser runs first consumes the stream, so
// a raw parser mounted after it would find the body already gone.
export const agentHookBodyParser: RequestHandler = raw({
  type: () => true,
  limit: MAX_HOOK_BODY_BYTES,
});


export interface RawHookReport {
  agentId: string;
  rawEvent: string;
  paneId: string;
  // The request body, already size-capped by the route.
  body: string;
}

// Window ids are uuids (the daemon) or tmux-<n> (the tmux backend) — anything
// else did not come from one of our terminals, so it is dropped rather than
// carried as a correlation key that cannot resolve.
const PANE_ID = /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|tmux-\d+)$/;

export type ReportOutcome = "delivered" | "unknown-agent" | "no-subscribers";

// Normalize one report and fan it out. Returns what happened, which is what
// makes the endpoint debuggable from a plain curl: "unknown-agent" means the
// hook names an agent that is no longer in the registry (the hook outlived
// the entry), "no-subscribers" that nothing is listening yet.
export async function reportAgentHook(report: RawHookReport): Promise<ReportOutcome> {
  const agent = await findAgent(report.agentId);
  if (!agent) return "unknown-agent";
  // An agent whose hook flavour was cleared can still have a hook installed
  // from before — the raw name is delivered unnormalized rather than dropped.
  const normalized = agent.hooks ? normalizeRawEvent(agent.hooks, report.rawEvent) : null;

  let payload: unknown = null;
  if (report.body) {
    try {
      payload = JSON.parse(report.body);
    } catch {
      // Not JSON. The event still happened, and rawEvent plus paneId is
      // most of what a subscriber acts on.
    }
  }

  const paneId = PANE_ID.test(report.paneId) ? report.paneId : "";
  let sessionName: string | null = null;
  if (paneId) {
    try {
      const { byWindowId } = await listAllWindowPids();
      sessionName = byWindowId.get(paneId) ?? null;
    } catch {
      // The terminal engine went away mid-turn: the event is still worth
      // delivering with the pane id the subscriber can match on itself.
    }
  }

  const event: AgentHookEvent = {
    event: normalized,
    rawEvent: report.rawEvent,
    agent: agent.id,
    paneId,
    sessionName,
    payload,
    receivedAt: Date.now(),
  };

  const allowHighFrequency = await highFrequencyEventsEnabled();
  let delivered = 0;
  for (const set of subscribers.values()) {
    for (const sub of set) {
      // An unmapped event goes to every subscriber: core cannot tell which
      // of them would recognize it, and the alternative is dropping it.
      if (normalized !== null) {
        if (!sub.events.includes(normalized)) continue;
        if (!allowHighFrequency && HIGH_FREQUENCY_EVENTS.includes(normalized)) continue;
      }
      delivered++;
      try {
        sub.onEvent(event);
      } catch (err) {
        console.error("agent hook subscriber threw:", err);
      }
    }
  }
  return delivered > 0 ? "delivered" : "no-subscribers";
}
