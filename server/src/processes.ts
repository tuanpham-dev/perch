// The host's process tree, for questions the terminal engine can't answer on
// its own: which window owns a listening port (ports.ts), and where a running
// nvim is listening (editor.ts).
import { execFile } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import { parseProcessCsv } from "perch-mux/windows";

export interface ProcInfo {
  ppid: number;
  comm: string;
}

function run(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve) => {
    execFile(cmd, args, { encoding: "utf8", maxBuffer: 32 * 1024 * 1024, windowsHide: true }, (err, stdout) =>
      resolve(err ? "" : stdout),
    );
  });
}

/** `ps -axo pid=,ppid=,comm=` output (macOS), as a process map. */
export function parsePsOutput(stdout: string): Map<number, ProcInfo> {
  const map = new Map<number, ProcInfo>();
  for (const line of stdout.split("\n")) {
    const m = /^\s*(\d+)\s+(\d+)\s+(.+)$/.exec(line);
    if (m) map.set(Number(m[1]), { ppid: Number(m[2]), comm: m[3]!.trim().split("/").pop()!.replace(/^-/, "") });
  }
  return map;
}

// A ppid+comm map of every process on the host: /proc on Linux, ps on macOS,
// the CIM process list on Windows. Callers treat an empty map as "unknown"
// (and fall back to the keystroke-injection path, for the editor).
export async function buildProcessMap(): Promise<Map<number, ProcInfo>> {
  if (process.platform === "darwin") return parsePsOutput(await run("ps", ["-axo", "pid=,ppid=,comm="]));
  if (process.platform === "win32") {
    const csv = await run("powershell.exe", [
      "-NoProfile", "-NonInteractive", "-Command",
      "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name | ConvertTo-Csv -NoTypeInformation",
    ]);
    return new Map(parseProcessCsv(csv).map((e) => [e.pid, { ppid: e.ppid, comm: e.name }]));
  }
  const map = new Map<number, ProcInfo>();
  let entries: string[];
  try {
    entries = await readdir("/proc");
  } catch {
    return map;
  }
  await Promise.all(
    entries
      .filter((name) => /^\d+$/.test(name))
      .map(async (name) => {
        try {
          const raw = await readFile(`/proc/${name}/stat`, "utf8");
          // Format: "pid (comm) state ppid ...". comm is parenthesized and
          // may itself contain spaces/parens, so match up to the last ")".
          const m = raw.match(/^\d+\s+\((.*)\)\s+\S+\s+(\d+)/);
          if (!m) return;
          map.set(Number(name), { comm: m[1], ppid: Number(m[2]) });
        } catch {
          // Process exited between readdir and read; ignore.
        }
      }),
  );
  return map;
}

// BFS down the process tree from rootPid (inclusive), collecting every
// process matching predicate in shallowest-first order. Nvim can run as a
// pair of same-named processes (a TUI host plus a nested core that actually
// owns the RPC socket), so the caller needs every match, not just the first.
export function findDescendants(
  rootPid: number,
  map: Map<number, ProcInfo>,
  predicate: (comm: string) => boolean,
): number[] {
  const childrenOf = new Map<number, number[]>();
  for (const [pid, info] of map) {
    const siblings = childrenOf.get(info.ppid) ?? [];
    siblings.push(pid);
    childrenOf.set(info.ppid, siblings);
  }
  const queue = [rootPid];
  const seen = new Set<number>();
  const matches: number[] = [];
  while (queue.length > 0) {
    const pid = queue.shift()!;
    if (seen.has(pid)) continue;
    seen.add(pid);
    const info = map.get(pid);
    if (info && predicate(info.comm)) matches.push(pid);
    queue.push(...(childrenOf.get(pid) ?? []));
  }
  return matches;
}
