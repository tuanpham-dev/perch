// macOS process facts without stalling the daemon. There is no /proc, so
// every answer is a ps or lsof run, and the daemon asks often: each listing
// and each scrollback save (scheduled by PTY output, so by typing) walks
// every window's process tree and reads its cwd. One synchronous run per pid
// per question was seconds of blocked event loop with a dozen windows, and
// keystrokes echoed that late. Instead one ps lists every process and one
// lsof answers every cwd asked about, each refreshed in the background at
// most once a second while somebody reads; a caller gets the latest finished
// answer straight away. Only a pid not seen yet is looked up while it waits.
// A refresh that changes an answer somebody asked for says so (onChange), so
// a snapshot saved from the stale one is saved again.

export type RunSync = (cmd: string, args: string[]) => string;
export type RunAsync = (cmd: string, args: string[], done: (stdout: string) => void) => void;

export interface DarwinProc { pid: number; ppid: number; comm: string }

const REFRESH_MS = 1_000;

/** Parses `ps -axo pid=,ppid=,comm=`: two numbers, then a name that may hold spaces. */
export function parsePs(out: string): Map<number, DarwinProc> {
  const procs = new Map<number, DarwinProc>();
  for (const line of out.split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    if (!m) continue;
    const pid = Number(m[1]);
    procs.set(pid, { pid, ppid: Number(m[2]), comm: m[3]!.trim() });
  }
  return procs;
}

/** Parses `lsof -Fn` output into pid -> path (a `p` line starts each process, `n` is its name). */
export function parseLsofCwd(out: string): Map<number, string> {
  const cwds = new Map<number, string>();
  let pid = NaN;
  for (const line of out.split('\n')) {
    if (line.startsWith('p')) pid = Number(line.slice(1));
    else if (line.startsWith('n') && Number.isInteger(pid)) cwds.set(pid, line.slice(1));
  }
  return cwds;
}

export type Later = (fn: () => void, ms: number) => void;

const unrefTimeout: Later = (fn, ms) => { setTimeout(fn, ms).unref(); };

// One background query, run at most once a second: straight away when asked
// while stale, or, when asked while fresh, as soon as it goes stale, so what
// was just read is looked at once more and a change made right after it
// (the cd that printed the prompt, the command just started) isn't missed.
class Refresh {
  #run: (done: () => void) => void;
  #now: () => number;
  #later: Later;
  #at = -Infinity;
  #busy = false;

  constructor(run: (done: () => void) => void, now: () => number, later: Later) {
    this.#run = run;
    this.#now = now;
    this.#later = later;
  }

  get stale(): boolean {
    return this.#now() - this.#at >= REFRESH_MS;
  }

  /** A synchronous lookup just answered: it counts as the latest run. */
  ran(): void {
    this.#at = this.#now();
  }

  ask(): void {
    if (this.#busy) return;
    this.#busy = true;
    const go = () => {
      this.#at = this.#now();
      this.#run(() => { this.#busy = false; });
    };
    const wait = this.#at + REFRESH_MS - this.#now();
    if (wait <= 0) go();
    else this.#later(go, wait);
  }
}

export class DarwinProcs {
  #runSync: RunSync;
  #runAsync: RunAsync;

  #procs: Map<number, DarwinProc> | null = null;
  #procsRefresh: Refresh;
  // A pid's command line, read once: what it names doesn't change.
  #argv = new Map<number, string[]>();
  // Pids asked about since the last refresh, whose answers it compares.
  #asked = new Set<number>();

  #cwds = new Map<number, string | null>();
  #cwdsRefresh: Refresh;

  #listeners: Array<() => void> = [];

  constructor(runSync: RunSync, runAsync: RunAsync, now: () => number = Date.now, later: Later = unrefTimeout) {
    this.#runSync = runSync;
    this.#runAsync = runAsync;
    this.#procsRefresh = new Refresh((done) => this.#refreshProcs(done), now, later);
    this.#cwdsRefresh = new Refresh((done) => this.#refreshCwds(done), now, later);
  }

  onChange(cb: () => void): void {
    this.#listeners.push(cb);
  }

  childPids(pid: number): number[] {
    return childrenIn(this.#table(pid), pid);
  }

  /** ps's comm for a live pid: the executable path, or "-zsh" for a login shell. */
  comm(pid: number): string | undefined {
    return this.#table(pid).get(pid)?.comm;
  }

  argv(pid: number): string[] {
    let argv = this.#argv.get(pid);
    if (!argv) {
      argv = this.#runSync('ps', ['-o', 'command=', '-p', String(pid)]).trim().split(/\s+/).filter(Boolean);
      if (argv.length > 0) this.#argv.set(pid, argv);
    }
    return argv;
  }

  cwd(pid: number): string | null {
    if (!this.#cwds.has(pid)) {
      this.#cwds.set(pid, parseLsofCwd(this.#runSync('lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn'])).get(pid) ?? null);
    }
    this.#cwdsRefresh.ask();
    return this.#cwds.get(pid) ?? null;
  }

  // The latest process table. A pid it doesn't hold yet (a window that
  // just spawned) waits for a fresh one, at most once a second, so asking
  // about dead pids can't cost a run per question.
  #table(pid: number): Map<number, DarwinProc> {
    this.#asked.add(pid);
    if (!this.#procs || (!this.#procs.has(pid) && this.#procsRefresh.stale)) {
      this.#setProcs(parsePs(this.#runSync('ps', ['-axo', 'pid=,ppid=,comm='])));
      this.#procsRefresh.ran();
    }
    this.#procsRefresh.ask();
    return this.#procs!;
  }

  #setProcs(procs: Map<number, DarwinProc>): void {
    this.#procs = procs;
    for (const pid of this.#argv.keys()) if (!procs.has(pid)) this.#argv.delete(pid);
  }

  #refreshProcs(done: () => void): void {
    const asked = [...this.#asked];
    this.#asked.clear();
    this.#runAsync('ps', ['-axo', 'pid=,ppid=,comm='], (out) => {
      done();
      const procs = parsePs(out);
      if (procs.size === 0) return;
      const before = this.#procs!;
      this.#setProcs(procs);
      if (asked.some((p) => describe(before, p) !== describe(procs, p))) this.#changed();
    });
  }

  // Every pid asked about, in one lsof. One that isn't in the answer has
  // exited (or has no cwd to report) and is dropped, to be asked afresh.
  #refreshCwds(done: () => void): void {
    const pids = [...this.#cwds.keys()];
    this.#runAsync('lsof', ['-a', '-p', pids.join(','), '-d', 'cwd', '-Fn'], (out) => {
      done();
      const fresh = parseLsofCwd(out);
      let changed = false;
      for (const pid of pids) {
        const cwd = fresh.get(pid);
        if (cwd === undefined) this.#cwds.delete(pid);
        else if (cwd !== this.#cwds.get(pid)) { this.#cwds.set(pid, cwd); changed = true; }
      }
      if (changed) this.#changed();
    });
  }

  #changed(): void {
    for (const cb of this.#listeners) cb();
  }
}

function childrenIn(procs: Map<number, DarwinProc>, pid: number): number[] {
  const out: number[] = [];
  for (const p of procs.values()) if (p.ppid === pid) out.push(p.pid);
  return out.sort((a, b) => a - b);
}

// What callers can learn about a pid from the table: its name and children.
function describe(procs: Map<number, DarwinProc>, pid: number): string {
  return `${procs.get(pid)?.comm ?? ''}|${childrenIn(procs, pid).join(',')}`;
}
