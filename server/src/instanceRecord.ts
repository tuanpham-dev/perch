// A small file saying "a perch is running here, on this port", written
// while the server runs. The CLI finds instances by reading process command
// lines and environments where the OS allows that; Windows doesn't, so there
// `perch instances`, `stop` and `open` read these records instead.
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

export const instanceRecordDir = path.join(tmpdir(), "perch-instances");

export interface InstanceRecord {
  pid: number;
  port: number;
  appName: string;
  repoDir: string;
  // Who started it: "service" (the OS service), "cli" (a background start),
  // or "" (anything else, e.g. npm run dev).
  launcher: string;
  startedAt: number;
}

export function writeInstanceRecord(port: number, repoDir: string): void {
  // Only Windows reads them, so only Windows writes them: a crash elsewhere
  // would leave a file nothing ever cleans up.
  if (process.platform !== "win32") return;
  const file = path.join(instanceRecordDir, `${process.pid}.json`);
  const record: InstanceRecord = {
    pid: process.pid,
    port,
    appName: process.env.APP_NAME ?? "",
    repoDir,
    launcher: process.env.PERCH_LAUNCHER ?? "",
    startedAt: Date.now(),
  };
  try {
    mkdirSync(instanceRecordDir, { recursive: true });
    writeFileSync(file, JSON.stringify(record));
  } catch {
    return; // Discovery by process listing still works where it's possible.
  }
  process.on("exit", () => rmSync(file, { force: true }));
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => {
      rmSync(file, { force: true });
      // A handler of our own replaces the default exit; keep that exit unless
      // something else now handles the signal.
      if (process.listenerCount(signal) === 0) process.exit(0);
    });
  }
}
