import { useEffect, useState } from "react";
import { CONTEXT_KEYS } from "../contextKeys";
import { useExtensionRegistry } from "../extensions";
import {
  COMMANDS,
  formatBinding,
  recorderState,
  resolveBindings,
  serializeEvent,
  type Command,
  type Keybinding,
  type KeybindingOverrides,
} from "../keybindings";
import { isValidWhen, normalizeWhen } from "../whenClause";
import Icon from "./Icon";

// The identifier token immediately before the caret — what the autosuggest
// dropdown filters CONTEXT_KEYS against as the user types a when clause.
function currentToken(text: string, caret: number): string {
  const match = text.slice(0, caret).match(/[A-Za-z0-9_.-]*$/);
  return match ? match[0] : "";
}

interface Props {
  active: boolean;
  keybindingOverrides: KeybindingOverrides;
  onKeybindingOverridesChange: (overrides: KeybindingOverrides) => void;
}

// Which chord slot a recording session is filling: replacing an existing
// binding at `index`, or appending a new one ("new").
interface RecordSlot {
  commandId: string;
  index: number | "new";
}

interface RowInfo {
  cmd: Command;
  // null marks the single placeholder row rendered for a command with zero
  // bindings — there's nothing at that "index" to replace, only to add to.
  index: number | null;
  binding: Keybinding | null;
  isFirst: boolean;
  isLast: boolean;
}

function bindingArraysEqual(a: Keybinding[], b: Keybinding[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((x, i) => x.key === b[i].key && (x.when ?? "") === (b[i].when ?? ""));
}

// Either side being bare (no when clause) means it always applies, so it
// conflicts with anything sharing the same scope+key regardless of the
// other side's condition — only two conditioned bindings need their
// conditions to actually match (normalized) to count as a real conflict.
function whenClausesConflict(a: string, b: string): boolean {
  if (!a || !b) return true;
  return normalizeWhen(a) === normalizeWhen(b);
}

export default function KeyboardShortcutsView({ active, keybindingOverrides, onKeybindingOverridesChange }: Props) {
  const [filter, setFilter] = useState("");
  const [recording, setRecording] = useState<RecordSlot | null>(null);
  const [editingWhen, setEditingWhen] = useState<{ commandId: string; index: number } | null>(null);
  const [whenDraft, setWhenDraft] = useState("");
  // Caret position within whenDraft, tracked per-event (onChange/onKeyUp/
  // onClick) rather than via a full selection model — a caret moved purely
  // by a mouse selection-drag can go briefly stale, self-correcting on the
  // next keystroke (accepted tradeoff for this small input).
  const [whenCaret, setWhenCaret] = useState(0);
  const [suggestOpen, setSuggestOpen] = useState(true);
  const [suggestIndex, setSuggestIndex] = useState(0);

  // Extension-registered commands join the built-in list everywhere this
  // view lists/resolves/records commands — see App.tsx's matching merge for
  // the dispatcher side.
  const { commands: extCommands } = useExtensionRegistry();
  const extCommandDefs: Command[] = extCommands.map((c) => ({
    id: c.id,
    label: c.label,
    defaultBindings: c.defaultBinding ? [{ key: c.defaultBinding }] : [],
    scope: "global",
  }));
  const allCommands: Command[] = [...COMMANDS, ...extCommandDefs];
  const resolved = resolveBindings(keybindingOverrides, extCommandDefs);

  function commitBindings(cmd: Command, next: Keybinding[]) {
    const nextOverrides = { ...keybindingOverrides };
    if (bindingArraysEqual(next, cmd.defaultBindings)) delete nextOverrides[cmd.id];
    else nextOverrides[cmd.id] = next;
    onKeybindingOverridesChange(nextOverrides);
  }

  // Chord recorder — same recorderState/window-capture-listener mechanics as
  // the original Settings > Keyboard section, just targeting one binding
  // slot (replace-in-place or append) instead of the whole command.
  useEffect(() => {
    recorderState.recording = recording !== null;
    if (!recording) return;
    const onKeyDown = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      // Only a bare Escape cancels recording — with a modifier held (e.g.
      // Alt+Esc) it's a chord being captured like any other.
      if (e.key === "Escape" && !e.ctrlKey && !e.shiftKey && !e.altKey && !e.metaKey) {
        setRecording(null);
        return;
      }
      const combo = serializeEvent(e);
      if (!combo) return; // modifier alone — keep waiting for the chord
      const cmd = allCommands.find((c) => c.id === recording.commandId);
      if (!cmd) {
        setRecording(null);
        return;
      }
      const current = resolved[cmd.id] ?? [];
      const next =
        recording.index === "new"
          ? [...current, { key: combo }]
          : current.map((b, i) => (i === recording.index ? { key: combo, when: b.when } : b));
      commitBindings(cmd, next);
      setRecording(null);
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => {
      window.removeEventListener("keydown", onKeyDown, true);
      recorderState.recording = false;
    };
    // Deliberately not depending on allCommands/resolved (new identities every
    // render): matches the original recorder's dependency list, which only
    // reruns when recording starts/stops or the overrides actually change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recording, keybindingOverrides, onKeybindingOverridesChange]);

  // Leaving the tab mid-recording/mid-edit cancels it, same rationale as the
  // original Settings section: this component itself stays mounted (App.tsx
  // keeps every tab alive), so only the "tab became inactive" transition
  // needs watching here.
  useEffect(() => {
    if (!active) {
      setRecording(null);
      setEditingWhen(null);
    }
  }, [active]);

  function commitWhen(cmd: Command, index: number, value: string) {
    const when = value.trim();
    const current = resolved[cmd.id] ?? [];
    const next = current.map((b, i) => (i === index ? { key: b.key, when: when || undefined } : b));
    commitBindings(cmd, next);
  }

  // Replaces just the identifier token before the caret with `key` (so
  // completing the second half of `terminalFocus && pan…` doesn't clobber
  // the first half), and leaves editing open for `&&`/`||` chaining.
  function acceptSuggestion(key: string) {
    const tokenLen = currentToken(whenDraft, whenCaret).length;
    const before = whenDraft.slice(0, whenCaret - tokenLen) + key;
    const after = whenDraft.slice(whenCaret);
    setWhenDraft(before + after);
    setWhenCaret(before.length);
    setSuggestOpen(false);
    setSuggestIndex(0);
  }

  const filterLower = filter.trim().toLowerCase();
  const visibleCommands = allCommands.filter((cmd) => {
    if (!filterLower) return true;
    if (cmd.label.toLowerCase().includes(filterLower)) return true;
    return (resolved[cmd.id] ?? []).some((b) => formatBinding(b.key).toLowerCase().includes(filterLower));
  });

  // scope+key+normalized-when → conflicting command ids, for the row warning
  // icon. Built over every command (not just visibleCommands) so filtering
  // the list doesn't hide a real conflict with an off-screen command.
  const allEntries: { commandId: string; scope: Command["scope"]; key: string; when: string }[] = [];
  for (const cmd of allCommands) {
    for (const b of resolved[cmd.id] ?? []) {
      allEntries.push({ commandId: cmd.id, scope: cmd.scope, key: b.key, when: b.when ?? "" });
    }
  }
  function conflictsFor(cmd: Command, binding: Keybinding): string[] {
    const when = binding.when ?? "";
    const ids = allEntries
      .filter(
        (e) =>
          e.commandId !== cmd.id &&
          e.scope === cmd.scope &&
          e.key === binding.key &&
          whenClausesConflict(e.when, when),
      )
      .map((e) => e.commandId);
    return Array.from(new Set(ids));
  }

  const rows: RowInfo[] = [];
  for (const cmd of visibleCommands) {
    const bindings = resolved[cmd.id] ?? [];
    if (bindings.length === 0) {
      rows.push({ cmd, index: null, binding: null, isFirst: true, isLast: true });
    } else {
      bindings.forEach((binding, index) => {
        rows.push({ cmd, index, binding, isFirst: index === 0, isLast: index === bindings.length - 1 });
      });
      // A command with existing bindings has no natural placeholder row for
      // an in-progress "add another" recording to attach to (unlike the
      // index === null row above, which already doubles as one) — inject
      // one so "Press key combination…" has somewhere to render.
      if (recording?.commandId === cmd.id && recording.index === "new") {
        rows[rows.length - 1].isLast = false;
        rows.push({ cmd, index: null, binding: null, isFirst: false, isLast: true });
      }
    }
  }

  return (
    <div className={`settings-host${active ? "" : " hidden"}`}>
      <div className="settings-content">
        <h2 className="settings-section-title">Keyboard Shortcuts</h2>

        <input
          className="dialog-input keybinding-filter"
          placeholder="Type to search keybindings"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />

        <div className="keybinding-table">
          <div className="keybinding-header-row">
            <span className="keybinding-header-command">Command</span>
            <span className="keybinding-header-binding">Keybinding</span>
            <span className="keybinding-header-when">When</span>
            <span className="keybinding-header-source">Source</span>
            <span className="keybinding-header-actions" />
          </div>
          {rows.map((row) => {
            const { cmd, index, binding } = row;
            const overridden = keybindingOverrides[cmd.id] !== undefined;
            const isRecordingRow =
              recording?.commandId === cmd.id &&
              (index === null ? recording.index === "new" : recording.index === index);
            const isEditingWhen = editingWhen?.commandId === cmd.id && editingWhen.index === index;
            const conflicts = binding ? conflictsFor(cmd, binding) : [];
            const conflictLabels = conflicts
              .map((id) => allCommands.find((c) => c.id === id)?.label ?? id)
              .join(", ");
            return (
              <div key={`${cmd.id}:${index ?? "empty"}`} className="keybinding-row">
                <span className="keybinding-label">{row.isFirst ? cmd.label : ""}</span>
                <span
                  className={`keybinding-chip${isRecordingRow ? " recording" : ""}${binding ? "" : " empty"}`}
                  onDoubleClick={() => binding && setRecording({ commandId: cmd.id, index: index as number })}
                >
                  {isRecordingRow ? "Press key combination…" : binding ? formatBinding(binding.key) : "Unbound"}
                  {conflicts.length > 0 && !isRecordingRow && (
                    <span className="keybinding-conflict" title={`Also bound to: ${conflictLabels}`}>
                      <Icon name="warning" />
                    </span>
                  )}
                </span>
                <span className="keybinding-when-cell">
                  {isEditingWhen ? (
                    (() => {
                      const token = suggestOpen ? currentToken(whenDraft, whenCaret) : "";
                      const suggestions = suggestOpen
                        ? CONTEXT_KEYS.filter((k) => k.key.toLowerCase().startsWith(token.toLowerCase()))
                        : [];
                      return (
                        <>
                          <input
                            autoFocus
                            className={`dialog-input keybinding-when-input${isValidWhen(whenDraft) ? "" : " invalid"}`}
                            value={whenDraft}
                            onChange={(e) => {
                              setWhenDraft(e.target.value);
                              setWhenCaret(e.target.selectionStart ?? e.target.value.length);
                              setSuggestOpen(true);
                              setSuggestIndex(0);
                            }}
                            onKeyUp={(e) => {
                              // Keeps the caret fresh for the token filter when it
                              // moves without the value changing.
                              if (["ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key)) {
                                setWhenCaret(e.currentTarget.selectionStart ?? 0);
                              }
                            }}
                            onClick={(e) => setWhenCaret(e.currentTarget.selectionStart ?? 0)}
                            onBlur={() => {
                              commitWhen(cmd, index as number, whenDraft);
                              setEditingWhen(null);
                            }}
                            onKeyDown={(e) => {
                              if (suggestions.length > 0) {
                                if (e.key === "ArrowDown") {
                                  e.preventDefault();
                                  setSuggestIndex((i) => (i + 1) % suggestions.length);
                                  return;
                                }
                                if (e.key === "ArrowUp") {
                                  e.preventDefault();
                                  setSuggestIndex((i) => (i - 1 + suggestions.length) % suggestions.length);
                                  return;
                                }
                                if (e.key === "Enter" || e.key === "Tab") {
                                  e.preventDefault();
                                  acceptSuggestion(suggestions[suggestIndex].key);
                                  return;
                                }
                              }
                              if (e.key === "Escape" && suggestOpen) {
                                e.preventDefault();
                                setSuggestOpen(false);
                                return;
                              }
                              if (e.key === "Enter") {
                                commitWhen(cmd, index as number, whenDraft);
                                setEditingWhen(null);
                              } else if (e.key === "Escape") {
                                setEditingWhen(null);
                              }
                            }}
                          />
                          {suggestions.length > 0 && (
                            <div className="keybinding-when-suggest">
                              {suggestions.map((s, i) => (
                                <div
                                  key={s.key}
                                  className={`keybinding-when-suggest-item${i === suggestIndex ? " active" : ""}`}
                                  onMouseDown={(e) => e.preventDefault()}
                                  onMouseEnter={() => setSuggestIndex(i)}
                                  onClick={() => acceptSuggestion(s.key)}
                                >
                                  <span className="keybinding-when-suggest-key">{s.key}</span>
                                  <span className="keybinding-when-suggest-desc">{s.description}</span>
                                </div>
                              ))}
                            </div>
                          )}
                        </>
                      );
                    })()
                  ) : (
                    binding && (
                      <button
                        className="keybinding-when-display"
                        title={binding.when ? "Edit when clause" : "Add a when clause"}
                        onClick={() => {
                          const initial = binding.when ?? "";
                          setEditingWhen({ commandId: cmd.id, index: index as number });
                          setWhenDraft(initial);
                          setWhenCaret(initial.length);
                          setSuggestOpen(true);
                          setSuggestIndex(0);
                        }}
                      >
                        {binding.when ?? <Icon name="edit" />}
                      </button>
                    )
                  )}
                </span>
                <span className="keybinding-source">{binding ? (overridden ? "User" : "Default") : ""}</span>
                <span className="keybinding-row-actions">
                  {binding && (
                    <button
                      className="icon-button keybinding-action"
                      title={isRecordingRow ? "Cancel recording (Esc)" : "Change keybinding"}
                      onClick={() =>
                        setRecording(isRecordingRow ? null : { commandId: cmd.id, index: index as number })
                      }
                    >
                      <Icon name="edit" />
                    </button>
                  )}
                  {row.isLast && (
                    <button
                      className="icon-button keybinding-action"
                      title={isRecordingRow && index === null ? "Cancel recording (Esc)" : "Add another keybinding"}
                      onClick={() =>
                        setRecording(
                          isRecordingRow && index === null ? null : { commandId: cmd.id, index: "new" },
                        )
                      }
                    >
                      <Icon name="add" />
                    </button>
                  )}
                  {binding && (
                    <button
                      className="icon-button keybinding-action"
                      title="Remove this keybinding"
                      onClick={() => commitBindings(cmd, (resolved[cmd.id] ?? []).filter((_, i) => i !== index))}
                    >
                      <Icon name="close" />
                    </button>
                  )}
                  {row.isFirst && (
                    <button
                      className="icon-button keybinding-action"
                      title="Reset to default"
                      style={{ visibility: overridden ? "visible" : "hidden" }}
                      onClick={() => {
                        const next = { ...keybindingOverrides };
                        delete next[cmd.id];
                        onKeybindingOverridesChange(next);
                      }}
                    >
                      <Icon name="discard" />
                    </button>
                  )}
                </span>
              </div>
            );
          })}
          {rows.length === 0 && <div className="keybinding-empty">No matching keybindings</div>}
        </div>

        <div className="settings-footer">
          <button
            className="dialog-button secondary"
            disabled={Object.keys(keybindingOverrides).length === 0}
            onClick={() => onKeybindingOverridesChange({})}
          >
            Reset All Keybindings
          </button>
        </div>
      </div>
    </div>
  );
}
