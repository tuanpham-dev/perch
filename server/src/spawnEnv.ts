import { isLauncherContextVar } from "perch-mux/spawn-env";

// The terminal backend (the bundled daemon and the tmux server alike) inherits
// the full environment of whichever process spawns it — and when that's this
// node process (the usual case on a fresh boot: createSession/attach run before
// the user ever starts one themselves), everything here lands in the backend's
// global environment and from there into every shell of every window of every
// session. Confirmed live on the tmux backend: PORT, ALLOWED_HOSTS, APP_NAME and the whole npm_*
// launch set were sitting in `show-environment -g`. Beyond the confusion
// (`npm run dev` inside a pane silently binding the production PORT), a set
// AUTH_TOKEN would hand the app's secret to every pane process.

// This server's own configuration vars — everything read from process.env
// for config anywhere in server/src. Keep in sync when adding config.
const SERVER_CONFIG_VARS = new Set([
  "PORT",
  "ALLOWED_HOSTS",
  "APP_NAME",
  "AUTH_TOKEN",
  "PROXY_DOMAIN",
  "EXTENSION_REGISTRY",
  "NEW_SESSION_CWD",
]);

// npm_* / INIT_CWD / NODE are `npm start` launch artifacts: absent from any
// normal login shell, and npm_package_*/npm_lifecycle_* actively mislead
// tools run inside panes into thinking they're in this server's package.
// Deliberately NOT stripped: vars from the surrounding login/container
// environment (PATH, LANG, SHOPIFY_CLI_DEVICE_AUTH, ...) — those aren't ours
// to police, and a user's plain shell would have them anyway.
//
// Also stripped: what the process that started this server knows about its
// own terminal (tmux's TMUX/TMUX_PANE, Claude Code's session markers). A new
// terminal is none of those; see isLauncherContextVar.
export function isServerOnlyVar(name: string): boolean {
  return (
    SERVER_CONFIG_VARS.has(name) ||
    isLauncherContextVar(name) ||
    name.startsWith("npm_") ||
    name === "INIT_CWD" ||
    name === "NODE"
  );
}

// process.env minus the server-only vars — for spawning anything that can
// start (or feed the environment of) the long-lived Perch. Fresh copy
// per call so later process.env mutations are never frozen into a snapshot.
export function spawnEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (!isServerOnlyVar(k)) env[k] = v;
  }
  return env;
}
