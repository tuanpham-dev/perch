import { describe, expect, it } from "vitest";
import { parseLsofListeners, parseNetTcpCsv, processLabel } from "./ports.js";
import { parsePsOutput } from "./processes.js";

describe("naming a process from its command line", () => {
  it("leaves a program that is already named after itself alone", () => {
    expect(processLabel(["/usr/local/bin/cloudflared", "tunnel", "run"], "/home/me")).toBe("cloudflared");
  });

  it("names a dependency CLI after its bin entry, not the runtime", () => {
    // ss and lsof both report "node-MainThread" for this, Node having
    // renamed its own main thread.
    expect(processLabel(["node", "/works/app/node_modules/.bin/vite"], "/works/app/client")).toBe("vite");
  });

  it("skips flags that take their value as the next argument", () => {
    const argv = [
      "/home/me/.nvm/versions/node/v26.3.1/bin/node",
      "--require", "/works/app/node_modules/tsx/dist/preflight.cjs",
      "--import", "file:///works/app/node_modules/tsx/dist/loader.mjs",
      "scripts/worker.ts",
    ];
    expect(processLabel(argv, "/works/app")).toBe("worker.ts");
  });

  it("falls back to the working directory when the script is named by position", () => {
    expect(processLabel(["node", "--enable-source-maps", "src/index.ts"], "/works/perch/server")).toBe(
      "perch/server",
    );
  });

  it("names a package's own entry file after the package", () => {
    const argv = ["node", "node_modules/.pnpm/@react-router+serve@7.18.2/node_modules/@react-router/serve/bin.js"];
    expect(processLabel(argv, "/works/shop")).toBe("@react-router/serve");
  });

  it("names a module run with -m after the module", () => {
    expect(processLabel(["python3", "-m", "http.server"], "/works/notes")).toBe("http.server");
  });

  it("has nothing to say about an empty command line", () => {
    expect(processLabel([], "/works/app")).toBeNull();
  });
});

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
