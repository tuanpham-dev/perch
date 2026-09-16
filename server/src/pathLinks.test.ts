import { describe, expect, it } from "vitest";
import { groupWrappedRows, paneAtCell, resolveLinkPath, type ResolveDeps } from "./pathLinks.js";

function deps(files: string[], roots: Record<string, string | null>): ResolveDeps {
  const set = new Set(files);
  return {
    isFile: async (p) => set.has(p),
    gitRoot: async (dir) => roots[dir] ?? null,
  };
}

describe("resolveLinkPath", () => {
  const cwd = "/repo/client/src";
  const roots = { [cwd]: "/repo" };

  it("prefers the pane cwd over the repo root", async () => {
    const d = deps(["/repo/client/src/README.md", "/repo/README.md"], roots);
    expect(await resolveLinkPath("README.md", cwd, d)).toBe("/repo/client/src/README.md");
  });

  it("falls back to the repo root", async () => {
    const d = deps(["/repo/plans/abc.md"], roots);
    expect(await resolveLinkPath("plans/abc.md", cwd, d)).toBe("/repo/plans/abc.md");
  });

  it("returns null outside a repo when the cwd misses", async () => {
    const d = deps(["/repo/plans/abc.md"], {});
    expect(await resolveLinkPath("plans/abc.md", "/tmp", d)).toBeNull();
  });

  it("strips a diff prefix under the cwd and the root", async () => {
    expect(await resolveLinkPath("a/x.ts", cwd, deps(["/repo/client/src/x.ts"], roots))).toBe("/repo/client/src/x.ts");
    expect(await resolveLinkPath("b/server/api.ts", cwd, deps(["/repo/server/api.ts"], roots))).toBe("/repo/server/api.ts");
  });

  it("keeps a literal a/ directory ahead of stripping", async () => {
    const d = deps(["/repo/a/x.ts", "/repo/x.ts"], { "/repo": "/repo" });
    expect(await resolveLinkPath("a/x.ts", "/repo", d)).toBe("/repo/a/x.ts");
  });

  it("checks absolute paths as-is", async () => {
    const d = deps(["/etc/hosts"], roots);
    expect(await resolveLinkPath("/etc/hosts", cwd, d)).toBe("/etc/hosts");
    expect(await resolveLinkPath("/etc/nope", cwd, d)).toBeNull();
  });
});

describe("paneAtCell", () => {
  const panes = [
    { id: "L", left: 0, top: 0, right: 39, bottom: 19 },
    { id: "R", left: 41, top: 0, right: 79, bottom: 19 },
  ];

  it("includes edges", () => {
    expect(paneAtCell(panes, { row: 19, col: 39 })?.id).toBe("L");
    expect(paneAtCell(panes, { row: 0, col: 41 })?.id).toBe("R");
  });

  it("misses the border column", () => {
    expect(paneAtCell(panes, { row: 5, col: 40 })).toBeUndefined();
  });
});

describe("groupWrappedRows", () => {
  // Fixture from the tmux spike: a 40-column pane.
  const pad = (s: string) => s.padEnd(40, " ");
  const plain = [
    "pre pre pre pre pre pre pre pre pre pre ",
    "pre pre pre pre pre pre pre pre pre pre ",
    pad("pre pre pre pre pre pre pre pre pre pre"),
    pad("short"),
    "yyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyy plans/t",
    pad("erminal-relative-path-links.spec.html"),
    "日本語日本語日本語日本語日本語日本語日本語",
    pad("日本語 plans/x.md"),
    pad("tail"),
    pad(""),
  ];
  const joined = [
    "pre ".repeat(30).trimEnd(),
    "short",
    "yyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyy plans/terminal-relative-path-links.spec.html",
    "日本語日本語日本語日本語日本語日本語日本語日本語 plans/x.md",
    "tail",
    "",
  ];

  it("maps each logical line to its rows", () => {
    expect(groupWrappedRows(plain, joined).map((g) => [g.firstRow, g.lastRow])).toEqual([
      [0, 2],
      [3, 3],
      [4, 5],
      [6, 7],
      [8, 8],
      [9, 9],
    ]);
  });

  it("returns the joined text", () => {
    expect(groupWrappedRows(plain, joined)[2].text).toContain("plans/terminal-relative-path-links.spec.html");
  });
});
