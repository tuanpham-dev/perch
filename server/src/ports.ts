import { execFile } from "node:child_process";
import { readFile, readlink } from "node:fs/promises";
import { buildProcessMap, type ProcInfo } from "./processes.js";
import { readSettingsDoc } from "./settingsStore.js";
import { listAllWindowPids } from "./terminals.js";

export interface ListeningPort {
  port: number;
  address: string;
  process?: string;
  pid?: number;
  // The terminal session the process belongs to, or the one it remembers
  // being started from when `orphan` is set. Empty only for a port the
  // "user" scope swept in, which no terminal ever started.
  session: string;
  // The process outlived the terminal that started it (or was never started
  // by one): still yours, still listening, but no live pane owns it.
  orphan?: boolean;
}

export interface RawPort {
  port: number;
  address: string;
  process?: string;
  pid?: number;
}

function ss(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("ss", args, { encoding: "utf8" }, (err, stdout, stderr) => {
      if (err) {
        reject(new Error(stderr.trim() || err.message));
      } else {
        resolve(stdout);
      }
    });
  });
}

// Address column looks like "127.0.0.54:53", "0.0.0.0:5432", "*:8080", or
// "[::]:8086" — split off the trailing ":port" rather than assuming a fixed
// delimiter count, since IPv6 addresses contain colons themselves.
function parseAddress(field: string): { address: string; port: number } | null {
  const idx = field.lastIndexOf(":");
  if (idx === -1) return null;
  const port = Number(field.slice(idx + 1));
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  let address = field.slice(0, idx);
  address = address.replace(/^\[|\]$/g, "");
  return { address, port };
}

// The "users:" column only appears for sockets owned by the requesting
// user — root-owned listeners (e.g. system services) omit it entirely, and
// therefore can never be attributed to a terminal below.
function parseProcess(line: string): { process?: string; pid?: number } {
  const match = line.match(/users:\(\("([^"]+)",pid=(\d+)/);
  if (!match) return {};
  return { process: match[1], pid: Number(match[2]) };
}

/** `lsof -nP -iTCP -sTCP:LISTEN -Fpcn` output (macOS). */
export function parseLsofListeners(stdout: string): RawPort[] {
  const out: RawPort[] = [];
  let pid: number | undefined;
  let proc: string | undefined;
  for (const line of stdout.split("\n")) {
    const field = line[0];
    const value = line.slice(1);
    if (field === "p") pid = Number(value);
    else if (field === "c") proc = value;
    else if (field === "n") {
      const parsed = parseAddress(value);
      if (parsed) out.push({ port: parsed.port, address: parsed.address, process: proc, pid });
    }
  }
  return out;
}

/** `Get-NetTCPConnection -State Listen | Select LocalAddress,LocalPort,OwningProcess | ConvertTo-Csv` (Windows). */
export function parseNetTcpCsv(csv: string, names: Map<number, ProcInfo>): RawPort[] {
  const out: RawPort[] = [];
  for (const line of csv.split(/\r?\n/).slice(1)) {
    const cells = line.split(",").map((c) => c.replace(/^"|"$/g, ""));
    if (cells.length < 3) continue;
    const port = Number(cells[1]);
    const pid = Number(cells[2]);
    if (!Number.isInteger(port) || port < 1 || port > 65535) continue;
    out.push({ port, address: cells[0]!, pid: pid > 0 ? pid : undefined, process: names.get(pid)?.comm });
  }
  return out;
}

function runQuiet(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve) => {
    execFile(cmd, args, { encoding: "utf8", maxBuffer: 16 * 1024 * 1024, windowsHide: true }, (err, stdout) => resolve(err ? "" : stdout));
  });
}

/** One entry per port, preferring whichever listener has process info. */
function byPortWithProcess(entries: RawPort[]): RawPort[] {
  const byPort = new Map<number, RawPort>();
  for (const e of entries) {
    const existing = byPort.get(e.port);
    if (!existing || (!existing.process && e.process)) byPort.set(e.port, e);
  }
  return [...byPort.values()].sort((a, b) => a.port - b.port);
}

async function listPorts(): Promise<RawPort[]> {
  if (process.platform === "darwin") {
    return byPortWithProcess(parseLsofListeners(await runQuiet("lsof", ["-nP", "-iTCP", "-sTCP:LISTEN", "-Fpcn"])));
  }
  if (process.platform === "win32") {
    const [csv, names] = await Promise.all([
      runQuiet("powershell.exe", [
        "-NoProfile", "-NonInteractive", "-Command",
        "Get-NetTCPConnection -State Listen | Select-Object LocalAddress,LocalPort,OwningProcess | ConvertTo-Csv -NoTypeInformation",
      ]),
      buildProcessMap(),
    ]);
    return byPortWithProcess(parseNetTcpCsv(csv, names));
  }
  const stdout = await ss(["-H", "-ltnp"]);
  const byPort = new Map<number, RawPort>();

  for (const line of stdout.split("\n")) {
    if (!line.trim()) continue;
    // State  Recv-Q  Send-Q  Local-Address:Port  Peer-Address:Port  [Process]
    const fields = line.trim().split(/\s+/);
    if (fields.length < 4) continue;
    const parsed = parseAddress(fields[3]);
    if (!parsed) continue;

    const { process: proc, pid } = parseProcess(line);
    const existing = byPort.get(parsed.port);
    // Prefer whichever entry has process info when the same port shows up
    // twice (e.g. separate IPv4/IPv6 listeners).
    if (!existing || (!existing.process && proc)) {
      byPort.set(parsed.port, { port: parsed.port, address: parsed.address, process: proc, pid });
    }
  }

  return [...byPort.values()].sort((a, b) => a.port - b.port);
}

const MAX_ANCESTRY_HOPS = 64;

// Interactive shells mark the boundary between the server's own npm/dev tree
// and whoever launched it — a user's pane shell, or an agent's per-command
// wrapper shell. npm runs package scripts with plain `sh`, deliberately
// absent here so it stays inside the tree.
const BOUNDARY_SHELLS = new Set(["zsh", "bash", "fish", "csh", "tcsh", "ksh"]);

// Ancestors of this server process, up to the terminal it's running in, the
// first interactive shell, or the process-tree root — whichever comes first
// (all excluded). A port whose owning process's chain passes through one of
// these pids belongs to perch itself or a sibling dev-server process
// spawned by the same `npm run dev`/concurrently tree (e.g. Vite), rather
// than to something the user launched in a terminal. Stopping at the
// shell keeps the set to exactly that tree: collecting all the way to the
// pane would also sweep in the launching shell/agent, wrongly excluding any
// *other* dev server the same agent spawns later.
function computeOwnAncestors(procMap: Map<number, ProcInfo>, panePids: Map<number, string>): Set<number> {
  const ancestors = new Set<number>();
  let pid = process.pid;
  for (let hop = 0; hop < MAX_ANCESTRY_HOPS; hop++) {
    if (pid <= 1 || panePids.has(pid)) break;
    const info = procMap.get(pid);
    if (info && BOUNDARY_SHELLS.has(info.comm)) break;
    ancestors.add(pid);
    if (!info) break;
    pid = info.ppid;
  }
  return ancestors;
}

// "own": the chain hit perch's own ancestry — hard-excluded, no
// fallback. "unknown": the chain dead-ended (reparented orphan, exited
// parent) — eligible for the PERCH_WINDOW environ fallback below.
type Attribution = { session: string } | "own" | "unknown";

// Walks a port's owning pid up its parent chain looking for a terminal window.
function attributeToSession(
  pid: number,
  procMap: Map<number, ProcInfo>,
  panePids: Map<number, string>,
  ownAncestors: Set<number>,
): Attribution {
  let cur = pid;
  for (let hop = 0; hop < MAX_ANCESTRY_HOPS; hop++) {
    if (ownAncestors.has(cur)) return "own";
    const session = panePids.get(cur);
    if (session) return { session };
    if (cur <= 1) return "unknown";
    const info = procMap.get(cur);
    if (!info) return "unknown";
    cur = info.ppid;
  }
  return "unknown";
}

// What a process remembers about the terminal it was started in. Linux only
// (other systems have no readable process environment; their orphaned
// listeners simply go unattributed).
//
// These survive reparenting: when the shell/agent that spawned a process
// exits, the process is reparented to pid 1 and the ppid walk above
// dead-ends, but the window id and session name it was spawned in stay in
// its (immutable) /proc environ. The window id is the precise key — it finds
// the live session even after a rename — and the session name is the
// fallback for when that window is closed, which is the whole point: the dev
// server is still listening long after you closed the pane you started it in.
//
// Same-user readable only — the same constraint ss's process column already
// imposes, so this can never attribute a port ss couldn't name.
interface TerminalOrigin {
  windowId: string | null;
  session: string | null;
}

async function readTerminalOrigin(pid: number): Promise<TerminalOrigin | null> {
  try {
    const raw = await readFile(`/proc/${pid}/environ`, "utf8");
    let windowId: string | null = null;
    let session: string | null = null;
    for (const entry of raw.split("\0")) {
      if (entry.startsWith("PERCH_WINDOW=") && entry.length > "PERCH_WINDOW=".length) {
        windowId = entry.slice("PERCH_WINDOW=".length);
      } else if (entry.startsWith("PERCH_SESSION=") && entry.length > "PERCH_SESSION=".length) {
        session = entry.slice("PERCH_SESSION=".length);
      } else if (entry.startsWith("TMUX_PANE=%") && !windowId) {
        // A pane of the tmux backend: its window id comes from tmux's pane id.
        windowId = `tmux-${entry.slice("TMUX_PANE=%".length)}`;
      }
    }
    return windowId || session ? { windowId, session } : null;
  } catch {
    // Exited, foreign-user, or no /proc (macOS) — unattributable.
    return null;
  }
}

// Node renames its main thread, so /proc's comm (and therefore ss's and
// lsof's process column) reads "node-MainThread" for every Node program on
// the box — true and useless. The command line says what it actually is.
const RUNTIMES = new Set([
  "node", "node-MainThread", "deno", "bun", "electron",
  "python", "python2", "python3", "ruby", "php", "perl", "java", "dotnet",
]);
// Flags whose value is the NEXT argv entry, so the value isn't mistaken for
// the script. Node takes --require/--import/--loader this way.
const VALUE_FLAGS = new Set([
  "-r", "--require", "--import", "--loader", "--experimental-loader",
  "--env-file", "--conditions", "-e", "--eval",
]);
// `python3 -m http.server` has no script: the module IS the name.
const MODULE_FLAGS = new Set(["-m", "--module"]);
// A script named after its position rather than its job: the folder it runs
// in says far more than "index.ts" does.
const GENERIC_SCRIPT = /^(index|main|server|app|start|cli|run|__main__)\.\w+$/;
// Folders that are equally a position rather than a name — qualified with
// their parent ("perch/server") to stay tellable apart across checkouts.
const GENERIC_DIR = new Set(["src", "server", "client", "app", "api", "web", "backend", "frontend", "lib"]);

const base = (p: string) => p.replace(/\/+$/, "").split("/").pop() ?? p;

/** The name to show for a process, from its argv and working directory. */
export function processLabel(argv: string[], cwd: string | null): string | null {
  const exe = argv[0] ? base(argv[0]) : null;
  if (!exe) return null;
  if (!RUNTIMES.has(exe)) return exe;
  let script: string | null = null;
  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i]!;
    if (MODULE_FLAGS.has(arg) && argv[i + 1]) return argv[i + 1]!;
    if (VALUE_FLAGS.has(arg)) {
      i++;
      continue;
    }
    if (arg.startsWith("-")) continue;
    script = arg;
    break;
  }
  if (script) {
    // A dependency's CLI (vite, next, nodemon…) is named by its bin entry.
    const bin = /(?:^|\/)node_modules\/\.bin\/([^/]+)$/.exec(script);
    if (bin) return bin[1]!;
    // Anything else out of node_modules is named after the package that owns
    // it: a package's own entry file is called bin.js or index.js far more
    // often than it is called anything useful.
    const pkg = /(?:^|\/)node_modules\/(@[^/]+\/[^/]+|[^@][^/]*)\//g;
    let owner: string | null = null;
    for (let m = pkg.exec(script); m; m = pkg.exec(script)) owner = m[1]!;
    if (owner && owner !== ".bin") return owner;
    const name = base(script);
    if (!GENERIC_SCRIPT.test(name)) return name;
  }
  if (cwd) {
    const dir = base(cwd);
    if (GENERIC_DIR.has(dir)) {
      const parent = base(cwd.slice(0, cwd.length - dir.length - 1));
      if (parent) return `${parent}/${dir}`;
    }
    return dir;
  }
  return script ? base(script) : exe;
}

// Linux only: the other platforms' listings already carry a usable name.
async function describeProcess(pid: number): Promise<string | null> {
  if (process.platform !== "linux") return null;
  try {
    const [raw, cwd] = await Promise.all([
      readFile(`/proc/${pid}/cmdline`, "utf8"),
      readlink(`/proc/${pid}/cwd`).catch(() => null),
    ]);
    return processLabel(raw.split("\0").filter(Boolean), cwd);
  } catch {
    // Exited or unreadable — the listing's own name stands.
    return null;
  }
}

// How far past "a terminal that is still open" the listing reaches. The
// proxy and the tunnel serve exactly what this returns (getTunnelablePorts),
// so this setting is also the allowlist for both — see the hint on it in
// Settings → Behavior.
export type PortScope = "open" | "launched" | "user";

async function readPortScope(): Promise<PortScope> {
  const settings = ((await readSettingsDoc()).settings ?? {}) as Record<string, unknown>;
  const scope = settings.portScope;
  return scope === "open" || scope === "user" ? scope : "launched";
}

// Listening ports whose owning process lives inside a terminal's process
// tree, by ppid walk or — for orphaned trees — by the PERCH_WINDOW /
// PERCH_SESSION breadcrumbs in its environ. perch's own server and the dev
// tooling around it are always excluded, and so is any socket whose owner
// the kernel won't name for us (root's, another user's): scope only decides
// how much of the rest comes along.
async function scanTerminalPorts(): Promise<ListeningPort[]> {
  const [ports, panes, procMap, scope] = await Promise.all([
    listPorts(),
    listAllWindowPids(),
    buildProcessMap(),
    readPortScope(),
  ]);
  const ownAncestors = computeOwnAncestors(procMap, panes.byPid);

  const attributed = await Promise.all(
    ports.map(async (port): Promise<ListeningPort | null> => {
      if (port.pid === undefined) return null;
      const result = attributeToSession(port.pid, procMap, panes.byPid, ownAncestors);
      if (result === "own") return null;
      if (result !== "unknown") return withProcessName(port, { session: result.session });
      // The chain dead-ended: a process reparented to init when whatever
      // started it exited. Its own environ still says where it came from.
      const origin = await readTerminalOrigin(port.pid);
      const live = origin?.windowId ? panes.byWindowId.get(origin.windowId) : undefined;
      // That window is still open — an ordinary attribution, not an orphan,
      // and the one case every scope agrees on.
      if (live) return withProcessName(port, { session: live });
      if (scope === "open") return null;
      if (origin) return withProcessName(port, { session: origin.session ?? "", orphan: true });
      return scope === "user" ? withProcessName(port, { session: "", orphan: true }) : null;
    }),
  );
  return attributed.filter((p): p is ListeningPort => p !== null);
}

// Fills in the process name from the command line, which is what a Node
// program is actually called (see processLabel), keeping the listing's own
// name when /proc can't say.
async function withProcessName(port: RawPort, rest: Omit<ListeningPort, keyof RawPort>): Promise<ListeningPort> {
  const label = port.pid === undefined ? null : await describeProcess(port.pid);
  return { ...port, ...rest, process: label ?? port.process };
}

const SCAN_CACHE_TTL_MS = 2_000;
let scanCache: { expiresAt: number; ports: ListeningPort[] } | null = null;
let scanPromise: Promise<ListeningPort[]> | null = null;

// Cached briefly so the panel's 5s poll (one per connected client) and the
// tunnel gate — which can open many channels back to back on a single page
// load — share one session listing + /proc sweep + ss run.
export function listTerminalPorts(): Promise<ListeningPort[]> {
  if (scanCache && scanCache.expiresAt > Date.now()) {
    return Promise.resolve(scanCache.ports);
  }
  if (scanPromise) return scanPromise;

  scanPromise = scanTerminalPorts()
    .then((ports) => {
      scanCache = { expiresAt: Date.now() + SCAN_CACHE_TTL_MS, ports };
      return ports;
    })
    .finally(() => {
      scanPromise = null;
    });
  return scanPromise;
}

// Looks up a single port's terminal attribution on demand (kill confirmation and
// the 5s SIGKILL-escalation recheck both want a fresh, uncached read, unlike
// getTunnelablePorts below).
export async function findTerminalPort(port: number): Promise<ListeningPort | null> {
  const ports = await scanTerminalPorts();
  return ports.find((p) => p.port === port) ?? null;
}

// The set of ports currently tunnelable — a view over the shared cached scan.
export function getTunnelablePorts(): Promise<Set<number>> {
  return listTerminalPorts().then((ports) => new Set(ports.map((p) => p.port)));
}
