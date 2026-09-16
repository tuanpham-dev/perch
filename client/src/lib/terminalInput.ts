// Terminal input utilities shared by core (TerminalView's local-echo
// gating and text sending) and the touch-keys extension (via the
// @perch/engine-support shim) — split out of the old touchKeys.ts
// when the touch-key bar became an extension.

// Empty `when` always matches; otherwise the pane's foreground command must
// exactly equal one of the comma-separated names (case-insensitive).
export function whenMatches(when: string, command: string): boolean {
  const trimmed = when.trim();
  if (!trimmed) return true;
  const cmd = command.trim().toLowerCase();
  return trimmed.split(",").some((name) => name.trim().toLowerCase() === cmd);
}

// Ink-based TUIs (Claude Code) can drop input when text and its trailing
// Enter arrive in the same WS frame/instant — the same reason TerminalView's
// local-echo-to-be (plans/codeman-mobile-features.md) sends text then \r
// 80ms apart. Splits already-parsed `data` (real bytes, not the {token}
// notation) at \r: each text segment sends immediately, each \r sends 80ms
// after the segment before it — chained, so "a\rb\rc" sends a(0ms),
// \r(80ms), b(80ms), \r(160ms), c(160ms). Data with no \r sends in one
// call, byte-identical to calling `send` directly.
export function sendWithInkSafeEnters(data: string, send: (chunk: string) => void): void {
  const parts = data.split("\r");
  let delay = 0;
  const scheduleSend = (chunk: string) => {
    if (delay === 0) send(chunk);
    else setTimeout(() => send(chunk), delay);
  };
  parts.forEach((part, i) => {
    if (part) scheduleSend(part);
    if (i < parts.length - 1) {
      delay += 80;
      scheduleSend("\r");
    }
  });
}
