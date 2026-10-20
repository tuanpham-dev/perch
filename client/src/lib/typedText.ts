// Text as the keystrokes that put it into an agent's input box as one block,
// without submitting it partway. Ported from the Claude Viewer extension's
// keys.mjs typedText, with the line break chosen per agent, because each
// agent's input opens a new line with a different key:
//
//   "esc-enter"  Claude Code: Esc+Enter, the sequence /terminal-setup binds
//                Shift+Enter to. Typed rather than pasted on purpose: Claude
//                Code files any paste of 20+ characters away as pasted
//                content, and the model then reads it as material quoted from
//                elsewhere rather than as the user's own words.
//   "ctrl-j"     Codex: Ctrl+J (a bare line feed) inserts a newline; Esc
//                would interrupt or go back a turn.
//   "paste"      anything else: one bracketed paste, which every input box
//                that understands bracketed paste takes as text, line breaks
//                included, without acting on it.
//
// Control bytes are dropped in every mode (they would act as keys: \x03
// interrupts a turn), and tabs become four spaces.
export type NewlineMode = "esc-enter" | "ctrl-j" | "paste";

export function newlineModeFor(program: string | null | undefined): NewlineMode {
  const name = (program ?? "").toLowerCase().split(/[\\/]/).pop() ?? "";
  if (name === "claude") return "esc-enter";
  if (name === "codex") return "ctrl-j";
  return "paste";
}

export function typedText(text: string, mode: NewlineMode = "esc-enter"): string {
  const body = String(text)
    .replace(/\r\n?/g, "\n")
    .replace(/\t/g, "    ")
    // eslint-disable-next-line no-control-regex
    .replace(/\x1b\[20[01]~/g, "")
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x09\x0b-\x1f\x7f]/g, "");
  if (mode === "paste") return `\x1b[200~${body}\x1b[201~`;
  return body.split("\n").join(mode === "ctrl-j" ? "\n" : "\x1b\r");
}
