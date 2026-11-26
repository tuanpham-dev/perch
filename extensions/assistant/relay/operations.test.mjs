import assert from 'node:assert/strict'
import { createPrivateKey, randomBytes } from 'node:crypto'
import { WebSocketServer } from 'ws'
import { test } from 'node:test'
import { canonical } from '../../_shared/relayWire.mjs'
import { connect, fakeClock, joinWithInvite, newKeys, startTestRelay } from '../../../relay/test/helpers.mjs'
import { folderBytes, startRig, until } from '../test/relayRig.mjs'
import { answerSession, decodeInvite, newIdentity, newInvite, sealTo } from './crypto.mjs'
import { createMembership } from './membership.mjs'

const text = (r) => r.content[0].text
const rejectsWith = async (p, pattern) => {
  try {
    await p
  } catch (e) {
    assert.match(e.message, pattern)
    return e
  }
  assert.fail(`expected an error matching ${pattern}`)
}
const pause = (ms) => new Promise((r) => setTimeout(r, ms))
const names = (n) => n.snap().machines.map((m) => m.display).sort()

test('create, invite, join: both sides verified, state persisted, one-use invite spent on success only', async () => {
  const rig = await startRig()
  try {
    const a = await rig.creator('alpha')
    assert.equal(a.membership.joined, true)
    assert.equal(a.membership.state.inbound, 'send')
    assert.equal(a.membership.group.epoch, 1)
    const { id, invite } = await a.link.createInvite({ uses: 1, expiresMinutes: 60 })
    // createInvite resolves on the relay's `ok`; the directory listing the invite
    // follows as a separate frame, so wait for it instead of reading at once.
    await until(() => a.snap().invites.length === 1, 3000, 'invite listed in the directory')
    assert.equal(a.snap().invites[0].held, true)

    // A refused join (name in use) does not spend the invite.
    const early = rig.node('early')
    await rejectsWith(early.link.join({ invite, name: 'alpha', allowInsecure: true }), /A machine named "alpha" is already in this group\./)
    assert.equal(early.membership.joined, false)
    assert.deepEqual(await early.fh.secrets.list(), [])
    await until(() => a.snap().invites[0]?.usesLeft === 1, 3000, 'invite unspent')

    const b = rig.node('bravo')
    await b.link.join({ invite, name: 'bravo', allowInsecure: true })
    await a.waitVerified('bravo')
    await b.waitVerified('alpha')
    assert.equal(b.membership.state.inbound, 'send')
    assert.equal(b.membership.group.secret, a.membership.group.secret)
    assert.deepEqual(Object.keys(b.membership.state.pinned), [a.mid()])
    await until(() => a.snap().invites.length === 0, 3000, 'used invite gone from the directory')
    await until(() => !Object.hasOwn(a.membership.state.invites, id), 3000, 'used invite dropped by the admitter')
    assert.ok(a.membership.state.goneInvites.includes(id))
    await until(() => a.events.some((e) => e.kind === 'joined' && e.name === 'bravo' && e.by === 'alpha'), 3000, 'event seen')
    // The invite is finished for everyone.
    const late = rig.node('late')
    await rejectsWith(late.link.join({ invite, name: 'late', allowInsecure: true }), /This invite has already been used\./)
    // Both are in a group; each refuses to create or join again.
    await rejectsWith(b.link.join({ invite, name: 'x', allowInsecure: true }), /already in a relay group/)
    await rejectsWith(a.link.create({ relayUrl: rig.relay.url, adminSecret: 'x', name: 'x', allowInsecure: true }), /already in a relay group/)
  } finally {
    await rig.close()
  }
})

test('two newcomers racing on a one-use invite: one joins, the other is denied and holds nothing', async () => {
  const rig = await startRig()
  try {
    const a = await rig.creator('alpha')
    const { invite } = await a.link.createInvite({ uses: 1, expiresMinutes: 60 })
    const n1 = rig.node('one')
    const n2 = rig.node('two')
    const results = await Promise.allSettled([
      n1.link.join({ invite, name: 'one', allowInsecure: true }),
      n2.link.join({ invite, name: 'two', allowInsecure: true }),
    ])
    const ok = results.filter((r) => r.status === 'fulfilled')
    const denied = results.filter((r) => r.status === 'rejected')
    assert.equal(ok.length, 1)
    assert.equal(denied.length, 1)
    assert.match(denied[0].reason.message, /already been used|group changed/)
    const loser = results[0].status === 'rejected' ? n1 : n2
    const winner = loser === n1 ? n2 : n1
    assert.equal(loser.membership.joined, false)
    assert.deepEqual(await loser.fh.secrets.list(), [])
    assert.equal(winner.membership.joined, true)
    await a.waitVerified(winner.name)
    assert.equal(a.snap().machines.length, 2)
  } finally {
    await rig.close()
  }
})

test('an invite already expired is refused locally; a bad string and bad names are refused', async () => {
  const rig = await startRig()
  try {
    const a = await rig.creator('alpha')
    const old = newInvite({ relay: rig.relay.url, group: a.membership.state.groupId, expiresAt: Date.now() - 1000 })
    const n = rig.node('n')
    await rejectsWith(n.link.join({ invite: old.string, name: 'n', allowInsecure: true }), /^This invite has expired\.$/)
    await rejectsWith(n.link.join({ invite: 'nonsense', name: 'n', allowInsecure: true }), /That is not a Perch invite\./)
    const { invite } = await a.link.createInvite({ uses: 1, expiresMinutes: 60 })
    await rejectsWith(n.link.join({ invite, name: 'has space', allowInsecure: true }), /may use letters/)
    await rejectsWith(n.link.join({ invite, name: '', allowInsecure: true }), /may use letters/)
    const remote = newInvite({ relay: 'ws://relay.example.com', group: a.membership.state.groupId, expiresAt: Date.now() + 600000 })
    await rejectsWith(n.link.join({ invite: remote.string, name: 'n' }), /must start with wss:\/\//)
    await rejectsWith(a.link.createInvite({ uses: 0 }), /1 to 20/)
    await rejectsWith(a.link.createInvite({ expiresMinutes: 5 }), /10 minutes to 7 days/)
    await rejectsWith(a.link.createInvite({ uses: 21 }), /1 to 20/)
  } finally {
    await rig.close()
  }
})

test('join with nobody to admit fails with that text after 60 s, and works later with the same invite (A7)', async () => {
  const clock = fakeClock(Date.now())
  const rig = await startRig({ clock })
  try {
    const a = await rig.creator('alpha')
    const { invite } = await a.link.createInvite({ uses: 1, expiresMinutes: 60 })
    a.stop()
    await pause(100)
    clock.tick(1)
    const n = rig.node('newcomer')
    const joining = n.link.join({ invite, name: 'newcomer', allowInsecure: true })
    joining.catch(() => {})
    await pause(300)
    clock.tick(60001)
    await rejectsWith(joining, /^No machine that holds this invite is online\. Ask the machine that created it to be online and try again\.$/)
    assert.equal(n.membership.joined, false)
    // The inviter comes back; the same invite still works.
    await a.restart()
    await until(() => a.link.status === 'connected', 5000, 'alpha reconnected')
    await n.link.join({ invite, name: 'newcomer', allowInsecure: true })
    await a.waitVerified('newcomer')
  } finally {
    await rig.close()
  }
})

test('a member that was online at creation admits when the creator is offline', async () => {
  const rig = await startRig()
  try {
    const a = await rig.creator('alpha')
    const b = await rig.joiner(a, 'bravo')
    const { id, invite } = await a.link.createInvite({ uses: 1, expiresMinutes: 60 })
    await until(() => Object.hasOwn(b.membership.state.invites, id), 3000, 'invite shared with bravo')
    a.stop()
    await b.waitOnline('alpha', false)
    const c = rig.node('charlie')
    await c.link.join({ invite, name: 'charlie', allowInsecure: true })
    await b.waitVerified('charlie')
    // Charlie got the member list from the admitter: alpha is pinned and verified though offline.
    await c.waitVerified('bravo')
    assert.equal(c.trustOf('alpha'), 'verified')
    assert.equal(c.machine('alpha').online, false)
    await until(() => b.events.some((e) => e.kind === 'joined' && e.name === 'charlie'), 3000, 'event seen')
  } finally {
    await rig.close()
  }
})

test('a member offline when an invite was revoked drops it on its next directory and on invites.sync', async () => {
  const rig = await startRig()
  try {
    const a = await rig.creator('alpha')
    const b = await rig.joiner(a, 'bravo')
    const { id } = await a.link.createInvite({ uses: 3, expiresMinutes: 60 })
    await until(() => Object.hasOwn(b.membership.state.invites, id), 3000, 'shared')
    b.stop()
    await a.waitOnline('bravo', false)
    await a.link.revokeInvite(id)
    assert.ok(a.membership.state.goneInvites.includes(id))
    await b.restart()
    await until(() => b.link.status === 'connected', 5000, 'bravo back')
    await until(() => !Object.hasOwn(b.membership.state.invites, id), 3000, 'dropped on directory')
    assert.ok(b.membership.state.goneInvites.includes(id))

    // invites.sync: a held id that the peer lists as gone is deleted on session setup.
    b.membership.state.invites.ghost = { admit: randomBytes(32).toString('base64url'), expiresAt: Date.now() + 600000 }
    a.membership.dropInvite('ghost')
    assert.ok(Object.hasOwn(b.membership.state.invites, 'ghost'))
    await a.link.call(b.mid(), 'ping', {})
    await until(() => !Object.hasOwn(b.membership.state.invites, 'ghost'), 3000, 'dropped on invites.sync')
    assert.ok(b.membership.state.goneInvites.includes('ghost'))
  } finally {
    await rig.close()
  }
})

test('rename and name rules (A34)', async () => {
  const rig = await startRig()
  try {
    const a = await rig.creator('alpha')
    const b = await rig.joiner(a, 'bravo')
    await rejectsWith(b.link.rename('alpha'), /A machine named "alpha" is already in this group\./)
    await rejectsWith(b.link.rename('has space'), /may use letters/)
    await b.link.rename('bravo2')
    assert.equal(b.membership.state.name, 'bravo2')
    await until(() => a.machine('bravo2')?.trust === 'verified', 5000, 'rename visible')
    assert.equal(a.machine('bravo'), undefined)
    // The renamed event is a separate peer message from the directory update: wait for it.
    await until(() => a.events.some((e) => e.kind === 'renamed' && e.to === 'bravo2'), 3000, 'renamed event')
    // A session opened before the rename still works under the new name.
    assert.equal(text(await a.link.call(b.mid(), 'x', {})), 'bravo ran x')
    assert.equal(b.inboundCalls[0].peer.name, 'alpha')
  } finally {
    await rig.close()
  }
})

test('two machines forced onto one name show as name~xxxx', async () => {
  const rig = await startRig()
  try {
    const a = await rig.creator('alpha')
    const b = await rig.joiner(a, 'bravo')
    b.membership.state.name = 'alpha'
    await b.link.setInbound('read')
    const dup = `alpha~${b.mid().slice(0, 4)}`
    await until(() => a.machine(dup), 5000, 'duplicate display name')
    assert.deepEqual(names(a), [`alpha~${a.mid().slice(0, 4)}`, dup].sort())
    assert.equal(a.link.machineByName('alpha'), null)
    assert.equal(a.link.machineByName(dup).id, b.mid())
  } finally {
    await rig.close()
  }
})

test('label and permission', async () => {
  const rig = await startRig()
  try {
    const a = await rig.creator('alpha')
    const b = await rig.joiner(a, 'bravo')
    await a.link.setLabel('build-box')
    assert.equal(a.membership.state.label, 'build-box')
    await until(() => b.snap().machines.find((m) => m.self === false)?.label === 'build-box', 3000, 'label in directory')
    await a.link.setLabel('')
    await until(() => b.snap().machines.find((m) => m.self === false)?.label === '', 3000, 'label cleared')
    await rejectsWith(a.link.setLabel('has space'), /may use letters/)
    await rejectsWith(a.link.setInbound('everything'), /Others may/)
    await a.link.setInbound('off')
    assert.equal(a.membership.state.inbound, 'off')
    assert.deepEqual(a.inboundSettings, ['off'])
    await until(() => b.machine('alpha').accepts === 'off', 3000, 'profile shows off')
  } finally {
    await rig.close()
  }
})

test('remove with re-key: offline member converges, removed machine clears only through a verified record, invites cancelled (A31)', async () => {
  const hooks = {}
  const rig = await startRig({ hooks })
  try {
    const a = await rig.creator('alpha')
    const b = await rig.joiner(a, 'bravo')
    const c = await rig.joiner(a, 'charlie')
    await b.waitVerified('charlie')
    await c.waitVerified('bravo')
    const { id: heldId, invite: oldInvite } = await a.link.createInvite({ uses: 2, expiresMinutes: 60 })
    await until(() => Object.hasOwn(c.membership.state.invites, heldId), 3000, 'invite reached charlie')
    // Remember bravo's directory row for the "relay re-adds it" test below.
    let bravoRow = null
    hooks.onSend = (frame, to) => {
      if (frame.t === 'directory' && to.machineId === c.mid()) bravoRow ||= frame.machines.find((m) => m.id === b.mid())
      return undefined
    }
    await a.link.setLabel('x')
    await until(() => bravoRow, 3000, 'bravo row captured')
    c.stop()
    await a.waitOnline('charlie', false)

    await a.link.remove(b.mid())
    assert.equal(a.membership.group.epoch, 2)
    await until(() => !a.snap().machines.some((m) => m.id === b.mid()), 3000, 'alpha directory without bravo')
    assert.deepEqual(names(a), ['alpha', 'charlie'])
    assert.ok(a.membership.state.removed.includes(b.mid()))
    assert.deepEqual(a.membership.state.invites, {}, 'held invites deleted by the re-key')
    // Bravo was online: its relay connection ended with a signed record.
    await until(() => !b.membership.joined, 3000, 'bravo cleared')
    assert.deepEqual(await b.fh.secrets.list(), [])
    await until(() => b.events.some((e) => e.kind === 'self-removed'), 3000, 'event seen')
    await until(() => a.events.some((e) => e.kind === 'removed' && e.name === 'bravo' && e.by === 'alpha'), 3000, 'event seen')

    a.stop()
    await c.restart()
    await until(() => c.membership.group.epoch === 2, 5000, 'charlie applied the re-key')
    assert.equal(c.membership.group.secret, a.membership.group.secret)
    await until(() => c.snap().machines.length === 2, 3000, 'charlie directory')
    assert.deepEqual(names(c), ['alpha', 'charlie'])
    assert.deepEqual(c.membership.state.invites, {})
    await until(() => c.events.some((e) => e.kind === 'removed' && e.name === 'bravo'), 3000, 'event seen')
    assert.ok(c.membership.state.removed.includes(b.mid()))

    await a.restart()
    await until(() => a.link.status === 'connected', 5000, 'alpha back')
    await a.waitVerified('charlie')
    await c.waitVerified('alpha')
    assert.equal(text(await a.link.call(c.mid(), 'hello', {})), 'charlie ran hello')
    assert.equal(text(await c.link.call(a.mid(), 'hello', {})), 'alpha ran hello')

    // The invite made before the removal was cancelled at the relay.
    const late = rig.node('late')
    await rejectsWith(late.link.join({ invite: oldInvite, name: 'late', allowInsecure: true }), /^This invite was cancelled when a machine was removed\.$/)

    // A relay that lists bravo again does not make it verified or callable.
    hooks.onSend = (frame, to) => {
      if (frame.t !== 'directory' || to.machineId !== c.mid()) return undefined
      return { ...frame, machines: [...frame.machines.filter((m) => m.id !== b.mid()), bravoRow] }
    }
    await a.link.setLabel('y')
    await until(() => c.snap().machines.some((m) => m.id === b.mid()), 3000, 'bravo row re-added')
    assert.equal(c.snap().machines.find((m) => m.id === b.mid()).trust, 'unverified')
    await assert.rejects(c.link.call(b.mid(), 'x', {}), { code: 'unverified' })
  } finally {
    await rig.close()
  }
})

test('a newcomer can remove a machine, and an offline member that never pinned it adopts the re-key', async () => {
  const rig = await startRig()
  try {
    const a = await rig.creator('alpha')
    const b = await rig.joiner(a, 'bravo')
    const c = await rig.joiner(a, 'charlie')
    await b.waitVerified('charlie')
    c.stop()
    await a.waitOnline('charlie', false)
    const d = await rig.joiner(a, 'delta')
    assert.ok(!Object.hasOwn(c.membership.state.pinned, d.mid()))
    await d.link.remove(b.mid())
    await until(() => d.membership.group.epoch === 2, 5000, 'delta re-keyed')
    await c.restart()
    await until(() => c.membership.group.epoch === 2, 5000, 'charlie adopted delta re-key')
    assert.equal(c.membership.group.secret, d.membership.group.secret)
    assert.ok(Object.hasOwn(c.membership.state.pinned, d.mid()), 'the remover is pinned')
    await until(() => c.trustOf('delta') === 'verified', 5000, 'charlie verifies delta')
    assert.ok(c.membership.state.removed.includes(b.mid()))
    assert.equal(text(await c.link.call(d.mid(), 'hi', {})), 'delta ran hi')
  } finally {
    await rig.close()
  }
})

test('a relay that swaps a re-key package is refused: the old group is kept, state rekey-failed', async () => {
  const hooks = {}
  const rig = await startRig({ hooks })
  try {
    const a = await rig.creator('alpha')
    const b = await rig.joiner(a, 'bravo')
    const c = await rig.joiner(a, 'charlie')
    await b.waitVerified('charlie')
    await c.waitVerified('bravo')
    const oldSecret = c.membership.group.secret
    hooks.onSend = (frame, to) => {
      if (frame.t !== 'rekey' || to.machineId !== c.mid()) return undefined
      const { sig, ...body } = frame.record
      const aad = canonical(body) + '\n' + c.mid()
      return { ...frame, sealed: sealTo(c.membership.identity.dhPub, randomBytes(32), aad).toString('base64url') }
    }
    await a.link.remove(b.mid())
    await until(() => c.link.status === 'refused', 3000, 'charlie refused the package')
    assert.equal(c.link.snapshot().reasonCode, 'rekey-failed')
    assert.equal(c.membership.group.epoch, 1)
    assert.equal(c.membership.group.secret, oldSecret)
    assert.ok(!c.membership.state.removed.includes(b.mid()))
  } finally {
    await rig.close()
  }
})

test('an old record sent again is skipped and changes nothing (replay)', async () => {
  const hooks = {}
  const rig = await startRig({ hooks })
  try {
    const a = await rig.creator('alpha')
    const b = await rig.joiner(a, 'bravo')
    const c = await rig.joiner(a, 'charlie')
    await b.waitVerified('charlie')
    let rekey = null
    hooks.onSend = (frame, to) => {
      if (frame.t === 'rekey' && to.machineId === c.mid()) rekey = frame
      return undefined
    }
    await a.link.remove(b.mid())
    await until(() => rekey && c.membership.group.epoch === 2, 5000, 'charlie re-keyed')
    const secret = c.membership.group.secret
    const events = c.events.length
    rig.relay.inject(c.membership.state.groupId, c.mid(), rekey)
    await pause(300)
    assert.equal(c.membership.group.epoch, 2)
    assert.equal(c.membership.group.secret, secret)
    assert.equal(c.events.length, events)
    assert.equal(c.link.status, 'connected')
  } finally {
    await rig.close()
  }
})

test('held-invite abuse: after a removal no member starts an admission on a pre-removal invite', async () => {
  const hooks = {}
  const rig = await startRig({ hooks })
  try {
    const a = await rig.creator('alpha')
    const b = await rig.joiner(a, 'bravo')
    const c = await rig.joiner(a, 'charlie')
    await b.waitVerified('charlie')
    const { id } = await a.link.createInvite({ uses: 5, expiresMinutes: 60 })
    await until(() => Object.hasOwn(b.membership.state.invites, id), 3000, 'shared with bravo')
    await a.link.remove(c.mid())
    await until(() => b.membership.group.epoch === 2, 5000, 'bravo re-keyed')
    const hs1 = []
    hooks.onForward = (frame) => (frame.k === 'hs1' && hs1.push(frame), undefined)
    const stranger = newKeys()
    const request = { t: 'join.request', machineId: stranger.machineId, inviteId: id, signPub: stranger.signPub, dhPub: stranger.dhPub }
    for (const n of [a, b]) rig.relay.inject(a.membership.state.groupId, n.mid(), request)
    // Even the removed machine's id on a request is ignored.
    rig.relay.inject(a.membership.state.groupId, a.mid(), { ...request, machineId: c.mid() })
    await pause(400)
    assert.equal(hs1.length, 0)
  } finally {
    await rig.close()
  }
})

test('the remover killed after remove.ok applies its own package on restart and matches the others', async () => {
  const hooks = {}
  const rig = await startRig({ hooks })
  try {
    const a = await rig.creator('alpha')
    const b = await rig.joiner(a, 'bravo')
    const c = await rig.joiner(a, 'charlie')
    await b.waitVerified('charlie')
    await c.waitVerified('bravo')
    let swallowed = false
    hooks.onSend = (frame, to) => {
      if (frame.t === 'rekey' && to.machineId === a.mid() && !swallowed) {
        swallowed = true
        return null
      }
      return undefined
    }
    const removing = a.link.remove(b.mid())
    removing.catch(() => {})
    await until(() => swallowed, 3000, 'remove.ok sent, own package withheld')
    assert.equal(a.membership.group.epoch, 1)
    a.stop() // killed
    await rejectsWith(removing, /./)
    await until(() => c.membership.group.epoch === 2, 3000, 'charlie re-keyed')
    await a.restart()
    await until(() => a.membership.group.epoch === 2, 5000, 'alpha applied its own package')
    assert.equal(a.membership.group.secret, c.membership.group.secret)
    await a.waitVerified('charlie')
    assert.equal(text(await a.link.call(c.mid(), 'ok', {})), 'charlie ran ok')
  } finally {
    await rig.close()
  }
})

test('two simultaneous removals converge on one group (A32)', async () => {
  const rig = await startRig()
  try {
    const a = await rig.creator('alpha')
    const b = await rig.joiner(a, 'bravo')
    const c = await rig.joiner(a, 'charlie')
    const d = await rig.joiner(a, 'delta')
    for (const n of [a, b, c, d]) for (const m of [a, b, c, d]) if (n !== m) await n.waitVerified(m.name)
    await Promise.all([a.link.remove(c.mid()), b.link.remove(d.mid())])
    await until(() => a.membership.group.epoch === 3 && b.membership.group.epoch === 3, 8000, 'epoch 3')
    assert.equal(a.membership.group.secret, b.membership.group.secret)
    assert.deepEqual(names(a), ['alpha', 'bravo'])
    assert.deepEqual(names(b), ['alpha', 'bravo'])
    await until(() => !c.membership.joined && !d.membership.joined, 5000, 'removed machines cleared')
    await a.waitVerified('bravo')
    assert.equal(text(await a.link.call(b.mid(), 'ok', {})), 'bravo ran ok')
  } finally {
    await rig.close()
  }
})

test('leave online and offline (A33)', async () => {
  const rig = await startRig()
  try {
    const a = await rig.creator('alpha')
    const b = await rig.joiner(a, 'bravo')
    const c = await rig.joiner(a, 'charlie')
    await b.waitVerified('charlie')
    const out = await b.link.leave()
    assert.deepEqual(out, { relayEntryRemoved: true })
    assert.equal(b.membership.joined, false)
    assert.deepEqual(await b.fh.secrets.list(), [])
    assert.equal(b.activityCleared, 1)
    await until(() => a.snap().machines.length === 2, 3000, 'alpha no longer lists bravo')
    await until(() => a.events.some((e) => e.kind === 'left' && e.by === 'bravo'), 3000, 'event seen')
    // Not connected: the membership is cleared anyway.
    c.stop()
    const offline = await c.link.leave()
    assert.deepEqual(offline, { relayEntryRemoved: false })
    assert.equal(c.membership.joined, false)
    assert.deepEqual(await c.fh.secrets.list(), [])
    // The relay still lists charlie until an admin removes it; the group works for the rest.
    assert.equal(a.membership.joined, true)
  } finally {
    await rig.close()
  }
})

test('after the whole flow the relay data folder holds no name, invite secret or group secret (A27)', async () => {
  const rig = await startRig()
  try {
    const a = await rig.creator('alpha-secretname')
    const first = await a.link.createInvite({ uses: 1, expiresMinutes: 60 })
    const b = rig.node('bravo-secretname')
    await b.link.join({ invite: first.invite, name: 'bravo-secretname', allowInsecure: true })
    await a.waitVerified('bravo-secretname')
    await a.link.setLabel('label-ok')
    const second = await a.link.createInvite({ uses: 1, expiresMinutes: 60 })
    const c = rig.node('charlie-secretname')
    await c.link.join({ invite: second.invite, name: 'charlie-secretname', allowInsecure: true })
    await a.waitVerified('charlie-secretname')
    await a.link.call(b.mid(), 'marker', { text: 'payload-marker' })
    const firstSecrets = decodeInvite(first.invite)
    const secrets = [
      ['machine name', 'alpha-secretname'],
      ['machine name', 'bravo-secretname'],
      ['machine name', 'charlie-secretname'],
      ['enrolment key', firstSecrets.enrolKey],
      ['admission secret', firstSecrets.admit],
      ['admission secret', decodeInvite(second.invite).admit],
      ['group secret', a.membership.group.secret],
      ['signing key', a.membership.identity.signKey],
    ]
    await a.link.remove(c.mid())
    secrets.push(['group secret', a.membership.group.secret])
    const bytes = folderBytes(rig.relay.dir)
    assert.ok(bytes.length > 1000)
    for (const [what, value] of secrets) {
      assert.ok(!bytes.includes(Buffer.from(value)), `the relay stored a ${what} as text`)
      if (/^[A-Za-z0-9_-]{40,}$/.test(value)) assert.ok(!bytes.includes(Buffer.from(value, 'base64url')), `the relay stored a ${what} as bytes`)
    }
  } finally {
    await rig.close()
  }
})

test('a version error on the responder side is unauthenticated: logged, no state, no notice', async () => {
  const hooks = {}
  const rig = await startRig({ hooks })
  try {
    const a = await rig.creator('alpha')
    const b = await rig.joiner(a, 'bravo')
    let hs2 = 0
    hooks.onForward = (frame, from) => {
      if (frame.k === 'hs2') hs2++
      if (frame.k === 'hs1' && from.machineId === a.mid()) {
        const msg1 = JSON.parse(Buffer.from(frame.data, 'base64'))
        return { ...frame, data: Buffer.from(JSON.stringify({ ...msg1, v: [2, 2] })).toString('base64') }
      }
      return undefined
    }
    const events = b.events.length
    const pending = a.link.call(b.mid(), 'x', {})
    pending.catch(() => {})
    await pause(400)
    assert.equal(hs2, 0)
    assert.equal(b.events.length, events)
    assert.ok(b.logs.some((l) => /not answered version/.test(l)))
    assert.equal(b.inboundCalls.length, 0)
    a.stop()
    await assert.rejects(pending, { code: 'not-connected' })
  } finally {
    await rig.close()
  }
})

test('admission: a wrong admission secret never reaches admit, and the invite is not spent', async () => {
  const rig = await startRig()
  try {
    const a = await rig.creator('alpha')
    const { invite } = await a.link.createInvite({ uses: 1, expiresMinutes: 60 })
    const inv = decodeInvite(invite)
    const keys = newKeys()
    const ident = newIdentity()
    const joined = await joinWithInvite(
      rig.relay,
      { id: inv.invite, groupId: inv.group, enrolPriv: createPrivateKey({ key: Buffer.from(inv.enrolKey, 'base64url'), format: 'der', type: 'pkcs8' }) },
      keys,
    )
    assert.equal(joined.first.t, 'welcome')
    const hs1 = await joined.client.until((f) => f.t === 'from' && f.k === 'hs1')
    const msg1 = JSON.parse(Buffer.from(hs1.data, 'base64'))
    const wrong = randomBytes(32).toString('base64url')
    const self = { ...ident, machineId: keys.machineId, signKey: keys.signPriv.export({ format: 'der', type: 'pkcs8' }).toString('base64url') }
    const reply = answerSession(self, inv.group, hs1.from, msg1.signPub, msg1, wrong)
    joined.client.send({ t: 'to', to: hs1.from, k: 'hs2', sid: hs1.sid, data: Buffer.from(JSON.stringify(reply.msg2)).toString('base64') })
    await until(() => a.logs?.some((l) => /handshake failed psk/.test(l)), 3000, 'alpha refused the wrong secret')
    assert.equal(await joined.client.quiet((f) => f.t === 'from' && f.k === 'hs3', 300), true)
    assert.equal(a.snap().machines.length, 1)
    await joined.client.closeAndWait()
    await until(() => a.snap().invites[0]?.usesLeft === 1, 3000, 'invite unspent')
    // A real newcomer can still use it.
    const n = rig.node('real')
    await n.link.join({ invite, name: 'real', allowInsecure: true })
    await a.waitVerified('real')
  } finally {
    await rig.close()
  }
})

test('a relay that is unreachable or refuses the admin secret gives the plain messages', async () => {
  const rig = await startRig()
  try {
    const n = rig.node('n')
    await rejectsWith(n.link.create({ relayUrl: rig.relay.url, adminSecret: 'wrong', name: 'n', allowInsecure: true }), /^The relay did not accept that admin secret\.$/)
    await rejectsWith(n.link.create({ relayUrl: 'ws://127.0.0.1:1', adminSecret: 'x', name: 'n' }), /^Could not reach the relay\.$/)
    await rejectsWith(n.link.create({ relayUrl: 'ws://relay.example.com', adminSecret: 'x', name: 'n' }), /must start with wss:\/\//)
    await rejectsWith(n.link.create({ relayUrl: rig.relay.url, adminSecret: 'x', name: 'bad name', allowInsecure: true }), /may use letters/)
    assert.equal(n.membership.joined, false)
    assert.deepEqual(await n.fh.secrets.list(), [])
    await connect(rig.relay).then((c) => c.ws.terminate())
    void startTestRelay
  } finally {
    await rig.close()
  }
})

test('F1a: a removal between the admission handshake and join.name stops the grant', async () => {
  const hooks = {}
  const lines = []
  const rig = await startRig({ hooks, log: (l) => lines.push(l) })
  try {
    const a = await rig.creator('alpha')
    const b = await rig.joiner(a, 'bravo')
    const c = await rig.joiner(a, 'charlie')
    await b.waitVerified('charlie')
    const { invite } = await a.link.createInvite({ uses: 2, expiresMinutes: 60 })
    const held = []
    // Any member holding the invite may admit the newcomer (they all received it), so hold the
    // newcomer's data frames to whichever member it talks to, and remember that member.
    const members = [a.mid(), b.mid(), c.mid()]
    hooks.onForward = (frame, from, to) => {
      if (members.includes(to.machineId) && frame.k === 'data' && !members.includes(from.machineId)) return held.push({ frame, to: to.machineId }), null
      return undefined
    }
    const mark = lines.length
    const n = rig.node('newbie')
    const joining = n.link.join({ invite, name: 'newbie', allowInsecure: true })
    joining.catch(() => {})
    await until(() => held.length >= 1, 15000, 'join.name held by the relay')
    // Remove a member that is not the admitter, so the admitter sees the re-key mid-admission.
    const victim = held[0].to === c.mid() ? b.mid() : c.mid()
    await a.link.remove(victim)
    assert.deepEqual(a.membership.state.invites, {})
    assert.ok(a.membership.state.goneInvites.length >= 1)
    // The relay now delivers the old join.name.
    rig.relay.inject(a.membership.state.groupId, held[0].to, held[0].frame)
    await rejectsWith(joining, /cancelled|did not finish|changed/)
    await pause(300)
    assert.equal(n.membership.joined, false)
    assert.deepEqual(await n.fh.secrets.list(), [])
    assert.ok(!a.events.some((e) => e.kind === 'joined' && e.name === 'newbie'))
    assert.ok(!lines.slice(mark).some((l) => members.some((m) => l.includes(`machine=${m}`)) && /type=admit /.test(l + ' ')))
  } finally {
    await rig.close()
  }
})

test('F1b: a pre-removal invite shared by a member that missed the re-key is refused as gone', async () => {
  const hooks = {}
  const rig = await startRig({ hooks })
  try {
    const a = await rig.creator('alpha')
    const b = await rig.joiner(a, 'bravo')
    const c = await rig.joiner(a, 'charlie')
    await b.waitVerified('charlie')
    const { id } = await a.link.createInvite({ uses: 2, expiresMinutes: 60 })
    await until(() => Object.hasOwn(b.membership.state.invites, id), 3000, 'shared with bravo')
    hooks.onSend = (frame, to) => (frame.t === 'rekey' && to.machineId === b.mid() ? null : undefined)
    await a.link.remove(c.mid())
    const stale = b.membership.state.invites[id]
    assert.ok(stale, 'bravo never got the re-key and still holds the invite')
    assert.ok(a.membership.state.goneInvites.includes(id))
    await b.link.broadcast({ t: 'invite.share', id, admit: stale.admit, expiresAt: stale.expiresAt })
    await pause(300)
    assert.ok(!Object.hasOwn(a.membership.state.invites, id))
  } finally {
    await rig.close()
  }
})

test('F2: a crash between the two re-key writes leaves the removal recorded; a failed group write sends no profile', async () => {
  const lines = []
  const rig = await startRig({ log: (l) => lines.push(l) })
  try {
    const a = await rig.creator('alpha')
    const b = await rig.joiner(a, 'bravo')
    const c = await rig.joiner(a, 'charlie')
    await b.waitVerified('charlie')
    await c.waitVerified('bravo')
    const bid = b.mid()
    const cid = c.mid()
    const puts = () => lines.filter((l) => l.includes(`machine=${cid}`) && l.includes('type=profile.put')).length
    const before = puts()
    const realSet = c.fh.secrets.set
    c.fh.secrets.set = async (k, v) => {
      if (k === 'relay.group') throw new Error('disk full')
      return realSet(k, v)
    }
    const oldEpoch = c.membership.group.epoch
    await a.link.remove(bid)
    await until(() => c.link.status === 'refused', 3000, 'charlie could not save')
    assert.equal(c.link.snapshot().reasonCode, 'rekey-failed')
    assert.equal(c.membership.group.epoch, oldEpoch, 'memory stays at the old epoch')
    await pause(200)
    assert.equal(puts(), before, 'no profile.put after a failed write')
    // What reached the disk: the removal is recorded and the machine unpinned.
    const disk = createMembership({ secrets: c.fh.secrets })
    assert.equal(await disk.load(), true)
    assert.ok(disk.state.removed.includes(bid))
    assert.ok(!Object.hasOwn(disk.state.pinned, bid))
    assert.equal(disk.group.epoch, oldEpoch)
    // Restart: the package is applied again and the group matches.
    c.fh.secrets.set = realSet
    await c.restart()
    await until(() => c.membership.group.epoch === oldEpoch + 1, 5000, 'charlie applied the re-key after restart')
    assert.equal(c.membership.group.secret, a.membership.group.secret)
  } finally {
    await rig.close()
  }
})

test('F3: a machine admitted just before a removal is reported by the relay and shows the missed-key reason', async () => {
  const hooks = {}
  const rig = await startRig({ hooks })
  try {
    const a = await rig.creator('alpha')
    const b = await rig.joiner(a, 'bravo')
    const x = await rig.joiner(a, 'xray')
    await b.waitVerified('xray')
    // Alpha never hears of the newcomer: its directory frames are withheld.
    hooks.onSend = (frame, to) => (frame.t === 'directory' && to.machineId === a.mid() ? null : undefined)
    const { invite } = await a.link.createInvite({ uses: 1, expiresMinutes: 60 })
    const n = rig.node('newbie')
    await n.link.join({ invite, name: 'newbie', allowInsecure: true })
    await until(() => n.link.status === 'connected', 3000, 'newbie connected')
    await a.link.remove(x.mid())
    await until(() => a.events.some((e) => e.kind === 'package-missing' && e.id === n.mid()), 3000, 'event seen')
    await until(() => n.link.status === 'refused', 5000, 'newbie sees the missed key')
    assert.equal(n.link.snapshot().reason, 'This machine missed a key change. Leave the group and join again with a new invite.')
    assert.equal(n.link.snapshot().reasonCode, 'missed-key')
    assert.equal(n.membership.joined, true)
  } finally {
    await rig.close()
  }
})

test('F6: a relay that pings but never answers the join ends in a timeout, and the next operation can start', async () => {
  const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 })
  await new Promise((r) => wss.once('listening', r))
  wss.on('connection', (ws) => ws.on('error', () => {}))
  const url = `ws://127.0.0.1:${wss.address().port}`
  const clock = fakeClock(Date.now())
  const rig = await startRig()
  try {
    const n = rig.node('newbie', { clock })
    const inv = newInvite({ relay: url, group: 'a'.repeat(32), expiresAt: Date.now() + 3600000 })
    const joining = n.link.join({ invite: inv.string, name: 'newbie' })
    joining.catch(() => {})
    await until(() => wss.clients.size === 1, 3000, 'socket open')
    for (const step of [20000, 20000, 20000, 20000, 10000]) {
      await pause(50)
      for (const ws of wss.clients) ws.send(JSON.stringify({ t: 'ping' }))
      await pause(50)
      clock.tick(step)
    }
    await rejectsWith(joining, /^The relay did not finish the join\. Try again\.$/)
    // busy is clear: another operation gets its own answer.
    await rejectsWith(n.link.create({ relayUrl: 'ws://127.0.0.1:1', adminSecret: 'x', name: 'newbie' }), /^Could not reach the relay\.$/)
  } finally {
    await rig.close()
    for (const ws of wss.clients) ws.terminate()
    wss.close()
  }
})

test('F6: turning Assistant Read-only on republishes accepts read without any state request', async () => {
  const clock = fakeClock(Date.now())
  const rig = await startRig()
  try {
    const a = await rig.creator('alpha')
    const b = await rig.joiner(a, 'bravo', { clock })
    assert.equal(a.machine('bravo').accepts, 'send')
    b.readOnly = true
    clock.tick(10000)
    await until(() => a.machine('bravo').accepts === 'read', 3000, 'accepts follows Read-only')
    b.readOnly = false
    clock.tick(10000)
    await until(() => a.machine('bravo').accepts === 'send', 3000, 'accepts back to send')
    // An inbound call also checks.
    b.readOnly = true
    await a.link.call(b.mid(), 'x', {})
    await until(() => a.machine('bravo').accepts === 'read', 3000, 'accepts follows Read-only on a call')
  } finally {
    await rig.close()
  }
})

test("a refusal of another request in flight does not fail this one", async () => {
  const rig = await startRig()
  try {
    const a = await rig.creator('alpha')
    const pending = a.link.setLabel('desk')
    // Arrives before the relay's answer to label.set: a refused profile.put.
    rig.relay.inject(a.membership.state.groupId, a.mid(), { t: 'error', code: 'limit', message: 'Too big.', re: 'profile.put', limit: 'profileBytes' })
    await pending
    assert.equal(a.membership.state.label, 'desk')
  } finally {
    await rig.close()
  }
})
