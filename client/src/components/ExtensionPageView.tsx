import { useEffect, useMemo, useState } from "react";
import ReactMarkdown from "react-markdown";
import rehypeSanitize from "rehype-sanitize";
import remarkGfm from "remark-gfm";
import * as api from "../api";
import { isOfficialPublisher, parsePublisher } from "../lib/extensionId";
import { compareVersions } from "../lib/version";
import type { ExtensionInfo, RegistrySourceResult } from "../types";
import Icon from "./Icon";

interface Props {
  active: boolean;
  extensionId: string;
  source?: string;
  extensions: ExtensionInfo[];
  registryCatalog: RegistrySourceResult[];
  onReloadExtensions: () => void;
  onOpenExtensionSettings: (id: string) => void;
}

type BodyTab = "details" | "features";

// {source, entry} for whichever registry catalog entry matches id — prefers
// the tab's own recorded source (set when the page was opened from a
// specific registry row) so a second source shipping the same id can't
// silently swap which one a reopened tab shows.
function findRegistryEntry(
  catalog: RegistrySourceResult[],
  id: string,
  preferredSource?: string,
): { source: string; entry: RegistrySourceResult["entries"][number] } | null {
  if (preferredSource) {
    const preferred = catalog.find((s) => s.source === preferredSource);
    const entry = preferred?.entries.find((e) => e.id === id);
    if (entry) return { source: preferredSource, entry };
  }
  for (const src of catalog) {
    const entry = src.entries.find((e) => e.id === id);
    if (entry) return { source: src.source, entry };
  }
  return null;
}

export default function ExtensionPageView({
  active,
  extensionId,
  source,
  extensions,
  registryCatalog,
  onReloadExtensions,
  onOpenExtensionSettings,
}: Props) {
  const [bodyTab, setBodyTab] = useState<BodyTab>("details");
  const [readme, setReadme] = useState<string | null>(null);
  const [readmeLoading, setReadmeLoading] = useState(false);
  const [installing, setInstalling] = useState(false);
  const [pendingUninstall, setPendingUninstall] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const installed = extensions.find((e) => e.id === extensionId) ?? null;
  const registryMatch = findRegistryEntry(registryCatalog, extensionId, source);

  const update =
    installed && registryMatch && compareVersions(registryMatch.entry.version, installed.version) > 0
      ? registryMatch
      : null;

  const displayName = installed?.displayName ?? registryMatch?.entry.displayName ?? extensionId;
  const publisher = registryMatch?.entry.publisher ?? parsePublisher(extensionId);
  const version = installed?.version ?? registryMatch?.entry.version;
  const description = installed?.description ?? registryMatch?.entry.description ?? "";
  const iconUrl = installed?.icon
    ? api.extensionFileUrl(installed.id, installed.icon)
    : registryMatch && registryMatch.entry.hasIcon
      ? api.registryIconUrl(registryMatch.source, extensionId)
      : null;

  const hasReadme = installed ? true : Boolean(registryMatch?.entry.hasReadme);

  useEffect(() => {
    if (!hasReadme) {
      setReadme(null);
      return;
    }
    let cancelled = false;
    setReadmeLoading(true);
    setReadme(null);
    const load = installed
      ? fetch(api.extensionFileUrl(installed.id, "README.md")).then((res) => {
          if (!res.ok) throw new Error("no README");
          return res.text();
        })
      : registryMatch
        ? api.fetchRegistryReadme(registryMatch.source, extensionId)
        : Promise.reject(new Error("not found"));
    load
      .then((text) => {
        if (!cancelled) setReadme(text);
      })
      .catch(() => {
        if (!cancelled) setReadme(null);
      })
      .finally(() => {
        if (!cancelled) setReadmeLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // Re-fetch only when the identity of the subject or its source changes —
    // not on every extensions/registryCatalog re-render (e.g. a poll tick).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [extensionId, installed?.id, registryMatch?.source, hasReadme]);

  const rehypePlugins = useMemo(() => [rehypeSanitize], []);
  const remarkPlugins = useMemo(() => [remarkGfm], []);

  const runInstall = (installSource: string) => {
    setInstalling(true);
    setError(null);
    api
      .installFromRegistry(installSource, extensionId)
      .then(onReloadExtensions)
      .catch((err) => setError(err instanceof Error ? err.message : String(err)))
      .finally(() => setInstalling(false));
  };

  const runUninstall = () => {
    setError(null);
    api
      .uninstallExtension(extensionId)
      .then(onReloadExtensions)
      .catch((err) => setError(err instanceof Error ? err.message : String(err)))
      .finally(() => setPendingUninstall(false));
  };

  const notFound = !installed && !registryMatch;

  return (
    <div className={`settings-host${active ? "" : " hidden"}`}>
      <div className="extension-page">
        {notFound ? (
          <div className="file-tree-empty">
            This extension isn't installed and wasn't found in any configured registry.
          </div>
        ) : (
          <>
            <div className="extension-page-header">
              {iconUrl ? (
                <img src={iconUrl} alt="" className="extension-page-icon" />
              ) : (
                <Icon name="extensions" className="extension-page-icon" />
              )}
              <div className="extension-page-title-block">
                <div className="extension-page-title">
                  {displayName}
                  {installed?.builtin && <span className="extension-row-builtin">Built-in</span>}
                </div>
                <div className="extension-page-meta">
                  {publisher && (
                    <span className="extension-publisher">
                      {isOfficialPublisher(publisher) && <Icon name="verified-filled" className="extension-verified-icon" />}
                      {publisher}
                    </span>
                  )}
                  {version && <span>v{version}</span>}
                  {update && <span>Update available: v{update.entry.version}</span>}
                </div>
                {description && <div className="extension-page-description">{description}</div>}
                <div className="extension-page-actions">
                  {!installed && registryMatch && (
                    <button
                      className="dialog-button primary"
                      disabled={installing}
                      onClick={() => runInstall(registryMatch.source)}
                    >
                      {installing ? "Installing…" : "Install"}
                    </button>
                  )}
                  {installed && update && (
                    <button
                      className="dialog-button primary"
                      disabled={installing}
                      onClick={() => runInstall(update.source)}
                    >
                      {installing ? "Updating…" : `Update to v${update.entry.version}`}
                    </button>
                  )}
                  {installed?.required && (
                    <span className="extension-required-label" title="This extension is part of the app's core surface and cannot be disabled or uninstalled.">
                      Required
                    </span>
                  )}
                  {installed && !installed.required && installed.uninstalled && (
                    <button
                      className="dialog-button primary"
                      onClick={() => {
                        // An uninstalled builtin installs by clearing its
                        // tombstone back to enabled (its bundled files were
                        // never deleted — see the server's setExtensionEnabled).
                        api
                          .setExtensionEnabled(installed.id, true)
                          .then(onReloadExtensions)
                          .catch((err) => setError(err instanceof Error ? err.message : String(err)));
                      }}
                    >
                      Install
                    </button>
                  )}
                  {installed && !installed.required && !installed.uninstalled && (
                    <button
                      className="dialog-button secondary"
                      onClick={() => {
                        api
                          .setExtensionEnabled(installed.id, !installed.enabled)
                          .then(onReloadExtensions)
                          .catch((err) => setError(err instanceof Error ? err.message : String(err)));
                      }}
                    >
                      {installed.enabled ? "Disable" : "Enable"}
                    </button>
                  )}
                  {installed && installed.configuration.length > 0 && (
                    <button
                      className="dialog-button secondary"
                      onClick={() => onOpenExtensionSettings(installed.id)}
                    >
                      Extension Settings
                    </button>
                  )}
                  {installed &&
                    !installed.required &&
                    !installed.uninstalled &&
                    (pendingUninstall ? (
                      <div className="extension-row-confirm">
                        <span>{installed.builtin ? "Uninstall built-in?" : "Uninstall?"}</span>
                        <button className="dialog-button primary" onClick={runUninstall}>
                          Yes
                        </button>
                        <button className="dialog-button secondary" onClick={() => setPendingUninstall(false)}>
                          Cancel
                        </button>
                      </div>
                    ) : (
                      <button className="dialog-button secondary" onClick={() => setPendingUninstall(true)}>
                        Uninstall
                      </button>
                    ))}
                </div>
                {error && <div className="extension-error">{error}</div>}
              </div>
            </div>

            <div className="extension-page-tabs">
              <button
                className={`extension-page-tab${bodyTab === "details" ? " active" : ""}`}
                onClick={() => setBodyTab("details")}
              >
                Details
              </button>
              <button
                className={`extension-page-tab${bodyTab === "features" ? " active" : ""}`}
                onClick={() => setBodyTab("features")}
              >
                Features
              </button>
            </div>

            <div className="extension-page-body">
              {bodyTab === "details" ? (
                readmeLoading ? (
                  <div className="keybinding-empty">Loading…</div>
                ) : readme ? (
                  <div className="extension-page-readme">
                    <ReactMarkdown remarkPlugins={remarkPlugins} rehypePlugins={rehypePlugins}>
                      {readme}
                    </ReactMarkdown>
                  </div>
                ) : (
                  <div className="extension-page-fallback">
                    {description && <p>{description}</p>}
                    <FeaturesList installed={installed} registryEntry={registryMatch?.entry ?? null} />
                  </div>
                )
              ) : (
                <FeaturesList
                  installed={installed}
                  registryEntry={registryMatch?.entry ?? null}
                  showConfiguration
                />
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function FeaturesList({
  installed,
  registryEntry: _registryEntry,
  showConfiguration,
}: {
  installed: ExtensionInfo | null;
  registryEntry: RegistrySourceResult["entries"][number] | null;
  showConfiguration?: boolean;
}) {
  if (!installed) {
    return <div className="keybinding-empty">Install this extension to see its contributed features.</div>;
  }
  const rows: string[] = [];
  if (installed.themes.length > 0) rows.push(`${installed.themes.length} color theme(s)`);
  if (installed.iconThemes.length > 0) rows.push(`${installed.iconThemes.length} icon theme(s)`);
  if (installed.fonts.length > 0) rows.push(`${installed.fonts.length} font group(s)`);
  if (installed.hasClient) rows.push("UI functionality");
  if (installed.hasServer) rows.push("Server functionality");

  return (
    <div className="extension-page-features">
      {rows.length > 0 && (
        <div className="extension-row-contributes">
          {rows.map((r) => (
            <span key={r}>{r}</span>
          ))}
        </div>
      )}
      {rows.length === 0 && <div className="keybinding-empty">No contributions.</div>}
      {showConfiguration && installed.configuration.length > 0 && (
        <table className="extension-page-config-table">
          <thead>
            <tr>
              <th>Setting</th>
              <th>Type</th>
              <th>Default</th>
              <th>Description</th>
            </tr>
          </thead>
          <tbody>
            {installed.configuration.flatMap((section) =>
              section.properties.map((prop) => (
                <tr key={prop.key}>
                  <td>{prop.key}</td>
                  <td>{prop.type}</td>
                  <td>{JSON.stringify(prop.default)}</td>
                  <td>{prop.description}</td>
                </tr>
              )),
            )}
          </tbody>
        </table>
      )}
    </div>
  );
}
