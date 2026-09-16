import { useEffect, useState } from "react";
import { getAiModels, type AiModelOption } from "../../api";

// A model name, with the endpoint's own list behind it. Used twice: by the
// profile editor in Settings → AI Providers, and by an extension's `"ai-model"`
// property, which picks a model for that one feature (see
// ExtensionConfigSection). Both want the same three things — a text box, a
// way to pull the list, and an honest fallback hint — so the fetching lives
// here rather than in each.
//
// It stays a TEXT box with suggestions, never a plain dropdown: an
// OpenAI-compatible endpoint will often serve models its /models route
// doesn't list, and a CLI provider has no list at all.

export default function AiModelField({
  id,
  value,
  placeholder,
  hint,
  // The profile whose endpoint answers. "" is the user's default profile —
  // the same thing an empty profileId means to ai.run.
  profileId,
  // Whether that profile can even be asked: only the API providers have a
  // models route. A CLI or custom-command profile gets no button.
  fetchable,
  onChange,
}: {
  // Distinguishes this field's <datalist> from every other one on the page.
  id: string;
  value: string;
  placeholder: string;
  hint: string;
  profileId: string;
  fetchable: boolean;
  onChange: (value: string) => void;
}) {
  const [models, setModels] = useState<AiModelOption[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Whatever changes which endpoint would answer invalidates the list.
  useEffect(() => {
    setModels(null);
    setError(null);
  }, [profileId, fetchable]);

  // Only the profile id goes to the server, never an endpoint or key: the
  // server reads both from its own stored settings. A client that could
  // name the URL to call would be a way to point a stored API key at an
  // arbitrary host. The cost is that a just-typed endpoint has to have
  // synced (a beat after typing) before this reflects it.
  const fetchModels = async () => {
    setBusy(true);
    setError(null);
    try {
      const data = await getAiModels(profileId);
      setModels(data.models);
      if (data.models.length === 0) setError("This provider listed no models - type the id it expects.");
    } catch (err) {
      setModels(null);
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const listId = `ai-models-${id}`;

  return (
    <>
      <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
        <input
          className="dialog-input"
          style={{ flex: 1 }}
          list={listId}
          placeholder={placeholder}
          value={value}
          onChange={(e) => onChange(e.target.value)}
        />
        {fetchable && (
          <button className="dialog-button secondary" disabled={busy} onClick={() => void fetchModels()}>
            {busy ? "Fetching…" : models ? "Refresh" : "Fetch models"}
          </button>
        )}
      </div>
      <datalist id={listId}>
        {(models ?? []).map((m) => (
          <option key={m.id} value={m.id}>
            {m.label ?? m.id}
          </option>
        ))}
      </datalist>
      {error ? (
        <div className="settings-hint settings-error">{error}</div>
      ) : models ? (
        <div className="settings-hint">
          {models.length} model{models.length === 1 ? "" : "s"} offered - type to filter, or enter any
          id this provider accepts.
        </div>
      ) : (
        <div className="settings-hint">{hint}</div>
      )}
    </>
  );
}
