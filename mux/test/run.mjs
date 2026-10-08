// Runs the suite: `node --test` over every test/*.test.ts, one file at a
// time (they share ports, pids and timing budgets).
//
// On Windows the daemon end-to-end files are left out: they reach the
// daemon over its Unix socket (`<state>/daemon.sock`, where Windows listens
// on a named pipe) and find and kill it through /proc. Windows has its own
// daemon coverage in platform-windows.test.ts; the rest of the suite (bell
// detection, config, frames, scrollback, process labels) runs everywhere.
import { execFileSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const dir = dirname(fileURLToPath(import.meta.url));

const POSIX_ONLY = new Set([
  "active-viewer-size.test.ts",
  "auto-name.test.ts",
  "e2e-reboot.test.ts",
  "events.test.ts",
  "listing-enrichment.test.ts",
  "passthrough.test.ts",
  "query-answer.test.ts",
  "raw-scrollback.test.ts",
  "spawn-env.test.ts",
  "window-attach.test.ts",
  "window-info.test.ts",
]);

const all = readdirSync(dir).filter((f) => f.endsWith(".test.ts")).sort();
const skipped = process.platform === "win32" ? all.filter((f) => POSIX_ONLY.has(f)) : [];
const files = all.filter((f) => !skipped.includes(f));
if (skipped.length > 0) {
  console.log(`skipping ${skipped.length} daemon end-to-end files on Windows (Unix socket + /proc): ${skipped.join(", ")}`);
}

try {
  execFileSync(process.execPath, ["--test", "--test-concurrency=1", ...files.map((f) => join(dir, f))], {
    stdio: "inherit",
  });
} catch (err) {
  process.exit(typeof err.status === "number" ? err.status : 1);
}
