// The app's state directory: machine-local, regenerable things (the terminal
// daemon's socket and scrollback, extensions' runtime folders for their own
// sockets). PERCH_STATE_DIR moves it, the way PERCH_CONFIG_DIR moves the
// config directory, so a second instance keeps its own.
import { homedir } from "node:os";
import path from "node:path";

// Must agree with the terminal daemon's (mux/src/util/paths.ts). Resolved per
// call, as the daemon's is, so tests can point it at a throwaway directory.
export function stateDir(): string {
  if (process.env.PERCH_STATE_DIR) return process.env.PERCH_STATE_DIR;
  if (process.platform === "win32") {
    return path.join(process.env.LOCALAPPDATA || path.join(homedir(), "AppData", "Local"), "perch");
  }
  return process.env.XDG_STATE_HOME
    ? path.join(process.env.XDG_STATE_HOME, "perch")
    : path.join(homedir(), ".local", "state", "perch");
}
