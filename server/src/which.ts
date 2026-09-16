// "Is this binary on PATH" — asked by ai.ts of each CLI provider and by
// agents.ts of each registry entry's program, so Settings can dim a row whose
// command is not installed rather than offering it as if it would work.
//
// Its own module rather than a function on ai.ts, which is where it started:
// agents.ts asking the AI provider module whether a binary exists coupled the
// registry to a module it has nothing else to do with.
//
// A PATH walk rather than spawning `which`: this is called once per candidate
// every time a settings panel opens, and a subprocess per name is a
// noticeable cost for a question the filesystem answers directly.
import { access, constants } from "node:fs/promises";
import path from "node:path";

export async function isOnPath(bin: string): Promise<boolean> {
  const dirs = (process.env.PATH ?? "").split(path.delimiter).filter(Boolean);
  const names = candidateNames(bin);
  for (const dir of dirs) {
    for (const name of names) {
      try {
        await access(path.join(dir, name), constants.X_OK);
        return true;
      } catch {
        // Not here (or not executable) — keep looking.
      }
    }
  }
  return false;
}

// On Windows a command is found by trying each PATHEXT extension ("claude"
// is claude.cmd, "node" is node.exe); a name that already has one is tried
// as it is too.
export function candidateNames(bin: string, platform: NodeJS.Platform = process.platform, pathext = process.env.PATHEXT): string[] {
  if (platform !== "win32") return [bin];
  const exts = (pathext || ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean);
  return [bin, ...exts.map((ext) => bin + ext.toLowerCase())];
}
