import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { callServer } from './mcp.ts';

// callServer: the tool-call request of `perch mcp`. A call may hold for ten
// minutes, so nothing but its own timeout may end it (Node's fetch gives up
// after 300 s without response headers).

async function withServer(delayMs: number, fn: (url: string, seen: { auth?: string; body: string }) => Promise<void>): Promise<void> {
  const seen = { auth: undefined as string | undefined, body: '' };
  const server = createServer((req, res) => {
    seen.auth = req.headers['x-auth-token'] as string | undefined;
    req.on('data', (c: Buffer) => (seen.body += c));
    req.on('end', () =>
      setTimeout(() => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ content: [{ type: 'text', text: 'late' }], isError: false }));
      }, delayMs),
    );
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  try {
    await fn(`http://127.0.0.1:${(server.address() as AddressInfo).port}/call`, seen);
  } finally {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  }
}

test('a slow answer succeeds, with the auth header and body sent', async () => {
  await withServer(300, async (url, seen) => {
    const res = await callServer(url, { 'content-type': 'application/json', 'x-auth-token': 'tok' }, '{"name":"x"}', 5000);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { content: [{ type: 'text', text: 'late' }], isError: false });
    assert.equal(seen.auth, 'tok');
    assert.equal(seen.body, '{"name":"x"}');
  });
});

test('its own timeout ends a call that never answers, as a TimeoutError', async () => {
  await withServer(5000, async (url) => {
    await assert.rejects(callServer(url, {}, '{}', 200), (e: Error) => e.name === 'TimeoutError');
  });
});

test('an unreachable server rejects without a TimeoutError', async () => {
  await assert.rejects(callServer('http://127.0.0.1:1/call', {}, '{}', 2000), (e: Error) => e.name !== 'TimeoutError');
});

// 310 s is past fetch's 300 s header timeout. Slow: PERCH_SLOW_TESTS=1.
test('an answer 310 s after the request still arrives', { skip: process.env.PERCH_SLOW_TESTS ? false : 'set PERCH_SLOW_TESTS=1', timeout: 340_000 }, async () => {
  await withServer(310_000, async (url) => {
    const res = await callServer(url, {}, '{}', 330_000);
    assert.equal(res.status, 200);
  });
});
