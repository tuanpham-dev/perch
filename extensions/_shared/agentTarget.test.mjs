// Tests for agentTarget.ts's pure resolution logic — the shared "what is an
// agent" helper that git-scm, live-preview and ports all route through, and
// that the github and jira extensions vendor byte-identical copies of
// (plans/agent-platform-core.md).
//
// Plain `node --test`, same as statusModel.test.mjs beside it. It imports the
// .ts source directly: Node strips types natively, so no tsx and no build
// step is involved — which also means these run against the exact file the
// bundles inline, not a copy.
//
// `fetch` is stubbed per test rather than mocked at module level, because
// what is being pinned down is that every caller has exactly ONE source: the
// core registry - and that an unreadable registry is a rejection, not a
// silently invented list.
//
// It used to be three-way. Each extension's own agentPrograms / agents
// setting came first, honoured for one version so an upgrade could not
// silently reset a customized list. That grace period was cancelled before
// it shipped, so those settings are gone and the registry can no longer be
// pre-empted - which is what the first test below now pins down.
import assert from "node:assert/strict";
import { test } from "node:test";
import { agentWindows, resolveAgentPresets, resolveAgentTargets } from "./agentTarget.ts";

// ---- Fixtures ----

const REGISTRY = [
  {
    id: "claude",
    label: "Claude Code",
    program: "claude",
    command: "claude",
    skipPermissionsArgs: "--dangerously-skip-permissions",
    hooks: "claude",
  },
  // Detection-only: no launch command, so it is never offered as a preset.
  { id: "watcher", label: "Watcher", program: "watcher", command: "", skipPermissionsArgs: "", hooks: null },
  // Launch-only: no foreground command, so it can never match a pane.
  { id: "wrapper", label: "Wrapper", program: "", command: "run-agent", skipPermissionsArgs: "", hooks: null },
];

const SESSIONS = [
  {
    name: "repo",
    path: "~/proj",
    windows: [
      { index: 0, name: "zsh", command: "zsh" },
      { index: 1, name: "agent", command: "claude" },
      { index: 2, name: "other", command: "codex" },
    ],
  },
  { name: "elsewhere", path: "~/other", windows: [{ index: 0, name: "a", command: "claude" }] },
  // Synthetic per-window session: mirrors a real session's windows, so
  // counting it would double-list every match.
  { name: "perch-view-abc", path: "~/proj", windows: [{ index: 0, name: "m", command: "claude" }] },
];

function serveRegistry() {
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ agents: REGISTRY, skipPermissions: false }) });
}

// What an older core does: /api/agents does not exist there at all.
function serveNothing() {
  globalThis.fetch = async () => ({ ok: false, status: 404, statusText: "Not Found" });
}

function found(agents, repoPath = "~/proj") {
  return agentWindows(SESSIONS, repoPath, agents).map((w) => `${w.sessionName}:${w.windowIndex}`);
}

// ---- Detection ----

test("matches panes against the registry's programs, once each", async () => {
  serveRegistry();
  assert.deepEqual(found(await resolveAgentTargets()), ["repo:1"]);
});

test("a launch-only entry with no program matches nothing", () => {
  const blankCommandPane = [{ name: "s", path: "~/proj", windows: [{ index: 0, name: "w", command: "" }] }];
  assert.deepEqual(agentWindows(blankCommandPane, "~/proj", [{ program: "" }]), []);
});

test("only sessions at or under the repo path count", async () => {
  serveRegistry();
  const agents = await resolveAgentTargets();
  assert.deepEqual(found(agents, "~/other"), ["elsewhere:0"]);
  assert.deepEqual(found(agents, "~/nowhere"), []);
});

// The deprecated settings used to short-circuit this, and a caller that
// still passed one would now be silently ignored rather than obeyed. The
// registry has to be consulted every time, or "one list of agents" is not
// true.
test("the registry is consulted on every call and cannot be pre-empted", async () => {
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return { ok: true, json: async () => ({ agents: REGISTRY, skipPermissions: false }) };
  };
  assert.deepEqual(await resolveAgentTargets(), REGISTRY);
  // A leftover argument from a caller that has not been updated changes
  // nothing - the signature takes none.
  assert.deepEqual(await resolveAgentTargets(" codex , zsh "), REGISTRY);
  assert.equal(calls, 2);
});

// ---- Launch presets ----

test("offers the registry's launchable entries, in order, skipping detection-only ones", async () => {
  serveRegistry();
  assert.deepEqual(await resolveAgentPresets(), [
    { name: "Claude Code", command: "claude", skipPermissionsArgs: "--dangerously-skip-permissions" },
    { name: "Wrapper", command: "run-agent", skipPermissionsArgs: "" },
  ]);
});

// "Offer nothing" used to be expressible by storing "[]" in the deprecated
// setting. It still has to be reachable, because a user who disables every
// agent in Settings means it - it is now the registry's answer rather than
// the setting's, and an empty menu must not fall back to the floor.
test("a registry with nothing launchable offers nothing, and does not fall back", async () => {
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ agents: [], skipPermissions: false }) });
  assert.deepEqual(await resolveAgentPresets(), []);
  globalThis.fetch = async () => ({
    ok: true,
    json: async () => ({ agents: [{ id: "watcher", label: "Watcher", program: "watcher", command: "" }], skipPermissions: false }),
  });
  assert.deepEqual(await resolveAgentPresets(), []);
});

// ---- No registry, no answer ----
// There is deliberately no fallback: an extension on a core without
// /api/agents gets a rejection, not the list it shipped with years ago.

test("rejects rather than inventing agents when the registry cannot be read", async () => {
  serveNothing();
  await assert.rejects(() => resolveAgentTargets(), /404/);
  await assert.rejects(() => resolveAgentPresets(), /404/);
});

// ---- Skip-permissions, decided once ----
// It used to be a per-call boolean (launchCommand(preset, skip)), which meant
// the worktree form and jira each asked the user again and could contradict
// the one global setting. The server now sends the choice with the list and
// the preset's `command` arrives with it already applied.

test("applies the global yolo choice to the command, per agent's own flag", async () => {
  globalThis.fetch = async () => ({
    ok: true,
    json: async () => ({
      agents: [
        { id: "claude", label: "Claude Code", program: "claude", command: "claude", skipPermissionsArgs: "--dangerously-skip-permissions", hooks: "claude" },
        { id: "codex", label: "OpenAI Codex", program: "codex", command: "codex", skipPermissionsArgs: "--dangerously-bypass-approvals-and-sandbox", hooks: "codex" },
        // No flag of its own: yolo must not invent one.
        { id: "wrapper", label: "Wrapper", program: "", command: "run-agent", skipPermissionsArgs: "", hooks: null },
      ],
      skipPermissions: true,
    }),
  });
  assert.deepEqual(
    (await resolveAgentPresets()).map((p) => p.command),
    ["claude --dangerously-skip-permissions", "codex --dangerously-bypass-approvals-and-sandbox", "run-agent"],
  );
});

test("manual mode leaves every command exactly as the agent declared it", async () => {
  serveRegistry();
  assert.deepEqual(
    (await resolveAgentPresets()).map((p) => p.command),
    ["claude", "run-agent"],
  );
});

