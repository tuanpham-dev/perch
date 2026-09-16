// Cached front for api.resolvePaths, shared by every terminal-link path
// (hover links, touch Open, right-click). Hovering across rows re-asks for
// the same paths constantly; a found file is reused for FOUND_TTL_MS, and a
// miss only for MISSING_TTL_MS so a file created moments later still links
// quickly (the xterm engine's hover re-check timer is tuned just past it).
// The key includes the screen cell because the same path text can resolve
// differently per pane; a scrollback candidate (no cell) resolves against
// the active pane. Request failures aren't cached.
import * as api from "./api";

export const FOUND_TTL_MS = 10_000;
export const MISSING_TTL_MS = 2_000;
const MAX_ENTRIES = 500;

type Cell = { row: number; col: number } | null;
type Fetcher = typeof api.resolvePaths;

export function createPathResolver(getSession: () => string, fetcher: Fetcher = api.resolvePaths) {
  const cache = new Map<string, { value: string | null; expires: number }>();

  const prune = (now: number) => {
    if (cache.size <= MAX_ENTRIES) return;
    for (const [key, entry] of cache) if (entry.expires <= now) cache.delete(key);
  };

  return async (paths: string[], cells?: Cell[]): Promise<(string | null)[]> => {
    const session = getSession();
    const now = Date.now();
    const keyFor = (i: number) => {
      const cell = cells?.[i];
      return `${session}|${cell ? `${cell.row},${cell.col}` : "active"}|${paths[i]}`;
    };
    const results: (string | null)[] = new Array(paths.length).fill(null);
    const missIdx: number[] = [];
    paths.forEach((_, i) => {
      const hit = cache.get(keyFor(i));
      if (hit && hit.expires > now) results[i] = hit.value;
      else missIdx.push(i);
    });
    if (!missIdx.length) return results;

    const missCells = cells ? missIdx.map((i) => cells[i] ?? null) : undefined;
    const { results: fetched } = await fetcher(session, missIdx.map((i) => paths[i]), missCells);
    const stamp = Date.now();
    missIdx.forEach((i, j) => {
      const value = fetched[j] ?? null;
      results[i] = value;
      cache.set(keyFor(i), { value, expires: stamp + (value ? FOUND_TTL_MS : MISSING_TTL_MS) });
    });
    prune(stamp);
    return results;
  };
}
