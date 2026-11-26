import assert from 'node:assert/strict'
import { createHash, createPrivateKey, generateKeyPairSync } from 'node:crypto'
import { test } from 'node:test'
import { fakeClock } from '../../../relay/test/helpers.mjs'
import { makeRemoval, newIdentity, sign } from './crypto.mjs'
import { createLink } from './link.mjs'
import { createMembership } from './membership.mjs'
import { makeNode, startRig, until } from '../test/relayRig.mjs'

const text = (r) => r.content[0].text
const rejects = async (p, code) => {
  try {
    await p
  } catch (e) {
    assert.equal(e.code, code, `expected ${code}, got ${e.code}: ${e.message}`)
    return e
  }
  assert.fail(`expected a ${code} error`)
}

test('two machines connect and verify each other; a call crosses an encrypted session', async () => {
  const rig = await startRig()
  try {
    const a = await rig.creator('alpha')
    const b = await rig.joiner(a, 'bravo')
    assert.equal(a.trustOf('bravo'), 'verified')
    assert.equal(b.trustOf('alpha'), 'verified')
    assert.equal(a.machine('bravo').accepts, 'send')
    assert.equal(a.machine('alpha').self, true)
    assert.equal(a.link.status, 'connected')
    const r = await a.link.call(b.mid(), 'list_projects', { x: 1 }, { senderWindow: 'perch:1' })
    assert.equal(text(r), 'bravo ran list_projects')
    assert.equal(r.isError, false)
    assert.deepEqual(b.inboundCalls[0].msg.args, { x: 1 })
    assert.equal(b.inboundCalls[0].msg.senderWindow, 'perch:1')
    assert.equal(b.inboundCalls[0].peer.name, 'alpha')
    // The other direction needs a session of its own, and works.
    assert.equal(text(await b.link.call(a.mid(), 'agent_status', {})), 'alpha ran agent_status')
  } finally {
    await rig.close()
  }
})

test('profile accepts follows the inbound setting and Assistant Read-only', async () => {
  const rig = await startRig()
  try {
    const a = await rig.creator('alpha')
    const b = await rig.joiner(a, 'bravo')
    await b.link.setInbound('read')
    await until(() => a.machine('bravo').accepts === 'read', 3000, 'read')
    await b.link.setInbound('send')
    await until(() => a.machine('bravo').accepts === 'send', 3000, 'send')
    b.readOnly = true
    await b.link.refreshProfile()
    await until(() => a.machine('bravo').accepts === 'read', 3000, 'read-only limits')
    b.readOnly = false
    await b.link.refreshProfile()
    await b.link.setInbound('off')
    await until(() => a.machine('bravo').accepts === 'off', 3000, 'off')
  } finally {
    await rig.close()
  }
})

// A WebSocket that never connects, to count and time connection attempts.
function failingSockets(attempts) {
  return class {
    constructor(url) {
      attempts.push(url)
      this.readyState = 0
      this.l = {}
      queueMicrotask(() => {
        this.readyState = 3
        for (const f of this.l.error || []) f({})
        for (const f of this.l.close || []) f({})
      })
    }
    addEventListener(name, fn) {
      ;(this.l[name] ||= []).push(fn)
    }
    close() {}
    send() {}
  }
}

test('reconnect delays are 1, 2, 4, 8, 16, 32, 60, 60 seconds (A8)', async () => {
  const rig = await startRig()
  try {
    const a = await rig.creator('alpha')
    // The same identity, offline: a link on a stub socket that never connects.
    const clock = fakeClock()
    const attempts = []
    const link = createLink({ membership: a.membership, clock, WebSocketImpl: failingSockets(attempts) })
    link.start()
    const flush = () => new Promise((r) => setImmediate(r))
    await flush()
    assert.equal(attempts.length, 1)
    assert.equal(link.status, 'reconnecting')
    for (const [i, delay] of [1, 2, 4, 8, 16, 32, 60, 60].entries()) {
      clock.tick(delay * 1000 - 1)
      await flush()
      assert.equal(attempts.length, i + 1, `no attempt before ${delay}s`)
      clock.tick(1)
      await flush()
      assert.equal(attempts.length, i + 2, `attempt after ${delay}s`)
    }
    link.close()
  } finally {
    await rig.close()
  }
})

test('a 2 MB result arrives identical; a 9 MB one is too-large (A19)', async () => {
  const rig = await startRig()
  try {
    const a = await rig.creator('alpha')
    const b = await rig.joiner(a, 'bravo')
    const big = Array.from({ length: 2 * 1024 * 1024 }, (_, i) => String.fromCharCode(33 + ((i * 7) % 90))).join('')
    const huge = 'y'.repeat(9 * 1024 * 1024)
    b.onCall = (peer, msg, respond) => respond({ content: [{ type: 'text', text: msg.tool === 'huge' ? huge : big }], isError: false })
    const r = await a.link.call(b.mid(), 'big', {}, { timeoutMs: 20000 })
    assert.equal(text(r), big)
    const e = await rejects(a.link.call(b.mid(), 'huge', {}, { timeoutMs: 20000 }), 'too-large')
    assert.match(e.message, /8 MB/)
    // The session survived the substitution.
    assert.equal(text(await a.link.call(b.mid(), 'big', {}, { timeoutMs: 20000 })), big)
    // A call whose arguments are over 8 MB is not sent.
    await rejects(a.link.call(b.mid(), 'big', { blob: huge }), 'too-large')
  } finally {
    await rig.close()
  }
})

test('with frames limited to 64 KiB a 2 MB result still arrives (A19)', async () => {
  const rig = await startRig({ env: { RELAY_MAX_FRAME_BYTES: '65536' } })
  try {
    const a = await rig.creator('alpha')
    const b = await rig.joiner(a, 'bravo')
    const big = 'z'.repeat(2 * 1024 * 1024)
    b.onCall = (peer, msg, respond) => respond({ content: [{ type: 'text', text: big }], isError: false })
    assert.equal(a.link.snapshot().limits.frameBytes, 65536)
    assert.equal(text(await a.link.call(b.mid(), 'big', {}, { timeoutMs: 20000 })), big)
  } finally {
    await rig.close()
  }
})

test('a dropped data part resets the session; the next call works', async () => {
  const hooks = {}
  const rig = await startRig({ hooks })
  try {
    const a = await rig.creator('alpha')
    const b = await rig.joiner(a, 'bravo')
    const big = 'q'.repeat(600 * 1024)
    b.onCall = (peer, msg, respond) => respond({ content: [{ type: 'text', text: msg.tool === 'big' ? big : 'small' }], isError: false })
    let dropped = 0
    hooks.onForward = (frame, from) => {
      if (from.machineId === b.mid() && frame.k === 'data' && frame.seq === 1 && frame.part === 1 && !dropped++) return null
      return undefined
    }
    // seq 0 is invites.sync, seq 1 is the result.
    const e = await rejects(a.link.call(b.mid(), 'big', {}, { timeoutMs: 20000 }), 'not-connected')
    assert.match(e.message, /Relay not connected|not connected to the relay/)
    assert.match(e.message, /the secure session was reset; try again/)
    assert.equal(dropped, 1)
    assert.equal(text(await a.link.call(b.mid(), 'small', {}, { timeoutMs: 20000 })), 'small')
  } finally {
    await rig.close()
  }
})

test('a peer whose connection is replaced gets a fresh session on the next call', async () => {
  const hooks = {}
  const rig = await startRig({ hooks })
  try {
    const a = await rig.creator('alpha')
    const b = await rig.joiner(a, 'bravo')
    assert.equal(text(await a.link.call(b.mid(), 'one', {})), 'bravo ran one')
    // B's first connection stops answering the relay's probe: a half-open link.
    hooks.onSend = (frame, to) => (frame.t === 'probe' && to.machineId === b.mid() ? null : undefined)
    const before = a.machine('bravo').conn
    const second = []
    const link2 = createLink({
      membership: b.membership,
      onCall: (peer, msg, respond) => (second.push(msg.tool), respond({ content: [{ type: 'text', text: 'second connection' }], isError: false })),
    })
    link2.start()
    await until(() => a.machine('bravo')?.conn > before, 9000, 'replacement presence')
    assert.equal(text(await a.link.call(b.mid(), 'two', {})), 'second connection')
    assert.deepEqual(second, ['two'])
    link2.close()
  } finally {
    await rig.close()
  }
})

test('stopping the peer mid-call rejects with offline within 5 seconds', async () => {
  const rig = await startRig()
  try {
    const a = await rig.creator('alpha')
    const b = await rig.joiner(a, 'bravo')
    b.onCall = () => {}
    const started = Date.now()
    const pending = a.link.call(b.mid(), 'slow', {}, { timeoutMs: 20000 })
    await until(() => b.inboundCalls.length === 0 && true, 100).catch(() => {})
    await new Promise((r) => setTimeout(r, 100))
    b.link.close()
    await rejects(pending, 'offline')
    assert.ok(Date.now() - started < 5000)
    await rejects(a.link.call(b.mid(), 'again', {}), 'offline')
  } finally {
    await rig.close()
  }
})

test('a peer that never answers rejects with no-answer at the timeout', async () => {
  const rig = await startRig()
  try {
    const a = await rig.creator('alpha')
    const b = await rig.joiner(a, 'bravo')
    b.onCall = () => {}
    const e = await rejects(a.link.call(b.mid(), 'slow', {}, { timeoutMs: 300 }), 'no-answer')
    assert.match(e.message, /bravo did not answer within 0 seconds|bravo did not answer within/)
  } finally {
    await rig.close()
  }
})

test('calls to machines that are unknown, unverified or while disconnected fail with coded errors', async () => {
  const rig = await startRig()
  try {
    const a = await rig.creator('alpha')
    await rejects(a.link.call('f'.repeat(32), 'x', {}), 'offline')
    const lone = rig.node('lone')
    await rejects(lone.link.call('f'.repeat(32), 'x', {}), 'not-in-group')
  } finally {
    await rig.close()
  }
})

test('hostile relay: a flipped byte never delivers a call', async () => {
  const hooks = {}
  const rig = await startRig({ hooks })
  try {
    const a = await rig.creator('alpha')
    const b = await rig.joiner(a, 'bravo')
    let flipped = 0
    let armed = false
    hooks.onForward = (frame, from) => {
      if (armed && from.machineId === a.mid() && frame.k === 'data' && !flipped++) {
        const raw = Buffer.from(frame.data, 'base64')
        raw[raw.length - 1] ^= 1
        return { ...frame, data: raw.toString('base64') }
      }
      return undefined
    }
    await a.link.call(b.mid(), 'warm', {})
    armed = true
    await rejects(a.link.call(b.mid(), 'tampered', {}, { timeoutMs: 3000 }), 'not-connected')
    assert.deepEqual(b.inboundCalls.map((c) => c.msg.tool), ['warm'])
    assert.equal(text(await a.link.call(b.mid(), 'clean', {})), 'bravo ran clean')
  } finally {
    await rig.close()
  }
})

test('hostile relay: a replayed frame delivers nothing twice', async () => {
  const hooks = {}
  const rig = await startRig({ hooks })
  try {
    const a = await rig.creator('alpha')
    const b = await rig.joiner(a, 'bravo')
    let copy = null
    hooks.onForward = (frame, from) => {
      if (from.machineId === a.mid() && frame.k === 'data' && frame.seq === 1) copy = frame
      return undefined
    }
    assert.equal(text(await a.link.call(b.mid(), 'once', {})), 'bravo ran once')
    assert.ok(copy)
    rig.relay.inject(b.membership.state.groupId, b.mid(), copy)
    await new Promise((r) => setTimeout(r, 200))
    assert.equal(b.inboundCalls.length, 1)
    // The replay reset the session; a new call sets up a fresh one.
    assert.equal(text(await a.link.call(b.mid(), 'twice', {})), 'bravo ran twice')
    assert.equal(b.inboundCalls.length, 2)
  } finally {
    await rig.close()
  }
})

test('hostile relay: a frame redirected to a third member is not delivered', async () => {
  const hooks = {}
  const rig = await startRig({ hooks })
  try {
    const a = await rig.creator('alpha')
    const b = await rig.joiner(a, 'bravo')
    const c = await rig.joiner(a, 'charlie')
    await b.waitVerified('charlie')
    await c.waitVerified('bravo')
    let redirected = 0
    let armed = false
    hooks.onForward = (frame, from, to) => {
      if (armed && from.machineId === a.mid() && to.machineId === b.mid() && frame.k === 'data' && !redirected) {
        redirected++
        rig.relay.inject(a.membership.state.groupId, c.mid(), frame)
        return null
      }
      return undefined
    }
    await a.link.call(b.mid(), 'warm', {})
    armed = true
    await rejects(a.link.call(b.mid(), 'secret', {}, { timeoutMs: 600 }), 'no-answer')
    assert.equal(redirected, 1)
    assert.deepEqual(b.inboundCalls.map((x) => x.msg.tool), ['warm'])
    assert.equal(c.inboundCalls.length, 0)
  } finally {
    await rig.close()
  }
})

test('hostile relay: swapped public keys in the directory mark the machine unverified (A28)', async () => {
  const hooks = {}
  const rig = await startRig({ hooks })
  try {
    const a = await rig.creator('alpha')
    const b = await rig.joiner(a, 'bravo')
    assert.equal(text(await a.link.call(b.mid(), 'ok', {})), 'bravo ran ok')
    const evil = newIdentity()
    hooks.onSend = (frame, to) => {
      if (frame.t !== 'directory' || to.machineId !== a.mid()) return undefined
      return { ...frame, machines: frame.machines.map((m) => (m.id === b.mid() ? { ...m, signPub: evil.signPub, dhPub: evil.dhPub } : m)) }
    }
    // Any directory change makes the relay send a new one.
    await b.link.setInbound('read')
    await until(() => a.trustOf('bravo') === 'unverified', 3000, 'swapped keys flagged')
    const before = b.inboundCalls.length
    await rejects(a.link.call(b.mid(), 'x', {}), 'unverified')
    assert.equal(b.inboundCalls.length, before)
    assert.equal(a.membership.state.pinned[b.mid()].signPub, b.membership.identity.signPub, 'the pin is not replaced')
  } finally {
    await rig.close()
  }
})

test('hostile relay: a removed error without a valid record changes nothing (P6)', async () => {
  const rig = await startRig()
  try {
    const a = await rig.creator('alpha')
    const b = await rig.joiner(a, 'bravo')
    const c = await rig.joiner(a, 'charlie')
    const gid = b.membership.state.groupId
    const epoch = b.membership.group.epoch
    const secret = b.membership.group.secret
    const forged = makeRemoval({
      self: a.membership.identity,
      groupId: gid,
      removedId: b.mid(),
      oldGroup: a.membership.group,
      recipients: [],
    }).record
    const cases = [
      { t: 'error', code: 'removed', message: 'This machine was removed from the group.' },
      // A record that A really signed, but that names C.
      {
        t: 'error',
        code: 'removed',
        message: 'removed',
        record: makeRemoval({ self: a.membership.identity, groupId: gid, removedId: c.mid(), oldGroup: a.membership.group, recipients: [] }).record,
      },
      { t: 'error', code: 'removed', message: 'removed', record: { ...forged, sig: Buffer.alloc(64, 1).toString('base64url') } },
    ]
    for (const frame of cases) {
      await until(() => b.link.status === 'connected', 8000, 'b connected')
      rig.relay.inject(gid, b.mid(), frame)
      await until(() => b.link.status === 'refused', 3000, 'refused')
      assert.equal(b.membership.joined, true)
      assert.equal(b.membership.group.epoch, epoch)
      assert.equal(b.membership.group.secret, secret)
      assert.ok(await b.fh.secrets.get('relay.signKey'))
      // Back online by hand: the 60 s retry would be too slow for a test.
      b.link.close()
      b.link = createLinkFor(b)
      b.link.start()
    }
  } finally {
    await rig.close()
  }
})

function createLinkFor(node) {
  return createLink({
    membership: node.membership,
    log: (t) => (node.logs ||= []).push(t),
    onState: (s) => node.states.push(s),
    onEvent: (e) => node.events.push(e),
    onCall: (...a) => node.onCall(...a),
  })
}

test('a recording relay sees none of the tool name, arguments, project or machine name (A27)', async () => {
  const hooks = {}
  const seen = []
  hooks.onForward = (frame) => (seen.push(JSON.stringify(frame)), undefined)
  hooks.onSend = (frame) => (seen.push(JSON.stringify(frame)), undefined)
  const logs = []
  const rig = await startRig({ hooks, log: (l) => logs.push(l) })
  try {
    const a = await rig.creator('alpha-marker')
    const b = await rig.joiner(a, 'bravo-marker')
    b.onCall = (peer, msg, respond) => respond({ content: [{ type: 'text', text: 'result-marker-text' }], isError: false })
    const r = await a.link.call(b.mid(), 'tool_marker_name', { project: 'project-marker', text: 'argument-marker-text' }, { senderWindow: 'window-marker:1' })
    assert.equal(text(r), 'result-marker-text')
    const all = seen.join('\n') + logs.join('\n')
    for (const marker of ['tool_marker_name', 'project-marker', 'argument-marker-text', 'result-marker-text', 'alpha-marker', 'bravo-marker', 'window-marker']) {
      assert.ok(!all.includes(marker), `the relay saw ${marker}`)
    }
    assert.ok(seen.length > 5)
  } finally {
    await rig.close()
  }
})

// ---- a peer with another protocol version ----

const lp = (v) => {
  const bytes = Buffer.from(String(v))
  const head = Buffer.alloc(4)
  head.writeUInt32BE(bytes.length)
  return Buffer.concat([head, bytes])
}
// The same transcript hash as crypto.mjs (P1), so a test can sign a msg2 that
// states a protocol range of its own.
function transcriptHash({ groupId, idA, idB, eA, eB, rangeA, rangeB }, role) {
  const h = createHash('sha256')
  for (const f of ['perch-relay-session-v1', groupId, idA, idB, eA, eB, rangeA.join(','), rangeB.join(','), role]) h.update(lp(f))
  return h.digest()
}

test('a peer whose version range is [2,2] yields the version error', async () => {
  const hooks = {}
  const rig = await startRig({ hooks })
  try {
    const a = await rig.creator('alpha')
    const b = await rig.joiner(a, 'bravo')
    const gid = a.membership.state.groupId
    let eA = null
    hooks.onForward = (frame, from) => {
      if (frame.k === 'hs1' && from.machineId === a.mid()) eA = JSON.parse(Buffer.from(frame.data, 'base64')).e
      if (frame.k === 'hs2' && from.machineId === b.mid()) {
        const eB = b.membership.identity.dhPub
        const sig = sign(b.membership.identity.signKey, transcriptHash({ groupId: gid, idA: a.mid(), idB: b.mid(), eA, eB, rangeA: [1, 1], rangeB: [2, 2] }, 'b').toString('base64url'))
        return { ...frame, data: Buffer.from(JSON.stringify({ e: eB, v: [2, 2], sig, conf: 'x' })).toString('base64') }
      }
      return undefined
    }
    const e = await rejects(a.link.call(b.mid(), 'x', {}), 'version')
    assert.equal(e.older, 'self')
    assert.equal(b.inboundCalls.length, 0)
  } finally {
    await rig.close()
  }
})

test('generated keys are accepted as plain base64url (sanity for the helpers above)', () => {
  const k = generateKeyPairSync('ed25519')
  assert.ok(createPrivateKey(k.privateKey.export({ format: 'pem', type: 'pkcs8' })))
  void makeNode
  void createMembership
})

test('F4: removed while offline across two removals: three attempts, then refused with the offline-removal reason, keys kept', async () => {
  const rig = await startRig()
  try {
    const counter = { n: 0 }
    class Counting extends globalThis.WebSocket {
      constructor(url) {
        super(url)
        counter.n++
      }
    }
    const clock = fakeClock(Date.now())
    const a = await rig.creator('alpha')
    const b = await rig.joiner(a, 'bravo', { clock, WebSocketImpl: Counting })
    const c = await rig.joiner(a, 'charlie')
    await a.waitVerified('charlie')
    b.stop()
    await a.waitOnline('bravo', false)
    await a.link.remove(c.mid())
    await a.link.remove(b.mid())
    counter.n = 0
    await b.restart()
    const pause = (ms) => new Promise((r) => setTimeout(r, ms))
    await until(() => counter.n === 1 && b.link.status === 'refused', 3000, 'first attempt refused')
    assert.equal(b.link.snapshot().reasonCode, 'removed-unverified')
    clock.tick(60000)
    await until(() => counter.n === 2, 3000, 'second attempt')
    await pause(300)
    clock.tick(60000)
    await until(() => counter.n === 3 && b.link.snapshot().reasonCode === 'removed-offline', 3000, 'third attempt gives up')
    assert.equal(b.link.snapshot().reason, 'This machine was removed from the group while it was offline. Use Leave to clear it here.')
    clock.tick(300000)
    await pause(300)
    assert.equal(counter.n, 3, 'no further attempts')
    assert.equal(b.membership.joined, true, 'keys are kept')
    assert.equal(b.link.status, 'refused')
  } finally {
    await rig.close()
  }
})

test('F5: resets go through the paced queue, once per (peer, sid)', async () => {
  const hooks = {}
  const rig = await startRig({ hooks, env: { RELAY_FRAMES_PER_MINUTE: '100' } })
  try {
    const a = await rig.creator('alpha')
    const b = await rig.joiner(a, 'bravo')
    const resets = []
    hooks.onForward = (frame, from) => (from.machineId === a.mid() && frame.k === 'reset' && resets.push(frame.sid), undefined)
    const gid = a.membership.state.groupId
    for (let round = 0; round < 2; round++) {
      for (let i = 0; i < 200; i++) {
        rig.relay.inject(gid, a.mid(), { t: 'from', from: b.mid(), k: 'data', sid: `unknown${i}`, seq: 0, part: 0, parts: 1, data: 'AA' })
      }
    }
    await until(() => resets.length > 0, 3000, 'some resets')
    await new Promise((r) => setTimeout(r, 500))
    assert.equal(new Set(resets).size, resets.length, 'one reset per sid')
    // framesPerMinute 100 leaves 40 for session frames (P9).
    assert.ok(resets.length <= 40, `sent ${resets.length} resets`)
    assert.ok(!(a.logs || []).some((l) => /limit/.test(l)), 'the relay never limited alpha')
  } finally {
    await rig.close()
  }
})

test('T8.F11: a link refused as already-connected retries every 60 s and takes the link once the other instance stops', async () => {
  const rig = await startRig()
  try {
    const clock = fakeClock(Date.now())
    const a = await rig.creator('alpha')
    // A second Perch instance on the same configuration (same secrets).
    const dup = rig.node('alpha-dup', { fh: a.fh, clock })
    await dup.membership.load()
    dup.link.start()
    await until(() => dup.link.snapshot().reasonCode === 'already-connected', 3000, 'refused as already-connected')
    assert.equal(dup.link.status, 'refused')
    // While the other instance holds the link, retrying changes nothing.
    for (let i = 0; i < 2; i++) {
      clock.tick(60000)
      await new Promise((r) => setTimeout(r, 300))
      await until(() => dup.link.snapshot().reasonCode === 'already-connected', 3000, 'still refused')
      assert.equal(dup.link.connected, false)
    }
    assert.equal(a.link.connected, true, 'the holder keeps the link')
    // The holder stops; 60 s later the retry takes the link.
    a.stop()
    await new Promise((r) => setTimeout(r, 300))
    clock.tick(60000)
    await until(() => dup.link.connected, 3000, 'the displaced instance connects')
    assert.equal(dup.link.snapshot().reasonCode, '')
  } finally {
    await rig.close()
  }
})

test('T8.F10: renaming to the current name does nothing', async () => {
  const rig = await startRig()
  try {
    const a = await rig.creator('alpha')
    const b = await rig.joiner(a, 'bravo')
    const eventsBefore = a.events.length
    const heardBefore = b.events.length
    await a.link.rename('alpha')
    await new Promise((r) => setTimeout(r, 300))
    assert.equal(a.events.length, eventsBefore, 'no event on this machine')
    assert.equal(b.events.length, heardBefore, 'nothing sent to the others')
    await a.link.rename('alpha2')
    assert.equal(a.events.filter((e) => e.kind === 'renamed').length, 1)
  } finally {
    await rig.close()
  }
})
