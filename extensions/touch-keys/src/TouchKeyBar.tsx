import { useEffect, useRef, useState, type PointerEvent } from "react";
import { sendWithInkSafeEnters, whenMatches } from "@perch/engine-support";
import { parseSend, snippetIdOf, type TouchKey } from "./touchKeys";
import { isVoiceInputSupported, VoiceInput } from "./voiceInput";

interface Props {
  visible: boolean;
  keys: TouchKey[];
  // Set when the stored layout is broken (see layout.mjs): the bar says so
  // in place of keys, rather than showing a layout the user didn't choose.
  layoutError?: string | null;
  // Pushed by the server's attach watcher; gates each key's `when`. See
  // TerminalView's "command" WS message handling.
  currentCommand: string;
  stickyCtrl: boolean;
  onToggleStickyCtrl: () => void;
  onSendInput: (data: string) => void;
  // Final voice transcripts (plans/codeman-mobile-features.md Phase 5) route
  // through this instead of onSendInput: TerminalView wires it to the same
  // local-echo-or-direct fork image paste/drop already uses (sendTextOrEcho)
  // — voice text is plain printable text, not a control sequence, so it
  // belongs in the buffered overlay when local echo is active, unlike every
  // other touch key.
  onSendVoiceText: (text: string) => void;
  // Files picked via the `{image}` key (plans/mobile-image-upload-key.md)
  // route through this to TerminalView's uploadAndType — same upload
  // pipeline as desktop paste/drop. Any file type, not just images.
  onUploadImages: (files: File[]) => void;
}

// Filters `keys` down to the ones that should render right now: `when`
// matched against currentCommand, and `send` successfully parsed (a key
// authored with a bad token, or still empty mid-edit in Settings, is
// skipped rather than rendered broken). `{mic}` is filtered out entirely on
// a browser without SpeechRecognition ("hidden when unsupported" — checked
// here, not just inside the button, so an all-unsupported bar still collapses
// via the shown.length === 0 check below). Exported so FloatingTouchKeys
// renders the identical set.
export function visibleKeys(
  keys: TouchKey[],
  currentCommand: string,
): { key: TouchKey; data: string }[] {
  const result: { key: TouchKey; data: string }[] = [];
  for (const key of keys) {
    if (!whenMatches(key.when, currentCommand)) continue;
    if (key.send === "{ctrl}") {
      result.push({ key, data: "" });
      continue;
    }
    if (key.send === "{mic}") {
      if (isVoiceInputSupported()) result.push({ key, data: "" });
      continue;
    }
    if (key.send === "{image}") {
      result.push({ key, data: "" });
      continue;
    }
    // Snippet keys resolve at tap time (see TouchKeyButton) — nothing to
    // pre-parse, and a dangling reference still renders (the snippets
    // extension explains the miss on tap rather than the key silently
    // vanishing and reshuffling the layout).
    if (snippetIdOf(key.send)) {
      result.push({ key, data: "" });
      continue;
    }
    const parsed = parseSend(key.send);
    if ("error" in parsed || parsed.data === "") continue;
    result.push({ key, data: parsed.data });
  }
  return result;
}

// Pointer handlers that fire onTap only for a still tap. preventDefault on
// pointerdown keeps focus on the terminal's hidden textarea (so tapping a
// key never dismisses the on-screen keyboard), while the action itself waits
// for pointerup within a small movement threshold: when the bar overflows
// and the user swipes it, the browser's pan takes the pointer (pointercancel,
// no pointerup) — or the finger has moved — so the key the swipe started on
// doesn't send.
function useTapHandlers(onTap: () => void) {
  const start = useRef<{ x: number; y: number } | null>(null);
  return {
    onPointerDown: (e: PointerEvent) => {
      e.preventDefault();
      start.current = { x: e.clientX, y: e.clientY };
    },
    onPointerUp: (e: PointerEvent) => {
      const s = start.current;
      start.current = null;
      if (s && Math.hypot(e.clientX - s.x, e.clientY - s.y) < 10) onTap();
    },
    onPointerCancel: () => {
      start.current = null;
    },
  };
}

// Arrow-key autorepeat timing.
const REPEAT_DELAY_MS = 400;
const REPEAT_INTERVAL_MS = 40;

// The arrow keys, by their brace-token `send` — the keys that get hold-to-repeat.
function isArrowSend(send: string): boolean {
  const s = send.trim().toLowerCase();
  return s === "{up}" || s === "{down}" || s === "{left}" || s === "{right}";
}

// Like useTapHandlers but with hold-to-repeat, for arrow keys: a quick still
// tap fires once on release (preserving the anti-swipe behavior of the
// scrollable bar); holding past REPEAT_DELAY_MS starts firing every
// REPEAT_INTERVAL_MS until release. A horizontal swipe (finger moves before the
// hold begins) cancels without firing, so panning the bar never sends an arrow.
function useRepeatHandlers(onFire: () => void) {
  const state = useRef<{ x: number; y: number; fired: boolean } | null>(null);
  const timers = useRef<{ delay?: number; interval?: number }>({});
  const clearTimers = () => {
    window.clearTimeout(timers.current.delay);
    window.clearInterval(timers.current.interval);
    timers.current = {};
  };
  useEffect(() => clearTimers, []);
  const stop = () => {
    state.current = null;
    clearTimers();
  };
  return {
    onPointerDown: (e: PointerEvent) => {
      e.preventDefault();
      state.current = { x: e.clientX, y: e.clientY, fired: false };
      timers.current.delay = window.setTimeout(() => {
        if (state.current) state.current.fired = true;
        onFire();
        timers.current.interval = window.setInterval(onFire, REPEAT_INTERVAL_MS);
      }, REPEAT_DELAY_MS);
    },
    onPointerMove: (e: PointerEvent) => {
      const s = state.current;
      if (!s || s.fired) return;
      if (Math.hypot(e.clientX - s.x, e.clientY - s.y) >= 10) stop(); // swipe: cancel, no send
    },
    onPointerUp: (e: PointerEvent) => {
      const s = state.current;
      stop();
      // Quick still tap (repeat never started) fires once on release.
      if (s && !s.fired && Math.hypot(e.clientX - s.x, e.clientY - s.y) < 10) onFire();
    },
    onPointerCancel: stop,
    onPointerLeave: stop,
  };
}

// A `{mic}` key: toggles a VoiceInput session on tap, sending each final
// transcript through onTranscript. Its own component (unlike the stateless
// {ctrl} branch below) since it owns a VoiceInput instance's lifecycle —
// created once per mount, disposed on unmount, independent of whichever
// parent (TouchKeyBar or FloatingTouchKeys) renders it.
function MicKeyButton({ label, onTranscript }: { label: string; onTranscript: (text: string) => void }) {
  const [listening, setListening] = useState(false);
  const voiceRef = useRef<VoiceInput | null>(null);
  // Ref-mirrored so the VoiceInput instance (created once, in the effect
  // below) always calls the latest onTranscript without needing to be
  // recreated whenever the parent re-renders with a new closure identity.
  const onTranscriptRef = useRef(onTranscript);
  onTranscriptRef.current = onTranscript;

  useEffect(() => {
    const voice = new VoiceInput({
      onFinalResult: (text) => onTranscriptRef.current(text),
      onStateChange: setListening,
    });
    voiceRef.current = voice;
    return () => voice.dispose();
  }, []);

  const tap = useTapHandlers(() => voiceRef.current?.toggle());

  return (
    <button className={`touch-key touch-key-mic${listening ? " active" : ""}`} {...tap}>
      {label}
    </button>
  );
}

// An `{image}` key: opens the native file picker on tap, then hands the
// picked files to onUploadImages — TerminalView's uploadAndType, the same
// upload pipeline desktop paste/drop use. No `accept` attribute, so any file
// type can be picked (on iOS/Android the picker still offers the photo
// library and camera alongside the file browser); the token stays `{image}`
// for compatibility with saved layouts. The <input> stays hidden and
// permanently mounted; tap just proxies to its own click() (an
// <input type=file> can't be opened programmatically outside a user gesture,
// so this must fire from the same tap handler every other key uses).
function ImageKeyButton({ label, onUploadImages }: { label: string; onUploadImages: (files: File[]) => void }) {
  const inputRef = useRef<HTMLInputElement>(null);
  const tap = useTapHandlers(() => inputRef.current?.click());

  return (
    <>
      <input
        ref={inputRef}
        type="file"
        multiple
        style={{ display: "none" }}
        onChange={(e) => {
          const files = Array.from(e.target.files ?? []);
          e.target.value = "";
          if (files.length > 0) onUploadImages(files);
        }}
      />
      <button className="touch-key touch-key-image" {...tap}>
        {label}
      </button>
    </>
  );
}

// One key button: the sticky-Ctrl toggle for send === "{ctrl}" (applies to
// the next character typed, since holding Ctrl isn't possible with an
// on-screen keyboard), the mic toggle for send === "{mic}", otherwise a
// plain send button. Pointer handlers (not onClick) via useTapHandlers so
// tapping a button never steals focus from the terminal's hidden textarea —
// losing it would dismiss the on-screen keyboard — and so panning an
// overflowing bar doesn't send. Exported for reuse by FloatingTouchKeys.
export function TouchKeyButton({
  touchKey,
  data,
  stickyCtrl,
  onToggleStickyCtrl,
  onSendInput,
  onSendVoiceText,
  onUploadImages,
}: {
  touchKey: TouchKey;
  data: string;
  stickyCtrl: boolean;
  onToggleStickyCtrl: () => void;
  onSendInput: (data: string) => void;
  onSendVoiceText: (text: string) => void;
  onUploadImages: (files: File[]) => void;
}) {
  const isCtrl = touchKey.send === "{ctrl}";
  const snippetId = snippetIdOf(touchKey.send);
  const fire = () => {
    if (isCtrl) {
      onToggleStickyCtrl();
    } else if (snippetId) {
      // Handled by the snippets extension (see snippetIdOf's comment in
      // touchKeys.ts). The send callback keeps the text targeted at THIS
      // terminal — the snippets extension's own fallback types into the
      // active session's pane, which isn't necessarily the tapped one.
      window.dispatchEvent(
        new CustomEvent("perch:run-snippet", {
          detail: {
            id: snippetId,
            send: (text: string, submit: boolean) =>
              sendWithInkSafeEnters(text + (submit ? "\r" : ""), onSendInput),
          },
        }),
      );
    } else {
      sendWithInkSafeEnters(data, onSendInput);
    }
  };
  // Arrow keys hold-to-repeat; every other key is a single tap. Both hooks run
  // unconditionally (hook rules); the plain button below picks which to spread.
  const tap = useTapHandlers(fire);
  const repeat = useRepeatHandlers(fire);
  if (touchKey.send === "{mic}") {
    return <MicKeyButton label={touchKey.label} onTranscript={onSendVoiceText} />;
  }
  if (touchKey.send === "{image}") {
    return <ImageKeyButton label={touchKey.label} onUploadImages={onUploadImages} />;
  }
  if (isCtrl) {
    return (
      <button className={`touch-key touch-key-ctrl${stickyCtrl ? " active" : ""}`} {...tap}>
        {touchKey.label}
      </button>
    );
  }
  return (
    <button className="touch-key" {...(isArrowSend(touchKey.send) ? repeat : tap)}>
      {touchKey.label}
    </button>
  );
}

// Onscreen keys a mobile keyboard can't send (Esc, Tab, arrows, Ctrl+C by
// default) plus sticky Ctrl — fully user-customizable via Settings > UI
// (touchKeys.ts). Renders nothing when no key currently matches `when`.
// What the bar and the floating cluster show in place of keys while the
// stored layout is broken. The details (which key, which field) are in the
// layout editor, where there's room for them and where the fix happens.
export function TouchKeyLayoutError() {
  return (
    <span className="touch-key-layout-error">
      Touch keys layout is invalid - see Settings, Touch Keys
    </span>
  );
}

export default function TouchKeyBar({
  visible,
  keys,
  layoutError,
  currentCommand,
  stickyCtrl,
  onToggleStickyCtrl,
  onSendInput,
  onSendVoiceText,
  onUploadImages,
}: Props) {
  if (!visible) return null;
  if (layoutError) {
    return (
      <div className="touch-key-bar">
        <TouchKeyLayoutError />
      </div>
    );
  }
  const shown = visibleKeys(keys, currentCommand);
  if (shown.length === 0) return null;

  return (
    <div className="touch-key-bar">
      {shown.map(({ key, data }, i) => (
        <TouchKeyButton
          key={i}
          touchKey={key}
          data={data}
          stickyCtrl={stickyCtrl}
          onToggleStickyCtrl={onToggleStickyCtrl}
          onSendInput={onSendInput}
          onSendVoiceText={onSendVoiceText}
          onUploadImages={onUploadImages}
        />
      ))}
    </div>
  );
}
