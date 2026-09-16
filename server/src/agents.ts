// The app's one agent registry. "What is an AI agent" used to be answered in
// seven places at once — four comma-separated detection settings
// (agentMonitor.programs, gitScm.agentPrograms, livePreview.agentPrograms,
// ports.agentPrograms) and three launch-preset lists (github.agents,
// jira.agents, agentTasks.agents) — so the same CLI had to be named again in
// every extension that cared (plans/agent-platform-core.md).
//
// One entry answers all of it, because the three facts always travel
// together:
//   program   what the terminal reports as the window's foreground command, which is
//             how "which window is the agent in" is decided (detection).
//   command   the full launch line, which is what a "Start work" preset
//             types into a fresh session (launch).
//   hooks     which hook schema the CLI speaks, which is what lets core
//             generate and install its own hook for it (agentHooks.ts).
//
// A sibling of an existing core concept rather than a new one: ai.ts already
// names claude / codex / agy as AI providers, and reads its own list out of
// the settings document exactly the same way.
import { chmod, copyFile, mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { isOnPath } from "./which.js";
import { readSettingsDoc } from "./settingsStore.js";
import { configDir } from "./configDir.js";

// How one agent's CLI wants its hooks written, as data rather than as code.
// Core used to carry three hard-coded flavours (claude / codex / agy); it now
// carries none, and an extension declares this in its manifest instead
// (plans/agents-from-extensions.md). null means "this agent has no hooks core
// can install" (a wrapper script, a CLI that has none), which is a first-class
// state — such an entry is still a perfectly good detection and launch preset.
//
// Three known CLIs shaped these fields, and between them they cover both
// layouts anyone writes:
//
//   Claude   ~/.claude/settings.json, merged into a top-level "hooks" key,
//            each event holding entries of {matcher?, hooks:[handler]}.
//   Codex    ~/.codex/hooks.json, the same nested shape but core owns the
//            whole file, plus a required top-level "description".
//   flat     a named wrapper whose event value is a FLAT handler array with
//            no inner "hooks" — what Antigravity's CLI actually accepts.
export interface AgentHookDescriptor {
  // Absolute path to the config file. Declared with "~" and expanded here;
  // a path that escapes $HOME is refused, because core writing outside the
  // user's own home is never what an agent manifest legitimately wants.
  file: string;
  // "merged" — the file holds other things and core only adds its own part.
  // "whole-file" — the file is core's, so replacing it discards whatever was
  // there and the UI has to say so.
  ownership: "merged" | "whole-file";
  // Where the event map lives in the document: under a top-level key
  // ("hooks"), or inside a named wrapper object that carries its own extra
  // fields (Antigravity's {enabled:true, <Event>:[…]}).
  container:
    | { kind: "key"; key: string }
    | { kind: "wrapper"; name: string; extra: Record<string, unknown> };
  // The shape of one event's value. "nested" — a list of entries, each with
  // its own "hooks" array of handlers. "flat" — a list of handlers directly.
  entry: "nested" | "flat";
  // Raw event names that take matcher:"*". Only Claude's tool events do.
  matcherEvents: readonly string[];
  // Extra top-level fields the CLI's parser requires (Codex's description).
  extraFields: Readonly<Record<string, unknown>>;
  // A second file this agent's CLI needs written alongside its hooks, or null.
  // Core does not know what goes in it: the extension that declared the agent
  // registers a function (host.agentHooks.provideCompanion) that transforms
  // the file's current text, and core does the reading and the writing under
  // the same backup and temp-then-rename rules as the hook file itself.
  //
  // Codex is why this exists: it silently refuses to run any hook whose
  // handler is not trusted in ~/.codex/config.toml, so hooks.json alone is
  // inert. Constrained to the hook file's own directory - an extension does
  // not get to name an arbitrary path in $HOME for core to write.
  companion: string | null;
  // normalized event -> the raw name this CLI uses. An event missing here is
  // one the CLI does not deliver, so core never installs it and never claims
  // it can. Read backwards by the normalizer, so a raw name absent from the
  // map arrives with `event: null` rather than guessed at.
  events: Readonly<Partial<Record<AgentEvent, string>>>;
}

// How to run this agent's CLI for ONE prompt and one answer - the shape the
// shared AI backend (ai.ts) needs, which is a different thing from launching
// the agent into a pane. `command` starts an interactive session; this runs
// non-interactively and prints a reply.
//
// Core used to carry a table of these keyed by CLI name (`claude -p`,
// `codex exec`, `agy -p`), which is exactly the sort of per-agent knowledge
// that stopped being core's business - so the agent declares it and core only
// substitutes and executes.
export interface AgentOneShot {
  // argv template. "{prompt}" is replaced by the prompt; "{modelArgs}" splices
  // in `modelArgs` below, or nothing at all when no model is set - which is
  // why it is a splice point rather than a placeholder inside a single token:
  // codex wants its model flag BEFORE the prompt, and a template with no
  // splice point could not say where.
  args: readonly string[];
  // Included only when the profile names a model. "{model}" is replaced by it.
  modelArgs: readonly string[];
  // Optional subcommand that prints this CLI's available models, one per
  // line. Absent means core falls back to scraping `--help`.
  listModelsArgs: readonly string[];
}

function readStringArray(source: Record<string, unknown>, key: string): string[] {
  const raw = source[key];
  return Array.isArray(raw) ? raw.filter((v): v is string => typeof v === "string") : [];
}

// A one-shot form out of a manifest, or null when it cannot run a prompt.
// `args` has to say where the prompt goes: without "{prompt}" the CLI would
// be invoked with no question in it.
export function parseOneShot(raw: unknown): AgentOneShot | null {
  if (!isRecordValue(raw)) return null;
  const args = readStringArray(raw, "args");
  if (!args.includes("{prompt}")) return null;
  return {
    args,
    modelArgs: readStringArray(raw, "modelArgs"),
    listModelsArgs: readStringArray(raw, "listModelsArgs"),
  };
}

// The argv to spawn, with the templates filled in. Substitution is
// positional and never shell-quoted: the prompt is its own argv entry, so
// nothing in it can be read as a flag or an operator.
export function oneShotArgs(spec: AgentOneShot, prompt: string, model: string): string[] {
  const out: string[] = [];
  for (const token of spec.args) {
    if (token === "{modelArgs}") {
      if (model) out.push(...spec.modelArgs.map((t) => t.replaceAll("{model}", model)));
      continue;
    }
    out.push(token.replaceAll("{prompt}", prompt));
  }
  return out;
}

function isRecordValue(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// Expands a leading "~" and refuses anything that lands outside $HOME. The
// descriptor comes from an extension manifest, and this is the one field in
// it that decides which file core writes.
function resolveHookFile(raw: string): string | null {
  const home = homedir();
  const expanded = raw === "~" ? home : raw.startsWith("~/") || raw.startsWith("~\\") ? path.join(home, raw.slice(2)) : raw;
  if (!path.isAbsolute(expanded)) return null;
  const resolved = path.resolve(expanded);
  if (resolved !== home && !resolved.startsWith(`${home}${path.sep}`)) return null;
  return resolved;
}

// One descriptor out of a manifest, or null when it is unusable. Everything
// optional has a default that matches the commonest shape (Claude's), so a
// minimal declaration is file + events.
export function parseHookDescriptor(raw: unknown): AgentHookDescriptor | null {
  if (!isRecordValue(raw)) return null;
  const file = typeof raw.file === "string" ? resolveHookFile(raw.file.trim()) : null;
  if (!file) return null;

  const events: Partial<Record<AgentEvent, string>> = {};
  if (isRecordValue(raw.events)) {
    for (const [event, name] of Object.entries(raw.events)) {
      if (!AGENT_EVENTS.includes(event as AgentEvent)) continue;
      if (typeof name !== "string" || !name.trim()) continue;
      events[event as AgentEvent] = name.trim();
    }
  }
  // An agent that can deliver nothing has no hooks to install, which is the
  // same as declaring none at all.
  if (Object.keys(events).length === 0) return null;

  let container: AgentHookDescriptor["container"] = { kind: "key", key: "hooks" };
  if (isRecordValue(raw.container)) {
    const wrapper = typeof raw.container.wrapper === "string" ? raw.container.wrapper.trim() : "";
    const key = typeof raw.container.key === "string" ? raw.container.key.trim() : "";
    if (wrapper) {
      container = {
        kind: "wrapper",
        name: wrapper,
        extra: isRecordValue(raw.container.extra) ? { ...raw.container.extra } : {},
      };
    } else if (key) {
      container = { kind: "key", key };
    }
  }

  let companion: string | null = null;
  if (typeof raw.companion === "string" && raw.companion.trim()) {
    const resolved = resolveHookFile(raw.companion.trim());
    // Same directory as the hook file, so the blast radius of a companion is
    // the directory the agent already owns.
    companion = resolved && path.dirname(resolved) === path.dirname(file) ? resolved : null;
  }

  return {
    file,
    ownership: raw.ownership === "whole-file" ? "whole-file" : "merged",
    container,
    entry: raw.entry === "flat" ? "flat" : "nested",
    matcherEvents: Array.isArray(raw.matcherEvents)
      ? raw.matcherEvents.filter((name): name is string => typeof name === "string" && name.trim() !== "")
      : [],
    extraFields: isRecordValue(raw.extraFields) ? { ...raw.extraFields } : {},
    companion,
    events,
  };
}

// One agent, as Settings → AI Providers lists them.
export interface AgentPreset {
  // Stable across renames: what an extension stores when it picks one, and
  // what the hook routes address. Safe as a plain object key.
  id: string;
  label: string;
  // The foreground command a window running this agent reports. Empty means
  // "launch preset only" — nothing will ever be detected as this agent.
  program: string;
  // The full command line that starts it. Empty means "detection only".
  command: string;
  // The command line that picks up where the agent left off in the same
  // folder ("claude --continue"), typed into a window that was running it
  // when the terminals come back after a restart. Empty means it isn't
  // resumed: the restored window is left at a shell prompt.
  resume: string;
  // The argument(s) appended to `command` to start this agent with its
  // permission prompts off - its "yolo mode". A parameter rather than a
  // second registry entry, because every agent has one and the pair only
  // ever differed by this flag: two entries meant the same CLI listed twice,
  // with the same program, the same hooks and the same everything else.
  // Empty means this agent has no such mode and the checkbox is not offered.
  skipPermissionsArgs: string;
  hooks: AgentHookDescriptor | null;
  // How to run this CLI for one-shot text, or null when it cannot do that.
  // An agent with none is still a perfectly good detection and launch entry;
  // it just cannot answer a commit message.
  oneShot: AgentOneShot | null;
  // Where to read about this agent, or how to install it - the row's
  // external-link button in Settings → AI Providers, and the only useful thing to
  // offer for an agent whose CLI is not on the machine yet. Empty hides the
  // link.
  docsUrl: string;
  // An image for the agent's row. Core's own agents point at files the app
  // serves (/agents/<id>.svg); a contributed agent may give an absolute URL
  // or a path inside its own extension, which is resolved to that
  // extension's file route before it reaches a client. Empty falls back to
  // `icon` below.
  iconUrl: string;
  // Fallback for an agent with no image: a codicon name from the set the app
  // already ships (see client/src/components/Icon.tsx). Anything empty or
  // unknown renders the generic robot rather than leaving a hole in the row.
  icon: string;
  // An agent kept but not offered: it stays configured and stops showing up
  // in pickers and in detection.
  enabled: boolean;
  // The extension that contributed this entry, or "" for one core ships or
  // the user wrote. Contributed entries are not editable in Settings -
  // whoever contributed them owns their command line - but they can be
  // enabled and disabled like any other.
  contributedBy: string;
}

// Core ships no agents. "What is an AI agent" is answered entirely by what
// extensions contribute (manifest `contributes.agents`), so a profile with no
// agent-contributing extension installed has an empty registry and says so in
// Settings — see the bundled extensions/agents, which supplies Claude Code and
// Codex (plans/agents-from-extensions.md).
// What a row shows for an agent that named no icon of its own.
export const DEFAULT_AGENT_ICON = "hubot";

function readString(source: Record<string, unknown>, key: string): string {
  return typeof source[key] === "string" ? (source[key] as string).trim() : "";
}

function parseAgent(raw: unknown): AgentPreset | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const source = raw as Record<string, unknown>;
  const id = readString(source, "id");
  const program = readString(source, "program");
  const command = readString(source, "command");
  // An entry that can neither be detected nor launched is not an agent, and
  // an id is what everything else addresses it by.
  if (!id || (!program && !command)) return null;
  return {
    id,
    label: readString(source, "label") || program || command,
    program,
    command,
    skipPermissionsArgs: readString(source, "skipPermissionsArgs"),
    resume: readString(source, "resume"),
    // Never taken from the settings document. A descriptor says which file in
    // the user's home core may write, and in what shape, so it comes only
    // from the manifest that declared the agent — a document the user can
    // hand-edit does not get to redirect core's writer. Documents written by
    // earlier versions still hold a "claude" / "codex" / "agy" string here;
    // it is ignored, and resolveAgents puts the real descriptor back.
    hooks: null,
    oneShot: null,
    docsUrl: readString(source, "docsUrl"),
    iconUrl: readString(source, "iconUrl"),
    icon: readString(source, "icon") || DEFAULT_AGENT_ICON,
    // Absent means enabled: the settings UI always writes the flag, and a
    // hand-edited entry that left it out means "use it".
    enabled: source.enabled !== false,
    contributedBy: readString(source, "contributedBy"),
  };
}

// Agents contributed by extensions (manifest `contributes.agents`), supplied
// by extensions.ts at import time rather than imported from it: the
// extension host already depends on this module for host.agents, so reaching
// back would be a cycle. An installed provider is the only way contributed
// entries reach the registry, and with none installed the registry is
// exactly what it was.
let contributedAgentsSource: () => Promise<AgentPreset[]> = async () => [];

export function setContributedAgentsSource(source: () => Promise<AgentPreset[]>): void {
  contributedAgentsSource = source;
}

// The whole registry, disabled entries included: every agent an extension
// contributes, with the user's own state from the settings document laid over
// it.
//
// The direction matters and it is the opposite of what it used to be. A
// contribution is now the ONLY source of an agent's identity — its command
// line, its icon, and above all its hook descriptor. The settings document
// contributes one thing: whether the user turned it off. So a stored entry is
// merged ONTO its contributed one by id, and a stored entry no contribution
// matches is dropped rather than rendered as a dead row: it is either an
// agent core used to ship (an old "agy") or one whose extension has been
// uninstalled. Its flag stays in the document untouched, so reinstalling that
// extension restores the user's choice exactly.
export async function resolveAgents(): Promise<AgentPreset[]> {
  const doc = await readSettingsDoc();
  const settings = (doc.settings ?? {}) as Record<string, unknown>;
  const raw = settings.agents;
  const stored = new Map<string, AgentPreset>();
  if (Array.isArray(raw)) {
    for (const entry of raw) {
      const parsed = parseAgent(entry);
      if (parsed) stored.set(parsed.id, parsed);
    }
  }
  let contributed: AgentPreset[] = [];
  try {
    contributed = await contributedAgentsSource();
  } catch (err) {
    // A broken manifest must not take the registry down with it.
    console.error("failed to read contributed agents:", err);
  }
  return contributed.map((agent) => {
    // A stored entry under the same id carries the user's enabled choice.
    // Entries under any other id - including the bare "claude" a
    // pre-registry document held - match nothing and are simply not applied.
    const override = stored.get(agent.id);
    return override ? { ...agent, enabled: override.enabled } : agent;
  });
}

// Which of the registry's programs are actually on this machine, so Settings
// → Agents can dim an agent whose CLI is not installed rather than offering
// it as if it would work. Keyed by agent id; an entry with no program is
// never "installed" because there is nothing to look for.
export async function probeAgentPrograms(): Promise<Record<string, boolean>> {
  const agents = await resolveAgents();
  const found: Record<string, boolean> = {};
  await Promise.all(
    agents.map(async (agent) => {
      found[agent.id] = agent.program ? await isOnPath(agent.program) : false;
    }),
  );
  return found;
}

// What a caller may choose between, or match a pane against: the enabled
// entries, in the user's own order. `enabled` is not carried — everything
// in this list is.
export interface AgentSummary {
  id: string;
  label: string;
  program: string;
  command: string;
  // Appended to `command` when the caller offers a "skip permissions" choice
  // and the user takes it. Empty means this agent has no such mode.
  skipPermissionsArgs: string;
  // How to resume it after a restart; empty when it isn't resumed.
  resume: string;
  // Whether core can install hooks for this agent at all. The descriptor
  // itself is deliberately not published: it names a file in the user's home
  // and only core's writer has any business with it.
  hooks: boolean;
  // The one-shot form, when this agent has one - ai.ts needs the template
  // itself to build an argv, and unlike the hook descriptor it names no file
  // and reveals nothing about the user's machine.
  oneShot: AgentOneShot | null;
  // The agent's own mark, already resolved to a URL a client can load, and a
  // codicon name to fall back on. Published so anything showing an agent
  // (a status-bar readout, a picker) draws the icon the agent brought with
  // it instead of keeping its own table of which agent looks like what.
  iconUrl: string;
  icon: string;
}

export async function listAgents(): Promise<AgentSummary[]> {
  const agents = await resolveAgents();
  return agents
    .filter((a) => a.enabled)
    .map(({ id, label, program, command, skipPermissionsArgs, resume, hooks, oneShot, iconUrl, icon }) => ({
      id,
      label,
      program,
      command,
      skipPermissionsArgs,
      resume,
      hooks: hooks !== null,
      oneShot,
      iconUrl,
      icon,
    }));
}

// The line that starts an enabled agent, with the global Yolo/Manual choice
// (settings.agentPermissions) already applied - the server-side twin of what
// resolveAgentPresets in extensions/_shared/agentTarget.ts builds from
// GET /api/agents, and the same rule: append skipPermissionsArgs only under
// "yolo", and only when the agent has such a mode. A launcher running with no
// browser connected (an automation's scheduler tick) has no client to ask, so
// the rule is applied here rather than copied into each extension. Null for
// an unknown or disabled id, and for an agent with no launch command at all
// (a detection-only entry) - there is nothing to type for it.
export async function launchCommand(id: string): Promise<string | null> {
  const agent = (await listAgents()).find((a) => a.id === id);
  if (!agent || !agent.command) return null;
  return withPermissions(agent, agent.command);
}

// The line that resumes an enabled agent after a restart, under the same
// Yolo/Manual rule as launchCommand. Null for an unknown or disabled id, or
// an agent that declares no resume command.
export async function resumeCommand(id: string): Promise<string | null> {
  const agent = (await listAgents()).find((a) => a.id === id);
  if (!agent || !agent.resume) return null;
  return withPermissions(agent, agent.resume);
}

async function withPermissions(agent: AgentSummary, line: string): Promise<string> {
  const doc = await readSettingsDoc();
  const settings = (doc.settings ?? {}) as Record<string, unknown>;
  const yolo = settings.agentPermissions === "yolo";
  return yolo && agent.skipPermissionsArgs ? `${line} ${agent.skipPermissionsArgs}` : line;
}

// One agent by id, disabled ones included — the hook routes address an agent
// directly and must still be able to uninstall hooks for one the user has
// since switched off.
export async function findAgent(id: string): Promise<AgentPreset | undefined> {
  const agents = await resolveAgents();
  return agents.find((a) => a.id === id);
}

// ---- Hook schemas -------------------------------------------------------
// Everything below writes hooks WITHOUT knowing which agent it is writing
// for. The per-CLI knowledge that used to live here — three files, three
// shapes, three sets of event names — is now data on the descriptor an
// extension declares, so adding an agent is a manifest, not a patch to this
// file (plans/agents-from-extensions.md).

// The events core normalizes to, and the only names a subscriber ever sees.
// One vocabulary over however many CLIs, each spelling them differently, so
// an extension subscribing to "stop" gets every agent's stop without knowing
// what any of them calls it.
export type AgentEvent =
  | "session-start"
  | "prompt-submit"
  | "tool-start"
  | "tool-end"
  | "permission"
  | "stop"
  | "subagent-stop";

// Fire once per tool call rather than once per turn. Gated behind the
// agentHooksHighFrequencyEvents setting: a subscriber may ask for them, but
// core does not install them until the user opts in.
export const HIGH_FREQUENCY_EVENTS: readonly AgentEvent[] = ["tool-start", "tool-end"];

// The same list at runtime, so parseHookDescriptor can reject an event name a
// manifest invented. Kept beside the type deliberately: adding a member to
// one and not the other silently drops that event from every descriptor.
const AGENT_EVENTS: readonly AgentEvent[] = [
  "session-start",
  "prompt-submit",
  "tool-start",
  "tool-end",
  "permission",
  "stop",
  "subagent-stop",
];

// Seconds. Generous next to the shim's own `curl -m 2` — the number is only
// ever reached if the whole shim hangs, and a hook that times out is an agent
// that stalls, so it errs long rather than tight.
const HOOK_TIMEOUT_SECONDS = 5;

// The one line core ever asks an agent to run. Written at boot by
// agentHooks.ts (which owns the script's contents); the path is here because
// it is also core's signature in an agent's config file — the writer
// recognizes its own entries by this path and nothing else, which is what
// keeps a hand-written hook from ever being read, rewritten or removed.
export const agentHookShimPath = path.join(
  configDir,
  "bin",
  process.platform === "win32" ? "agent-hook.cmd" : "agent-hook",
);

// How the shim path is written in a hook command: quoted on Windows, where
// the path usually contains the user's name and may contain spaces.
const shimInCommand = process.platform === "win32" ? `"${agentHookShimPath}"` : agentHookShimPath;

// An id safe to put in a hook command's argument list, and safe as a plain
// object key. Ids come from a user-editable settings document, and the
// generated command is executed by the agent, so anything outside this
// alphabet is refused rather than escaped.
const SAFE_ID = /^[A-Za-z0-9._-]{1,64}$/;

export function isSafeAgentId(id: string): boolean {
  return SAFE_ID.test(id) && id !== "__proto__";
}

// The command an agent's hook entry runs: the shim, the agent it fired for,
// and the agent's own event name. The event JSON goes to the shim on stdin,
// and $TMUX_PANE is read from the pane's environment — nothing about the
// event is interpolated here.
export function hookCommandFor(agentId: string, rawEvent: string): string {
  return `${shimInCommand} ${agentId} ${rawEvent}`;
}

// Which of `events` this agent can actually deliver, as its own raw names,
// in a stable order so two calls produce comparable results (the stale check
// in hookState compares these sets).
export function rawEventsFor(hooks: AgentHookDescriptor, events: readonly AgentEvent[]): string[] {
  const names = new Set<string>();
  for (const event of events) {
    const raw = hooks.events[event];
    if (raw) names.add(raw);
  }
  return [...names].sort();
}

// The reverse of the descriptor's event map, for agentHooks.ts's normalizer.
// A raw name this agent has no entry for returns null — the event is still
// delivered, just unnormalized.
export function normalizeRawEvent(hooks: AgentHookDescriptor, rawEvent: string): AgentEvent | null {
  for (const [event, raw] of Object.entries(hooks.events)) {
    if (raw === rawEvent) return event as AgentEvent;
  }
  return null;
}

export interface HookSnippet {
  // Absolute path of the file this belongs in.
  file: string;
  // "merged" — the file holds other things and core only adds its own part.
  // "whole-file" — the snippet IS the file's entire contents, so pasting it
  // over an existing one would discard whatever was there and the UI has to
  // say so. Declared per agent by its descriptor.
  ownership: "merged" | "whole-file";
  // The exact text to paste, newline-terminated.
  text: string;
  // The raw event names this snippet registers, for the UI and for the
  // install/stale bookkeeping.
  rawEvents: string[];
}

// One handler, the only thing core ever asks an agent to run.
function handlerFor(agentId: string, rawEvent: string): Record<string, unknown> {
  return { type: "command", command: hookCommandFor(agentId, rawEvent), timeout: HOOK_TIMEOUT_SECONDS };
}

// One event's value, in whichever of the two shapes this agent's parser
// wants: a list of entries each holding a "hooks" array, or a flat list of
// handlers. The matcher goes on the entry and only for the events that
// accept one — putting it on an event that does not is how a file gets
// rejected at startup.
function eventValueFor(
  hooks: AgentHookDescriptor,
  agentId: string,
  rawEvent: string,
): Record<string, unknown>[] {
  const handler = handlerFor(agentId, rawEvent);
  if (hooks.entry === "flat") return [handler];
  const entry: Record<string, unknown> = {};
  if (hooks.matcherEvents.includes(rawEvent)) entry.matcher = "*";
  entry.hooks = [handler];
  return [entry];
}

// The whole document core would write for an agent, from nothing. Used for
// the pasteable snippet the UI shows; installHooks merges into whatever is
// already on disk instead.
function snippetDoc(
  hooks: AgentHookDescriptor,
  agentId: string,
  rawEvents: string[],
): Record<string, unknown> {
  const events: Record<string, unknown> = {};
  for (const raw of rawEvents) events[raw] = eventValueFor(hooks, agentId, raw);
  if (hooks.container.kind === "wrapper") {
    return { [hooks.container.name]: { ...hooks.container.extra, ...events } };
  }
  return { ...hooks.extraFields, [hooks.container.key]: events };
}

// The snippet for one agent and one set of normalized events, or null when
// there is nothing to generate: an agent with no hook descriptor, an unsafe
// id, or a set of events this agent cannot deliver any of.
export function snippetFor(agent: AgentPreset, events: readonly AgentEvent[]): HookSnippet | null {
  if (!agent.hooks || !isSafeAgentId(agent.id)) return null;
  const rawEvents = rawEventsFor(agent.hooks, events);
  if (rawEvents.length === 0) return null;
  return {
    file: agent.hooks.file,
    ownership: agent.hooks.ownership,
    text: `${JSON.stringify(snippetDoc(agent.hooks, agent.id, rawEvents), null, 2)}\n`,
    rawEvents,
  };
}

// ---- The writer ---------------------------------------------------------
// Core writing into a file it does not own (an agent's own config, in the
// user's home) is the one place in this app that does that, so the rules are
// strict and they are all here:
//
//   Only from an explicit user action. Nothing below runs at boot or on a
//   settings change — only POST /api/agent-hooks/install and its sibling.
//
//   Only core's own entries are ever read, replaced or removed, and "core's
//   own" means exactly one thing: the command starts with core's shim path.
//   A hand-written hook is never touched, whatever it points at, and
//   installing twice replaces core's entry in place rather than adding a
//   second.
//
//   A timestamped backup beside the file first, then temp-then-rename, so a
//   crash mid-write cannot leave a user without their agent's settings.

// Core's own entries are recognized by exactly one thing: the command starts
// with core's shim path. Nothing else in a file is ever read, rewritten or
// removed, whatever it points at.
function isCoreHookCommand(command: unknown): boolean {
  return typeof command === "string" && command.startsWith(`${shimInCommand} `);
}

// The agent id core's own command was installed for. Hooks are per config
// FILE, so two registry entries that share a CLI share one installed entry,
// and this is whichever of them was installed last - see hookStateFor's stale
// check.
function coreHookAgentId(command: string): string {
  return command.slice(shimInCommand.length + 1).split(" ")[0] ?? "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// What core found of its own in an agent's config file. Shape-agnostic: the
// descriptor says where the event map lives and how one event's value is
// built, and everything below works off that alone.
interface HookScan {
  // Raw event names core's own handlers are registered for.
  coreEvents: string[];
  // Agent ids core's installed handlers name.
  coreAgentIds: string[];
}

// Every handler registered under one event's value, in either shape. A
// "nested" value is a list of entries each carrying its own handler array; a
// "flat" value is the handler list itself.
function handlersIn(value: unknown, entry: AgentHookDescriptor["entry"]): unknown[] {
  if (!Array.isArray(value)) return [];
  if (entry === "flat") return value;
  const out: unknown[] = [];
  for (const item of value) {
    if (isRecord(item) && Array.isArray(item.hooks)) out.push(...item.hooks);
  }
  return out;
}

// The event maps to scan in a document. One for a keyed container; for a
// wrapper container it is every wrapper object in the file, because core has
// to find its own entries even under a name it no longer uses (a rename, an
// older version). A wrapper's non-array fields — Antigravity's enabled:true —
// fall out on their own, since an event value is always an array.
function eventMapsIn(doc: Record<string, unknown>, hooks: AgentHookDescriptor): Record<string, unknown>[] {
  if (hooks.container.kind === "wrapper") {
    return Object.values(doc).filter(isRecord);
  }
  const map = doc[hooks.container.key];
  return isRecord(map) ? [map] : [];
}

function scanHooks(doc: Record<string, unknown>, hooks: AgentHookDescriptor): HookScan {
  const coreEvents = new Set<string>();
  const coreAgentIds = new Set<string>();
  for (const map of eventMapsIn(doc, hooks)) {
    for (const [event, value] of Object.entries(map)) {
      for (const handler of handlersIn(value, hooks.entry)) {
        const command = isRecord(handler) ? handler.command : undefined;
        if (isCoreHookCommand(command)) {
          coreEvents.add(event);
          coreAgentIds.add(coreHookAgentId(command as string));
        }
      }
    }
  }
  return { coreEvents: [...coreEvents].sort(), coreAgentIds: [...coreAgentIds] };
}

// Drops every handler core wrote from a keyed event map, leaving everything
// else — including an entry that mixes a core handler with a hand-written
// one, where only the core handler goes — and prunes an event whose list ends
// up empty so the file does not accumulate dead keys.
function stripCoreEntries(map: Record<string, unknown>, entry: AgentHookDescriptor["entry"]): void {
  for (const [event, value] of Object.entries(map)) {
    if (!Array.isArray(value)) continue;
    const kept: unknown[] = [];
    for (const item of value) {
      if (entry === "flat") {
        if (!isCoreHookCommand(isRecord(item) ? item.command : undefined)) kept.push(item);
        continue;
      }
      if (!isRecord(item) || !Array.isArray(item.hooks)) {
        kept.push(item);
        continue;
      }
      const handlers = item.hooks.filter(
        (handler) => !isCoreHookCommand(isRecord(handler) ? handler.command : undefined),
      );
      if (handlers.length === item.hooks.length) kept.push(item);
      else if (handlers.length > 0) kept.push({ ...item, hooks: handlers });
    }
    if (kept.length > 0) map[event] = kept;
    else delete map[event];
  }
}

// A wrapper core owns, recognized only by the commands inside it — so a
// wrapper under core's own name that points somewhere else is someone else's
// and is left completely alone (installHooks refuses rather than replacing
// it).
function isCoreWrapper(wrapper: unknown, entry: AgentHookDescriptor["entry"]): boolean {
  if (!isRecord(wrapper)) return false;
  let sawHandler = false;
  for (const value of Object.values(wrapper)) {
    for (const handler of handlersIn(value, entry)) {
      sawHandler = true;
      if (!isCoreHookCommand(isRecord(handler) ? handler.command : undefined)) return false;
    }
  }
  return sawHandler;
}

// ---- Companions ---------------------------------------------------------
// A companion is a second file an agent's CLI needs written alongside its
// hooks, whose contents core cannot generate because the knowledge belongs to
// the agent, not to core. The extension that declared the agent registers a
// transform; core reads the file, hands over its current text plus what it
// just installed, and writes back what comes out.
//
// The privilege this hands an extension is real, so it is fenced on every
// side: the path comes from the manifest (not from the transform's return
// value) and must sit in the hook file's own directory, the result is capped,
// and a transform that throws or hangs is logged and skipped rather than
// taking the install down with it. Core still owns the backup and the
// temp-then-rename.

// One handler core installed, addressed the way a companion needs to address
// it: by event and by position, because that is how a trust entry keyed on
// "<file>:<event>:<group>:<handler>" is built.
export interface AgentCompanionHandler {
  rawEvent: string;
  command: string;
  timeoutSeconds: number;
  // Index of the entry within the event's array, and of the handler within
  // that entry. Always 0 and 0 for what core writes today - core installs one
  // entry per event with one handler in it - but a companion keying on
  // position should read them rather than assume.
  group: number;
  handler: number;
}

export interface AgentCompanionRequest {
  agentId: string;
  // The hook file core just wrote, which a companion usually has to name.
  hookFile: string;
  // What core installed. Empty on uninstall, which is how a transform knows
  // to remove its entries rather than write them.
  handlers: AgentCompanionHandler[];
  // The companion file's current text, or "" when it does not exist yet.
  current: string;
}

export type AgentCompanionTransform = (request: AgentCompanionRequest) => string | Promise<string>;

// Registered by extensions.ts as extensions activate, keyed by the namespaced
// agent id. agents.ts cannot import that module (it already imports this one),
// so registration comes inward.
const companions = new Map<string, AgentCompanionTransform>();

export function registerAgentCompanion(agentId: string, transform: AgentCompanionTransform): void {
  companions.set(agentId, transform);
}

export function dropAgentCompanions(extensionId: string): void {
  for (const id of companions.keys()) {
    if (id === extensionId || id.startsWith(`${extensionId}.`)) companions.delete(id);
  }
}

// 64KB, the same ceiling the hook pipeline puts on an event payload. A
// config file core writes on a user's behalf has no business being larger.
const COMPANION_MAX_BYTES = 64 * 1024;
const COMPANION_TIMEOUT_MS = 2_000;

// Runs an agent's companion transform, if it has one, and writes the result.
// Returns the backup path when it wrote something. Never throws: the hooks
// themselves are already on disk by this point, and failing the whole install
// because a companion misbehaved would leave the user worse off than the
// warning does.
async function writeCompanion(
  agent: AgentPreset,
  hooks: AgentHookDescriptor,
  rawEvents: string[],
): Promise<string | null> {
  if (!hooks.companion) return null;
  const transform = companions.get(agent.id);
  if (!transform) return null;

  const handlers: AgentCompanionHandler[] = rawEvents.map((rawEvent) => ({
    rawEvent,
    command: hookCommandFor(agent.id, rawEvent),
    timeoutSeconds: HOOK_TIMEOUT_SECONDS,
    group: 0,
    handler: 0,
  }));

  try {
    let current = "";
    try {
      current = await readFile(hooks.companion, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
    const produced = await Promise.race([
      Promise.resolve(transform({ agentId: agent.id, hookFile: hooks.file, handlers, current })),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("timed out")), COMPANION_TIMEOUT_MS),
      ),
    ]);
    if (typeof produced !== "string") {
      console.warn(`agent ${agent.id}: companion returned no text - ${hooks.companion} left alone`);
      return null;
    }
    if (Buffer.byteLength(produced, "utf8") > COMPANION_MAX_BYTES) {
      console.warn(`agent ${agent.id}: companion output over 64KB - ${hooks.companion} left alone`);
      return null;
    }
    // Nothing to do is the common case on an agent whose companion entries
    // are already right; writing an identical file would still rotate a
    // backup, so it is skipped.
    if (produced === current) return null;
    return await writeTextFile(hooks.companion, produced);
  } catch (err) {
    console.warn(`agent ${agent.id}: companion failed, ${hooks.companion} left alone:`, err);
    return null;
  }
}

export class HookWriteError extends Error {}

// ---- File IO ----

async function readHookDoc(file: string): Promise<Record<string, unknown> | null> {
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
  // An empty file is a fresh one, not a broken one — several of these get
  // created by `touch`.
  if (text.trim() === "") return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new HookWriteError(`${file} is not valid JSON - fix or move it first, then install again`);
  }
  if (!isRecord(parsed)) {
    throw new HookWriteError(`${file} does not hold a JSON object`);
  }
  return parsed;
}

// Milliseconds included deliberately: two installs in the same second would
// otherwise share a name, and the second backup would overwrite the first —
// losing the only copy of what the file looked like before core touched it.
function backupName(file: string): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").replace(/Z$/, "");
  return `${file}.perch-backup-${stamp}`;
}

// Backup beside the file, then write a sibling temp file and rename it over
// the original — a rename within one directory is atomic, so a crash leaves
// either the old file or the new one and never a truncated mix. The original
// file's mode is carried over; a new file gets the process umask's.
async function writeTextFile(file: string, text: string): Promise<string | null> {
  await mkdir(path.dirname(file), { recursive: true });
  let backup: string | null = null;
  let mode: number | undefined;
  try {
    const info = await stat(file);
    mode = info.mode & 0o777;
    backup = backupName(file);
    await copyFile(file, backup);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  const temp = `${file}.perch-tmp-${process.pid}`;
  await writeFile(temp, text);
  if (mode !== undefined) await chmod(temp, mode);
  await rename(temp, file);
  return backup;
}

async function writeHookDoc(file: string, doc: Record<string, unknown>): Promise<string | null> {
  return writeTextFile(file, `${JSON.stringify(doc, null, 2)}\n`);
}

// ---- State ----

export interface HookState {
  agentId: string;
  // "unsupported" — this agent speaks no hook schema core knows.
  // "not-installed" — nothing of core's is in the file.
  // "installed" — core's entries match what its subscribers currently want.
  // "stale" — core's entries are there but no longer right; `staleReason`
  //   says why in one sentence a user can act on.
  state: "unsupported" | "not-installed" | "installed" | "stale";
  file: string | null;
  ownership: "merged" | "whole-file" | null;
  // Raw event names core has installed, and the ones it would install now.
  installedEvents: string[];
  wantedEvents: string[];
  staleReason: string | null;
  // Set when the file itself could not be read as JSON: nothing was written
  // and nothing will be until it is fixed.
  error: string | null;
}

// `wantedEvents` comes from the caller (agentHooks.ts owns the subscriber
// union) rather than being read here, so this module stays free of the
// pipeline and the two never import each other.
export async function hookStateFor(agent: AgentPreset, events: readonly AgentEvent[]): Promise<HookState> {
  const base = {
    agentId: agent.id,
    installedEvents: [] as string[],
    wantedEvents: [] as string[],
    staleReason: null,
    error: null,
  };
  if (!agent.hooks) {
    return { ...base, state: "unsupported", file: null, ownership: null };
  }
  const file = agent.hooks.file;
  const wantedEvents = rawEventsFor(agent.hooks, events);
  const ownership = agent.hooks.ownership;

  let doc: Record<string, unknown> | null;
  try {
    doc = await readHookDoc(file);
  } catch (err) {
    return {
      ...base,
      state: "not-installed",
      file,
      ownership,
      wantedEvents,
      error: err instanceof Error ? err.message : String(err),
    };
  }

  const scan: HookScan =
    doc === null ? { coreEvents: [], coreAgentIds: [] } : scanHooks(doc, agent.hooks);

  const result: HookState = {
    ...base,
    state: scan.coreEvents.length === 0 ? "not-installed" : "installed",
    file,
    ownership,
    installedEvents: scan.coreEvents,
    wantedEvents,
  };
  if (result.state === "not-installed") return result;

  const installed = scan.coreEvents.join(",");
  if (installed !== wantedEvents.join(",")) {
    result.state = "stale";
    result.staleReason =
      wantedEvents.length === 0
        ? "Nothing is subscribed to agent hooks any more, so these can be removed."
        : "The installed events no longer match what the enabled extensions ask for. Install again to update them.";
    return result;
  }
  // The hooks are per config file, so two presets sharing a CLI share one
  // installed entry; what must still hold is that the agent it names exists,
  // or its events arrive for an agent core can no longer resolve.
  const agents = await resolveAgents();
  const orphan = scan.coreAgentIds.find((id) => !agents.some((a) => a.id === id));
  if (orphan !== undefined) {
    result.state = "stale";
    result.staleReason = `These hooks report as "${orphan}", which is not in the list any more. Install again to point them at this agent.`;
  }
  return result;
}

// ---- Install / uninstall ----

export interface HookWriteResult {
  state: HookState;
  // Where the previous contents were kept, when there were any.
  backup: string | null;
  // The same, for the agent's companion file when it has one and it changed.
  companionBackup?: string | null;
}

export async function installHooks(agent: AgentPreset, events: readonly AgentEvent[]): Promise<HookWriteResult> {
  if (!agent.hooks) throw new HookWriteError(`${agent.label} has no hook format core can write`);
  if (!isSafeAgentId(agent.id)) throw new HookWriteError(`"${agent.id}" is not a usable agent id`);
  const rawEvents = rawEventsFor(agent.hooks, events);
  if (rawEvents.length === 0) {
    throw new HookWriteError(
      "Nothing is subscribed to agent hooks yet, so there is nothing to install. Enable an extension that uses them first.",
    );
  }
  const container = agent.hooks.container;
  const file = agent.hooks.file;
  const doc = (await readHookDoc(file)) ?? {};

  if (container.kind === "wrapper") {
    // Core owns one named wrapper. Any wrapper that is core's (by command) is
    // dropped first, so a rename or an old event set leaves nothing behind,
    // and a name collision with someone else's wrapper is refused rather than
    // resolved by overwriting it.
    for (const [name, wrapper] of Object.entries(doc)) {
      if (isCoreWrapper(wrapper, agent.hooks.entry)) delete doc[name];
    }
    if (doc[container.name] !== undefined) {
      throw new HookWriteError(
        `${file} already has a hook named "${container.name}" that is not core's - rename it and install again`,
      );
    }
    const wrapper: Record<string, unknown> = { ...container.extra };
    for (const raw of rawEvents) wrapper[raw] = eventValueFor(agent.hooks, agent.id, raw);
    doc[container.name] = wrapper;
  } else {
    const map = isRecord(doc[container.key]) ? { ...(doc[container.key] as Record<string, unknown>) } : {};
    stripCoreEntries(map, agent.hooks.entry);
    for (const raw of rawEvents) {
      const existing = Array.isArray(map[raw]) ? (map[raw] as unknown[]) : [];
      map[raw] = [...existing, ...eventValueFor(agent.hooks, agent.id, raw)];
    }
    doc[container.key] = map;
    // Fields this CLI's parser requires (Codex's "description"). Only filled
    // in when absent — whatever the user put there is theirs.
    for (const [key, value] of Object.entries(agent.hooks.extraFields)) {
      if (doc[key] === undefined) doc[key] = value;
    }
  }

  const backup = await writeHookDoc(file, doc);
  // After the hooks, never before: a companion that names the hook file must
  // describe what is actually on disk.
  const companionBackup = await writeCompanion(agent, agent.hooks, rawEvents);
  return { state: await hookStateFor(agent, events), backup, companionBackup };
}

export async function uninstallHooks(agent: AgentPreset, events: readonly AgentEvent[]): Promise<HookWriteResult> {
  if (!agent.hooks) throw new HookWriteError(`${agent.label} has no hook format core can write`);
  const container = agent.hooks.container;
  const file = agent.hooks.file;
  const doc = await readHookDoc(file);
  if (doc === null) return { state: await hookStateFor(agent, events), backup: null };

  if (container.kind === "wrapper") {
    for (const [name, wrapper] of Object.entries(doc)) {
      if (isCoreWrapper(wrapper, agent.hooks.entry)) delete doc[name];
    }
  } else if (isRecord(doc[container.key])) {
    const map = { ...(doc[container.key] as Record<string, unknown>) };
    stripCoreEntries(map, agent.hooks.entry);
    // An emptied container key is left as an empty object rather than
    // deleted: it was there before core wrote anything, and removing a key
    // the user may have put there is not core's call.
    doc[container.key] = map;
  }

  const backup = await writeHookDoc(file, doc);
  // No handlers left, which is how a companion knows to take its entries out.
  const companionBackup = await writeCompanion(agent, agent.hooks, []);
  return { state: await hookStateFor(agent, events), backup, companionBackup };
}
