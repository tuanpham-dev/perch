import assert from 'node:assert/strict'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, test } from 'node:test'
import {
  addMember,
  connect,
  connectMember,
  createGroup,
  createInvite,
  helloFrame,
  joinWithInvite,
  leaveSig,
  removalRecord,
  signText,
  startTestRelay,
} from './helpers.mjs'
import { canonical, challengeString } from '../src/wire.mjs'

let relay
let open = []
afterEach(async () => {
  for (const c of open) c.ws.terminate()
  open = []
  await relay?.close()
  relay = null
})
const track = (...cs) => {
  open.push(...cs)
  return cs[0]
}

// Three members a (creator), b, c, all online. Returns them with the group id.
async function trio() {
  relay = await startTestRelay()
  const a = await createGroup(relay)
  const b = await addMember(relay, a.client, a.groupId)
  const c = await addMember(relay, a.client, a.groupId)
  track(a.client, b.client, c.client)
  return { a, b, c, groupId: a.groupId }
}

function removeFrame(groupId, by, removedId, packages, fromEpoch = 1, confirm) {
  return { t: 'remove', record: removalRecord({ groupId, by, removedId, fromEpoch, confirm }), fromEpoch, packages }
}

test('a removal stores the record, closes the removed machine with it, and delivers packages', async () => {
  const { a, b, c, groupId } = await trio()
  const frame = removeFrame(groupId, a.keys, b.keys.machineId, { [a.keys.machineId]: 'pkg-a', [c.keys.machineId]: 'pkg-c', [b.keys.machineId]: 'pkg-b' })
  a.client.send(frame)
  const removed = await b.client.until('error')
  assert.equal(removed.code, 'removed')
  assert.deepEqual(removed.record, frame.record)
  await b.client.closedPromise
  assert.deepEqual(await a.client.until('remove.ok'), { t: 'remove.ok', epoch: 2, packageMissing: [] })
  assert.deepEqual(await a.client.until('rekey'), { t: 'rekey', record: frame.record, sealed: 'pkg-a' })
  assert.deepEqual(await c.client.until('rekey'), { t: 'rekey', record: frame.record, sealed: 'pkg-c' })
  const dir = await a.client.until((f) => f.t === 'directory' && f.machines.length === 2 && !f.machines.some((m) => m.id === b.keys.machineId))
  assert.equal(dir.machines.length, 2)
})

test('a removed machine reconnecting gets removed with the record, only after a valid signature', async () => {
  const { a, b, c, groupId } = await trio()
  const frame = removeFrame(groupId, a.keys, b.keys.machineId, { [a.keys.machineId]: 'x', [c.keys.machineId]: 'y' })
  a.client.send(frame)
  await a.client.until('remove.ok')
  await b.client.closedPromise

  // Bad signature: nothing about its standing is revealed.
  const bad = await connect(relay)
  bad.send(helloFrame(b.keys, { groupId }))
  const ch = await bad.until('challenge')
  bad.send({ t: 'prove', sig: signText(c.keys.signPriv, challengeString(ch.nonce, groupId, b.keys.machineId)) })
  const refused = await bad.until('error')
  assert.equal(refused.code, 'credential')
  assert.equal(refused.record, undefined)

  const good = await connectMember(relay, groupId, b.keys)
  const e = await good.until('error')
  assert.equal(e.code, 'removed')
  assert.deepEqual(e.record, frame.record)
  await good.closedPromise
  assert.equal(await good.quiet('welcome', 50), true)
})

test('packages for an offline member are kept and delivered before the directory, until its profile.put', async () => {
  const { a, b, c, groupId } = await trio()
  c.client.ws.terminate()
  await c.client.closedPromise
  await a.client.until((f) => f.t === 'presence' && !f.online)
  const frame = removeFrame(groupId, a.keys, b.keys.machineId, { [a.keys.machineId]: 'pkg-a', [c.keys.machineId]: 'pkg-c' })
  a.client.send(frame)
  await a.client.until('remove.ok')

  const back = track((await connectMember(relay, groupId, c.keys)))
  const order = []
  for (let i = 0; i < 3; i++) order.push((await back.next()).t)
  assert.deepEqual(order, ['welcome', 'rekey', 'directory'])

  // Still stored until the machine republishes its profile at the new epoch.
  back.ws.terminate()
  await back.closedPromise
  await a.client.until((f) => f.t === 'presence' && f.machineId === c.keys.machineId && !f.online)
  const second = track(await connectMember(relay, groupId, c.keys))
  assert.deepEqual([(await second.next()).t, (await second.next()).t], ['welcome', 'rekey'])
  second.send({ t: 'profile.put', blob: 'new-profile', epoch: 2 })
  await second.until('ok')
  second.ws.terminate()
  await second.closedPromise
  await a.client.until((f) => f.t === 'presence' && f.machineId === c.keys.machineId && !f.online)
  const third = track(await connectMember(relay, groupId, c.keys))
  assert.deepEqual([(await third.next()).t, (await third.next()).t], ['welcome', 'directory'])
})

test('a removal closes pending joiners and cancels every invite', async () => {
  const { a, b, c, groupId } = await trio()
  const { invite } = await createInvite(a.client, groupId)
  const { invite: spare } = await createInvite(a.client, groupId)
  const pending = track((await joinWithInvite(relay, invite)).client)
  await a.client.until('join.request')
  a.client.send(removeFrame(groupId, a.keys, b.keys.machineId, { [a.keys.machineId]: 'x', [c.keys.machineId]: 'y' }))
  await a.client.until('remove.ok')
  const e = await pending.until('error')
  assert.deepEqual([e.code, e.reason], ['invite', 'cancelled'])
  await pending.closedPromise
  const late = await joinWithInvite(relay, spare)
  assert.deepEqual([late.first.code, late.first.reason], ['invite', 'cancelled'])
  const dir = await a.client.until((f) => f.t === 'directory' && f.machines.length === 2 && !f.machines.some((m) => m.id === b.keys.machineId))
  assert.deepEqual(dir.invites, [])
  // The pending machine row is gone, so admitting it now is refused.
  a.client.send({ t: 'admit', machineId: pending && late.keys.machineId, inviteId: invite.id, epoch: 2 })
  assert.equal((await a.client.until('admit.refused')).reason, 'not-pending')
})

test('two removals from the same epoch: exactly one is accepted, the other gets epoch-conflict', async () => {
  const { a, b, c, groupId } = await trio()
  const pkgsA = { [a.keys.machineId]: 'x', [c.keys.machineId]: 'y' }
  a.client.send(removeFrame(groupId, a.keys, b.keys.machineId, pkgsA))
  c.client.send(removeFrame(groupId, c.keys, b.keys.machineId, { [a.keys.machineId]: 'p', [c.keys.machineId]: 'q' }))
  const results = await Promise.all([
    a.client.until((f) => f.t === 'remove.ok' || (f.t === 'error' && f.code === 'epoch-conflict')),
    c.client.until((f) => f.t === 'remove.ok' || (f.t === 'error' && f.code === 'epoch-conflict')),
  ])
  const oks = results.filter((r) => r.t === 'remove.ok')
  const conflicts = results.filter((r) => r.t === 'error')
  assert.equal(oks.length, 1)
  assert.equal(conflicts.length, 1)
  assert.equal(conflicts[0].epoch, 2)
  assert.equal(oks[0].epoch, 2)
})

test('a stale fromEpoch gets epoch-conflict even for a different target', async () => {
  const { a, b, c, groupId } = await trio()
  a.client.send(removeFrame(groupId, a.keys, b.keys.machineId, { [a.keys.machineId]: 'x', [c.keys.machineId]: 'y' }))
  await a.client.until('remove.ok')
  a.client.send(removeFrame(groupId, a.keys, c.keys.machineId, { [a.keys.machineId]: 'x' }, 1))
  const e = await a.client.until('error')
  assert.deepEqual([e.code, e.epoch], ['epoch-conflict', 2])
  // At the new epoch it is accepted.
  a.client.send(removeFrame(groupId, a.keys, c.keys.machineId, { [a.keys.machineId]: 'x' }, 2))
  assert.deepEqual(await a.client.until('remove.ok'), { t: 'remove.ok', epoch: 3, packageMissing: [] })
})

test('invalid removal records are refused and change nothing', async () => {
  const { a, b, c, groupId } = await trio()
  const good = removeFrame(groupId, a.keys, b.keys.machineId, {})
  const cases = {
    'record.by is another machine': { ...good, record: removalRecord({ groupId, by: c.keys, removedId: b.keys.machineId, fromEpoch: 1 }) },
    'bad signature': { ...good, record: { ...good.record, confirm: 'tampered' } },
    'epoch is not fromEpoch + 1': { ...good, record: removalRecord({ groupId, by: a.keys, removedId: b.keys.machineId, fromEpoch: 5 }) },
    'another group': { ...good, record: removalRecord({ groupId: 'other', by: a.keys, removedId: b.keys.machineId, fromEpoch: 1 }) },
    'removing itself': removeFrame(groupId, a.keys, a.keys.machineId, {}),
    'not a member': removeFrame(groupId, a.keys, 'e'.repeat(32), {}),
  }
  for (const [name, frame] of Object.entries(cases)) {
    a.client.send(frame)
    const e = await a.client.until('error')
    assert.equal(e.code, 'bad-frame', name)
  }
  a.client.send({ t: 'label.set', label: 'x' })
  const dir = await a.client.until((f) => f.t === 'directory' && f.machines.some((m) => m.label === 'x'))
  assert.equal(dir.machines.length, 3)
  assert.equal(await b.client.quiet('error', 100), true)
})

test('leave removes the machine; a bad signature does not; the last machine leaving deletes the group', async () => {
  const { a, b, groupId } = await trio()
  b.client.send({ t: 'leave', sig: leaveSig(a.keys, groupId) })
  assert.equal((await b.client.until('error')).code, 'credential')
  b.client.send({ t: 'leave', sig: leaveSig(b.keys, groupId) })
  assert.deepEqual(await b.client.until('ok'), { t: 'ok', re: 'leave' })
  await b.client.closedPromise
  const dir = await a.client.until((f) => f.t === 'directory' && f.machines.length === 2 && !f.machines.some((m) => m.id === b.keys.machineId))
  assert.equal(dir.machines.length, 2)
  // Its keys no longer work.
  const back = await connectMember(relay, groupId, b.keys)
  assert.equal((await back.until('error')).code, 'credential')
})

test('the last machine leaving deletes the group', async () => {
  relay = await startTestRelay()
  const a = await createGroup(relay)
  track(a.client)
  a.client.send({ t: 'leave', sig: leaveSig(a.keys, a.groupId) })
  await a.client.until('ok')
  const back = await connectMember(relay, a.groupId, a.keys)
  assert.equal((await back.until('error')).code, 'credential')
})

test('a machine removed while its replacement connection is being probed is refused as removed', async () => {
  const { a, b, c, groupId } = await trio()
  // b's old connection never answers the probe.
  const second = track(await connectMember(relay, groupId, b.keys))
  await b.client.until('probe')
  const frame = removeFrame(groupId, a.keys, b.keys.machineId, { [a.keys.machineId]: 'x', [c.keys.machineId]: 'y' })
  a.client.send(frame)
  await a.client.until('remove.ok')
  const e = await second.until((f) => f.t === 'error' || f.t === 'welcome')
  assert.equal(e.code, 'removed')
  assert.deepEqual(e.record, frame.record)
  await second.closedPromise
  assert.equal(await second.quiet('welcome', 50), true)
})

test('a machine that is no longer a member cannot send a signed remove', async () => {
  const { a, b, c, groupId } = await trio()
  // Simulate the race: the row changes while b's connection is still registered.
  const raw = new DatabaseSync(join(relay.dir, 'relay.sqlite'))
  raw.prepare("UPDATE machines SET status = 'removed' WHERE group_id = ? AND id = ?").run(groupId, b.keys.machineId)
  b.client.send(removeFrame(groupId, b.keys, a.keys.machineId, { [b.keys.machineId]: 'x', [c.keys.machineId]: 'y' }))
  assert.equal((await b.client.until('error')).code, 'bad-frame')
  await b.client.closedPromise
  const epoch = raw.prepare('SELECT epoch FROM groups WHERE id = ?').get(groupId).epoch
  const statuses = raw.prepare('SELECT id, status FROM machines WHERE group_id = ? ORDER BY id').all(groupId)
  assert.equal(epoch, 1)
  assert.equal(statuses.find((m) => m.id === a.keys.machineId).status, 'member')
  assert.equal(raw.prepare('SELECT COUNT(*) AS n FROM removals').get().n, 0)
  raw.close()
})

test('a removal record with a key outside the record set, or aimed at its author, is refused before storing', async () => {
  const { a, b, c, groupId } = await trio()
  const packages = { [a.keys.machineId]: 'x', [c.keys.machineId]: 'y' }
  const base = removeFrame(groupId, a.keys, b.keys.machineId, packages)
  const { sig, ...body } = base.record
  const extra = { ...body, extra: 1 }
  a.client.send({ ...base, record: { ...extra, sig: signText(a.keys.signPriv, canonical(extra)) } })
  assert.equal((await a.client.until('error')).code, 'bad-frame')
  const own = { ...body, removedId: a.keys.machineId }
  a.client.send({ ...base, record: { ...own, sig: signText(a.keys.signPriv, canonical(own)) } })
  assert.equal((await a.client.until('error')).code, 'bad-frame')
  // nothing was stored: a valid removal at the same epoch still works
  a.client.send(base)
  assert.deepEqual(await a.client.until('remove.ok'), { t: 'remove.ok', epoch: 2, packageMissing: [] })
})

test('remove.ok names the members the remover sent no package for', async () => {
  const { a, b, c, groupId } = await trio()
  const frame = removeFrame(groupId, a.keys, b.keys.machineId, { [a.keys.machineId]: 'pkg-a' })
  a.client.send(frame)
  assert.deepEqual(await a.client.until('remove.ok'), { t: 'remove.ok', epoch: 2, packageMissing: [c.keys.machineId] })
  await a.client.until('rekey')
  assert.equal(await c.client.quiet('rekey', 200), true)
})
