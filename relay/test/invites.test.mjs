import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import {
  addMember,
  connect,
  createGroup,
  createInvite,
  fakeClock,
  joinAsMember,
  joinWithInvite,
  newInvite,
  newKeys,
  startTestRelay,
} from './helpers.mjs'

let relay
afterEach(async () => {
  await relay?.close()
  relay = null
})

const MIN = 60000

test('invite.create accepts 1-20 uses and 10 minutes to 7 days, and lists it in the directory', async () => {
  relay = await startTestRelay()
  const a = await createGroup(relay)
  const accepted = []
  for (const [uses, minutes] of [[1, 10], [20, 10080], [5, 1440]]) {
    const { reply } = await createInvite(a.client, a.groupId, { uses, minutes })
    accepted.push(reply.t)
  }
  assert.deepEqual(accepted, ['ok', 'ok', 'ok'])
  const dir = (await a.client.until((f) => f.t === 'directory' && f.invites.length === 3)).invites
  assert.deepEqual(dir.map((i) => i.usesLeft), [1, 20, 5])
  assert.ok(dir.every((i) => i.createdBy === a.keys.machineId && i.createdAt > 0 && i.expiresAt > i.createdAt))
  assert.equal(Object.keys(dir[0]).sort().join(), 'createdAt,createdBy,expiresAt,id,usesLeft')
  for (const [uses, minutes] of [[0, 60], [21, 60], [1, 5], [1, 8 * 24 * 60]]) {
    const { reply } = await createInvite(a.client, a.groupId, { uses, minutes })
    assert.deepEqual([reply.t, reply.code, reply.limit], ['error', 'limit', 'invite'], `${uses} uses ${minutes} min`)
  }
  a.client.ws.terminate()
})

test('a one-use invite works once and then fails as used', async () => {
  relay = await startTestRelay()
  const a = await createGroup(relay)
  const { invite } = await createInvite(a.client, a.groupId)
  const first = await joinWithInvite(relay, invite)
  assert.equal(first.first.t, 'welcome')
  assert.equal(first.first.pending, true)
  const request = await a.client.until('join.request')
  assert.deepEqual(
    [request.machineId, request.inviteId, request.signPub, request.dhPub],
    [first.keys.machineId, invite.id, first.keys.signPub, first.keys.dhPub],
  )
  a.client.send({ t: 'admit', machineId: request.machineId, inviteId: invite.id, epoch: 1 })
  assert.deepEqual(await a.client.until('admit.ok'), { t: 'admit.ok', machineId: request.machineId })
  const second = await joinWithInvite(relay, invite)
  assert.deepEqual([second.first.code, second.first.reason], ['invite', 'used'])
  // The new member sees itself in the directory, online, with the group's other member.
  const dir = await first.client.until('directory')
  assert.equal(dir.machines.length, 2)
  assert.equal(dir.machines.find((m) => m.id === first.keys.machineId).online, true)
  assert.deepEqual(dir.invites, [])
  // The group sees presence for the new member.
  assert.ok(await a.client.until((f) => f.t === 'presence' && f.machineId === first.keys.machineId && f.online))
  a.client.ws.terminate()
  first.client.ws.terminate()
})

test('an expired invite fails with reason expired (mock clock)', async () => {
  const clock = fakeClock()
  relay = await startTestRelay({ clock })
  const a = await createGroup(relay)
  const { invite } = await createInvite(a.client, a.groupId, { minutes: 10, now: clock.now() })
  const fresh = await joinWithInvite(relay, invite)
  assert.equal(fresh.first.t, 'welcome')
  fresh.client.ws.terminate()
  clock.tick(11 * MIN)
  const late = await joinWithInvite(relay, invite)
  assert.deepEqual([late.first.code, late.first.reason], ['invite', 'expired'])
})

test('a revoked invite fails with reason revoked; unknown ones with unknown', async () => {
  relay = await startTestRelay()
  const a = await createGroup(relay)
  const { invite } = await createInvite(a.client, a.groupId)
  a.client.send({ t: 'invite.revoke', id: invite.id })
  assert.deepEqual(await a.client.until('ok'), { t: 'ok', re: 'invite.revoke' })
  const dir = await a.client.until((f) => f.t === 'directory' && f.invites.length === 0)
  assert.ok(dir)
  const r = await joinWithInvite(relay, invite)
  assert.deepEqual([r.first.code, r.first.reason], ['invite', 'revoked'])
  const u = await joinWithInvite(relay, newInvite(a.groupId))
  assert.deepEqual([u.first.code, u.first.reason], ['invite', 'unknown'])
  a.client.send({ t: 'invite.revoke', id: 'nope' })
  assert.equal((await a.client.until('error')).reason, 'unknown')
  a.client.ws.terminate()
})

test('an invite for another group is unknown there', async () => {
  relay = await startTestRelay()
  const a = await createGroup(relay)
  const b = await createGroup(relay)
  const { invite } = await createInvite(a.client, a.groupId)
  const r = await joinWithInvite(relay, { ...invite, groupId: b.groupId })
  assert.equal(r.first.reason, 'unknown')
  a.client.ws.terminate()
  b.client.ws.terminate()
})

test('a join signed with the wrong key is refused', async () => {
  relay = await startTestRelay()
  const a = await createGroup(relay)
  const { invite } = await createInvite(a.client, a.groupId)
  const other = newInvite(a.groupId)
  const r = await joinWithInvite(relay, invite, newKeys(), { badKey: other.enrolPriv })
  assert.equal(r.first.code, 'credential')
  assert.equal(await a.client.quiet('join.request'), true)
  // The proof also binds the machine's keys: a proof for other keys does not work.
  a.client.ws.terminate()
})

test('a pending machine can talk only to members of its group and cannot act as a member', async () => {
  relay = await startTestRelay()
  const a = await createGroup(relay)
  const other = await createGroup(relay)
  const { invite } = await createInvite(a.client, a.groupId)
  const j = await joinWithInvite(relay, invite)
  const request = await a.client.until('join.request')
  // Pending to member works, member to pending works.
  j.client.send({ t: 'to', to: a.keys.machineId, k: 'hs2', sid: 's', data: 'x' })
  assert.equal((await a.client.until('from')).from, j.keys.machineId)
  a.client.send({ t: 'to', to: request.machineId, k: 'hs1', sid: 's', data: 'y' })
  assert.equal((await j.client.until('from')).from, a.keys.machineId)
  // Not another group, not itself.
  for (const to of [other.keys.machineId, j.keys.machineId, 'd'.repeat(32)]) {
    j.client.send({ t: 'to', to, k: 'hs1', sid: 'q' })
    assert.equal((await j.client.until('error')).code, 'route')
  }
  assert.equal(await other.client.quiet('from'), true)
  // Not member actions.
  const forbidden = [
    { t: 'profile.put', blob: 'b', epoch: 1 },
    { t: 'label.set', label: 'x' },
    { t: 'invite.create', id: 'zzzzzzzz', enrolPub: invite.enrolPub, expiresAt: Date.now() + 3600000, uses: 1 },
    { t: 'admit', machineId: j.keys.machineId, inviteId: invite.id, epoch: 1 },
    { t: 'leave', sig: 'x' },
  ]
  for (const f of forbidden) {
    j.client.send(f)
    assert.equal((await j.client.until('error')).code, 'route', f.t)
  }
  // It is not in the directory and the invite was not spent.
  a.client.send({ t: 'label.set', label: 'again' })
  const dir = await a.client.until('directory')
  assert.equal(dir.machines.length, 1)
  assert.equal(dir.invites[0].usesLeft, 1)
  a.client.ws.terminate()
  other.client.ws.terminate()
  j.client.ws.terminate()
})

test('nobody to admit for 60 s: error no-admitter, and the invite stays usable (mock clock)', async () => {
  const clock = fakeClock()
  relay = await startTestRelay({ clock })
  const a = await createGroup(relay)
  const { invite } = await createInvite(a.client, a.groupId, { now: clock.now() })
  a.client.ws.terminate()
  await a.client.closedPromise
  await new Promise((r) => setTimeout(r, 50))
  const j = await joinWithInvite(relay, invite)
  assert.equal(j.first.pending, true)
  clock.tick(30000)
  j.client.send({ t: 'ping' }) // a joiner's link keeps pinging while it waits
  await new Promise((r) => setTimeout(r, 50))
  clock.tick(29000)
  assert.equal(await j.client.quiet('error', 100), true)
  clock.tick(1000)
  const e = await j.client.until('error')
  assert.equal(e.code, 'no-admitter')
  await j.client.closedPromise
  // The invite is intact and a member who comes back sees it with its use left.
  const back = await joinAsMember(relay, a.groupId, a.keys)
  assert.equal(back.directory.invites[0].usesLeft, 1)
  assert.equal(back.directory.machines.length, 1, 'the pending row is gone')
  const again = await joinWithInvite(relay, invite)
  assert.equal(again.first.t, 'welcome')
  const request = await back.client.until('join.request')
  back.client.send({ t: 'admit', machineId: request.machineId, inviteId: invite.id, epoch: 1 })
  assert.ok(await back.client.until('admit.ok'))
  back.client.ws.terminate()
  again.client.ws.terminate()
})

test('a member who comes online while someone waits is asked to admit them', async () => {
  const clock = fakeClock()
  relay = await startTestRelay({ clock })
  const a = await createGroup(relay)
  const { invite } = await createInvite(a.client, a.groupId, { now: clock.now() })
  a.client.ws.terminate()
  await a.client.closedPromise
  await new Promise((r) => setTimeout(r, 50))
  const j = await joinWithInvite(relay, invite)
  const back = await joinAsMember(relay, a.groupId, a.keys)
  const request = await back.client.until('join.request')
  assert.equal(request.machineId, j.keys.machineId)
  back.client.ws.terminate()
  j.client.ws.terminate()
})

test('two pending machines on a one-use invite: exactly one admit.ok', async () => {
  relay = await startTestRelay()
  const a = await createGroup(relay)
  const { invite } = await createInvite(a.client, a.groupId)
  const j1 = await joinWithInvite(relay, invite)
  const j2 = await joinWithInvite(relay, invite)
  assert.equal(j1.first.t, 'welcome')
  assert.equal(j2.first.t, 'welcome')
  const r1 = await a.client.until('join.request')
  const r2 = await a.client.until('join.request')
  for (const r of [r1, r2]) a.client.send({ t: 'admit', machineId: r.machineId, inviteId: invite.id, epoch: 1 })
  const first = await a.client.until((f) => f.t === 'admit.ok' || f.t === 'admit.refused')
  const second = await a.client.until((f) => f.t === 'admit.ok' || f.t === 'admit.refused')
  assert.deepEqual([first.t, second.t].sort(), ['admit.ok', 'admit.refused'])
  assert.equal([first, second].find((f) => f.t === 'admit.refused').reason, 'used')
  a.client.ws.terminate()
  j1.client.ws.terminate()
  j2.client.ws.terminate()
})

test('admit with a stale epoch, for a machine that is not pending, or from a joiner is refused', async () => {
  relay = await startTestRelay()
  const a = await createGroup(relay)
  const { invite } = await createInvite(a.client, a.groupId)
  const j = await joinWithInvite(relay, invite)
  const request = await a.client.until('join.request')
  a.client.send({ t: 'admit', machineId: request.machineId, inviteId: invite.id, epoch: 9 })
  assert.deepEqual(await a.client.until('admit.refused'), { t: 'admit.refused', machineId: request.machineId, reason: 'epoch' })
  a.client.send({ t: 'admit', machineId: 'c'.repeat(32), inviteId: invite.id, epoch: 1 })
  assert.equal((await a.client.until('admit.refused')).reason, 'not-pending')
  a.client.send({ t: 'admit', machineId: request.machineId, inviteId: 'other-invite', epoch: 1 })
  assert.equal((await a.client.until('admit.refused')).reason, 'not-pending')
  // Still admissible with the right epoch.
  a.client.send({ t: 'admit', machineId: request.machineId, inviteId: invite.id, epoch: 1 })
  assert.ok(await a.client.until('admit.ok'))
  a.client.ws.terminate()
  j.client.ws.terminate()
})

test('the 51st machine is refused with machinesPerGroup; lowering the limit moves it', async () => {
  relay = await startTestRelay()
  const a = await createGroup(relay)
  const members = []
  for (let i = 1; i < 50; i++) members.push(await addMember(relay, a.client, a.groupId))
  const { invite } = await createInvite(a.client, a.groupId)
  const over = await joinWithInvite(relay, invite)
  assert.deepEqual([over.first.code, over.first.limit], ['limit', 'machinesPerGroup'])
  for (const m of members) m.client.ws.terminate()
  a.client.ws.terminate()
  await relay.close()

  relay = await startTestRelay({ env: { RELAY_MAX_MACHINES: '3' } })
  const b = await createGroup(relay)
  const b2 = await addMember(relay, b.client, b.groupId)
  const b3 = await addMember(relay, b.client, b.groupId)
  const inv2 = (await createInvite(b.client, b.groupId)).invite
  const over2 = await joinWithInvite(relay, inv2)
  assert.deepEqual([over2.first.code, over2.first.limit], ['limit', 'machinesPerGroup'])
  for (const c of [b, b2, b3]) c.client.ws.terminate()
})

test('failed invite proofs count toward the failed-attempt limit', async () => {
  relay = await startTestRelay({ env: { RELAY_AUTH_FAILS_PER_MINUTE: '2' } })
  const a = await createGroup(relay)
  const codes = []
  for (let i = 0; i < 3; i++) codes.push((await joinWithInvite(relay, newInvite(a.groupId))).first.reason ?? 'x')
  const c = await connect(relay)
  assert.ok(c)
  assert.deepEqual(codes.slice(0, 2), ['unknown', 'unknown'])
  assert.equal(codes[2], 'x', 'third attempt hit the limit, which has no reason')
  a.client.ws.terminate()
})

test('an admit right after the no-admitter timeout is refused as not-pending and spends nothing', async () => {
  const clock = fakeClock()
  relay = await startTestRelay({ clock })
  const a = await createGroup(relay)
  const { invite } = await createInvite(a.client, a.groupId, { now: clock.now() })
  const j = await joinWithInvite(relay, invite)
  const request = await a.client.until('join.request')
  clock.tick(30000)
  a.client.send({ t: 'ping' })
  j.client.send({ t: 'ping' })
  await new Promise((r) => setTimeout(r, 50))
  clock.tick(30000) // the 60 s timer fires here; the socket is not yet closed
  a.client.send({ t: 'admit', machineId: request.machineId, inviteId: invite.id, epoch: 1 })
  assert.deepEqual(await a.client.until((f) => f.t === 'admit.refused' || f.t === 'admit.ok'), {
    t: 'admit.refused',
    machineId: request.machineId,
    reason: 'not-pending',
  })
  assert.equal((await j.client.until('error')).code, 'no-admitter')
  a.client.send({ t: 'label.set', label: 'chk' })
  const dir = await a.client.until((f) => f.t === 'directory' && f.machines[0].label === 'chk')
  assert.equal(dir.invites[0].usesLeft, 1)
  assert.equal(dir.machines.length, 1)
  // The machine id is free: the same keys can try again.
  const again = await joinWithInvite(relay, invite, j.keys)
  assert.equal(again.first.t, 'welcome')
  a.client.ws.terminate()
  again.client.ws.terminate()
})

test('simultaneous admissions cannot exceed machinesPerGroup', async () => {
  relay = await startTestRelay({ env: { RELAY_MAX_MACHINES: '3' } })
  const a = await createGroup(relay)
  const b = await addMember(relay, a.client, a.groupId)
  const { invite } = await createInvite(a.client, a.groupId, { uses: 3 })
  const joiners = []
  for (let i = 0; i < 3; i++) {
    const j = await joinWithInvite(relay, invite)
    assert.equal(j.first.t, 'welcome')
    joiners.push(j)
  }
  const requests = []
  for (let i = 0; i < 3; i++) requests.push(await a.client.until('join.request'))
  for (const r of requests) a.client.send({ t: 'admit', machineId: r.machineId, inviteId: invite.id, epoch: 1 })
  const results = []
  for (let i = 0; i < 3; i++) results.push(await a.client.until((f) => f.t === 'admit.ok' || f.t === 'admit.refused'))
  assert.equal(results.filter((r) => r.t === 'admit.ok').length, 1)
  const refused = results.filter((r) => r.t === 'admit.refused')
  assert.deepEqual(refused.map((r) => r.reason), ['group-full', 'group-full'])
  const errors = []
  for (const j of joiners) {
    const e = await j.client.until((f) => f.t === 'error' || f.t === 'directory')
    if (e.t === 'error') errors.push([e.code, e.limit])
  }
  assert.deepEqual(errors, [['limit', 'machinesPerGroup'], ['limit', 'machinesPerGroup']])
  a.client.send({ t: 'label.set', label: 'chk' })
  const dir = await a.client.until((f) => f.t === 'directory' && f.machines.some((m) => m.label === 'chk'))
  assert.equal(dir.machines.length, 3)
  assert.equal(dir.invites[0].usesLeft, 2)
  a.client.ws.terminate()
  b.client.ws.terminate()
  for (const j of joiners) j.client.ws.terminate()
})

test('the 6th pending joiner on one invite is refused with the limit named', async () => {
  relay = await startTestRelay()
  const a = await createGroup(relay)
  const { invite } = await createInvite(a.client, a.groupId, { uses: 20 })
  const joiners = []
  for (let i = 0; i < 5; i++) {
    const j = await joinWithInvite(relay, invite)
    assert.equal(j.first.t, 'welcome')
    joiners.push(j)
  }
  const sixth = await joinWithInvite(relay, invite)
  assert.deepEqual([sixth.first.code, sixth.first.limit], ['limit', 'pendingPerInvite'])
  a.client.ws.terminate()
  for (const j of joiners) j.client.ws.terminate()
  await relay.close()
  relay = await startTestRelay({ env: { RELAY_MAX_PENDING_PER_INVITE: '1' } })
  const b = await createGroup(relay)
  const inv = (await createInvite(b.client, b.groupId, { uses: 5 })).invite
  const first = await joinWithInvite(relay, inv)
  const second = await joinWithInvite(relay, inv)
  assert.deepEqual([first.first.t, second.first.limit], ['welcome', 'pendingPerInvite'])
  b.client.ws.terminate()
  first.client.ws.terminate()
})
