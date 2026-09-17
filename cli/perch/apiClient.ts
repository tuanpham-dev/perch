// The one place the CLI talks HTTP to a running instance: which instance, and
// with what credential.
//
// `perch ext` and `perch settings` go through the server rather than writing
// ~/.config/perch themselves, so an installed extension's server hook mounts
// immediately and the install logic stays in one implementation. The cost is
// that an instance has to be running, which resolveInstancePort reports
// plainly.
import { readAuthToken } from './paths.ts';
import { listInstances } from './instances.ts';
import { ask, die, Exit, heading, info, interactive, table, warn } from './output.ts';
import { instanceSummary } from './commands.ts';

/**
 * Which instance to talk to: an explicit --port, then $PERCH_PORT (set in
 * every terminal this app starts, so running a command inside one targets its
 * own instance), then discovery — prompting when more than one is running and
 * refusing when it can't ask.
 *
 * Lifted out of `perch open`, which now calls this, so every command that
 * reaches the API picks its target the same way.
 */
export async function resolveInstancePort(flagPort = ''): Promise<string> {
  let port = flagPort || process.env.PERCH_PORT || '';
  if (port) return port;

  const instances = listInstances();
  if (instances.length === 0) die('no running instance found - start one with: perch start');
  if (instances.length === 1) return instances[0]!.port;

  if (!interactive()) {
    warn('more than one instance is running; re-run with --port <n>:');
    instances.forEach((i) => info(instanceSummary(i)));
    throw new Exit(1);
  }
  heading('Running instances');
  table(
    [['#', 'PID', 'PORT', 'APP_NAME', 'MANAGED BY'], ...instances.map((i, n) => [String(n + 1), String(i.pid), i.port, i.appName, i.managedBy])],
    [4, 8, 6, 22],
  );
  const choice = await ask(`Use which instance? [1-${instances.length}/q=cancel]: `);
  if (choice === '' || /^q$/i.test(choice)) {
    info('cancelled');
    throw new Exit(0);
  }
  const n = Number(choice);
  if (!Number.isInteger(n) || n < 1 || n > instances.length) die(`invalid choice: ${choice}`);
  return instances[n - 1]!.port;
}

/** Shared by every request: the token header when a gate is configured. */
function headers(extra: Record<string, string> = {}): Record<string, string> {
  const token = readAuthToken();
  return token ? { ...extra, 'x-auth-token': token } : extra;
}

// A failed request carries the server's own `error` message when it sent one —
// "extension not found in registry source" is far more use than "400".
async function fail(res: Response, what: string): Promise<never> {
  let detail = `${res.status}`;
  try {
    const body: unknown = JSON.parse(await res.text());
    if (body && typeof body === 'object' && typeof (body as { error?: unknown }).error === 'string') {
      detail = (body as { error: string }).error;
    }
  } catch {
    // Non-JSON body (a proxy error page, say) — the status is all there is.
  }
  if (res.status === 401 || res.status === 403) {
    die(`${what}: ${detail} - this instance has AUTH_TOKEN set; put the same value in server/.env or the AUTH_TOKEN env var`);
  }
  die(`${what}: ${detail}`);
}

async function send(port: string, path: string, init: RequestInit, what: string): Promise<Response> {
  let res: Response;
  try {
    res = await fetch(`http://127.0.0.1:${port}${path}`, {
      ...init,
      signal: AbortSignal.timeout(60_000),
    });
  } catch {
    die(`couldn't reach the server on port ${port} - is it running? (perch start)`);
  }
  if (!res.ok) await fail(res, what);
  return res;
}

/** GET/POST/DELETE returning parsed JSON, or undefined for a 204. */
export async function apiJson<T>(
  port: string,
  path: string,
  what: string,
  init: RequestInit = {},
): Promise<T> {
  const res = await send(port, path, { ...init, headers: headers(init.headers as Record<string, string>) }, what);
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

/** POST a JSON body. */
export function apiPost<T>(port: string, path: string, body: unknown, what: string): Promise<T> {
  return apiJson<T>(port, path, what, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

/** POST raw bytes — the .perch upload route takes the file as the body. */
export function apiPostBytes<T>(port: string, path: string, body: Uint8Array, what: string): Promise<T> {
  return apiJson<T>(port, path, what, {
    method: 'POST',
    headers: { 'content-type': 'application/octet-stream' },
    body,
  });
}
