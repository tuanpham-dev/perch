import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fakeClock, startTestRelay } from '../../../relay/test/helpers.mjs'
import { fakeHost } from '../test/fakeHost.mjs'
import { startRig, until } from '../test/relayRig.mjs'
import { LinkError } from './link.mjs'
import { createRemoteTools, NOT_IN_GROUP } from './remoteTools.mjs'

class ToolError extends Error {}

// ---- Messages rows, against a stub link ----

function stub({ machines, joined = true, callImpl, reasonCode = '', connected = true, resolveWindow, sendText }) {
  const calls = []
  const link = {
    snapshot: () => ({ machines }),
    call: async (id, tool, args, opts) => {
      calls.push({ id, tool, args, opts })
      return callImpl(id, tool, args, opts)
    },
    reasonCode,
    connected,
  }
  const membership = { joined, state: { name: 'alpha', inbound: 'send' }, identity: { machineId: 'a' } }
  const rt = createRemoteTools({
    link,
    membership,
    runLocalTool: async () => ({ content: [], isError: false }),
    callerTerminal: async (id) => (id === 'w9' ? { session: 'web', index: 2 } : null),
    resolveWindow: resolveWindow ?? (async () => ({})),
    sendText: sendText ?? (async () => {}),
    markSent: () => {},
    ToolError,
  })
  return { rt, calls, membership }
}
const dir = [
  { id: 'a', display: 'alpha', self: true, online: true, lastSeen: null, trust: 'verified', accepts: 'send' },
  { id: 'b', display: 'bravo', self: false, online: true, lastSeen: Date.UTC(2026, 10, 1, 12, 0, 0), trust: 'verified', accepts: 'read' },
]
const fails = async (p, text) => assert.rejects(p, (e) => e instanceof ToolError && e.message === text)

test('every outbound failure has its exact Messages text', async () => {
  const run = async (err, name = 'bravo') => {
    const { rt } = stub({ machines: dir, callImpl: async () => Promise.reject(err) })
    return rt.callRemote(name, 'list_projects', {}, {})
  }
  await fails(run(null, 'bravx'), 'No machine named "bravx" in this group. Machines: alpha, bravo.')
  await fails(run(new LinkError('offline', 'x', { machine: 'b', lastSeen: Date.UTC(2026, 10, 1, 12, 0, 0) })), 'bravo is offline (last seen 2026-11-01T12:00:00.000Z).')
  await fails(run(new LinkError('unverified', 'x', { machine: 'b' })), 'bravo is not verified, so Perch will not talk to it. Remove it and invite it again.')
  await fails(run(new LinkError('not-connected', 'This machine is not connected to the relay right now (could not reach the relay).')), 'This machine is not connected to the relay right now (could not reach the relay).')
  await fails(run(new LinkError('no-answer', 'x', { machine: 'b', seconds: 30 })), 'bravo did not answer within 30 seconds.')
  await fails(run(new LinkError('too-large', 'The result is larger than 8 MB.', { machine: 'b' })), 'The result from bravo is larger than 8 MB. Ask for fewer messages or less scrollback.')
  await fails(run(new LinkError('version', 'x', { older: 'peer', machine: 'b' })), 'bravo runs a Perch that is too old to talk to this one. Update bravo.')
  await fails(run(new LinkError('version', 'x', { older: 'self', machine: 'b' })), 'bravo runs a Perch that is too new to talk to this one. Update this machine.')
  await fails(run(new LinkError('not-in-group', 'x')), NOT_IN_GROUP)
  const { rt } = stub({ machines: dir, callImpl: async () => Promise.reject(new LinkError('not-connected', 'x')), reasonCode: 'already-connected', connected: false })
  await fails(rt.callRemote('bravo', 'list_projects', {}, {}), 'This machine is already connected to the relay from another Perch instance that shares its configuration folder.')
  await fails(stub({ machines: dir, joined: false, callImpl: async () => null }).rt.callRemote('bravo', 'list_projects', {}, {}), NOT_IN_GROUP)
})

test('timeouts: 30 s, or the wait plus 30 s; the sender window is project:index or null; a peer refusal passes through', async () => {
  const refusal = { content: [{ type: 'text', text: 'bravo does not accept read_terminal from other machines (its setting is off).' }], isError: true }
  const { rt, calls } = stub({ machines: dir, callImpl: async () => refusal })
  assert.deepEqual(await rt.callRemote('bravo', 'read_terminal', { target: 'x' }, {}), refusal)
  await rt.callRemote('bravo', 'wait_for_agent', { target: 'x', timeoutSeconds: 90 }, { callerWindow: 'w9' })
  await rt.callRemote('bravo', 'wait_for_agent', { target: 'x' }, { callerWindow: 'nope' })
  await rt.callRemote('bravo', 'wait_for_agent', { target: 'x', timeoutSeconds: 9999 }, {})
  assert.deepEqual(calls.map((c) => [c.opts.timeoutMs, c.opts.senderWindow]), [
    [30000, null],
    [120000, 'web:2'],
    [150000, null],
    [630000, null],
  ])
})

test('list_machines on a stub: not in a group is a plain string, already-connected is an error', async () => {
  assert.equal(stub({ machines: [], joined: false, callImpl: async () => null }).rt.listMachines(), NOT_IN_GROUP)
  const { rt } = stub({ machines: dir, callImpl: async () => null, reasonCode: 'already-connected', connected: false })
  assert.throws(() => rt.listMachines(), (e) => e instanceof ToolError && /already connected to the relay from another Perch instance/.test(e.message))
})

// ---- two real hosts through a test relay ----

let counter = 0
const win = (id, index, name, command) => ({ id, index, name, command, cwd: '/w/web', active: index === 0 })
function bravoFixture() {
  return fakeHost({
    sessions: [{ name: 'web', path: '/w/web', windows: [win('w1', 0, 'zsh', 'zsh'), win('w2', 1, 'claude', 'claude')] }],
    agents: { web: [{ windowId: 'w2', windowIndex: 1, label: 'Claude Code', program: 'claude', cwd: '/w/web' }] },
  })
}
async function startHost(fh) {
  const mod = await import(`../server.js?remote=${++counter}`)
  mod.activate({ router: fh.router, host: fh.host, getSettings: fh.getSettings, log: fh.log, secrets: fh.secrets, storage: fh.storage })
  return {
    fh,
    mod,
    post: async (path, body) => (await fh.request('POST', path, body)).body,
    get: async (path) => (await fh.request('GET', path)).body,
    call: async (name, args = {}, callerWindow = null) => (await fh.request('POST', '/call', { name, arguments: args, callerWindow })).body,
  }
}
const textOf = (r) => r.content[0].text

async function duo() {
  const relay = await startTestRelay()
  const a = await startHost(fakeHost({ sessions: [{ name: 'api', path: '/w/api', windows: [win('a1', 0, 'zsh', 'zsh')] }] }))
  const b = await startHost(bravoFixture())
  await a.post('/relay/create', { relayUrl: relay.url, adminSecret: 'admin-secret-for-tests', name: 'alpha', allowInsecure: true })
  await until(async () => (await a.get('/relay/state')).connection === 'connected', 3000, 'alpha connected')
  const { invite } = await a.post('/relay/invites', { uses: 1, expiresMinutes: 30 })
  await b.post('/relay/join', { invite, name: 'bravo', allowInsecure: true })
  const verified = (h, n) => async () => (await h.get('/relay/state')).machines.find((m) => m.name === n)?.trust === 'verified'
  await until(verified(a, 'bravo'), 5000, 'alpha verifies bravo')
  await until(verified(b, 'alpha'), 5000, 'bravo verifies alpha')
  return { relay, a, b, close: async () => (a.mod.deactivate(), b.mod.deactivate(), await relay.close()) }
}

test('machine runs the six tools on the other machine; list_machines before and after it stops; offline and unknown errors', async () => {
  const t = await duo()
  try {
    const { a, b } = t
    const remote = await a.call('list_projects', { machine: 'bravo' })
    assert.equal(remote.isError, false)
    assert.deepEqual(remote, await b.call('list_projects'))
    assert.deepEqual(await a.call('list_projects', { machine: 'alpha' }), await a.call('list_projects'))
    assert.deepEqual(await a.call('read_terminal', { machine: 'bravo', target: 'web:1' }), await b.call('read_terminal', { target: 'web:1' }))
    assert.equal(textOf(await a.call('agent_status', { machine: 'nobody' })), 'No machine named "nobody" in this group. Machines: alpha, bravo.')

    const listed = JSON.parse(textOf(await a.call('list_machines')))
    assert.deepEqual(listed.map((m) => [m.name, m.thisMachine, m.online, m.verified, m.accepts]), [
      ['alpha', true, true, true, 'read and send'],
      ['bravo', false, true, true, 'read and send'],
    ])
    await b.post('/relay/permission', { inbound: 'read' })
    await until(async () => JSON.parse(textOf(await a.call('list_machines')))[1].accepts === 'read-only', 5000, 'accepts follows')

    b.mod.deactivate()
    await until(async () => JSON.parse(textOf(await a.call('list_machines')))[1].online === false, 8000, 'bravo offline')
    const after = JSON.parse(textOf(await a.call('list_machines')))
    assert.equal(after[1].accepts, 'read-only')
    assert.match(after[1].lastSeen, /^\d{4}-\d\d-\d\dT/)
    const offline = await a.call('list_projects', { machine: 'bravo' })
    assert.equal(offline.isError, true)
    assert.match(textOf(offline), /^bravo is offline \(last seen \d{4}-\d\d-\d\dT[\d:.]+Z\)\.$/)
  } finally {
    await t.close()
  }
})

test('send_to_agent to another machine adds the replies-refused sentence when this machine is not Read and send', async () => {
  const t = await duo()
  try {
    const { a, b } = t
    assert.equal(textOf(await a.call('send_to_agent', { machine: 'bravo', target: 'web', text: 'hi' })), 'Typed into web:1 (claude) and pressed Enter.')
    await a.post('/relay/permission', { inbound: 'read' })
    assert.equal(
      textOf(await a.call('send_to_agent', { machine: 'bravo', target: 'web', text: 'hi' })),
      'Typed into web:1 (claude) and pressed Enter. Replies from that agent will be refused here: this machine\'s "Others may" setting is Read-only.',
    )
    await a.post('/relay/permission', { inbound: 'off' })
    assert.equal(
      textOf(await a.call('send_to_agent', { machine: 'bravo', target: 'web', text: 'hi' })),
      'Typed into web:1 (claude) and pressed Enter. Replies from that agent will be refused here: this machine\'s "Others may" setting is Off.',
    )
    assert.equal(b.fh.host.calls.sendTextToWindow.length, 3)
  } finally {
    await t.close()
  }
})

// ---- T4.F1: offline without a time ----

test('an offline error that carries no time takes one from the directory, else from when the call began', async () => {
  const run = async (machines) => {
    const { rt } = stub({ machines, callImpl: async () => Promise.reject(new LinkError('offline', 'x', { machine: 'b' })) })
    return rt.callRemote('bravo', 'list_projects', {}, {})
  }
  await fails(run(dir), 'bravo is offline (last seen 2026-11-01T12:00:00.000Z).')
  await assert.rejects(run(dir.map((m) => (m.id === 'b' ? { ...m, lastSeen: null } : m))), (e) => /^bravo is offline \(last seen \d{4}-\d\d-\d\dT[\d:.]+Z\)\.$/.test(e.message))
})

test('stopping the peer during wait_for_agent gives an offline error with a real time', async () => {
  const t = await duo()
  try {
    const waiting = t.a.call('wait_for_agent', { machine: 'bravo', target: 'web:1', timeoutSeconds: 60 })
    await new Promise((r) => setTimeout(r, 300))
    t.b.mod.deactivate()
    const out = await waiting
    assert.equal(out.isError, true)
    assert.match(textOf(out), /^bravo is offline \(last seen \d{4}-\d\d-\d\dT[\d:.]+Z\)\.$/)
  } finally {
    await t.close()
  }
})

// ---- T8.F4: the already-connected text comes from a real link ----

test('a second host on the same configuration gets the exact Already connected text, and local tools still work', async () => {
  const relay = await startTestRelay()
  const a = await startHost(bravoFixture())
  // Same configuration folder: the same secrets and the same database, a second Perch instance.
  const fh2 = fakeHost({ sessions: [{ name: 'web', path: '/w/web', windows: [win('w1', 0, 'zsh', 'zsh')] }], db: a.fh.db })
  fh2.secrets = a.fh.secrets
  let b
  let c
  try {
    await a.post('/relay/create', { relayUrl: relay.url, adminSecret: 'admin-secret-for-tests', name: 'alpha', allowInsecure: true })
    await until(async () => (await a.get('/relay/state')).connection === 'connected', 3000, 'alpha connected')
    const { invite } = await a.post('/relay/invites', { uses: 1, expiresMinutes: 30 })
    c = await startHost(bravoFixture())
    await c.post('/relay/join', { invite, name: 'bravo', allowInsecure: true })
    await until(async () => (await a.get('/relay/state')).machines.find((m) => m.name === 'bravo')?.trust === 'verified', 5000, 'alpha verifies bravo')
    b = await startHost(fh2)
    await until(async () => (await b.get('/relay/state')).reasonCode === 'already-connected' || /already connected/i.test(JSON.stringify(await b.get('/relay/state'))), 5000, 'second host refused')
    const text = 'This machine is already connected to the relay from another Perch instance that shares its configuration folder.'
    const listed = await b.call('list_machines')
    assert.equal(listed.isError, true)
    assert.equal(textOf(listed), text)
    const remote = await b.call('list_projects', { machine: 'bravo' })
    assert.equal(remote.isError, true)
    assert.equal(textOf(remote), text)
    const local = await b.call('list_projects')
    assert.equal(local.isError, false)
  } finally {
    a.mod.deactivate()
    b?.mod.deactivate()
    c?.mod.deactivate()
    await relay.close()
  }
})

// ---- T4.F3: the machine's own address ----

test('with two machines named alpha, only alpha~xxxx is this machine', async () => {
  const machines = [
    { id: 'a1a1', display: 'alpha~a1a1', self: true, online: true, lastSeen: null, trust: 'verified', accepts: 'send' },
    { id: 'b2b2', display: 'alpha~b2b2', self: false, online: true, lastSeen: null, trust: 'verified', accepts: 'send' },
    { id: 'c3c3', display: 'bravo', self: false, online: true, lastSeen: null, trust: 'verified', accepts: 'send' },
  ]
  const typed = []
  const { rt, calls, membership } = stub({
    machines,
    callImpl: async () => ({ content: [{ type: 'text', text: 'ok' }], isError: false }),
    resolveWindow: async () => ({ session: { name: 'api' }, window: { id: 'w1', index: 0, name: 'claude' }, agent: { program: 'claude' } }),
    sendText: async (id, text) => void typed.push(text),
  })
  membership.identity = { machineId: 'a1a1' }
  assert.equal(rt.isSelf('alpha~a1a1'), true)
  assert.equal(rt.isSelf('alpha'), false)
  assert.equal(rt.isSelf('alpha~b2b2'), false)
  await fails(rt.callRemote('alpha', 'list_projects', {}, {}), 'No machine named "alpha" in this group. Machines: alpha~a1a1, alpha~b2b2, bravo.')
  assert.equal(await rt.replyToAgent({ text: 'hi', to: 'alpha~a1a1/x:1' }, {}), 'Sent to alpha~a1a1/x:1.')
  assert.equal(typed.length, 1)
  assert.match(typed[0], /^\[Perch message from an agent on alpha~a1a1\./)
  assert.equal(calls.length, 0)
})

// ---- T4.F4: peer results Perch cannot show ----

test('a peer result with no usable text item is a tool error; usable items are kept and trimmed', async () => {
  for (const content of [[null], [{ type: 'text', text: 5 }], [{ type: 'image' }], []]) {
    const { rt } = stub({ machines: dir, callImpl: async () => ({ content, isError: false }) })
    await fails(rt.callRemote('bravo', 'list_projects', {}, {}), 'bravo sent a result Perch cannot show.')
  }
  const { rt } = stub({ machines: dir, callImpl: async () => ({ content: [null, { type: 'text', text: 'a', extra: 1 }, { type: 'image' }], isError: true }) })
  assert.deepEqual(await rt.callRemote('bravo', 'list_projects', {}, {}), { content: [{ type: 'text', text: 'a' }], isError: true })
})

test('an outbound request over 8 MB is told apart by its direction, not its wording', async () => {
  const run = (opts) => stub({ machines: dir, callImpl: async () => Promise.reject(new LinkError('too-large', 'worded differently', { machine: 'b', ...opts })) }).rt.callRemote('bravo', 'list_projects', {}, {})
  await fails(run({ direction: 'out' }), 'The request to bravo is larger than 8 MB.')
  await fails(run({ direction: 'in' }), 'The result from bravo is larger than 8 MB. Ask for fewer messages or less scrollback.')
})

test('over a real session, bad peer results are tool errors and /call still answers', async () => {
  const relay = await startTestRelay()
  const a = await startHost(fakeHost({ sessions: [] }))
  let probe
  try {
    await a.post('/relay/create', { relayUrl: relay.url, adminSecret: 'admin-secret-for-tests', name: 'alpha', allowInsecure: true })
    await until(async () => (await a.get('/relay/state')).connection === 'connected', 3000, 'alpha connected')
    const { makeNode } = await import('../test/relayRig.mjs')
    probe = makeNode('probe', relay.url)
    const { invite } = await a.post('/relay/invites', { uses: 1, expiresMinutes: 30 })
    await probe.link.join({ invite, name: 'probe', allowInsecure: true })
    await probe.waitVerified('alpha')
    await until(async () => (await a.get('/relay/state')).machines.find((m) => m.name === 'probe')?.trust === 'verified', 5000, 'alpha verifies probe')
    for (const content of [[null], [{ type: 'text', text: 5 }], [{ type: 'image' }]]) {
      probe.onCall = (_peer, _msg, respond) => respond({ content, isError: false })
      const out = await a.call('list_projects', { machine: 'probe' })
      assert.deepEqual(out, { content: [{ type: 'text', text: 'probe sent a result Perch cannot show.' }], isError: true })
    }
  } finally {
    probe?.link.close()
    a.mod.deactivate()
    await relay.close()
  }
})

// ---- T4.F5: the whole call, handshake included, is bounded ----

test('a peer that never answers the handshake fails at 30 seconds, naming 30 seconds', async () => {
  let drop = false
  const hooks = { onForward: (frame) => (drop && frame.k === 'hs2' ? null : undefined) }
  const rig = await startRig({ hooks })
  try {
    const clock = fakeClock(Date.now())
    const a = await rig.creator('alpha', { clock })
    await rig.joiner(a, 'bravo')
    await a.waitOnline('bravo')
    drop = true
    const rt = createRemoteTools({
      link: a.link,
      membership: a.membership,
      runLocalTool: async () => ({ content: [], isError: false }),
      callerTerminal: async () => null,
      resolveWindow: async () => ({}),
      sendText: async () => {},
      markSent: () => {},
      ToolError,
    })
    let outcome = null
    rt.callRemote('bravo', 'list_projects', {}, {}).then(
      () => (outcome = 'ok'),
      (e) => (outcome = e.message),
    )
    await new Promise((r) => setTimeout(r, 200))
    clock.tick(15000)
    await new Promise((r) => setTimeout(r, 100))
    assert.equal(outcome, null, 'still waiting after 15 seconds')
    clock.tick(15000)
    await until(() => outcome !== null, 2000, 'call ended')
    assert.equal(outcome, 'bravo did not answer within 30 seconds.')
  } finally {
    await rig.close()
  }
})

// ---- T8.F3: activity rows do not repeat the machine name ----

test('membership event rows leave the machine name to its own column; a rename row says from and to', async () => {
  const { DatabaseSync } = await import('node:sqlite')
  const sql = new DatabaseSync(':memory:')
  const link = { snapshot: () => ({ machines: [] }), connected: true, reasonCode: '' }
  const membership = { joined: true, state: { name: 'alpha', inbound: 'send' }, identity: { machineId: 'a' } }
  const rt = createRemoteTools({ link, membership, runLocalTool: async () => ({}), callerTerminal: async () => null, resolveWindow: async () => ({}), sendText: async () => {}, markSent: () => {}, sql, ToolError })
  rt.recordEvent({ kind: 'joined', name: 'buildbox', by: 'laptop' })
  rt.recordEvent({ kind: 'removed', name: 'buildbox', by: 'laptop' })
  rt.recordEvent({ kind: 'left', by: 'buildbox' })
  rt.recordEvent({ kind: 'renamed', by: 'old', name: 'new', to: 'new' }) // this machine
  rt.recordEvent({ kind: 'renamed', by: 'peer-sender', name: 'old2', to: 'new2' }) // a peer
  const rows = sql.prepare('SELECT machine, event FROM relay_activity ORDER BY id').all().map((r) => [r.machine, r.event])
  assert.deepEqual(rows, [
    ['buildbox', 'joined, admitted by laptop'],
    ['buildbox', 'removed by laptop'],
    ['buildbox', 'left the group'],
    ['new', 'renamed from old to new'],
    ['new2', 'renamed from old2 to new2'],
  ])
})
