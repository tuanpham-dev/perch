// One entry of the "Carry into new worktrees" setting, normalized the way the
// server's normalizeCarryOverPaths (server/src/gitWorktrees.ts) does it: a
// path relative to the repository root, without "./", a trailing "/", or
// anything that could reach outside the repository. Null means refused.
export function normalizeCarryOverPath(raw: string): string | null {
  let p = raw.trim().replace(/\\/g, "/");
  while (p.startsWith("./")) p = p.slice(2);
  p = p.replace(/\/+$/, "");
  if (!p || p.startsWith("/") || /^[A-Za-z]:/.test(p)) return null;
  if (p.split("/").includes("..")) return null;
  return p;
}
