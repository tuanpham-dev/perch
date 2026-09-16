// Paths travel to the browser with forward slashes. The client splits and
// joins paths on "/" throughout, and Windows accepts "C:/Users/me/x" in every
// API the server calls, so converting once at the boundary keeps a Windows
// server working without teaching every client component about backslashes.
// Elsewhere this is a no-op.
import type { NextFunction, Request, Response } from "express";

// A drive path ("C:\...") or a home-shortened one ("~\...").
const WINDOWS_PATH = /^(?:[A-Za-z]:\\|~\\)/;

export function toClientPath(value: string, platform: NodeJS.Platform = process.platform): string {
  return platform === "win32" && WINDOWS_PATH.test(value) ? value.replace(/\\/g, "/") : value;
}

/** Every string in a JSON-shaped value, converted. Other values are returned as they are. */
export function toClientPaths<T>(value: T, platform: NodeJS.Platform = process.platform): T {
  if (platform !== "win32") return value;
  const walk = (v: unknown): unknown => {
    if (typeof v === "string") return toClientPath(v, platform);
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === "object" && Object.getPrototypeOf(v) === Object.prototype) {
      return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]));
    }
    return v;
  };
  return walk(value) as T;
}

/** Converts every res.json() body on Windows. */
export function clientPathsMiddleware(_req: Request, res: Response, next: NextFunction): void {
  if (process.platform === "win32") {
    const json = res.json.bind(res);
    res.json = (body?: unknown) => json(toClientPaths(body));
  }
  next();
}
