// The relay link of the Assistant extension: one WebSocket to the relay, the
// directory of the group, encrypted sessions to other machines, calls across
// them, and every membership operation that needs the relay (create, invite,
// join, admit, rename, label, permission, remove, leave).
//
// Rules P1-P9 of plans/relay-server.md are implemented here and in crypto.mjs.
// The relay is never trusted: everything it tells this machine to do with its
// keys or group secret must carry a member's signature (P5, P6), and a machine
// is only talked to once it is verified (membership.trust).
//
// Uses the global WebSocket, which cannot send protocol pings, so keepalive is
// an application `ping` frame. Plain ESM, no build step.

import { randomBytes } from 'node:crypto'
import {
  DEAD_MS,
  ID_RE,
  KEEPALIVE_MS,
  KEY_RE,
  NAME_RE,
  PROTOCOL_MAX,
  PROTOCOL_MIN,
  decodeFrame,
  encodeFrame,
} from '../../_shared/relayWire.mjs'
import {
  acceptRemoval,
  answerSession,
  confirmSession,
  decodeInvite,
  finishSession,
  joinProof,
  makeRemoval,
  newIdentity,
  newInvite,
  open,
  openProfile,
  seal,
  sealProfile,
  sign,
  startSession,
  verifyRemovalRecord,
  vouchFor,
} from './crypto.mjs'
import { INBOUND_VALUES, checkRelayUrl, displayNames } from './membership.mjs'

const MAX_MESSAGE = 8 * 1024 * 1024
const BACKOFF_S = [1, 2, 4, 8, 16, 32, 60]
const RETRY_FIXED_S = 60
const HANDSHAKE_MS = 10000
const ASSEMBLY_MS = 30000
const ADMISSION_MS = 30000
const GRANT_MS = 60000
const REQUEST_MS = 10000
const LEAVE_MS = 5000
const MAX_ADMISSIONS = 5
const MAX_LIST = 400
const IN_GROUP = 'This Perch is already in a relay group. Leave it first.'
const NAME_INVALID = 'A machine name may use letters, digits, dot, dash and underscore, up to 40 characters.'
const MISSED_KEY =
  'This machine missed a key change. Leave the group and join again with a new invite.'
const REMOVED_OFFLINE = 'This machine was removed from the group while it was offline. Use Leave to clear it here.'
const JOIN_DEADLINE_MS = 90000
const RO_POLL_MS = 10000
const RESET_DEDUP_MS = 60000
const RESET_DEDUP_MAX = 2000
const RESET_REASON = 'the secure session was reset; try again'

const INVITE_TEXT = {
  expired: 'This invite has expired.',
  used: 'This invite has already been used.',
  revoked: 'This invite was revoked.',
  cancelled: 'This invite was cancelled when a machine was removed.',
  unknown: 'The relay does not know this invite.',
}
const NO_ADMITTER_TEXT =
  'No machine that holds this invite is online. Ask the machine that created it to be online and try again.'

const realClock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (t) => clearTimeout(t),
  setInterval: (fn, ms) => setInterval(fn, ms),
  clearInterval: (t) => clearInterval(t),
}

export class LinkError extends Error {
  constructor(code, message, extra = {}) {
    super(message)
    this.name = 'LinkError'
    this.code = code
    Object.assign(this, extra)
  }
}

const b64 = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64')
function unb64(text) {
  try {
    if (typeof text !== 'string' || text.length > 8192) return null
    const v = JSON.parse(Buffer.from(text, 'base64').toString('utf8'))
    return v !== null && typeof v === 'object' && !Array.isArray(v) ? v : null
  } catch {
    return null
  }
}
const sentence = (text) => {
  const t = String(text ?? '').trim()
  if (!t) return 'The relay refused that.'
  const s = t[0].toUpperCase() + t.slice(1)
  return /[.!?]$/.test(s) ? s : s + '.'
}
const notConnectedText = (reason) => `This machine is not connected to the relay right now (${reason}).`
const resetError = () => new LinkError('not-connected', notConnectedText(RESET_REASON), { reason: RESET_REASON })

// options:
//   membership        createMembership(...)
//   log(text)         never given a key, secret or message text
//   onState(snapshot) called when status, directory, invites or settings change
//   onEvent(event)    membership events: joined, left, removed, self-removed,
//                     blocked, invite-created, invite-revoked, renamed
//   onCall(peer, msg, respond, signal)  inbound calls from verified peers
//   onInbound(value)  the inbound setting changed
//   readOnly()        true while Assistant Read-only is on (may be async)
//   clearActivity()   called by leave()
//   clock, WebSocketImpl   for tests
export function createLink({
  membership,
  log = () => {},
  onState = () => {},
  onEvent = () => {},
  onCall = null,
  onInbound = () => {},
  readOnly = () => false,
  clearActivity = async () => {},
  clock = realClock,
  WebSocketImpl,
}) {
  const WS = WebSocketImpl || globalThis.WebSocket
  let closed = false
  let busy = false
  let gen = 0
  let cur = null
  let status = 'reconnecting'
  let reason = 'not started'
  let reasonCode = ''
  // Who removed this machine (verified, P6); kept in memory until the next create or join.
  let removedBy = null
  let attempt = 0
  let retryTimer = null
  let limits = { frameBytes: 262144, framesPerMinute: 600 }
  let rawDirectory = null
  let directory = []
  let previousBlocked = null
  const noticed = new Set()
  const sessions = new Map()
  const calls = new Map()
  const admitting = new Set()
  const resetsSent = new Map()
  let removedFailures = 0
  const epochWaiters = new Set()
  let opChain = Promise.resolve()

  const safeLog = (...a) => {
    try {
      log(a.join(' '))
    } catch {}
  }
  const changed = () => {
    try {
      onState(snapshot())
    } catch (e) {
      safeLog('onState failed', e?.message)
    }
  }
  const emit = (event) => {
    try {
      onEvent(event)
    } catch (e) {
      safeLog('onEvent failed', e?.message)
    }
  }
  const selfName = () => membership.state?.name ?? ''
  const exclusive = (fn) => {
    const run = opChain.then(fn)
    opChain = run.catch(() => {})
    return run
  }

  // ---- identity of the machine, also while it is still joining ----

  const me = () => cur?.ctx?.identity || membership.identity
  const groupIdNow = () => cur?.ctx?.inv?.group || membership.state?.groupId
  const connected = () => !!cur && cur.mode === 'member' && cur.welcomed

  // ---- the socket ----

  function sendFrame(c, frame) {
    if (!c || c !== cur || !c.ws || c.ws.readyState !== 1) return false
    try {
      c.ws.send(encodeFrame(frame))
      return true
    } catch {
      return false
    }
  }

  // Frames of sessions go through a paced queue (P9).
  function sendTo(c, frame) {
    c.outQueue.push(frame)
    pump(c)
  }

  function pump(c) {
    if (c !== cur) return
    const budget = Math.max(1, (limits.framesPerMinute || 600) - 60)
    const now = clock.now()
    while (c.sent.length && now - c.sent[0] >= 60000) c.sent.shift()
    while (c.outQueue.length) {
      if (c.sent.length >= budget) {
        if (!c.pumpTimer) {
          const wait = Math.max(1, c.sent[0] + 60000 - now)
          c.pumpTimer = clock.setTimeout(() => {
            c.pumpTimer = null
            pump(c)
          }, wait)
        }
        return
      }
      if (!c.ws || c.ws.readyState !== 1) return
      const frame = c.outQueue.shift()
      c.sent.push(now)
      sendFrame(c, frame)
    }
    const waiting = c.drainWaiters.splice(0)
    for (const w of waiting) w()
  }

  function drain(c, ms) {
    if (!c || !c.outQueue.length) return Promise.resolve()
    return new Promise((resolve) => {
      const t = clock.setTimeout(resolve, ms)
      c.drainWaiters.push(() => {
        clock.clearTimeout(t)
        resolve()
      })
    })
  }

  // Waits for a frame from the relay. Rejects on timeout or when the socket closes.
  function waitFor(c, pred, ms = REQUEST_MS) {
    return new Promise((resolve, reject) => {
      const w = {
        pred,
        resolve: (f) => {
          clock.clearTimeout(w.timer)
          c.waiters.delete(w)
          resolve(f)
        },
        reject: (e) => {
          clock.clearTimeout(w.timer)
          c.waiters.delete(w)
          reject(e)
        },
      }
      w.timer = clock.setTimeout(() => w.reject(new LinkError('no-answer', 'The relay did not answer.')), ms)
      c.waiters.add(w)
    })
  }

  // Sends a frame and waits for its `ok` (or a refusal). Resolves with the
  // answering frame; an `error` frame comes back as a frame, not a throw.
  function request(frame, pred) {
    const c = cur
    if (!c || !connected()) return Promise.reject(notConnected())
    // A refusal answers this request when it names this frame's type, or names
    // none (refused before the relay read it, such as over the rate).
    const p = waitFor(c, (f) => pred(f) || refusalOf(f, frame.t))
    sendFrame(c, frame)
    return p
  }

  function refusalOf(f, type) {
    return f.t === 'error' && !f.sid && (f.re === undefined || f.re === type)
  }

  function notConnected() {
    return new LinkError('not-connected', notConnectedText(reason || 'not started'), { reason })
  }

  function openConn(mode, url, ctx) {
    const c = {
      gen: ++gen,
      mode,
      ctx,
      ws: null,
      opened: false,
      welcomed: false,
      queue: Promise.resolve(),
      outQueue: [],
      sent: [],
      drainWaiters: [],
      waiters: new Set(),
      pumpTimer: null,
      pingTimer: null,
      deadTimer: null,
      next: null,
    }
    cur = c
    let ws
    try {
      ws = new WS(url)
    } catch (e) {
      clock.setTimeout(() => onSocketClosed(c), 0)
      return c
    }
    c.ws = ws
    ws.addEventListener('open', () => {
      if (c !== cur) return
      c.opened = true
      armDead(c)
      c.pingTimer = clock.setInterval(() => sendFrame(c, { t: 'ping' }), KEEPALIVE_MS)
      sendFrame(c, ctx.hello())
    })
    ws.addEventListener('message', (ev) => {
      if (c !== cur) return
      armDead(c)
      const f = typeof ev.data === 'string' ? decodeFrame(ev.data) : null
      if (!f) return
      c.queue = c.queue.then(() => handleFrame(c, f)).catch((e) => safeLog('frame failed', f.t, e?.message))
    })
    ws.addEventListener('close', () => onSocketClosed(c))
    ws.addEventListener('error', () => {})
    return c
  }

  function armDead(c) {
    clock.clearTimeout(c.deadTimer)
    c.deadTimer = clock.setTimeout(() => {
      safeLog('relay silent, reconnecting')
      forceClose(c)
    }, DEAD_MS)
  }

  function forceClose(c) {
    if (c !== cur) return
    try {
      c.ws?.close()
    } catch {}
    onSocketClosed(c)
  }

  function onSocketClosed(c) {
    if (c !== cur) return
    cur = null
    clock.clearTimeout(c.deadTimer)
    clock.clearTimeout(c.pumpTimer)
    clock.clearInterval(c.pingTimer)
    clock.clearInterval(c.roTimer)
    for (const w of [...c.waiters]) w.reject(notConnected())
    for (const w of c.drainWaiters.splice(0)) w()
    dropAllSessions(c.opened ? 'the connection to the relay was lost' : 'could not reach the relay')
    if (c.mode !== 'member') {
      c.ctx.fail?.(new Error(c.opened ? 'The connection to the relay was lost.' : 'Could not reach the relay.'))
      return
    }
    if (closed) return
    const next = c.next || {
      status: 'reconnecting',
      reason: c.opened ? 'the connection to the relay was lost' : 'could not reach the relay',
      code: '',
    }
    status = next.status
    reason = next.reason
    reasonCode = next.code || ''
    changed()
    if (next.stop) return
    const delay = next.delay ?? BACKOFF_S[Math.min(attempt++, BACKOFF_S.length - 1)]
    retryTimer = clock.setTimeout(() => {
      retryTimer = null
      if (!closed) connectMember()
    }, delay * 1000)
  }

  function connectMember() {
    if (cur || closed || !membership.joined) return
    const { state, identity } = membership
    openConn('member', state.relayUrl, {
      hello: () => ({
        t: 'hello',
        v: [PROTOCOL_MIN, PROTOCOL_MAX],
        auth: 'machine-key',
        groupId: state.groupId,
        machineId: identity.machineId,
      }),
    })
  }

  // The relay refused or the group state is wrong: stay refused, close, and
  // try again after `delay` seconds (null: never).
  function refuse(c, text, code, delay) {
    c.next = { status: 'refused', reason: text, code, delay: delay ?? undefined, stop: delay === null }
    forceClose(c)
  }

  // ---- frames from the relay ----

  async function handleFrame(c, f) {
    if (c !== cur) return
    for (const w of [...c.waiters]) if (w.pred(f)) w.resolve(f)
    switch (f.t) {
      case 'challenge':
        return onChallenge(c, f)
      case 'welcome':
        return onWelcome(c, f)
      case 'ping':
        return
      case 'probe':
        return void sendFrame(c, { t: 'probe-ack' })
      case 'error':
        return onError(c, f)
      case 'from':
        return onFrom(c, f)
      default:
    }
    if (c.mode === 'join') return onJoinFrame(c, f)
    if (c.mode !== 'member' || !c.welcomed) return
    switch (f.t) {
      case 'rekey':
        return onRekey(c, f)
      case 'directory':
        return onDirectory(f)
      case 'presence':
        return onPresence(f)
      case 'join.request':
        return void onJoinRequest(c, f)
      default:
    }
  }

  function onChallenge(c, f) {
    const { ctx } = c
    if (c.mode === 'member') {
      const { identity, state } = membership
      return void sendFrame(c, {
        t: 'prove',
        sig: sign(identity.signKey, 'perch-relay-auth-v1\n' + f.nonce + '\n' + state.groupId + '\n' + identity.machineId),
      })
    }
    if (c.mode === 'join') {
      const { identity, inv } = ctx
      sendFrame(c, { t: 'prove', sig: joinProof(inv.enrolKey, f.nonce, inv.group, identity.machineId, identity.signPub, identity.dhPub) })
    }
  }

  async function onWelcome(c, f) {
    if (f.limits && Number.isFinite(f.limits.frameBytes) && Number.isFinite(f.limits.framesPerMinute)) {
      limits = { frameBytes: f.limits.frameBytes, framesPerMinute: f.limits.framesPerMinute }
    }
    if (c.mode === 'create') return finishCreate(c, f)
    if (c.mode === 'join') {
      c.ctx.pending = f.pending === true
      return
    }
    c.welcomed = true
    c.relayEpoch = f.epoch
    status = 'connected'
    reason = ''
    reasonCode = ''
    attempt = 0
    removedFailures = 0
    startRoPoll(c)
    await publishProfile()
    changed()
  }

  // No hook tells this extension that Assistant Read-only changed, so the
  // published `accepts` is checked every 10 s and on every inbound call.
  function startRoPoll(c) {
    clock.clearInterval(c.roTimer)
    c.roTimer = clock.setInterval(() => void checkReadOnly(), RO_POLL_MS)
  }
  async function checkReadOnly() {
    if (!connected() || !membership.joined) return
    let ro = false
    try {
      ro = (await readOnly()) === true
    } catch {}
    if (ro !== cachedReadOnly) await refreshProfile()
  }

  async function onError(c, f) {
    if (f.sid) return onRouteError(f)
    if (c.mode === 'create') return failAttempt(c, new Error(createMessage(f)))
    if (c.mode === 'join') return failAttempt(c, new Error(joinMessage(f)))
    switch (f.code) {
      case 'removed':
        return onRemovedError(c, f)
      case 'blocked':
        return refuse(c, 'blocked by the relay admin', 'blocked', RETRY_FIXED_S)
      case 'already-connected':
        return refuse(c, 'this machine is already connected to the relay from another Perch instance', 'already-connected', RETRY_FIXED_S)
      case 'version':
        return refuse(c, sentence(f.message), 'version', null)
      case 'epoch-conflict':
      case 'limit':
      case 'bad-frame':
        return void safeLog('relay refused a frame', f.code, f.limit || '')
      default:
        return refuse(c, sentence(f.message), f.code, undefined)
    }
  }

  function createMessage(f) {
    if (f.code === 'admin-secret') return /no admin secret/i.test(f.message) ? sentence(f.message) : 'The relay did not accept that admin secret.'
    return sentence(f.message)
  }

  function joinMessage(f) {
    if (f.code === 'invite') return INVITE_TEXT[f.reason] || sentence(f.message)
    if (f.code === 'no-admitter') return NO_ADMITTER_TEXT
    if (f.code === 'limit' && f.limit === 'machinesPerGroup') return sentence(f.message)
    if (f.code === 'credential') return 'The relay did not accept that invite.'
    return sentence(f.message)
  }

  // P8: an error naming a session: the session is dropped.
  function onRouteError(f) {
    if (!['limit', 'offline', 'route'].includes(f.code) || !f.to) return
    const s = sessions.get(f.to)
    if (!s || s.sid !== f.sid) return
    dropSession(s, {
      reset: false,
      error:
        f.code === 'offline'
          ? new LinkError('offline', `${nameOf(s.peerId)} is offline.`, { machine: s.peerId })
          : resetError(),
    })
  }

  // P6: only a signed record naming this machine ends the membership.
  async function onRemovedError(c, f) {
    const { state, group, identity } = membership
    try {
      if (!f.record) throw new Error('no record')
      verifyRemovalRecord({
        group: { groupId: state.groupId, secret: group.secret, epoch: group.epoch },
        removedIds: state.removed,
        pinned: state.pinned,
        record: f.record,
      })
      if (f.record.removedId !== identity.machineId) throw new Error('not for this machine')
    } catch {
      // Keys are kept. After three tries the machine stops asking.
      if (++removedFailures >= 3) return refuse(c, REMOVED_OFFLINE, 'removed-offline', null)
      return refuse(c, `the relay says this machine was removed, but it could not prove it (${sentence(f.message)})`, 'removed-unverified', RETRY_FIXED_S)
    }
    const byName = state.pinned[f.record.by]?.name ?? null
    c.next = { status: 'refused', reason: 'this machine was removed from the group', code: 'removed', stop: true }
    await membership.clear()
    rawDirectory = null
    directory = []
    forceClose(c)
    removedBy = { by: byName ?? '?' + String(f.record.by).slice(0, 8), at: clock.now() }
    emit({ kind: 'self-removed', by: byName })
    // After the event, so its own row goes with the rest.
    try {
      await clearActivity()
    } catch (e) {
      safeLog('activity not cleared', e?.message)
    }
  }

  // ---- profile, directory and presence ----

  async function publishProfile() {
    const c = cur
    if (!c || c.mode !== 'member' || !c.welcomed || !membership.joined) return
    const { state, group, identity } = membership
    let ro = false
    try {
      ro = await readOnly()
    } catch {}
    if (c !== cur) return
    const accepts = state.inbound === 'send' && ro ? 'read' : state.inbound
    let blob
    try {
      blob = sealProfile(group.secret, group.epoch, identity.machineId, {
        name: state.name,
        accepts,
        vouch: vouchFor(group.secret, group.epoch, identity),
      })
    } catch (e) {
      return void safeLog('profile not sent', e?.code || '')
    }
    sendFrame(c, { t: 'profile.put', blob, epoch: group.epoch })
  }

  function onDirectory(f) {
    // Re-key frames come before the directory, so an epoch above ours with no
    // package applied means the relay never had a package for this machine.
    const ownEpoch = membership.group.epoch
    const aheadOnRelay = cur && cur.relayEpoch > ownEpoch
    const aheadByPeers = f.machines.some((m) => m && m.id !== membership.identity.machineId && Number.isFinite(m.profileEpoch) && m.profileEpoch > ownEpoch)
    if (cur && (aheadOnRelay || aheadByPeers)) return refuse(cur, MISSED_KEY, 'missed-key', null)
    rawDirectory = f
    const { state } = membership
    let dirty = false
    const listed = new Map(f.invites.filter((i) => i && typeof i.id === 'string').map((i) => [i.id, i]))
    for (const id of Object.keys(state.invites)) {
      const l = listed.get(id)
      if (!l || !(l.usesLeft > 0)) {
        membership.dropInvite(id)
        dirty = true
      }
    }
    if (dirty) void membership.saveState()
    recompute()
  }

  function onPresence(f) {
    const m = rawDirectory?.machines.find((x) => x.id === f.machineId)
    if (!m) return
    m.online = f.online
    m.conn = f.conn
    m.lastSeen = f.lastSeen
    recompute()
  }

  function recompute() {
    if (!rawDirectory || !membership.joined) {
      directory = []
      return changed()
    }
    const { state, group, identity } = membership
    const list = []
    let pinsChanged = false
    for (const m of rawDirectory.machines) {
      if (!m || typeof m.id !== 'string' || !ID_RE.test(m.id) || !KEY_RE.test(m.signPub || '') || !KEY_RE.test(m.dhPub || '')) continue
      const self = m.id === identity.machineId
      let profile = null
      if (typeof m.profile === 'string' && m.profileEpoch === group.epoch) {
        try {
          profile = openProfile(group.secret, group.epoch, m.id, m.profile)
        } catch {}
      }
      const vouch = profile && typeof profile.vouch === 'string' ? profile.vouch : undefined
      const trust = self ? 'verified' : membership.trust({ id: m.id, signPub: m.signPub, dhPub: m.dhPub, blocked: m.blocked === true, vouch })
      const pin = Object.hasOwn(state.pinned, m.id) ? state.pinned[m.id] : null
      const profileName = profile && typeof profile.name === 'string' && NAME_RE.test(profile.name) ? profile.name : null
      if (!self && trust === 'verified' && profileName) {
        if (!pin) {
          state.pinned[m.id] = { signPub: m.signPub, dhPub: m.dhPub, name: profileName }
          pinsChanged = true
        } else if (pin.name !== profileName) {
          pin.name = profileName
          pinsChanged = true
        }
      }
      const accepts = profile && INBOUND_VALUES.includes(profile.accepts) ? profile.accepts : 'unknown'
      list.push({
        id: m.id,
        name: self ? state.name : profileName ?? (pin?.name || null),
        self,
        online: self ? true : m.online === true,
        lastSeen: Number.isFinite(m.lastSeen) ? m.lastSeen : null,
        conn: Number.isFinite(m.conn) ? m.conn : 0,
        trust,
        blocked: m.blocked === true,
        // On this machine's removed list: a removal it accepted. UIs hide these rows.
        removed: !self && state.removed.includes(m.id),
        accepts: self ? (state.inbound === 'send' && cachedReadOnly ? 'read' : state.inbound) : accepts,
        label: typeof m.label === 'string' ? m.label : '',
        signPub: m.signPub,
        dhPub: m.dhPub,
      })
    }
    if (pinsChanged) void membership.saveState()
    const names = displayNames(list)
    for (const e of list) e.display = names.get(e.id)
    directory = list
    // A newly blocked machine raises one notice; the first directory only seeds.
    const blockedNow = new Set(list.filter((e) => e.blocked).map((e) => e.id))
    if (previousBlocked) {
      for (const e of list) if (e.blocked && !previousBlocked.has(e.id)) emit({ kind: 'blocked', id: e.id, name: e.display })
    }
    previousBlocked = blockedNow
    // Sessions follow the directory (P8): offline, replaced connection, or no longer verified.
    for (const s of [...sessions.values()]) {
      const e = directory.find((x) => x.id === s.peerId)
      if (s.admission) continue
      if (!e || !e.online) dropSession(s, { reset: false, error: new LinkError('offline', `${nameOf(s.peerId)} is offline.`, { machine: s.peerId }) })
      else if (e.trust !== 'verified') dropSession(s, { reset: true, error: new LinkError('unverified', `${e.display} is not verified.`, { machine: s.peerId }) })
      else if (e.conn !== s.conn) dropSession(s, { reset: true, error: resetError() })
    }
    changed()
  }
  let cachedReadOnly = false
  void (async () => {
    try {
      cachedReadOnly = (await readOnly()) === true
    } catch {}
  })()

  const entryOf = (id) => directory.find((m) => m.id === id) || null
  const nameOf = (id) => entryOf(id)?.display || '?' + String(id).slice(0, 8)

  // ---- P5: accepting a re-key ----

  async function onRekey(c, f) {
    const { state, group, identity } = membership
    const record = f.record
    let next
    try {
      next = acceptRemoval({
        self: identity,
        group: { groupId: state.groupId, secret: group.secret, epoch: group.epoch },
        removedIds: state.removed,
        pinned: state.pinned,
        record,
        sealed: f.sealed,
      })
    } catch (e) {
      if (e?.code === 'stale') return publishProfile()
      safeLog('re-key refused', e?.code || '')
      return refuse(c, `a re-key from the relay was refused (${e?.message || e?.code})`, 'rekey-failed', RETRY_FIXED_S)
    }
    const removedName = state.pinned[record.removedId]?.name ?? entryOf(record.removedId)?.display ?? null
    const byName = record.by === identity.machineId ? state.name : state.pinned[record.by]?.name ?? entryOf(record.by)?.display ?? null
    // State first, then the group: a crash between the two leaves the removed
    // machine on the removed list and unpinned, and the package is applied again.
    const before = {
      removed: [...state.removed],
      pinned: structuredClone(state.pinned),
      invites: { ...state.invites },
      goneInvites: [...state.goneInvites],
    }
    try {
      if (!state.removed.includes(record.removedId)) state.removed.push(record.removedId)
      delete state.pinned[record.removedId]
      // Every held invite is finished: its admission secret could yield the new group.
      for (const id of Object.keys(state.invites)) membership.dropInvite(id)
      if (record.by !== identity.machineId && !Object.hasOwn(state.pinned, record.by)) {
        state.pinned[record.by] = { signPub: record.bySignPub, dhPub: record.byDhPub, name: byName }
      }
      await membership.saveState()
      await membership.saveGroup(next)
    } catch (e) {
      Object.assign(state, before)
      safeLog('re-key not saved', e?.message || '')
      return refuse(c, 'a re-key could not be saved on this machine', 'rekey-failed', RETRY_FIXED_S)
    }
    admitting.clear()
    for (const s of [...sessions.values()]) if (s.admission) dropSession(s, { reset: true })
    const gone = sessions.get(record.removedId)
    if (gone) dropSession(gone, { reset: true, error: new LinkError('unverified', `${removedName} was removed.`) })
    recompute()
    await publishProfile()
    for (const w of [...epochWaiters]) if (next.epoch >= w.epoch) w.resolve()
    noticed.add(record.removedId)
    // `local`: this machine made the removal; its own screen needs no notice.
    emit({ kind: 'removed', id: record.removedId, name: removedName, by: byName, local: record.by === identity.machineId })
  }

  // ---- sessions ----

  function newSession(peerId, role, sid = randomBytes(8).toString('hex')) {
    const s = {
      peerId,
      role,
      sid,
      stage: '',
      state: null,
      pending: null,
      session: null,
      isReady: false,
      conn: entryOf(peerId)?.conn ?? 0,
      nextTx: 0,
      nextRx: 0,
      asm: null,
      timer: null,
      admission: null,
      psk: undefined,
      inbound: new Map(),
    }
    s.readyP = new Promise((resolve, reject) => {
      s.resolve = resolve
      s.reject = reject
    })
    s.readyP.catch(() => {})
    sessions.set(peerId, s)
    return s
  }

  // Resets go through the paced queue, once per (peer, sid) for 60 s.
  function sendReset(c, to, sid) {
    if (!c || c !== cur) return
    const now = clock.now()
    const key = to + ':' + sid
    const last = resetsSent.get(key)
    if (last !== undefined && now - last < RESET_DEDUP_MS) return
    if (resetsSent.size >= RESET_DEDUP_MAX) {
      for (const [k, t] of resetsSent) if (now - t >= RESET_DEDUP_MS) resetsSent.delete(k)
      if (resetsSent.size >= RESET_DEDUP_MAX) resetsSent.delete(resetsSent.keys().next().value)
    }
    resetsSent.set(key, now)
    sendTo(c, { t: 'to', to, k: 'reset', sid })
  }

  function dropSession(s, { reset = true, error = resetError() } = {}) {
    if (sessions.get(s.peerId) === s) sessions.delete(s.peerId)
    clock.clearTimeout(s.timer)
    clock.clearTimeout(s.asm?.timer)
    s.asm = null
    if (!s.isReady) s.reject(error)
    s.dropped = true
    if (reset && cur && cur.opened) sendReset(cur, s.peerId, s.sid)
    for (const [id, p] of calls) {
      if (p.s === s) {
        calls.delete(id)
        clock.clearTimeout(p.timer)
        p.reject(error)
      }
    }
    for (const ac of s.inbound.values()) ac.abort()
    s.inbound.clear()
    if (cur?.ctx?.session === s) cur.ctx.session = null
    s.isReady = false
  }

  function dropAllSessions(why) {
    for (const s of [...sessions.values()]) {
      dropSession(s, { reset: false, error: new LinkError('not-connected', notConnectedText(why), { reason: why }) })
    }
    for (const [id, p] of calls) {
      calls.delete(id)
      clock.clearTimeout(p.timer)
      p.reject(new LinkError('not-connected', notConnectedText(why), { reason: why }))
    }
  }

  function startHandshakeTimer(s, code = 'no-answer', ms = HANDSHAKE_MS) {
    const seconds = Math.round(ms / 1000)
    s.timer = clock.setTimeout(() => {
      dropSession(s, {
        reset: true,
        error: new LinkError(code, `${nameOf(s.peerId)} did not answer within ${seconds} seconds.`, { machine: s.peerId, seconds }),
      })
    }, ms)
  }

  // A ready session to a verified, online peer, starting one when needed.
  async function ensureSession(peerId, handshakeMs = HANDSHAKE_MS) {
    if (!connected()) throw notConnected()
    const e = entryOf(peerId)
    if (!e) throw new LinkError('offline', `${nameOf(peerId)} is offline.`, { machine: peerId, lastSeen: null })
    if (!e.online) throw new LinkError('offline', `${e.display} is offline.`, { machine: peerId, lastSeen: e.lastSeen })
    if (e.trust !== 'verified') throw new LinkError('unverified', `${e.display} is not verified, so Perch will not talk to it. Remove it and invite it again.`, { machine: peerId })
    const have = sessions.get(peerId)
    if (have) return have.isReady ? have : have.readyP
    const s = newSession(peerId, 'init')
    const { state, msg1 } = startSession(me(), groupIdNow())
    s.state = state
    s.stage = 'hs2'
    startHandshakeTimer(s, 'no-answer', handshakeMs)
    sendTo(cur, { t: 'to', to: peerId, k: 'hs1', sid: s.sid, data: b64(msg1) })
    return s.readyP
  }

  function becomeReady(s, session) {
    clock.clearTimeout(s.timer)
    s.session = session
    s.isReady = true
    s.stage = 'ready'
    s.resolve(s)
    if (!s.admission) {
      sendMsg(s, { t: 'invites.sync', held: Object.keys(membership.state?.invites || {}), gone: membership.state?.goneInvites || [] })
    }
  }

  // hs1 from a peer: answer as responder. In a join, the sender is the
  // admitter, authenticated only by the invite's admission secret.
  function onHs1(c, f) {
    const msg1 = unb64(f.data)
    if (!msg1) return
    if (c.mode === 'join') return onJoinHs1(c, f, msg1)
    const e = entryOf(f.from)
    if (!e || !e.online || e.trust !== 'verified') return
    const have = sessions.get(f.from)
    if (have && !have.isReady && have.role === 'init' && !have.admission) {
      // Both started at once: the lexically smaller machine id wins.
      if (f.from > me().machineId) return
      sessions.delete(f.from)
      clock.clearTimeout(have.timer)
      const mine = have
      const s = respond(c, f, msg1, e)
      if (s) mine.resolve(s.readyP)
      else mine.reject(resetError())
      return
    }
    if (have) dropSession(have, { reset: false })
    respond(c, f, msg1, e)
  }

  function respond(c, f, msg1, e, ...pskArg) {
    let out
    try {
      out = answerSession(me(), groupIdNow(), f.from, e.signPub, msg1, ...pskArg)
    } catch (err) {
      // A version error here comes from unauthenticated msg1.v: no state, no notice.
      safeLog('handshake from a peer not answered', err?.code || '')
      return null
    }
    const s = newSession(f.from, 'resp', f.sid)
    s.pending = out.pending
    s.stage = 'hs3'
    startHandshakeTimer(s)
    sendTo(c, { t: 'to', to: f.from, k: 'hs2', sid: f.sid, data: b64(out.msg2) })
    return s
  }

  function onHs2(c, f, s) {
    const msg2 = unb64(f.data)
    const peer = s.admission ? s.admission.signPub : entryOf(s.peerId)?.signPub
    if (!msg2 || !peer || s.stage !== 'hs2') return dropSession(s, { reset: true })
    let fin
    try {
      fin = finishSession(s.state, s.peerId, peer, msg2, ...(s.admission ? [s.admission.admit] : []))
    } catch (err) {
      if (err?.code === 'version') {
        return dropSession(s, {
          reset: true,
          error: new LinkError('version', 'The two machines share no protocol version.', { older: err.older, machine: s.peerId }),
        })
      }
      safeLog('handshake failed', err?.code || '')
      return dropSession(s, { reset: true, error: new LinkError('handshake', `Could not set up a secure session with ${nameOf(s.peerId)}.`, { machine: s.peerId }) })
    }
    sendTo(c, { t: 'to', to: s.peerId, k: 'hs3', sid: s.sid, data: b64(fin.msg3) })
    becomeReady(s, fin.session)
    if (s.admission) s.admission.ready?.()
  }

  function onHs3(c, f, s) {
    const msg3 = unb64(f.data)
    if (!msg3 || s.stage !== 'hs3') return dropSession(s, { reset: true })
    let session
    try {
      session = confirmSession(s.pending, msg3)
    } catch (err) {
      safeLog('handshake not confirmed', err?.code || '')
      return dropSession(s, { reset: true })
    }
    becomeReady(s, session)
    if (s.admission) s.admission.ready?.()
  }

  function onFrom(c, f) {
    if (c.mode === 'member' && !c.welcomed) return
    if (c.mode === 'create') return
    if (f.k === 'hs1') return onHs1(c, f)
    const s = sessions.get(f.from)
    if (f.k === 'reset') {
      if (s && s.sid === f.sid) dropSession(s, { reset: false })
      return
    }
    if (!s || s.sid !== f.sid) {
      // P8: a frame naming an unknown session resets it, once.
      return sendReset(c, f.from, f.sid)
    }
    if (f.k === 'hs2') return s.role === 'init' ? onHs2(c, f, s) : dropSession(s, { reset: true })
    if (f.k === 'hs3') return s.role === 'resp' ? onHs3(c, f, s) : dropSession(s, { reset: true })
    if (f.k === 'data') return onData(s, f)
  }

  // ---- sealed messages, parts and pacing (P9) ----

  function partBytes() {
    return Math.max(1024, Math.floor(((limits.frameBytes || 262144) - 2048) * 3 / 4))
  }

  function sendMsg(s, obj) {
    const c = cur
    if (!c || !s.isReady || s.dropped) throw resetError()
    const bytes = Buffer.from(JSON.stringify(obj))
    if (bytes.length > MAX_MESSAGE) throw new LinkError('too-large', 'That message is larger than 8 MB.', { machine: s.peerId, direction: 'out' })
    let blob
    try {
      blob = seal(s.session, bytes)
    } catch {
      dropSession(s, { reset: true })
      throw resetError()
    }
    const size = partBytes()
    const parts = Math.max(1, Math.ceil(blob.length / size))
    const seq = s.nextTx++
    for (let i = 0; i < parts; i++) {
      sendTo(c, {
        t: 'to',
        to: s.peerId,
        k: 'data',
        sid: s.sid,
        seq,
        part: i,
        parts,
        data: blob.subarray(i * size, (i + 1) * size).toString('base64'),
      })
    }
  }

  function onData(s, f) {
    if (!s.isReady) return dropSession(s, { reset: true })
    const bad = () => dropSession(s, { reset: true })
    if (!Number.isInteger(f.seq) || !Number.isInteger(f.part) || !Number.isInteger(f.parts) || typeof f.data !== 'string') return bad()
    if (f.parts < 1 || f.parts > 9000 || f.part < 0 || f.part >= f.parts) return bad()
    let a = s.asm
    if (!a) {
      if (f.part !== 0 || f.seq !== s.nextRx) return bad()
      a = s.asm = { seq: f.seq, parts: f.parts, next: 0, chunks: [], bytes: 0, timer: null }
    }
    if (f.seq !== a.seq || f.parts !== a.parts || f.part !== a.next) return bad()
    const chunk = Buffer.from(f.data, 'base64')
    a.bytes += chunk.length
    if (a.bytes > MAX_MESSAGE + 64) return bad()
    a.chunks.push(chunk)
    a.next++
    clock.clearTimeout(a.timer)
    if (a.next < a.parts) {
      a.timer = clock.setTimeout(() => {
        if (s.asm === a) dropSession(s, { reset: true })
      }, ASSEMBLY_MS)
      return
    }
    s.asm = null
    s.nextRx++
    let msg
    try {
      msg = JSON.parse(open(s.session, Buffer.concat(a.chunks)).toString('utf8'))
    } catch {
      return bad()
    }
    if (msg === null || typeof msg !== 'object' || Array.isArray(msg)) return
    handleMessage(s, msg)
  }

  function handleMessage(s, msg) {
    if (s.admission) return onAdmissionMessage(s, msg)
    switch (msg.t) {
      case 'call':
        return onInboundCall(s, msg)
      case 'result':
        return onResult(s, msg)
      case 'invite.share':
        return onInviteShare(msg)
      case 'invites.sync':
        return onInvitesSync(s, msg)
      case 'event':
        return onPeerEvent(s, msg)
      default:
    }
  }

  // ---- calls ----

  function onInboundCall(s, msg) {
    if (typeof msg.id !== 'string' || msg.id.length > 64 || typeof msg.tool !== 'string' || s.inbound.has(msg.id)) return
    const ac = new AbortController()
    s.inbound.set(msg.id, ac)
    let done = false
    const respondTo = (result) => {
      if (done) return
      done = true
      s.inbound.delete(msg.id)
      if (s.dropped || !s.isReady) return
      sendResult(s, msg.id, result)
    }
    const args = msg.args !== null && typeof msg.args === 'object' && !Array.isArray(msg.args) ? msg.args : {}
    const peer = { id: s.peerId, name: nameOf(s.peerId) }
    const request = { id: msg.id, tool: msg.tool, args, senderWindow: typeof msg.senderWindow === 'string' ? msg.senderWindow : null }
    void checkReadOnly()
    if (!onCall) return respondTo({ content: [{ type: 'text', text: `${msg.tool} cannot be called from another machine.` }], isError: true })
    Promise.resolve()
      .then(() => onCall(peer, request, respondTo, ac.signal))
      .catch((e) => {
        safeLog('inbound call failed', e?.message)
        respondTo({ content: [{ type: 'text', text: 'The call failed on the other machine.' }], isError: true })
      })
  }

  function sendResult(s, id, result) {
    const body = { t: 'result', id, content: result?.content ?? [], isError: result?.isError === true }
    try {
      sendMsg(s, body)
    } catch (e) {
      if (e?.code !== 'too-large') return safeLog('result not sent', e?.code || '')
      try {
        sendMsg(s, { t: 'result', id, isError: true, code: 'too-large', content: [{ type: 'text', text: 'The result is larger than 8 MB.' }] })
      } catch {}
    }
  }

  function onResult(s, msg) {
    const p = typeof msg.id === 'string' ? calls.get(msg.id) : null
    if (!p || p.s !== s) return
    calls.delete(msg.id)
    clock.clearTimeout(p.timer)
    if (msg.code === 'too-large') return p.reject(new LinkError('too-large', 'The result is larger than 8 MB.', { machine: s.peerId, direction: 'in' }))
    p.resolve({ content: Array.isArray(msg.content) ? msg.content : [], isError: msg.isError === true })
  }

  async function call(machineId, tool, args = {}, { senderWindow = null, timeoutMs = 30000 } = {}) {
    if (!membership.joined) throw new LinkError('not-in-group', 'This Perch is not in a relay group.')
    if (!connected()) throw notConnected()
    // One deadline covers the handshake and the call itself.
    const seconds = Math.round(timeoutMs / 1000)
    const noAnswer = () => new LinkError('no-answer', `${nameOf(machineId)} did not answer within ${seconds} seconds.`, { machine: machineId, seconds })
    let onExpire
    let rejectDeadline
    const deadline = new Promise((_, reject) => (rejectDeadline = reject))
    deadline.catch(() => {})
    onExpire = () => rejectDeadline(noAnswer())
    const timer = clock.setTimeout(() => onExpire(), timeoutMs)
    let s
    try {
      s = await Promise.race([ensureSession(machineId, timeoutMs), deadline])
    } catch (e) {
      clock.clearTimeout(timer)
      throw e
    }
    return new Promise((resolve, reject) => {
      const id = randomBytes(8).toString('hex')
      onExpire = () => {
        calls.delete(id)
        reject(noAnswer())
      }
      calls.set(id, { s, resolve, reject, timer })
      try {
        sendMsg(s, { t: 'call', id, tool, args, senderWindow })
      } catch (e) {
        calls.delete(id)
        clock.clearTimeout(timer)
        reject(e)
      }
    })
  }

  async function broadcast(msg) {
    const targets = directory.filter((m) => !m.self && m.online && m.trust === 'verified')
    await Promise.allSettled(
      targets.map(async (m) => {
        const s = await ensureSession(m.id)
        sendMsg(s, msg)
      }),
    )
  }

  // ---- invites held, shared and synced (P7) ----

  function onInviteShare(msg) {
    const { state } = membership
    if (typeof msg.id !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(msg.id)) return
    if (typeof msg.admit !== 'string' || !KEY_RE.test(msg.admit)) return
    if (!Number.isFinite(msg.expiresAt) || msg.expiresAt <= clock.now()) return
    if (state.goneInvites.includes(msg.id) || Object.hasOwn(state.invites, msg.id)) return
    state.invites[msg.id] = { admit: msg.admit, expiresAt: msg.expiresAt }
    void membership.saveState()
    changed()
  }

  const idList = (v) => (Array.isArray(v) ? v.slice(0, MAX_LIST).filter((x) => typeof x === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(x)) : [])

  function onInvitesSync(s, msg) {
    const { state } = membership
    let dirty = false
    for (const id of idList(msg.gone)) {
      if (Object.hasOwn(state.invites, id) || !state.goneInvites.includes(id)) {
        membership.dropInvite(id)
        dirty = true
      }
    }
    if (dirty) void membership.saveState()
    const theirs = new Set(idList(msg.held))
    for (const [id, inv] of Object.entries(state.invites)) {
      if (!theirs.has(id) && inv.expiresAt > clock.now()) {
        try {
          sendMsg(s, { t: 'invite.share', id, admit: inv.admit, expiresAt: inv.expiresAt })
        } catch {}
      }
    }
    if (dirty) changed()
  }

  const PEER_EVENTS = ['joined', 'left', 'removed', 'invite-created', 'invite-revoked', 'renamed']

  function onPeerEvent(s, msg) {
    if (!PEER_EVENTS.includes(msg.kind)) return
    const name = typeof msg.name === 'string' && NAME_RE.test(msg.name) ? msg.name : null
    const to = typeof msg.to === 'string' && NAME_RE.test(msg.to) ? msg.to : null
    if (msg.kind === 'removed') {
      if (typeof msg.id !== 'string' || !ID_RE.test(msg.id) || noticed.has(msg.id)) return
      noticed.add(msg.id)
    }
    emit({ kind: msg.kind, by: nameOf(s.peerId), byId: s.peerId, name, to })
  }

  // ---- admitting a newcomer (P3, admitter side) ----

  function onJoinRequest(c, f) {
    const { state, identity } = membership
    const held = state.invites[f.inviteId]
    if (!held || typeof held.admit !== 'string' || held.expiresAt <= clock.now()) return
    if (state.removed.includes(f.machineId) || admitting.has(f.machineId) || admitting.size >= MAX_ADMISSIONS) return
    if (!ID_RE.test(f.machineId) || !KEY_RE.test(f.signPub) || !KEY_RE.test(f.dhPub)) return
    if (directory.some((m) => m.id === f.machineId) || sessions.has(f.machineId)) return
    admitting.add(f.machineId)
    const s = newSession(f.machineId, 'init')
    s.admission = { inviteId: f.inviteId, admit: held.admit, signPub: f.signPub, named: false }
    const { state: hs, msg1 } = startSession(identity, state.groupId)
    s.state = hs
    s.stage = 'hs2'
    const finish = () => {
      admitting.delete(f.machineId)
      clock.clearTimeout(overall)
    }
    const overall = clock.setTimeout(() => {
      finish()
      if (sessions.get(f.machineId) === s) dropSession(s, { reset: true })
    }, ADMISSION_MS)
    s.readyP.then(null, finish)
    s.admission.finish = finish
    sendTo(c, { t: 'to', to: f.machineId, k: 'hs1', sid: s.sid, data: b64({ ...msg1, signPub: identity.signPub }) })
  }

  async function onAdmissionMessage(s, msg) {
    const a = s.admission
    if (a.role === 'newcomer') return onNewcomerMessage(s, msg)
    if (msg.t !== 'join.name' || a.named) return
    a.named = true
    const c = cur
    const deny = (message) => {
      try {
        sendMsg(s, { t: 'admit.deny', message })
      } catch {}
      a.finish()
      dropSession(s, { reset: false })
    }
    try {
      const { state, group, identity } = membership
      const epoch0 = group.epoch
      // A re-key in between ends every invite: nothing is admitted or granted after it.
      const stillValid = () => membership.joined && !s.dropped && membership.group.epoch === epoch0 && Object.hasOwn(membership.state.invites, a.inviteId)
      const CHANGED = 'The group changed while you were joining. Ask for a new invite.'
      const name = msg.name
      if (!stillValid()) return deny(CHANGED)
      if (typeof name !== 'string' || !NAME_RE.test(name)) return deny(NAME_INVALID)
      if (name === state.name || directory.some((m) => m.name === name)) return deny(`A machine named "${name}" is already in this group.`)
      // The name arrived through an opened session: only now is the relay asked to admit.
      const answer = waitFor(c, (f) => (f.t === 'admit.ok' || f.t === 'admit.refused') && f.machineId === s.peerId, REQUEST_MS)
      answer.catch(() => {})
      sendFrame(c, { t: 'admit', machineId: s.peerId, inviteId: a.inviteId, epoch: group.epoch })
      const reply = await answer
      if (reply.t === 'admit.refused') return deny(refusalText(reply.reason))
      if (!stillValid()) return deny(CHANGED)
      const members = Object.entries(state.pinned).map(([id, p]) => ({ id, name: p.name, signPub: p.signPub, dhPub: p.dhPub }))
      members.push({ id: identity.machineId, name: state.name, signPub: identity.signPub, dhPub: identity.dhPub })
      sendMsg(s, { t: 'admit.grant', group: { secret: group.secret, epoch: group.epoch }, members })
      a.finish()
      dropSession(s, { reset: false })
      emit({ kind: 'joined', name, by: state.name, byId: identity.machineId })
      void broadcast({ t: 'event', kind: 'joined', name })
    } catch (e) {
      safeLog('admission failed', e?.code || e?.message || '')
      a.finish()
      if (sessions.get(s.peerId) === s) dropSession(s, { reset: true })
    }
  }

  function refusalText(r) {
    if (INVITE_TEXT[r]) return INVITE_TEXT[r]
    if (r === 'epoch') return 'The group changed while you were joining. Ask for a new invite.'
    if (r === 'group-full') return 'This group is full.'
    return 'You are no longer waiting to be admitted. Try joining again.'
  }

  // ---- create and join (the machine that is not in a group yet) ----

  function attemptConn(mode, url, ctx, deadlineMs = 0) {
    return new Promise((resolve, reject) => {
      let settled = false
      let deadline = null
      ctx.resolve = (v) => {
        if (settled) return
        settled = true
        clock.clearTimeout(deadline)
        resolve(v)
      }
      ctx.fail = (e) => {
        if (settled) return
        settled = true
        clock.clearTimeout(deadline)
        reject(e)
      }
      const c = openConn(mode, url, ctx)
      if (deadlineMs) {
        deadline = clock.setTimeout(() => {
          if (settled) return
          clock.clearTimeout(ctx.grantTimer)
          ctx.fail(new Error('The relay did not finish the join. Try again.'))
          forceClose(c)
        }, deadlineMs)
      }
    })
  }

  function failAttempt(c, error) {
    c.ctx.fail?.(error)
    clock.clearTimeout(c.ctx.grantTimer)
    forceClose(c)
  }

  function guardNew() {
    if (membership.joined) throw new Error(IN_GROUP)
    if (busy) throw new Error('Another relay operation is still running.')
  }

  async function create({ relayUrl, adminSecret, name, allowInsecure = false }) {
    guardNew()
    if (typeof name !== 'string' || !NAME_RE.test(name)) throw new Error(NAME_INVALID)
    const url = checkRelayUrl(relayUrl, allowInsecure)
    if (typeof adminSecret !== 'string' || !adminSecret) throw new Error('Enter the relay admin secret.')
    removedBy = null
    busy = true
    try {
      const identity = newIdentity()
      const secret = randomBytes(32).toString('base64url')
      await attemptConn('create', url, {
        identity,
        secret,
        name,
        url,
        allowInsecure: allowInsecure === true,
        hello: () => ({
          t: 'hello',
          v: [PROTOCOL_MIN, PROTOCOL_MAX],
          auth: 'create',
          machineId: identity.machineId,
          signPub: identity.signPub,
          dhPub: identity.dhPub,
          adminSecret,
        }),
      })
    } finally {
      busy = false
    }
  }

  async function finishCreate(c, f) {
    const { ctx } = c
    if (!ID_RE.test(f.groupId) || f.epoch !== 1) return failAttempt(c, new Error('The relay sent an unexpected reply.'))
    await membership.saveNew({
      identity: ctx.identity,
      group: { secret: ctx.secret, epoch: 1 },
      state: {
        relayUrl: ctx.url,
        allowInsecure: ctx.allowInsecure,
        groupId: f.groupId,
        machineId: ctx.identity.machineId,
        name: ctx.name,
        label: '',
        inbound: 'send',
      },
    })
    becomeMember(c)
    ctx.resolve({ groupId: f.groupId })
  }

  function becomeMember(c) {
    c.mode = 'member'
    c.welcomed = true
    status = 'connected'
    reason = ''
    reasonCode = ''
    attempt = 0
    previousBlocked = null
    removedFailures = 0
    startRoPoll(c)
    void publishProfile()
    changed()
  }

  async function join({ invite, name, allowInsecure = false }) {
    guardNew()
    const inv = decodeInvite(invite)
    if (inv.exp <= clock.now()) throw new Error('This invite has expired.')
    if (typeof name !== 'string' || !NAME_RE.test(name)) throw new Error(NAME_INVALID)
    const url = checkRelayUrl(inv.relay, allowInsecure)
    removedBy = null
    busy = true
    try {
      const identity = newIdentity()
      return await attemptConn('join', url, {
        identity,
        inv,
        name,
        url,
        allowInsecure: allowInsecure === true,
        pending: false,
        session: null,
        directory: null,
        hello: () => ({
          t: 'hello',
          v: [PROTOCOL_MIN, PROTOCOL_MAX],
          auth: 'invite',
          groupId: inv.group,
          inviteId: inv.invite,
          machineId: identity.machineId,
          signPub: identity.signPub,
          dhPub: identity.dhPub,
        }),
      }, JOIN_DEADLINE_MS)
    } finally {
      busy = false
    }
  }

  // Frames that only matter to a machine that is joining.
  function onJoinFrame(c, f) {
    const { ctx } = c
    if (f.t === 'directory') {
      ctx.directory = f
      // Admitted: the grant must follow within 60 s.
      if (!ctx.grantTimer) {
        ctx.grantTimer = clock.setTimeout(() => {
          sendFrame(c, { t: 'leave', sig: sign(ctx.identity.signKey, 'perch-relay-leave\n' + ctx.inv.group + '\n' + ctx.identity.machineId) })
          failAttempt(c, new Error('Joining did not finish. Ask for a new invite.'))
        }, GRANT_MS)
      }
    }
  }

  function onJoinHs1(c, f, msg1) {
    const { ctx } = c
    // The first admitter to answer wins; any other is told to stop.
    if (ctx.session) return sendReset(c, f.from, f.sid)
    const signPub = msg1.signPub
    if (typeof signPub !== 'string' || !KEY_RE.test(signPub)) return
    const s = respond(c, f, msg1, { signPub }, ctx.inv.admit)
    if (!s) return
    s.admission = { role: 'newcomer', ready: () => sendMsg(s, { t: 'join.name', name: ctx.name }) }
    ctx.session = s
  }

  async function onNewcomerMessage(s, msg) {
    const c = cur
    if (!c || c.mode !== 'join') return
    const { ctx } = c
    if (msg.t === 'admit.deny') {
      return failAttempt(c, new Error(typeof msg.message === 'string' && msg.message.length < 300 ? msg.message : 'The group did not admit this machine.'))
    }
    if (msg.t !== 'admit.grant') return
    const g = msg.group
    if (!g || typeof g.secret !== 'string' || !KEY_RE.test(g.secret) || !Number.isSafeInteger(g.epoch) || g.epoch < 1 || !Array.isArray(msg.members)) {
      return failAttempt(c, new Error('The group sent an invalid welcome.'))
    }
    const pinned = {}
    for (const m of msg.members.slice(0, 200)) {
      if (!m || !ID_RE.test(m.id) || m.id === ctx.identity.machineId || !KEY_RE.test(m.signPub) || !KEY_RE.test(m.dhPub)) continue
      pinned[m.id] = { signPub: m.signPub, dhPub: m.dhPub, name: typeof m.name === 'string' && NAME_RE.test(m.name) ? m.name : null }
    }
    clock.clearTimeout(ctx.grantTimer)
    await membership.saveNew({
      identity: ctx.identity,
      group: { secret: g.secret, epoch: g.epoch },
      state: {
        relayUrl: ctx.url,
        allowInsecure: ctx.allowInsecure,
        groupId: ctx.inv.group,
        machineId: ctx.identity.machineId,
        name: ctx.name,
        label: '',
        inbound: 'send',
        pinned,
      },
    })
    dropSession(s, { reset: false })
    becomeMember(c)
    if (ctx.directory) {
      rawDirectory = ctx.directory
      recompute()
    }
    ctx.resolve({ groupId: ctx.inv.group, machineId: ctx.identity.machineId })
  }

  // ---- membership operations ----

  function requireJoined() {
    if (!membership.joined) throw new Error('This Perch is not in a relay group.')
  }
  function requireConnected() {
    requireJoined()
    if (!connected()) throw notConnected()
  }
  function refuseRelay(reply) {
    return new Error(sentence(reply.message))
  }

  function createInvite({ uses = 1, expiresMinutes = 1440 } = {}) {
    return exclusive(async () => {
      requireConnected()
      if (!Number.isInteger(uses) || uses < 1 || uses > 20) throw new Error('An invite can be used 1 to 20 times.')
      if (!Number.isInteger(expiresMinutes) || expiresMinutes < 10 || expiresMinutes > 10080) {
        throw new Error('An invite can last from 10 minutes to 7 days.')
      }
      const { state } = membership
      const expiresAt = clock.now() + expiresMinutes * 60000
      const inv = newInvite({ relay: state.relayUrl, group: state.groupId, expiresAt })
      // Stored in the same step that sees the relay's `ok`, so the directory
      // frame right behind it already finds the invite held.
      const reply = await request({ t: 'invite.create', id: inv.id, enrolPub: inv.enrolPub, expiresAt, uses }, (f) => {
        const hit = f.t === 'ok' && f.re === 'invite.create'
        if (hit) state.invites[inv.id] = { admit: inv.admit, expiresAt }
        return hit
      })
      if (reply.t !== 'ok') throw refuseRelay(reply)
      await membership.saveState()
      emit({ kind: 'invite-created', by: state.name, byId: membership.identity.machineId, local: true })
      void broadcast({ t: 'invite.share', id: inv.id, admit: inv.admit, expiresAt })
      void broadcast({ t: 'event', kind: 'invite-created' })
      changed()
      return { id: inv.id, invite: inv.string, expiresAt }
    })
  }

  function revokeInvite(id) {
    return exclusive(async () => {
      requireConnected()
      const reply = await request({ t: 'invite.revoke', id }, (f) => f.t === 'ok' && f.re === 'invite.revoke')
      if (reply.t !== 'ok') throw refuseRelay(reply)
      membership.dropInvite(id)
      await membership.saveState()
      emit({ kind: 'invite-revoked', by: membership.state.name, byId: membership.identity.machineId, local: true })
      void broadcast({ t: 'invites.sync', held: [], gone: [id] })
      void broadcast({ t: 'event', kind: 'invite-revoked' })
      changed()
    })
  }

  function nameInUse(name) {
    return directory.some((m) => !m.self && m.name === name)
  }

  function rename(name) {
    return exclusive(async () => {
      requireJoined()
      if (typeof name !== 'string' || !NAME_RE.test(name)) throw new Error(NAME_INVALID)
      if (nameInUse(name)) throw new Error(`A machine named "${name}" is already in this group.`)
      const { state } = membership
      // Saving the same name changes nothing: no save, no event, no row.
      if (name === state.name) return
      const was = state.name
      state.name = name
      await membership.saveState()
      await publishProfile()
      emit({ kind: 'renamed', by: was, name, to: name, local: true })
      void broadcast({ t: 'event', kind: 'renamed', name: was, to: name })
      recompute()
    })
  }

  function setLabel(label) {
    return exclusive(async () => {
      requireConnected()
      if (typeof label !== 'string' || (label !== '' && !NAME_RE.test(label))) {
        throw new Error('A relay label may use letters, digits, dot, dash and underscore, up to 40 characters.')
      }
      if (label === membership.state.label) return
      const reply = await request({ t: 'label.set', label }, (f) => f.t === 'ok' && f.re === 'label.set')
      if (reply.t !== 'ok') throw refuseRelay(reply)
      membership.state.label = label
      await membership.saveState()
      changed()
    })
  }

  function setInbound(value) {
    return exclusive(async () => {
      requireJoined()
      if (!INBOUND_VALUES.includes(value)) throw new Error('Others may be off, read-only or read and send.')
      membership.state.inbound = value
      await membership.saveState()
      try {
        onInbound(value)
      } catch (e) {
        safeLog('onInbound failed', e?.message)
      }
      await publishProfile()
      recompute()
    })
  }

  // Called when Assistant Read-only changes, so the published `accepts` follows it.
  async function refreshProfile() {
    try {
      cachedReadOnly = (await readOnly()) === true
    } catch {}
    await publishProfile()
    recompute()
  }

  function waitEpoch(epoch, ms) {
    if (membership.group && membership.group.epoch >= epoch) return Promise.resolve()
    return new Promise((resolve, reject) => {
      const w = {
        epoch,
        resolve: () => {
          clock.clearTimeout(w.timer)
          epochWaiters.delete(w)
          resolve()
        },
        reject: (e) => {
          clock.clearTimeout(w.timer)
          epochWaiters.delete(w)
          reject(e)
        },
      }
      w.timer = clock.setTimeout(() => {
        epochWaiters.delete(w)
        reject(new LinkError('no-answer', 'The re-key did not arrive.'))
      }, ms)
      epochWaiters.add(w)
    })
  }

  function remove(machineId) {
    return exclusive(() => removeNow(machineId))
  }

  async function removeNow(machineId) {
    requireConnected()
    const first = entryOf(machineId)
    if (!first || first.self) throw new Error(first?.self ? 'This machine cannot remove itself. Use Leave group instead.' : 'No such machine in this group.')
    const targetName = first.display
    for (let tries = 0; tries < 5; tries++) {
      requireConnected()
      const target = entryOf(machineId)
      if (!target) return { removed: true }
      const { state, group, identity } = membership
      const recipients = directory
        .filter((m) => !m.self && m.id !== machineId && m.trust === 'verified' && Object.hasOwn(state.pinned, m.id))
        .map((m) => ({ machineId: m.id, dhPub: state.pinned[m.id].dhPub }))
      const made = makeRemoval({ self: identity, groupId: state.groupId, removedId: machineId, oldGroup: group, recipients })
      const reply = await request(
        { t: 'remove', record: made.record, fromEpoch: group.epoch, packages: made.packages },
        (f) => f.t === 'remove.ok',
      )
      if (reply.t === 'remove.ok') {
        for (const id of Array.isArray(reply.packageMissing) ? reply.packageMissing : []) {
          if (typeof id !== 'string' || !ID_RE.test(id)) continue
          const who = entryOf(id)?.display || id
          safeLog('no re-key package for', id)
          emit({ kind: 'package-missing', id, name: who })
        }
        // The remover's own package arrives as a rekey and is applied by P5.
        await waitEpoch(made.group.epoch, REQUEST_MS)
        void broadcast({ t: 'event', kind: 'removed', id: machineId, name: first.name })
        return { removed: true }
      }
      if (reply.code !== 'epoch-conflict') throw refuseRelay(reply)
      if (Number.isFinite(reply.epoch)) await waitEpoch(reply.epoch, REQUEST_MS).catch(() => {})
    }
    throw new Error(`Could not remove ${targetName}: the group kept changing. Try again.`)
  }

  function leave() {
    return exclusive(leaveNow)
  }

  async function leaveNow() {
    requireJoined()
    const c = cur
    let relayEntryRemoved = false
    if (c && connected()) {
      emit({ kind: 'left', by: membership.state.name, byId: membership.identity.machineId, local: true })
      await Promise.race([broadcast({ t: 'event', kind: 'left' }), new Promise((r) => clock.setTimeout(r, 3000))])
      await drain(c, 3000)
      const { identity, state } = membership
      const sig = sign(identity.signKey, 'perch-relay-leave\n' + state.groupId + '\n' + identity.machineId)
      try {
        const p = waitFor(c, (f) => (f.t === 'ok' && f.re === 'leave') || refusalOf(f, 'leave'), LEAVE_MS)
        p.catch(() => {})
        sendFrame(c, { t: 'leave', sig })
        const reply = await p
        relayEntryRemoved = reply.t === 'ok'
      } catch {}
    }
    clock.clearTimeout(retryTimer)
    retryTimer = null
    if (cur) {
      cur.next = { status: 'reconnecting', reason: 'not in a group', stop: true }
      forceClose(cur)
    }
    await membership.clear()
    try {
      await clearActivity()
    } catch (e) {
      safeLog('activity not cleared', e?.message)
    }
    rawDirectory = null
    directory = []
    previousBlocked = null
    noticed.clear()
    attempt = 0
    status = 'reconnecting'
    reason = 'not in a group'
    reasonCode = ''
    changed()
    return { relayEntryRemoved }
  }

  // ---- state for the routes ----

  function snapshot() {
    const joined = membership.joined
    const held = membership.state?.invites || {}
    return {
      joined,
      status,
      reason,
      reasonCode,
      limits,
      machines: directory.map((m) => ({ ...m })),
      invites: (rawDirectory?.invites || [])
        .filter((i) => i && typeof i.id === 'string')
        .map((i) => ({
          id: i.id,
          createdBy: entryOf(i.createdBy)?.display ?? null,
          createdAt: i.createdAt,
          expiresAt: i.expiresAt,
          usesLeft: i.usesLeft,
          held: Object.hasOwn(held, i.id),
        })),
    }
  }

  function machineByName(display) {
    return directory.find((m) => m.display === display) || null
  }

  function start() {
    if (closed || cur || retryTimer || !membership.joined) return
    connectMember()
  }

  function close() {
    closed = true
    clock.clearTimeout(retryTimer)
    retryTimer = null
    const c = cur
    if (c) {
      c.next = { stop: true, status, reason }
      forceClose(c)
    }
    dropAllSessions('this machine is shutting down')
    for (const w of [...epochWaiters]) w.reject(new LinkError('not-connected', notConnectedText('this machine is shutting down')))
  }

  return {
    start,
    close,
    call,
    broadcast,
    snapshot,
    machineByName,
    refreshProfile,
    create,
    join,
    createInvite,
    revokeInvite,
    rename,
    setLabel,
    setInbound,
    remove,
    leave,
    get connected() {
      return connected()
    },
    get status() {
      return status
    },
    get reason() {
      return reason
    },
    get reasonCode() {
      return reasonCode
    },
    get removedBy() {
      return removedBy
    },
  }
}
