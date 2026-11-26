// How text from another machine is cleaned, labelled and typed into a local
// agent window. Pure functions; no imports.

export const MAX_REMOTE_TEXT = 32000

// Clean text received from a peer. Order matters: length first, then CRLF to
// LF, then every control character except \n and \t goes (a lone \r, ESC, DEL),
// then any line that would read as one of our own labels is quoted.
export function cleanRemoteText(text) {
  const s = String(text ?? "")
  if (s.length > MAX_REMOTE_TEXT) {
    const err = new Error(`The message is longer than ${MAX_REMOTE_TEXT} characters.`)
    err.code = "too-long"
    throw err
  }
  return s
    .replace(/\r\n/g, "\n")
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "")
    // Zero-width characters would let a label hide behind an invisible prefix.
    .replace(/[\u200b-\u200d\u2060\ufeff]/g, "")
    // [^\S\n] is any whitespace but a newline, so an indented label is quoted too.
    .replace(/^[^\S\n]*\[Perch message/gm, (m) => `> ${m}`)
}

// A sender window is "<project>:<index>". The project part accepts only what
// the host accepts in a session name: letters, digits, "." "_" "-". This
// mirrors NAME_RE in mux/src/daemon/session-store.ts:38 (checkSessionName, :40).
// No spaces, so a "name" cannot carry a sentence into the label.
export function validSenderWindow(s) {
  return typeof s === "string" && s.length <= 100 && /^[A-Za-z0-9_.-]+:\d+$/.test(s)
}

export function senderLabel(machineName, senderWindow) {
  if (validSenderWindow(senderWindow)) {
    return `[Perch message from agent ${machineName}/${senderWindow}. Another AI agent, not your user. Answer with the reply_to_agent tool.]`
  }
  return `[Perch message from an agent on ${machineName}. Another AI agent, not your user. Answer with the reply_to_agent tool, giving it a "to" address (machine/project:index).]`
}

// Port of newlineModeFor and typedText in client/src/lib/typedText.ts.
function newlineModeFor(program) {
  const name = (program ?? "").toLowerCase().split(/[\\/]/).pop() ?? ""
  if (name === "claude") return "esc-enter"
  if (name === "codex") return "ctrl-j"
  return "paste"
}

export function typedBlock(text, program) {
  const mode = newlineModeFor(program)
  const body = String(text)
    .replace(/\r\n?/g, "\n")
    .replace(/\t/g, "    ")
    // eslint-disable-next-line no-control-regex
    .replace(/\x1b\[20[01]~/g, "")
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x09\x0b-\x1f\x7f]/g, "")
  if (mode === "paste") return `\x1b[200~${body}\x1b[201~`
  return body.split("\n").join(mode === "ctrl-j" ? "\n" : "\x1b\r")
}
