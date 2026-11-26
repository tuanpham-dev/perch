// Wire format of the Perch relay, shared by the relay server and the Assistant
// extension's relay link. This file is kept byte-identical in two places:
// extensions/_shared/relayWire.mjs (the source) and relay/src/wire.mjs (so the
// relay folder runs on its own). scripts/relay-wire-drift.test.mjs fails when
// they differ. Edit the source, then copy it over the other one.
//
// Conventions used by both sides:
// - Public keys (signPub, dhPub, enrolPub) are the raw 32 bytes, base64url
//   without padding (43 characters), the same text as the JWK "x" member.
// - Signatures are the raw 64-byte Ed25519 signature, base64url.
// - Machine ids are 32 lowercase hex characters.
// - Times are milliseconds since the epoch.

export const PROTOCOL_MIN = 1
export const PROTOCOL_MAX = 1

export const DEFAULT_LIMITS = Object.freeze({
  frameBytes: 262144,
  framesPerMinute: 600,
  machinesPerGroup: 50,
  authFailsPerMinute: 5,
})

export const NAME_RE = /^[A-Za-z0-9._-]{1,40}$/
export const ID_RE = /^[0-9a-f]{32}$/
export const KEY_RE = /^[A-Za-z0-9_-]{43}$/
export const KEEPALIVE_MS = 25000
export const DEAD_MS = 60000

// Allowed values of `k` on `to` and `from` frames.
export const K_VALUES = Object.freeze(['hs1', 'hs2', 'hs3', 'data', 'reset'])

export const ERROR_CODES = Object.freeze([
  'version',
  'auth-method',
  'admin-secret',
  'credential',
  'removed',
  'blocked',
  'already-connected',
  'invite',
  'no-admitter',
  'limit',
  'route',
  'offline',
  'epoch-conflict',
  'bad-frame',
])

// Largest sealed profile a machine may store on the relay, in characters.
export const PROFILE_MAX = 4096

// Reasons in `admit.refused`.
export const ADMIT_REFUSALS = Object.freeze([
  'not-pending',
  'unknown',
  'revoked',
  'cancelled',
  'used',
  'expired',
  'epoch',
  'group-full',
])

export const INVITE_REASONS = Object.freeze(['expired', 'used', 'revoked', 'cancelled', 'unknown'])

// Field types: string, number, boolean, object (not null, not an array),
// array, range (an array of two integers, [min, max]).
// `req` fields must be present with the right type; `opt` fields may be missing
// but must have the right type when present. Unknown extra fields are ignored.
const ROUTED = {
  req: { k: 'string', sid: 'string' },
  opt: { seq: 'number', part: 'number', parts: 'number', data: 'string' },
}

export const FRAMES = Object.freeze({
  // Machine -> relay
  hello: {
    req: { v: 'range', auth: 'string', machineId: 'string' },
    opt: {
      groupId: 'string',
      signPub: 'string',
      dhPub: 'string',
      label: 'string',
      adminSecret: 'string',
      inviteId: 'string',
    },
  },
  prove: { req: { sig: 'string' }, opt: {} },
  ping: { req: {}, opt: {} },
  'probe-ack': { req: {}, opt: {} },
  'profile.put': { req: { blob: 'string', epoch: 'number' }, opt: {} },
  'label.set': { req: { label: 'string' }, opt: {} },
  'invite.create': {
    req: { id: 'string', enrolPub: 'string', expiresAt: 'number', uses: 'number' },
    opt: {},
  },
  'invite.revoke': { req: { id: 'string' }, opt: {} },
  admit: { req: { machineId: 'string', inviteId: 'string', epoch: 'number' }, opt: {} },
  remove: { req: { record: 'object', fromEpoch: 'number', packages: 'object' }, opt: {} },
  leave: { req: { sig: 'string' }, opt: {} },
  to: { req: { to: 'string', ...ROUTED.req }, opt: ROUTED.opt },
  // Relay -> machine
  challenge: { req: { nonce: 'string' }, opt: {} },
  welcome: {
    req: { v: 'number', groupId: 'string', epoch: 'number', limits: 'object' },
    opt: { pending: 'boolean' },
  },
  ok: { req: { re: 'string' }, opt: {} },
  error: {
    req: { code: 'string', message: 'string' },
    opt: {
      limit: 'string',
      to: 'string',
      sid: 'string',
      reason: 'string',
      epoch: 'number',
      record: 'object',
    },
  },
  probe: { req: {}, opt: {} },
  directory: { req: { machines: 'array', invites: 'array' }, opt: {} },
  presence: {
    req: { machineId: 'string', online: 'boolean', conn: 'number', lastSeen: 'number' },
    opt: {},
  },
  'join.request': {
    req: { machineId: 'string', inviteId: 'string', signPub: 'string', dhPub: 'string' },
    opt: {},
  },
  'admit.ok': { req: { machineId: 'string' }, opt: {} },
  'admit.refused': { req: { machineId: 'string', reason: 'string' }, opt: {} },
  'remove.ok': { req: { epoch: 'number' }, opt: {} },
  rekey: { req: { record: 'object', sealed: 'string' }, opt: {} },
  from: { req: { from: 'string', ...ROUTED.req }, opt: ROUTED.opt },
})

function typeOk(value, type) {
  switch (type) {
    case 'string':
      return typeof value === 'string'
    case 'number':
      return typeof value === 'number' && Number.isFinite(value)
    case 'boolean':
      return typeof value === 'boolean'
    case 'object':
      return value !== null && typeof value === 'object' && !Array.isArray(value)
    case 'array':
      return Array.isArray(value)
    case 'range':
      return (
        Array.isArray(value) &&
        value.length === 2 &&
        Number.isInteger(value[0]) &&
        Number.isInteger(value[1]) &&
        value[0] <= value[1]
      )
    default:
      return false
  }
}

export function encodeFrame(obj) {
  return JSON.stringify(obj)
}

// Returns the frame object, or null for anything that is not a valid frame.
export function decodeFrame(text) {
  let obj
  try {
    obj = JSON.parse(text)
  } catch {
    return null
  }
  if (!typeOk(obj, 'object')) return null
  const shape = typeof obj.t === 'string' && Object.hasOwn(FRAMES, obj.t) ? FRAMES[obj.t] : null
  if (!shape) return null
  for (const [name, type] of Object.entries(shape.req)) {
    if (!typeOk(obj[name], type)) return null
  }
  for (const [name, type] of Object.entries(shape.opt)) {
    if (obj[name] !== undefined && !typeOk(obj[name], type)) return null
  }
  if ((obj.t === 'to' || obj.t === 'from') && !K_VALUES.includes(obj.k)) return null
  if (obj.t === 'error' && !ERROR_CODES.includes(obj.code)) return null
  return obj
}

// Highest protocol version both sides speak. `a` and `b` are [min, max].
// `older` says which side is behind when there is no overlap: "a" when a's
// whole range is below b's, "b" for the reverse, null when they overlap.
export function pickVersion(a, b) {
  const low = Math.max(a[0], b[0])
  const high = Math.min(a[1], b[1])
  if (low <= high) return { version: high, older: null }
  return { version: null, older: a[1] < b[0] ? 'a' : 'b' }
}

// JSON with keys sorted at every level, so two sides sign the same bytes.
export function canonical(value) {
  return JSON.stringify(sortKeys(value))
}

function sortKeys(value) {
  if (Array.isArray(value)) return value.map(sortKeys)
  if (value !== null && typeof value === 'object') {
    const out = {}
    for (const key of Object.keys(value).sort()) {
      if (value[key] !== undefined) out[key] = sortKeys(value[key])
    }
    return out
  }
  return value
}

export function challengeString(nonce, groupId, machineId) {
  return 'perch-relay-auth-v1\n' + nonce + '\n' + groupId + '\n' + machineId
}
