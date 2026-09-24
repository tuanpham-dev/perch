// The app's one AI backend. Everything that turns a prompt into text — the
// git-scm commit-message button, ai-command, prompts — comes through runAi,
// so "which AI do I have?" is answered once, in Settings → AI Providers, instead of
// once per extension (plans/core-ai-providers.md).
//
// Two provider families:
//   CLI    claude / codex / agy / custom — a locally installed binary, run
//          one-shot ("print the reply and exit"); no key, no interactive or
//          agent mode, and nothing here executes any part of the reply.
//   API    anthropic / openai — a single HTTPS POST with a key read from the
//          settings store's server-only aiSecrets (see settingsStore.ts).
//          Hand-rolled fetch rather than an SDK: one short call each, and the
//          server takes no new dependency for it. The provider picks the WIRE
//          FORMAT, not the vendor: aiBaseUrl points either format at any
//          compatible endpoint (OpenRouter, Groq, Together, LiteLLM, a local
//          Ollama), which is why there is no separate provider per vendor.
import { execFile } from "node:child_process";
import { access, constants } from "node:fs/promises";
import path from "node:path";
import { findAgent, listAgents, oneShotArgs, probeAgentPrograms } from "./agents.js";
import { readAiSecrets, readSettingsDoc } from "./settingsStore.js";

const TIMEOUT_MS = 60_000;
// The ceiling a caller may raise the wait to with AiRunOptions.timeoutMs. A
// job that legitimately runs for minutes — a CLI agent asked to read a
// repository before answering — needs more than the default, but an unbounded
// wait turns one mistyped number into a request that never returns.
const MAX_TIMEOUT_MS = 15 * 60_000;
const MAX_BUFFER = 4 * 1024 * 1024;
// Long enough for a commit message or a refined prompt; this is a one-shot
// text call, not a conversation.
const MAX_OUTPUT_TOKENS = 4096;
// Documented default for the Anthropic API. OpenAI gets no baked-in default
// — see AiError("missing-model").
const ANTHROPIC_DEFAULT_MODEL = "claude-opus-5";
// Official endpoints, used when aiBaseUrl is empty. Both include the version
// segment, so a third-party base URL is given the same way the vendors
// document theirs (".../v1") and the route below is appended to it.
const ANTHROPIC_DEFAULT_BASE = "https://api.anthropic.com/v1";
// Required on every Anthropic API call, the models list included.
const ANTHROPIC_VERSION = "2023-06-01";
const OPENAI_DEFAULT_BASE = "https://api.openai.com/v1";

export type AiErrorCode =
  | "unsupported"
  | "missing-binary"
  | "missing-key"
  | "missing-model"
  | "missing-command"
  | "provider-failed"
  | "empty-reply";

// Typed so a caller can tell "you haven't configured this yet" from "the
// provider broke", and surface the first as guidance rather than an error.
export class AiError extends Error {
  constructor(
    readonly code: AiErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "AiError";
  }
}

// One configured AI, as Settings → AI Providers lists them. Several can be set up at
// once — a CLI you're signed into, a keyed API for the jobs worth paying
// for — and each caller (core, or any extension) either names one or gets
// the default.
export interface AiProfile {
  // Stable across renames: what a caller stores when it picks a profile.
  id: string;
  label: string;
  provider: string;
  model: string;
  binaryPath: string;
  customCommand: string;
  baseUrl: string;
  enabled: boolean;
}

function readString(source: Record<string, unknown>, key: string): string {
  return typeof source[key] === "string" ? (source[key] as string).trim() : "";
}

function parseProfile(raw: unknown): AiProfile | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const source = raw as Record<string, unknown>;
  const id = readString(source, "id");
  const provider = readString(source, "provider");
  if (!id || !provider) return null;
  return {
    id,
    label: readString(source, "label") || provider,
    provider,
    model: readString(source, "model"),
    binaryPath: readString(source, "binaryPath"),
    customCommand: readString(source, "customCommand"),
    baseUrl: readString(source, "baseUrl"),
    // Absent means enabled: a profile is only ever written by the settings
    // UI, and a hand-edited entry that forgot the flag means "use it".
    enabled: source.enabled !== false,
  };
}

interface AiConfigDoc {
  profiles: AiProfile[];
  defaultProfileId: string;
  // The model chosen for whichever provider is the default, from Settings →
  // AI Providers' own select. Applied to the default profile only: a caller
  // that names a profile explicitly gets that profile's own model.
  defaultModel: string;
}

// One profile per enabled agent that declared a one-shot form, synthesised
// rather than stored. This is what "the CLIs come from the agents" means in
// practice: nobody adds a Claude Code provider by hand, and there is no
// second place where that CLI is defined. The agent's id IS the profile id,
// so a stored entry for the same id (a user who set a model or a binary path
// for it) simply wins.
//
// No model of its own: an agent-derived profile runs the CLI's own default
// model. Naming one means storing a profile with that id, which the settings
// UI does when you edit the row.
async function agentProfiles(): Promise<AiProfile[]> {
  try {
    const agents = await listAgents();
    return agents
      .filter((agent) => agent.oneShot)
      .map((agent) => ({
        id: agent.id,
        label: agent.label,
        provider: agent.id,
        model: "",
        binaryPath: "",
        customCommand: "",
        baseUrl: "",
        enabled: true,
      }));
  } catch (err) {
    // A broken manifest must not take the AI backend down with it — the
    // stored API providers are independent of this.
    console.error("failed to read agent-derived AI profiles:", err);
    return [];
  }
}

// The kinds core talks to itself. Anything else in a profile's `provider` is
// an agent id, resolved against the registry.
const API_PROVIDERS = new Set(["anthropic", "openai", "custom"]);

// Can this profile actually answer? An API kind always can. A CLI one can
// only if the agent it names is still installed, enabled and declares a
// one-shot form.
//
// A stored profile that fails this is DROPPED rather than listed, and that is
// deliberate: before CLIs came from the registry, a profile could name the
// bare provider "claude", and those entries survive in existing settings
// documents. Keeping one would leave a broken row that is very likely the
// user's default, so every AI feature would fail until they noticed. Dropping
// it lets the default fall through to an agent-derived profile that works.
function profileIsUsable(profile: AiProfile, agentIds: Set<string>): boolean {
  return API_PROVIDERS.has(profile.provider) || agentIds.has(profile.provider);
}

async function readAiConfig(): Promise<AiConfigDoc> {
  const doc = await readSettingsDoc();
  const settings = (doc.settings ?? {}) as Record<string, unknown>;
  const raw = settings.aiProfiles;
  const parsed = Array.isArray(raw) ? raw.map(parseProfile).filter((p): p is AiProfile => p !== null) : [];
  const derivable = await agentProfiles();
  const agentIds = new Set(derivable.map((p) => p.id));
  const stored = parsed.filter((p) => profileIsUsable(p, agentIds));
  for (const dropped of parsed.filter((p) => !stored.includes(p))) {
    console.warn(
      `ai: ignoring profile "${dropped.label}" - its provider "${dropped.provider}" is not an API kind and names no installed agent`,
    );
  }
  const storedIds = new Set(stored.map((p) => p.id));
  const derived = derivable.filter((p) => !storedIds.has(p.id));
  const profiles = [...stored, ...derived];
  return {
    // Possibly empty: no stored API provider and no agent offering a one-shot
    // form. There is no synthesised fallback any more - the pre-profiles flat
    // settings (aiProvider and friends) are gone - so an empty list surfaces
    // as defaultProfileOf's "No AI is configured" rather than as a profile
    // that could only fail.
    profiles,
    defaultProfileId: readString(settings, "aiProfileId"),
    defaultModel: readString(settings, "aiDefaultModel"),
  };
}

// Which profile answers when nothing names one: the configured default, else
// the first usable one. Its own function because both resolveProfile and
// listAiProfiles have to agree on it - a picker marking one profile while the
// backend runs another is the kind of thing nobody notices until a job uses
// the wrong model.
function defaultProfileOf(profiles: AiProfile[], defaultProfileId: string): AiProfile {
  const enabled = profiles.filter((p) => p.enabled);
  const found = enabled.find((p) => p.id === defaultProfileId) ?? enabled[0] ?? profiles[0];
  if (!found) {
    throw new AiError(
      "missing-command",
      "No AI is configured - add an API provider, or enable an agent that can answer text, in Settings → AI Providers",
    );
  }
  return found;
}

// What a caller may choose between: the enabled profiles, in the user's own
// order, with the default first-class so a picker can mark it. Never
// includes a binary path, a base URL or anything else an extension has no
// business seeing — only what it takes to name one.
export interface AiProfileSummary {
  id: string;
  label: string;
  provider: string;
  model: string;
  // The binary this one runs, for a CLI. Empty for an API provider. Published
  // because the provider id is an AGENT id now ("perch.agents.codex"),
  // which is not what the user would look for on their PATH - the settings UI
  // has to be able to name the actual command.
  program: string;
  isDefault: boolean;
}

export async function listAiProfiles(): Promise<AiProfileSummary[]> {
  const { profiles, defaultProfileId, defaultModel } = await readAiConfig();
  const enabled = profiles.filter((p) => p.enabled);
  const fallbackId = profiles.length > 0 ? defaultProfileOf(profiles, defaultProfileId).id : "";
  return Promise.all(
    enabled.map(async (p) => ({
      id: p.id,
      label: p.label,
      provider: p.provider,
      model: p.id === fallbackId && defaultModel ? defaultModel : p.model,
      program: API_PROVIDERS.has(p.provider) ? "" : (await findAgent(p.provider))?.program ?? "",
      isDefault: p.id === fallbackId,
    })),
  );
}

// Explicitly named profile, else the configured default, else the first
// enabled one, else the first one at all. A caller that names a profile the
// user has since deleted or disabled falls back rather than failing: its
// stored id is a preference, not a dependency.
async function resolveProfile(profileId?: string): Promise<AiProfile> {
  const { profiles, defaultProfileId, defaultModel } = await readAiConfig();
  const wanted = profileId?.trim();
  const named = wanted ? profiles.find((p) => p.id === wanted && p.enabled) : undefined;
  if (named) return named;
  const fallback = defaultProfileOf(profiles, defaultProfileId);
  // Only the default profile takes the default model. A profile reached by
  // name keeps its own, so an extension pointed at a specific AI is not
  // silently re-pointed at a different model.
  return defaultModel ? { ...fallback, model: defaultModel } : fallback;
}

// `${base}/${route}` with any trailing slash on the base collapsed, so both
// "https://host/v1" and "https://host/v1/" resolve the same way.
function endpoint(base: string, fallback: string, route: string): string {
  const root = (base || fallback).replace(/\/+$/, "");
  return `${root}/${route}`;
}

// The CLIs that can answer a one-shot prompt are not listed here any more.
// This module used to hold a table of them keyed by name (`claude -p`,
// `codex exec`, `agy -p`); each agent now declares its own one-shot form in
// its manifest and core substitutes and executes it, so adding a CLI is an
// extension rather than a patch to this file
// (plans/cli-providers-from-agents.md).
//
// An AI profile whose `provider` is not one of the API kinds above is an
// AGENT ID, resolved against the registry — which is also how the profile
// list gains an entry per agent without anyone adding one by hand.

// ---- CLI availability ----
// Which of the CLI providers are actually installed, so Settings → AI Providers can
// grey out a provider that would only ever fail with "claude CLI not found"
// the first time something asked it for text.
//
// A PATH walk rather than `which`/`command -v`: no subprocess per provider
// (this is polled by a settings dialog, not a one-shot), and no dependency
// on a lookup tool being present on a minimal box. A provider with an
// explicit binary path configured is NOT covered — that path is the user's
// own claim, checked when the call runs.

const CLI_PROBE_TTL_MS = 15_000;
let cliProbe: { at: number; value: Record<string, boolean> } | null = null;

// Lives in which.ts now — agents.ts asks the same question of every registry
// entry and should not have to import the AI provider module to do it.
// Re-exported here because this module's own callers already had it.
import { isOnPath } from "./which.js";
export { isOnPath };

// agent id → is its program on PATH. Cached briefly: a settings dialog
// re-reads this on every open, and installing a CLI mid-dialog is not worth a
// filesystem walk per keystroke.
//
// Delegates to the registry rather than keeping its own list: "which agents
// are installed" is one question with one answer, and Settings already dims
// an agent row from the same probe.
export async function probeCliProviders(): Promise<Record<string, boolean>> {
  if (cliProbe && Date.now() - cliProbe.at < CLI_PROBE_TTL_MS) return cliProbe.value;
  const value = await probeAgentPrograms();
  cliProbe = { at: Date.now(), value };
  return value;
}

function runCli(
  bin: string,
  args: string[],
  provider: string,
  cwd?: string,
  env?: Record<string, string>,
  timeoutMs: number = TIMEOUT_MS,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      bin,
      args,
      { encoding: "utf8", timeout: timeoutMs, maxBuffer: MAX_BUFFER, cwd, env: env ? { ...process.env, ...env } : undefined },
      (err, stdout, stderr) => {
        if (err) {
          const detail = (stderr || err.message || "").trim().slice(0, 300);
          if (/ENOENT/.test(err.message ?? "")) {
            reject(
              new AiError(
                "missing-binary",
                `CLI "${bin}" not found - install it, or pick another AI in Settings → AI Providers`,
              ),
            );
            return;
          }
          // execFile's own timeout kills the child, and the generic "CLI
          // failed" wording hid that. A caller that raised the wait needs to
          // know WHICH limit it hit before it can offer a shorter job instead.
          if ((err as { killed?: boolean }).killed) {
            reject(
              new AiError(
                "provider-failed",
                `${provider} CLI timed out after ${Math.round(timeoutMs / 1000)}s`,
              ),
            );
            return;
          }
          reject(new AiError("provider-failed", `${provider} CLI failed: ${detail || "unknown error"}`));
          return;
        }
        resolve(stdout);
      },
    );
    // Close stdin immediately. These are one-shot invocations with the prompt
    // in argv, but execFile leaves stdin an open pipe, and a CLI that checks
    // for piped input waits on it: `codex exec` prints "Reading additional
    // input from stdin..." and hangs until the timeout, yielding nothing.
    // EOF up front makes that instant (90s to 0.1s), and is harmless for the
    // providers that never read stdin.
    child.stdin?.end();
  });
}

async function postJson(
  url: string,
  headers: Record<string, string>,
  body: unknown,
  provider: string,
  timeoutMs: number = TIMEOUT_MS,
) {
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    if ((err as Error).name === "TimeoutError") {
      throw new AiError("provider-failed", `${provider} request timed out after ${Math.round(timeoutMs / 1000)}s`);
    }
    throw new AiError("provider-failed", `${provider} request failed: ${(err as Error).message}`);
  }
  const text = await res.text();
  if (!res.ok) {
    // Provider error bodies can echo the request, so only a short prefix is
    // surfaced — never the whole body, and never the key.
    throw new AiError("provider-failed", `${provider} returned ${res.status}: ${text.slice(0, 300)}`);
  }
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw new AiError("provider-failed", `${provider} returned a non-JSON response`);
  }
}

// A key is mandatory against the vendors' own endpoints, but a custom base
// URL is often something that needs no auth at all (a local Ollama or
// llama.cpp), so there it is optional and the auth header is simply omitted.
async function resolveKey(profile: AiProfile, custom: boolean): Promise<string> {
  const secrets = await readAiSecrets();
  // Keyed by profile id, so two profiles of the same wire format (OpenAI
  // itself and an OpenRouter endpoint, say) hold different keys.
  const key = secrets[profile.id];
  if (!key && !custom) {
    throw new AiError(
      "missing-key",
      `No API key configured for "${profile.label}" - add one in Settings → AI Providers`,
    );
  }
  return key ?? "";
}

async function runAnthropic(
  prompt: string,
  model: string,
  profile: AiProfile,
  timeoutMs: number = TIMEOUT_MS,
): Promise<string> {
  const baseUrl = profile.baseUrl;
  const key = await resolveKey(profile, !!baseUrl);
  const data = await postJson(
    endpoint(baseUrl, ANTHROPIC_DEFAULT_BASE, "messages"),
    { ...(key ? { "x-api-key": key } : {}), "anthropic-version": ANTHROPIC_VERSION },
    {
      model: model || ANTHROPIC_DEFAULT_MODEL,
      max_tokens: MAX_OUTPUT_TOKENS,
      messages: [{ role: "user", content: prompt }],
    },
    "anthropic",
    timeoutMs,
  );
  const content = Array.isArray(data.content) ? (data.content as { type?: string; text?: string }[]) : [];
  return content.find((block) => block.type === "text")?.text ?? "";
}

async function runOpenai(
  prompt: string,
  model: string,
  profile: AiProfile,
  timeoutMs: number = TIMEOUT_MS,
): Promise<string> {
  if (!model) {
    throw new AiError("missing-model", "The OpenAI provider needs a model - set one in Settings → AI Providers");
  }
  const baseUrl = profile.baseUrl;
  const key = await resolveKey(profile, !!baseUrl);
  const data = await postJson(
    endpoint(baseUrl, OPENAI_DEFAULT_BASE, "chat/completions"),
    key ? { authorization: `Bearer ${key}` } : {},
    { model, messages: [{ role: "user", content: prompt }] },
    "openai",
    timeoutMs,
  );
  const choices = Array.isArray(data.choices)
    ? (data.choices as { message?: { content?: string } }[])
    : [];
  return choices[0]?.message?.content ?? "";
}

// ---- Model discovery ----
// Both API formats expose the same route — GET {base}/models, returning
// {data: [...]} — so the Model field can offer the endpoint's own list
// instead of asking people to type an id from memory. Which endpoint that
// is follows the profile's base URL, so an OpenAI-compatible service
// (OpenRouter, Groq, Together, a local Ollama) lists ITS models, not
// OpenAI's.
//
// A CLI has no such route, so each one is asked the way it actually answers
// — see listCliModels. A custom command is the only provider with no answer
// at all: it's a command line the user wrote.

export interface AiModelOption {
  id: string;
  // Anthropic returns a display_name ("Claude Opus 5"); OpenAI-format
  // endpoints return the id alone.
  label?: string;
}

// Anthropic's list is paginated (has_more/last_id). A few pages is plenty
// for a picker — nobody scrolls 500 models — and it bounds a slow endpoint.
const MODEL_PAGE_LIMIT = 100;
const MODEL_MAX_PAGES = 3;

async function getJson(
  url: string,
  headers: Record<string, string>,
  provider: string,
): Promise<Record<string, unknown>> {
  let res: Response;
  try {
    res = await fetch(url, { headers, signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (err) {
    throw new AiError("provider-failed", `${provider} request failed: ${(err as Error).message}`);
  }
  const text = await res.text();
  if (!res.ok) {
    throw new AiError("provider-failed", `${provider} returned ${res.status}: ${text.slice(0, 300)}`);
  }
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw new AiError("provider-failed", `${provider} returned a non-JSON response`);
  }
}

function modelsFromData(data: unknown): AiModelOption[] {
  if (!Array.isArray(data)) return [];
  const out: AiModelOption[] = [];
  for (const entry of data) {
    if (typeof entry !== "object" || entry === null) continue;
    const row = entry as Record<string, unknown>;
    const id = typeof row.id === "string" ? row.id : "";
    if (!id) continue;
    const display = typeof row.display_name === "string" ? row.display_name : "";
    out.push(display && display !== id ? { id, label: display } : { id });
  }
  return out;
}

// ---- CLI model discovery ----
// No standard exists, so each CLI is asked the way it actually answers,
// checked against the installed binaries (2026-09-11):
//
//   agy     `agy models` prints "<id>\t<label>" per line, after a
//           "Fetching available models..." preamble — a real list.
//   claude  no models command, but its `--model` help documents what it
//           takes ("an alias ... 'fable', 'opus', or 'sonnet' ... or a
//           model's full name (e.g. 'claude-fable-5')"), so the quoted
//           tokens in that paragraph ARE the answer.
//   codex   neither: `-m/--model` is documented as "Model the agent should
//           use", naming nothing — so this returns an empty list and the
//           field says so rather than inventing ids.
//
// Best-effort by nature: a CLI that rewords its help or drops a subcommand
// yields an empty list, never a crash and never a guess.

const CLI_LIST_TIMEOUT_MS = 20_000;

function runCliCapture(bin: string, args: string[]): Promise<string> {
  return new Promise((resolve) => {
    const child = execFile(
      bin,
      args,
      { encoding: "utf8", timeout: CLI_LIST_TIMEOUT_MS, maxBuffer: MAX_BUFFER },
      (err, stdout) => {
        // Help text often exits non-zero, and an unknown subcommand isn't
        // worth an error here — whatever was printed is what gets parsed.
        resolve(err && !stdout ? "" : stdout);
      },
    );
    child.stdin?.end();
  });
}

// "<id>\t<label>" lines, ignoring everything else the command prints.
function parseCliModelLines(out: string): AiModelOption[] {
  const models: AiModelOption[] = [];
  for (const line of out.split("\n")) {
    const tab = line.indexOf("\t");
    if (tab <= 0) continue;
    const id = line.slice(0, tab).trim();
    const label = line.slice(tab + 1).trim();
    if (!id || /\s/.test(id)) continue;
    models.push(label && label !== id ? { id, label } : { id });
  }
  return models;
}

// The quoted tokens inside a CLI's own --model help — the names it
// documents. Anything containing whitespace or a period is prose, not an id.
function parseHelpModelNames(out: string): AiModelOption[] {
  const paragraph = /--model[^\n]*\n(?:[ \t]{2,}[^\n]*\n)*/.exec(out)?.[0] ?? "";
  const ids = new Set<string>();
  for (const match of paragraph.matchAll(/'([^']{2,60})'/g)) {
    const id = match[1].trim();
    if (id && !/[\s.]/.test(id)) ids.add(id);
  }
  return [...ids].map((id) => ({ id }));
}

async function listCliModels(profile: AiProfile): Promise<AiModelOption[]> {
  // The profile's provider is an agent id; the agent knows its own binary and
  // whether it has a model-listing subcommand.
  const agent = await findAgent(profile.provider);
  const bin = profile.binaryPath || agent?.program || profile.provider;
  const listCommand = agent?.oneShot?.listModelsArgs ?? [];
  if (listCommand.length > 0) {
    const models = parseCliModelLines(await runCliCapture(bin, [...listCommand]));
    if (models.length > 0) return models;
  }
  // The help text is the fallback: for a CLI with no list subcommand, and
  // for one whose subcommand printed nothing usable (not signed in, offline).
  return parseHelpModelNames(await runCliCapture(bin, ["--help"]));
}

// The models the profile's own endpoint offers. Throws AiError — the same
// typed codes runAi uses, so the caller tells "no key yet" from "the
// endpoint broke" from "this provider has no such list".
export async function listProviderModels(profileId?: string): Promise<AiModelOption[]> {
  const profile = await resolveProfile(profileId);
  if (profile.provider === "anthropic") {
    const key = await resolveKey(profile, !!profile.baseUrl);
    const models: AiModelOption[] = [];
    let after = "";
    for (let page = 0; page < MODEL_MAX_PAGES; page++) {
      const url = new URL(endpoint(profile.baseUrl, ANTHROPIC_DEFAULT_BASE, "models"));
      url.searchParams.set("limit", String(MODEL_PAGE_LIMIT));
      if (after) url.searchParams.set("after_id", after);
      const data = await getJson(
        url.toString(),
        { ...(key ? { "x-api-key": key } : {}), "anthropic-version": ANTHROPIC_VERSION },
        "anthropic",
      );
      models.push(...modelsFromData(data.data));
      const lastId = typeof data.last_id === "string" ? data.last_id : "";
      if (data.has_more !== true || !lastId) break;
      after = lastId;
    }
    return models;
  }
  if (profile.provider === "openai") {
    const key = await resolveKey(profile, !!profile.baseUrl);
    const data = await getJson(
      endpoint(profile.baseUrl, OPENAI_DEFAULT_BASE, "models"),
      key ? { authorization: `Bearer ${key}` } : {},
      "openai",
    );
    // Alphabetical: this route returns creation order, which for a big
    // catalogue reads as random.
    return modelsFromData(data.data).sort((a, b) => a.id.localeCompare(b.id));
  }
  if (profile.provider === "custom") {
    throw new AiError(
      "unsupported",
      `"${profile.label}" is a command line you wrote - only you know which models it takes.`,
    );
  }
  return listCliModels(profile);
}

// Models wrap a reply in a code fence even when told not to. Only a fence on
// the very first and very last line is stripped, so a reply that legitimately
// quotes a fenced block keeps it.
function stripWrappingFence(reply: string): string {
  const lines = reply.replace(/\r\n/g, "\n").trim().split("\n");
  if (lines.length >= 2 && /^```/.test(lines[0]) && /^```\s*$/.test(lines[lines.length - 1])) {
    return lines.slice(1, -1).join("\n").trim();
  }
  return lines.join("\n").trim();
}

export interface AiRunOptions {
  // Which configured AI to use (see listAiProfiles). Omitted — or naming a
  // profile the user has since removed or disabled — falls back to the
  // default profile.
  profileId?: string;
  // Overrides the profile's own model for this one call — for a caller whose
  // task wants a different size of model than the user's default.
  model?: string;
  // Working directory for a CLI provider. Some CLIs refuse to run outside a
  // trusted directory ("Not inside a trusted directory" from `codex exec`),
  // so a caller that knows which project it is acting on should say so rather
  // than inherit wherever the server happens to have been started. Ignored by
  // the API providers, which have no notion of a working directory.
  cwd?: string;
  // How long to wait for this one call, when the default 60s is the wrong
  // budget for the job: a CLI agent told to read the repository under `cwd`
  // before answering routinely runs for minutes. Clamped to [1s, 15min], so
  // the option can lengthen a wait but never remove the ceiling. Omitted
  // leaves every caller on the default.
  timeoutMs?: number;
}

// The wait one call gets, from the option or the default.
function effectiveTimeout(opts: AiRunOptions): number {
  const wanted = opts.timeoutMs;
  if (typeof wanted !== "number" || !Number.isFinite(wanted)) return TIMEOUT_MS;
  return Math.min(MAX_TIMEOUT_MS, Math.max(1_000, Math.floor(wanted)));
}

// Prompt in, text out. Throws AiError; never returns an empty string.
export async function runAi(prompt: string, opts: AiRunOptions = {}): Promise<string> {
  if (!prompt.trim()) throw new AiError("provider-failed", "prompt is empty");
  const profile = await resolveProfile(opts.profileId);
  const model = opts.model?.trim() || profile.model;
  const timeoutMs = effectiveTimeout(opts);

  let raw: string;
  if (profile.provider === "anthropic") {
    raw = await runAnthropic(prompt, model, profile, timeoutMs);
  } else if (profile.provider === "openai") {
    raw = await runOpenai(prompt, model, profile, timeoutMs);
  } else if (profile.provider === "custom") {
    if (!profile.customCommand) {
      throw new AiError(
        "missing-command",
        `"${profile.label}" needs a command - set one in Settings → AI Providers`,
      );
    }
    // The user's own command line, with the prompt appended as its single
    // argument — quoting inside the command is theirs, and the prompt itself
    // never needs any. Via sh ($0 of the -c script); on Windows via
    // PowerShell, where the prompt rides in an environment variable so
    // nothing in it is ever parsed as PowerShell.
    raw = process.platform === "win32"
      ? await runCli(
          "powershell.exe",
          ["-NoProfile", "-NonInteractive", "-Command", `${profile.customCommand} $env:PERCH_PROMPT`],
          "custom",
          opts.cwd,
          { PERCH_PROMPT: prompt },
          timeoutMs,
        )
      : await runCli("/bin/sh", ["-c", `${profile.customCommand} "$0"`, prompt], "custom", opts.cwd, undefined, timeoutMs);
  } else {
    // Any provider that is not an API kind names an agent. Its manifest says
    // how to run one prompt; core fills the template in and spawns it.
    const agent = await findAgent(profile.provider);
    if (!agent?.oneShot) {
      throw new AiError(
        "missing-command",
        `"${profile.label}" points at an agent that cannot answer a single prompt - pick another AI in Settings → AI Providers`,
      );
    }
    raw = await runCli(
      profile.binaryPath || agent.program,
      oneShotArgs(agent.oneShot, prompt, model),
      profile.provider,
      opts.cwd,
      undefined,
      timeoutMs,
    );
  }

  const text = stripWrappingFence(raw);
  if (!text) throw new AiError("empty-reply", `${profile.label} returned an empty reply`);
  return text;
}
