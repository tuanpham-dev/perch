import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { windowsHookShim } from "./agentHooks.js";
import { windowsOpenShim } from "./openUrl.js";

// The Windows shims are Node scripts, so their behaviour can be checked on any
// system: run each against a local server and look at what arrives.
interface Received { url: string; headers: IncomingMessage["headers"]; body: string }

let received: Received[] = [];
let port = 0;
let close: () => void = () => {};
let dir = "";

beforeEach(async () => {
  received = [];
  dir = mkdtempSync(path.join(tmpdir(), "shims-"));
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      received.push({ url: req.url ?? "", headers: req.headers, body: Buffer.concat(chunks).toString("utf8") });
      res.writeHead(204).end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as AddressInfo).port;
  close = () => server.close();
});

afterEach(() => {
  close();
  rmSync(dir, { recursive: true, force: true });
});

function runScript(script: string, args: string[], input = "", env: Record<string, string> = {}): Promise<number> {
  const file = path.join(dir, "shim.mjs");
  writeFileSync(file, script);
  // Async: the test's own server has to keep answering while the script runs.
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [file, ...args], { env: { ...process.env, ...env } });
    child.stdin.end(input);
    child.on("exit", (code) => resolve(code ?? -1));
  });
}

describe("Windows shims", () => {
  it("the browser opener posts the URL with its guard header", async () => {
    const { script, cmd } = windowsOpenShim(port, "C:\\Program Files\\nodejs\\node.exe");
    expect(cmd).toBe('@echo off\r\n"C:\\Program Files\\nodejs\\node.exe" "%~dp0open-in-browser.mjs" %*\r\n');
    expect(await runScript(script, ["https://example.com/a b"])).toBe(0);
    expect(received).toHaveLength(1);
    expect(received[0]!.url).toBe("/api/open-url");
    expect(received[0]!.headers["x-perch-open"]).toBe("1");
    expect(new URLSearchParams(received[0]!.body).get("url")).toBe("https://example.com/a b");
  });

  it("the browser opener fails without a URL", async () => {
    expect(await runScript(windowsOpenShim(port, "node").script, [])).toBe(1);
    expect(received).toHaveLength(0);
  });

  it("the agent hook relays the event JSON with the window id, and always exits 0", async () => {
    const { script } = windowsHookShim(port, "node");
    const status = await runScript(script, ["perch.agents.claude", "Stop"], '{"session_id":"abc"}', { PERCH_WINDOW: "w-1" });
    expect(status).toBe(0);
    expect(received[0]!.url).toBe("/api/agent-hooks/report");
    expect(received[0]!.headers["x-perch-agent"]).toBe("perch.agents.claude");
    expect(received[0]!.headers["x-perch-event"]).toBe("Stop");
    expect(received[0]!.headers["x-perch-pane"]).toBe("w-1");
    expect(received[0]!.body).toBe('{"session_id":"abc"}');
  });

  it("the agent hook exits 0 even with the server gone", async () => {
    close();
    const { script } = windowsHookShim(1, "node");
    expect(await runScript(script, ["x", "Stop"], "{}")).toBe(0);
  });
});

