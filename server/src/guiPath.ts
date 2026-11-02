// A desktop app started from Finder/Dock gets launchd's PATH
// (/usr/bin:/bin:/usr/sbin:/sbin), not the one the user's shell builds in its
// rc files. Anything the server spawns by bare name - an extension running
// `claude -p /usage`, an editor - then fails with ENOENT for a CLI installed in
// ~/.local/bin or Homebrew, while the same command works in a terminal.
import { homedir } from "node:os";
import path from "node:path";

// Where CLIs are commonly installed that a GUI-launched PATH lacks.
export function extraBinDirs(home: string = homedir()): string[] {
  return [
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/snap/bin",
    "/nix/var/nix/profiles/default/bin",
    path.join(home, ".nix-profile", "bin"),
    path.join(home, ".local", "bin"),
    path.join(home, "bin"),
    path.join(home, ".local", "share", "mise", "shims"),
    path.join(home, ".asdf", "shims"),
  ];
}

// Appends the missing ones after the existing PATH, so anything the user's
// environment already put first still wins.
export function withExtraBinDirs(current: string | undefined, home: string = homedir()): string {
  const have = (current ?? "").split(path.delimiter).filter(Boolean);
  const add = extraBinDirs(home).filter((d) => !have.includes(d));
  return [...have, ...add].join(path.delimiter);
}

export function ensureGuiPath(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): void {
  if (platform === "win32") return;
  env.PATH = withExtraBinDirs(env.PATH);
}
