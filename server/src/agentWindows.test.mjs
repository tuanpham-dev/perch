// The matching rule behind host.agents.forWindow: which window is running an
// agent, and which process it is. Pure over its inputs, so the process map
// and the window list are handed in rather than read from the host.
import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveAgentWindows } from "./agentWindows.ts";

const CLAUDE = { id: "ext.agents.claude", label: "Claude Code", program: "claude" };
const CODEX = { id: "ext.agents.codex", label: "Codex", program: "codex" };

const window = (over = {}) => ({
  windowIndex: 0,
  windowId: "w0",
  pid: 100,
  command: "zsh",
  cwd: "/works/app",
  ...over,
});

// pid -> { ppid, comm }
const procs = (entries) => new Map(entries.map(([pid, ppid, comm]) => [pid, { ppid, comm }]));

test("a window whose foreground is an agent matches, with the agent's own pid", () => {
  const map = procs([
    [100, 1, "zsh"],
    [101, 100, "claude"],
  ]);
  const [found] = resolveAgentWindows([window({ command: "claude" })], [CLAUDE, CODEX], map);
  assert.equal(found.agentId, CLAUDE.id);
  assert.equal(found.label, "Claude Code");
  assert.equal(found.matchedBy, "foreground");
  assert.equal(found.windowPid, 100);
  assert.equal(found.agentPid, 101);
  assert.equal(found.cwd, "/works/app");
});

test("a foreground match with no process list still reports the window", () => {
  const [found] = resolveAgentWindows([window({ command: "claude" })], [CLAUDE], new Map());
  assert.equal(found.agentId, CLAUDE.id);
  assert.equal(found.agentPid, null);
  assert.equal(found.matchedBy, "foreground");
});

test("an agent under a wrapper is found through the process tree", () => {
  const map = procs([
    [100, 1, "zsh"],
    [101, 100, "run-agent.sh"],
    [102, 101, "codex"],
  ]);
  const [found] = resolveAgentWindows([window({ command: "run-agent.sh" })], [CLAUDE, CODEX], map);
  assert.equal(found.agentId, CODEX.id);
  assert.equal(found.agentPid, 102);
  assert.equal(found.matchedBy, "descendant");
});

test("a window running no agent is left out", () => {
  const map = procs([
    [100, 1, "zsh"],
    [101, 100, "vim"],
  ]);
  assert.deepEqual(resolveAgentWindows([window()], [CLAUDE, CODEX], map), []);
});

test("only the windows with agents come back, in window order", () => {
  const map = procs([
    [100, 1, "zsh"],
    [101, 100, "claude"],
    [200, 1, "zsh"],
    [300, 1, "zsh"],
    [301, 300, "codex"],
  ]);
  const found = resolveAgentWindows(
    [
      window({ windowIndex: 0, windowId: "w0", pid: 100, command: "claude" }),
      window({ windowIndex: 1, windowId: "w1", pid: 200, command: "zsh" }),
      window({ windowIndex: 2, windowId: "w2", pid: 300, command: "zsh" }),
    ],
    [CLAUDE, CODEX],
    map,
  );
  assert.deepEqual(
    found.map((f) => [f.windowIndex, f.agentId, f.matchedBy]),
    [
      [0, CLAUDE.id, "foreground"],
      [2, CODEX.id, "descendant"],
    ],
  );
});

test("an agent with no program never matches, and neither does an empty registry", () => {
  const map = procs([
    [100, 1, "zsh"],
    [101, 100, "claude"],
  ]);
  const launchOnly = { id: "ext.agents.thing", label: "Thing", program: "" };
  assert.deepEqual(resolveAgentWindows([window({ command: "" })], [launchOnly], map), []);
  assert.deepEqual(resolveAgentWindows([window({ command: "claude" })], [], map), []);
});

test("an agent started from inside another reports the outer one", () => {
  const map = procs([
    [100, 1, "zsh"],
    [101, 100, "claude"],
    [102, 101, "codex"],
  ]);
  const [found] = resolveAgentWindows([window()], [CLAUDE, CODEX], map);
  assert.equal(found.agentId, CLAUDE.id);
  assert.equal(found.agentPid, 101);
});
