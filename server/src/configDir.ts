// The app's config directory: settings, extensions, push subscriptions, the
// browser-opener and agent-hook shims, the shell integration script, and the
// terminal daemon's mux.json. PERCH_CONFIG_DIR moves it, so a second
// instance (a test build beside the one you use) keeps its own shims instead
// of rewriting the other's. XDG_CONFIG_HOME isn't used for that because every
// program started in a terminal would inherit it.
import { homedir } from "node:os";
import path from "node:path";

// Must agree with the terminal daemon's (mux/src/util/paths.ts): the server
// writes the daemon's mux.json here.
export const configDir =
  process.env.PERCH_CONFIG_DIR ||
  (process.platform === "win32"
    ? path.join(process.env.APPDATA || path.join(homedir(), "AppData", "Roaming"), "perch")
    : path.join(process.env.XDG_CONFIG_HOME || path.join(homedir(), ".config"), "perch"));
