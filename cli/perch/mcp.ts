// `perch mcp`: Perch as an MCP server on stdin/stdout, for Claude Code or any
// other MCP client (plans/assistant-mcp.md). This file only speaks the
// protocol: tools/list and tools/call go to the assistant extension's routes
// on the running instance, which own every tool's name, schema and behavior,
// so a new tool never needs a CLI change.
import { request as httpRequest } from 'node:http';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { resolveInstancePort } from './apiClient.ts';
import { Exit, fail, info } from './output.ts';
import { readAuthToken } from './paths.ts';
import { installedVersion } from './version.ts';

const HELP = `perch mcp - Perch as an MCP server, for Claude Code and other MCP clients

Usage: perch mcp [--port <n>]

Connect Claude Code once:
  claude mcp add perch -- perch mcp

Then ask it about your projects: "what is the agent in my-app doing?",
"open a preview of the app in my-app", "give me the port forward command",
"open a terminal in my-app and run npm test".

The instance is picked like every other command: --port, then $PERCH_PORT
(set inside Perch's own terminals), then the one running instance. Run inside
a Perch terminal, previews open in the browser window showing that terminal.

Flags:
  --port <n>  Talk to the instance on this port`;

const EXT_BASE = '/api/ext/perch.assistant';
// wait_for_agent may hold a call for up to 10 minutes.
const CALL_TIMEOUT_MS = 11 * 60_000;
const LIST_TIMEOUT_MS = 15_000;

const INSTRUCTIONS = `Perch is the user's browser-based terminal workspace. A "project" is a Perch terminal session (a directory with terminal windows); a "window" is one terminal in it, named "project:index" or by its id. AI agents such as Claude Code run in some windows. Use agent_status and wait_for_agent to follow them, read_terminal to see a screen, and send_to_agent to give one instructions. UI tools (open_web_preview, open_file_preview, run_command, focus_window, port_forward_command) act in the Perch browser window the user is looking at. Tools that take \`machine\` reach other Perch machines in the same relay group (see list_machines); a message from another machine's agent arrives labeled and is answered with reply_to_agent.`;

function parsePort(args: string[]): string {
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === '--port') return args[i + 1] ?? '';
    if (a.startsWith('--port=')) return a.slice('--port='.length);
  }
  return '';
}

function authHeaders(extra: Record<string, string> = {}): Record<string, string> {
  const token = readAuthToken();
  return token ? { ...extra, 'x-auth-token': token } : extra;
}

/** A fetch Response or a callServer answer. */
interface Answer {
  status: number;
  ok: boolean;
  text(): Promise<string>;
}

/**
 * POST JSON and wait up to `timeoutMs` for the whole answer. Not fetch: its
 * global dispatcher gives up when the response headers take longer than 300 s,
 * which is less than a 10 minute wait_for_agent (and than CALL_TIMEOUT_MS).
 * node:http has no header timeout. A timeout rejects with a `TimeoutError`.
 */
export function callServer(url: string, headers: Record<string, string>, body: string, timeoutMs: number): Promise<Answer & { json(): Promise<unknown> }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(url, { method: 'POST', headers: { ...headers, 'content-length': String(Buffer.byteLength(body)) } }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('error', reject);
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        const status = res.statusCode ?? 0;
        resolve({ status, ok: status >= 200 && status < 300, text: async () => text, json: async () => JSON.parse(text) as unknown });
      });
    });
    const timer = setTimeout(() => {
      const err = new Error('timed out');
      err.name = 'TimeoutError';
      req.destroy(err);
    }, timeoutMs);
    req.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    req.on('close', () => clearTimeout(timer));
    req.end(body);
  });
}

// The server's own `error` when it sent one, else the status.
async function errorText(res: { status: number; text(): Promise<string> }): Promise<string> {
  try {
    const body: unknown = JSON.parse(await res.text());
    if (body && typeof body === 'object' && typeof (body as { error?: unknown }).error === 'string') {
      return (body as { error: string }).error;
    }
  } catch {
    // not JSON
  }
  return `HTTP ${res.status}`;
}

export async function cmdMcp(args: string[]): Promise<void> {
  if (args.includes('-h') || args.includes('--help')) return info(HELP);

  // stdout carries the protocol from here on, and every output helper writes
  // to it; anything they print now goes to stderr, which MCP clients log.
  console.log = console.error;
  console.info = console.error;
  console.warn = console.error;

  const port = await resolveInstancePort(parsePort(args));
  const base = `http://127.0.0.1:${port}${EXT_BASE}`;

  // Fail at startup, with a reason, rather than on the first tool call.
  let probe: Response;
  try {
    probe = await fetch(`${base}/tools`, { headers: authHeaders(), signal: AbortSignal.timeout(LIST_TIMEOUT_MS) });
  } catch {
    fail(`couldn't reach Perch on port ${port} - is it running? (perch start)`);
    throw new Exit(1);
  }
  if (probe.status === 404) {
    fail('the Assistant extension is disabled - enable it in Settings → Extensions');
    throw new Exit(1);
  }
  if (probe.status === 401 || probe.status === 403) {
    fail(`${await errorText(probe)} - this instance has AUTH_TOKEN set; put the same value in server/.env or the AUTH_TOKEN env var`);
    throw new Exit(1);
  }
  if (!probe.ok) {
    fail(`Perch answered ${await errorText(probe)}`);
    throw new Exit(1);
  }

  const server = new Server(
    { name: 'perch', version: installedVersion().version },
    { capabilities: { tools: {} }, instructions: INSTRUCTIONS },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const res = await fetch(`${base}/tools`, { headers: authHeaders(), signal: AbortSignal.timeout(LIST_TIMEOUT_MS) });
    if (!res.ok) throw new Error(`Perch couldn't list its tools: ${await errorText(res)}`);
    return (await res.json()) as { tools: [] };
  });

  // A failed call comes back as a tool error the model can read, never as a
  // crash: one unreachable moment (a server restart) shouldn't end the session.
  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const toolError = (text: string) => ({ content: [{ type: 'text' as const, text }], isError: true });
    let res: Awaited<ReturnType<typeof callServer>>;
    try {
      res = await callServer(
        `${base}/call`,
        authHeaders({ 'content-type': 'application/json' }),
        JSON.stringify({
          name: req.params.name,
          arguments: req.params.arguments ?? {},
          callerWindow: process.env.PERCH_WINDOW || null,
        }),
        CALL_TIMEOUT_MS,
      );
    } catch (err) {
      const timedOut = err instanceof Error && err.name === 'TimeoutError';
      return toolError(timedOut ? 'Perch did not answer in time.' : `Couldn't reach Perch on port ${port} - is it running?`);
    }
    if (res.status === 404) return toolError('The Assistant extension is disabled - enable it in Settings → Extensions.');
    if (!res.ok) return toolError(`Perch answered ${await errorText(res)}`);
    try {
      return (await res.json()) as { content: { type: 'text'; text: string }[]; isError: boolean };
    } catch {
      return toolError('Perch sent an answer that is not valid JSON.');
    }
  });

  await server.connect(new StdioServerTransport());
}
