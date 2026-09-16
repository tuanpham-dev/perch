import { useCallback, useEffect, useRef, useState } from "react";
import { fetchAiProfiles, getAiCliStatus, getAiKeyStatus, setAiKey, type AiKeyStatus, type AiProfileOption } from "../../api";
import { API_PROVIDER_IDS, type AiProfile, type AiProviderId, type AppSettings } from "../../settings";
import Icon from "../Icon";
import AiModelField from "./AiModelField";
import { useSettingsContext } from "./context";

// Settings → AI Providers. One place answers "which AI do I have?", for the app and
// every extension that asks for one (plans/core-ai-providers.md) — the
// commit-message button in SOURCE CONTROL, AI Command Search, and the prompt
// editor's Refine all run through what is configured here.
//
// Several can be configured at once: a CLI you're already signed into for
// the everyday jobs, a keyed API for the ones worth paying for. One is the
// default (what a caller that doesn't care gets), and an extension can point
// its own feature at any of the others through an "ai-profile" setting of
// its own — see ExtensionConfigSection's picker.

// What you can ADD here: API providers only. The CLIs are not in this list on
// purpose - every agent in the group above that can answer a single prompt is
// already offered as a provider, without anyone adding it, and listing them
// here too would have been the same CLI defined in two places
// (plans/cli-providers-from-agents.md).
const PROVIDERS: { id: AiProviderId; label: string; hint: string }[] = [
  { id: "anthropic", label: "Anthropic API (key)", hint: "Anthropic's Messages format - to Anthropic, or to any compatible endpoint you set below. Defaults to claude-opus-5 when no model is set." },
  { id: "openai", label: "OpenAI API (key)", hint: "OpenAI's chat-completions format - to OpenAI, or to any compatible endpoint you set below. A model is required." },
  { id: "custom", label: "Custom command", hint: "Any command that takes the prompt as its last argument and prints the reply." },
];

const KEYED_PROVIDERS: AiProviderId[] = ["anthropic", "openai"];

// A profile whose provider is not one of the addable kinds above came from an
// agent, and the agent owns its command line - so the row shows what it is
// rather than offering to edit it.
function isAgentProvider(provider: AiProviderId): boolean {
  return !PROVIDERS.some((p) => p.id === provider);
}

function providerLabel(id: AiProviderId): string {
  return PROVIDERS.find((p) => p.id === id)?.label ?? id;
}

// Provider options for the Add picker and for an editable row. Only the API
// kinds appear; an agent-derived row does not render this control at all, so
// `selected` exists for the one case where a stored profile still names an
// agent - it stays listed and selectable rather than silently switching to
// something else.
function providerOptions(cliStatus: Record<string, boolean> | null, selected?: AiProviderId) {
  const options = PROVIDERS.some((p) => p.id === selected) || !selected
    ? PROVIDERS
    : [...PROVIDERS, { id: selected, label: providerLabel(selected), hint: "" }];
  return options.map((p) => {
    const missing = !!cliStatus && isAgentProvider(p.id) && !cliStatus[p.id];
    const disabled = missing && p.id !== selected;
    return (
      <option key={p.id} value={p.id} disabled={disabled}>
        {p.label}
        {missing ? " - not installed" : ""}
      </option>
    );
  });
}

// Short and readable rather than random: "openai", "openai-2", … Ids are
// stored by extensions and used as the API key's storage key, so they must
// be stable, unique, and safe as a plain object key.
function makeProfileId(provider: AiProviderId, taken: readonly string[]): string {
  if (!taken.includes(provider)) return provider;
  for (let n = 2; ; n++) {
    const candidate = `${provider}-${n}`;
    if (!taken.includes(candidate)) return candidate;
  }
}


// The key never comes back from the server, so the field is a write-only box
// over a boolean: it shows whether one is stored, and typing replaces it.
function ApiKeyField({
  profile,
  stored,
  optional,
  onChanged,
}: {
  profile: AiProfile;
  stored: boolean;
  // A custom endpoint may need no auth at all (a local Ollama), so the field
  // says so rather than implying the call will fail without one.
  optional: boolean;
  onChanged: () => void;
}) {
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async (key: string) => {
    setBusy(true);
    setError(null);
    try {
      await setAiKey(profile.id, key);
      setDraft("");
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="settings-row">
      <span className="settings-label">
        API key{" "}
        <span className="settings-hint">
          - {stored ? "stored" : optional ? "not set (optional for this endpoint)" : "not set"}
        </span>
      </span>
      <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
        <input
          className="dialog-input"
          style={{ flex: 1 }}
          type="password"
          autoComplete="off"
          placeholder={stored ? "Stored - type to replace" : `Paste your ${profile.provider} API key`}
          value={draft}
          disabled={busy}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && draft.trim()) void save(draft);
          }}
        />
        <button className="dialog-button primary" disabled={busy || !draft.trim()} onClick={() => void save(draft)}>
          Save
        </button>
        {stored && (
          <button className="dialog-button secondary" disabled={busy} onClick={() => void save("")}>
            Clear
          </button>
        )}
      </div>
      {error && <div className="settings-hint settings-error">{error}</div>}
    </div>
  );
}

// One profile's own fields, shown while it's expanded.
function ProfileEditor({
  profile,
  keys,
  cliStatus,
  derived,
  program,
  onChange,
  onKeysChanged,
}: {
  profile: AiProfile;
  keys: AiKeyStatus | null;
  cliStatus: Record<string, boolean> | null;
  // Supplied by an agent rather than added here: the agent owns which CLI
  // this is, so the provider is shown rather than offered as a choice.
  // Repointing it would shadow the agent's own row with something unrelated
  // under the agent's id.
  derived: boolean;
  // The command this profile actually runs. For an agent-supplied one the
  // provider id is "perch.agents.codex" while the binary is "codex",
  // and the binary is what a user would look for on their PATH.
  program: string;
  onChange: (next: AiProfile) => void;
  onKeysChanged: () => void;
}) {
  const hint = PROVIDERS.find((p) => p.id === profile.provider)?.hint;
  const isCli = isAgentProvider(profile.provider);
  // A binary path is the escape hatch for a CLI that isn't on the server's
  // PATH (a version manager's shim, a checkout), so it silences the warning.
  // cliStatus is keyed by agent id (the registry's own probe), which is what
  // `provider` holds for a CLI - so this lookup stays correct even though the
  // message it feeds names the binary instead.
  const cliMissing = isCli && !!cliStatus && !cliStatus[profile.provider] && !profile.binaryPath.trim();
  const keyed = KEYED_PROVIDERS.includes(profile.provider);
  const storedKey = !!keys?.has?.[profile.id];

  return (
    <div className="settings-entry-editor">
      <div className="settings-row">
        <span className="settings-label">Name</span>
        <input
          className="dialog-input"
          value={profile.label}
          placeholder={providerLabel(profile.provider)}
          onChange={(e) => onChange({ ...profile, label: e.target.value })}
        />
        <div className="settings-hint">What pickers call this one - yours to name.</div>
      </div>

      <div className="settings-row">
        <span className="settings-label">Provider</span>
        {derived ? (
          <div className="settings-hint">
            Supplied by the <strong>{profile.label}</strong> agent above. Set a model here if you want
            something other than its own default; everything else about it belongs to the agent.
          </div>
        ) : (
          <select
            className="dialog-input settings-select"
            value={profile.provider}
            onChange={(e) => onChange({ ...profile, provider: e.target.value as AiProviderId })}
          >
            {providerOptions(cliStatus, profile.provider)}
          </select>
        )}
        {cliMissing ? (
          <div className="settings-hint settings-error">
            No <code>{program || profile.provider}</code> on the server&apos;s PATH - install it, or give this
            profile a binary path below.
          </div>
        ) : (
          hint && <div className="settings-hint">{hint}</div>
        )}
      </div>

      {keyed && (
        <div className="settings-row">
          <span className="settings-label">Endpoint</span>
          <input
            className="dialog-input"
            placeholder={
              profile.provider === "openai" ? "https://api.openai.com/v1" : "https://api.anthropic.com/v1"
            }
            value={profile.baseUrl}
            onChange={(e) => onChange({ ...profile, baseUrl: e.target.value })}
          />
          <div className="settings-hint">
            Leave empty for {profile.provider === "openai" ? "OpenAI" : "Anthropic"} itself. Set it to
            send the same request format to any compatible service - OpenRouter, Groq, Together,
            LiteLLM, or a local Ollama - including the version segment, e.g.{" "}
            <code>https://openrouter.ai/api/v1</code>.
          </div>
        </div>
      )}

      {keyed && (
        <ApiKeyField
          profile={profile}
          stored={storedKey}
          optional={!!profile.baseUrl.trim()}
          onChanged={onKeysChanged}
        />
      )}

      <div className="settings-row">
        <span className="settings-label">Model</span>
        <AiModelField
          id={profile.id}
          value={profile.model}
          profileId={profile.id}
          // Every provider but "custom" can be asked for a list — the API
          // ones over HTTP, the CLIs by running them (see ai.ts's
          // listCliModels). A command line the user wrote has no answer.
          fetchable={profile.provider !== "custom"}
          placeholder={
            profile.provider === "openai"
              ? "Required for the OpenAI API, e.g. gpt-4.1-mini"
              : profile.provider === "anthropic"
                ? "claude-opus-5"
                : "Leave empty for the CLI's own default"
          }
          hint="A smaller, faster model is usually the better choice for short jobs like writing a commit message."
          onChange={(model) => onChange({ ...profile, model })}
        />
      </div>

      {isCli && (
        <div className="settings-row">
          <span className="settings-label">Binary path</span>
          <input
            className="dialog-input"
            placeholder={`Leave empty to use "${program || profile.provider}" from PATH`}
            value={profile.binaryPath}
            onChange={(e) => onChange({ ...profile, binaryPath: e.target.value })}
          />
        </div>
      )}

      {profile.provider === "custom" && (
        <div className="settings-row">
          <span className="settings-label">Command</span>
          <input
            className="dialog-input"
            placeholder="my-llm --quiet"
            value={profile.customCommand}
            onChange={(e) => onChange({ ...profile, customCommand: e.target.value })}
          />
          <div className="settings-hint">
            Run as <code>sh -c &apos;&lt;command&gt; &quot;$0&quot;&apos;</code> with the prompt as the
            single trailing argument, so your own quoting is preserved. On Windows it runs in PowerShell
            the same way.
          </div>
        </div>
      )}
    </div>
  );
}

export default function AiSection() {
  const { settings, onSettingsChange } = useSettingsContext();
  // One write per change, however many keys it touches. The context's own
  // `set` rebuilds from the `settings` of the render it was called in, so
  // two calls in a row (list + default) would have the second overwrite the
  // first — caught in QA, where seeding wrote the profile list and then
  // immediately dropped it again.
  const patch = (next: Partial<AppSettings>) => onSettingsChange({ ...settings, ...next });
  const [keys, setKeys] = useState<AiKeyStatus | null>(null);
  // null until the probe answers — everything renders as available until
  // then rather than flashing every CLI as missing.
  const [cliStatus, setCliStatus] = useState<Record<string, boolean> | null>(null);
  // Every AI the server will actually resolve: the stored API providers plus
  // one per agent that can answer a single prompt. null while unknown, and on
  // failure, so nothing is pruned or hidden on a guess.
  const [resolvedProfiles, setResolvedProfiles] = useState<AiProfileOption[] | null>(null);
  const refreshResolved = useCallback(() => {
    fetchAiProfiles()
      .then(setResolvedProfiles)
      .catch(() => setResolvedProfiles(null));
  }, []);
  useEffect(refreshResolved, [refreshResolved]);
  const usableIds = resolvedProfiles === null ? null : new Set(resolvedProfiles.map((p) => p.id));
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [addProvider, setAddProvider] = useState<AiProviderId>("anthropic");

  const refreshKeys = () => {
    getAiKeyStatus()
      .then(setKeys)
      .catch(() => setKeys(null));
  };
  useEffect(refreshKeys, []);
  useEffect(() => {
    getAiCliStatus()
      .then(setCliStatus)
      .catch(() => setCliStatus(null));
  }, []);

  const profiles = settings.aiProfiles;

  // One-time cleanup of profiles that should not be in this list.
  //
  // A CLI provider used to be a literal here ("claude", "codex", "agy"); they
  // are agent ids now, so a profile stored under the old name resolves to
  // nothing and the backend already ignores it. Leaving it listed was worse
  // than dropping it: the row could not be made to work, and it claimed to be
  // the default while the server quietly answered with something else. The
  // CLI it named is still available - as the agent of the same name in the
  // group above, which is where it comes from now.
  //
  // Guarded three ways: only once the server has actually told us which ids
  // resolve (never on a failed request), only when something would change,
  // and only once per mount.
  const prunedRef = useRef(false);
  useEffect(() => {
    if (usableIds === null || prunedRef.current) return;
    // Two kinds go. One: a provider the server cannot resolve at all (a CLI
    // stored under its old bare name, before CLIs became agent ids). Two: a
    // provider that IS an agent - agents supply themselves, so a stored copy
    // would list the same agent a second time as an editable row, and the
    // model for the default one lives in aiDefaultModel rather than here.
    const kept = profiles.filter((p) => usableIds.has(p.id) && !isAgentProvider(p.provider));
    if (kept.length === profiles.length) return;
    prunedRef.current = true;
    const next: Partial<AppSettings> = { aiProfiles: kept };
    // A default that pointed at a dropped profile has to go too, or it names
    // an id that is not in the list any more.
    if (!kept.some((p) => p.id === settings.aiProfileId)) next.aiProfileId = "";
    patch(next);
  }, [usableIds, profiles, settings.aiProfileId]);


  const update = (id: string, next: AiProfile) =>
    patch({ aiProfiles: profiles.map((p) => (p.id === id ? next : p)) });

  const add = () => {
    const id = makeProfileId(addProvider, profiles.map((p) => p.id));
    patch({
      aiProfiles: [
        ...profiles,
        {
          id,
          label: providerLabel(addProvider),
          provider: addProvider,
          model: "",
          binaryPath: "",
          customCommand: "",
          baseUrl: "",
          enabled: true,
        },
      ],
    });
    setExpandedId(id);
  };

  const remove = (id: string) => {
    patch({
      aiProfiles: profiles.filter((p) => p.id !== id),
      ...(settings.aiProfileId === id ? { aiProfileId: "" } : {}),
    });
    if (expandedId === id) setExpandedId(null);
    // The stored key is deliberately left alone: removing a profile by
    // accident shouldn't cost a key that can't be read back to restore.
  };

  return (
    <>
      <div className="settings-entry-list">
        {profiles.map((profile) => {
          const isExpanded = expandedId === profile.id;

          return (
            <div key={profile.id} className={`settings-entry${isExpanded ? " expanded" : ""}`}>
              <div className="settings-entry-head">
                <input
                  type="checkbox"
                  checked={profile.enabled}
                  title={profile.enabled ? "Enabled - uncheck to keep it but stop offering it" : "Disabled"}
                  onChange={(e) => update(profile.id, { ...profile, enabled: e.target.checked })}
                />
                <button
                  className="settings-entry-name"
                  onClick={() => setExpandedId(isExpanded ? null : profile.id)}
                  aria-expanded={isExpanded}
                >
                  <Icon name={isExpanded ? "chevron-down" : "chevron-right"} />
                  <span>{profile.label || providerLabel(profile.provider)}</span>
                  <span className="settings-hint">
                    {providerLabel(profile.provider)}
                    {profile.model ? ` · ${profile.model}` : ""}
                  </span>
                </button>

                <button className="icon-button" title="Remove" onClick={() => remove(profile.id)}>
                  <Icon name="trash" />
                </button>
              </div>
              {isExpanded && (
                <ProfileEditor
                  profile={profile}
                  keys={keys}
                  cliStatus={cliStatus}
                  derived={isAgentProvider(profile.provider)}
                  program={resolvedProfiles?.find((r) => r.id === profile.id)?.program ?? ""}
                  onChange={(next) => update(profile.id, next)}
                  onKeysChanged={refreshKeys}
                />
              )}
            </div>
          );
        })}
        {profiles.length === 0 && (
          <div className="settings-hint">
            No API provider added. You don&apos;t need one to use an agent above - add one here only for
            an API key or a command of your own.
          </div>
        )}
      </div>

      <div className="settings-row">
        <span className="settings-label">Add</span>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <select
            className="dialog-input settings-select"
            style={{ flex: 1 }}
            value={addProvider}
            onChange={(e) => setAddProvider(e.target.value as AiProviderId)}
          >
            {providerOptions(cliStatus)}
          </select>
          <button className="dialog-button primary" onClick={add}>
            Add
          </button>
        </div>
      </div>
    </>
  );
}
