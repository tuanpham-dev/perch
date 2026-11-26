// The relay: accepts WebSocket connections, authenticates machines, keeps a
// directory and presence per group, forwards opaque `to` frames between members
// of one group, and sequences admissions and removals. It never sees a name, a
// message, a group secret or an invite secret.
import { createHash, createPublicKey, randomBytes, timingSafeEqual, verify as cryptoVerify } from 'node:crypto'
import http from 'node:http'
import { WebSocketServer } from 'ws'
import { clientAddress, createCounter, trustedList } from './limits.mjs'
import { openStore } from './store.mjs'
import {
  DEAD_MS,
  ID_RE,
  KEEPALIVE_MS,
  KEY_RE,
  NAME_RE,
  PROTOCOL_MAX,
  PROFILE_MAX,
  PROTOCOL_MIN,
  canonical,
  challengeString,
  decodeFrame,
  encodeFrame,
  pickVersion,
} from './wire.mjs'

// Same set as RECORD_KEYS in extensions/assistant/relay/crypto.mjs (plus `sig`).
const REMOVAL_RECORD_KEYS = ['groupId', 'removedId', 'epoch', 'by', 'bySignPub', 'byDhPub', 'byVouch', 'confirm']
const HELLO_TIMEOUT_MS = 10000
const PROBE_TIMEOUT_MS = 5000
const NO_ADMITTER_MS = 60000
const TICK_MS = 5000
const INVITE_MIN_MS = 10 * 60 * 1000
const INVITE_MAX_MS = 7 * 24 * 60 * 60 * 1000
// Machine clocks drift; an invite made for exactly 10 minutes or 7 days must not
// be refused because the relay's clock is a little ahead or behind.
const INVITE_SLACK_MS = 30 * 1000
const ADMIN_FAILS_PER_MINUTE = 5
const OVERSIZE_STRIKES = 3
// Frames a connection may send past framesPerMinute before it is closed.
const RATE_STRIKES = 50
// Bytes the relay may have queued for one connection before it is cut off as
// not reading; at least 32 frames of the largest size.
const SEND_BUFFER_MIN = 8 * 1024 * 1024
const DEFAULT_MAX_PREAUTH_PER_ADDRESS = 20
const DEFAULT_MAX_PENDING_PER_INVITE = 5

const realClock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (t) => clearTimeout(t),
  setInterval: (fn, ms) => setInterval(fn, ms),
  clearInterval: (t) => clearInterval(t),
}

const keyCache = new Map()
function verifySig(signPub, text, sig) {
  try {
    let key = keyCache.get(signPub)
    if (!key) {
      key = createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: signPub }, format: 'jwk' })
      if (keyCache.size > 500) keyCache.clear()
      keyCache.set(signPub, key)
    }
    return cryptoVerify(null, Buffer.from(text), key, Buffer.from(sig, 'base64url'))
  } catch {
    return false
  }
}

function safeEqual(a, b) {
  const ha = createHash('sha256').update(String(a)).digest()
  const hb = createHash('sha256').update(String(b)).digest()
  return timingSafeEqual(ha, hb)
}

const INVITE_MESSAGES = {
  expired: 'This invite has expired.',
  used: 'This invite has already been used.',
  revoked: 'This invite was revoked.',
  cancelled: 'This invite was cancelled when a machine was removed.',
  unknown: 'The relay does not know this invite.',
}

// options: { config, hooks?, clock?, log? }
// hooks.onForward(frame, from, to): the `from` frame about to be delivered;
//   return a replacement frame or null to drop it (anything else keeps it).
// hooks.onSend(frame, to): any frame about to be sent; same return rules.
//   `from` and `to` look like { groupId, machineId }. Tests only.
// Returns { port, adminPort, close, inject(groupId, machineId, frame) }.
export async function startRelay({ config, hooks = {}, clock = realClock, log = () => {} }) {
  const limits = config.limits
  const store = openStore(config.dataDir, { now: clock.now })
  // A restart drops every connection, so no joiner can still be waiting.
  store.deleteAllPending()
  const trusted = trustedList(config.trustedProxies)
  const authFails = createCounter(60000, clock.now)
  const rates = createCounter(60000, clock.now)
  const adminFails = createCounter(60000, clock.now)
  const oversize = createCounter(60000, clock.now)
  const rateStrikes = createCounter(60000, clock.now)
  const maxPreauth = config.maxPreauthPerAddress ?? DEFAULT_MAX_PREAUTH_PER_ADDRESS
  const maxPendingPerInvite = config.maxPendingPerInvite ?? DEFAULT_MAX_PENDING_PER_INVITE
  // Connection numbers only ever grow, also across a restart of the relay.
  const connBase = clock.now()

  /** groupId -> Map(machineId -> connection) */
  const members = new Map()
  const pendings = new Map()
  /** "group:machine" -> last connection number handed out */
  const connNo = new Map()
  const all = new Set()
  let nextId = 1
  let closed = false

  const mapFor = (registry, groupId) => {
    let m = registry.get(groupId)
    if (!m) registry.set(groupId, (m = new Map()))
    return m
  }
  const memberConn = (groupId, id) => members.get(groupId)?.get(id)
  const keyOf = (groupId, id) => `${groupId}:${id}`

  function logf(event, c, extra = {}) {
    const parts = [event]
    if (c?.groupId) parts.push(`group=${c.groupId}`)
    if (c?.machineId) parts.push(`machine=${c.machineId}`)
    for (const k of ['type', 'size', 'code']) if (extra[k] !== undefined) parts.push(`${k}=${extra[k]}`)
    try {
      log(parts.join(' '))
    } catch {}
  }

  function send(c, frame) {
    if (c.ws.readyState !== 1) return
    if (hooks.onSend) {
      try {
        const r = hooks.onSend(frame, { groupId: c.groupId, machineId: c.machineId })
        if (r === null) return
        if (r !== undefined) frame = r
      } catch {}
    }
    const text = encodeFrame(frame)
    // A peer that does not read its socket is cut off rather than queued for.
    if (c.ws.bufferedAmount > Math.max(SEND_BUFFER_MIN, 32 * limits.frameBytes)) {
      logf('not-reading', c)
      try {
        c.ws.terminate()
      } catch {}
      return
    }
    try {
      c.ws.send(text)
      logf('send', c, { type: frame.t, size: text.length })
    } catch {}
  }

  function fail(c, code, message, extra = {}, { close = true } = {}) {
    send(c, { t: 'error', code, message, ...(c.answering ? { re: c.answering } : {}), ...extra })
    logf('refused', c, { code })
    if (close) closeConn(c)
  }

  function closeConn(c) {
    clearTimers(c)
    c.stage = 'closed'
    try {
      c.ws.close(1000)
    } catch {}
  }

  function clearTimers(c) {
    for (const name of ['helloTimer', 'admitTimer']) {
      if (c[name]) clock.clearTimeout(c[name])
      c[name] = null
    }
  }

  // ---- directory and presence ------------------------------------------------

  function directoryFrame(groupId) {
    const now = clock.now()
    const machines = []
    for (const m of store.machines(groupId)) {
      if (m.status !== 'member' && m.status !== 'blocked') continue
      const online = !!memberConn(groupId, m.id)
      machines.push({
        id: m.id,
        signPub: m.signPub,
        dhPub: m.dhPub,
        label: m.label,
        lastSeen: online ? now : m.lastSeen,
        online,
        conn: connNo.get(keyOf(groupId, m.id)) || 0,
        profile: m.profile,
        profileEpoch: m.profileEpoch,
        blocked: m.status === 'blocked',
      })
    }
    const invites = store.activeInvites(groupId, now).map((i) => ({
      id: i.id,
      createdBy: i.createdBy,
      createdAt: i.createdAt,
      expiresAt: i.expiresAt,
      usesLeft: i.usesLeft,
    }))
    return { t: 'directory', machines, invites }
  }

  function broadcast(groupId, frame, exceptId) {
    for (const [id, c] of members.get(groupId) || []) {
      if (id !== exceptId) send(c, frame)
    }
  }

  function broadcastDirectory(groupId) {
    if (!store.group(groupId)) return
    const frame = directoryFrame(groupId)
    broadcast(groupId, frame)
  }

  function presenceFrame(groupId, machineId, online) {
    return {
      t: 'presence',
      machineId,
      online,
      conn: connNo.get(keyOf(groupId, machineId)) || 0,
      lastSeen: clock.now(),
    }
  }

  // ---- connection lifecycle ----------------------------------------------------

  function register(c, groupId, machineId) {
    c.groupId = groupId
    c.machineId = machineId
    c.kind = 'member'
    c.stage = 'active'
    c.rateKey = `m:${keyOf(groupId, machineId)}`
    const key = keyOf(groupId, machineId)
    c.conn = (connNo.get(key) ?? connBase) + 1
    connNo.set(key, c.conn)
    mapFor(members, groupId).set(machineId, c)
    c.lastHeard = clock.now()
    c.lastPing = c.lastHeard
    store.touch(groupId, machineId, c.lastHeard)
  }

  function unregister(c) {
    if (c.kind === 'member') {
      const m = members.get(c.groupId)
      if (m?.get(c.machineId) === c) {
        m.delete(c.machineId)
        if (!m.size) members.delete(c.groupId)
        return true
      }
    } else if (c.kind === 'pending') {
      const m = pendings.get(c.groupId)
      if (m?.get(c.machineId) === c) {
        m.delete(c.machineId)
        if (!m.size) pendings.delete(c.groupId)
        return true
      }
    }
    return false
  }

  function welcomeFrame(c, groupId, epoch, pending) {
    const frame = {
      t: 'welcome',
      v: c.version,
      groupId,
      epoch,
      limits: { frameBytes: limits.frameBytes, framesPerMinute: limits.framesPerMinute },
    }
    if (pending) frame.pending = true
    return frame
  }

  // Becomes a member connection: welcome, stored re-key packages in epoch order,
  // then the directory, then tell the others.
  function acceptMember(c, groupId, machineId) {
    register(c, groupId, machineId)
    const group = store.group(groupId)
    send(c, welcomeFrame(c, groupId, group.epoch, false))
    for (const p of store.packagesFor(groupId, machineId)) send(c, { t: 'rekey', record: p.record, sealed: p.sealed })
    send(c, directoryFrame(groupId))
    broadcast(groupId, presenceFrame(groupId, machineId, true), machineId)
    // Anyone still waiting to be admitted may now have somebody to admit them.
    for (const pend of pendings.get(groupId)?.values() || []) sendJoinRequest(c, pend)
    logf('accepted', c)
  }

  function sendJoinRequest(to, pend) {
    send(to, {
      t: 'join.request',
      machineId: pend.machineId,
      inviteId: pend.inviteId,
      signPub: pend.signPub,
      dhPub: pend.dhPub,
    })
  }

  function onClose(c) {
    all.delete(c)
    clearTimers(c)
    if (closed) return
    if (c.probe) c.probe.settle(false)
    const wasMember = c.kind === 'member'
    const wasCurrent = unregister(c)
    if (c.kind === 'pending' && c.groupId) {
      const row = store.machine(c.groupId, c.machineId)
      if (row?.status === 'pending') store.deleteMachine(c.groupId, c.machineId)
    }
    if (wasMember && wasCurrent && c.groupId) {
      const row = store.machine(c.groupId, c.machineId)
      if (row && (row.status === 'member' || row.status === 'blocked')) {
        store.touch(c.groupId, c.machineId, clock.now())
        broadcast(c.groupId, presenceFrame(c.groupId, c.machineId, false), c.machineId)
      }
    }
    c.stage = 'closed'
    logf('closed', c)
  }

  // ---- incoming frames -------------------------------------------------------------

  function peekRoute(text) {
    try {
      const o = JSON.parse(text)
      if (o && o.t === 'to' && typeof o.to === 'string' && typeof o.sid === 'string') return { to: o.to, sid: o.sid }
    } catch {}
    return {}
  }

  function onMessage(c, raw, isBinary) {
    if (c.stage === 'closed') return
    c.lastHeard = clock.now()
    const text = isBinary ? null : raw.toString()
    const size = raw.length
    if (text === null) return fail(c, 'bad-frame', 'Frames must be text.', {}, { close: false })
    // Every frame counts against the rate, whatever its size. Only a connection
    // that is already authenticated gets its route parsed out of a refused frame.
    const peek = () => (c.stage === 'active' ? peekRoute(text) : {})
    const key = c.rateKey || `c:${c.id}`
    // A frame over the limit is answered but not recorded, so a flood cannot grow
    // the counter; a connection with RATE_STRIKES refusals in a minute is closed.
    if (rates.count(key) >= limits.framesPerMinute) {
      const strikes = rateStrikes.hit(`c:${c.id}`)
      return fail(c, 'limit', 'Too many frames this minute.', { limit: 'framesPerMinute', ...peek() }, { close: strikes >= RATE_STRIKES })
    }
    rates.hit(key)
    if (size > limits.frameBytes) {
      const strikes = oversize.hit(key)
      fail(c, 'limit', 'That frame is larger than this relay allows.', { limit: 'frameBytes', ...peek() }, { close: strikes >= OVERSIZE_STRIKES })
      return
    }
    const frame = decodeFrame(text)
    if (!frame) return fail(c, 'bad-frame', 'That is not a valid frame.', {}, { close: false })
    logf('recv', c, { type: frame.t, size })
    if (frame.t === 'probe-ack') {
      if (c.probe) c.probe.settle(true)
      return
    }
    switch (c.stage) {
      case 'hello':
        if (frame.t !== 'hello') return fail(c, 'bad-frame', 'Expected hello.')
        return void onHello(c, frame).catch((err) => internalError(c, err))
      case 'prove':
        if (frame.t !== 'prove') return fail(c, 'bad-frame', 'Expected prove.')
        return void onProve(c, frame).catch((err) => internalError(c, err))
      case 'active':
        return c.kind === 'member' ? onMemberFrame(c, frame) : onPendingFrame(c, frame)
      default:
        return // busy: ignore until authentication finishes
    }
  }

  function internalError(c, err) {
    logf('internal-error', c, { code: err?.code })
    if (c.stage !== 'closed') fail(c, 'bad-frame', 'The relay could not process that.')
  }

  // ---- authentication ---------------------------------------------------------------

  async function onHello(c, f) {
    clock.clearTimeout(c.helloTimer)
    c.helloTimer = null
    const picked = pickVersion(f.v, [PROTOCOL_MIN, PROTOCOL_MAX])
    if (picked.version === null) {
      const message =
        picked.older === 'a'
          ? 'this Perch is too old for the relay; update Perch'
          : 'the relay is too old for this Perch; update the relay'
      return fail(c, 'version', message)
    }
    c.version = picked.version
    if (f.auth !== 'create' && f.auth !== 'invite' && f.auth !== 'machine-key') {
      return fail(c, 'auth-method', 'The relay does not accept that way of signing in.')
    }
    if (authFails.count(c.address) >= limits.authFailsPerMinute) {
      return fail(c, 'limit', 'Too many failed attempts. Try again in a minute.', { limit: 'authFailsPerMinute' })
    }
    if (!ID_RE.test(f.machineId)) return fail(c, 'bad-frame', 'The machine id is not valid.')
    if (f.label !== undefined && f.label !== '' && !NAME_RE.test(f.label)) {
      return fail(c, 'bad-frame', 'The label is not valid.')
    }
    if (f.auth === 'create') return helloCreate(c, f)
    if (f.auth === 'invite') return helloInvite(c, f)
    return helloMachineKey(c, f)
  }

  function startChallenge(c, auth) {
    c.nonce = randomBytes(24).toString('base64url')
    c.auth = auth
    c.stage = 'prove'
    c.helloTimer = clock.setTimeout(() => closeConn(c), HELLO_TIMEOUT_MS)
    send(c, { t: 'challenge', nonce: c.nonce })
  }

  function helloCreate(c, f) {
    if (!config.adminSecret) {
      return fail(c, 'admin-secret', 'this relay has no admin secret, so groups cannot be created')
    }
    if (typeof f.adminSecret !== 'string' || !KEY_RE.test(f.signPub || '') || !KEY_RE.test(f.dhPub || '')) {
      return fail(c, 'bad-frame', 'Creating a group needs an admin secret and both public keys.')
    }
    if (!safeEqual(f.adminSecret, config.adminSecret)) {
      authFails.hit(c.address)
      return fail(c, 'admin-secret', 'The relay did not accept that admin secret.')
    }
    const groupId = randomBytes(16).toString('hex')
    store.createGroup(groupId, { id: f.machineId, signPub: f.signPub, dhPub: f.dhPub, label: f.label || null })
    acceptMember(c, groupId, f.machineId)
  }

  function helloMachineKey(c, f) {
    if (typeof f.groupId !== 'string') return fail(c, 'bad-frame', 'A group id is needed.')
    startChallenge(c, { kind: 'machine-key', groupId: f.groupId, machineId: f.machineId })
  }

  function helloInvite(c, f) {
    if (
      typeof f.groupId !== 'string' ||
      typeof f.inviteId !== 'string' ||
      !KEY_RE.test(f.signPub || '') ||
      !KEY_RE.test(f.dhPub || '')
    ) {
      return fail(c, 'bad-frame', 'Joining needs a group id, an invite id and both public keys.')
    }
    const inv = store.invite(f.inviteId)
    if (!inv || inv.groupId !== f.groupId || !store.group(f.groupId)) {
      authFails.hit(c.address)
      return fail(c, 'invite', INVITE_MESSAGES.unknown, { reason: 'unknown' })
    }
    startChallenge(c, {
      kind: 'invite',
      groupId: f.groupId,
      inviteId: f.inviteId,
      machineId: f.machineId,
      signPub: f.signPub,
      dhPub: f.dhPub,
    })
  }

  async function onProve(c, f) {
    clock.clearTimeout(c.helloTimer)
    c.helloTimer = null
    c.stage = 'busy'
    const a = c.auth
    if (a.kind === 'machine-key') return proveMachine(c, a, f)
    return proveInvite(c, a, f)
  }

  async function proveMachine(c, a, f) {
    const row = store.machine(a.groupId, a.machineId)
    const text = challengeString(c.nonce, a.groupId, a.machineId)
    if (!row || row.status === 'pending' || !verifySig(row.signPub, text, f.sig)) {
      authFails.hit(c.address)
      return fail(c, 'credential', 'The relay did not accept that machine key.')
    }
    // Only a valid signature learns anything about the machine's standing.
    if (row.status === 'removed') {
      const record = store.latestRemoval(a.groupId, a.machineId)
      return fail(c, 'removed', 'This machine was removed from the group.', record ? { record } : {})
    }
    if (row.status === 'blocked') {
      return fail(c, 'blocked', 'This machine was blocked by the relay admin.')
    }
    // One connection per machine. Ask the current holder whether it is alive.
    for (;;) {
      const old = memberConn(a.groupId, a.machineId)
      if (!old || old === c) break
      if (await probeAlive(old)) {
        return fail(c, 'already-connected', 'This machine is already connected to the relay.')
      }
      if (memberConn(a.groupId, a.machineId) === old) {
        unregister(old)
        try {
          old.ws.terminate()
        } catch {}
      }
    }
    if (c.stage === 'closed' || c.ws.readyState !== 1) return
    // The probe took time. Look at the machine's standing again before registering it.
    const now = store.machine(a.groupId, a.machineId)
    if (!now || now.status === 'pending' || !store.group(a.groupId)) {
      return fail(c, 'credential', 'The relay did not accept that machine key.')
    }
    if (now.status === 'removed') {
      const record = store.latestRemoval(a.groupId, a.machineId)
      return fail(c, 'removed', 'This machine was removed from the group.', record ? { record } : {})
    }
    if (now.status === 'blocked') return fail(c, 'blocked', 'This machine was blocked by the relay admin.')
    acceptMember(c, a.groupId, a.machineId)
  }

  // True when `old` answers a probe within 5 seconds.
  function probeAlive(old) {
    if (old.ws.readyState !== 1) return Promise.resolve(false)
    if (old.probe) return old.probe.promise
    const probe = {}
    probe.promise = new Promise((resolve) => {
      const timer = clock.setTimeout(() => probe.settle(false), PROBE_TIMEOUT_MS)
      probe.settle = (alive) => {
        if (old.probe !== probe) return
        old.probe = null
        clock.clearTimeout(timer)
        resolve(alive)
      }
    })
    old.probe = probe
    send(old, { t: 'probe' })
    return probe.promise
  }

  async function proveInvite(c, a, f) {
    const inv = store.invite(a.inviteId)
    const text = challengeString(c.nonce, a.groupId, a.machineId) + '\n' + a.signPub + '\n' + a.dhPub
    if (!inv || !verifySig(inv.enrolPub, text, f.sig)) {
      authFails.hit(c.address)
      return fail(c, 'credential', 'The relay did not accept that invite.')
    }
    const now = clock.now()
    let reason = null
    if (inv.status !== 'active') reason = inv.status
    else if (inv.usesLeft <= 0) reason = 'used'
    else if (inv.expiresAt <= now) reason = 'expired'
    if (reason) return fail(c, 'invite', INVITE_MESSAGES[reason], { reason })
    const group = store.group(a.groupId)
    if (!group) return fail(c, 'invite', INVITE_MESSAGES.unknown, { reason: 'unknown' })
    if (store.machine(a.groupId, a.machineId)) return fail(c, 'bad-frame', 'That machine id is already in use.')
    if (store.memberCount(a.groupId) >= limits.machinesPerGroup) {
      return fail(c, 'limit', `This group is full (${limits.machinesPerGroup} machines).`, { limit: 'machinesPerGroup' })
    }
    if ((pendings.get(a.groupId) ? [...pendings.get(a.groupId).values()] : []).filter((p) => p.inviteId === a.inviteId).length >= maxPendingPerInvite) {
      return fail(c, 'limit', 'Too many machines are waiting on this invite.', { limit: 'pendingPerInvite' })
    }
    store.addPending(a.groupId, { id: a.machineId, signPub: a.signPub, dhPub: a.dhPub }, a.inviteId)
    c.groupId = a.groupId
    c.machineId = a.machineId
    c.inviteId = a.inviteId
    c.signPub = a.signPub
    c.dhPub = a.dhPub
    c.kind = 'pending'
    c.stage = 'active'
    c.rateKey = `p:${keyOf(a.groupId, a.machineId)}`
    c.lastHeard = now
    c.lastPing = now
    mapFor(pendings, a.groupId).set(a.machineId, c)
    send(c, welcomeFrame(c, a.groupId, group.epoch, true))
    for (const member of members.get(a.groupId)?.values() || []) sendJoinRequest(member, c)
    c.admitTimer = clock.setTimeout(() => {
      c.admitTimer = null
      if (c.stage === 'closed' || c.kind !== 'pending') return
      // Leave no window in which an admit could still find this joiner.
      unregister(c)
      store.deleteMachine(c.groupId, c.machineId)
      c.stage = 'closed'
      fail(c, 'no-admitter', 'Nobody was online to admit you. Try again when another machine in the group is online.')
    }, NO_ADMITTER_MS)
    logf('pending', c)
  }

  // ---- frames from members and pending joiners ----------------------------------------

  function onPendingFrame(c, f) {
    if (f.t === 'ping') return
    if (f.t === 'to') return routeTo(c, f)
    fail(c, 'route', 'You are not admitted to this group yet.', {}, { close: false })
  }

  function onMemberFrame(c, f) {
    // Only a current member may act as one; a machine removed or deleted while
    // its connection was being set up must not.
    const self = f.t === 'ping' ? null : store.machine(c.groupId, c.machineId)
    if (f.t !== 'ping' && self?.status !== 'member') {
      unregister(c)
      return fail(c, 'bad-frame', 'You are not a member of this group.')
    }
    // Refusals name the frame they answer, so a machine with several requests in
    // flight can tell which one failed. Every handler below runs synchronously.
    c.answering = f.t
    try {
      return memberFrame(c, f)
    } finally {
      c.answering = null
    }
  }

  function memberFrame(c, f) {
    switch (f.t) {
      case 'ping':
        return
      case 'to':
        return routeTo(c, f)
      case 'profile.put': {
        if (f.blob.length > PROFILE_MAX) {
          return fail(c, 'limit', 'That profile is larger than this relay allows.', { limit: 'profileBytes' }, { close: false })
        }
        const before = store.machine(c.groupId, c.machineId)
        store.setProfile(c.groupId, c.machineId, f.blob, f.epoch)
        store.deletePackages(c.groupId, c.machineId, f.epoch)
        send(c, { t: 'ok', re: 'profile.put' })
        // Last-seen is not part of the directory's stable content, so an
        // unchanged profile needs no broadcast.
        if (before.profile === f.blob && before.profileEpoch === f.epoch) return
        return broadcastDirectory(c.groupId)
      }
      case 'label.set': {
        if (f.label !== '' && !NAME_RE.test(f.label)) return fail(c, 'bad-frame', 'The label is not valid.', {}, { close: false })
        const before = store.machine(c.groupId, c.machineId)
        store.setLabel(c.groupId, c.machineId, f.label)
        send(c, { t: 'ok', re: 'label.set' })
        if ((before.label ?? '') === f.label) return
        return broadcastDirectory(c.groupId)
      }
      case 'invite.create':
        return onInviteCreate(c, f)
      case 'invite.revoke':
        return onInviteRevoke(c, f)
      case 'admit':
        return onAdmit(c, f)
      case 'remove':
        return onRemove(c, f)
      case 'leave':
        return onLeave(c, f)
      default:
        return fail(c, 'bad-frame', 'The relay does not accept that frame here.', {}, { close: false })
    }
  }

  function routeTo(c, f) {
    const refuse = (code, message) => fail(c, code, message, { to: f.to, sid: f.sid }, { close: false })
    if (f.to === c.machineId) return refuse('route', 'You cannot send to yourself.')
    const row = store.machine(c.groupId, f.to)
    let target
    if (c.kind === 'member') {
      if (!row || (row.status !== 'member' && row.status !== 'blocked' && row.status !== 'pending')) {
        return refuse('route', 'That machine is not in your group.')
      }
      target = row.status === 'pending' ? pendings.get(c.groupId)?.get(f.to) : memberConn(c.groupId, f.to)
    } else {
      // A joiner may talk only to members of the group it is joining.
      if (!row || (row.status !== 'member' && row.status !== 'blocked')) {
        return refuse('route', 'That machine is not in the group you are joining.')
      }
      target = memberConn(c.groupId, f.to)
    }
    if (!target || target.stage !== 'active') return refuse('offline', 'That machine is offline.')
    let out = { t: 'from', from: c.machineId, k: f.k, sid: f.sid }
    for (const name of ['seq', 'part', 'parts', 'data']) if (f[name] !== undefined) out[name] = f[name]
    if (hooks.onForward) {
      try {
        const r = hooks.onForward(
          out,
          { groupId: c.groupId, machineId: c.machineId },
          { groupId: c.groupId, machineId: f.to },
        )
        if (r === null) return
        if (r !== undefined) out = r
      } catch {}
    }
    send(target, out)
  }

  function onInviteCreate(c, f) {
    const now = clock.now()
    const refuse = () => fail(c, 'limit', 'That invite is outside what this relay allows.', { limit: 'invite' }, { close: false })
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(f.id) || !KEY_RE.test(f.enrolPub)) {
      return fail(c, 'bad-frame', 'The invite is not valid.', {}, { close: false })
    }
    if (!Number.isInteger(f.uses) || f.uses < 1 || f.uses > 20) return refuse()
    const span = f.expiresAt - now
    if (span < INVITE_MIN_MS - INVITE_SLACK_MS || span > INVITE_MAX_MS + INVITE_SLACK_MS) return refuse()
    if (store.invite(f.id)) return fail(c, 'bad-frame', 'That invite id is already in use.', {}, { close: false })
    store.createInvite({
      id: f.id,
      groupId: c.groupId,
      enrolPub: f.enrolPub,
      expiresAt: f.expiresAt,
      uses: f.uses,
      createdBy: c.machineId,
    })
    send(c, { t: 'ok', re: 'invite.create' })
    broadcastDirectory(c.groupId)
  }

  function onInviteRevoke(c, f) {
    if (!store.revokeInvite(c.groupId, f.id)) {
      return fail(c, 'invite', INVITE_MESSAGES.unknown, { reason: 'unknown' }, { close: false })
    }
    send(c, { t: 'ok', re: 'invite.revoke' })
    broadcastDirectory(c.groupId)
  }

  function onAdmit(c, f) {
    const pend = pendings.get(c.groupId)?.get(f.machineId)
    if (!pend || pend.stage !== 'active' || pend.kind !== 'pending') {
      return send(c, { t: 'admit.refused', machineId: f.machineId, reason: 'not-pending' })
    }
    const result = store.admit({
      groupId: c.groupId,
      machineId: f.machineId,
      inviteId: f.inviteId,
      epoch: f.epoch,
      at: clock.now(),
      maxMembers: limits.machinesPerGroup,
    })
    if (!result.ok) {
      send(c, { t: 'admit.refused', machineId: f.machineId, reason: result.reason })
      if (result.reason === 'group-full') {
        unregister(pend)
        store.deleteMachine(pend.groupId, pend.machineId)
        fail(pend, 'limit', `This group is full (${limits.machinesPerGroup} machines).`, { limit: 'machinesPerGroup' })
      }
      return
    }
    clearTimers(pend)
    unregister(pend)
    register(pend, pend.groupId, pend.machineId)
    send(c, { t: 'admit.ok', machineId: f.machineId })
    broadcastDirectory(c.groupId)
    broadcast(c.groupId, presenceFrame(c.groupId, pend.machineId, true), pend.machineId)
    logf('admitted', pend)
  }

  function onRemove(c, f) {
    const bad = (message) => fail(c, 'bad-frame', message, {}, { close: false })
    const record = f.record
    const group = store.group(c.groupId)
    const self = store.machine(c.groupId, c.machineId)
    if (!group || !self) return bad('You are not in a group.')
    if (record === null || typeof record !== 'object' || Array.isArray(record)) return bad('That removal record is not valid.')
    // Members reject any record with a key outside this set, so storing one
    // would split the group from the relay.
    for (const k of Object.keys(record)) {
      if (k !== 'sig' && !REMOVAL_RECORD_KEYS.includes(k)) return bad('That removal record is not valid.')
    }
    if (
      record.by !== c.machineId ||
      record.groupId !== c.groupId ||
      !Number.isInteger(f.fromEpoch) ||
      record.epoch !== f.fromEpoch + 1 ||
      record.bySignPub !== self.signPub ||
      typeof record.removedId !== 'string' ||
      typeof record.sig !== 'string'
    ) {
      return bad('That removal record is not valid.')
    }
    const { sig, ...body } = record
    if (!verifySig(self.signPub, canonical(body), sig)) return bad('That removal record is not signed by you.')
    for (const v of Object.values(f.packages)) if (typeof v !== 'string') return bad('The re-key packages are not valid.')
    if (f.fromEpoch !== group.epoch) {
      return send(c, { t: 'error', code: 'epoch-conflict', message: 'The group changed. Try again.', epoch: group.epoch })
    }
    if (record.removedId === record.by || record.removedId === c.machineId) return bad('A machine cannot remove itself; use leave.')
    const packages = {}
    // Members at the old epoch that the remover sent no package for (for example a
    // machine admitted just before, whose keys the remover had not seen yet).
    const packageMissing = []
    for (const m of store.machines(c.groupId)) {
      if ((m.status !== 'member' && m.status !== 'blocked') || m.id === record.removedId) continue
      if (typeof f.packages[m.id] === 'string') packages[m.id] = f.packages[m.id]
      else packageMissing.push(m.id)
    }
    const result = store.remove({
      groupId: c.groupId,
      removedId: record.removedId,
      fromEpoch: f.fromEpoch,
      record,
      packages,
    })
    if (!result.ok) {
      if (result.reason === 'epoch-conflict') {
        return send(c, { t: 'error', code: 'epoch-conflict', message: 'The group changed. Try again.', epoch: result.epoch })
      }
      return bad('That machine is not in the group.')
    }
    const groupId = c.groupId
    // Joiners were waiting on invites that no longer exist.
    for (const pend of [...(pendings.get(groupId)?.values() || [])]) {
      fail(pend, 'invite', INVITE_MESSAGES.cancelled, { reason: 'cancelled' })
    }
    store.deletePending(groupId)
    const removed = memberConn(groupId, record.removedId)
    if (removed) {
      unregister(removed)
      fail(removed, 'removed', 'This machine was removed from the group.', { record })
    }
    send(c, { t: 'remove.ok', epoch: result.epoch, packageMissing })
    for (const [machineId, sealed] of Object.entries(packages)) {
      const to = memberConn(groupId, machineId)
      if (to) send(to, { t: 'rekey', record, sealed })
    }
    broadcastDirectory(groupId)
    logf('removed', c)
  }

  function onLeave(c, f) {
    const row = store.machine(c.groupId, c.machineId)
    const text = 'perch-relay-leave\n' + c.groupId + '\n' + c.machineId
    if (!row || !verifySig(row.signPub, text, f.sig)) {
      authFails.hit(c.address)
      return fail(c, 'credential', 'That leave request is not signed by this machine.', {}, { close: false })
    }
    const groupId = c.groupId
    store.deleteMachine(groupId, c.machineId)
    unregister(c)
    send(c, { t: 'ok', re: 'leave' })
    closeConn(c)
    // Blocked machines cannot sign in, so a group with no members left is dropped.
    if (!store.machines(groupId).some((m) => m.status === 'member')) {
      dropGroup(groupId)
    } else {
      broadcastDirectory(groupId)
    }
    logf('left', c)
  }

  // ---- admin actions (the loopback listener calls these) --------------------------------

  function dropGroup(groupId) {
    const conns = [...(members.get(groupId)?.values() || []), ...(pendings.get(groupId)?.values() || [])]
    for (const conn of conns) {
      unregister(conn)
      closeConn(conn)
    }
    store.deleteGroup(groupId)
    for (const key of [...connNo.keys()]) if (key.startsWith(groupId + ':')) connNo.delete(key)
  }

  function blockMachine(groupId, machineId) {
    store.block(groupId, machineId)
    const conn = memberConn(groupId, machineId)
    if (conn) {
      unregister(conn)
      fail(conn, 'blocked', 'This machine was blocked by the relay admin.')
    }
    broadcastDirectory(groupId)
  }

  // ---- servers -------------------------------------------------------------------------------

  const server = http.createServer((req, res) => {
    if (req.method === 'GET' && (req.url === '/healthz' || req.url === '/healthz/')) {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end('{"ok":true}')
      return
    }
    res.writeHead(404, { 'content-type': 'text/plain' })
    res.end('not found')
  })
  const wss = new WebSocketServer({ noServer: true, maxPayload: limits.frameBytes * 4, perMessageDeflate: false })
  server.on('upgrade', (req, socket, head) => {
    const address = clientAddress(req, trusted)
    wss.handleUpgrade(req, socket, head, (ws) => {
      const c = {
        id: nextId++,
        ws,
        address,
        stage: 'hello',
        kind: null,
        groupId: null,
        machineId: null,
        lastHeard: clock.now(),
        lastPing: clock.now(),
        helloTimer: null,
        admitTimer: null,
        probe: null,
      }
      const preauth = [...all].filter((o) => o.address === address && ['hello', 'prove', 'busy'].includes(o.stage)).length
      all.add(c)
      if (preauth >= maxPreauth) {
        ws.on('error', () => {})
        ws.on('close', () => onClose(c))
        return fail(c, 'limit', 'Too many connections from this address.', { limit: 'preAuthPerAddress' })
      }
      c.helloTimer = clock.setTimeout(() => closeConn(c), HELLO_TIMEOUT_MS)
      ws.on('message', (raw, isBinary) => {
        try {
          onMessage(c, raw, isBinary)
        } catch (err) {
          internalError(c, err)
        }
      })
      ws.on('close', () => onClose(c))
      ws.on('error', () => {})
    })
  })

  const adminServer = http.createServer((req, res) => {
    try {
      handleAdmin(req, res)
    } catch {
      if (!res.headersSent) res.writeHead(400, { 'content-type': 'application/json' })
      res.end('{"error":"Bad request."}')
    }
  })
  function handleAdmin(req, res) {
    const reply = (status, body) => {
      res.writeHead(status, { 'content-type': 'application/json' })
      res.end(JSON.stringify(body))
    }
    if (adminFails.count('admin') >= ADMIN_FAILS_PER_MINUTE) {
      res.setHeader('retry-after', '60')
      return reply(429, { error: 'Too many wrong admin secrets. Try again in a minute.' })
    }
    const given = req.headers['x-relay-admin']
    if (!config.adminSecret || typeof given !== 'string' || !safeEqual(given, config.adminSecret)) {
      adminFails.hit('admin')
      return reply(403, { error: 'Wrong or missing admin secret.' })
    }
    const url = new URL(req.url, 'http://localhost')
    const parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent)
    if (parts[0] !== 'groups') return reply(404, { error: 'not found' })
    if (parts.length === 1 && req.method === 'GET') {
      return reply(
        200,
        store.groups().map((g) => ({
          id: g.id,
          epoch: g.epoch,
          createdAt: g.createdAt,
          machines: store.machines(g.id).filter((m) => m.status === 'member' || m.status === 'blocked').length,
          online: members.get(g.id)?.size || 0,
        })),
      )
    }
    const group = store.group(parts[1])
    if (!group) return reply(404, { error: 'No such group.' })
    if (parts.length === 2 && req.method === 'DELETE') {
      dropGroup(group.id)
      return reply(200, { ok: true })
    }
    if (parts.length === 3 && parts[2] === 'machines' && req.method === 'GET') {
      return reply(
        200,
        store
          .machines(group.id)
          .filter((m) => m.status !== 'removed')
          .map((m) => ({
            id: m.id,
            label: m.label,
            lastSeen: memberConn(group.id, m.id) ? clock.now() : m.lastSeen,
            online: !!memberConn(group.id, m.id),
            status: m.status,
          })),
      )
    }
    if (parts.length === 4 && parts[2] === 'machines' && req.method === 'DELETE') {
      const row = store.machine(group.id, parts[3])
      if (!row || (row.status !== 'member' && row.status !== 'blocked')) return reply(404, { error: 'No such machine.' })
      blockMachine(group.id, row.id)
      return reply(200, { ok: true })
    }
    return reply(404, { error: 'not found' })
  }

  const listen = (srv, port, host) =>
    new Promise((resolve, reject) => {
      srv.once('error', reject)
      srv.listen(port, host, () => {
        srv.off('error', reject)
        resolve(srv.address().port)
      })
    })

  let port
  let adminPort
  try {
    port = await listen(server, config.port, config.host)
    adminPort = await listen(adminServer, config.adminPort, '127.0.0.1')
  } catch (err) {
    server.close()
    adminServer.close()
    store.close()
    throw err
  }

  const tick = clock.setInterval(() => {
    const now = clock.now()
    for (const c of [...all]) {
      if (c.stage !== 'active') continue
      if (now - c.lastHeard >= DEAD_MS) {
        logf('timeout', c)
        try {
          c.ws.terminate()
        } catch {}
      } else if (now - c.lastPing >= KEEPALIVE_MS) {
        c.lastPing = now
        send(c, { t: 'ping' })
      }
    }
    authFails.sweep()
    rates.sweep()
    adminFails.sweep()
    oversize.sweep()
    rateStrikes.sweep()
  }, TICK_MS)

  return {
    port,
    adminPort,
    // For tests of a relay that misbehaves: send a frame to a connected machine.
    inject(groupId, machineId, frame) {
      const c = memberConn(groupId, machineId)
      if (c) send(c, frame)
    },
    async close() {
      if (closed) return
      closed = true
      clock.clearInterval(tick)
      for (const c of [...all]) {
        clearTimers(c)
        try {
          c.ws.terminate()
        } catch {}
      }
      await Promise.all(
        [server, adminServer].map(
          (srv) =>
            new Promise((resolve) => {
              srv.close(() => resolve())
              srv.closeAllConnections?.()
            }),
        ),
      )
      wss.close()
      store.close()
    },
  }
}
