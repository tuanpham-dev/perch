// The Codex trust blocks, pinned to a vector measured against the real
// binary. Codex runs no hook whose handler is not trusted in config.toml and
// says nothing when it skips one, so a wrong hash here is invisible until
// someone notices the agent never reports "done" - which is exactly how the
// bug that motivated this file went unexplained for a week.
//
// Tested through activate() rather than by exporting the internals, because
// what has to keep working is the contract core calls: register a transform,
// hand it the file's current text, write back what comes out.
import assert from "node:assert/strict";
import { test } from "node:test";
import { activate } from "./server.js";

function companionFor(agentId = "codex") {
  let captured = null;
  activate({
    host: {
      agentHooks: {
        provideCompanion(id, transform) {
          if (id === agentId) captured = transform;
        },
      },
    },
  });
  assert.ok(captured, `no companion registered for ${agentId}`);
  return captured;
}

// The exact input that produced the hash below, in an isolated CODEX_HOME on
// 2026-09-11 against codex-cli 0.146.1: with this block present the hook
// fired, with it absent nothing fired at all. The paths are a recorded byte
// vector, not references to the app: they still spell the checkout's old
// folder name because the hash covers those exact bytes.
const HOOK_FILE =
  "/tmp/claude-1002/-works-tmux-server--worktrees-feature-agent-platform-core/907a809b-8a17-4736-924d-e63a75fb787f/scratchpad/codex-home-trusted/hooks.json";
const FIXTURE = {
  rawEvent: "SessionStart",
  command:
    'echo "$(date +%s) fired" >> /tmp/claude-1002/-works-tmux-server--worktrees-feature-agent-platform-core/907a809b-8a17-4736-924d-e63a75fb787f/scratchpad/codex-home-trusted/FIRED',
  timeoutSeconds: 10,
  group: 0,
  handler: 0,
};
const VERIFIED_HASH = "sha256:111862283d0e6c2259d8c33965b499136c2b96e74e43cc1ddba0c716d8da615c";

test("reproduces the hash codex actually accepted", () => {
  const out = companionFor()({ hookFile: HOOK_FILE, handlers: [FIXTURE], current: "" });
  assert.match(out, /^\[hooks\.state\."/m);
  assert.ok(out.includes(`trusted_hash = "${VERIFIED_HASH}"`), out);
  assert.ok(out.includes(`${HOOK_FILE}:session_start:0:0`), out);
  assert.ok(out.includes("enabled = true"));
});

test("PascalCase events become snake_case labels in the key", () => {
  const events = ["SessionStart", "UserPromptSubmit", "PreToolUse", "Stop", "SubagentStop"];
  const out = companionFor()({
    hookFile: HOOK_FILE,
    handlers: events.map((rawEvent) => ({ ...FIXTURE, rawEvent })),
    current: "",
  });
  for (const label of ["session_start", "user_prompt_submit", "pre_tool_use", "stop", "subagent_stop"]) {
    assert.ok(out.includes(`:${label}:0:0`), `missing ${label} in:\n${out}`);
  }
});

test("keeps the user's own config and their unrelated trust blocks", () => {
  const current = [
    "# my notes",
    '[projects."/works/thing"]',
    'trust_level = "trusted"',
    "",
    '[hooks.state."/home/someone/.codex/other.json:stop:0:0"]',
    "enabled = true",
    'trusted_hash = "sha256:deadbeef"',
    "",
  ].join("\n");
  const out = companionFor()({ hookFile: HOOK_FILE, handlers: [FIXTURE], current });
  assert.ok(out.includes("# my notes"));
  assert.ok(out.includes('[projects."/works/thing"]'));
  // Someone else's hooks.json is not ours to touch.
  assert.ok(out.includes('trusted_hash = "sha256:deadbeef"'));
  assert.ok(out.includes(VERIFIED_HASH));
});

test("installing twice does not stack duplicate blocks", () => {
  const companion = companionFor();
  const once = companion({ hookFile: HOOK_FILE, handlers: [FIXTURE], current: "" });
  const twice = companion({ hookFile: HOOK_FILE, handlers: [FIXTURE], current: once });
  assert.equal(twice, once);
  assert.equal(twice.split("[hooks.state.").length - 1, 1);
});

test("no handlers means uninstall: our blocks go, everything else stays", () => {
  const companion = companionFor();
  const installed = companion({
    hookFile: HOOK_FILE,
    handlers: [FIXTURE],
    current: '[projects."/works/thing"]\ntrust_level = "trusted"\n',
  });
  const removed = companion({ hookFile: HOOK_FILE, handlers: [], current: installed });
  assert.ok(!removed.includes("hooks.state"));
  assert.ok(removed.includes('[projects."/works/thing"]'));
});

test("an empty config stays empty rather than gaining a blank line", () => {
  const out = companionFor()({ hookFile: HOOK_FILE, handlers: [], current: "" });
  assert.equal(out, "");
});
