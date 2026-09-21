import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import * as api from "../api";
import { reloadPendingIds, useExtensionRegistryVersion } from "../extensions";
import { useListNavigation } from "../hooks/useListNavigation";
import { isOfficialPublisher, parsePublisher } from "../lib/extensionId";
import { outdatedExtensions } from "../lib/extensionUpdates";
import type { ExtensionInfo, RegistryCatalogEntry, RegistrySourceResult } from "../types";
import Icon from "./Icon";

interface Props {
  extensions: ExtensionInfo[];
  onReloadExtensions: () => void;
  registries: string[];
  onRegistriesChange: (registries: string[]) => void;
  // The app's built-in default registry (or null if disabled). Merged ahead of
  // `registries` for display/filtering but never mutated through
  // onRegistriesChange — it's server/env-owned, so its row can't be removed.
  defaultRegistry: string | null;
  registryCatalog: RegistrySourceResult[];
  registryLoading: boolean;
  onEnsureRegistryLoaded: () => void;
  onRefreshRegistry: (refresh: boolean, sourcesOverride?: string[]) => void;
  onOpenExtensionPage: (id: string, source?: string) => void;
  // settings.autoUpdateExtensions, mirrored here so the gear popover can
  // flip it without a trip through Settings.
  autoUpdate: boolean;
  onAutoUpdateChange: (autoUpdate: boolean) => void;
}

function ExtIcon({ src }: { src: string | null }) {
  return src ? <img src={src} alt="" className="extension-icon" /> : <Icon name="extensions" className="extension-icon" />;
}

// One list row — VS Code's extension-list-item layout: icon, then a stacked
// title/description/publisher column, then a right-hand actions strip.
// `children` are that row's action controls (checkbox+uninstall for an
// installed row, an Install button for an available one) — kept in the
// caller since the two rows' actions differ enough that folding them in here
// would just replace one branch with another.
function ExtensionRow({
  iconSrc,
  displayName,
  description,
  publisher,
  verified,
  disabled,
  onOpen,
  children,
  tabIndex,
  rowRef,
  onRowFocus,
}: {
  iconSrc: string | null;
  displayName: string;
  description: string;
  publisher?: string;
  verified?: boolean;
  disabled?: boolean;
  onOpen: () => void;
  children?: ReactNode;
  // Roving-tabindex keyboard nav (useListNavigation) — same plain-prop
  // convention as git-scm's FileRow/DirRow/GroupHeader (see that file's
  // comment on why this isn't a forwarded React ref).
  tabIndex?: number;
  rowRef?: (el: HTMLElement | null) => void;
  onRowFocus?: () => void;
}) {
  return (
    <div
      className={`extension-row extension-row-clickable${disabled ? " extension-row-disabled" : ""}`}
      onClick={onOpen}
      tabIndex={tabIndex}
      ref={rowRef}
      onFocus={onRowFocus}
    >
      <ExtIcon src={iconSrc} />
      <div className="extension-row-body">
        <div className="extension-row-title">{displayName}</div>
        <div className="extension-row-description">{description}</div>
        <div className="extension-row-footer">
          {verified && <Icon name="verified-filled" className="extension-verified-icon" />}
          {publisher && <span className="extension-row-publisher">{publisher}</span>}
          {children && (
            <div className="extension-row-actions" onClick={(e) => e.stopPropagation()}>
              {children}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export default function ExtensionsPanel({
  extensions,
  onReloadExtensions,
  registries,
  onRegistriesChange,
  defaultRegistry,
  registryCatalog,
  registryLoading,
  onEnsureRegistryLoaded,
  onRefreshRegistry,
  onOpenExtensionPage,
  autoUpdate,
  onAutoUpdateChange,
}: Props) {
  const [search, setSearch] = useState("");
  const [installingId, setInstallingId] = useState<string | null>(null);
  const [installingPackage, setInstallingPackage] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showRegistries, setShowRegistries] = useState(false);
  const [newRegistry, setNewRegistry] = useState("");
  const [installedCollapsed, setInstalledCollapsed] = useState(false);
  const [availableCollapsed, setAvailableCollapsed] = useState(false);
  // The updates chip's filter. Panel-local and deliberately not persisted:
  // this panel remounts on every sidebar tab switch, and a filter that
  // outlived the visit would hide extensions with no visible explanation.
  const [updatesOnly, setUpdatesOnly] = useState(false);
  const [updatingAll, setUpdatingAll] = useState(false);
  const searchInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    onEnsureRegistryLoaded();
  }, [onEnsureRegistryLoaded]);


  // Sidebar.tsx only renders the active sidebar tab, so this panel mounts
  // fresh every time the user switches to it (via sidebar.focusExtensions/
  // Ctrl+Shift+X or the tab strip) — focusing the search input here is
  // exactly "land somewhere useful" for that shortcut, no separate bridge
  // needed (contrast ProjectList/PortsPanel, which stay mounted inside an
  // always-present accordion and need an explicit focus bridge instead).
  useEffect(() => {
    searchInputRef.current?.focus();
  }, []);

  // Uninstalled builtins live in `extensions` (so the client knows about
  // them) but surface in the Available section, not Installed — they read as
  // normal available extensions whose "Install" re-enables the bundled copy
  // (see runReinstall). Everything else is genuinely installed.
  const installedExtensions = extensions.filter((e) => !e.uninstalled);
  const uninstalledBuiltins = extensions.filter((e) => e.uninstalled);
  const installedIds = new Set(installedExtensions.map((e) => e.id));
  // User sources with the built-in default prepended (deduped) — the effective
  // source list this panel displays and filters the catalog by. The default is
  // never mutated through onRegistriesChange (see removeRegistry/addRegistry).
  const effectiveRegistries =
    defaultRegistry && !registries.includes(defaultRegistry)
      ? [defaultRegistry, ...registries]
      : registries;
  // A just-removed source's fetched entries linger in registryCatalog until
  // the next refresh — filtered out here so removal reads as immediate
  // rather than waiting on a refetch (see addRegistry's sourcesOverride for
  // the mirror-image add case).
  const liveRegistryCatalog = registryCatalog.filter((src) => effectiveRegistries.includes(src.source));

  // {id -> {source, version}} for the highest-version registry entry that
  // beats the installed version — drives the updates chip, "Update All" and
  // each row's own Update action. Shared with the sidebar tab's badge (see
  // lib/extensionUpdates.ts) so the count and the rows can't disagree.
  const updateBySource = outdatedExtensions(extensions, registryCatalog, effectiveRegistries);
  const updateCount = updateBySource.size;
  // Extensions already updated on disk whose old code is still running —
  // only a reload swaps it. Module state, so the hook is what re-renders us
  // when it changes.
  useExtensionRegistryVersion();
  const reloadPending = reloadPendingIds();
  // Installed order, so the banner reads the same way the list below does.
  const pendingReload = installedExtensions.filter((e) => reloadPending.has(e.id));
  const pendingReloadWithServer = pendingReload.filter((e) => e.hasServer);

  // Updating the last outdated extension leaves the chip gone and the filter
  // on, i.e. an empty list with nothing to explain it. Drop the filter with
  // the chip that turned it on.
  useEffect(() => {
    if (updateCount === 0) setUpdatesOnly(false);
  }, [updateCount]);

  const availableEntries: (RegistryCatalogEntry & { source: string })[] = [];
  for (const src of liveRegistryCatalog) {
    for (const entry of src.entries) {
      if (installedIds.has(entry.id)) continue;
      availableEntries.push({ source: src.source, ...entry });
    }
  }

  const searchLower = search.trim().toLowerCase();
  const matches = (displayName: string, description: string, id: string) =>
    !searchLower ||
    displayName.toLowerCase().includes(searchLower) ||
    description.toLowerCase().includes(searchLower) ||
    id.toLowerCase().includes(searchLower);

  const visibleInstalled = installedExtensions.filter(
    (e) => matches(e.displayName, e.description, e.id) && (!updatesOnly || updateBySource.has(e.id)),
  );
  const visibleAvailable = availableEntries.filter((e) => matches(e.displayName, e.description, e.id));
  const visibleAvailableBuiltins = uninstalledBuiltins.filter((e) => matches(e.displayName, e.description, e.id));
  const totalAvailable = availableEntries.length + uninstalledBuiltins.length;
  const visibleAvailableTotal = visibleAvailable.length + visibleAvailableBuiltins.length;

  const runInstall = (source: string, id: string) => {
    setInstallingId(id);
    setError(null);
    api
      .installFromRegistry(source, id)
      .then(onReloadExtensions)
      .catch((err) => setError(err instanceof Error ? err.message : String(err)))
      .finally(() => setInstallingId(null));
  };

  // "Install" for an uninstalled builtin — clears its tombstone back to
  // enabled (the bundled files were never deleted). Same spinner/error path
  // as a registry install, keyed on the extension id.
  const runReinstall = (id: string) => {
    setInstallingId(id);
    setError(null);
    api
      .setExtensionEnabled(id, true)
      .then(onReloadExtensions)
      .catch((err) => setError(err instanceof Error ? err.message : String(err)))
      .finally(() => setInstallingId(null));
  };

  // Sequential, not Promise.all: each install writes into the same
  // extensions directory and rewrites the same state file, and a failure
  // part-way should leave the ones already done installed rather than
  // racing an unknown number of writes.
  const runUpdateAll = async () => {
    setUpdatingAll(true);
    setError(null);
    try {
      for (const [id, update] of [...updateBySource]) {
        setInstallingId(id);
        try {
          await api.installFromRegistry(update.source, id);
        } catch (err) {
          setError(err instanceof Error ? err.message : String(err));
          break;
        }
      }
    } finally {
      setInstallingId(null);
      setUpdatingAll(false);
      // Unconditional: whatever did install has to be reflected, even when a
      // later one failed.
      onReloadExtensions();
    }
  };

  const addRegistry = () => {
    const value = newRegistry.trim();
    if (!value || registries.includes(value) || value === defaultRegistry) return;
    // Passed explicitly (not left to the next render's registries prop) so
    // the refresh doesn't race the settings doc's debounced write-back —
    // see api.fetchRegistry's doc comment.
    const next = [...registries, value];
    onRegistriesChange(next);
    setNewRegistry("");
    onRefreshRegistry(true, next);
  };

  const removeRegistry = (source: string) => {
    onRegistriesChange(registries.filter((r) => r !== source));
  };

  // ---- Keyboard navigation (roving tabindex over both sections' headers +
  // rows) — mirrors ProjectList.tsx’s flattened-row approach. Row order here
  // matches the JSX below exactly (installed header, its rows if expanded,
  // available header, its rows if expanded).
  type NavRow =
    | { kind: "header"; id: string; section: "installed" | "available" }
    | { kind: "installed"; id: string; ext: ExtensionInfo }
    | { kind: "builtin-available"; id: string; ext: ExtensionInfo }
    | { kind: "available"; id: string; entry: RegistryCatalogEntry & { source: string } };

  const navRows = useMemo<NavRow[]>(() => {
    const out: NavRow[] = [{ kind: "header", id: "header:installed", section: "installed" }];
    if (!installedCollapsed) {
      for (const ext of visibleInstalled) out.push({ kind: "installed", id: `installed:${ext.id}`, ext });
    }
    out.push({ kind: "header", id: "header:available", section: "available" });
    if (!availableCollapsed) {
      // Uninstalled builtins first, then registry entries — matches the JSX
      // render order below so the roving tabindex tracks it.
      for (const ext of visibleAvailableBuiltins) {
        out.push({ kind: "builtin-available", id: `builtin-available:${ext.id}`, ext });
      }
      for (const entry of visibleAvailable) {
        out.push({ kind: "available", id: `available:${entry.source}:${entry.id}`, entry });
      }
    }
    return out;
  }, [installedCollapsed, availableCollapsed, visibleInstalled, visibleAvailableBuiltins, visibleAvailable]);
  const navRowsById = useMemo(() => new Map(navRows.map((r) => [r.id, r])), [navRows]);
  const navRowIds = useMemo(() => navRows.map((r) => r.id), [navRows]);

  const nav = useListNavigation({
    rowIds: navRowIds,
    onActivate: (id) => {
      const row = navRowsById.get(id);
      if (!row) return;
      if (row.kind === "header") {
        if (row.section === "installed") setInstalledCollapsed((v) => !v);
        else setAvailableCollapsed((v) => !v);
        return;
      }
      if (row.kind === "installed" || row.kind === "builtin-available") onOpenExtensionPage(row.ext.id);
      else onOpenExtensionPage(row.entry.id, row.entry.source);
    },
    onExpand: (id) => {
      const row = navRowsById.get(id);
      if (row?.kind !== "header") return;
      if (row.section === "installed" && installedCollapsed) setInstalledCollapsed(false);
      if (row.section === "available" && availableCollapsed) setAvailableCollapsed(false);
    },
    onCollapse: (id) => {
      const row = navRowsById.get(id);
      if (row?.kind !== "header") return;
      if (row.section === "installed" && !installedCollapsed) setInstalledCollapsed(true);
      if (row.section === "available" && !availableCollapsed) setAvailableCollapsed(true);
    },
  });

  const handleSearchKeyDown = (e: ReactKeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown" && navRowIds.length > 0) {
      e.preventDefault();
      nav.focusRow(navRowIds[0]);
    }
  };

  return (
    <div className="extensions-panel">
      <div className="extensions-panel-toolbar">
        <input
          ref={searchInputRef}
          className="dialog-input extension-filter-search"
          placeholder="Search extensions"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          onKeyDown={handleSearchKeyDown}
        />
        <label className="dialog-button secondary extension-install-button">
          {installingPackage ? "Installing…" : "Install from .perch"}
          <input
            type="file"
            accept=".perch"
            disabled={installingPackage}
            style={{ display: "none" }}
            onChange={async (e) => {
              const file = e.target.files?.[0];
              e.target.value = "";
              if (!file) return;
              setInstallingPackage(true);
              setError(null);
              try {
                await api.installExtensionPackage(file);
                onReloadExtensions();
              } catch (err) {
                setError(err instanceof Error ? err.message : String(err));
              } finally {
                setInstallingPackage(false);
              }
            }}
          />
        </label>
        <button
          className="icon-button"
          title="Refresh registries"
          onClick={() => onRefreshRegistry(true)}
        >
          <Icon name="refresh" />
        </button>
        <button
          className={`icon-button${showRegistries ? " active" : ""}`}
          title="Manage registries"
          onClick={() => setShowRegistries((v) => !v)}
        >
          <Icon name="gear" />
        </button>
      </div>

      {showRegistries && (
        <div className="extensions-registries">
          <label className="settings-row checkbox-row extensions-auto-update-row">
            <input
              type="checkbox"
              checked={autoUpdate}
              onChange={(e) => onAutoUpdateChange(e.target.checked)}
            />
            <span>Auto-update extensions</span>
          </label>
          {effectiveRegistries.length === 0 && (
            <div className="settings-hint">
              No registries configured. Add a URL serving an index.json, or a local directory path.
            </div>
          )}
          {effectiveRegistries.map((source) => {
            const result = registryCatalog.find((r) => r.source === source);
            const isDefault = source === defaultRegistry;
            return (
              <div key={source} className="extensions-registry-row">
                <span className="extensions-registry-source" title={source}>
                  {source}
                </span>
                {result?.error && <span className="extension-error extensions-registry-error">{result.error}</span>}
                {isDefault ? (
                  <span className="extensions-registry-default" title="Built-in default registry (set EXTENSION_REGISTRY to override)">
                    default
                  </span>
                ) : (
                  <button className="icon-button" title="Remove" onClick={() => removeRegistry(source)}>
                    <Icon name="trash" />
                  </button>
                )}
              </div>
            );
          })}
          <div className="extensions-registry-add">
            <input
              className="dialog-input"
              placeholder="https://example.com/ or /path/to/dist"
              value={newRegistry}
              onChange={(e) => setNewRegistry(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") addRegistry();
              }}
            />
            <button className="dialog-button secondary" onClick={addRegistry}>
              Add
            </button>
          </div>
        </div>
      )}

      {error && <div className="extension-error">{error}</div>}

      {pendingReload.length > 0 && (
        // One banner rather than a button per row: the reload is a single
        // page-wide act, and the rows it concerns may be scrolled out of
        // sight (or filtered away) when the user gets here.
        <div className="extension-reload-banner">
          <div className="extension-reload-banner-head">
            <div className="extension-reload-banner-title">Reload required</div>
            <button
              className="dialog-button primary extension-reload-button"
              onClick={() => window.location.reload()}
            >
              Reload
            </button>
          </div>
          <div className="extension-reload-banner-body">
            <div className="extension-reload-banner-names">
              {pendingReload.map((e) => e.displayName).join(", ")}{" "}
              {pendingReload.length === 1 ? "was updated" : "were updated"} - the page is still running
              the old code
            </div>
            {pendingReloadWithServer.length > 0 && (
              // A reload re-imports client code; a server hook is a module
              // the server process can never unload. Name the ones that
              // need the heavier fix rather than let the button look like
              // it covers everything.
              <div className="extension-reload-note">
                {pendingReloadWithServer.map((e) => e.displayName).join(", ")}{" "}
                {pendingReloadWithServer.length === 1 ? "also serves" : "also serve"} routes that keep
                the old code until the server restarts - run <code>perch restart</code>
              </div>
            )}
          </div>
        </div>
      )}

      <div className="extensions-panel-body" onKeyDown={nav.onKeyDown}>
        {(() => {
          const installedHeaderRowProps = nav.getRowProps("header:installed");
          return (
            <div
              className="extensions-panel-section-header"
              onClick={() => setInstalledCollapsed((v) => !v)}
              tabIndex={installedHeaderRowProps.tabIndex}
              ref={installedHeaderRowProps.ref}
              onFocus={installedHeaderRowProps.onFocus}
            >
              <Icon
                name={installedCollapsed ? "chevron-right" : "chevron-down"}
                className="extensions-panel-section-chevron"
              />
              <span className="extensions-panel-section-title">Installed</span>
              <span className="extensions-panel-section-badge">
                {updatesOnly ? `${visibleInstalled.length} of ${installedExtensions.length}` : installedExtensions.length}
              </span>
              {updateCount > 0 && (
                <button
                  className={`extensions-updates-chip${updatesOnly ? " active" : ""}`}
                  title={updatesOnly ? "Show all installed extensions" : "Show only extensions with updates"}
                  aria-pressed={updatesOnly}
                  onClick={(e) => {
                    // The header itself toggles the section collapse.
                    e.stopPropagation();
                    setUpdatesOnly((v) => !v);
                  }}
                >
                  {updateCount} {updateCount === 1 ? "update" : "updates"}
                  <Icon name={updatesOnly ? "chevron-down" : "chevron-right"} />
                </button>
              )}
              {updatesOnly && (
                <button
                  className="dialog-button secondary extensions-update-all"
                  disabled={updatingAll}
                  onClick={(e) => {
                    e.stopPropagation();
                    void runUpdateAll();
                  }}
                >
                  {updatingAll ? "Updating..." : "Update All"}
                </button>
              )}
            </div>
          );
        })()}
        {!installedCollapsed && (
          <div className="extension-list">
            {installedExtensions.length === 0 && <div className="keybinding-empty">No extensions installed</div>}
            {installedExtensions.length > 0 && visibleInstalled.length === 0 && (
              <div className="keybinding-empty">No extensions match your search</div>
            )}
            {visibleInstalled.map((ext) => {
              const update = updateBySource.get(ext.id);
              const rowProps = nav.getRowProps(`installed:${ext.id}`);
              return (
                <ExtensionRow
                  key={ext.id}
                  iconSrc={ext.icon ? api.extensionFileUrl(ext.id, ext.icon) : null}
                  displayName={ext.displayName}
                  description={ext.description}
                  publisher={parsePublisher(ext.id)}
                  tabIndex={rowProps.tabIndex}
                  rowRef={rowProps.ref}
                  onRowFocus={rowProps.onFocus}
                  verified={isOfficialPublisher(parsePublisher(ext.id))}
                  disabled={!ext.enabled}
                  onOpen={() => onOpenExtensionPage(ext.id)}
                >
                  {update && (
                    <>
                      <span className="extension-row-version">
                        {ext.version} -&gt; {update.version}
                      </span>
                      <button
                        className="dialog-button secondary"
                        disabled={installingId === ext.id}
                        title={`Update to v${update.version}`}
                        onClick={() => runInstall(update.source, ext.id)}
                      >
                        {installingId === ext.id ? "Updating..." : "Update"}
                      </button>
                    </>
                  )}
                </ExtensionRow>
              );
            })}
          </div>
        )}

        {(() => {
          const availableHeaderRowProps = nav.getRowProps("header:available");
          return (
            <div
              className="extensions-panel-section-header"
              onClick={() => setAvailableCollapsed((v) => !v)}
              tabIndex={availableHeaderRowProps.tabIndex}
              ref={availableHeaderRowProps.ref}
              onFocus={availableHeaderRowProps.onFocus}
            >
              <Icon
                name={availableCollapsed ? "chevron-right" : "chevron-down"}
                className="extensions-panel-section-chevron"
              />
              <span className="extensions-panel-section-title">Available</span>
              {registryLoading ? (
                <span className="extensions-panel-section-loading">Loading…</span>
              ) : (
                <span className="extensions-panel-section-badge">{totalAvailable}</span>
              )}
            </div>
          );
        })()}
        {!availableCollapsed && (
          <div className="extension-list">
            {effectiveRegistries.length === 0 && uninstalledBuiltins.length === 0 && (
              <div className="keybinding-empty">
                No registries configured - click the gear above to add one.
              </div>
            )}
            {effectiveRegistries.length > 0 && totalAvailable === 0 && !registryLoading && (
              <div className="keybinding-empty">No available extensions</div>
            )}
            {totalAvailable > 0 && visibleAvailableTotal === 0 && (
              <div className="keybinding-empty">No extensions match your search</div>
            )}
            {visibleAvailableBuiltins.map((ext) => {
              const rowProps = nav.getRowProps(`builtin-available:${ext.id}`);
              return (
                <ExtensionRow
                  key={`builtin:${ext.id}`}
                  iconSrc={ext.icon ? api.extensionFileUrl(ext.id, ext.icon) : null}
                  displayName={ext.displayName}
                  description={ext.description}
                  publisher={parsePublisher(ext.id)}
                  verified={isOfficialPublisher(parsePublisher(ext.id))}
                  onOpen={() => onOpenExtensionPage(ext.id)}
                  tabIndex={rowProps.tabIndex}
                  rowRef={rowProps.ref}
                  onRowFocus={rowProps.onFocus}
                >
                  <button
                    className="dialog-button primary"
                    disabled={installingId === ext.id}
                    onClick={() => runReinstall(ext.id)}
                  >
                    {installingId === ext.id ? "Installing…" : "Install"}
                  </button>
                </ExtensionRow>
              );
            })}
            {visibleAvailable.map((entry) => {
              const rowProps = nav.getRowProps(`available:${entry.source}:${entry.id}`);
              return (
              <ExtensionRow
                key={`${entry.source}:${entry.id}`}
                iconSrc={entry.hasIcon ? api.registryIconUrl(entry.source, entry.id) : null}
                displayName={entry.displayName}
                description={entry.description}
                publisher={entry.publisher ?? parsePublisher(entry.id)}
                verified={isOfficialPublisher(entry.publisher ?? parsePublisher(entry.id))}
                onOpen={() => onOpenExtensionPage(entry.id, entry.source)}
                tabIndex={rowProps.tabIndex}
                rowRef={rowProps.ref}
                onRowFocus={rowProps.onFocus}
              >
                <button
                  className="dialog-button primary"
                  disabled={installingId === entry.id}
                  onClick={() => runInstall(entry.source, entry.id)}
                >
                  {installingId === entry.id ? "Installing…" : "Install"}
                </button>
              </ExtensionRow>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
