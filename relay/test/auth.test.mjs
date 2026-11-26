import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, test } from 'node:test'
import {
  ADMIN,
  connect,
  connectMember,
  createGroup,
  fakeClock,
  helloFrame,
  joinAsMember,
  newKeys,
  signText,
  startTestRelay,
} from './helpers.mjs'
import { challengeString } from '../src/wire.mjs'

let relay
afterEach(async () => {
  await relay?.close()
  relay = null
})

async function createWith(secret, keys = newKeys()) {
  const c = await connect(relay)
  c.send(helloFrame(keys, { auth: 'create', adminSecret: secret, signPub: keys.signPub, dhPub: keys.dhPub }))
  return c
}

test('create: right admin secret makes a group and welcomes its first machine', async () => {
  relay = await startTestRelay()
  const { welcome, directory, keys, client } = await createGroup(relay, { label: 'rack' })
  assert.equal(welcome.epoch, 1)
  assert.equal(welcome.v, 1)
  assert.match(welcome.groupId, /^[0-9a-f]{32}$/)
  assert.equal(directory.machines.length, 1)
  const me = directory.machines[0]
  assert.deepEqual([me.id, me.signPub, me.dhPub, me.label, me.online, me.blocked], [keys.machineId, keys.signPub, keys.dhPub, 'rack', true, false])
  assert.ok(me.conn > 0)
  client.ws.terminate()
})

test('create: wrong admin secret is refused and closed', async () => {
  relay = await startTestRelay()
  const c = await createWith('wrong')
  const e = await c.until('error')
  assert.equal(e.code, 'admin-secret')
  await c.closedPromise
})

test('create: an unconfigured admin secret refuses with the explaining message', async () => {
  relay = await startTestRelay({ env: { RELAY_ADMIN_SECRET: '' } })
  const c = await createWith('anything')
  const e = await c.until('error')
  assert.equal(e.code, 'admin-secret')
  assert.equal(e.message, 'this relay has no admin secret, so groups cannot be created')
  await c.closedPromise
  const c2 = await createWith('')
  assert.equal((await c2.until('error')).code, 'admin-secret')
})

test('machine-key: a signed challenge gets welcome and directory', async () => {
  relay = await startTestRelay()
  const first = await createGroup(relay)
  const second = newKeys()
  // Join as a second member through the store-free path: another created machine is not possible,
  // so reconnect the first one.
  first.client.ws.terminate()
  await first.client.closedPromise
  const again = await joinAsMember(relay, first.groupId, first.keys)
  assert.equal(again.welcome.groupId, first.groupId)
  assert.equal(again.welcome.v, 1)
  assert.equal(again.directory.machines[0].conn, first.directory.machines[0].conn + 1)
  void second
  again.client.ws.terminate()
})

test('machine-key: the relay always sends a challenge, even for an unknown machine', async () => {
  relay = await startTestRelay()
  const { groupId, client } = await createGroup(relay)
  const stranger = newKeys()
  const c = await connectMember(relay, 'nonexistent-group', stranger)
  const e = await c.until('error')
  assert.equal(e.code, 'credential')
  const c2 = await connect(relay)
  c2.send(helloFrame(stranger, { groupId }))
  assert.ok(await c2.until('challenge'))
  client.ws.terminate()
})

test('machine-key: a signature by the wrong key is refused', async () => {
  relay = await startTestRelay()
  const { groupId, keys, client } = await createGroup(relay)
  const other = newKeys()
  const c = await connect(relay)
  c.send(helloFrame(keys, { groupId }))
  const ch = await c.until('challenge')
  c.send({ t: 'prove', sig: signText(other.signPriv, challengeString(ch.nonce, groupId, keys.machineId)) })
  assert.equal((await c.until('error')).code, 'credential')
  // A signature over another nonce is refused too.
  const c2 = await connect(relay)
  c2.send(helloFrame(keys, { groupId }))
  await c2.until('challenge')
  c2.send({ t: 'prove', sig: signText(keys.signPriv, challengeString('old-nonce', groupId, keys.machineId)) })
  assert.equal((await c2.until('error')).code, 'credential')
  client.ws.terminate()
})

test('six bad credentials in a minute: the sixth is refused with the limit named', async () => {
  relay = await startTestRelay()
  const { groupId, client } = await createGroup(relay)
  const codes = []
  for (let i = 0; i < 6; i++) {
    const c = await connectMember(relay, groupId, newKeys())
    const e = await c.until('error')
    codes.push([e.code, e.limit])
    await c.closedPromise
  }
  assert.deepEqual(codes.slice(0, 5).map((x) => x[0]), Array(5).fill('credential'))
  assert.deepEqual(codes[5], ['limit', 'authFailsPerMinute'])
  client.ws.terminate()
})

test('lowering the failed-attempt limit lowers the threshold', async () => {
  relay = await startTestRelay({ env: { RELAY_AUTH_FAILS_PER_MINUTE: '2' } })
  const codes = []
  for (let i = 0; i < 3; i++) {
    const c = await createWith('wrong')
    codes.push((await c.until('error')).code)
  }
  assert.deepEqual(codes, ['admin-secret', 'admin-secret', 'limit'])
})

test('failures expire after a minute (mock clock)', async () => {
  const clock = fakeClock()
  relay = await startTestRelay({ env: { RELAY_AUTH_FAILS_PER_MINUTE: '1' }, clock })
  assert.equal((await (await createWith('wrong')).until('error')).code, 'admin-secret')
  assert.equal((await (await createWith('wrong')).until('error')).code, 'limit')
  clock.tick(61000)
  assert.equal((await (await createWith('wrong')).until('error')).code, 'admin-secret')
})

test('an oversize frame is refused with the limit, the connection stays open', async () => {
  relay = await startTestRelay()
  const { client, keys } = await createGroup(relay)
  client.send({ t: 'to', to: 'f'.repeat(32), k: 'data', sid: 's1', data: 'x'.repeat(257 * 1024) })
  const e = await client.until('error')
  assert.deepEqual([e.code, e.limit, e.to, e.sid], ['limit', 'frameBytes', 'f'.repeat(32), 's1'])
  client.send({ t: 'label.set', label: 'still-here' })
  assert.ok(await client.until('ok'))
  void keys
  client.ws.terminate()
})

test('lowering the frame size moves the threshold, and welcome reports the limits', async () => {
  relay = await startTestRelay({ env: { RELAY_MAX_FRAME_BYTES: '8192', RELAY_FRAMES_PER_MINUTE: '77' } })
  const { client, welcome } = await createGroup(relay)
  assert.deepEqual(welcome.limits, { frameBytes: 8192, framesPerMinute: 77 })
  client.send({ t: 'to', to: 'f'.repeat(32), k: 'data', sid: 's', data: 'x'.repeat(4000) })
  assert.equal((await client.until('error')).code, 'route')
  client.send({ t: 'to', to: 'f'.repeat(32), k: 'data', sid: 's', data: 'x'.repeat(9000) })
  const e = await client.until('error')
  assert.equal(e.limit, 'frameBytes')
  client.ws.terminate()
})

test('a burst over the per-minute rate is refused with the limit, and lowering it moves the threshold', async () => {
  for (const [perMinute, burst] of [[20, 25], [10, 15]]) {
    relay = await startTestRelay({ env: { RELAY_FRAMES_PER_MINUTE: String(perMinute) } })
    const { client } = await createGroup(relay)
    for (let i = 0; i < burst; i++) client.send({ t: 'ping' })
    const e = await client.until('error')
    assert.deepEqual([e.code, e.limit], ['limit', 'framesPerMinute'])
    // Each frame past the limit is refused: hello + pings = perMinute allowed.
    let refused = 1
    while (await client.until('error', 200)) refused++
    assert.equal(refused, burst - perMinute)
    client.ws.terminate()
    await relay.close()
    relay = null
  }
})

test('undecodable frames get bad-frame and the connection stays open', async () => {
  relay = await startTestRelay()
  const { client } = await createGroup(relay)
  client.send('not json')
  assert.equal((await client.until('error')).code, 'bad-frame')
  client.send({ t: 'welcome', v: 1, groupId: 'g', epoch: 1, limits: {} })
  assert.equal((await client.until('error')).code, 'bad-frame')
  client.send({ t: 'ping' })
  client.send({ t: 'label.set', label: 'ok' })
  assert.ok(await client.until('ok'))
  client.ws.terminate()
})

test('a first frame that is not hello closes the connection; silence for 10 s closes it too', async () => {
  const clock = fakeClock()
  relay = await startTestRelay({ clock })
  const a = await connect(relay)
  a.send({ t: 'ping' })
  assert.equal((await a.until('error')).code, 'bad-frame')
  await a.closedPromise
  const b = await connect(relay)
  clock.tick(10000)
  await b.closedPromise
  assert.ok(b.closed)
})

test('already-connected: the second connection is refused while the first answers a probe', async () => {
  relay = await startTestRelay()
  const { groupId, keys, client: first } = await createGroup(relay)
  first.ws.on('message', (d) => {
    if (JSON.parse(d.toString()).t === 'probe') first.send({ t: 'probe-ack' })
  })
  const second = await connectMember(relay, groupId, keys)
  const e = await second.until((f) => f.t === 'error' || f.t === 'welcome')
  assert.equal(e.code, 'already-connected')
  await second.closedPromise
  // The first connection is untouched.
  first.send({ t: 'label.set', label: 'alive' })
  assert.ok(await first.until('ok'))
  first.ws.terminate()
})

test('already-connected: a first connection that stops answering is replaced within 5 s, with a higher conn', async () => {
  const clock = fakeClock()
  relay = await startTestRelay({ clock })
  const { groupId, keys, client: first } = await createGroup(relay)
  // A second member watches presence.
  const watcherKeys = newKeys()
  const mkInvite = await import('./helpers.mjs')
  const { invite } = await mkInvite.createInvite(first, groupId, { now: clock.now() })
  const joiner = await mkInvite.joinWithInvite(relay, invite, watcherKeys)
  assert.equal(joiner.first.t, 'welcome')
  const request = await first.until('join.request')
  first.send({ t: 'admit', machineId: request.machineId, inviteId: request.inviteId, epoch: 1 })
  assert.ok(await first.until('admit.ok'))
  const both = await joiner.client.until((f) => f.t === 'directory' && f.machines.length === 2)
  const firstConn = both.machines.find((m) => m.id === keys.machineId).conn
  joiner.client.frames.length = 0

  const second = await connectMember(relay, groupId, keys)
  await first.until('probe') // never answered
  assert.equal(await second.quiet('welcome', 100), true, 'not accepted before the 5 s are over')
  clock.tick(5000)
  const welcome = await second.until((f) => f.t === 'welcome' || f.t === 'error')
  assert.equal(welcome.t, 'welcome')
  await first.closedPromise
  const presence = await joiner.client.until((f) => f.t === 'presence' && f.machineId === keys.machineId && f.online)
  assert.equal(presence.conn, firstConn + 1)
  // The old connection's close must not announce the machine as offline.
  assert.equal(await joiner.client.quiet((f) => f.t === 'presence' && !f.online), true)
  second.ws.terminate()
  joiner.client.ws.terminate()
})

test('keepalive: ping every 25 s, close after 60 s of silence; traffic keeps it alive', async () => {
  const clock = fakeClock()
  relay = await startTestRelay({ clock })
  const { client } = await createGroup(relay)
  clock.tick(25000)
  assert.ok(await client.until('ping'))
  assert.equal(await client.quiet('ping', 100), true)
  clock.tick(25000)
  assert.ok(await client.until('ping'))
  clock.tick(10000) // 60 s since the last thing the relay heard
  await client.closedPromise
  assert.ok(client.closed)

  const { client: busy } = await createGroup(relay)
  clock.tick(40000)
  busy.send({ t: 'ping' })
  await new Promise((r) => setTimeout(r, 100))
  clock.tick(40000)
  assert.equal(busy.closed, false)
  busy.ws.terminate()
})

test('state survives close and restart on the same data folder', async () => {
  const dir = mkdtempSync(join(process.env.TMPDIR || tmpdir(), 'relay-restart-'))
  relay = await startTestRelay({ dataDir: dir })
  const { groupId, keys, client } = await createGroup(relay, { label: 'keeper' })
  client.send({ t: 'profile.put', blob: 'sealed-profile', epoch: 1 })
  await client.until('ok')
  client.ws.terminate()
  await relay.close()
  relay = await startTestRelay({ dataDir: dir })
  const again = await joinAsMember(relay, groupId, keys)
  assert.equal(again.error, undefined, JSON.stringify(again.error))
  assert.equal(again.welcome.epoch, 1)
  const me = again.directory.machines[0]
  assert.deepEqual([me.label, me.profile, me.profileEpoch], ['keeper', 'sealed-profile', 1])
  again.client.ws.terminate()
  await relay.close()
  relay = null
  rmSync(dir, { recursive: true, force: true })
})

test('profile.put and label.set are stored and broadcast in the directory', async () => {
  relay = await startTestRelay()
  const { client, keys } = await createGroup(relay)
  client.send({ t: 'label.set', label: 'rack-1' })
  assert.deepEqual(await client.until('ok'), { t: 'ok', re: 'label.set' })
  let dir = await client.until('directory')
  assert.equal(dir.machines[0].label, 'rack-1')
  client.send({ t: 'label.set', label: '' })
  await client.until('ok')
  dir = await client.until('directory')
  assert.equal(dir.machines[0].label, null)
  client.send({ t: 'label.set', label: 'has space' })
  assert.equal((await client.until('error')).code, 'bad-frame')
  client.send({ t: 'profile.put', blob: 'blob', epoch: 3 })
  assert.deepEqual(await client.until('ok'), { t: 'ok', re: 'profile.put' })
  dir = await client.until('directory')
  assert.deepEqual([dir.machines[0].profile, dir.machines[0].profileEpoch], ['blob', 3])
  void keys
  client.ws.terminate()
})

test('the 21st unauthenticated connection from one address is refused with the limit named', async () => {
  relay = await startTestRelay()
  const idle = []
  for (let i = 0; i < 20; i++) idle.push(await connect(relay))
  const extra = await connect(relay)
  const e = await extra.until('error')
  assert.deepEqual([e.code, e.limit], ['limit', 'preAuthPerAddress'])
  await extra.closedPromise
  // Authenticated connections do not count: one idle slot freed lets a new one in.
  idle[0].ws.terminate()
  await idle[0].closedPromise
  const ok = await createWith(ADMIN)
  assert.ok(await ok.until('welcome'))
  for (const c of idle) c.ws.terminate()
  ok.ws.terminate()
})

test('lowering the pre-auth limit moves the threshold', async () => {
  relay = await startTestRelay({ env: { RELAY_MAX_PREAUTH_PER_ADDRESS: '2' } })
  const a = await connect(relay)
  const b = await connect(relay)
  const c = await connect(relay)
  assert.equal((await c.until('error')).limit, 'preAuthPerAddress')
  a.ws.terminate()
  b.ws.terminate()
})
