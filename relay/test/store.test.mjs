import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, test } from 'node:test'
import { DatabaseSync } from 'node:sqlite'
import { openStore } from '../src/store.mjs'

let dir
let clock
let store
const KEY = (c) => c.repeat(43)
const m = (c, extra = {}) => ({ id: c.repeat(32), signPub: KEY(c), dhPub: KEY(c), ...extra })
const GROUP = 'g1'

beforeEach(() => {
  dir = mkdtempSync(join(process.env.TMPDIR || tmpdir(), 'relay-store-'))
  clock = 1_000_000
  store = openStore(dir, { now: () => clock })
})
afterEach(() => {
  try {
    store.close()
  } catch {}
  rmSync(dir, { recursive: true, force: true })
})

function seedGroup() {
  store.createGroup(GROUP, m('a', { label: 'first' }))
  store.createInvite({ id: 'inv1', groupId: GROUP, enrolPub: KEY('e'), expiresAt: clock + 60_000, uses: 1, createdBy: m('a').id })
}

test('createGroup stores the first machine as member with owner kind key', () => {
  store.createGroup(GROUP, m('a', { label: 'first' }))
  const g = store.group(GROUP)
  assert.equal(g.epoch, 1)
  assert.equal(g.ownerKind, 'key')
  assert.equal(g.ownerId, null)
  const machine = store.machine(GROUP, m('a').id)
  assert.equal(machine.status, 'member')
  assert.equal(machine.label, 'first')
  assert.equal(store.memberCount(GROUP), 1)
  assert.deepEqual(store.groups().map((x) => x.id), [GROUP])
  assert.equal(store.group('nope'), undefined)
})

test('pending machines are not members until admitted', () => {
  seedGroup()
  store.addPending(GROUP, m('b'), 'inv1')
  assert.equal(store.machine(GROUP, m('b').id).status, 'pending')
  assert.equal(store.memberCount(GROUP), 1)
  assert.deepEqual(store.machines(GROUP).map((x) => x.id), [m('a').id])
  store.deletePending(GROUP)
  assert.equal(store.machine(GROUP, m('b').id), undefined)
})

test('admit succeeds once, decrements and marks the invite used at zero', () => {
  seedGroup()
  store.addPending(GROUP, m('b'), 'inv1')
  assert.deepEqual(store.admit({ groupId: GROUP, machineId: m('b').id, inviteId: 'inv1', epoch: 1 }), { ok: true })
  assert.equal(store.machine(GROUP, m('b').id).status, 'member')
  assert.equal(store.invite('inv1').usesLeft, 0)
  assert.equal(store.invite('inv1').status, 'used')
  assert.deepEqual(store.activeInvites(GROUP), [])
})

test('admit loses the compare-and-set when the machine is no longer pending on that invite', () => {
  seedGroup()
  store.addPending(GROUP, m('b'), 'inv1')
  assert.equal(store.admit({ groupId: GROUP, machineId: m('b').id, inviteId: 'other', epoch: 1 }).reason, 'not-pending')
  assert.equal(store.admit({ groupId: GROUP, machineId: m('z').id, inviteId: 'inv1', epoch: 1 }).reason, 'not-pending')
  assert.equal(store.admit({ groupId: GROUP, machineId: m('b').id, inviteId: 'inv1', epoch: 1 }).ok, true)
  // Second admit of the same machine: it is a member now.
  assert.equal(store.admit({ groupId: GROUP, machineId: m('b').id, inviteId: 'inv1', epoch: 1 }).reason, 'not-pending')
})

test('two pending machines on a one-use invite: exactly one is admitted', () => {
  seedGroup()
  store.addPending(GROUP, m('b'), 'inv1')
  store.addPending(GROUP, m('c'), 'inv1')
  const a = store.admit({ groupId: GROUP, machineId: m('b').id, inviteId: 'inv1', epoch: 1 })
  const b = store.admit({ groupId: GROUP, machineId: m('c').id, inviteId: 'inv1', epoch: 1 })
  assert.equal(a.ok, true)
  assert.deepEqual(b, { ok: false, reason: 'used' })
  assert.equal(store.machine(GROUP, m('c').id).status, 'pending')
})

test('admit loses the compare-and-set on a stale epoch and leaves the invite alone', () => {
  seedGroup()
  store.addPending(GROUP, m('b'), 'inv1')
  assert.deepEqual(store.admit({ groupId: GROUP, machineId: m('b').id, inviteId: 'inv1', epoch: 7 }), { ok: false, reason: 'epoch' })
  assert.equal(store.invite('inv1').usesLeft, 1)
  assert.equal(store.machine(GROUP, m('b').id).status, 'pending')
})

test('admit refuses expired, revoked and cancelled invites', () => {
  seedGroup()
  store.addPending(GROUP, m('b'), 'inv1')
  clock += 120_000
  assert.equal(store.admit({ groupId: GROUP, machineId: m('b').id, inviteId: 'inv1', epoch: 1 }).reason, 'expired')
  clock = 1_000_000
  assert.equal(store.revokeInvite(GROUP, 'inv1'), true)
  assert.equal(store.admit({ groupId: GROUP, machineId: m('b').id, inviteId: 'inv1', epoch: 1 }).reason, 'revoked')
  store.createInvite({ id: 'inv2', groupId: GROUP, enrolPub: KEY('e'), expiresAt: clock + 60_000, uses: 2, createdBy: m('a').id })
  store.addPending(GROUP, m('c'), 'inv2')
  store.cancelInvites(GROUP)
  assert.equal(store.admit({ groupId: GROUP, machineId: m('c').id, inviteId: 'inv2', epoch: 1 }).reason, 'cancelled')
})

test('invites: create, list active, revoke only once, uses decrement', () => {
  seedGroup()
  store.createInvite({ id: 'inv2', groupId: GROUP, enrolPub: KEY('f'), expiresAt: clock + 10, uses: 3, createdBy: m('a').id })
  assert.deepEqual(store.activeInvites(GROUP).map((i) => [i.id, i.usesLeft, i.createdBy, i.createdAt]), [
    ['inv1', 1, m('a').id, clock],
    ['inv2', 3, m('a').id, clock],
  ])
  clock += 100
  assert.deepEqual(store.activeInvites(GROUP).map((i) => i.id), ['inv1'])
  assert.equal(store.revokeInvite(GROUP, 'inv1'), true)
  assert.equal(store.revokeInvite(GROUP, 'inv1'), false)
  assert.equal(store.revokeInvite('other-group', 'inv2'), false)
  assert.equal(store.invite('inv1').status, 'revoked')
  assert.throws(() => store.createInvite({ id: 'inv1', groupId: GROUP, enrolPub: KEY('e'), expiresAt: 1, uses: 1, createdBy: 'x' }))
})

function seedThree() {
  store.createGroup(GROUP, m('a'))
  for (const c of ['b', 'c']) {
    store.createInvite({ id: 'i' + c, groupId: GROUP, enrolPub: KEY('e'), expiresAt: clock + 60_000, uses: 1, createdBy: m('a').id })
    store.addPending(GROUP, m(c), 'i' + c)
    assert.equal(store.admit({ groupId: GROUP, machineId: m(c).id, inviteId: 'i' + c, epoch: 1 }).ok, true)
  }
  store.createInvite({ id: 'live', groupId: GROUP, enrolPub: KEY('e'), expiresAt: clock + 60_000, uses: 5, createdBy: m('a').id })
}

test('remove: one transaction sets removed, stores record and packages, cancels invites, bumps epoch', () => {
  seedThree()
  const record = { groupId: GROUP, removedId: m('b').id, epoch: 2, by: m('a').id }
  const result = store.remove({
    groupId: GROUP,
    removedId: m('b').id,
    fromEpoch: 1,
    record,
    packages: { [m('a').id]: 'sealed-a', [m('c').id]: 'sealed-c' },
  })
  assert.deepEqual(result, { ok: true, epoch: 2 })
  assert.equal(store.group(GROUP).epoch, 2)
  assert.equal(store.machine(GROUP, m('b').id).status, 'removed')
  assert.equal(store.invite('live').status, 'cancelled')
  assert.deepEqual(store.packagesFor(GROUP, m('c').id), [{ epoch: 2, record, sealed: 'sealed-c' }])
  assert.deepEqual(store.packagesFor(GROUP, m('b').id), [])
  assert.deepEqual(store.latestRemoval(GROUP, m('b').id), record)
  assert.equal(store.latestRemoval(GROUP, m('c').id), null)
})

test('remove loses the compare-and-set on a stale epoch and changes nothing', () => {
  seedThree()
  const first = { groupId: GROUP, removedId: m('b').id, epoch: 2 }
  assert.equal(store.remove({ groupId: GROUP, removedId: m('b').id, fromEpoch: 1, record: first, packages: {} }).ok, true)
  const second = store.remove({
    groupId: GROUP,
    removedId: m('c').id,
    fromEpoch: 1,
    record: { groupId: GROUP, removedId: m('c').id, epoch: 2 },
    packages: { [m('a').id]: 'x' },
  })
  assert.deepEqual(second, { ok: false, reason: 'epoch-conflict', epoch: 2 })
  assert.equal(store.machine(GROUP, m('c').id).status, 'member')
  assert.equal(store.group(GROUP).epoch, 2)
  assert.deepEqual(store.packagesFor(GROUP, m('a').id), [])
})

test('remove refuses a machine that is not a member', () => {
  seedThree()
  assert.equal(store.remove({ groupId: GROUP, removedId: m('z').id, fromEpoch: 1, record: {}, packages: {} }).reason, 'not-member')
  assert.equal(store.group(GROUP).epoch, 1)
})

test('packages arrive in epoch order and are deleted up to an epoch', () => {
  seedThree()
  store.remove({ groupId: GROUP, removedId: m('b').id, fromEpoch: 1, record: { epoch: 2 }, packages: { [m('c').id]: 's2' } })
  store.createInvite({ id: 'x', groupId: GROUP, enrolPub: KEY('e'), expiresAt: clock + 60_000, uses: 1, createdBy: m('a').id })
  store.addPending(GROUP, m('d'), 'x')
  store.admit({ groupId: GROUP, machineId: m('d').id, inviteId: 'x', epoch: 2 })
  store.remove({ groupId: GROUP, removedId: m('d').id, fromEpoch: 2, record: { epoch: 3 }, packages: { [m('c').id]: 's3' } })
  assert.deepEqual(store.packagesFor(GROUP, m('c').id).map((p) => [p.epoch, p.sealed]), [[2, 's2'], [3, 's3']])
  store.deletePackages(GROUP, m('c').id, 2)
  assert.deepEqual(store.packagesFor(GROUP, m('c').id).map((p) => p.epoch), [3])
  assert.equal(store.latestRemoval(GROUP, m('d').id).epoch, 3)
})

test('profile, label, last seen, block and delete', () => {
  seedGroup()
  const id = m('a').id
  store.setProfile(GROUP, id, 'blob', 4)
  store.setLabel(GROUP, id, 'rack')
  store.touch(GROUP, id, 42)
  let row = store.machine(GROUP, id)
  assert.deepEqual([row.profile, row.profileEpoch, row.label, row.lastSeen], ['blob', 4, 'rack', 42])
  store.setLabel(GROUP, id, '')
  assert.equal(store.machine(GROUP, id).label, null)
  store.block(GROUP, id)
  assert.equal(store.machine(GROUP, id).status, 'blocked')
  assert.equal(store.memberCount(GROUP), 1)
  store.deleteMachine(GROUP, id)
  assert.equal(store.machine(GROUP, id), undefined)
})

test('deleteGroup removes every row of that group only', () => {
  seedThree()
  store.createGroup('g2', m('f'))
  store.remove({ groupId: GROUP, removedId: m('b').id, fromEpoch: 1, record: { epoch: 2 }, packages: { [m('c').id]: 's' } })
  store.deleteGroup(GROUP)
  assert.equal(store.group(GROUP), undefined)
  assert.deepEqual(store.machines(GROUP), [])
  assert.equal(store.invite('live'), undefined)
  assert.deepEqual(store.packagesFor(GROUP, m('c').id), [])
  assert.equal(store.latestRemoval(GROUP, m('b').id), null)
  assert.equal(store.group('g2').epoch, 1)
  assert.equal(store.machines('g2').length, 1)
})

test('data persists across close and reopen, and pending rows can be cleared', () => {
  seedGroup()
  store.addPending(GROUP, m('b'), 'inv1')
  store.close()
  store = openStore(dir, { now: () => clock })
  assert.equal(store.group(GROUP).epoch, 1)
  assert.equal(store.machine(GROUP, m('a').id).label, 'first')
  assert.equal(store.invite('inv1').usesLeft, 1)
  assert.equal(store.machine(GROUP, m('b').id).status, 'pending')
  store.deleteAllPending()
  assert.equal(store.machine(GROUP, m('b').id), undefined)
})

test('user_version is 1, five tables exist, and a higher version is refused', () => {
  store.close()
  const raw = new DatabaseSync(join(dir, 'relay.sqlite'))
  assert.equal(raw.prepare('PRAGMA user_version').get().user_version, 1)
  const tables = raw.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all().map((r) => r.name)
  assert.deepEqual(tables, ['groups', 'invites', 'machines', 'rekey_packages', 'removals'])
  raw.exec('PRAGMA user_version = 2')
  raw.close()
  assert.throws(() => openStore(dir), /newer relay/)
  store = openStore(join(dir, 'fresh'))
})
