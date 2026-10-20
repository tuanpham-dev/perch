// The session browser's core half: the two built-in transcript formats, the
// registry's fencing of provided readers, and the resume line. Transcripts
// are generated into temp folders; the terminal side (which window has a
// conversation open) is mocked out, since it needs a running daemon.
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

vi.mock("./terminals.js", () => ({ listSessions: async () => [] }));
vi.mock("./agentWindows.js", () => ({ agentsForSession: async () => [] }));

const home = await mkdtemp(path.join(tmpdir(), "perch-agent-sessions-test-"));
process.env.PERCH_CONFIG_DIR = path.join(home, "config");

const { setContributedAgentsSource, parseResumeSession, parseSessionsDescriptor } = await import("./agents.js");
const { writeSettingsDoc } = await import("./settingsStore.js");
const sessions = await import("./agentSessions.js");
const { createClaudeReader, claudeTitle } = await import("./agentSessionFormats/claudeJsonl.js");
const { createCodexReader } = await import("./agentSessionFormats/codexRollout.js");

const claudeRoot = path.join(home, "claude-projects");
const codexRoot = path.join(home, "codex-sessions");
const project = "/work/shop";

const line = (o: unknown) => JSON.stringify(o);

async function writeClaude(id: string, lines: unknown[], cwd = project) {
  const dir = path.join(claudeRoot, cwd.replace(/[^a-zA-Z0-9]/g, "-"));
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, `${id}.jsonl`), lines.map(line).join("\n") + "\n");
}

const user = (text: unknown, extra: Record<string, unknown> = {}) => ({ type: "user", message: { role: "user", content: text }, ...extra });
const assistant = (content: unknown[]) => ({ type: "assistant", message: { role: "assistant", content } });

function agent(over: Record<string, unknown>) {
  return {
    id: "perch.agents.claude",
    label: "Claude Code",
    program: "claude",
    command: "claude",
    resume: "claude --continue",
    skipPermissionsArgs: "--dangerously-skip-permissions",
    hooks: null,
    oneShot: null,
    resumeSession: "claude --resume {id}",
    sessions: { format: "claude-jsonl" as const, dir: claudeRoot },
    docsUrl: "",
    iconUrl: "",
    icon: "sparkle",
    enabled: true,
    contributedBy: "perch.agents",
    ...over,
  };
}

beforeEach(async () => {
  sessions.resetSessionReaders();
  await rm(claudeRoot, { recursive: true, force: true });
  await rm(codexRoot, { recursive: true, force: true });
  await writeSettingsDoc({ settings: { agentPermissions: "manual" } });
  setContributedAgentsSource(async () => [agent({})]);
});

afterAll(async () => {
  await rm(home, { recursive: true, force: true });
});

describe("claude-jsonl", () => {
  it("titles a conversation the way Claude Code does", () => {
    expect(claudeTitle([user("first prompt"), { type: "ai-title", aiTitle: "Generated" }])).toBe("Generated");
    expect(claudeTitle([{ type: "ai-title", aiTitle: "Generated" }, { type: "custom-title", customTitle: "Mine" }])).toBe("Mine");
    expect(claudeTitle([user("<local-command-caveat>x</local-command-caveat>"), user("fix the grid\nplease")])).toBe("fix the grid please");
  });

  it("lists a folder's conversations with counts, leaving out empty ones", async () => {
    await writeClaude("aaaaaaaa-0000-4000-8000-000000000001", [
      user("fix the grid"),
      assistant([{ type: "thinking", thinking: "..." }, { type: "text", text: "On it." }, { type: "tool_use", name: "Bash", input: { command: "ls" } }]),
      user([{ type: "tool_result", content: "ok" }]),
      assistant([{ type: "text", text: "Done." }]),
    ]);
    await writeClaude("aaaaaaaa-0000-4000-8000-000000000002", [{ type: "mode", mode: "default" }]);
    const list = await createClaudeReader(claudeRoot).list(project);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ id: "aaaaaaaa-0000-4000-8000-000000000001", title: "fix the grid", messageCount: 3 });
  });

  it("collapses tool calls to one line in the messages", async () => {
    await writeClaude("aaaaaaaa-0000-4000-8000-000000000003", [
      user("go"),
      assistant([{ type: "tool_use", name: "Read", input: { file_path: "/work/shop/a.ts" } }]),
    ]);
    const messages = await createClaudeReader(claudeRoot).messages("aaaaaaaa-0000-4000-8000-000000000003", project, 50);
    expect(messages).toEqual([
      { role: "user", text: "go" },
      { role: "tool", text: "Read /work/shop/a.ts" },
    ]);
  });
});

describe("codex-rollout", () => {
  async function writeRollout(name: string, id: string, cwd: string, prompt: string) {
    const dir = path.join(codexRoot, "2026", "10", "19");
    await mkdir(dir, { recursive: true });
    await writeFile(
      path.join(dir, name),
      [
        line({ type: "session_meta", payload: { id, cwd } }),
        line({ type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "<environment_context>x</environment_context>" }] } }),
        line({ type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: prompt }] } }),
        line({ type: "response_item", payload: { type: "custom_tool_call", name: "exec", input: "git status" } }),
        line({ type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "Clean." }] } }),
      ].join("\n") + "\n",
    );
  }

  it("lists only the folder's rollouts, titled by the first real prompt", async () => {
    await writeRollout("rollout-a.jsonl", "01a14294-5e9b-7f62-87b4-8ffde0f79755", project, "add .backups to ignore");
    await writeRollout("rollout-b.jsonl", "01a14294-5e9b-7f62-87b4-8ffde0f79756", "/elsewhere", "other");
    const reader = createCodexReader(codexRoot);
    const list = await reader.list(project);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ title: "add .backups to ignore", messageCount: 2 });
    expect(await reader.messages(list[0].id, project, 10)).toEqual([
      { role: "user", text: "add .backups to ignore" },
      { role: "tool", text: "exec git status" },
      { role: "assistant", text: "Clean." },
    ]);
  });
});

describe("registry", () => {
  it("skips a reader that throws or hangs, and keeps the rest", async () => {
    await writeClaude("aaaaaaaa-0000-4000-8000-000000000004", [user("keep me")]);
    setContributedAgentsSource(async () => [
      agent({}),
      agent({ id: "ext.broken.thrower", sessions: null, resumeSession: "" }),
      agent({ id: "ext.broken.hanger", sessions: null, resumeSession: "" }),
    ]);
    sessions.registerSessionReader("ext.broken.thrower", {
      list: async () => {
        throw new Error("boom");
      },
      messages: async () => [],
    });
    sessions.registerSessionReader("ext.broken.hanger", { list: () => new Promise(() => {}), messages: async () => [] });
    sessions.setReaderTimeout(200);
    try {
      const list = await sessions.listAgentSessions(project);
      expect(list.map((s) => s.title)).toEqual(["keep me"]);
      expect(list[0]).toMatchObject({ agentId: "perch.agents.claude", canResume: true, openIn: null });
    } finally {
      sessions.setReaderTimeout(sessions.READER_TIMEOUT_MS);
    }
  });

  it("drops an extension's readers when it unmounts", async () => {
    setContributedAgentsSource(async () => [agent({ id: "ext.x.agent", sessions: null })]);
    sessions.registerSessionReader("ext.x.agent", {
      list: async () => [{ id: "s1", cwd: project, title: "From ext", lastActiveAt: 1, messageCount: 1 }],
      messages: async () => [],
    });
    expect((await sessions.listAgentSessions(project)).map((s) => s.title)).toEqual(["From ext"]);
    sessions.dropSessionReaders("ext.x");
    expect(await sessions.listAgentSessions(project)).toEqual([]);
  });

  it("builds the resume line under Manual and Yolo, and refuses unsafe ids", async () => {
    expect(await sessions.resumeSessionCommand("perch.agents.claude", "abc-123")).toBe("claude --resume abc-123");
    await writeSettingsDoc({ settings: { agentPermissions: "yolo" } });
    expect(await sessions.resumeSessionCommand("perch.agents.claude", "abc-123")).toBe(
      "claude --resume abc-123 --dangerously-skip-permissions",
    );
    expect(await sessions.resumeSessionCommand("perch.agents.claude", "x; rm -rf ~")).toBeNull();
    expect(await sessions.resumeSessionCommand("perch.agents.claude", "$(whoami)")).toBeNull();
  });

  it("lists 500 conversations within 2 seconds", async () => {
    await Promise.all(
      Array.from({ length: 500 }, (_, i) =>
        writeClaude(`bbbbbbbb-0000-4000-8000-${String(i).padStart(12, "0")}`, [user(`prompt ${i}`), assistant([{ type: "text", text: "ok" }])]),
      ),
    );
    const started = Date.now();
    const list = await sessions.listAgentSessions(project);
    expect(list).toHaveLength(500);
    expect(Date.now() - started).toBeLessThan(2000);
  });
});

describe("manifest fields", () => {
  it("parses resumeSession and sessions, dropping unusable ones", () => {
    expect(parseResumeSession("claude --resume {id}")).toBe("claude --resume {id}");
    expect(parseResumeSession("claude --resume")).toBe("");
    expect(parseSessionsDescriptor({ format: "claude-jsonl" })).toEqual({ format: "claude-jsonl", dir: null });
    expect(parseSessionsDescriptor({ format: "nope" })).toBeNull();
    expect(parseSessionsDescriptor({ format: "codex-rollout", dir: "/etc" })).toBeNull();
    expect(parseSessionsDescriptor({ format: "codex-rollout", dir: "~/.codex/sessions" })?.dir).toMatch(/\.codex[\\/]sessions$/);
  });
});
