import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Project, RepoInfo, TerminalSession, WorktreeInfo } from "../types";
import {
  bumpRecent,
  isLinkedWorktreePath,
  projectName,
  projectTree,
  sessionNameForProject,
  withoutWorktreeRecents,
  worktreeContainer,
  worktreeForPath,
} from "./projects";

function makeSession(overrides: Partial<TerminalSession>): TerminalSession {
  return { id: "$1", name: "session", created: 0, attached: 0, path: "~/works/app", windows: [], ...overrides };
}

function makeProject(overrides: Partial<Project>): Project {
  return { cwd: "~/works/app", pinned: false, lastOpened: 0, ...overrides };
}

describe("projectName", () => {
  it("derives the folder basename", () => {
    expect(projectName("~/works/app")).toBe("app");
    expect(projectName("/opt/data/thing")).toBe("thing");
  });

  it("handles trailing slashes, bare home, and root", () => {
    expect(projectName("~/works/app/")).toBe("app");
    expect(projectName("~")).toBe("~");
    expect(projectName("/")).toBe("/");
  });
});

describe("sessionNameForProject", () => {
  it("uses the basename when free", () => {
    expect(sessionNameForProject("~/works/app", [])).toBe("app");
  });

  it("sanitizes characters session names forbid", () => {
    expect(sessionNameForProject("~/works/my.app:v2", [])).toBe("my-app-v2");
  });

  it("suffixes -2, -3… until unique", () => {
    expect(sessionNameForProject("~/other/app", ["app"])).toBe("app-2");
    expect(sessionNameForProject("~/third/app", ["app", "app-2"])).toBe("app-3");
  });
});

describe("bumpRecent", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("adds a new entry unpinned at MRU front", () => {
    const next = bumpRecent([makeProject({ cwd: "~/old", lastOpened: 10 })], "~/new");
    expect(next[0]).toEqual({ cwd: "~/new", pinned: false, lastOpened: 1_000_000 });
    expect(next).toHaveLength(2);
  });

  it("preserves the pinned flag when bumping an existing entry", () => {
    const next = bumpRecent([makeProject({ cwd: "~/a", pinned: true, lastOpened: 10 })], "~/a");
    expect(next).toEqual([{ cwd: "~/a", pinned: true, lastOpened: 1_000_000 }]);
  });

  it("evicts the oldest unpinned entries beyond the cap, never pinned ones", () => {
    const projects: Project[] = [
      makeProject({ cwd: "~/pinned-old", pinned: true, lastOpened: 1 }),
      ...Array.from({ length: 15 }, (_, i) => makeProject({ cwd: `~/p${i}`, lastOpened: 100 + i })),
    ];
    const next = bumpRecent(projects, "~/fresh");
    expect(next.some((p) => p.cwd === "~/pinned-old")).toBe(true);
    expect(next.some((p) => p.cwd === "~/p0")).toBe(false); // oldest unpinned evicted
    expect(next.filter((p) => !p.pinned)).toHaveLength(15);
  });
});


function makeWorktree(overrides: Partial<WorktreeInfo>): WorktreeInfo {
  return {
    path: "~/works/app",
    branch: "main",
    head: "abc1234def",
    detached: false,
    locked: false,
    prunable: false,
    main: false,
    dirty: false,
    ...overrides,
  };
}

// A repo whose linked worktrees nest inside it — the default location, and
// the case that makes prefix matching necessary.
function nestedRepo(): RepoInfo {
  return {
    repo: "~/works/app",
    branches: [],
    worktrees: [
      makeWorktree({ path: "~/works/app", branch: "main", main: true }),
      makeWorktree({ path: "~/works/app/.worktrees/feature", branch: "feature" }),
    ],
  };
}

function indexFor(paths: string[], repo: RepoInfo): Map<string, RepoInfo> {
  return new Map(paths.map((p) => [p, repo]));
}

describe("worktreeForPath", () => {
  it("takes the longest matching worktree, not the first", () => {
    const { worktrees } = nestedRepo();
    expect(worktreeForPath(worktrees, "~/works/app/.worktrees/feature")?.branch).toBe("feature");
    expect(worktreeForPath(worktrees, "~/works/app/.worktrees/feature/src")?.branch).toBe("feature");
    expect(worktreeForPath(worktrees, "~/works/app")?.branch).toBe("main");
    expect(worktreeForPath(worktrees, "~/works/app/src")?.branch).toBe("main");
  });

  it("matches on path segments, not string prefixes", () => {
    const { worktrees } = nestedRepo();
    expect(worktreeForPath(worktrees, "~/works/app-other")).toBeUndefined();
  });
});

describe("isLinkedWorktreePath", () => {
  it("is true at or under a linked worktree, false for the main checkout", () => {
    const repo = nestedRepo();
    const index = indexFor(["~/works/app"], repo);
    expect(isLinkedWorktreePath(index, "~/works/app/.worktrees/feature")).toBe(true);
    expect(isLinkedWorktreePath(index, "~/works/app/.worktrees/feature/src")).toBe(true);
    expect(isLinkedWorktreePath(index, "~/works/app")).toBe(false);
    expect(isLinkedWorktreePath(index, "~/works/app/src")).toBe(false);
  });

  it("is false for a folder no known repository contains", () => {
    expect(isLinkedWorktreePath(indexFor(["~/works/app"], nestedRepo()), "~/works/other")).toBe(false);
    expect(isLinkedWorktreePath(new Map(), "~/works/app/.worktrees/feature")).toBe(false);
  });

  it("lets the innermost repository own a path when repositories nest", () => {
    const outer: RepoInfo = {
      repo: "~/works",
      worktrees: [makeWorktree({ path: "~/works", branch: "main", main: true })],
      branches: [],
    };
    const inner = nestedRepo();
    const index = new Map([
      ["~/works", outer],
      ["~/works/app", inner],
    ]);
    expect(isLinkedWorktreePath(index, "~/works/app/.worktrees/feature")).toBe(true);
  });
});

describe("worktreeContainer", () => {
  it("resolves the default location to the folder inside the repository", () => {
    expect(worktreeContainer("{repo}/.worktrees/{branch}", "~/works/app")).toBe("~/works/app/.worktrees");
    expect(worktreeContainer("wt/{branch}", "/srv/app")).toBe("/srv/app/wt");
  });

  it("refuses templates whose folder could be an unrelated project", () => {
    expect(worktreeContainer("{repo}-{branch}", "~/works/app")).toBeNull();
    expect(worktreeContainer("../wt/{branch}", "~/works/app")).toBeNull();
    expect(worktreeContainer("{repo}/{branch}/{branch}", "~/works/app")).toBeNull();
    expect(worktreeContainer("/elsewhere/{branch}", "~/works/app")).toBeNull();
  });
});

describe("isLinkedWorktreePath with a location", () => {
  it("counts a folder in the worktree container even after git forgot it", () => {
    const index = indexFor(["~/works/app"], nestedRepo());
    const location = "{repo}/.worktrees/{branch}";
    expect(isLinkedWorktreePath(index, "~/works/app/.worktrees/removed", location)).toBe(true);
    expect(isLinkedWorktreePath(index, "~/works/app/.worktrees/removed", undefined)).toBe(false);
    expect(isLinkedWorktreePath(index, "~/works/app/client", location)).toBe(false);
    expect(isLinkedWorktreePath(index, "~/works/app", location)).toBe(false);
  });
});

describe("withoutWorktreeRecents", () => {
  it("drops unpinned linked-worktree entries and keeps pins and projects", () => {
    const index = indexFor(["~/works/app"], nestedRepo());
    const projects = [
      makeProject({ cwd: "~/works/app" }),
      makeProject({ cwd: "~/works/app/.worktrees/feature" }),
      makeProject({ cwd: "~/works/app/.worktrees/pinned", pinned: true }),
    ];
    // The pinned one isn't a listed worktree here, so give it one.
    const repo = nestedRepo();
    repo.worktrees.push(makeWorktree({ path: "~/works/app/.worktrees/pinned", branch: "pinned" }));
    const result = withoutWorktreeRecents(projects, indexFor(["~/works/app"], repo));
    expect(result.map((p) => p.cwd)).toEqual(["~/works/app", "~/works/app/.worktrees/pinned"]);
    expect(withoutWorktreeRecents(projects, new Map())).toBe(projects);
    expect(withoutWorktreeRecents([projects[0]], index)).toEqual([projects[0]]);
  });

  it("returns the same array when nothing changes", () => {
    const projects = [makeProject({ cwd: "~/works/app" })];
    expect(withoutWorktreeRecents(projects, indexFor(["~/works/app"], nestedRepo()))).toBe(projects);
  });
});

describe("projectTree", () => {
  it("groups sessions in different worktrees under one repository project", () => {
    const repo = nestedRepo();
    const main = makeSession({ id: "$1", name: "app", path: "~/works/app" });
    const feature = makeSession({ id: "$2", name: "feature", path: "~/works/app/.worktrees/feature" });
    const nodes = projectTree(
      [main, feature],
      [],
      indexFor(["~/works/app", "~/works/app/.worktrees/feature"], repo),
    );
    expect(nodes).toHaveLength(1);
    expect(nodes[0].label).toBe("app");
    expect(nodes[0].cwd).toBe("~/works/app");
    expect(nodes[0].sessions).toEqual([]);
    expect(nodes[0].worktrees.map((w) => [w.label, w.sessions.map((s) => s.name)])).toEqual([
      ["main", ["app"]],
      ["feature", ["feature"]],
    ]);
  });

  it("attributes a session in a nested worktree to that worktree, not the repo root", () => {
    const repo = nestedRepo();
    const feature = makeSession({ name: "feature", path: "~/works/app/.worktrees/feature" });
    const nodes = projectTree([feature], [], indexFor(["~/works/app/.worktrees/feature"], repo));
    expect(nodes[0].worktrees[0].sessions).toEqual([]);
    expect(nodes[0].worktrees[1].sessions).toEqual([feature]);
  });

  it("lists a worktree that has no session at all", () => {
    const repo = nestedRepo();
    const main = makeSession({ name: "app", path: "~/works/app" });
    const nodes = projectTree([main], [], indexFor(["~/works/app"], repo));
    expect(nodes[0].worktrees).toHaveLength(2);
    expect(nodes[0].worktrees[1].sessions).toEqual([]);
  });

  it("keeps every session in one worktree rather than picking an owner", () => {
    const repo = nestedRepo();
    const a = makeSession({ id: "$1", name: "app", path: "~/works/app" });
    const b = makeSession({ id: "$2", name: "app-2", path: "~/works/app" });
    const nodes = projectTree([a, b], [], indexFor(["~/works/app"], repo));
    expect(nodes[0].worktrees[0].sessions).toEqual([a, b]);
  });

  it("shows no worktree level for a repository with a single worktree", () => {
    const single: RepoInfo = {
      repo: "~/works/solo",
      branches: [],
      worktrees: [makeWorktree({ path: "~/works/solo", main: true })],
    };
    const session = makeSession({ name: "solo", path: "~/works/solo" });
    const nodes = projectTree([session], [], indexFor(["~/works/solo"], single));
    expect(nodes[0].worktrees).toEqual([]);
    expect(nodes[0].sessions).toEqual([session]);
  });

  it("labels a detached worktree by its short head, and an unbranched one by its folder", () => {
    const repo: RepoInfo = {
      repo: "~/works/app",
      branches: [],
      worktrees: [
        makeWorktree({ path: "~/works/app", main: true }),
        makeWorktree({ path: "~/works/app/.worktrees/loose", branch: null, detached: true, head: "abc1234def" }),
        makeWorktree({ path: "~/works/app/.worktrees/odd", branch: null }),
      ],
    };
    const session = makeSession({ path: "~/works/app" });
    const nodes = projectTree([session], [], indexFor(["~/works/app"], repo));
    expect(nodes[0].worktrees.map((w) => w.label)).toEqual(["main", "(detached abc1234)", "odd"]);
  });

  it("keeps a non-repository session as its own flat project", () => {
    const session = makeSession({ name: "notes", path: "~/notes" });
    const nodes = projectTree([session], [], new Map());
    expect(nodes).toEqual([
      {
        key: "~/notes",
        cwd: "~/notes",
        label: "notes",
        pinned: false,
        sessions: [session],
        worktrees: [],
      },
    ]);
  });

  it("merges same-path sessions and never merges pathless ones", () => {
    const a = makeSession({ id: "$1", name: "app", path: "~/works/app" });
    const b = makeSession({ id: "$2", name: "app-2", path: "~/works/app" });
    const x = makeSession({ id: "$3", name: "x", path: "" });
    const y = makeSession({ id: "$4", name: "y", path: "" });
    const nodes = projectTree([a, b, x, y], [], new Map());
    expect(nodes.map((n) => [n.key, n.sessions.map((s) => s.name)])).toEqual([
      ["~/works/app", ["app", "app-2"]],
      ["x", ["x"]],
      ["y", ["y"]],
    ]);
  });

  it("orders projects by the first session that put each on screen", () => {
    const repo = nestedRepo();
    const other = makeSession({ id: "$1", name: "notes", path: "~/notes" });
    const feature = makeSession({ id: "$2", name: "feature", path: "~/works/app/.worktrees/feature" });
    const nodes = projectTree([other, feature], [], indexFor(["~/works/app/.worktrees/feature"], repo));
    expect(nodes.map((n) => n.key)).toEqual(["~/notes", "~/works/app"]);
  });

  it("pins a project by its repo root and a worktree by its own path, never both for one folder", () => {
    const repo = nestedRepo();
    const main = makeSession({ path: "~/works/app" });
    const nodes = projectTree(
      [main],
      [
        makeProject({ cwd: "~/works/app", pinned: true }),
        makeProject({ cwd: "~/works/app/.worktrees/feature", pinned: true }),
      ],
      indexFor(["~/works/app"], repo),
    );
    expect(nodes[0].pinned).toBe(true);
    // The main worktree is the repo root: its pin shows on the project row
    // above, not twice in the same subtree.
    expect(nodes[0].worktrees.map((w) => w.pinned)).toEqual([false, true]);
  });

  it("gives pinned projects with no live session no row", () => {
    const nodes = projectTree([], [makeProject({ cwd: "~/works/gone", pinned: true })], new Map());
    expect(nodes).toEqual([]);
  });

  it("never doubles a folder that is already a worktree row", () => {
    const repo = nestedRepo();
    const main = makeSession({ path: "~/works/app" });
    const nodes = projectTree(
      [main],
      [makeProject({ cwd: "~/works/app/.worktrees/feature", pinned: true })],
      indexFor(["~/works/app"], repo),
    );
    expect(nodes).toHaveLength(1);
    expect(nodes[0].worktrees[1].pinned).toBe(true);
  });

  it("keeps a session inside the repo but under no listed worktree on the project row", () => {
    const repo = nestedRepo();
    const stray = makeSession({ name: "stray", path: "~/elsewhere" });
    const nodes = projectTree([stray], [], indexFor(["~/elsewhere"], repo));
    expect(nodes[0].key).toBe("~/works/app");
    expect(nodes[0].sessions).toEqual([stray]);
    expect(nodes[0].worktrees.every((w) => w.sessions.length === 0)).toBe(true);
  });
});
