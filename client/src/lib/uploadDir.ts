import { resolveGitRootDir } from "../hooks/useGitRootDir";

// Expands the pasteDropUploadDir setting for one upload: {cwd} is the pane's
// working directory, {gitroot} the git repo root containing it (the repo-less
// fallback to cwd itself comes from the /api/fs/git-root endpoint). Brace
// syntax matches the touch-keys extension's {esc}/{ctrl} send tokens. Empty
// keeps the original behavior, {cwd}/uploads. The git lookup only runs when
// the token is actually present — a literal path stays a single sync step.
export async function resolveUploadDir(setting: string, cwd: string): Promise<string> {
  if (!setting) return `${cwd}/uploads`;
  let dir = setting.replaceAll("{cwd}", cwd);
  if (dir.includes("{gitroot}")) {
    dir = dir.replaceAll("{gitroot}", await resolveGitRootDir(cwd));
  }
  return dir;
}
