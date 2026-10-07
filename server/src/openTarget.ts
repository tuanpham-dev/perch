// What "open this path" means, shared by the two ways in: `perch open`
// (POST /api/open-target, a local CLI) and the desktop app (GET
// /api/open-target/resolve, called by the page itself, which then opens the
// result in its own window - plans/desktop-app.md T5).
import { realpath } from "node:fs/promises";
import path from "node:path";
import { exists, expandHome, getGitRoot, isDirectory, shortenHome } from "./files.js";
import type { OpenTargetPayload } from "./openUrl.js";

export const MAX_OPEN_TARGET_PATH_LENGTH = 4096;

export type OpenTargetParams = { path: string; line?: number; action?: "editor" | "preview" };

/** Validates raw request fields. Returns the params or a message for a 400. */
export function parseOpenTargetParams(body: Record<string, unknown> | undefined): OpenTargetParams | { error: string } {
  const rawPath = body?.path;
  if (typeof rawPath !== "string" || !rawPath || rawPath.length > MAX_OPEN_TARGET_PATH_LENGTH) {
    return { error: "path is required" };
  }
  let line: number | undefined;
  if (body?.line !== undefined && body.line !== "") {
    const n = Number(body.line);
    if (!Number.isInteger(n) || n < 1) return { error: "line must be a positive integer" };
    line = n;
  }
  let action: "editor" | "preview" | undefined;
  if (body?.action !== undefined && body.action !== "") {
    if (body.action !== "editor" && body.action !== "preview") return { error: "action must be editor or preview" };
    action = body.action;
  }
  return { path: rawPath, line, action };
}

/**
 * The repository `dir` is in, as an ancestor of `dir` the way it was written.
 * git answers with symlinks resolved, so the ancestor whose real path is
 * git's answer is the one returned; git's own answer only when none is.
 */
async function repoRootAsWritten(dir: string): Promise<string | null> {
  const root = await getGitRoot(dir);
  if (!root) return null;
  const real = await realpath(root).catch(() => root);
  for (let at = dir; ; at = path.dirname(at)) {
    if ((await realpath(at).catch(() => null)) === real) return at;
    if (path.dirname(at) === at) return root;
  }
}

/**
 * The payload a client's open-target handler takes, or null when the path
 * doesn't exist. Like `perch open`, a trailing ":N" is a line number only
 * when the literal path doesn't exist, so a filename with a colon in it still
 * opens as-is; an explicit `line` wins over one parsed from the path.
 */
export async function resolveOpenTarget(params: OpenTargetParams): Promise<OpenTargetPayload | null> {
  let target = expandHome(params.path);
  let line = params.line;
  if (!(await exists(target))) {
    const m = /^(.+):(\d+)$/.exec(target);
    if (!m || !(await exists(m[1]!))) return null;
    target = m[1]!;
    line ??= Number(m[2]);
  }
  // Tidied (".", "..", a relative path) but not resolved through symlinks:
  // a project opened as ~/code/app, where ~/code is a symlink, must match
  // the same ~/code/app here, or opening one of its files would open the
  // project a second time under its real path.
  target = path.resolve(target);
  const dir = await isDirectory(target);
  const projectCwd = dir ? target : ((await repoRootAsWritten(path.dirname(target))) ?? path.dirname(target));
  return {
    kind: dir ? "dir" : "file",
    path: shortenHome(target),
    projectCwd: shortenHome(projectCwd),
    ...(line !== undefined && !dir ? { line } : {}),
    ...(params.action ? { action: params.action } : {}),
  };
}
