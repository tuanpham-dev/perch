// Web Speech API wrapper for the touch key bar's mic key
// (plans/codeman-mobile-features.md Phase 5). No Deepgram/external key —
// browser-native SpeechRecognition only, so this degrades to "hidden"
// wherever it's unsupported.

// Not in TS's lib.dom.d.ts (Web Speech API isn't part of the standard yet)
// — declared narrowly to just what's used here, not the full spec.
interface SpeechRecognitionResultLike {
  0: { transcript: string };
  isFinal: boolean;
}
interface SpeechRecognitionEventLike {
  resultIndex: number;
  results: ArrayLike<SpeechRecognitionResultLike>;
}
interface SpeechRecognitionLike extends EventTarget {
  continuous: boolean;
  interimResults: boolean;
  onresult: ((e: SpeechRecognitionEventLike) => void) | null;
  onend: (() => void) | null;
  onerror: (() => void) | null;
  start(): void;
  stop(): void;
}
type SpeechRecognitionCtor = new () => SpeechRecognitionLike;

function getCtor(): SpeechRecognitionCtor | undefined {
  const w = window as unknown as {
    SpeechRecognition?: SpeechRecognitionCtor;
    webkitSpeechRecognition?: SpeechRecognitionCtor;
  };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition;
}

export function isVoiceInputSupported(): boolean {
  return getCtor() !== undefined;
}

export interface VoiceInputHandlers {
  onFinalResult: (text: string) => void;
  onStateChange: (listening: boolean) => void;
}

const SILENCE_TIMEOUT_MS = 3000;

// One mic session: start()/stop()/toggle(), auto-stopping after
// SILENCE_TIMEOUT_MS with no new result (interim or final) to reset the
// timer. Constructing this when isVoiceInputSupported() is false throws —
// callers must check first.
export class VoiceInput {
  private readonly recognition: SpeechRecognitionLike;
  private readonly handlers: VoiceInputHandlers;
  private listening = false;
  private silenceTimer: number | undefined;

  constructor(handlers: VoiceInputHandlers) {
    const Ctor = getCtor();
    if (!Ctor) throw new Error("SpeechRecognition unsupported");
    this.handlers = handlers;
    this.recognition = new Ctor();
    this.recognition.continuous = true;
    this.recognition.interimResults = true;
    this.recognition.onresult = (e) => {
      this.resetSilenceTimer();
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const result = e.results[i];
        if (result.isFinal) this.handlers.onFinalResult(result[0].transcript);
      }
    };
    this.recognition.onend = () => {
      this.listening = false;
      window.clearTimeout(this.silenceTimer);
      this.handlers.onStateChange(false);
    };
    this.recognition.onerror = () => {
      // Notifies the same as onend: browsers normally fire both for a real
      // error, but calling onStateChange here too (harmless if onend also
      // fires — setting React state to the same value is a no-op) means a
      // permission denial or any other error can't leave the UI stuck
      // showing "listening" if onend is ever skipped.
      this.listening = false;
      this.handlers.onStateChange(false);
    };
  }

  start(): void {
    if (this.listening) return;
    this.listening = true;
    this.recognition.start();
    this.handlers.onStateChange(true);
    this.resetSilenceTimer();
  }

  stop(): void {
    if (!this.listening) return;
    this.recognition.stop();
  }

  toggle(): void {
    if (this.listening) this.stop();
    else this.start();
  }

  private resetSilenceTimer(): void {
    window.clearTimeout(this.silenceTimer);
    this.silenceTimer = window.setTimeout(() => this.stop(), SILENCE_TIMEOUT_MS);
  }

  dispose(): void {
    window.clearTimeout(this.silenceTimer);
    this.recognition.onresult = null;
    this.recognition.onend = null;
    this.recognition.onerror = null;
    if (this.listening) this.recognition.stop();
  }
}
