import { Fragment, useEffect, useState } from "react";
import { fetchAiProfiles, type AiProfileOption } from "../../api";
import type { RegisteredSettingsComponent } from "../../extensions";
import { placeSettingsComponents } from "../../lib/settingsComponents";
import type { ExtensionInfo } from "../../types";
import AiModelField from "./AiModelField";
import { NumberField } from "./controls";
import { useSettingsContext } from "./context";

// Renders one control per declared contributes.configuration property,
// grouped by the manifest's own configuration sections (title optional).
// Write-back is sparse: setting a value back to its declared default removes
// the override entirely (see setValue) — same rationale as keybinding
// overrides, so a future manifest default change still reaches a user who
// never customized that property. Bounds default to a wide ±1e9 when the
// schema omits minimum/maximum, since NumberField requires both.
// Every provider but "custom" can produce a list — the API ones over HTTP,
// the CLIs by running them (server/src/ai.ts's listCliModels). A custom
// command line is the one thing nothing can enumerate.
const UNLISTABLE_PROVIDER = "custom";

type ConfigProperty = ExtensionInfo["configuration"][number]["properties"][number];

function ExtensionProperties({
  ext,
  overrides,
  onChange,
  anchored,
}: {
  ext: ExtensionInfo;
  overrides: Record<string, unknown>;
  onChange: (next: Record<string, unknown>) => void;
  // Settings components placed after a particular property - see
  // lib/settingsComponents.ts.
  anchored: Map<string, RegisteredSettingsComponent[]>;
}) {
  // For "ai-profile"/"ai-model" properties — every AI a job may be pointed at.
  //
  // Fetched rather than read from the settings document, because the document
  // no longer holds all of them: the API providers are stored there, but a
  // CLI comes from whichever agent declared it and is synthesised server-side
  // (plans/cli-providers-from-agents.md). Falls back to the stored list if
  // the request fails, so an offline or older server still renders a picker.
  const { settings } = useSettingsContext();
  const [resolvedProfiles, setResolvedProfiles] = useState<AiProfileOption[] | null>(null);
  useEffect(() => {
    let live = true;
    fetchAiProfiles()
      .then((list) => {
        if (live) setResolvedProfiles(list);
      })
      .catch(() => {
        if (live) setResolvedProfiles(null);
      });
    return () => {
      live = false;
    };
  }, []);
  const aiProfiles =
    resolvedProfiles ??
    settings.aiProfiles
      .filter((p) => p.enabled)
      .map((p) => ({
        id: p.id,
        label: p.label,
        provider: p.provider,
        model: p.model,
        // Unknown from the document alone; only the fallback path uses this
        // shape, and nothing here reads the binary name.
        program: "",
        isDefault: p.id === settings.aiProfileId,
      }));
  // This extension's own profile choice, whatever it called that property —
  // an "ai-model" box reads it to show the right fallback. One picker per
  // extension is the convention; the first one declared wins.
  const profileKey = ext.configuration
    .flatMap((section) => section.properties)
    .find((p) => p.format === "ai-profile")?.key;
  const selectedAiProfileId =
    profileKey && typeof overrides[profileKey] === "string" ? (overrides[profileKey] as string) : "";
  const setValue = (key: string, value: unknown, def: unknown) => {
    const next = { ...overrides };
    if (value === def) delete next[key];
    else next[key] = value;
    onChange(next);
  };

  const renderRow = (prop: ConfigProperty) => {
    const value = prop.key in overrides ? overrides[prop.key] : prop.default;
    const label = prop.description || prop.key;

    if (prop.type === "boolean") {
      return (
        <label key={prop.key} className="settings-row checkbox-row" title={prop.key}>
          <input
            type="checkbox"
            checked={Boolean(value)}
            onChange={(e) => setValue(prop.key, e.target.checked, prop.default)}
          />
          <span>{label}</span>
        </label>
      );
    }

    if (prop.type === "number" || prop.type === "integer") {
      const numericValue = typeof value === "number" ? value : Number(prop.default) || 0;
      return (
        <label key={prop.key} className="settings-row" title={prop.key}>
          <span className="settings-label">{label}</span>
          <NumberField
            value={numericValue}
            min={prop.minimum ?? -1e9}
            max={prop.maximum ?? 1e9}
            step={prop.type === "integer" ? 1 : 0.1}
            onCommit={(v) => setValue(prop.key, prop.type === "integer" ? Math.round(v) : v, prop.default)}
          />
        </label>
      );
    }

    // A model box that knows what it would fall back to: the model
    // configured on whichever profile this extension is pointed at
    // (its own "ai-profile" property, else the app default), so the
    // placeholder answers "and what do I get if I leave this empty?"
    // without anyone opening Settings → AI Providers to look.
    if (prop.format === "ai-model") {
      // Which profile would answer if this box stays empty — the
      // extension's own pick, else the app default. Mirrors ai.ts's
      // resolveProfile, so the placeholder names the AI that would
      // really run.
      // The server list is already enabled-only and marks its own
      // default, so this mirrors resolveProfile without re-deriving
      // "enabled" on the client.
      const chosen =
        aiProfiles.find((p) => p.id === selectedAiProfileId) ??
        aiProfiles.find((p) => p.isDefault) ??
        aiProfiles[0];
      const fallback = chosen?.model
        ? `${chosen.model} (from ${chosen.label})`
        : chosen
          ? `${chosen.label}'s own default`
          : "the provider's own default";
      return (
        <div key={prop.key} className="settings-row" title={prop.key}>
          <span className="settings-label">{label}</span>
          <AiModelField
            // Namespaced by property key: two extensions' model
            // fields must not share one <datalist>.
            id={prop.key}
            value={typeof value === "string" ? value : ""}
            // "" is "the app default", which the server resolves the
            // same way this placeholder does.
            profileId={selectedAiProfileId}
            fetchable={!!chosen && chosen.provider !== UNLISTABLE_PROVIDER}
            placeholder={`Leave empty for ${fallback}`}
            hint={`Runs on ${chosen ? chosen.label : "the app's default AI"}.`}
            onChange={(next) => setValue(prop.key, next, prop.default)}
          />
        </div>
      );
    }

    // An AI picker rather than a text box for the profile id: the
    // ids come from Settings → AI Providers, and nobody should have to type
    // one. Empty means "whatever the default profile is", which is
    // also what ctx.ai.run does with an empty profileId.
    if (prop.format === "ai-profile") {
      return (
        <label key={prop.key} className="settings-row" title={prop.key}>
          <span className="settings-label">{label}</span>
          <select
            className="dialog-input settings-select"
            value={typeof value === "string" ? value : ""}
            onChange={(e) => setValue(prop.key, e.target.value, prop.default)}
          >
            <option value="">App default</option>
            {aiProfiles.map((p) => (
              <option key={p.id} value={p.id}>
                {p.label}
                {p.model ? ` · ${p.model}` : ""}
              </option>
            ))}
          </select>
          <div className="settings-hint">Configure the list in Settings → AI Providers.</div>
        </label>
      );
    }

    if (prop.enum && prop.enum.length > 0) {
      return (
        <label key={prop.key} className="settings-row" title={prop.key}>
          <span className="settings-label">{label}</span>
          <select
            className="dialog-input settings-select"
            value={String(value)}
            onChange={(e) => setValue(prop.key, e.target.value, prop.default)}
          >
            {prop.enum.map((opt, optIndex) => (
              <option key={opt} value={opt} title={prop.enumDescriptions?.[optIndex]}>
                {prop.enumItemLabels?.[optIndex] ?? opt}
              </option>
            ))}
          </select>
        </label>
      );
    }

    return (
      <label key={prop.key} className="settings-row" title={prop.key}>
        <span className="settings-label">{label}</span>
        <input
          className="dialog-input"
          value={typeof value === "string" ? value : String(value ?? "")}
          onChange={(e) => setValue(prop.key, e.target.value, prop.default)}
        />
      </label>
    );
  };

  return (
    <>
      {ext.configuration.map((section, sectionIndex) => (
        <div key={sectionIndex}>
          {section.title && <h3 className="settings-subsection-title">{section.title}</h3>}
          {section.properties.map((prop) => (
            <Fragment key={prop.key}>
              {renderRow(prop)}
              {anchored.get(prop.key)?.map((c) => <c.component key={c.id} />)}
            </Fragment>
          ))}
        </div>
      ))}
    </>
  );
}

// `components` are this extension's registered settings components. Each
// renders after the property its `after` names, the rest below every scalar
// control - which is where all of them rendered before placement existed.
export default function ExtensionConfigSection({
  ext,
  components,
}: {
  ext: ExtensionInfo;
  components: readonly RegisteredSettingsComponent[];
}) {
  const { extensionSettings, onExtensionSettingsChange } = useSettingsContext();
  const { anchored, trailing } = placeSettingsComponents(
    components,
    ext.configuration.flatMap((section) => section.properties.map((prop) => prop.key)),
  );

  return (
    <>
      <h2 className="settings-section-title">{ext.displayName}</h2>
      <ExtensionProperties
        ext={ext}
        overrides={extensionSettings[ext.id] ?? {}}
        onChange={(next) => {
          const nextAll = { ...extensionSettings };
          if (Object.keys(next).length === 0) delete nextAll[ext.id];
          else nextAll[ext.id] = next;
          onExtensionSettingsChange(nextAll);
        }}
        anchored={anchored}
      />
      {trailing.map((c) => (
        <c.component key={c.id} />
      ))}
    </>
  );
}
