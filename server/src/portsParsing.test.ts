import { describe, expect, it } from "vitest";
import { parseLsofListeners, parseNetTcpCsv } from "./ports.js";
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
