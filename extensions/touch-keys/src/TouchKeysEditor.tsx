import { useEffect, useRef, useState } from "react";
import { DEFAULT_TOUCH_KEYS, parseSend, snippetIdOf, type TouchKey } from "./touchKeys";
import { TouchKeyButton, visibleKeys } from "./TouchKeyBar";
import { readLayout, useTouchKeySettingsTick, writeKeys } from "./client";

// Drop position for an in-progress row drag: `id` is the target row's drop
// indicator id (its index in settings.touchKeys), `edge` says above or below
// that row. Mirrors TabBar.tsx's chip-drag drop-indicator shape, but
// vertical (top/bottom) instead of horizontal (left/right).
interface DropIndicator {
  index: number;
  edge: "top" | "bottom";
}

const MOVE_SLOP_PX = 5;

// Drag & drop reordering plus a live, tag-filterable preview for the
// touch-key layout editor — rendered inside this extension's Settings
// section via registerSettingsComponent (moved from core Settings > UI
// when touch keys became this extension).
export default function TouchKeysEditor() {
  // Layout persists as this extension's touchKeys.keys JSON setting —
  // readLayout/writeKeys in client.tsx own the (de)serialization.
  useTouchKeySettingsTick();
  const { keys, error: layoutError } = readLayout();
  const set = (_key: "touchKeys", next: TouchKey[]) => writeKeys(next);

  const [previewTag, setPreviewTag] = useState("All");
  // Saved snippets from the bundled snippets extension, for the "Add
  // snippet key" picker. Read from the synced settings doc rather than a
  // cross-extension API (extensions only see their own ctx) — the same
  // first-party coupling category as core knowing git-scm's diff viewer.
  // Empty (extension absent, no snippets, or fetch failure) just hides the
  // picker; existing {snippet:…} keys keep working regardless.
  const [snippetChoices, setSnippetChoices] = useState<{ id: string; name: string }[]>([]);
  useEffect(() => {
    fetch("/api/settings")
      .then((res) => (res.ok ? res.json() : null))
      .then((doc) => {
        const raw = doc?.extensionSettings?.["perch.snippets"]?.["snippets.items"];
        if (typeof raw !== "string" || !raw.trim()) return;
        const parsed: unknown = JSON.parse(raw);
        if (!Array.isArray(parsed)) return;
        setSnippetChoices(
          parsed
            .filter((s): s is { id: string; name: string } =>
              typeof s === "object" && s !== null &&
              typeof (s as { id?: unknown }).id === "string" &&
              typeof (s as { name?: unknown }).name === "string")
            .map((s) => ({ id: s.id, name: s.name })),
        );
      })
      .catch(() => {});
  }, []);
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [dropIndicator, setDropIndicator] = useState<DropIndicator | null>(null);
  const rowRefs = useRef<Map<number, HTMLDivElement>>(new Map());

  // Mutable drag-session state, mirroring TabBar.tsx's sessionRef — read
  // synchronously from window listeners registered outside React's event
  // system, so it can't rely on state batching.
  const sessionRef = useRef<{
    pointerId: number;
    index: number;
    startX: number;
    startY: number;
    dragging: boolean;
    insertIndex: number;
  } | null>(null);

  const updateKey = (i: number, next: TouchKey) => {
    const nextKeys = keys.slice();
    nextKeys[i] = next;
    set("touchKeys", nextKeys);
  };
  const removeKey = (i: number) => {
    set(
      "touchKeys",
      keys.filter((_, idx) => idx !== i),
    );
  };
  const addKey = () => {
    set("touchKeys", [...keys, { label: "", send: "", when: "" }]);
  };
  const restoreDefaultKeys = () => {
    set(
      "touchKeys",
      DEFAULT_TOUCH_KEYS.map((k) => ({ ...k })),
    );
  };

  // Distinct program names across every key's `when`, first-appearance
  // order — the same comma-split/trim/lowercase rule whenMatches applies at
  // runtime, so a tag here always corresponds to a real gate.
  const tags: string[] = [];
  for (const key of keys) {
    for (const name of key.when.split(",")) {
      const trimmed = name.trim().toLowerCase();
      if (trimmed && !tags.includes(trimmed)) tags.push(trimmed);
    }
  }
  // A tag the editor no longer has any key for (renamed/removed `when`)
  // falls back to "All" rather than showing an empty, orphaned preview.
  useEffect(() => {
    if (previewTag !== "All" && !tags.includes(previewTag)) setPreviewTag("All");
  }, [previewTag, tags]);

  const previewShown = visibleKeys(keys, previewTag === "All" ? "" : previewTag);

  // Hit-tests against rowRefs — a row can only reorder relative to the
  // other rows in this same list.
  const computeDropIndicator = (clientY: number, draggedIndex: number): DropIndicator | null => {
    const order = keys.map((_, i) => i).filter((i) => i !== draggedIndex);
    if (order.length === 0) return null;
    for (const i of order) {
      const el = rowRefs.current.get(i);
      if (!el) continue;
      const rect = el.getBoundingClientRect();
      if (clientY < rect.top + rect.height / 2) return { index: i, edge: "top" };
      if (clientY < rect.bottom) return { index: i, edge: "bottom" };
    }
    return { index: order[order.length - 1], edge: "bottom" };
  };

  const indicatorToInsertIndex = (indicator: DropIndicator, draggedIndex: number): number => {
    const order = keys.map((_, i) => i).filter((i) => i !== draggedIndex);
    const idx = order.findIndex((i) => i === indicator.index);
    return indicator.edge === "top" ? idx : idx + 1;
  };

  const removeWindowListeners = () => {
    window.removeEventListener("pointermove", onPointerMoveWindow);
    window.removeEventListener("pointerup", onPointerUpWindow);
    window.removeEventListener("pointercancel", onPointerCancelWindow);
  };

  const endSession = () => {
    sessionRef.current = null;
    setDragIndex(null);
    setDropIndicator(null);
  };

  // Safety net: if the component unmounts mid-drag, the gesture's own
  // pointerup/pointercancel will never fire to remove these listeners.
  useEffect(() => {
    return () => {
      if (!sessionRef.current) return;
      removeWindowListeners();
      sessionRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const onPointerMoveWindow = (e: PointerEvent) => {
    const session = sessionRef.current;
    if (!session || e.pointerId !== session.pointerId) return;
    if (!session.dragging) {
      const dx = e.clientX - session.startX;
      const dy = e.clientY - session.startY;
      if (Math.hypot(dx, dy) < MOVE_SLOP_PX) return;
      session.dragging = true;
      setDragIndex(session.index);
    }
    const indicator = computeDropIndicator(e.clientY, session.index);
    setDropIndicator(indicator);
    if (indicator) session.insertIndex = indicatorToInsertIndex(indicator, session.index);
  };

  const onPointerUpWindow = (e: PointerEvent) => {
    const session = sessionRef.current;
    if (!session || e.pointerId !== session.pointerId) return;
    removeWindowListeners();
    if (session.dragging) {
      const nextKeys = keys.slice();
      const [moved] = nextKeys.splice(session.index, 1);
      nextKeys.splice(session.insertIndex, 0, moved);
      set("touchKeys", nextKeys);
    }
    endSession();
  };

  const onPointerCancelWindow = (e: PointerEvent) => {
    const session = sessionRef.current;
    if (!session || e.pointerId !== session.pointerId) return;
    removeWindowListeners();
    endSession();
  };

  const handleGripPointerDown = (e: React.PointerEvent, index: number) => {
    if (e.pointerType === "mouse" && e.button !== 0) return;
    e.preventDefault();
    sessionRef.current = {
      pointerId: e.pointerId,
      index,
      startX: e.clientX,
      startY: e.clientY,
      dragging: false,
      insertIndex: index,
    };
    window.addEventListener("pointermove", onPointerMoveWindow);
    window.addEventListener("pointerup", onPointerUpWindow);
    window.addEventListener("pointercancel", onPointerCancelWindow);
  };

  // A broken stored layout gets no row editor: every edit writes the whole
  // list back, so editing from an empty list would overwrite the pasted
  // text the user is about to fix. They fix it in the JSON field above, or
  // start over from the defaults.
  if (layoutError) {
    return (
      <div className="settings-row">
        <span className="settings-label">Touch keys</span>
        <div className="touch-key-layout-error-details" role="alert">
          <strong>The layout above can't be used, so the key bar shows no keys until it's fixed.</strong>
          {"\n"}
          {layoutError}
        </div>
        <div className="touch-key-editor-buttons">
          <button type="button" className="dialog-button secondary" onClick={restoreDefaultKeys}>
            Restore default keys
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="settings-row">
      <span className="settings-label">Touch keys</span>
      <div className="touch-key-editor-legend">
        send: literal text, or tokens {"{esc} {tab} {enter} {up} {down} {left} {right} {home} {end} {pgup} {pgdn} {space} {^x}"}{" "}
        (Ctrl+x, e.g. {"{^c}"}), {"{{"} for a literal {"{"}, {"{ctrl}"} for sticky-Ctrl, {"{mic}"} for voice input (hidden if
        unsupported), {"{image}"} for an image picker (uploads to the Behavior settings' upload
        directory and types the path), {"{snippet:id}"} to run a saved snippet with its {"{param}"} prompts
        (use "Add snippet key" below). when: comma-separated program names (e.g. "nvim"); empty = always.
      </div>

      <div className="touch-key-preview">
        <div className="touch-key-preview-tags">
          <button
            type="button"
            className={`touch-key-preview-tag${previewTag === "All" ? " active" : ""}`}
            onClick={() => setPreviewTag("All")}
          >
            All
          </button>
          {tags.map((tag) => (
            <button
              type="button"
              key={tag}
              className={`touch-key-preview-tag${previewTag === tag ? " active" : ""}`}
              onClick={() => setPreviewTag(tag)}
            >
              {tag}
            </button>
          ))}
        </div>
        <div className="touch-key-preview-bar">
          {previewShown.length === 0 ? (
            <span className="touch-key-preview-empty">No keys match this tag</span>
          ) : (
            previewShown.map(({ key, data }, i) => (
              <TouchKeyButton
                key={i}
                touchKey={key}
                data={data}
                stickyCtrl={false}
                onToggleStickyCtrl={() => {}}
                onSendInput={() => {}}
                onSendVoiceText={() => {}}
                onUploadImages={() => {}}
              />
            ))
          )}
        </div>
      </div>

      <div className="touch-key-editor">
        {keys.map((key, i) => {
          const parsed =
            key.send === "{ctrl}" || key.send === "{mic}" || key.send === "{image}" || key.send === "" ||
            snippetIdOf(key.send) !== null
              ? null
              : parseSend(key.send);
          const error = parsed && "error" in parsed ? parsed.error : null;
          const indicatorClass = dropIndicator?.index === i ? ` drop-indicator-${dropIndicator.edge}` : "";
          const draggingClass = dragIndex === i ? " dragging" : "";
          return (
            <div
              className={`touch-key-editor-row${indicatorClass}${draggingClass}`}
              key={i}
              ref={(el) => {
                if (el) rowRefs.current.set(i, el);
                else rowRefs.current.delete(i);
              }}
            >
              <div
                className="touch-key-editor-grip"
                onPointerDown={(e) => handleGripPointerDown(e, i)}
                aria-label="Drag to reorder"
              >
                ⋮⋮
              </div>
              <input
                className="dialog-input touch-key-editor-label"
                placeholder="Label"
                value={key.label}
                onChange={(e) => updateKey(i, { ...key, label: e.target.value })}
              />
              <input
                className={`dialog-input touch-key-editor-send${error ? " invalid" : ""}`}
                placeholder="Send (e.g. {esc})"
                value={key.send}
                onChange={(e) => updateKey(i, { ...key, send: e.target.value })}
              />
              <input
                className="dialog-input touch-key-editor-when"
                placeholder="When (e.g. nvim)"
                value={key.when}
                onChange={(e) => updateKey(i, { ...key, when: e.target.value })}
              />
              <div className="touch-key-editor-actions">
                <button type="button" className="icon-button" onClick={() => removeKey(i)} aria-label="Remove key">
                  ✕
                </button>
              </div>
              {error && <div className="touch-key-editor-error">{error}</div>}
            </div>
          );
        })}
      </div>
      <div className="touch-key-editor-buttons">
        <button type="button" className="dialog-button secondary" onClick={addKey}>
          Add key
        </button>
        {snippetChoices.length > 0 && (
          <select
            className="dialog-input touch-key-editor-snippet-add"
            value=""
            onChange={(e) => {
              const chosen = snippetChoices.find((s) => s.id === e.target.value);
              if (chosen) {
                set("touchKeys", [...keys, { label: chosen.name, send: `{snippet:${chosen.id}}`, when: "" }]);
              }
              e.target.value = "";
            }}
          >
            <option value="">Add snippet key…</option>
            {snippetChoices.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        )}
        <button type="button" className="dialog-button secondary" onClick={restoreDefaultKeys}>
          Restore default keys
        </button>
      </div>
    </div>
  );
}
