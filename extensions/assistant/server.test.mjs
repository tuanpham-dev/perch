// Recorded results of the tools that exist today, pinned before server.js
// learns about remote machines. Each test calls /tools or /call and asserts
// the whole response body.
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { activate, deactivate } from "./server.js";
import { fakeHost } from "./test/fakeHost.mjs";

const win = (id, index, name, command, cwd, active = false) => ({ id, index, name, command, cwd, active });

// Two projects: perch has a shell (w1) and a claude agent (w2); api has a shell.
function fixture() {
  return fakeHost({
    sessions: [
      { name: "perch", path: "/work/perch", windows: [win("w1", 0, "zsh", "zsh", "/work/perch", true), win("w2", 1, "claude", "claude", "/work/perch")] },
      { name: "api", path: "/work/api", windows: [win("w3", 0, "zsh", "zsh", "/work/api", true)] },
    ],
    agents: { perch: [{ windowId: "w2", windowIndex: 1, label: "Claude Code", cwd: "/work/perch" }] },
    conversations: {
      "/work/perch": [{ id: "c1", title: "Fix the relay", agentId: "claude", agentLabel: "Claude Code", openIn: { windowId: "w2", sessionName: "perch", windowIndex: 1 } }],
    },
    messages: {
      c1: [
        { role: "user", text: "hello" },
        { role: "assistant", text: "hi there" },
      ],
    },
    ports: [{ port: 5173, session: "perch", orphan: false, process: "node", pid: 10 }],
  });
}

const text = (value) => ({ content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }], isError: false });
const failure = (message) => ({ content: [{ type: "text", text: message }], isError: true });

function start(fh = fixture()) {
  activate({ router: fh.router, host: fh.host, getSettings: fh.getSettings, log: fh.log });
  const call = async (name, args = {}) => {
    const res = await fh.request("POST", "/call", { name, arguments: args });
    assert.equal(res.statusCode, 200);
    return res.body;
  };
  return { fh, call };
}

afterEach(() => deactivate());

test("/tools lists the tools without changing their names or order", async () => {
  const { fh } = start();
  const res = await fh.request("GET", "/tools");
  assert.deepEqual(
    res.body.tools.map((t) => t.name),
    [
      "list_projects", "agent_status", "agent_conversation", "read_terminal", "list_ports", "list_conversations", "list_worktrees",
      "wait_for_agent", "open_web_preview", "open_file_preview", "port_forward_command", "list_commands", "run_command",
      "focus_window", "send_to_agent", "create_session", "create_window", "kill_session", "create_worktree", "remove_worktree",
      "resume_conversation",
    ],
  );
  const send = res.body.tools.find((t) => t.name === "send_to_agent");
  assert.deepEqual(send, {
    name: "send_to_agent",
    description:
      "Type text into a terminal, normally an AI agent's prompt, and press Enter unless submit is false. For a project with several windows it types into the agent's window. Follow with wait_for_agent to know when the agent is done.",
    inputSchema: {
      type: "object",
      properties: {
        target: { type: "string", description: 'A project or terminal: a window id ($PERCH_WINDOW), "project:index", a project (session) name, or a path inside the project.' },
        text: { type: "string", description: "What to type." },
        submit: { type: "boolean", description: "Press Enter after typing (default true)." },
        machine: { type: "string", description: "Another machine in this Perch's relay group, by name from list_machines. Omit for this machine." },
      },
      required: ["target", "text"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  });
});

test("machine is in exactly the six remote tools' schemas", async () => {
  const { fh } = start();
  const tools = (await fh.request("GET", "/tools")).body.tools;
  assert.deepEqual(
    tools.filter((t) => "machine" in t.inputSchema.properties).map((t) => t.name),
    ["list_projects", "agent_status", "agent_conversation", "read_terminal", "wait_for_agent", "send_to_agent"],
  );
});

test("a tool that does not take machine refuses it without running", async () => {
  const fh = fixture();
  const killed = [];
  fh.host.sessions.kill = async (name) => void killed.push(name);
  const { call } = start(fh);
  assert.deepEqual(
    await call("kill_session", { project: "api", machine: "other" }),
    failure("kill_session only works on this machine; it does not take a machine."),
  );
  assert.deepEqual(killed, []);
});

test("machine on a Perch with no relay is the not-in-a-group error", async () => {
  const { call } = start();
  assert.deepEqual(
    await call("list_projects", { machine: "other" }),
    failure("This Perch is not in a relay group. Join one in Settings → Assistant → Relay or with: perch relay join"),
  );
});

test("list_projects", async () => {
  const { call } = start();
  assert.deepEqual(
    await call("list_projects"),
    text([
      {
        name: "perch",
        path: "/work/perch",
        windows: [
          { index: 0, id: "w1", name: "zsh", command: "zsh", cwd: "/work/perch", active: true },
          { index: 1, id: "w2", name: "claude", command: "claude", cwd: "/work/perch", active: false, agent: "Claude Code", agentStatus: "unknown" },
        ],
        ports: [5173],
      },
      {
        name: "api",
        path: "/work/api",
        windows: [{ index: 0, id: "w3", name: "zsh", command: "zsh", cwd: "/work/api", active: true }],
        ports: [],
      },
    ]),
  );
});

test("agent_status without hook events, with a target, and for a project with no agent", async () => {
  const { call } = start();
  const entry = {
    project: "perch",
    window: "perch:1",
    windowId: "w2",
    agent: "Claude Code",
    status: "unknown",
    lastEventAt: null,
    note: "No hook event from this agent since the Perch server started. If it is busy, its hooks may not be installed: Settings → AI Providers → Install hooks.",
    conversation: { id: "c1", title: "Fix the relay" },
    lastMessage: { role: "assistant", text: "hi there" },
  };
  assert.deepEqual(await call("agent_status"), text([entry]));
  assert.deepEqual(await call("agent_status", { target: "perch" }), text([entry]));
  assert.deepEqual(await call("agent_status", { target: "api" }), text("No AI agent is running in api."));
  assert.deepEqual(await call("agent_status", { target: "nope" }), failure("No project or window matches \"nope\". Open projects: perch, api."));
});

test("agent_status reflects the last hook event", async () => {
  const { fh, call } = start();
  fh.emit({ paneId: "w2", event: "stop", receivedAt: Date.UTC(2026, 0, 2, 3, 4, 5) });
  const res = await call("agent_status", { target: "perch:1" });
  const [entry] = JSON.parse(res.content[0].text);
  assert.equal(entry.status, "idle");
  assert.equal(entry.lastEventAt, "2026-01-02T03:04:05.000Z");
  assert.equal("note" in entry, false);
});

test("agent_conversation", async () => {
  const { call } = start();
  const body = {
    conversation: { id: "c1", title: "Fix the relay", agent: "Claude Code" },
    messages: [
      { role: "user", text: "hello" },
      { role: "assistant", text: "hi there" },
    ],
  };
  assert.deepEqual(await call("agent_conversation", { target: "perch" }), text(body));
  assert.deepEqual(await call("agent_conversation", { target: "perch", conversationId: "c1", limit: 1 }), text({ ...body, messages: [body.messages[1]] }));
  assert.deepEqual(await call("agent_conversation", { target: "perch", conversationId: "zz" }), failure("No conversation zz in perch. List them with list_conversations."));
  assert.deepEqual(await call("agent_conversation", { target: "api" }), failure("No AI agent is running in api:0."));
});

test("read_terminal", async () => {
  const { fh, call } = start();
  assert.deepEqual(await call("read_terminal", { target: "perch" }), text("perch:1 (claude)\n\nscreen of w2"));
  assert.deepEqual(await call("read_terminal", { target: "w1", scrollback: 50 }), text("perch:0 (zsh)\n\nscreen of w1"));
  assert.deepEqual(fh.host.calls.capture, [
    { windowId: "w2", opts: { scrollback: 0 } },
    { windowId: "w1", opts: { scrollback: 50 } },
  ]);
});

test("wait_for_agent returns at once when idle, and waits for a stop otherwise", async () => {
  const { fh, call } = start();
  fh.emit({ paneId: "w2", event: "stop", receivedAt: 1 });
  assert.deepEqual(await call("wait_for_agent", { target: "perch" }), text({ window: "perch:1", status: "idle", lastEventAt: "1970-01-01T00:00:00.001Z", waitedSeconds: 0 }));

  fh.emit({ paneId: "w2", event: "prompt-submit", receivedAt: Date.now() });
  const waiting = call("wait_for_agent", { target: "perch", timeoutSeconds: 30 });
  await new Promise((r) => setTimeout(r, 20));
  fh.emit({ paneId: "w2", event: "permission", receivedAt: Date.now() });
  assert.deepEqual(await waiting, text({ window: "perch:1", status: "needs-input", waitedSeconds: 0 }));
});

test("wait_for_agent times out, and deactivate ends a wait", async () => {
  const { fh, call } = start();
  fh.emit({ paneId: "w2", event: "prompt-submit", receivedAt: Date.now() });
  assert.deepEqual(await call("wait_for_agent", { target: "perch", timeoutSeconds: 1 }), text({ window: "perch:1", status: "timed-out", lastStatus: "working", waitedSeconds: 1 }));

  const waiting = call("wait_for_agent", { target: "perch", timeoutSeconds: 30 });
  await new Promise((r) => setTimeout(r, 20));
  deactivate();
  assert.deepEqual(await waiting, text({ window: "perch:1", status: "timed-out", lastStatus: "working", waitedSeconds: 0 }));
});

test("send_to_agent types into the agent window and marks it working", async () => {
  const { fh, call } = start();
  fh.emit({ paneId: "w2", event: "stop", receivedAt: 1 });
  assert.deepEqual(await call("send_to_agent", { target: "perch", text: "run the tests" }), text("Typed into perch:1 (claude) and pressed Enter."));
  assert.deepEqual(await call("send_to_agent", { target: "w1", text: "ls", submit: false }), text("Typed into perch:0 (zsh)."));
  assert.deepEqual(fh.host.calls.sendTextToWindow, [
    { windowId: "w2", text: "run the tests", submit: true },
    { windowId: "w1", text: "ls", submit: false },
  ]);
  const [entry] = JSON.parse((await call("agent_status", { target: "perch" })).content[0].text);
  assert.equal(entry.status, "working");
  assert.equal(entry.note, "A message was just sent; the agent has not reported back yet.");
});

test("read-only hides and refuses send_to_agent", async () => {
  const fh = fixture();
  fh.settings["assistant.readOnly"] = true;
  const { call } = start(fh);
  const tools = (await fh.request("GET", "/tools")).body.tools.map((t) => t.name);
  assert.equal(tools.includes("send_to_agent"), false);
  assert.deepEqual(
    await call("send_to_agent", { target: "perch", text: "x" }),
    failure("send_to_agent is turned off: the Assistant extension is set to read-only (Settings → Extensions → Assistant)."),
  );
  assert.deepEqual(fh.host.calls.sendTextToWindow, []);
});

test("an unknown tool is an error", async () => {
  const { call } = start();
  assert.deepEqual(await call("nope"), failure("Unknown tool: nope"));
});

test("a host without secrets or SQL storage answers /relay/state as unavailable", async () => {
  const { fh } = start();
  const res = await fh.request("GET", "/relay/state");
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, { available: false, reason: "The relay needs Perch 0.9 or later." });
});
