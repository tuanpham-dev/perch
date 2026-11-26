import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { cmdRelay, NOTICE, parseExpiry, parseRelayArgs, readFirstLine, resolveSecret, type RelayIO, type SecretDeps } from './relay.ts';
import { Exit, initialSecret, reduceSecret } from './output.ts';
import { Readable } from 'node:stream';

// Argument handling, secret sources and one request per subcommand against a
// stub HTTP server. No relay or Perch instance is involved.

/** Run fn with console output captured; returns what went to stdout and stderr. */
async function capture(fn: () => Promise<unknown>): Promise<{ out: string; err: string; error?: unknown }> {
  const log = console.log;
  const errLog = console.error;
  let out = '';
  let err = '';
  console.log = (...a: unknown[]) => void (out += `${a.join(' ')}\n`);
  console.error = (...a: unknown[]) => void (err += `${a.join(' ')}\n`);
  try {
    await fn();
    return { out, err };
  } catch (error) {
    return { out, err, error };
  } finally {
    console.log = log;
    console.error = errLog;
  }
}

const dies = async (args: string[], pattern: RegExp) => {
  const r = await capture(async () => parseRelayArgs(args));
  assert.ok(r.error instanceof Exit, `expected ${args.join(' ')} to be refused`);
  assert.match(r.out, pattern);
};

test('every subcommand parses', () => {
  assert.equal(parseRelayArgs([]).cmd, 'help');
  assert.equal(parseRelayArgs(['-h']).cmd, 'help');
  assert.equal(parseRelayArgs(['invite', '--help']).cmd, 'help');
  const create = parseRelayArgs(['create', 'wss://r.example', '--name', 'laptop', '--allow-insecure', '--port=3091']);
  assert.deepEqual([create.cmd, create.relayUrl, create.name, create.allowInsecure, create.port], ['create', 'wss://r.example', 'laptop', true, '3091']);
  const join = parseRelayArgs(['join', '--name=desk', '--port', '4000']);
  assert.deepEqual([join.cmd, join.name, join.allowInsecure, join.port], ['join', 'desk', false, '4000']);
  const invite = parseRelayArgs(['invite', '--uses', '3', '--expires', '2h']);
  assert.deepEqual([invite.cmd, invite.uses, invite.expiresMinutes], ['invite', 3, 120]);
  assert.equal(parseRelayArgs(['invite']).uses, undefined);
  assert.equal(parseRelayArgs(['invites']).cmd, 'invites');
  assert.deepEqual([parseRelayArgs(['revoke', 'abc']).cmd, parseRelayArgs(['revoke', 'abc']).id], ['revoke', 'abc']);
  assert.equal(parseRelayArgs(['status']).cmd, 'status');
  assert.equal(parseRelayArgs(['machines']).cmd, 'machines');
  const remove = parseRelayArgs(['remove', 'desk', '--yes']);
  assert.deepEqual([remove.machine, remove.yes], ['desk', true]);
  assert.equal(parseRelayArgs(['remove', 'desk']).yes, false);
  assert.equal(parseRelayArgs(['rename', 'new']).name, 'new');
  assert.equal(parseRelayArgs(['label', 'build', 'box']).text, 'build box');
  assert.equal(parseRelayArgs(['label', '--clear']).clear, true);
  assert.equal(parseRelayArgs(['label']).text, '');
  assert.equal(parseRelayArgs(['permission', 'off']).inbound, 'off');
  assert.equal(parseRelayArgs(['permission', 'read-only']).inbound, 'read');
  assert.equal(parseRelayArgs(['permission', 'send']).inbound, 'send');
  assert.equal(parseRelayArgs(['leave', '-y']).yes, true);
});

test('secrets are never flags', async () => {
  await dies(['join', '--invite', 'perch-relay:abc'], /unknown flag: --invite/);
  await dies(['join', '--invite=perch-relay:abc'], /unknown flag: --invite/);
  await dies(['create', 'wss://r.example', '--admin-secret', 'x'], /unknown flag: --admin-secret/);
  await dies(['create', 'wss://r.example', '--admin-secret=x'], /unknown flag: --admin-secret/);
});

test('bad arguments are refused', async () => {
  await dies(['frobnicate'], /unknown relay command/);
  await dies(['create'], /needs <relay-url>/);
  await dies(['invite', '--name', 'x'], /unknown flag: --name/);
  await dies(['join', '--yes'], /unknown flag: --yes/);
  await dies(['invite', '--uses', '0'], /--uses/);
  await dies(['invite', '--uses', '21'], /--uses/);
  await dies(['invite', '--uses', 'x'], /--uses/);
  await dies(['permission', 'full'], /unknown permission/);
  await dies(['permission'], /needs/);
  await dies(['remove', 'a', 'b'], /unexpected: b/);
  await dies(['label', '--clear', 'x'], /--clear/);
  await dies(['status', '--port'], /--port requires a value/);
});

test('expiry parsing', async () => {
  assert.equal(parseExpiry('10m'), 10);
  assert.equal(parseExpiry('1h'), 60);
  assert.equal(parseExpiry('24h'), 1440);
  assert.equal(parseExpiry('7d'), 10080);
  assert.equal(parseExpiry('90m'), 90);
  assert.equal(parseExpiry('2d'), 2880);
  for (const bad of ['9m', '8d', '169h', '1w', '10', 'h', '-5m', '1.5h', '0d', '']) {
    const r = await capture(async () => parseExpiry(bad));
    assert.ok(r.error instanceof Exit, `${bad} should be refused`);
  }
});

test('a secret comes from the environment, then piped stdin, then the prompt', async () => {
  const deps = (over: Partial<SecretDeps>): SecretDeps => ({
    env: {},
    isTTY: false,
    readStdin: async () => {
      throw new Error('stdin should not be read');
    },
    askSecret: async () => {
      throw new Error('prompt should not be shown');
    },
    ...over,
  });
  // Environment wins, even in a terminal.
  assert.equal(await resolveSecret('S', 'thing', deps({ env: { S: ' from-env ' }, isTTY: true })), 'from-env');
  // Piped: the first line.
  assert.equal(await resolveSecret('S', 'thing', deps({ readStdin: async () => 'from-pipe\nsecond\n' })), 'from-pipe');
  // Terminal: the hidden prompt.
  const asked: string[] = [];
  const v = await resolveSecret('S', 'thing', deps({ isTTY: true, askSecret: async (q) => (asked.push(q), 'typed') }));
  assert.equal(v, 'typed');
  assert.deepEqual(asked, ['thing: ']);
  // Nothing anywhere is an error that names all three ways.
  const r = await capture(() => resolveSecret('S', 'thing', deps({ readStdin: async () => '\n' })));
  assert.ok(r.error instanceof Exit);
  assert.match(r.out, /\$S.*standard input.*terminal/);
});

// ---- subcommands against a stub server ----

interface Seen { method: string; url: string; body: unknown }

async function withStub(
  reply: (req: Seen) => { status?: number; body?: unknown },
  fn: (port: string, seen: Seen[]) => Promise<void>,
): Promise<void> {
  const seen: Seen[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      const entry: Seen = { method: req.method ?? '', url: req.url ?? '', body: raw ? JSON.parse(raw) : undefined };
      seen.push(entry);
      const r = reply(entry);
      res.writeHead(r.status ?? 200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(r.body ?? {}));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    await fn(String((server.address() as AddressInfo).port), seen);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

const BASE = '/api/ext/perch.assistant/relay';
const joinedState = {
  joined: true, relayHost: 'relay.test', connection: 'connected', reason: '', inbound: 'send', readOnlyLimiting: false,
  machine: { name: 'alpha', label: 'build box' },
  machines: [
    { name: 'alpha', self: true, online: true, trust: 'verified', blocked: false, accepts: 'send' },
    { name: 'beta', self: false, online: true, trust: 'verified', blocked: false, accepts: 'read' },
  ],
  invites: [{ id: 'inv1', createdBy: 'alpha', createdAt: 1, expiresAt: 4_000_000_000_000, usesLeft: 2, held: true }],
};
const io = (over: Partial<RelayIO> = {}): RelayIO => ({
  env: {}, isTTY: false, readStdin: async () => '', askSecret: async () => '', confirm: async () => false, ...over,
});

let stubJoined = false;

test('each subcommand hits its route with the right body', async () => {
  stubJoined = false;
  await withStub(
    (req) => ({
      body: req.url.endsWith('/invites') && req.method === 'POST'
        ? { id: 'i', invite: 'perch-relay:INVITE', expiresAt: 4_000_000_000_000 }
        : req.url.endsWith('/state') && !stubJoined ? { joined: false, defaultName: 'hostbox', machines: [], invites: [] } : joinedState,
    }),
    async (port, seen) => {
      const p = ['--port', port];
      const run = (args: string[], over: Partial<RelayIO> = {}) => capture(() => cmdRelay([...args, ...p], io(over)));
      const last = () => seen[seen.length - 1]!;

      let r = await run(['create', 'wss://relay.test', '--name', 'alpha', '--allow-insecure'], { env: { PERCH_RELAY_ADMIN_SECRET: 'adm' } });
      assert.equal(r.error, undefined);
      assert.deepEqual([last().method, last().url, last().body], ['POST', `${BASE}/create`, { relayUrl: 'wss://relay.test', adminSecret: 'adm', name: 'alpha', allowInsecure: true }]);
      assert.ok(r.out.includes(NOTICE));
      assert.ok(r.out.indexOf(NOTICE) < r.out.indexOf('Created'));
      assert.deepEqual([seen[0]!.method, seen[0]!.url], ['GET', `${BASE}/state`]);

      r = await run(['join', '--name', 'beta'], { readStdin: async () => 'perch-relay:XYZ\n' });
      assert.deepEqual([last().method, last().url, last().body], ['POST', `${BASE}/join`, { invite: 'perch-relay:XYZ', name: 'beta', allowInsecure: false }]);
      assert.ok(r.out.includes(NOTICE));

      // Without --name the server's default (the host name) is sent.
      r = await run(['join'], { readStdin: async () => 'perch-relay:XYZ\n' })
      assert.deepEqual(last().body, { invite: 'perch-relay:XYZ', name: 'hostbox', allowInsecure: false })

      stubJoined = true;
      r = await run(['invite', '--uses', '2', '--expires', '1h']);
      assert.deepEqual([last().method, last().url, last().body], ['POST', `${BASE}/invites`, { uses: 2, expiresMinutes: 60 }]);
      assert.equal(r.out, 'perch-relay:INVITE\n');
      assert.match(r.err, /Shown once/);

      await run(['invite']);
      assert.deepEqual(last().body, {});

      r = await run(['invites']);
      assert.deepEqual([last().method, last().url], ['GET', `${BASE}/state`]);
      assert.match(r.out, /inv1\s+alpha\s+2/);

      await run(['revoke', 'inv1']);
      assert.deepEqual([last().method, last().url], ['DELETE', `${BASE}/invites/inv1`]);

      r = await run(['status']);
      assert.deepEqual([last().method, last().url], ['GET', `${BASE}/state`]);
      assert.match(r.out, /relay\.test/);
      assert.match(r.out, /Others may:\s+Read and send/);

      r = await run(['machines']);
      assert.match(r.out, /alpha \(this machine\)\s+online\s+verified\s+read and send/);
      assert.match(r.out, /beta\s+online\s+verified\s+read-only/);

      await run(['remove', 'beta', '--yes']);
      assert.deepEqual([last().method, last().url, last().body], ['POST', `${BASE}/remove`, { machine: 'beta' }]);

      await run(['rename', 'gamma']);
      assert.deepEqual([last().url, last().body], [`${BASE}/rename`, { name: 'gamma' }]);

      await run(['label', 'my', 'label']);
      assert.deepEqual([last().url, last().body], [`${BASE}/label`, { label: 'my label' }]);
      await run(['label', '--clear']);
      assert.deepEqual([last().url, last().body], [`${BASE}/label`, { label: '' }]);
      r = await run(['label']);
      assert.deepEqual([last().method, last().url], ['GET', `${BASE}/state`]);
      assert.equal(r.out, 'build box\n');

      for (const [word, wire] of [['off', 'off'], ['read-only', 'read'], ['send', 'send']]) {
        await run(['permission', word!]);
        assert.deepEqual([last().url, last().body], [`${BASE}/permission`, { inbound: wire }]);
      }

      await run(['leave', '--yes']);
      assert.deepEqual([last().method, last().url], ['POST', `${BASE}/leave`]);

      // --allow-insecure warns on stderr before the request goes out.
      stubJoined = false;
      r = await run(['join', '--name', 'beta', '--allow-insecure'], { readStdin: async () => 'perch-relay:XYZ\n' });
      assert.match(r.err, /Secrets will cross the network unprotected\./);
      r = await run(['join', '--name', 'beta'], { readStdin: async () => 'perch-relay:XYZ\n' });
      assert.ok(!/unprotected/.test(r.err));
    },
  );
});

test('remove and leave do not act without --yes when nothing can ask', async () => {
  await withStub(() => ({}), async (port, seen) => {
    for (const args of [['remove', 'beta'], ['leave']]) {
      const r = await capture(() => cmdRelay([...args, '--port', port], io()));
      assert.ok(r.error instanceof Exit);
      assert.match(r.out, /--yes/);
    }
    assert.equal(seen.length, 0);
  });
});

test('a server error is shown as the server worded it', async () => {
  await withStub(() => ({ status: 409, body: { error: 'This Perch is not in a relay group.' } }), async (port) => {
    const r = await capture(() => cmdRelay(['leave', '--yes', '--port', port], io()));
    assert.ok(r.error instanceof Exit);
    assert.match(r.out, /relay leave: This Perch is not in a relay group\./);
  });
});

test('status when not in a group', async () => {
  await withStub(() => ({ body: { joined: false, machines: [], invites: [] } }), async (port) => {
    const r = await capture(() => cmdRelay(['status', '--port', port], io()));
    assert.match(r.out, /not in a relay group/);
  });
});

// ---- fixes T6.F1-F5 ----

const notJoined = { joined: false, machines: [], invites: [] };
const NOT_IN_GROUP = /This Perch is not in a relay group\. Join one in Settings → Assistant → Relay or with: perch relay join/;

test('a surplus word is never echoed', async () => {
  for (const args of [['join', 'perch-invite:1:abc'], ['create', 'wss://r', 'hunter2']]) {
    const r = await capture(async () => parseRelayArgs(args));
    assert.ok(r.error instanceof Exit);
    assert.match(r.out, /not taken as an argument/);
    assert.ok(!r.out.includes('perch-invite') && !r.out.includes('hunter2') && !r.out.includes('abc'));
  }
});

test('create and join: state first, notice, then the secret, then the request', async () => {
  await withStub((req) => ({ body: req.method === 'GET' ? notJoined : joinedState }), async (port, seen) => {
    const events: string[] = [];
    const log = console.log;
    const r = await capture(() =>
      cmdRelay(['join', '--port', port], io({
        readStdin: async () => (events.push(`read after ${seen.length} request(s)`), 'perch-relay:X'),
      })),
    );
    void log;
    assert.equal(r.error, undefined);
    assert.deepEqual(events, ['read after 1 request(s)']);
    assert.ok(r.out.includes(NOTICE));
    assert.match(r.err, /Reading the invite from standard input…/);
    assert.deepEqual(seen.map((x) => x.method), ['GET', 'POST']);
  });
  const secretNeverRead = io({ readStdin: async () => { throw new Error('read'); }, askSecret: async () => { throw new Error('asked'); } });
  await withStub(() => ({ body: joinedState }), async (port, seen) => {
    for (const args of [['join'], ['create', 'wss://r']]) {
      const r = await capture(() => cmdRelay([...args, '--port', port], secretNeverRead));
      assert.ok(r.error instanceof Exit, args.join(' '));
      assert.match(r.out, /already in a relay group/);
      assert.ok(!r.out.includes(NOTICE));
    }
    assert.ok(seen.every((x) => x.method === 'GET'));
  });
  await withStub(() => ({ status: 404, body: { error: 'extension not found or has no active server hook' } }), async (port) => {
    const r = await capture(() => cmdRelay(['join', '--port', port], secretNeverRead));
    assert.ok(r.error instanceof Exit);
    assert.match(r.out, /extension is disabled/);
  });
  await withStub(() => ({ body: { available: false, reason: 'The relay needs Perch 0.9 or later.' } }), async (port) => {
    const r = await capture(() => cmdRelay(['create', 'wss://r', '--port', port], secretNeverRead));
    assert.ok(r.error instanceof Exit);
    assert.match(r.out, /no relay support/);
  });
});

test('404 wording depends on the body', async () => {
  await withStub(() => ({ status: 404, body: { error: 'extension not found or has no active server hook' } }), async (port) => {
    const r = await capture(() => cmdRelay(['status', '--port', port], io()));
    assert.match(r.out, /Assistant extension is disabled - enable it in Settings → Extensions/);
  });
  await withStub(() => ({ status: 404, body: { error: 'not found' } }), async (port) => {
    const r = await capture(() => cmdRelay(['status', '--port', port], io()));
    assert.match(r.out, /no relay support; update or restart Perch\./);
    assert.ok(!/disabled/.test(r.out));
  });
});

test('a slow server gets its own message', async () => {
  const server = createServer(() => {});
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const port = String((server.address() as AddressInfo).port);
    const r = await capture(() => cmdRelay(['status', '--port', port], io({ timeoutMs: 100 })));
    assert.ok(r.error instanceof Exit);
    assert.match(r.out, /The server did not answer in time; check `perch relay status`\./);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});

test('empty, . and .. ids are rejected', async () => {
  for (const id of ['', '.', '..']) {
    await dies(['revoke', id], /needs/);
    await dies(['remove', id], /needs/);
  }
});

test('remove and leave confirm on a terminal', async () => {
  await withStub(() => ({ body: joinedState }), async (port, seen) => {
    const asked: string[] = [];
    let r = await capture(() => cmdRelay(['remove', 'beta', '--port', port], io({ isTTY: true, confirm: async (q) => (asked.push(q), true) })));
    assert.equal(r.error, undefined);
    assert.equal(asked.length, 1);
    assert.deepEqual([seen[0]!.method, seen[0]!.url], ['POST', `${BASE}/remove`]);
    seen.length = 0;
    for (const args of [['remove', 'beta'], ['leave']]) {
      r = await capture(() => cmdRelay([...args, '--port', port], io({ isTTY: true, confirm: async () => false })));
      assert.ok(r.error instanceof Exit);
      assert.equal((r.error as Exit).code, 0);
      assert.match(r.out, /cancelled/);
    }
    assert.equal(seen.length, 0);
  });
});

test('a stdin that sends one line and never closes resolves with it', async () => {
  const stream = new Readable({ read() {} });
  stream.push('first line\nrest');
  assert.equal(await readFirstLine(stream), 'first line');
  stream.destroy();
  const big = new Readable({ read() {} });
  big.push('x'.repeat(20000));
  assert.equal((await readFirstLine(big)).length, 8192);
  big.destroy();
});

test('machines, invites and bare label say not in a group and exit 1; status exits 0', async () => {
  await withStub(() => ({ body: notJoined }), async (port) => {
    for (const args of [['machines'], ['invites'], ['label']]) {
      const r = await capture(() => cmdRelay([...args, '--port', port], io()));
      assert.ok(r.error instanceof Exit, args.join(' '));
      assert.equal((r.error as Exit).code, 1);
      assert.match(r.out, NOT_IN_GROUP);
    }
    const r = await capture(() => cmdRelay(['status', '--port', port], io()));
    assert.equal(r.error, undefined);
  });
});

test('hidden prompt keystrokes', () => {
  const run = (...chunks: string[]) => chunks.reduce(reduceSecret, initialSecret());
  assert.deepEqual(run('abc\r'), { value: 'abc', esc: '', done: 'enter' });
  assert.equal(run('pasted-secret-value').value, 'pasted-secret-value');
  assert.equal(run('abcd\x7f\x7f').value, 'ab');
  assert.equal(run('ab\x03').done, 'interrupt');
  const eof = run('ab\x04cd');
  assert.deepEqual([eof.done, eof.value], ['eof', 'ab']);
  assert.equal(run('a\x1b[Ab\x1b[1;5Cc\x1bOPd').value, 'abcd');
  assert.equal(run('a\x1b', '[', 'Ab').value, 'ab');
});

test('leave says the relay entry remains when the relay could not be reached', async () => {
  for (const [body, remains] of [[{ relayEntryRemoved: false }, true], [{ relayEntryRemoved: true }, false], [{}, false]] as const) {
    await withStub(() => ({ body }), async (port) => {
      const r = await capture(() => cmdRelay(['leave', '--yes', '--port', port], io()));
      assert.equal(r.error, undefined);
      const text = "Left the group here. The relay could not be reached, so this machine's entry is still on the relay; ask a member to remove it.";
      assert.equal(r.out.includes(text), remains, JSON.stringify(body));
    });
  }
});

test('status on a machine that was removed says by whom, then the not-in-group lines', async () => {
  await withStub(() => ({ body: { joined: false, machines: [], invites: [], removedBy: { by: 'laptop', at: 1 } } }), async (port) => {
    const r = await capture(() => cmdRelay(['status', '--port', port], io()));
    assert.equal(r.error, undefined);
    assert.match(r.out, /^Removed from the group by laptop\.\nThis Perch is not in a relay group\./);
  });
});
