import { useEffect, useState } from "react";
import * as api from "../../api";
import type { BundleInstallResult, BundleSummary, SettingsBundle } from "../../api";

// The preview an import goes through before anything changes. It asks the
// server what the bundle would contribute (nothing is written by that call),
// lists it, and only merges once the user confirms.
//
// Extensions are listed one per row with a checkbox rather than folded into a
// count, because installing one runs its server hook as this user — that is
// never something a file someone sent you should do quietly.
//
// Built from the same .dialog-* classes as Dialog.tsx rather than through it:
// that component renders a fixed confirm/prompt/pick shape and takes no
// children, so reusing its styles is as far as sharing goes here.

interface Props {
  bundle: SettingsBundle;
  onClose: () => void;
}

type Phase =
  | { state: "loading" }
  | { state: "error"; message: string }
  | { state: "ready"; summary: BundleSummary }
  | { state: "applying"; summary: BundleSummary }
  | { state: "done"; failures: BundleInstallResult[] };

export default function ImportSettingsDialog({ bundle, onClose }: Props) {
  const [phase, setPhase] = useState<Phase>({ state: "loading" });
  // Ids the user wants installed. Seeded from the preview: every installable
  // row starts checked, so the common "clone my setup" case is one click.
  const [checked, setChecked] = useState<Set<string>>(new Set());

  useEffect(() => {
    let cancelled = false;
    api
      .previewSettingsBundle(bundle)
      .then((summary) => {
        if (cancelled) return;
        setChecked(new Set(summary.extensions.filter((e) => e.installable).map((e) => e.id)));
        setPhase({ state: "ready", summary });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setPhase({ state: "error", message: err instanceof Error ? err.message : String(err) });
      });
    return () => {
      cancelled = true;
    };
  }, [bundle]);

  // A merge that has landed cannot be taken back by closing a dialog, so once
  // the import has run the only way out is a reload that picks it up.
  const reload = () => window.location.reload();

  const confirm = async () => {
    if (phase.state !== "ready") return;
    setPhase({ state: "applying", summary: phase.summary });
    try {
      const result = await api.applySettingsBundle(bundle, [...checked]);
      const failures = result.extensions.filter((e) => !e.ok);
      // Nothing to report means nothing to read, so go straight to the
      // reloaded app rather than making the user dismiss a success message.
      if (failures.length === 0) return reload();
      setPhase({ state: "done", failures });
    } catch (err) {
      setPhase({ state: "error", message: err instanceof Error ? err.message : String(err) });
    }
  };

  const toggle = (id: string) =>
    setChecked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key !== "Escape") return;
    e.preventDefault();
    // Escape is a cancel before the import and a reload after it.
    if (phase.state === "done") reload();
    else if (phase.state !== "applying") onClose();
  };

  return (
    <div
      className="dialog-overlay"
      onMouseDown={phase.state === "applying" ? undefined : onClose}
    >
      <div
        className="dialog import-dialog"
        role="dialog"
        aria-label="Import Settings"
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={onKeyDown}
      >
        <div className="dialog-message">Import Settings</div>

        {phase.state === "loading" && <div className="import-note">Reading the file…</div>}

        {phase.state === "error" && <div className="import-error">{phase.message}</div>}

        {phase.state === "done" && (
          <>
            <div className="import-note">
              Your settings were imported. These extensions could not be installed:
            </div>
            <div className="import-group">
              {phase.failures.map((f) => (
                <div key={f.id} className="import-row">
                  <span className="import-row-name">{f.id}</span>
                  <span className="import-row-detail">{f.error}</span>
                </div>
              ))}
            </div>
          </>
        )}

        {(phase.state === "ready" || phase.state === "applying") && (
          <ImportBody summary={phase.summary} checked={checked} onToggle={toggle} />
        )}

        <div className="dialog-buttons">
          {phase.state === "done" ? (
            <button className="dialog-button primary" onClick={reload}>
              Reload
            </button>
          ) : phase.state === "error" ? (
            <button className="dialog-button secondary" onClick={onClose}>
              Close
            </button>
          ) : (
            <>
              <button
                className="dialog-button secondary"
                onClick={onClose}
                disabled={phase.state === "applying"}
              >
                Cancel
              </button>
              <button
                className="dialog-button primary"
                onClick={confirm}
                disabled={phase.state !== "ready"}
              >
                {phase.state === "applying"
                  ? "Importing…"
                  : checked.size > 0
                    ? `Import and Install ${checked.size}`
                    : "Import Settings"}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function ImportBody({
  summary,
  checked,
  onToggle,
}: {
  summary: BundleSummary;
  checked: Set<string>;
  onToggle: (id: string) => void;
}) {
  const exported = summary.exportedAt ? new Date(summary.exportedAt) : null;
  const exportedLabel =
    exported && !Number.isNaN(exported.getTime()) ? exported.toLocaleString() : null;

  return (
    <div className="import-body">
      {exportedLabel && <div className="import-note">Exported {exportedLabel}</div>}

      {summary.categories.length > 0 ? (
        <>
          <div className="import-head">Will be merged over your settings</div>
          <div className="import-group">
            {summary.categories.map((c) => (
              <div key={c.key} className="import-row">
                <span className="import-row-name">{c.label}</span>
                <span className="import-row-count">{c.count}</span>
              </div>
            ))}
          </div>
        </>
      ) : (
        <div className="import-note">This file carries no settings to merge.</div>
      )}

      {summary.extensions.length > 0 && (
        <>
          <div className="import-head">Extensions in this file</div>
          <div className="import-group">
            {summary.extensions.map((ext) => (
              <label
                key={ext.id}
                className={`import-row import-row-ext${ext.installable ? "" : " disabled"}`}
              >
                <input
                  type="checkbox"
                  id={`import-ext-${ext.id}`}
                  checked={checked.has(ext.id)}
                  disabled={!ext.installable}
                  onChange={() => onToggle(ext.id)}
                />
                <span className="import-row-name">{ext.id}</span>
                <span className="import-row-detail">
                  {ext.reason ?? (ext.installed ? `installed, ${ext.version}` : ext.version)}
                </span>
              </label>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
