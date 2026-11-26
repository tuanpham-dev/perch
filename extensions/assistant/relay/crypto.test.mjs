import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { PROFILE_MAX, challengeString } from '../../_shared/relayWire.mjs'
import {
  acceptRemoval,
  answerSession,
  checkVouch,
  confirmSession,
  decodeInvite,
  finishSession,
  joinProof,
  makeRemoval,
  newIdentity,
  newInvite,
  open,
  openProfile,
  openSealed,
  seal,
  sealProfile,
  sealTo,
  sign,
  startSession,
  verifyRemovalRecord,
  verifySig,
  vouchFor,
} from './crypto.mjs'

const GROUP = 'a'.repeat(32)
const SECRET = Buffer.alloc(32, 7).toString('base64url')

function pair(groupId = GROUP, ...psk) {
  const a = newIdentity()
  const b = newIdentity()
  const { state, msg1 } = startSession(a, groupId)
  const { pending, msg2 } = answerSession(b, groupId, a.machineId, a.signPub, msg1, ...psk)
  const fin = finishSession(state, b.machineId, b.signPub, msg2, ...psk)
  const sb = confirmSession(pending, fin.msg3)
  return { a, b, sa: fin.session, sb }
}

const throwsCode = (fn, code) =>
  assert.throws(fn, (e) => {
    assert.equal(e.code, code, e.message)
    return true
  })

test('identity and signatures', () => {
  const id = newIdentity()
  assert.match(id.machineId, /^[0-9a-f]{32}$/)
  assert.match(id.signPub, /^[A-Za-z0-9_-]{43}$/)
  assert.match(id.dhPub, /^[A-Za-z0-9_-]{43}$/)
  const sig = sign(id.signKey, 'hello')
  assert.equal(Buffer.from(sig, 'base64url').length, 64)
  assert.equal(verifySig(id.signPub, 'hello', sig), true)
  assert.equal(verifySig(id.signPub, 'hellp', sig), false)
  assert.equal(verifySig(newIdentity().signPub, 'hello', sig), false)
  assert.equal(verifySig('nope', 'hello', sig), false)
})

test('vouches: right secret and epoch pass, others fail', () => {
  const id = newIdentity()
  const v = vouchFor(SECRET, 3, id)
  assert.equal(checkVouch(SECRET, 3, id, v), true)
  assert.equal(checkVouch(SECRET, 4, id, v), false)
  assert.equal(checkVouch(Buffer.alloc(32, 8).toString('base64url'), 3, id, v), false)
  assert.equal(checkVouch(SECRET, 3, { ...id, dhPub: newIdentity().dhPub }, v), false)
  assert.equal(checkVouch(SECRET, 3, id, 'short'), false)
})

test('profile round trip, tamper, wrong epoch/secret/machine, size', () => {
  const profile = { name: 'n'.repeat(40), accepts: { read: true, write: true, type: true, spawn: true }, vouch: vouchFor(SECRET, 1, newIdentity()) }
  const blob = sealProfile(SECRET, 1, GROUP, profile)
  assert.ok(blob.length < PROFILE_MAX / 2, `blob is ${blob.length} chars`)
  assert.deepEqual(openProfile(SECRET, 1, GROUP, blob), profile)
  assert.notEqual(blob, sealProfile(SECRET, 1, GROUP, profile))
  throwsCode(() => openProfile(SECRET, 2, GROUP, blob), 'open')
  throwsCode(() => openProfile(Buffer.alloc(32, 1).toString('base64url'), 1, GROUP, blob), 'open')
  throwsCode(() => openProfile(SECRET, 1, 'b'.repeat(32), blob), 'open')
  const raw = Buffer.from(blob, 'base64url')
  raw[20] ^= 1
  throwsCode(() => openProfile(SECRET, 1, GROUP, raw.toString('base64url')), 'open')
  throwsCode(() => sealProfile(SECRET, 1, GROUP, { name: 'x'.repeat(PROFILE_MAX) }), 'too-large')
})

test('sealTo / openSealed round trip and failures', () => {
  const id = newIdentity()
  const blob = sealTo(id.dhPub, 'secret text', 'aad')
  assert.equal(openSealed(id.dhKey, blob, 'aad').toString(), 'secret text')
  throwsCode(() => openSealed(id.dhKey, blob, 'other'), 'open')
  throwsCode(() => openSealed(newIdentity().dhKey, blob, 'aad'), 'open')
  const bad = Buffer.from(blob)
  bad[bad.length - 1] ^= 1
  throwsCode(() => openSealed(id.dhKey, bad, 'aad'), 'open')
  throwsCode(() => openSealed(id.dhKey, Buffer.alloc(10), 'aad'), 'open')
})

test('session: round trip both ways, replay, reorder, flipped bit, third session', () => {
  const { sa, sb } = pair()
  assert.equal(sa.version, 1)
  const m1 = seal(sa, 'one')
  const m2 = seal(sa, 'two')
  assert.equal(open(sb, m1).toString(), 'one')
  assert.equal(open(sb, m2).toString(), 'two')
  assert.equal(open(sa, seal(sb, 'back')).toString(), 'back')
  throwsCode(() => open(sb, m1), 'open') // replay
  const m3 = seal(sa, 'three')
  const m4 = seal(sa, 'four')
  throwsCode(() => open(sb, m4), 'open') // out of order
  assert.equal(open(sb, m3).toString(), 'three') // a failed open does not advance
  assert.equal(open(sb, m4).toString(), 'four')
  const m5 = seal(sa, 'five')
  const flipped = Buffer.from(m5)
  flipped[0] ^= 1
  throwsCode(() => open(sb, flipped), 'open')
  assert.equal(open(sb, m5).toString(), 'five')
  const other = pair()
  throwsCode(() => open(other.sb, seal(sa, 'six')), 'open')
  // a blob sent by one side cannot be reflected back to it
  const sa2 = pair()
  const own = seal(sa2.sa, 'x')
  throwsCode(() => open(sa2.sa, own), 'open')
})

test('session objects hold only the listed fields and keys differ per session', () => {
  const a = newIdentity()
  const b = newIdentity()
  const run = () => {
    const { state, msg1 } = startSession(a, GROUP)
    const { pending, msg2 } = answerSession(b, GROUP, a.machineId, a.signPub, msg1)
    const fin = finishSession(state, b.machineId, b.signPub, msg2)
    return { sa: fin.session, sb: confirmSession(pending, fin.msg3) }
  }
  const one = run()
  const two = run()
  const fields = ['sendKey', 'recvKey', 'sendCounter', 'recvCounter', 'selfId', 'peerId', 'version'].sort()
  assert.deepEqual(Object.keys(one.sa).sort(), fields)
  assert.deepEqual(Object.keys(one.sb).sort(), fields)
  assert.notDeepEqual(one.sa.sendKey, two.sa.sendKey)
  assert.notDeepEqual(one.sa.recvKey, two.sa.recvKey)
  assert.deepEqual(one.sa.sendKey, one.sb.recvKey)
  assert.deepEqual(one.sa.recvKey, one.sb.sendKey)
  assert.notDeepEqual(one.sa.sendKey, one.sa.recvKey)
})

test('session: wrong peer key, group, altered versions and replayed handshake fail', () => {
  const a = newIdentity()
  const b = newIdentity()
  const mallory = newIdentity()
  const { state, msg1 } = startSession(a, GROUP)
  const { msg2 } = answerSession(b, GROUP, a.machineId, a.signPub, msg1)
  // same start state and msg2, only the peer id differs
  const s1 = startSession(a, GROUP)
  const r1 = answerSession(b, GROUP, a.machineId, a.signPub, s1.msg1)
  const state2 = () => s1.state
  const msg2b = r1.msg2
  // responder expects another signer for msg3 / initiator expects another signer for msg2
  throwsCode(() => finishSession(state, b.machineId, mallory.signPub, msg2), 'handshake')
  // wrong peer id changes the transcript
  throwsCode(() => finishSession(state2(), mallory.machineId, b.signPub, msg2b), 'handshake')
  // different groupId on the responder
  const s2 = startSession(a, GROUP)
  const r2 = answerSession(b, 'c'.repeat(32), a.machineId, a.signPub, s2.msg1)
  throwsCode(() => finishSession(s2.state, b.machineId, b.signPub, r2.msg2), 'handshake')
  // msg1 range altered in transit
  const s3 = startSession(a, GROUP)
  const r3 = answerSession(b, GROUP, a.machineId, a.signPub, { ...s3.msg1, v: [1, 2] })
  throwsCode(() => finishSession(s3.state, b.machineId, b.signPub, r3.msg2), 'handshake')
  // msg2 range altered in transit
  const s4 = startSession(a, GROUP)
  const r4 = answerSession(b, GROUP, a.machineId, a.signPub, s4.msg1)
  throwsCode(() => finishSession(s4.state, b.machineId, b.signPub, { ...r4.msg2, v: [1, 3] }), 'handshake')
  // msg2 ephemeral key swapped
  const s5 = startSession(a, GROUP)
  const r5 = answerSession(b, GROUP, a.machineId, a.signPub, s5.msg1)
  throwsCode(() => finishSession(s5.state, b.machineId, b.signPub, { ...r5.msg2, e: startSession(b, GROUP).msg1.e }), 'handshake')
  // msg3 from the wrong signer
  const s6 = startSession(a, GROUP)
  const r6 = answerSession(b, GROUP, a.machineId, a.signPub, s6.msg1)
  const f6 = finishSession(s6.state, b.machineId, b.signPub, r6.msg2)
  throwsCode(() => confirmSession(r6.pending, { sig: sign(mallory.signKey, 'x') }), 'handshake')
  const sb = confirmSession(r6.pending, f6.msg3)
  assert.equal(open(sb, seal(f6.session, 'ok')).toString(), 'ok')
  // msg3 cannot confirm twice; state cannot finish twice
  throwsCode(() => confirmSession(r6.pending, f6.msg3), 'handshake')
  throwsCode(() => finishSession(s6.state, b.machineId, b.signPub, r6.msg2), 'handshake')
  // malformed messages
  throwsCode(() => answerSession(b, GROUP, a.machineId, a.signPub, { e: 'x', v: [1, 1] }), 'handshake')
})

test('session: psk must match with key confirmation, in both directions', () => {
  const psk = Buffer.alloc(32, 9).toString('base64url')
  const wrong = Buffer.alloc(32, 10).toString('base64url')
  const ok = pair(GROUP, psk)
  assert.equal(open(ok.sb, seal(ok.sa, 'with psk')).toString(), 'with psk')
  const a = newIdentity()
  const b = newIdentity()
  // A holds the wrong psk: finishSession (A side) fails with psk
  {
    const { state, msg1 } = startSession(a, GROUP)
    const { msg2 } = answerSession(b, GROUP, a.machineId, a.signPub, msg1, psk)
    throwsCode(() => finishSession(state, b.machineId, b.signPub, msg2, wrong), 'psk')
  }
  // B holds the wrong psk: A fails already at msg2 ...
  {
    const { state, msg1 } = startSession(a, GROUP)
    const { msg2 } = answerSession(b, GROUP, a.machineId, a.signPub, msg1, wrong)
    throwsCode(() => finishSession(state, b.machineId, b.signPub, msg2, psk), 'psk')
  }
  // ... and a forged-but-valid-looking msg3 confirmation fails confirmSession (B side)
  {
    const { state, msg1 } = startSession(a, GROUP)
    const { pending, msg2 } = answerSession(b, GROUP, a.machineId, a.signPub, msg1, psk)
    const fin = finishSession(state, b.machineId, b.signPub, msg2, psk)
    throwsCode(() => confirmSession(pending, { ...fin.msg3, conf: msg2.conf }), 'psk')
    assert.equal(open(confirmSession(pending, fin.msg3), seal(fin.session, 'ok')).toString(), 'ok')
  }
  // psk on one side only: still refused, as psk where this side holds one
  {
    const { state, msg1 } = startSession(a, GROUP)
    const { msg2 } = answerSession(b, GROUP, a.machineId, a.signPub, msg1)
    throwsCode(() => finishSession(state, b.machineId, b.signPub, msg2, psk), 'psk')
    const s2 = startSession(a, GROUP)
    const r2 = answerSession(b, GROUP, a.machineId, a.signPub, s2.msg1, psk)
    throwsCode(() => finishSession(s2.state, b.machineId, b.signPub, r2.msg2), 'handshake')
  }
  // without any psk a missing or altered confirmation is a handshake failure
  {
    const { state, msg1 } = startSession(a, GROUP)
    const { msg2 } = answerSession(b, GROUP, a.machineId, a.signPub, msg1)
    const { conf, ...noConf } = msg2
    throwsCode(() => finishSession(state, b.machineId, b.signPub, noConf), 'handshake')
  }
  const z = Buffer.alloc(32).toString('base64url')
  const same = pair(GROUP, z)
  assert.equal(open(same.sb, seal(same.sa, 'z')).toString(), 'z')
})

test('session: a supplied psk must be exactly 32 bytes; explicit undefined is not "no psk"', () => {
  const a = newIdentity()
  const b = newIdentity()
  const bad = [undefined, null, '', Buffer.alloc(31, 1).toString('base64url'), Buffer.alloc(33, 1).toString('base64url')]
  for (const p of bad) {
    const { state, msg1 } = startSession(a, GROUP)
    throwsCode(() => answerSession(b, GROUP, a.machineId, a.signPub, msg1, p), 'handshake')
    const good = answerSession(b, GROUP, a.machineId, a.signPub, msg1)
    throwsCode(() => finishSession(state, b.machineId, b.signPub, good.msg2, p), 'handshake')
    assert.equal(state.eKey, null)
  }
})

test('session: low-order ephemeral keys fail as handshake and failure clears eKey', () => {
  const a = newIdentity()
  const b = newIdentity()
  const zero = Buffer.alloc(32).toString('base64url')
  const s = startSession(a, GROUP)
  throwsCode(() => answerSession(b, GROUP, a.machineId, a.signPub, { ...s.msg1, e: zero }), 'handshake')
  // msg2 carrying an all-zero e, signed properly by b over that transcript
  const s2 = startSession(a, GROUP)
  const fields = ['perch-relay-session-v1', GROUP, a.machineId, b.machineId, s2.msg1.e, zero, '1,1', '1,1', 'b']
  const field = (v) => {
    const bytes = Buffer.from(String(v))
    const head = Buffer.alloc(4)
    head.writeUInt32BE(bytes.length)
    return Buffer.concat([head, bytes])
  }
  const hash = createHash('sha256').update(Buffer.concat(fields.map(field))).digest()
  const msg2 = { e: zero, v: [1, 1], sig: sign(b.signKey, hash.toString('base64url')), conf: 'x'.repeat(43) }
  throwsCode(() => finishSession(s2.state, b.machineId, b.signPub, msg2), 'handshake')
  assert.equal(s2.state.eKey, null)
  // a failed finish (bad signature) also leaves no eKey
  const s3 = startSession(a, GROUP)
  const r3 = answerSession(b, GROUP, a.machineId, a.signPub, s3.msg1)
  throwsCode(() => finishSession(s3.state, b.machineId, a.signPub, r3.msg2), 'handshake')
  assert.equal(s3.state.eKey, null)
})

test('session: no common version names who is older', () => {
  const a = newIdentity()
  const b = newIdentity()
  const { msg1 } = startSession(a, GROUP)
  const peerOlder = { code: 'version', older: 'peer' }
  const selfOlder = { code: 'version', older: 'self' }
  assert.throws(() => answerSession(b, GROUP, a.machineId, a.signPub, { ...msg1, v: [0, 0] }), peerOlder)
  assert.throws(() => answerSession(b, GROUP, a.machineId, a.signPub, { ...msg1, v: [5, 6] }), selfOlder)
  // initiator side: the responder properly signs a range that does not overlap
  const s = startSession(a, GROUP)
  const field = (v) => {
    const bytes = Buffer.from(String(v))
    const head = Buffer.alloc(4)
    head.writeUInt32BE(bytes.length)
    return Buffer.concat([head, bytes])
  }
  const signedMsg2 = (v) => {
    const eB = startSession(b, GROUP).msg1.e
    const fields = ['perch-relay-session-v1', GROUP, a.machineId, b.machineId, s.msg1.e, eB, s.msg1.v.join(','), v.join(','), 'b']
    const hash = createHash('sha256').update(Buffer.concat(fields.map(field))).digest()
    return { e: eB, v, sig: sign(b.signKey, hash.toString('base64url')) }
  }
  assert.throws(() => finishSession(s.state, b.machineId, b.signPub, signedMsg2([2, 3])), selfOlder)
  const s2 = startSession(a, GROUP)
  s2.state.v = [2, 3]
  s2.msg1.v = [2, 3]
  assert.throws(() => finishSession(s2.state, b.machineId, b.signPub, (() => {
    const eB = startSession(b, GROUP).msg1.e
    const fields = ['perch-relay-session-v1', GROUP, a.machineId, b.machineId, s2.msg1.e, eB, '2,3', '1,1', 'b']
    const hash = createHash('sha256').update(Buffer.concat(fields.map(field))).digest()
    return { e: eB, v: [1, 1], sig: sign(b.signKey, hash.toString('base64url')) }
  })()), peerOlder)
})

function removalFixture() {
  const [A, B, C, D] = [newIdentity(), newIdentity(), newIdentity(), newIdentity()]
  const old = { secret: SECRET, epoch: 4 }
  const pin = (x) => ({ machineId: x.machineId, signPub: x.signPub, dhPub: x.dhPub })
  const out = makeRemoval({
    self: A,
    groupId: GROUP,
    removedId: D.machineId,
    oldGroup: old,
    recipients: [pin(B), pin(C)],
  })
  const accept = (who, over = {}) =>
    acceptRemoval({
      self: who,
      group: { groupId: GROUP, ...old },
      removedIds: [],
      pinned: { [A.machineId]: pin(A) },
      record: out.record,
      sealed: out.packages[who.machineId],
      ...over,
    })
  return { A, B, C, D, old, out, pin, accept }
}

test('removal: record shape and packages for recipients and the remover, not the removed', () => {
  const { A, B, C, D, out } = removalFixture()
  assert.equal(out.group.epoch, 5)
  assert.equal(Buffer.from(out.group.secret, 'base64url').length, 32)
  assert.deepEqual(Object.keys(out.packages).sort(), [A.machineId, B.machineId, C.machineId].sort())
  assert.equal(out.packages[D.machineId], undefined)
  assert.deepEqual(Object.keys(out.record).sort(), ['by', 'byDhPub', 'bySignPub', 'byVouch', 'confirm', 'epoch', 'groupId', 'removedId', 'sig'])
  assert.equal(out.record.epoch, 5)
  assert.equal(out.record.confirm, Buffer.from(out.record.confirm, 'base64').toString('base64'))
})

test('acceptRemoval: accepts for recipients and for the remover itself', () => {
  const { A, B, C, out, accept } = removalFixture()
  for (const who of [A, B, C]) assert.deepEqual(accept(who), out.group)
})

test('acceptRemoval: accepts a remover that is not pinned but whose vouch checks', () => {
  const { B, out, accept } = removalFixture()
  assert.deepEqual(accept(B, { pinned: {} }), out.group)
  assert.deepEqual(accept(B, { pinned: [] }), out.group)
})

test('acceptRemoval: each failure has its own reason', () => {
  const { A, B, C, D, old, out, pin, accept } = removalFixture()
  const resign = (changes, signer = A) => {
    const { sig, ...body } = { ...out.record, ...changes }
    return { ...body, sig: sign(signer.signKey, canonicalOf(body)) }
  }
  const canonicalOf = (body) => JSON.stringify(sortKeys(body))
  const reason = (fn) => {
    try {
      fn()
    } catch (e) {
      return e.code
    }
    return 'accepted'
  }
  // package sealed by a third party under the same AAD (confirm mismatch)
  const aad = (id) => JSON.stringify(sortKeys(bodyOf(out.record))) + '\n' + id
  const forged = sealTo(B.dhPub, Buffer.alloc(32, 1), aad(B.machineId)).toString('base64url')
  assert.equal(reason(() => accept(B, { sealed: forged })), 'confirm')
  // package moved to another recipient
  assert.equal(reason(() => accept(B, { sealed: out.packages[C.machineId] })), 'package')
  // package not opened by this key
  assert.equal(reason(() => accept(B, { sealed: 'AAAA' })), 'package')
  // epoch not own + 1
  const far = resign({ epoch: 6 })
  assert.equal(reason(() => accept(B, { record: far })), 'epoch')
  // stale: already applied
  assert.equal(reason(() => accept(B, { group: { groupId: GROUP, secret: out.group.secret, epoch: 5 } })), 'stale')
  assert.equal(reason(() => accept(B, { group: { groupId: GROUP, secret: out.group.secret, epoch: 9 } })), 'stale')
  // another group's record
  assert.equal(reason(() => accept(B, { group: { groupId: 'd'.repeat(32), ...old } })), 'group')
  // record by a removed machine
  assert.equal(reason(() => accept(B, { removedIds: [A.machineId] })), 'remover-removed')
  // remover neither pinned nor vouched
  const stranger = newIdentity()
  const bad = makeRemoval({ self: stranger, groupId: GROUP, removedId: D.machineId, oldGroup: { secret: Buffer.alloc(32, 3).toString('base64url'), epoch: 4 }, recipients: [pin(B)] })
  assert.equal(reason(() => accept(B, { record: bad.record, sealed: bad.packages[B.machineId], pinned: {} })), 'remover-untrusted')
  // pinned with other keys is not rescued by a valid vouch
  assert.equal(reason(() => accept(B, { pinned: { [A.machineId]: pin(C) } })), 'remover-untrusted')
  // bad signature
  assert.equal(reason(() => accept(B, { record: { ...out.record, sig: sign(A.signKey, 'something else') } })), 'signature')
  assert.equal(reason(() => accept(B, { record: { ...out.record, removedId: C.machineId } })), 'signature')
  assert.equal(reason(() => accept(B, { record: resign({ removedId: C.machineId }, C) })), 'signature')
  // malformed
  assert.equal(reason(() => accept(B, { record: { ...out.record, epoch: '5' } })), 'malformed')
  assert.equal(reason(() => accept(B, { record: null })), 'malformed')
  // untouched case still accepts
  assert.equal(reason(() => accept(B)), 'accepted')
})

function sortKeys(v) {
  if (Array.isArray(v)) return v.map(sortKeys)
  if (v && typeof v === 'object') return Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortKeys(v[k])]))
  return v
}
function bodyOf(record) {
  const { sig, ...body } = record
  return body
}

test('removal: unknown record keys, self-removal and removal of the author are refused', () => {
  const { A, B, D, old, out, pin, accept } = removalFixture()
  const reason = (fn) => {
    try {
      fn()
    } catch (e) {
      return e.code
    }
    return 'accepted'
  }
  // unknown key, even when signed by the remover
  const { sig, ...body } = out.record
  const extra = { ...body, extra: 1 }
  const signed = { ...extra, sig: sign(A.signKey, JSON.stringify(sortKeys(extra))) }
  assert.equal(reason(() => accept(B, { record: signed })), 'malformed')
  assert.equal(reason(() => accept(B, { record: { ...out.record, extra: 1 } })), 'malformed')
  // record removing its own author
  const selfRec = makeRemoval({ self: A, groupId: GROUP, removedId: D.machineId, oldGroup: old, recipients: [pin(B)] })
  const forgedBody = { ...bodyOf(selfRec.record), removedId: A.machineId }
  const forged = { ...forgedBody, sig: sign(A.signKey, JSON.stringify(sortKeys(forgedBody))) }
  assert.equal(reason(() => accept(B, { record: forged })), 'target')
  assert.equal(reason(() => verifyRemovalRecord({ group: { groupId: GROUP, ...old }, removedIds: [], pinned: { [A.machineId]: pin(A) }, record: forged })), 'target')
  // record that removes the machine itself
  assert.equal(reason(() => accept(D, { sealed: 'AAAA' })), 'target')
})

test('invites: round trip, validation, join proof', () => {
  const exp = Date.now() + 3600_000
  const inv = newInvite({ relay: 'wss://relay.example.com', group: GROUP, expiresAt: exp })
  assert.match(inv.id, /^[0-9a-f]{32}$/)
  assert.match(inv.enrolPub, /^[A-Za-z0-9_-]{43}$/)
  assert.ok(inv.string.startsWith('perch-invite:1:'))
  const d = decodeInvite(inv.string)
  assert.equal(d.relay, 'wss://relay.example.com')
  assert.equal(d.group, GROUP)
  assert.equal(d.invite, inv.id)
  assert.equal(d.enrolKey, inv.enrolKey)
  assert.equal(d.enrolPub, inv.enrolPub)
  assert.equal(d.admit, inv.admit)
  assert.equal(d.exp, exp)
  assert.equal(decodeInvite('  ' + inv.string + '\n').invite, inv.id)
  const enc = (o) => 'perch-invite:1:' + Buffer.from(JSON.stringify(o)).toString('base64url')
  const base = { relay: 'wss://r.example.com', group: GROUP, invite: inv.id, enrolKey: inv.enrolKey, admit: inv.admit, exp }
  for (const bad of [
    '',
    'perch-invite:2:abc',
    'perch-invite:1:',
    'perch-invite:1:%%%',
    'perch-invite:1:' + Buffer.from('not json').toString('base64url'),
    enc({ ...base, relay: 'https://r.example.com' }),
    enc({ ...base, relay: 5 }),
    enc({ ...base, group: 'xyz' }),
    enc({ ...base, invite: 'a b' }),
    enc({ ...base, admit: 'short' }),
    enc({ ...base, exp: 'soon' }),
    enc({ ...base, enrolKey: 'AAAA' }),
    enc({ ...base, enrolKey: newIdentity().dhKey }),
    enc([1, 2]),
    undefined,
    'perch-invite:1:' + 'A'.repeat(3000),
  ]) {
    assert.throws(() => decodeInvite(bad), (e) => e.message === 'That is not a Perch invite.', String(bad).slice(0, 40))
  }
  const me = newIdentity()
  const nonce = 'n0nce'
  const proof = joinProof(inv.enrolKey, nonce, GROUP, me.machineId, me.signPub, me.dhPub)
  const text = challengeString(nonce, GROUP, me.machineId) + '\n' + me.signPub + '\n' + me.dhPub
  assert.equal(verifySig(inv.enrolPub, text, proof), true)
  assert.equal(verifySig(inv.enrolPub, text + 'x', proof), false)
})

test('crypto.mjs imports only node:crypto and the shared wire file', () => {
  const src = readFileSync(new URL('./crypto.mjs', import.meta.url), 'utf8')
  const specs = [
    ...src.matchAll(/^\s*(?:import|export)[^'"]*from\s+['"]([^'"]+)['"]/gm),
    ...src.matchAll(/^\s*import\s+['"]([^'"]+)['"]/gm),
  ].map((m) => m[1])
  assert.deepEqual(specs.sort(), ['../../_shared/relayWire.mjs', 'node:crypto'])
  assert.doesNotMatch(src, /\brequire\s*\(|\bimport\s*\(/)
})
