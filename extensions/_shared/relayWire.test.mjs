import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  DEFAULT_LIMITS,
  ERROR_CODES,
  FRAMES,
  NAME_RE,
  PROTOCOL_MAX,
  PROTOCOL_MIN,
  canonical,
  challengeString,
  decodeFrame,
  encodeFrame,
  pickVersion,
} from './relayWire.mjs'

const ID = 'a'.repeat(32)
const KEY = 'A'.repeat(43)

// One valid example per frame type, and one invalid example (a required field
// missing or mistyped).
const examples = {
  hello: [{ v: [1, 1], auth: 'machine-key', machineId: ID, groupId: 'g' }, { v: [1], auth: 'create', machineId: ID }],
  prove: [{ sig: 's' }, { sig: 5 }],
  ping: [{}, null],
  'probe-ack': [{}, null],
  'profile.put': [{ blob: 'b', epoch: 2 }, { blob: 'b', epoch: '2' }],
  'label.set': [{ label: 'x' }, { label: null }],
  'invite.create': [
    { id: 'i', enrolPub: KEY, expiresAt: 1, uses: 1 },
    { id: 'i', enrolPub: KEY, expiresAt: 1 },
  ],
  'invite.revoke': [{ id: 'i' }, {}],
  admit: [{ machineId: ID, inviteId: 'i', epoch: 1 }, { machineId: ID, inviteId: 'i' }],
  remove: [{ record: {}, fromEpoch: 1, packages: {} }, { record: [], fromEpoch: 1, packages: {} }],
  leave: [{ sig: 's' }, {}],
  to: [{ to: ID, k: 'hs1', sid: 's', data: 'x' }, { to: ID, k: 'nope', sid: 's' }],
  challenge: [{ nonce: 'n' }, { nonce: 1 }],
  welcome: [
    { v: 1, groupId: 'g', epoch: 1, limits: { frameBytes: 1, framesPerMinute: 1 }, pending: true },
    { v: 1, groupId: 'g', epoch: 1 },
  ],
  ok: [{ re: 'leave' }, {}],
  error: [{ code: 'limit', message: 'm', limit: 'frameBytes' }, { code: 'made-up', message: 'm' }],
  probe: [{}, null],
  directory: [{ machines: [], invites: [] }, { machines: {}, invites: [] }],
  presence: [
    { machineId: ID, online: true, conn: 1, lastSeen: 1 },
    { machineId: ID, online: 'yes', conn: 1, lastSeen: 1 },
  ],
  'join.request': [
    { machineId: ID, inviteId: 'i', signPub: KEY, dhPub: KEY },
    { machineId: ID, inviteId: 'i', signPub: KEY },
  ],
  'admit.ok': [{ machineId: ID }, {}],
  'admit.refused': [{ machineId: ID, reason: 'used' }, { machineId: ID }],
  'remove.ok': [{ epoch: 2 }, { epoch: null }],
  rekey: [{ record: {}, sealed: 's' }, { record: {} }],
  from: [{ from: ID, k: 'data', sid: 's', seq: 1, part: 0, parts: 1, data: 'x' }, { from: ID, k: 'data' }],
}

test('every frame type has a valid and an invalid example', () => {
  assert.deepEqual(Object.keys(examples).sort(), Object.keys(FRAMES).sort())
})

for (const [t, [good, bad]] of Object.entries(examples)) {
  test(`frame ${t}: valid decodes, invalid does not`, () => {
    const frame = { t, ...good }
    assert.deepEqual(decodeFrame(encodeFrame(frame)), frame)
    if (bad !== null) assert.equal(decodeFrame(encodeFrame({ t, ...bad })), null)
    // An optional field with the wrong type is also refused.
    assert.equal(decodeFrame(encodeFrame({ t: 'to', to: ID, k: 'data', sid: 's', seq: 'x' })), null)
  })
}

test('decodeFrame rejects non-JSON, non-objects and unknown types', () => {
  for (const text of ['', 'not json', '[]', '5', 'null', '"x"', '{}', '{"t":"nope"}', '{"t":5}', '{"t":"__proto__"}', '{"t":"toString"}']) {
    assert.equal(decodeFrame(text), null, text)
  }
})

test('every error code is accepted', () => {
  for (const code of ERROR_CODES) assert.ok(decodeFrame(encodeFrame({ t: 'error', code, message: 'm' })), code)
})

test('hello version must be two ordered integers', () => {
  assert.equal(decodeFrame(encodeFrame({ t: 'hello', v: [2, 1], auth: 'create', machineId: ID })), null)
  assert.equal(decodeFrame(encodeFrame({ t: 'hello', v: [1.5, 2], auth: 'create', machineId: ID })), null)
})

test('canonical is stable under key order and sorts nested keys', () => {
  const a = { b: 1, a: { d: [{ y: 1, x: 2 }], c: null } }
  const b = { a: { c: null, d: [{ x: 2, y: 1 }] }, b: 1 }
  assert.equal(canonical(a), canonical(b))
  assert.equal(canonical(a), '{"a":{"c":null,"d":[{"x":2,"y":1}]},"b":1}')
})

test('pickVersion', () => {
  assert.deepEqual(pickVersion([1, 3], [2, 5]), { version: 3, older: null })
  assert.deepEqual(pickVersion([1, 1], [1, 1]), { version: 1, older: null })
  assert.deepEqual(pickVersion([1, 1], [2, 2]), { version: null, older: 'a' })
  assert.deepEqual(pickVersion([3, 4], [1, 2]), { version: null, older: 'b' })
})

test('constants and challenge string', () => {
  assert.equal(PROTOCOL_MIN, 1)
  assert.equal(PROTOCOL_MAX, 1)
  assert.deepEqual({ ...DEFAULT_LIMITS }, { frameBytes: 262144, framesPerMinute: 600, machinesPerGroup: 50, authFailsPerMinute: 5 })
  assert.ok(NAME_RE.test('build-box_1.x'))
  assert.ok(!NAME_RE.test('has space'))
  assert.ok(!NAME_RE.test('a'.repeat(41)))
  assert.equal(challengeString('n', 'g', 'm'), 'perch-relay-auth-v1\nn\ng\nm')
})
