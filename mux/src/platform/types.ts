// Everything the daemon, its client and its CLI need from the operating
// system, in one place. The rest of mux/ never touches /proc, signals, socket
// files or shells directly, so porting to another OS means writing one more
// implementation of this interface rather than hunting through callers.

export interface Platform {
  /** Where the daemon listens and clients connect, for a given state dir. */
  socketAddress(stateDir: string): string;
  /** Why this address can't be listened on, or null when it can. */
  addressProblem(address: string): string | null;
  /** Removes a leftover address from a daemon that died without cleaning up. */
  clearStaleAddress(address: string): void;
  /** Restricts the listening address to the current user. */
  secureAddress(address: string): void;

  /**
   * Takes the single-daemon lock at `lockPath`. A lock left by a process that
   * is no longer a daemon (`isLiveDaemon` false) is reclaimed. Returns false
   * when another live daemon holds it.
   */
  acquireLock(lockPath: string, isLiveDaemon: (pid: number) => boolean): boolean;
  /** True when `pid` is running and is the daemon started from `entryPath`. */
  isDaemonProcess(pid: number, entryPath: string): boolean;

  /** Starts `args` under `execPath`, detached from the caller's session and
   *  console, with `env` (default: this process's environment). */
  spawnDetached(execPath: string, args: string[], env?: NodeJS.ProcessEnv): void;
  /** Asks a daemon that no longer answers its socket to exit. */
  terminate(pid: number): void;
  /** Calls `cb` when the OS asks this process to stop. */
  onStopRequest(cb: () => void): void;

  /** Ends a window's shell and everything it started: gently, then for sure. */
  hangUpTree(pid: number): void;
  killTree(pid: number): void;

  /** Direct children of `pid`, oldest first. Empty when unknown. */
  childPids(pid: number): number[];
  /** What `pid` is called ("vim", "zsh", "vite"), or undefined when gone.
   *  A runtime that names only itself ("node", and the "node-MainThread" the
   *  OS reports for it) is resolved through util/process-label.ts, so this
   *  agrees with how the ports listing names the same process. */
  processName(pid: number): string | undefined;
  /** The live working directory of `pid`, or null when the OS won't say. */
  cwdOf(pid: number): string | null;

  /** The shell a window runs when none is configured. */
  defaultShell(): string;
  /** Calls `cb` when the attached terminal changes size. */
  onTerminalResize(cb: () => void): void;

  /**
   * Whether a window's raw output can be replayed byte for byte on attach.
   * False where the pseudo-terminal itself redraws the screen (Windows'
   * ConPTY), so replaying its bytes into a fresh terminal can land mid-redraw;
   * there the rebuilt screen is sent instead.
   */
  rawReplaySafe: boolean;
}
