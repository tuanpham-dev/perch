import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPathResolver, FOUND_TTL_MS, MISSING_TTL_MS } from "./pathResolver";

vi.mock("./api", () => ({ resolvePaths: vi.fn() }));

const existing = new Set(["a.md"]);
function makeFetcher() {
  return vi.fn(async (_session: string, paths: string[]) => ({
    results: paths.map((p) => (existing.has(p) ? `/repo/${p}` : null)),
  }));
}

describe("createPathResolver", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("reuses a result within its TTL", async () => {
    const fetcher = makeFetcher();
    const resolve = createPathResolver(() => "s", fetcher);
    expect(await resolve(["a.md"])).toEqual(["/repo/a.md"]);
    expect(await resolve(["a.md"])).toEqual(["/repo/a.md"]);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("re-checks a miss after the missing TTL", async () => {
    const fetcher = makeFetcher();
    const resolve = createPathResolver(() => "s", fetcher);
    await resolve(["b.md"]);
    vi.advanceTimersByTime(MISSING_TTL_MS - 1);
    await resolve(["b.md"]);
    expect(fetcher).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1);
    await resolve(["b.md"]);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("re-checks a found file after the found TTL", async () => {
    const fetcher = makeFetcher();
    const resolve = createPathResolver(() => "s", fetcher);
    await resolve(["a.md"]);
    vi.advanceTimersByTime(FOUND_TTL_MS);
    await resolve(["a.md"]);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("fetches only misses, keeping order and cells", async () => {
    const fetcher = makeFetcher();
    const resolve = createPathResolver(() => "s", fetcher);
    await resolve(["a.md"], [{ row: 1, col: 2 }]);
    expect(await resolve(["x.md", "a.md", "b.md"], [null, { row: 1, col: 2 }, { row: 3, col: 4 }])).toEqual([
      null,
      "/repo/a.md",
      null,
    ]);
    expect(fetcher).toHaveBeenLastCalledWith("s", ["x.md", "b.md"], [null, { row: 3, col: 4 }]);
  });

  it("keys by cell and session", async () => {
    const fetcher = makeFetcher();
    let session = "s";
    const resolve = createPathResolver(() => session, fetcher);
    await resolve(["a.md"], [{ row: 0, col: 0 }]);
    await resolve(["a.md"], [{ row: 0, col: 50 }]);
    session = "t";
    await resolve(["a.md"], [{ row: 0, col: 0 }]);
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it("doesn't cache a failed request", async () => {
    const fetcher = makeFetcher();
    fetcher.mockRejectedValueOnce(new Error("offline"));
    const resolve = createPathResolver(() => "s", fetcher);
    await expect(resolve(["a.md"])).rejects.toThrow("offline");
    expect(await resolve(["a.md"])).toEqual(["/repo/a.md"]);
  });
});
