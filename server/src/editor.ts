// Opening files, diffs and merges in nvim running in the app's terminals, and
// horizontal scroll inside nvim. The terminal engine only types into windows
// and creates them; finding a running nvim and its RPC socket is a question
// about the host's processes (processes.ts).
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, readlink, writeFile } from "node:fs/promises";
import net from "node:net";
import { tmpdir, userInfo } from "node:os";
import path from "node:path";
import { getMultiplexer, type MuxWindow } from "./multiplexer.js";
import { buildProcessMap, findDescendants } from "./processes.js";
import { findWindow, listSessionPanes, resolveAttachTarget } from "./terminals.js";

const mux = () => getMultiplexer();

// These routes are addressed by a tab's attach target, a session name or a
// window tab's "@<windowId>"; resolveAttachTarget (terminals.ts) names the window.
async function resolveTarget(target: string): Promise<{ session: string; window: MuxWindow }> {
  const { session, window } = await resolveAttachTarget(target, { fresh: true });
  return { session: session.name, window };
}

// ---- nvim RPC socket discovery ----

// Finds the unix-domain socket a running nvim process is listening on, by
// cross-referencing its open socket fds (/proc/<pid>/fd) against the kernel's
// socket table (/proc/net/unix), which lists the bound path alongside each
// listening socket's inode. Returns null if nvim can't be located this way
// (non-Linux host, sandboxed /proc, or nvim started with no default server).
async function readNvimSocketPath(nvimPid: number): Promise<string | null> {
  let fds: string[];
  try {
    fds = await readdir(`/proc/${nvimPid}/fd`);
  } catch {
    return null;
  }
  const inodes = new Set<string>();
  await Promise.all(
    fds.map(async (fd) => {
      try {
        const target = await readlink(`/proc/${nvimPid}/fd/${fd}`);
        const m = target.match(/^socket:\[(\d+)\]$/);
        if (m) inodes.add(m[1]);
      } catch {
        // fd closed between readdir and readlink; ignore.
      }
    }),
  );
  if (inodes.size === 0) return null;

  let unixTable: string;
  try {
    unixTable = await readFile("/proc/net/unix", "utf8");
  } catch {
    return null;
  }
  for (const line of unixTable.split("\n").slice(1)) {
    const cols = line.trim().split(/\s+/);
    const inode = cols[6];
    const socketPath = cols[7];
    if (inode && inodes.has(inode) && socketPath?.includes("nvim")) {
      return socketPath;
    }
  }
  return null;
}

// A live socket file on disk is not the same as a live listener — a stale
// nvim.<user>/<id>/nvim.<pid>.0 path can outlive the process, and pointing
// `nvim --server` at a dead socket does NOT fail: nvim prints "E247:
// connection refused. Editing locally" and starts a full interactive editor
// that never exits, hanging the caller forever. Probing first (~250ms budget)
// turns that into a fast "no RPC available" so the caller falls back to
// keystrokes instead of hanging.
function isSocketAlive(socket: string): Promise<boolean> {
  return new Promise((resolve) => {
    const conn = net.createConnection(socket);
    const finish = (alive: boolean) => {
      conn.removeAllListeners();
      conn.destroy();
      resolve(alive);
    };
    conn.setTimeout(250, () => finish(false));
    conn.once("connect", () => finish(true));
    conn.once("error", () => finish(false));
  });
}

// Where nvim's default server for `pid` lives when it can't be read from
// /proc: a named pipe on Windows, a socket under $TMPDIR/nvim.<user>/ on macOS.
async function nvimSocketCandidates(pid: number): Promise<string[]> {
  if (process.platform === "win32") return [`\\\\.\\pipe\\nvim.${pid}.0`];
  const base = path.join(process.env.TMPDIR || tmpdir(), `nvim.${userInfo().username}`);
  let dirs: string[] = [];
  try {
    dirs = await readdir(base);
  } catch {
    return [];
  }
  return dirs.map((d) => path.join(base, d, `nvim.${pid}.0`));
}

async function findNvimSocket(shellPid: number): Promise<string | null> {
  const map = await buildProcessMap();
  const nvimPids = findDescendants(shellPid, map, (comm) => comm === "nvim");
  for (const pid of nvimPids) {
    const candidates = process.platform === "linux" ? [await readNvimSocketPath(pid)] : await nvimSocketCandidates(pid);
    for (const socket of candidates) {
      if (socket && (await isSocketAlive(socket))) return socket;
    }
  }
  return null;
}

// A hard timeout backs up the isSocketAlive probe: a socket that dies between
// the probe and this call would otherwise still hang the request.
const NVIM_REMOTE_TIMEOUT_MS = 5_000;

function nvimRemote(socket: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(
      "nvim",
      ["--server", socket, ...args],
      { timeout: NVIM_REMOTE_TIMEOUT_MS, killSignal: "SIGKILL" },
      (err, _stdout, stderr) => {
        if (err) reject(new Error(stderr.trim() || err.message));
        else resolve();
      },
    );
  });
}

// "--remote-tab" opens the file with :tab-edit, so it lands in a new tab. A
// `+<line>` argument there is read as a second filename, not a jump, so the
// cursor is driven with a separate --remote-send once the tab is active.
async function nvimRemoteOpen(socket: string, filePath: string, line?: number): Promise<void> {
  await nvimRemote(socket, ["--remote-tab", filePath]);
  if (line) await nvimRemote(socket, ["--remote-send", `<Esc>:${line}<CR>`]);
}

// Backslash-escapes characters vim's cmdline treats specially, so a path with
// spaces or one of these symbols is one filename argument to ":tabe".
function escapeForVimCmdline(p: string): string {
  return p.replace(/([ \\%#|"!<])/g, "\\$1");
}

// Quoting for a command typed into the window's shell: POSIX single quotes, or
// PowerShell's (which escape by doubling) on Windows.
function shellQuote(p: string): string {
  if (process.platform === "win32") return `'${p.replace(/'/g, "''")}'`;
  return `'${p.replace(/'/g, `'\\''`)}'`;
}

// ":tabe [+cmd] file" — the Ex-command "+cmd" argument does jump the cursor.
// Vim on Windows takes forward slashes, which spares escaping every backslash.
function vimTabeCmd(filePath: string, line?: number): string {
  const cmd = line ? `+${line} ` : "";
  const file = process.platform === "win32" ? filePath.replace(/\\/g, "/") : filePath;
  return `:tabe ${cmd}${escapeForVimCmdline(file)}`;
}

const EDITOR_COMMANDS = new Set(["nvim", "vim"]);
const SHELL_COMMANDS = new Set(["bash", "zsh", "fish", "sh", "dash", "ksh", "tcsh", "csh", "pwsh", "powershell"]);

// RPC-only nvim open: true if `pid`'s nvim has a reachable socket and the
// file was opened as a new tab through it. Never falls back to keystrokes.
async function tryNvimRpcOpen(pid: number, filePath: string, line?: number): Promise<boolean> {
  const socket = await findNvimSocket(pid);
  if (!socket) return false;
  await nvimRemoteOpen(socket, filePath, line);
  return true;
}

// Escape, ":tabe file", Enter — typed into a window running vim or nvim.
async function typeTabe(windowId: string, filePath: string, line?: number): Promise<void> {
  await mux().sendText(`@${windowId}`, "\x1b");
  await mux().sendText(`@${windowId}`, vimTabeCmd(filePath, line));
  await mux().sendText(`@${windowId}`, "\r");
}

// Opens filePath as a new tab in the editor running in `window` (RPC for nvim
// when reachable, else keystrokes). Only for the window the user is looking at.
async function openInEditorWindow(window: MuxWindow, filePath: string, line?: number): Promise<void> {
  if (window.command === "nvim" && (await tryNvimRpcOpen(window.pid, filePath, line))) return;
  await typeTabe(window.id, filePath, line);
}

export interface OpenFileResult {
  windowIndex: number | null;
  // Set only when a running nvim was found in another window but its RPC
  // socket couldn't be reached: that window's id, for the client to complete
  // via openFileInPaneWithKeys once the window is visible — keystrokes typed
  // into a window nobody can see would fail invisibly.
  deferredPane?: string;
}

// Opens filePath, preferring (in order): the current window if it's already
// running nvim/vim; nvim running in another window of the session; an idle
// shell in the current window; or a new window running nvim.
export async function openFileInWindow(target: string, filePath: string, line?: number): Promise<OpenFileResult> {
  const { session, window } = await resolveTarget(target);
  const command = window.command.replace(/^-/, "");
  const nvimCliArg = line ? `+${line} ${shellQuote(filePath)}` : shellQuote(filePath);

  if (EDITOR_COMMANDS.has(command)) {
    await openInEditorWindow(window, filePath, line);
    return { windowIndex: null };
  }

  // Reusing an nvim the user already has open lands the file next to what
  // they're editing. nvim-only: the fast path goes through its RPC socket.
  const otherNvim = (await listSessionPanes(session))
    .filter((p) => p.windowIndex !== window.index && p.command.replace(/^-/, "") === "nvim")
    .sort((a, b) => a.windowIndex - b.windowIndex)[0];

  if (otherNvim) {
    if (await tryNvimRpcOpen(otherNvim.pid, filePath, line)) {
      return { windowIndex: otherNvim.windowIndex };
    }
    return { windowIndex: otherNvim.windowIndex, deferredPane: otherNvim.id };
  }

  if (SHELL_COMMANDS.has(command)) {
    // Ctrl-U clears anything half-typed at the prompt first.
    await mux().sendText(`@${window.id}`, "\x15");
    await mux().sendText(`@${window.id}`, `nvim ${nvimCliArg}`);
    await mux().sendText(`@${window.id}`, "\r");
    return { windowIndex: null };
  }

  // In the background, so a tab pinned to this session's current window isn't
  // moved; the client opens a tab for the new window from the returned index.
  const created = await mux().createWindow(session, {
    cwd: window.cwd,
    command: `nvim ${nvimCliArg}`,
    background: true,
  });
  return { windowIndex: created.index };
}

// Completes a deferred open (see OpenFileResult.deferredPane) once its window
// is visible. Re-checks the window is still running an editor — it may have
// changed since the scan — and does nothing otherwise rather than typing into
// whatever runs there now.
export async function openFileInPaneWithKeys(windowId: string, filePath: string, line?: number): Promise<void> {
  const found = await findWindow(windowId);
  if (!found || !EDITOR_COMMANDS.has(found.window.command.replace(/^-/, ""))) return;
  await typeTabe(windowId, filePath, line);
}

// ---- Diff / merge in nvim ----
// The `editor` setting's nvim provider handles diffs and conflicts too. Both
// are `nvim -d` in a fresh window; a diff side is usually *not* a file on disk
// (index or HEAD content), so it's materialized first.

// Each side goes to its own file under a fresh temp directory, named after the
// real file so filetype detection (and syntax highlighting) still works. Never
// cleaned up: there is no signal for a window the user closes whenever they
// like, and the OS reaps its temp directory on its own schedule.
async function materializeEditorTemp(files: { name: string; content: string }[]): Promise<string[]> {
  const dir = path.join(tmpdir(), `perch-editor-${randomUUID()}`);
  await mkdir(dir, { recursive: true });
  return Promise.all(
    files.map(async (file) => {
      const target = path.join(dir, file.name);
      await writeFile(target, file.content, "utf8");
      return target;
    }),
  );
}

// A filesystem-safe name that keeps `reference`'s extension; the label
// ("HEAD", "Index") becomes the stem, which nvim shows in its status line.
function tempSideName(label: string, reference: string): string {
  const base = path.basename(reference);
  const dot = base.lastIndexOf(".");
  const ext = dot > 0 ? base.slice(dot) : "";
  const stem = label.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "side";
  return `${stem}${ext}`;
}

export interface EditorSide {
  content: string;
  label: string;
  path?: string;
}

async function spawnEditorWindow(session: string, cwd: string, command: string): Promise<{ windowIndex: number | null }> {
  const created = await mux().createWindow(session, { cwd, command, background: true });
  return { windowIndex: created.index };
}

// `nvim -d left right` in a new window: the original side is always
// read-only; the right side is the real working file when there is one, else
// read-only temp content too (a staged diff).
export async function openDiffInWindow(
  target: string,
  req: { original: EditorSide; modified: EditorSide },
): Promise<{ windowIndex: number | null }> {
  const { session, window } = await resolveTarget(target);
  const reference = req.modified.path ?? req.modified.label;
  const sides: { name: string; content: string }[] = [
    { name: tempSideName(req.original.label, reference), content: req.original.content },
  ];
  if (!req.modified.path) {
    sides.push({ name: tempSideName(req.modified.label, reference), content: req.modified.content });
  }
  const temps = await materializeEditorTemp(sides);
  const originalPath = temps[0];
  const modifiedPath = req.modified.path ?? temps[1];
  const lockRight = req.modified.path ? "" : " | 2wincmd w | setlocal readonly nomodifiable";
  const nvimCmd = `nvim -d -c ${shellQuote(
    `1wincmd w | setlocal readonly nomodifiable${lockRight} | 2wincmd w`,
  )} ${shellQuote(originalPath)} ${shellQuote(modifiedPath)}`;
  return spawnEditorWindow(session, window.cwd, nvimCmd);
}

// git mergetool's nvimdiff layout on a conflicted working file:
// LOCAL | MERGED | REMOTE, outer windows read-only, cursor in MERGED.
export async function openMergeInWindow(
  target: string,
  req: { path: string; ours: EditorSide; theirs: EditorSide; base?: EditorSide },
): Promise<{ windowIndex: number | null }> {
  const { session, window } = await resolveTarget(target);
  const sides = [
    { name: tempSideName(req.ours.label, req.path), content: req.ours.content },
    { name: tempSideName(req.theirs.label, req.path), content: req.theirs.content },
  ];
  // The base isn't in the layout, but written out it's one :diffthis away.
  if (req.base) sides.push({ name: tempSideName(req.base.label, req.path), content: req.base.content });
  const [oursPath, theirsPath] = await materializeEditorTemp(sides);
  const nvimCmd = `nvim -d -c ${shellQuote(
    "1wincmd w | setlocal readonly nomodifiable | 3wincmd w | setlocal readonly nomodifiable | 2wincmd w",
  )} ${shellQuote(oursPath)} ${shellQuote(req.path)} ${shellQuote(theirsPath)}`;
  return spawnEditorWindow(session, window.cwd, nvimCmd);
}

// ---- Horizontal scroll in nvim ----

const HSCROLL_MAX_TICKS = 50;
const HSCROLL_SOCKET_CACHE_TTL_MS = 2000;

const hscrollSocketCache = new Map<string, { socket: string; expires: number }>();
const hscrollState = new Map<string, { amount: number; inFlight: boolean }>();

async function resolveNvimSocketCached(windowId: string, shellPid: number): Promise<string | null> {
  const cached = hscrollSocketCache.get(windowId);
  if (cached && cached.expires > Date.now()) return cached.socket;
  const socket = await findNvimSocket(shellPid);
  if (!socket) {
    hscrollSocketCache.delete(windowId);
    return null;
  }
  hscrollSocketCache.set(windowId, { socket, expires: Date.now() + HSCROLL_SOCKET_CACHE_TTL_MS });
  return socket;
}

// Delivers <ScrollWheelLeft>/<ScrollWheelRight> to the nvim running in the
// viewed window over its RPC socket — a terminal has no horizontal wheel
// event to carry. No-op for anything that isn't nvim, or when its socket
// can't be found.
export async function scrollHorizontal(target: { session: string } | { windowId: string }, amount: number): Promise<void> {
  const clamped = Math.max(-HSCROLL_MAX_TICKS, Math.min(HSCROLL_MAX_TICKS, Math.trunc(amount)));
  if (clamped === 0) return;
  const window = "windowId" in target ? (await findWindow(target.windowId))?.window : (await resolveTarget(target.session)).window;
  if (!window || window.command.replace(/^-/, "") !== "nvim") return;

  let state = hscrollState.get(window.id);
  if (!state) {
    state = { amount: 0, inFlight: false };
    hscrollState.set(window.id, state);
  }
  // Wheel ticks arrive faster than a remote-send round trip; fold them into the
  // run already in flight instead of spawning an nvim process per tick.
  state.amount += clamped;
  if (state.inFlight) return;

  state.inFlight = true;
  try {
    while (state.amount !== 0) {
      const n = state.amount;
      state.amount = 0;
      const socket = await resolveNvimSocketCached(window.id, window.pid);
      if (!socket) break;
      const keys = (n > 0 ? "<ScrollWheelRight>" : "<ScrollWheelLeft>").repeat(Math.abs(n));
      try {
        await nvimRemote(socket, ["--remote-send", keys]);
      } catch {
        // The cached socket may be stale (nvim restarted): resolve once more.
        hscrollSocketCache.delete(window.id);
        const retry = await resolveNvimSocketCached(window.id, window.pid);
        if (!retry) break;
        try {
          await nvimRemote(retry, ["--remote-send", keys]);
        } catch {
          break;
        }
      }
    }
  } finally {
    state.inFlight = false;
    hscrollState.delete(window.id);
  }
}
