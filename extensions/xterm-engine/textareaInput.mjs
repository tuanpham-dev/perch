// Keeps xterm.js's hidden textarea empty between keystrokes (plain JS so it
// runs under `node --test`; the engine bundles it via esbuild).
//
// WebKit (the desktop app's webview on Linux and macOS, and Safari) delivers
// some typed characters - spaces among them - through the textarea's `input`
// event rather than a keypress, so they stay in textarea.value after xterm
// has sent them. An IME commit there can also arrive with no
// compositionstart, and xterm's CompositionHelper then reads the commit as
// the whole value from position 0: every character still sitting in the
// textarea goes to the shell a second time, ahead of the composed text
// (`echo a ` + pinyin "nihao" sent "  你好", the spaces as U+00A0 - see
// plans/desktop-app.spike.md). Emptying the value once xterm has read each
// non-composing input leaves a later commit only its own text. The timer
// runs after xterm's own diff timer (FIFO), so xterm's delivery of the input
// itself is untouched; Chromium, where typed characters never stay in the
// value, sees nothing change.
export function keepTextareaClear(textarea) {
  let composing = false;
  const onStart = () => {
    composing = true;
  };
  const onEnd = () => {
    composing = false;
  };
  const onInput = (e) => {
    if (e.isComposing || composing) return;
    setTimeout(() => {
      if (!composing && textarea.value !== "") textarea.value = "";
    }, 0);
  };
  textarea.addEventListener("compositionstart", onStart);
  textarea.addEventListener("compositionend", onEnd);
  textarea.addEventListener("input", onInput);
  return () => {
    textarea.removeEventListener("compositionstart", onStart);
    textarea.removeEventListener("compositionend", onEnd);
    textarea.removeEventListener("input", onInput);
  };
}
