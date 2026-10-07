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
  try {
    target = await realpath(target);
  } catch {
    return null;
  }
  const dir = await isDirectory(target);
  const projectCwd = dir ? target : ((await getGitRoot(path.dirname(target))) ?? path.dirname(target));
  return {
    kind: dir ? "dir" : "file",
    path: shortenHome(target),
    projectCwd: shortenHome(projectCwd),
    ...(line !== undefined && !dir ? { line } : {}),
    ...(params.action ? { action: params.action } : {}),
  };
}
