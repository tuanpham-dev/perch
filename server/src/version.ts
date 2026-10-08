// What Perch this server is (plans/app-versioning.md): the version from the
// root package.json, the one source of truth every manifest follows, and the
// commit it was built from.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "../..");

// The oldest desktop app this server works with. Raise it when the server
// drops something an older app relies on; the app warns when it's below.
export const MIN_DESKTOP_VERSION = "0.1.0";

let cached: { version: string; commit: string } | null = null;

function read(): { version: string; commit: string } {
  if (cached) return cached;
  let version = "0.0.0";
  try {
    version = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8")).version ?? version;
  } catch {
    // A broken checkout still serves; it just can't say what it is.
  }
  let commit = "";
  try {
    // The desktop app's bundled server is a staged copy with no .git: the
    // staging script records the commit beside it.
    commit = JSON.parse(readFileSync(path.join(ROOT, "server-bundle.json"), "utf8")).commit ?? "";
  } catch {
    try {
      commit = execFileSync("git", ["-C", ROOT, "rev-parse", "--short", "HEAD"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    } catch {
      // Not a git checkout.
    }
  }
  cached = { version, commit };
  return cached;
}

export const appVersion = () => read().version;
export const appCommit = () => read().commit;

/** What GET /version.json answers: public, and only this. */
export function versionInfo() {
  return { version: appVersion(), commit: appCommit(), minDesktopVersion: MIN_DESKTOP_VERSION };
}
