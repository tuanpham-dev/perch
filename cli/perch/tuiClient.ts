// Everything `perch tui` asks of a Perch server: the session list, the
// projects in the settings document, the session and window actions, the
// folder listing for path completion, and the attach WebSocket's URL. Unlike
// apiClient.ts it never exits the process on a failure; the TUI shows the
// error in its status line and carries on.
import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { stateDir } from '../../mux/src/util/paths.ts';
import { sanitizeProjects, type Project, type Session } from './tuiModel.ts';

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
    this.name = 'ApiError';
  }
}

/** One listening port, as the Ports extension's list route returns it. */
export interface ListeningPort {
  port: number;
  address: string;
  process?: string;
  pid?: number;
  session: string;
  /** The terminal window the process runs in (newer servers only). */
  window?: string;
  orphan?: boolean;
}

export interface DirEntry {
  name: string;
  dir: boolean;
}

export class PerchClient {
  readonly baseUrl: string;
  readonly token: string;

  constructor(baseUrl: string, token = '') {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.token = token;
  }

  /** host[:port], for the header line. */
  get host(): string {
    return new URL(this.baseUrl).host;
  }

  async #request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const headers: Record<string, string> = {};
    if (this.token) headers['x-auth-token'] = this.token;
    if (body !== undefined) headers['content-type'] = 'application/json';
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}/api${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(10_000),
      });
    } catch {
      throw new ApiError(0, `couldn't reach the server at ${this.baseUrl}`);
    }
    if (!res.ok) {
      let message = `${res.status} ${res.statusText}`;
      try {
        const parsed = JSON.parse(await res.text()) as { error?: unknown };
        if (typeof parsed.error === 'string') message = parsed.error;
      } catch {
        // Not JSON (a proxy's error page): the status is all there is.
      }
      throw new ApiError(res.status, message);
    }
    if (res.status === 204) return undefined as T;
    return (await res.json()) as T;
  }

  sessions(): Promise<Session[]> {
    return this.#request('GET', '/sessions');
  }

  async projects(): Promise<Project[]> {
    const doc = await this.#request<{ projects?: unknown }>('GET', '/settings');
    return sanitizeProjects(doc?.projects);
  }

  /** PATCH replaces just the `projects` key; every other setting is left alone. */
  saveProjects(projects: Project[]): Promise<void> {
    return this.#request('PATCH', '/settings', { projects });
  }

  /** Starts a session in exactly `cwd` (not its git root), like a project open. */
  createSession(name: string, cwd: string): Promise<Session> {
    return this.#request('POST', '/sessions', { name, cwd, exactCwd: true });
  }

  async newWindow(session: string, cwd: string): Promise<number> {
    const r = await this.#request<{ index: number }>('POST', `/sessions/${encodeURIComponent(session)}/windows`, { cwd });
    return r.index;
  }

  renameSession(session: string, name: string): Promise<void> {
    return this.#request('POST', `/sessions/${encodeURIComponent(session)}/rename`, { name });
  }

  renameWindow(session: string, index: number, name: string): Promise<void> {
    return this.#request('POST', `/sessions/${encodeURIComponent(session)}/windows/${index}/rename`, { name });
  }

  killSession(session: string): Promise<void> {
    return this.#request('DELETE', `/sessions/${encodeURIComponent(session)}`);
  }

  killWindow(session: string, index: number): Promise<void> {
    return this.#request('DELETE', `/sessions/${encodeURIComponent(session)}/windows/${index}`);
  }

  /** The server's listing of a folder; `path` comes back `~`-shortened. */
  listDir(path: string): Promise<{ path: string; entries: DirEntry[] }> {
    return this.#request('GET', `/fs?path=${encodeURIComponent(path)}`);
  }

  /**
   * The server's listening ports, from the bundled Ports extension; null
   * when the server doesn't have it (the route is missing or disabled).
   */
  async ports(): Promise<ListeningPort[] | null> {
    try {
      return await this.#request<ListeningPort[]>('GET', '/ext/perch.ports/list');
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) return null;
      throw err;
    }
  }

  /** Ends the process holding `port` (SIGTERM, SIGKILL after a grace period). */
  killPort(port: number): Promise<void> {
    return this.#request('POST', `/ext/perch.ports/kill/${port}`);
  }

  /**
   * Whether a tunnel started with `client` in its command is connected, and
   * which ports it has bound on the machine it runs on.
   */
  async tunnelStatus(client: string): Promise<{ connected: boolean; ports: number[] }> {
    const r = await this.#request<{ connected?: boolean; ports?: number[] }>('GET', `/tunnel-status?client=${encodeURIComponent(client)}`);
    return { connected: r?.connected === true, ports: Array.isArray(r?.ports) ? r.ports : [] };
  }

  /** The proxy domain ports are served under, or null for the /proxy/ path. */
  async proxyDomain(): Promise<string | null> {
    const r = await this.#request<{ domain?: string | null }>('GET', '/proxy-config');
    return r?.domain || null;
  }

  /**
   * The attach socket for a session name (follows its current window) or a
   * "@<window id>" (pinned to that window). The token rides in the query,
   * which the upgrade handler accepts alongside the header.
   */
  attachUrl(target: string, cols: number, rows: number): string {
    const url = new URL('/ws/attach', this.baseUrl);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    url.searchParams.set('session', target);
    url.searchParams.set('cols', String(cols));
    url.searchParams.set('rows', String(rows));
    if (this.token) url.searchParams.set('token', this.token);
    return url.toString();
  }
}

/**
 * This machine's id for pairing tunnels with the TUI (the tunnel CLI's
 * --client). Kept in a file so a tunnel started from an earlier run's command
 * still counts after the TUI restarts; made up and saved on first use. If
 * the file can't be written, the id lasts as long as this run.
 */
export function tunnelClientId(file = join(stateDir(), 'tui-tunnel-client')): string {
  try {
    const stored = readFileSync(file, 'utf8').trim();
    if (/^[A-Za-z0-9_-]{1,64}$/.test(stored)) return stored;
  } catch {
    // Not made yet.
  }
  const id = randomBytes(16).toString('hex');
  try {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, `${id}\n`, { mode: 0o600 });
  } catch {
    // Read-only state folder: this run's id only.
  }
  return id;
}
