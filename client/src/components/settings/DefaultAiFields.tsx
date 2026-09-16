// The two choices that decide which AI answers when nothing asks for a
// particular one: the provider, and the model it runs.
//
// One select each, on purpose. The providers they list come from two places -
// the API providers stored below, and every agent above that can answer a
// single prompt - and the point of putting them in one control is that a user
// picking "which AI writes my commit messages" does not care which of those
// two places it came from. Listing the agents a second time as editable rows
// was the first attempt and it was worse: the same agent appeared twice on one
// screen (plans/cli-providers-from-agents.md).
import { useCallback, useEffect, useState } from "react";
import { fetchAiProfiles, getAiModels, type AiModelOption, type AiProfileOption } from "../../api";
import { useSettingsContext } from "./context";

export default function DefaultAiFields() {
  const { settings, onSettingsChange } = useSettingsContext();
  const patch = (next: Partial<typeof settings>) => onSettingsChange({ ...settings, ...next });

  // The agent-supplied entries. Only these need the server: it synthesises
  // one per agent from what that agent declares, and the settings document
  // knows nothing about them.
  //
  // Re-fetched when the agent list changes, because enabling or disabling an
  // agent in the group above adds or removes one of these. Keyed on the ids
  // and flags rather than the array identity, so an unrelated settings write
  // does not refetch.
  const agentSignature = settings.agents.map((a) => `${a.id}:${a.enabled}`).join(",");
  const [serverProfiles, setServerProfiles] = useState<AiProfileOption[] | null>(null);
  useEffect(() => {
    let live = true;
    fetchAiProfiles()
      .then((list) => {
        if (live) setServerProfiles(list);
      })
      .catch(() => {
        if (live) setServerProfiles(null);
      });
    return () => {
      live = false;
    };
  }, [agentSignature]);

  // The API providers come from the settings document directly rather than
  // from that fetch. They have to: adding one writes settings and the write
  // is debounced, so a refetch here would race it and the new provider would
  // not appear until something else re-rendered - which is exactly the bug
  // this replaced. Reading the document is also simply more correct, since
  // the document is what the user just changed.
  const storedOptions: AiProfileOption[] = settings.aiProfiles
    .filter((p) => p.enabled)
    .map((p) => ({
      id: p.id,
      label: p.label || p.provider,
      provider: p.provider,
      model: p.model,
      // Only meaningful for a CLI, and a stored entry here is an API kind.
      program: "",
      isDefault: false,
    }));
  // The server says which agents EXIST and can answer a prompt. Whether one is
  // enabled right now comes from the document, for the same reason the API
  // providers do: the settings write is debounced, so a refetch triggered by a
  // toggle can land before the server has the new value and read back the
  // previous state. That showed up as the list lagging one toggle behind.
  const agentOptions = (serverProfiles ?? [])
    .filter((sp) => !settings.aiProfiles.some((p) => p.id === sp.id))
    .filter((sp) => settings.agents.find((a) => a.id === sp.id)?.enabled !== false);
  // Stored first, then agent-supplied - the same order the server resolves
  // them in, so "the first one" means the same thing on both sides.
  const providers = serverProfiles === null && storedOptions.length === 0 ? null : [...storedOptions, ...agentOptions];

  // Which one is default right now: the stored choice when it still resolves,
  // else the first, which is what the server falls back to. Showing the
  // fallback rather than an empty select is the difference between "nothing
  // is configured" and "this is what answers".
  const storedId = settings.aiProfileId;
  const selectedId = providers?.find((p) => p.id === storedId)?.id ?? providers?.[0]?.id ?? "";

  const [models, setModels] = useState<AiModelOption[] | null>(null);
  const [modelsError, setModelsError] = useState<string | null>(null);
  const [loadingModels, setLoadingModels] = useState(false);

  // Models belong to a provider, so the list is re-fetched whenever the
  // provider changes. Not on mount alone: switching provider and keeping the
  // previous provider's models would offer a model that cannot run.
  const loadModels = useCallback((profileId: string) => {
    if (!profileId) return;
    setLoadingModels(true);
    setModelsError(null);
    getAiModels(profileId)
      .then((body) => setModels(body.models))
      .catch((err: Error) => {
        setModels(null);
        setModelsError(err.message);
      })
      .finally(() => setLoadingModels(false));
  }, []);

  useEffect(() => {
    setModels(null);
    setModelsError(null);
    loadModels(selectedId);
  }, [selectedId, loadModels]);

  const chosen = providers?.find((p) => p.id === selectedId);
  const chosenModel = settings.aiDefaultModel;
  // A model the provider did not list (typed before, or a list that failed to
  // load) still has to be selectable, or switching provider would silently
  // drop it.
  const modelOptions = models ?? [];
  const hasChosen = !chosenModel || modelOptions.some((m) => m.id === chosenModel);

  return (
    <>
      <div className="settings-row">
        <span className="settings-label">Provider</span>
        <select
          id="ai-default-provider"
          className="dialog-input settings-select"
          value={selectedId}
          disabled={providers === null || providers.length === 0}
          onChange={(e) => patch({ aiProfileId: e.target.value, aiDefaultModel: "" })}
        >
          {providers === null && <option value="">Reading the list…</option>}
          {providers?.length === 0 && <option value="">Nothing configured yet</option>}
          {providers?.map((p) => (
            <option key={p.id} value={p.id}>
              {p.label}
            </option>
          ))}
        </select>
        <div className="settings-hint">
          Answers anything that doesn&apos;t ask for a particular AI - commit messages, AI command
          search, prompt refine. The agents above appear here too: an agent that can answer a single
          prompt is a provider without being added.
        </div>
      </div>

      <div className="settings-row">
        <span className="settings-label">Model</span>
        <select
          id="ai-default-model"
          className="dialog-input settings-select"
          value={hasChosen ? chosenModel : ""}
          disabled={!selectedId || loadingModels}
          onChange={(e) => patch({ aiDefaultModel: e.target.value })}
        >
          <option value="">
            {chosen ? `${chosen.label}'s own default` : "The provider's own default"}
          </option>
          {modelOptions.map((m) => (
            <option key={m.id} value={m.id}>
              {m.label ?? m.id}
            </option>
          ))}
          {/* Keep a stored model selectable even when it is not in the list. */}
          {chosenModel && !hasChosen && <option value={chosenModel}>{chosenModel} (not listed)</option>}
        </select>
        <div className="settings-hint">
          {loadingModels
            ? "Asking that provider what it offers…"
            : modelsError
              ? `Could not read its model list: ${modelsError} - leave this on the provider's own default, or pick one after fixing that.`
              : "Applies to the default AI only. An extension pointed at a specific AI keeps that one's model."}
        </div>
      </div>
    </>
  );
}
