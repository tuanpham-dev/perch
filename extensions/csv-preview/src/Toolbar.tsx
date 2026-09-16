// Presentational toolbar JSX extracted verbatim from the original
// client/src/components/CsvView.tsx's render — see extensions/csv-preview's
// module split. No logic changes: every prop here is exactly the state/
// handler client.tsx already owned, just threaded through instead of
// closed over directly.
import type { RefObject } from "react";
import Icon from "../../_shared/Icon";

interface CsvToolbarProps {
  canUndo: boolean;
  canRedo: boolean;
  onUndo: () => void;
  onRedo: () => void;
  statusText: string;
  hiddenCols: Set<number>;
  headers: string[];
  showHiddenPanel: boolean;
  setShowHiddenPanel: (updater: boolean | ((v: boolean) => boolean)) => void;
  hiddenPanelRef: RefObject<HTMLDivElement | null>;
  setHiddenCols: (updater: Set<number> | ((prev: Set<number>) => Set<number>)) => void;
  showFind: boolean;
  onOpenFind: () => void;
  hasData: boolean;
  onAddRow: () => void;
  onAddColumn: () => void;
  hasHeader: boolean;
  setHasHeader: (v: boolean) => void;
  delimiter: string;
  setDelimiter: (v: string) => void;
  wordWrap: boolean;
  setWordWrap: (v: boolean) => void;
  copied: boolean;
  onCopyAll: () => void;
}

export function CsvToolbar({
  canUndo, canRedo, onUndo, onRedo, statusText, hiddenCols, headers,
  showHiddenPanel, setShowHiddenPanel, hiddenPanelRef, setHiddenCols,
  showFind, onOpenFind, hasData, onAddRow, onAddColumn,
  hasHeader, setHasHeader, delimiter, setDelimiter, wordWrap, setWordWrap, copied, onCopyAll,
}: CsvToolbarProps) {
  return (
    <div className="csv-toolbar">
      <button onClick={onUndo} disabled={!canUndo} title="Undo (Ctrl+Z)" className="icon-button">
        <Icon name="redo" className="icon-flip-x" />
      </button>
      <button onClick={onRedo} disabled={!canRedo} title="Redo (Ctrl+Y)" className="icon-button">
        <Icon name="redo" />
      </button>
      <span className="csv-toolbar-sep" />
      <span className="csv-status-text" title={statusText}>{statusText}</span>

      <span className="csv-toolbar-spacer" />

      {hiddenCols.size > 0 && (
        <div ref={hiddenPanelRef} className="csv-hidden-panel-wrap">
          <button onClick={() => setShowHiddenPanel((v) => !v)} className="csv-hidden-badge" title="Hidden columns">
            <Icon name="eye-closed" /> {hiddenCols.size}
          </button>
          {showHiddenPanel && (
            <div className="csv-hidden-panel">
              <button className="csv-hidden-panel-item" onClick={() => { setHiddenCols(new Set()); setShowHiddenPanel(false); }}>
                <Icon name="eye" /> Show all columns
              </button>
              {[...hiddenCols].sort((a, b) => a - b).map((ci) => (
                <button
                  key={ci}
                  className="csv-hidden-panel-item"
                  onClick={() => setHiddenCols((prev) => { const n = new Set(prev); n.delete(ci); return n; })}
                >
                  <Icon name="eye" /> <span className="csv-hidden-panel-item-name">{headers[ci] ?? `col${ci + 1}`}</span>
                </button>
              ))}
            </div>
          )}
        </div>
      )}
      <button onClick={onOpenFind} title="Find (Ctrl+F)" className={`icon-button${showFind ? " csv-toolbar-btn-active" : ""}`}>
        <Icon name="search" />
      </button>
      <span className="csv-toolbar-sep" />
      <button onClick={onAddRow} disabled={!hasData} title="Add row" className="csv-text-button">
        <Icon name="add" /> Row
      </button>
      <button onClick={onAddColumn} disabled={!hasData} title="Add column" className="csv-text-button">
        <Icon name="add" /> Col
      </button>
      <span className="csv-toolbar-sep" />
      <label className="csv-header-toggle">
        <input type="checkbox" checked={hasHeader} onChange={(e) => setHasHeader(e.target.checked)} /> Header
      </label>
      <select value={delimiter} onChange={(e) => setDelimiter(e.target.value)} className="csv-delimiter-select">
        <option value="auto">Auto</option>
        <option value=",">, comma</option>
        <option value=";">; semi</option>
        <option value="&#9;">⇥ tab</option>
        <option value="|">| pipe</option>
      </select>
      <span className="csv-toolbar-sep" />
      <label className="csv-header-toggle" title="Wrap long cell text onto multiple lines instead of truncating it">
        <input type="checkbox" checked={wordWrap} onChange={(e) => setWordWrap(e.target.checked)} /> Wrap
      </label>
      <span className="csv-toolbar-sep" />
      <button onClick={onCopyAll} disabled={!hasData} title="Copy whole CSV" className="csv-text-button">
        <Icon name="copy" /> {copied ? "Copied!" : "Copy"}
      </button>
    </div>
  );
}

interface CsvFindBarProps {
  findInputRef: RefObject<HTMLInputElement | null>;
  findQuery: string;
  setFindQuery: (v: string) => void;
  setFindIdx: (v: number) => void;
  safeIdx: number;
  findMatchesLength: number;
  onJumpToMatch: (idx: number) => void;
  onCloseFind: () => void;
  showReplace: boolean;
  setShowReplace: (updater: boolean | ((v: boolean) => boolean)) => void;
  replaceInputRef: RefObject<HTMLInputElement | null>;
  regexError: string | null;
  useRegexFind: boolean;
  setUseRegexFind: (updater: boolean | ((v: boolean) => boolean)) => void;
  replaceQuery: string;
  setReplaceQuery: (v: string) => void;
  onReplaceCurrent: () => void;
  onReplaceAll: () => void;
}

export function CsvFindBar({
  findInputRef, findQuery, setFindQuery, setFindIdx, safeIdx, findMatchesLength,
  onJumpToMatch, onCloseFind, showReplace, setShowReplace, replaceInputRef,
  regexError, useRegexFind, setUseRegexFind, replaceQuery, setReplaceQuery,
  onReplaceCurrent, onReplaceAll,
}: CsvFindBarProps) {
  return (
    <div className="csv-find-bar">
      <div className="csv-find-row">
        <Icon name="search" />
        <input
          ref={findInputRef}
          value={findQuery}
          onChange={(e) => { setFindQuery(e.target.value); setFindIdx(0); }}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === "Enter") onJumpToMatch(safeIdx + (e.shiftKey ? -1 : 1));
            if (e.key === "Escape") onCloseFind();
            if (e.key === "Tab" && showReplace) { e.preventDefault(); replaceInputRef.current?.focus(); }
          }}
          placeholder="Find in cells…"
          className={`csv-find-input${regexError ? " csv-find-input-error" : ""}`}
        />
        {regexError ? (
          <span className="csv-find-error" title={regexError}>{regexError}</span>
        ) : findQuery ? (
          <span className="csv-find-count">{findMatchesLength === 0 ? "No results" : `${safeIdx + 1} / ${findMatchesLength}`}</span>
        ) : null}
        <button onClick={() => { setUseRegexFind((v) => !v); setFindIdx(0); }} title="Use regular expression" className={`icon-button${useRegexFind ? " csv-toolbar-btn-active" : ""}`}>
          <Icon name="regex" />
        </button>
        <button onClick={() => setShowReplace((v) => !v)} title="Toggle replace (Ctrl+H)" className={`icon-button${showReplace ? " csv-toolbar-btn-active" : ""}`}>
          <Icon name="replace" />
        </button>
        <button onClick={() => onJumpToMatch(safeIdx - 1)} disabled={!findMatchesLength} title="Previous (Shift+Enter)" className="icon-button">
          <Icon name="chevron-down" className="icon-flip-y" />
        </button>
        <button onClick={() => onJumpToMatch(safeIdx + 1)} disabled={!findMatchesLength} title="Next (Enter)" className="icon-button">
          <Icon name="chevron-down" />
        </button>
        <button onClick={onCloseFind} title="Close (Esc)" className="icon-button">
          <Icon name="close" />
        </button>
      </div>
      {showReplace && (
        <div className="csv-find-row csv-replace-row">
          <input
            ref={replaceInputRef}
            value={replaceQuery}
            onChange={(e) => setReplaceQuery(e.target.value)}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === "Escape") onCloseFind();
              if (e.key === "Enter") onReplaceCurrent();
              if (e.key === "Tab" && e.shiftKey) { e.preventDefault(); findInputRef.current?.focus(); }
            }}
            placeholder="Replace with…"
            className="csv-find-input"
          />
          <button onClick={onReplaceCurrent} disabled={!findMatchesLength || !!regexError} className="csv-text-button" title="Replace current match (Enter)">
            <Icon name="replace" /> Replace
          </button>
          <button onClick={onReplaceAll} disabled={!findMatchesLength || !!regexError} className="csv-text-button" title="Replace all matches">
            <Icon name="replace-all" /> Replace All
          </button>
        </div>
      )}
    </div>
  );
}
