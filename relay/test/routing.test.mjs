import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, test } from 'node:test'
import { addMember, createGroup, fakeClock, joinAsMember, startTestRelay } from './helpers.mjs'

let relay
afterEach(async () => {
  await relay?.close()
  relay = null
})

test('a to frame is delivered as from with the same fields', async () => {
  relay = await startTestRelay()
  const a = await createGroup(relay)
  const b = await addMember(relay, a.client, a.groupId)
  a.client.send({ t: 'to', to: b.keys.machineId, k: 'data', sid: 's1', seq: 3, part: 0, parts: 2, data: 'AAAA' })
  const got = await b.client.until('from')
  assert.deepEqual(got, { t: 'from', from: a.keys.machineId, k: 'data', sid: 's1', seq: 3, part: 0, parts: 2, data: 'AAAA' })
  b.client.send({ t: 'to', to: a.keys.machineId, k: 'reset', sid: 's1' })
  assert.deepEqual(await a.client.until('from'), { t: 'from', from: b.keys.machineId, k: 'reset', sid: 's1' })
  a.client.ws.terminate()
  b.client.ws.terminate()
})

test('to an offline member is refused with offline, to a stranger with route', async () => {
  relay = await startTestRelay()
  const a = await createGroup(relay)
  const b = await addMember(relay, a.client, a.groupId)
  b.client.ws.terminate()
  await b.client.closedPromise
  await a.client.until((f) => f.t === 'presence' && !f.online)
  a.client.send({ t: 'to', to: b.keys.machineId, k: 'hs1', sid: 'x1' })
  const off = await a.client.until('error')
  assert.deepEqual([off.code, off.to, off.sid], ['offline', b.keys.machineId, 'x1'])
  a.client.send({ t: 'to', to: 'e'.repeat(32), k: 'hs1', sid: 'x2' })
  const route = await a.client.until('error')
  assert.deepEqual([route.code, route.to, route.sid], ['route', 'e'.repeat(32), 'x2'])
  a.client.send({ t: 'to', to: a.keys.machineId, k: 'hs1', sid: 'x3' })
  assert.equal((await a.client.until('error')).code, 'route')
  a.client.ws.terminate()
})

test('a frame to a member of another group is refused and never delivered', async () => {
  relay = await startTestRelay()
  const g1 = await createGroup(relay)
  const g2 = await createGroup(relay)
  g1.client.send({ t: 'to', to: g2.keys.machineId, k: 'data', sid: 's', data: 'secret' })
  const e = await g1.client.until('error')
  assert.deepEqual([e.code, e.sid], ['route', 's'])
  assert.equal(await g2.client.quiet('from'), true)
  g1.client.ws.terminate()
  g2.client.ws.terminate()
})

test('presence is broadcast on accept and on close, with the connection number', async () => {
  relay = await startTestRelay()
  const a = await createGroup(relay)
  const b = await addMember(relay, a.client, a.groupId)
  await a.client.until((f) => f.t === 'presence' && f.machineId === b.keys.machineId && f.online)
  b.client.ws.terminate()
  const off = await a.client.until((f) => f.t === 'presence' && f.machineId === b.keys.machineId && !f.online)
  const firstConn = off.conn
  assert.ok(firstConn > 0)
  const again = await joinAsMember(relay, a.groupId, b.keys)
  assert.equal(again.welcome.t, 'welcome')
  const on = await a.client.until((f) => f.t === 'presence' && f.machineId === b.keys.machineId && f.online)
  assert.equal(on.conn, firstConn + 1)
  assert.ok(on.lastSeen > 0)
  const entry = again.directory.machines.find((m) => m.id === b.keys.machineId)
  assert.deepEqual([entry.online, entry.conn], [true, firstConn + 1])
  a.client.ws.terminate()
  again.client.ws.terminate()
})

test('hooks can replace or drop a forwarded frame, and see every sent frame', async () => {
  const sent = []
  let mode = 'replace'
  relay = await startTestRelay({
    hooks: {
      onForward(frame) {
        if (mode === 'drop') return null
        if (mode === 'replace') return { ...frame, data: 'REPLACED' }
      },
      onSend(frame, to) {
        sent.push([frame.t, to.machineId])
      },
    },
  })
  const a = await createGroup(relay)
  const b = await addMember(relay, a.client, a.groupId)
  a.client.send({ t: 'to', to: b.keys.machineId, k: 'data', sid: 's', data: 'orig' })
  assert.equal((await b.client.until('from')).data, 'REPLACED')
  mode = 'drop'
  a.client.send({ t: 'to', to: b.keys.machineId, k: 'data', sid: 's', data: 'orig' })
  assert.equal(await b.client.quiet('from'), true)
  mode = 'keep'
  a.client.send({ t: 'to', to: b.keys.machineId, k: 'data', sid: 's', data: 'orig' })
  assert.equal((await b.client.until('from')).data, 'orig')
  assert.ok(sent.some(([t, id]) => t === 'from' && id === b.keys.machineId))
  assert.ok(sent.some(([t]) => t === 'directory'))
  a.client.ws.terminate()
  b.client.ws.terminate()
})

test('directory lists members with keys, label, profile and the active invites', async () => {
  relay = await startTestRelay()
  const a = await createGroup(relay, { label: 'one' })
  const b = await addMember(relay, a.client, a.groupId)
  b.client.send({ t: 'profile.put', blob: 'B-PROFILE', epoch: 1 })
  const dir = await a.client.until((f) => f.t === 'directory' && f.machines.some((m) => m.profile === 'B-PROFILE'))
  const entry = dir.machines.find((m) => m.id === b.keys.machineId)
  assert.deepEqual(
    [entry.signPub, entry.dhPub, entry.profileEpoch, entry.online, entry.blocked],
    [b.keys.signPub, b.keys.dhPub, 1, true, false],
  )
  assert.equal(dir.machines.length, 2)
  assert.deepEqual(dir.invites, [])
  a.client.ws.terminate()
  b.client.ws.terminate()
})

test('the public port answers /healthz and 404 for everything else', async () => {
  relay = await startTestRelay()
  const ok = await fetch(`http://127.0.0.1:${relay.port}/healthz`)
  assert.equal(ok.status, 200)
  assert.equal(await ok.text(), '{"ok":true}')
  for (const path of ['/', '/groups', '/admin/groups', '/healthz/x']) {
    const r = await fetch(`http://127.0.0.1:${relay.port}${path}`)
    assert.equal(r.status, 404, path)
  }
  const post = await fetch(`http://127.0.0.1:${relay.port}/healthz`, { method: 'POST' })
  assert.equal(post.status, 404)
})

test('log lines carry ids, frame types and sizes but never frame bodies', async () => {
  const lines = []
  relay = await startTestRelay({ log: (l) => lines.push(l) })
  const a = await createGroup(relay)
  const b = await addMember(relay, a.client, a.groupId)
  a.client.send({ t: 'to', to: b.keys.machineId, k: 'data', sid: 's', data: 'DATA-MARKER-1' })
  await b.client.until('from')
  a.client.send({ t: 'profile.put', blob: 'PROFILE-MARKER-2', epoch: 1 })
  await a.client.until('ok')
  const text = lines.join('\n')
  for (const marker of ['DATA-MARKER-1', 'PROFILE-MARKER-2', 'sealed', 'adminSecret', 'admin-secret-for-tests']) {
    assert.ok(!text.includes(marker), marker)
  }
  assert.ok(lines.some((l) => l.includes(`group=${a.groupId}`) && l.includes(`machine=${a.keys.machineId}`) && l.includes('type=to') && /size=\d+/.test(l)))
  a.client.ws.terminate()
  b.client.ws.terminate()
})

test('oversize frames count toward the per-minute rate', async () => {
  relay = await startTestRelay({ env: { RELAY_MAX_FRAME_BYTES: '4096', RELAY_FRAMES_PER_MINUTE: '6' } })
  const { client } = await createGroup(relay)
  const big = { t: 'to', to: 'f'.repeat(32), k: 'data', sid: 's', data: 'x'.repeat(5000) }
  client.send(big)
  client.send(big)
  for (let i = 0; i < 4; i++) client.send({ t: 'ping' })
  assert.equal((await client.until('error')).limit, 'frameBytes')
  assert.equal((await client.until('error')).limit, 'frameBytes')
  assert.equal(await client.quiet('error', 100), true, 'six frames are within the rate')
  client.send({ t: 'ping' })
  assert.equal((await client.until('error')).limit, 'framesPerMinute')
  client.ws.terminate()
})

test('a connection is closed on its third oversize frame in a minute', async () => {
  relay = await startTestRelay({ env: { RELAY_MAX_FRAME_BYTES: '4096' } })
  const { client } = await createGroup(relay)
  const big = { t: 'to', to: 'f'.repeat(32), k: 'data', sid: 's', data: 'x'.repeat(5000) }
  for (let i = 0; i < 3; i++) client.send(big)
  for (let i = 0; i < 3; i++) assert.equal((await client.until('error')).limit, 'frameBytes')
  await client.closedPromise
  assert.ok(client.closed)
})

test('a profile over 4096 characters is refused; an unchanged profile or label is not broadcast again', async () => {
  relay = await startTestRelay()
  const { client } = await createGroup(relay)
  client.send({ t: 'profile.put', blob: 'x'.repeat(4097), epoch: 1 })
  const e = await client.until('error')
  assert.deepEqual([e.code, e.limit], ['limit', 'profileBytes'])
  client.send({ t: 'profile.put', blob: 'x'.repeat(4096), epoch: 1 })
  await client.until('ok')
  assert.ok(await client.until((f) => f.t === 'directory' && f.machines[0].profile?.length === 4096))
  client.send({ t: 'profile.put', blob: 'x'.repeat(4096), epoch: 1 })
  await client.until('ok')
  assert.equal(await client.quiet('directory', 150), true)
  client.send({ t: 'profile.put', blob: 'x'.repeat(4096), epoch: 2 })
  await client.until('ok')
  assert.ok(await client.until('directory'))
  client.send({ t: 'label.set', label: 'one' })
  await client.until('ok')
  await client.until('directory')
  client.send({ t: 'label.set', label: 'one' })
  await client.until('ok')
  assert.equal(await client.quiet('directory', 150), true)
  client.ws.terminate()
})

test('connection numbers keep growing across a restart of the relay', async () => {
  const dir = mkdtempSync(join(process.env.TMPDIR || tmpdir(), 'relay-conn-'))
  const clock = fakeClock()
  relay = await startTestRelay({ dataDir: dir, clock })
  const a = await createGroup(relay)
  const before = a.directory.machines[0].conn
  a.client.ws.terminate()
  await relay.close()
  clock.tick(60 * 60 * 1000)
  relay = await startTestRelay({ dataDir: dir, clock })
  const again = await joinAsMember(relay, a.groupId, a.keys)
  assert.ok(again.directory.machines[0].conn > before, `${again.directory.machines[0].conn} > ${before}`)
  again.client.ws.terminate()
  await relay.close()
  relay = null
  rmSync(dir, { recursive: true, force: true })
})
