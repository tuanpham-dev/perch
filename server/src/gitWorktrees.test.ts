import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The setting as the synced settings document holds it; the create call that
// passes no carryOver of its own reads this.
vi.mock("./settingsStore.js", () => ({
  readSettingsDoc: async () => ({ settings: { worktreeCarryOver: [".env"] } }),
}));

const { carryOverIgnored, createWorktree, normalizeCarryOverPaths } = await import("./gitWorktrees.js");

const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" });
const write = (file: string, body = "x") => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body);
};
const isLink = (p: string) => {
  try {
    return fs.lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
};

describe("normalizing the carry-over list", () => {
  it("trims, strips ./ and trailing slashes, dedupes, and refuses paths leaving the repo", () => {
    expect(
      normalizeCarryOverPaths(["  .env ", "./node_modules/", ".env", "/etc/hosts", "../x", "a/../b", "", 3, "a\\b"]),
    ).toEqual([".env", "node_modules", "a/b"]);
    expect(normalizeCarryOverPaths("node_modules")).toEqual([]);
  });
});

describe("carrying ignored paths into a new worktree", () => {
  let repo: string;
  beforeEach(() => {
    repo = fs.realpathSync(fs.mkdtempSync(path.join(tmpdir(), "perch-wt-")));
    git(repo, "init", "-q", "-b", "main");
    git(repo, "config", "user.email", "t@example.com");
    git(repo, "config", "user.name", "t");
    write(path.join(repo, "README.md"), "readme");
    write(path.join(repo, "client/keep.txt"));
    write(path.join(repo, ".gitignore"), ".env\nnode_modules/\nbuild/\nclient/node_modules/\n");
    git(repo, "add", "-A");
    git(repo, "commit", "-qm", "init");
    write(path.join(repo, ".env"), "SECRET=1");
    write(path.join(repo, "node_modules/x.js"));
    write(path.join(repo, "build/cache/a"));
    write(path.join(repo, "build/other"));
    write(path.join(repo, "client/node_modules/y.js"));
    fs.appendFileSync(path.join(repo, ".git/info/exclude"), "/.backups/\n");
    write(path.join(repo, ".backups/b.txt"));
  });
  afterEach(() => {
    fs.chmodSync(repo, 0o755);
    fs.rmSync(repo, { recursive: true, force: true });
  });

  it("links what the main worktree ignores and leaves the rest alone", async () => {
    const { path: wt } = await createWorktree({
      cwd: repo,
      branch: "feat",
      mode: "new",
      carryOver: [".env", "node_modules", ".backups", "client/node_modules", "build/cache", "README.md", "missing"],
    });
    for (const p of [".env", "node_modules", ".backups", "client/node_modules", "build/cache"]) {
      expect(isLink(path.join(wt, p)), p).toBe(true);
      expect(fs.readlinkSync(path.join(wt, p))).toBe(path.join(repo, p));
    }
    expect(fs.readFileSync(path.join(wt, "client/node_modules/y.js"), "utf8")).toBe("x");
    expect(isLink(path.join(wt, "README.md"))).toBe(false);
    expect(fs.readFileSync(path.join(wt, "README.md"), "utf8")).toBe("readme");
    expect(fs.existsSync(path.join(wt, "missing"))).toBe(false);
    expect(fs.existsSync(path.join(wt, "build/other"))).toBe(false);
    expect(git(wt, "status", "--porcelain")).toBe("");
  });

  it("reads the list from the settings when the caller passes none", async () => {
    const { path: wt } = await createWorktree({ cwd: repo, branch: "from-settings", mode: "new" });
    expect(isLink(path.join(wt, ".env"))).toBe(true);
    expect(fs.existsSync(path.join(wt, "node_modules"))).toBe(false);
  });

  it("never replaces something already in the worktree", async () => {
    const { path: wt } = await createWorktree({ cwd: repo, branch: "keep", mode: "new", carryOver: [] });
    write(path.join(wt, ".env"), "LOCAL=1");
    await carryOverIgnored(repo, wt, [".env"]);
    expect(isLink(path.join(wt, ".env"))).toBe(false);
    expect(fs.readFileSync(path.join(wt, ".env"), "utf8")).toBe("LOCAL=1");
  });

  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "still returns when a link can't be made",
    async () => {
      const { path: wt } = await createWorktree({ cwd: repo, branch: "ro", mode: "new", carryOver: [] });
      const client = path.join(wt, "client");
      fs.chmodSync(client, 0o555);
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        await expect(carryOverIgnored(repo, wt, ["client/node_modules", ".env"])).resolves.toBeUndefined();
        expect(fs.existsSync(path.join(client, "node_modules"))).toBe(false);
        expect(isLink(path.join(wt, ".env"))).toBe(true);
        expect(warn).toHaveBeenCalled();
      } finally {
        warn.mockRestore();
        fs.chmodSync(client, 0o755);
      }
    },
  );
});
