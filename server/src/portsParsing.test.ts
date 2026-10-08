import { describe, expect, it } from "vitest";
import { attributeToSession, parseLsofListeners, parseNetTcpCsv } from "./ports.js";
import { parsePsOutput } from "./processes.js";

describe("process and port listings on macOS and Windows", () => {
  it("reads ps output into a process map", () => {
    const map = parsePsOutput("    1     0 /sbin/launchd\n  812     1 /Applications/iTerm.app/Contents/MacOS/iTerm2\n  900   812 -zsh\n");
    expect(map.get(900)).toEqual({ ppid: 812, comm: "zsh" });
    expect(map.get(812)?.comm).toBe("iTerm2");
  });

  it("reads lsof's field output, one entry per listening address", () => {
    const out = "p4242\ncnode\nn127.0.0.1:5173\nn[::1]:5173\np77\ncpostgres\nn*:5432\n";
    expect(parseLsofListeners(out)).toEqual([
      { port: 5173, address: "127.0.0.1", process: "node", pid: 4242 },
      { port: 5173, address: "::1", process: "node", pid: 4242 },
      { port: 5432, address: "*", process: "postgres", pid: 77 },
    ]);
  });

  it("reads Get-NetTCPConnection CSV, naming processes from the map", () => {
    const csv = '"LocalAddress","LocalPort","OwningProcess"\r\n"0.0.0.0","3000","5120"\r\n"::","445","4"\r\n"127.0.0.1","notaport","1"';
    const names = new Map([[5120, { ppid: 1, comm: "node" }]]);
    expect(parseNetTcpCsv(csv, names)).toEqual([
      { port: 3000, address: "0.0.0.0", pid: 5120, process: "node" },
      { port: 445, address: "::", pid: 4, process: undefined },
    ]);
  });
});

describe("attributing a port to its terminal", () => {
  // 900 is a window's shell; 950 a dev server it started; 960 that server's worker.
  const procMap = new Map([
    [900, { ppid: 1, comm: "zsh" }],
    [950, { ppid: 900, comm: "node" }],
    [960, { ppid: 950, comm: "node" }],
    [970, { ppid: 1, comm: "orphan" }],
  ]);
  const panePids = new Map([[900, "app"]]);
  const paneWindows = new Map([[900, "win-1"]]);

  it("names the session and the window whose shell started the process", () => {
    expect(attributeToSession(960, procMap, panePids, new Set(), paneWindows)).toEqual({ session: "app", window: "win-1" });
  });

  it("still names the session when the window is not known", () => {
    expect(attributeToSession(950, procMap, panePids, new Set())).toEqual({ session: "app" });
  });

  it("reports perch's own processes and dead-ended chains as before", () => {
    expect(attributeToSession(950, procMap, panePids, new Set([950]), paneWindows)).toBe("own");
    expect(attributeToSession(970, procMap, panePids, new Set(), paneWindows)).toBe("unknown");
  });
});
