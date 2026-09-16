// Environment for shells the daemon spawns. The daemon is long-lived and usually
// auto-spawned by whichever perch process first needed it — the app server, the
// CLI, or a test runner — so its own process.env carries that ancestor's launch
// baggage. Without scrubbing, every shell of every window inherits it: npm_*
// lifecycle vars mislead tools into thinking they run inside perch's package,
// and app config like AUTH_TOKEN would hand the server's secret to every shell.
// (Same failure perch verified live in its spawnEnv.ts: PORT, AUTH_TOKEN
// and the whole npm_* set were sitting in the tmux backend's global environment.)
//
// Deliberately NOT stripped: vars from the surrounding login/container
// environment (PATH, LANG, ...) — those aren't ours to police, and a user's
// plain shell would have them anyway. PERCH_STATE_DIR/PERCH_CONFIG_DIR are also
// kept: a `perch-mux` invocation inside a window should target the same daemon
// that spawned it.

// The perch web server's own configuration vars — keep in sync with server config.
const APP_CONFIG_VARS = new Set([
  'PORT',
  'ALLOWED_HOSTS',
  'APP_NAME',
  'AUTH_TOKEN',
  'PROXY_DOMAIN',
  'EXTENSION_REGISTRY',
  'NEW_SESSION_CWD',
]);

// What the process that launched the daemon knows about *its own* terminal,
// set for its children. A server started from inside a tmux pane, a Claude
// Code session, or one of this app's own windows passes these down, and a
// fresh window is none of those: tmux vars make tools think they run inside
// tmux, and Claude Code's child-session marker makes `claude` in the window
// run as a subagent of the launcher (with transcript saving off). Only the
// vars those programs set for their children are listed; user configuration
// such as CLAUDE_CODE_USE_BEDROCK is left alone.
const LAUNCHER_CONTEXT_VARS = new Set([
  'TMUX',
  'TMUX_PANE',
  'PERCH_SESSION',
  'PERCH_WINDOW',
  'PERCH_SERVER_URL',
  'CLAUDECODE',
  'CLAUDE_PID',
  'CLAUDE_EFFORT',
  'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_CODE_EXECPATH',
  'CLAUDE_CODE_CHILD_SESSION',
  'CLAUDE_CODE_SESSION_ID',
  'CLAUDE_CODE_SESSION_ATTENDED',
  'CLAUDE_CODE_BRIDGE_SESSION_ID',
  'CLAUDE_CODE_MESSAGING_TOKEN',
  'CLAUDE_CODE_MESSAGING_SOCKET',
]);

export function isLauncherContextVar(name: string): boolean {
  return LAUNCHER_CONTEXT_VARS.has(name);
}

function isDaemonOnlyVar(name: string): boolean {
  return (
    APP_CONFIG_VARS.has(name) ||
    LAUNCHER_CONTEXT_VARS.has(name) ||
    name.startsWith('npm_') ||
    name === 'INIT_CWD' ||
    name === 'NODE'
  );
}

export type SpawnIdentity = {
  /** Session name at spawn time (a later session.rename does not update it). */
  sessionName: string;
  /** The window's stable uuid — the durable identity, analog of $TMUX_PANE. */
  windowId: string;
  /**
   * The app server this shell should report commands to, when one has
   * announced itself.
   *
   * The shell integration script bakes in a port, and every server writes that
   * file at startup — so a second server on another port silently redirects
   * every shell's reporting to itself, including the shells of the first. The
   * daemon knows which server actually announced itself to it, which is a
   * better answer than whichever one wrote the file last.
   */
  serverUrl?: string | null;
};

/**
 * Fresh scrubbed copy of process.env plus the window's identity vars.
 * Fresh per call so later process.env mutations are never frozen into a
 * snapshot.
 */
export function spawnEnv(identity: SpawnIdentity): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined && !isDaemonOnlyVar(k)) env[k] = v;
  }
  env.PERCH_SESSION = identity.sessionName;
  env.PERCH_WINDOW = identity.windowId;
  if (identity.serverUrl) env.PERCH_SERVER_URL = identity.serverUrl;
  return env;
}
