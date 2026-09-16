// Clipboard-tool shims: xclip, xsel, wl-copy and pbcopy stand-ins, first on
// PATH in the app's terminals (mux.ts's terminalEnv). A CLI that copies by
// piping into one of those (gh's one-time code, say) finds no display on a
// headless host, and the real tool fails. The shim instead writes the text as
// an OSC 52 sequence to the terminal, which the browser engine turns into a
// real clipboard write. With a display the real tool runs, unchanged.
//
// Reading the clipboard back is not possible from here (the engine does not
// answer OSC 52 queries, and a browser will not hand over the clipboard
// without a user gesture), so the read forms print nothing and succeed.
import { chmod, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { displayFallback, shimBinDir } from "./openUrl.js";

export const CLIPBOARD_TOOLS = ["xclip", "xsel", "wl-copy", "pbcopy"] as const;

export function clipboardShimScript(name: string, dir: string = shimBinDir): string {
  return `#!/bin/sh
# Written by Perch at startup - copies to the browser's clipboard through
# OSC 52 when this host has no display; with one, runs the real ${name}.
${displayFallback(name, dir)}# The read forms (xclip -o, xsel -o) have nothing to read back: succeed empty.
# wl-copy alone takes the text as arguments; its -t and -s take a value.
text=
skip=
for arg in "$@"; do
  if [ -n "$skip" ]; then skip=; continue; fi
  case "$arg" in
    -o|-out|-output|--output) exit 0 ;;
    -t|--type|-s|--seat) skip=1 ;;
    -*) ;;
    *) [ ${JSON.stringify(name)} = wl-copy ] && text="\${text:+$text }$arg" ;;
  esac
done
if [ -n "$text" ]; then
  data=$(printf %s "$text" | base64 | tr -d '\\n')
elif [ -t 0 ]; then
  exit 0
else
  data=$(base64 | tr -d '\\n')
fi
[ -n "$data" ] || exit 0
printf '\\033]52;c;%s\\007' "$data" > /dev/tty 2>/dev/null || exit 1
`;
}

// Best-effort at boot, like the other shims: failure disables the bridge,
// never the server. Windows programs copy through the console, so none there.
export async function ensureClipboardShims(dir: string = shimBinDir): Promise<void> {
  if (process.platform === "win32") return;
  await mkdir(dir, { recursive: true });
  for (const name of CLIPBOARD_TOOLS) {
    const file = path.join(dir, name);
    await writeFile(file, clipboardShimScript(name, dir));
    await chmod(file, 0o755);
  }
}
