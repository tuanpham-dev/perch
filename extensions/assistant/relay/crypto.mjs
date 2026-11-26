// Cryptography of the Perch relay link, written against rules P1, P2, P4 and P5
// of plans/relay-server.md. Only node:crypto and the shared wire file are used.
//
// Conventions (same as relayWire.mjs): public keys are the raw 32 bytes in
// base64url without padding, signatures are the raw 64 bytes in base64url,
// private keys are PKCS#8 DER in base64url, group secrets are 32 bytes in
// base64url. Everything that is signed is a string, signed as UTF-8.

import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  randomBytes,
  sign as cryptoSign,
  timingSafeEqual,
  verify as cryptoVerify,
} from 'node:crypto'
import {
  canonical,
  challengeString,
  ID_RE,
  KEY_RE,
  PROFILE_MAX,
  PROTOCOL_MAX,
  PROTOCOL_MIN,
  pickVersion,
} from '../../_shared/relayWire.mjs'

const HKDF_SALT = 'perch-relay'
const SESSION_TAG = 'perch-relay-session-v1'
const INVITE_PREFIX = 'perch-invite:1:'
const INVITE_MAX_CHARS = 2048
const NOT_AN_INVITE = 'That is not a Perch invite.'
const NONCE_LEN = 12
const TAG_LEN = 16
const MAX_COUNTER = Number.MAX_SAFE_INTEGER

function fail(code, message, extra) {
  return Object.assign(new Error(message), { code }, extra)
}

// ---- encodings and keys ----

const b64u = (buf) => Buffer.from(buf).toString('base64url')
const fromB64u = (text) => Buffer.from(text, 'base64url')

function toBuf(value) {
  return Buffer.isBuffer(value) ? value : typeof value === 'string' ? fromB64u(value) : Buffer.from(value)
}

function privateKeyObject(text) {
  return createPrivateKey({ key: fromB64u(text), format: 'der', type: 'pkcs8' })
}

function publicKeyObject(curve, text) {
  if (typeof text !== 'string' || !KEY_RE.test(text)) throw fail('key', 'Not a public key.')
  return createPublicKey({ key: { kty: 'OKP', crv: curve, x: text }, format: 'jwk' })
}

function newPair(type) {
  const { publicKey, privateKey } = generateKeyPairSync(type)
  return {
    priv: b64u(privateKey.export({ format: 'der', type: 'pkcs8' })),
    pub: publicKey.export({ format: 'jwk' }).x,
  }
}

export function newIdentity() {
  const s = newPair('ed25519')
  const d = newPair('x25519')
  return {
    machineId: randomBytes(16).toString('hex'),
    signKey: s.priv,
    signPub: s.pub,
    dhKey: d.priv,
    dhPub: d.pub,
  }
}

function hkdf(ikm, info) {
  return Buffer.from(hkdfSync('sha256', ikm, HKDF_SALT, info, 32))
}

const lp = (value) => {
  const bytes = Buffer.from(String(value))
  const head = Buffer.alloc(4)
  head.writeUInt32BE(bytes.length)
  return Buffer.concat([head, bytes])
}

// ---- signatures ----

export function sign(signKey, text) {
  return b64u(cryptoSign(null, Buffer.from(text), privateKeyObject(signKey)))
}

export function verifySig(signPub, text, sig) {
  try {
    if (typeof sig !== 'string') return false
    return cryptoVerify(null, Buffer.from(text), publicKeyObject('Ed25519', signPub), fromB64u(sig))
  } catch {
    return false
  }
}

// ---- vouches ----

export function vouchFor(secret, epoch, { machineId, signPub, dhPub }) {
  const key = hkdf(toBuf(secret), 'vouch:' + epoch)
  return b64u(createHmac('sha256', key).update(machineId + '\n' + signPub + '\n' + dhPub).digest())
}

export function checkVouch(secret, epoch, keys, vouch) {
  try {
    if (typeof vouch !== 'string') return false
    const want = fromB64u(vouchFor(secret, epoch, keys))
    const got = fromB64u(vouch)
    return got.length === want.length && timingSafeEqual(got, want)
  } catch {
    return false
  }
}

// ---- AEAD helpers (ChaCha20-Poly1305) ----

function aeadSeal(key, nonce, plaintext, aad) {
  const c = createCipheriv('chacha20-poly1305', key, nonce, { authTagLength: TAG_LEN })
  c.setAAD(Buffer.from(aad))
  return Buffer.concat([c.update(plaintext), c.final(), c.getAuthTag()])
}

function aeadOpen(key, nonce, body, aad) {
  if (body.length < TAG_LEN) throw fail('open', 'Could not open that message.')
  try {
    const d = createDecipheriv('chacha20-poly1305', key, nonce, { authTagLength: TAG_LEN })
    d.setAAD(Buffer.from(aad))
    d.setAuthTag(body.subarray(body.length - TAG_LEN))
    return Buffer.concat([d.update(body.subarray(0, body.length - TAG_LEN)), d.final()])
  } catch {
    throw fail('open', 'Could not open that message.')
  }
}

// ---- profile blobs ----

export function sealProfile(secret, epoch, machineId, obj) {
  const key = hkdf(toBuf(secret), 'profile:' + epoch)
  const nonce = randomBytes(NONCE_LEN)
  const blob = b64u(Buffer.concat([nonce, aeadSeal(key, nonce, Buffer.from(JSON.stringify(obj)), machineId)]))
  if (blob.length > PROFILE_MAX) throw fail('too-large', 'That profile is too large.')
  return blob
}

export function openProfile(secret, epoch, machineId, blob) {
  if (typeof blob !== 'string' || blob.length > PROFILE_MAX) throw fail('open', 'Could not open that profile.')
  const raw = fromB64u(blob)
  if (raw.length < NONCE_LEN) throw fail('open', 'Could not open that profile.')
  const key = hkdf(toBuf(secret), 'profile:' + epoch)
  const plain = aeadOpen(key, raw.subarray(0, NONCE_LEN), raw.subarray(NONCE_LEN), machineId)
  try {
    return JSON.parse(plain.toString('utf8'))
  } catch {
    throw fail('open', 'Could not open that profile.')
  }
}

// ---- sealed boxes to a public key ----

// Output: one-time public key (32) + nonce (12) + ciphertext + tag (16).
export function sealTo(dhPub, plaintext, aad) {
  const eph = generateKeyPairSync('x25519')
  const shared = diffieHellman({ privateKey: eph.privateKey, publicKey: publicKeyObject('X25519', dhPub) })
  const key = hkdf(shared, 'sealed')
  const nonce = randomBytes(NONCE_LEN)
  const epk = fromB64u(eph.publicKey.export({ format: 'jwk' }).x)
  return Buffer.concat([epk, nonce, aeadSeal(key, nonce, Buffer.from(plaintext), aad)])
}

export function openSealed(dhKey, blob, aad) {
  const raw = Buffer.from(blob)
  if (raw.length < 32 + NONCE_LEN + TAG_LEN) throw fail('open', 'Could not open that message.')
  let key
  try {
    const shared = diffieHellman({
      privateKey: privateKeyObject(dhKey),
      publicKey: publicKeyObject('X25519', b64u(raw.subarray(0, 32))),
    })
    key = hkdf(shared, 'sealed')
  } catch {
    throw fail('open', 'Could not open that message.')
  }
  return aeadOpen(key, raw.subarray(32, 32 + NONCE_LEN), raw.subarray(32 + NONCE_LEN), aad)
}

// ---- removal (P4) and accepting a re-key (P5) ----

const RECORD_KEYS = ['groupId', 'removedId', 'epoch', 'by', 'bySignPub', 'byDhPub', 'byVouch', 'confirm']

function recordBody(record) {
  const body = {}
  for (const k of RECORD_KEYS) body[k] = record[k]
  return body
}

function confirmFor(secret, epoch) {
  return hkdf(toBuf(secret), 'confirm:' + epoch).toString('base64')
}

function packageAad(record, recipientId) {
  return canonical(recordBody(record)) + '\n' + recipientId
}

// recipients: [{machineId, dhPub}]. The remover is always sealed to itself.
export function makeRemoval({ self, groupId, removedId, oldGroup, recipients }) {
  if (removedId === self.machineId) throw fail('self', 'A machine cannot remove itself.')
  const epoch = oldGroup.epoch + 1
  const secret = randomBytes(32)
  const body = {
    groupId,
    removedId,
    epoch,
    by: self.machineId,
    bySignPub: self.signPub,
    byDhPub: self.dhPub,
    byVouch: vouchFor(oldGroup.secret, oldGroup.epoch, self),
    confirm: confirmFor(secret, epoch),
  }
  const record = { ...body, sig: sign(self.signKey, canonical(body)) }
  const targets = new Map([[self.machineId, self.dhPub]])
  for (const r of recipients) if (r.machineId !== removedId) targets.set(r.machineId, r.dhPub)
  const packages = {}
  for (const [id, dhPub] of targets) packages[id] = b64u(sealTo(dhPub, secret, packageAad(body, id)))
  return { group: { secret: b64u(secret), epoch }, record, packages }
}

function pinnedEntry(pinned, id) {
  if (!pinned) return null
  if (Array.isArray(pinned)) return pinned.find((p) => p && p.machineId === id) || null
  if (pinned instanceof Map) return pinned.get(id) || null
  return Object.hasOwn(pinned, id) ? pinned[id] : null
}

function shapeOk(record) {
  if (record === null || typeof record !== 'object' || Array.isArray(record)) return false
  for (const k of Object.keys(record)) if (k !== 'sig' && !RECORD_KEYS.includes(k)) return false
  return (
    ID_RE.test(record.groupId) &&
    ID_RE.test(record.removedId) &&
    ID_RE.test(record.by) &&
    Number.isSafeInteger(record.epoch) &&
    KEY_RE.test(record.bySignPub) &&
    KEY_RE.test(record.byDhPub) &&
    typeof record.byVouch === 'string' &&
    typeof record.confirm === 'string' &&
    typeof record.sig === 'string'
  )
}

// The checks of P5 that need no package: the record is for this group, is the
// next epoch, is not by a removed machine, comes from a trusted remover and is
// signed. Used by acceptRemoval and, for P6, on its own. Throws with `code`:
// malformed, group, stale (epoch <= own: already applied, not a failure),
// target, epoch, remover-removed, remover-untrusted, signature.
// group: {groupId, secret, epoch}; pinned: machineId -> {signPub, dhPub}
// (an object, a Map, or an array of {machineId, signPub, dhPub}).
export function verifyRemovalRecord({ group, removedIds, pinned, record }) {
  if (!shapeOk(record)) throw fail('malformed', 'That re-key record is malformed.')
  if (record.removedId === record.by) throw fail('target', 'That re-key removes its own author.')
  if (record.groupId !== group.groupId) throw fail('group', 'That re-key is for another group.')
  if (record.epoch <= group.epoch) throw fail('stale', 'That re-key was already applied.')
  if (record.epoch !== group.epoch + 1) throw fail('epoch', 'That re-key skips an epoch.')
  if ((removedIds || []).includes(record.by)) throw fail('remover-removed', 'That re-key is by a removed machine.')
  const pin = pinnedEntry(pinned, record.by)
  const keys = { machineId: record.by, signPub: record.bySignPub, dhPub: record.byDhPub }
  // A pinned machine must present its pinned keys; a changed key is never
  // rescued by a vouch.
  const trusted = pin
    ? pin.signPub === record.bySignPub && pin.dhPub === record.byDhPub
    : checkVouch(group.secret, group.epoch, keys, record.byVouch)
  if (!trusted) throw fail('remover-untrusted', 'The machine that re-keyed the group is not trusted.')
  if (!verifySig(record.bySignPub, canonical(recordBody(record)), record.sig)) {
    throw fail('signature', 'That re-key record is not signed correctly.')
  }
}

// Returns the new {secret, epoch} (secret as base64url) or throws; see
// verifyRemovalRecord for codes, then `package` and `confirm`.
export function acceptRemoval({ self, group, removedIds, pinned, record, sealed }) {
  verifyRemovalRecord({ group, removedIds, pinned, record })
  if (record.removedId === self.machineId) throw fail('target', 'That re-key removes this machine.')
  let secret
  try {
    secret = openSealed(self.dhKey, fromB64u(sealed), packageAad(record, self.machineId))
  } catch {
    throw fail('package', 'The re-key package did not open.')
  }
  if (secret.length !== 32) throw fail('package', 'The re-key package did not open.')
  const want = Buffer.from(confirmFor(secret, record.epoch))
  const got = Buffer.from(record.confirm)
  if (got.length !== want.length || !timingSafeEqual(got, want)) {
    throw fail('confirm', 'The re-key package does not match its record.')
  }
  return { secret: b64u(secret), epoch: record.epoch }
}

// ---- sessions (P1) ----

function rangeOk(v) {
  return (
    Array.isArray(v) && v.length === 2 && Number.isInteger(v[0]) && Number.isInteger(v[1]) && v[0] <= v[1]
  )
}

function validPeer(peerId, peerSignPub) {
  if (typeof peerId !== 'string' || !ID_RE.test(peerId)) throw fail('handshake', 'Not a machine id.')
  if (typeof peerSignPub !== 'string' || !KEY_RE.test(peerSignPub)) throw fail('handshake', 'Not a public key.')
}

// A supplied psk must be exactly 32 bytes (base64url text or a Buffer); an
// explicit undefined, null or '' is an error, never "no psk".
function pskBytes(psk) {
  let bytes = null
  if (typeof psk === 'string' && /^[A-Za-z0-9_-]+$/.test(psk)) bytes = fromB64u(psk)
  else if (Buffer.isBuffer(psk)) bytes = psk
  if (!bytes || bytes.length !== 32) throw fail('handshake', 'The admission secret is not valid.')
  return bytes
}

// SHA-256 of the tag, group, both ids, both ephemeral keys, both version
// ranges and (when given) the role. Fields are length-prefixed.
function transcript(t, role) {
  const h = createHash('sha256')
  const fields = [SESSION_TAG, t.groupId, t.idA, t.idB, t.eA, t.eB, t.rangeA.join(','), t.rangeB.join(',')]
  if (role) fields.push(role)
  for (const f of fields) h.update(lp(f))
  return h.digest()
}

function versionOrThrow(rangeA, rangeB, peerIsA) {
  const picked = pickVersion(rangeA, rangeB)
  if (picked.version === null) {
    const aOlder = picked.older === 'a'
    throw fail('version', 'The two machines share no protocol version.', {
      older: aOlder === peerIsA ? 'peer' : 'self',
    })
  }
  return picked.version
}

// hasPsk is true when the caller supplied a psk argument at all.
function deriveKeys(ownPriv, peerEph, hasPsk, psk, t) {
  const pskPart = hasPsk ? pskBytes(psk) : Buffer.alloc(32)
  const sfx = hasPsk ? ':psk' : ''
  try {
    const shared = diffieHellman({ privateKey: privateKeyObject(ownPriv), publicKey: publicKeyObject('X25519', peerEph) })
    const ikm = Buffer.concat([shared, pskPart])
    const salt = transcript(t)
    const out = (info) => Buffer.from(hkdfSync('sha256', ikm, salt, info + sfx, 32))
    return { a2b: out('a2b'), b2a: out('b2a'), confirm: out('confirm'), hasPsk }
  } catch (e) {
    if (e && e.code === 'handshake') throw e
    throw fail('handshake', 'That handshake message is not valid.')
  }
}

// Key confirmation: an HMAC over the role-tagged transcript hash.
function confirmTag(confirmKey, t, role) {
  return createHmac('sha256', confirmKey).update(transcript(t, role)).digest()
}

function checkConfirm(keys, t, role, got) {
  let ok = false
  if (typeof got === 'string' && KEY_RE.test(got)) {
    const want = confirmTag(keys.confirm, t, role)
    const have = fromB64u(got)
    ok = have.length === want.length && timingSafeEqual(have, want)
  }
  if (!ok) {
    throw keys.hasPsk
      ? fail('psk', 'The admission secret does not match.')
      : fail('handshake', 'The other machine did not prove the shared key.')
  }
}

function makeSession(sendKey, recvKey, selfId, peerId, version) {
  return { sendKey, recvKey, sendCounter: 0, recvCounter: 0, selfId, peerId, version }
}

const signText = (hash) => hash.toString('base64url')

export function startSession(self, groupId) {
  const eph = newPair('x25519')
  const v = [PROTOCOL_MIN, PROTOCOL_MAX]
  return { state: { self, groupId, eKey: eph.priv, e: eph.pub, v, used: false }, msg1: { e: eph.pub, v } }
}

export function answerSession(self, groupId, peerId, peerSignPub, msg1, ...rest) {
  const hasPsk = rest.length > 0
  validPeer(peerId, peerSignPub)
  if (!msg1 || typeof msg1.e !== 'string' || !KEY_RE.test(msg1.e) || !rangeOk(msg1.v)) {
    throw fail('handshake', 'That handshake message is not valid.')
  }
  const mine = [PROTOCOL_MIN, PROTOCOL_MAX]
  const version = versionOrThrow(msg1.v, mine, true)
  const eph = newPair('x25519')
  const t = { groupId, idA: peerId, idB: self.machineId, eA: msg1.e, eB: eph.pub, rangeA: msg1.v, rangeB: mine }
  const keys = deriveKeys(eph.priv, msg1.e, hasPsk, rest[0], t)
  const sig = sign(self.signKey, signText(transcript(t, 'b')))
  return {
    pending: {
      used: false,
      peerSignPub,
      expect: signText(transcript(t, 'a')),
      keys,
      t,
      session: [keys.b2a, keys.a2b, self.machineId, peerId, version],
    },
    msg2: { e: eph.pub, v: mine, sig, conf: b64u(confirmTag(keys.confirm, t, 'b')) },
  }
}

export function finishSession(state, peerId, peerSignPub, msg2, ...rest) {
  const hasPsk = rest.length > 0
  try {
    validPeer(peerId, peerSignPub)
    if (state.used) throw fail('handshake', 'That handshake was already used.')
    if (!msg2 || typeof msg2.e !== 'string' || !KEY_RE.test(msg2.e) || !rangeOk(msg2.v) || typeof msg2.sig !== 'string') {
      throw fail('handshake', 'That handshake message is not valid.')
    }
    const t = {
      groupId: state.groupId,
      idA: state.self.machineId,
      idB: peerId,
      eA: state.e,
      eB: msg2.e,
      rangeA: state.v,
      rangeB: msg2.v,
    }
    if (!verifySig(peerSignPub, signText(transcript(t, 'b')), msg2.sig)) {
      throw fail('handshake', 'The other machine did not prove who it is.')
    }
    const version = versionOrThrow(state.v, msg2.v, false)
    state.used = true
    const keys = deriveKeys(state.eKey, msg2.e, hasPsk, rest[0], t)
    checkConfirm(keys, t, 'b', msg2.conf)
    return {
      session: makeSession(keys.a2b, keys.b2a, state.self.machineId, peerId, version),
      msg3: { sig: sign(state.self.signKey, signText(transcript(t, 'a'))), conf: b64u(confirmTag(keys.confirm, t, 'a')) },
    }
  } finally {
    state.used = true
    state.eKey = null
  }
}

export function confirmSession(pending, msg3) {
  if (pending.used) throw fail('handshake', 'That handshake was already used.')
  if (!msg3 || !verifySig(pending.peerSignPub, pending.expect, msg3.sig)) {
    throw fail('handshake', 'The other machine did not prove who it is.')
  }
  checkConfirm(pending.keys, pending.t, 'a', msg3.conf)
  pending.used = true
  return makeSession(...pending.session)
}

function counterNonce(counter) {
  const nonce = Buffer.alloc(NONCE_LEN)
  nonce.writeBigUInt64BE(BigInt(counter), 4)
  return nonce
}

// The blob is ciphertext + tag. The counter is not sent: it is the nonce, so a
// replayed, dropped or reordered blob fails to open.
export function seal(session, bytes) {
  if (session.sendCounter >= MAX_COUNTER) throw fail('exhausted', 'This session has sent too many messages.')
  const blob = aeadSeal(
    session.sendKey,
    counterNonce(session.sendCounter),
    Buffer.from(bytes),
    session.selfId + '\n' + session.peerId,
  )
  session.sendCounter += 1
  return blob
}

export function open(session, blob) {
  const plain = aeadOpen(
    session.recvKey,
    counterNonce(session.recvCounter),
    Buffer.from(blob),
    session.peerId + '\n' + session.selfId,
  )
  session.recvCounter += 1
  return plain
}

// ---- invites (P2) ----

export function newInvite({ relay, group, expiresAt }) {
  const k = newPair('ed25519')
  const id = randomBytes(16).toString('hex')
  const admit = b64u(randomBytes(32))
  const json = JSON.stringify({ relay, group, invite: id, enrolKey: k.priv, admit, exp: expiresAt })
  const string = INVITE_PREFIX + b64u(Buffer.from(json))
  decodeInvite(string)
  return { id, enrolKey: k.priv, enrolPub: k.pub, admit, string }
}

export function decodeInvite(text) {
  const err = fail('invite', NOT_AN_INVITE)
  try {
    if (typeof text !== 'string') throw err
    const trimmed = text.trim()
    if (trimmed.length > INVITE_MAX_CHARS || !trimmed.startsWith(INVITE_PREFIX)) throw err
    const body = trimmed.slice(INVITE_PREFIX.length)
    if (!/^[A-Za-z0-9_-]+$/.test(body)) throw err
    const o = JSON.parse(fromB64u(body).toString('utf8'))
    if (o === null || typeof o !== 'object' || Array.isArray(o)) throw err
    if (typeof o.relay !== 'string' || o.relay.length > 512) throw err
    const url = new URL(o.relay)
    if (url.protocol !== 'ws:' && url.protocol !== 'wss:') throw err
    if (typeof o.group !== 'string' || !ID_RE.test(o.group)) throw err
    if (typeof o.invite !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(o.invite)) throw err
    if (typeof o.admit !== 'string' || !KEY_RE.test(o.admit)) throw err
    if (typeof o.exp !== 'number' || !Number.isSafeInteger(o.exp) || o.exp <= 0) throw err
    if (typeof o.enrolKey !== 'string' || !/^[A-Za-z0-9_-]{1,200}$/.test(o.enrolKey)) throw err
    const key = privateKeyObject(o.enrolKey)
    if (key.asymmetricKeyType !== 'ed25519') throw err
    const enrolPub = createPublicKey(key).export({ format: 'jwk' }).x
    return { relay: o.relay, group: o.group, invite: o.invite, enrolKey: o.enrolKey, enrolPub, admit: o.admit, exp: o.exp }
  } catch {
    throw err
  }
}

// The newcomer's proof of holding the invite: the relay's challenge string
// plus both public keys, signed with the invite's enrolment key.
export function joinProof(enrolKey, nonce, groupId, machineId, signPub, dhPub) {
  return sign(enrolKey, challengeString(nonce, groupId, machineId) + '\n' + signPub + '\n' + dhPub)
}
