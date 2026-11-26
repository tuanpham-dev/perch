// Test client for the relay: signs challenges with node:crypto and keeps every
// frame it receives in order.
import { generateKeyPairSync, randomBytes, sign } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import WebSocket from 'ws'
import { loadConfig } from '../src/config.mjs'
import { startRelay } from '../src/server.mjs'
import { canonical, challengeString, encodeFrame } from '../src/wire.mjs'

export const ADMIN = 'admin-secret-for-tests'

export function newKeys() {
  const ed = generateKeyPairSync('ed25519')
  const x = generateKeyPairSync('x25519')
  return {
    machineId: randomBytes(16).toString('hex'),
    signPriv: ed.privateKey,
    signPub: ed.publicKey.export({ format: 'jwk' }).x,
    dhPub: x.publicKey.export({ format: 'jwk' }).x,
  }
}

export const signText = (priv, text) => sign(null, Buffer.from(text), priv).toString('base64url')

export function fakeClock(start = 1_700_000_000_000) {
  let t = start
  let nextId = 1
  const timers = new Map()
  const clock = {
    now: () => t,
    setTimeout: (fn, ms) => {
      const id = nextId++
      timers.set(id, { fn, at: t + ms })
      return id
    },
    clearTimeout: (id) => void timers.delete(id),
    setInterval: (fn, ms) => {
      const id = nextId++
      timers.set(id, { fn, at: t + ms, every: ms })
      return id
    },
    clearInterval: (id) => void timers.delete(id),
    // Moves time forward, firing due timers in order.
    tick(ms) {
      const end = t + ms
      for (;;) {
        let due = null
        for (const [id, tm] of timers) if (tm.at <= end && (!due || tm.at < due[1].at)) due = [id, tm]
        if (!due) break
        const [id, tm] = due
        t = Math.max(t, tm.at)
        if (tm.every) tm.at += tm.every
        else timers.delete(id)
        tm.fn()
      }
      t = end
    },
  }
  return clock
}

export async function startTestRelay({ env = {}, hooks, clock, dataDir, log } = {}) {
  const owned = !dataDir
  const dir = dataDir || mkdtempSync(join(process.env.TMPDIR || tmpdir(), 'relay-test-'))
  const config = loadConfig({
    RELAY_HOST: '127.0.0.1',
    RELAY_PORT: '0',
    RELAY_ADMIN_PORT: '0',
    RELAY_DATA_DIR: dir,
    RELAY_ADMIN_SECRET: ADMIN,
    ...env,
  })
  const relay = await startRelay({ config, hooks, clock, log })
  return {
    ...relay,
    dir,
    url: `ws://127.0.0.1:${relay.port}`,
    async close() {
      await relay.close()
      if (owned) rmSync(dir, { recursive: true, force: true })
    },
  }
}

export class Client {
  constructor(url) {
    this.frames = []
    this.waiters = []
    this.closed = false
    this.ws = new WebSocket(url)
    this.opened = new Promise((resolve, reject) => {
      this.ws.once('open', resolve)
      this.ws.once('error', reject)
    })
    this.closedPromise = new Promise((resolve) => {
      this.ws.once('close', (code) => {
        this.closed = true
        this.closeCode = code
        this.flush()
        resolve(code)
      })
    })
    this.ws.on('message', (data) => {
      const text = data.toString()
      this.raw = (this.raw || []).concat(text)
      try {
        this.frames.push(JSON.parse(text))
      } catch {
        this.frames.push({ t: '?bad', text })
      }
      this.flush()
    })
    this.ws.on('error', () => {})
  }

  flush() {
    for (const w of [...this.waiters]) {
      const i = this.frames.findIndex(w.pred)
      if (i >= 0) {
        this.waiters.splice(this.waiters.indexOf(w), 1)
        clearTimeout(w.timer)
        w.resolve(this.frames.splice(i, 1)[0])
      } else if (this.closed) {
        this.waiters.splice(this.waiters.indexOf(w), 1)
        clearTimeout(w.timer)
        w.resolve(null)
      }
    }
  }

  send(frame) {
    this.ws.send(typeof frame === 'string' ? frame : encodeFrame(frame))
  }

  // Resolves with (and removes) the first received frame that matches, or null
  // when the connection closed or the time ran out.
  until(match, ms = 3000) {
    const pred = typeof match === 'string' ? (f) => f.t === match : match
    return new Promise((resolve) => {
      const w = { pred, resolve, timer: setTimeout(() => {
        this.waiters.splice(this.waiters.indexOf(w), 1)
        resolve(null)
      }, ms) }
      this.waiters.push(w)
      this.flush()
    })
  }

  // Next frame, whatever it is.
  next(ms = 3000) {
    return this.until(() => true, ms)
  }

  // True when nothing matching arrives for `ms`.
  async quiet(match = () => true, ms = 150) {
    const pred = typeof match === 'string' ? (f) => f.t === match : match
    return (await this.until(pred, ms)) === null
  }

  async closeAndWait() {
    this.ws.close()
    await this.closedPromise
  }
}

export async function connect(relay) {
  const c = new Client(relay.url)
  await c.opened
  return c
}

export const helloFrame = (keys, extra = {}) => ({
  t: 'hello',
  v: [1, 1],
  auth: 'machine-key',
  machineId: keys.machineId,
  ...extra,
})

// Creates a group; returns { client, keys, groupId, welcome, directory }.
export async function createGroup(relay, { label, keys = newKeys() } = {}) {
  const client = await connect(relay)
  client.send(
    helloFrame(keys, { auth: 'create', adminSecret: ADMIN, signPub: keys.signPub, dhPub: keys.dhPub, ...(label ? { label } : {}) }),
  )
  const welcome = await client.until('welcome')
  const directory = await client.until('directory')
  return { client, keys, groupId: welcome.groupId, welcome, directory }
}

// Connects an existing member with a signed challenge.
export async function connectMember(relay, groupId, keys) {
  const client = await connect(relay)
  client.send(helloFrame(keys, { groupId }))
  const challenge = await client.until((f) => f.t === 'challenge' || f.t === 'error')
  if (challenge.t === 'error') {
    client.frames.unshift(challenge)
    return client
  }
  client.send({ t: 'prove', sig: signText(keys.signPriv, challengeString(challenge.nonce, groupId, keys.machineId)) })
  return client
}

// Connects a member and waits for its welcome and directory.
export async function joinAsMember(relay, groupId, keys) {
  const client = await connectMember(relay, groupId, keys)
  const welcome = await client.until((f) => f.t === 'welcome' || f.t === 'error')
  if (welcome.t === 'error') return { client, error: welcome }
  const directory = await client.until('directory')
  return { client, keys, welcome, directory }
}

export function newInvite(groupId) {
  const enrol = generateKeyPairSync('ed25519')
  return {
    id: randomBytes(9).toString('base64url'),
    groupId,
    enrolPriv: enrol.privateKey,
    enrolPub: enrol.publicKey.export({ format: 'jwk' }).x,
  }
}

// A member registers an invite with the relay.
export async function createInvite(member, groupId, { uses = 1, minutes = 60, now = Date.now(), invite = newInvite(groupId) } = {}) {
  member.send({ t: 'invite.create', id: invite.id, enrolPub: invite.enrolPub, expiresAt: now + minutes * 60000, uses })
  const reply = await member.until((f) => (f.t === 'ok' && f.re === 'invite.create') || f.t === 'error')
  return { invite, reply }
}

// A newcomer connects with an invite. Resolves with the first frame after the
// proof: welcome (pending) or error.
export async function joinWithInvite(relay, invite, keys = newKeys(), { badKey } = {}) {
  const client = await connect(relay)
  client.send(
    helloFrame(keys, {
      auth: 'invite',
      groupId: invite.groupId,
      inviteId: invite.id,
      signPub: keys.signPub,
      dhPub: keys.dhPub,
    }),
  )
  const challenge = await client.until((f) => f.t === 'challenge' || f.t === 'error')
  if (challenge.t === 'error') return { client, keys, first: challenge }
  const text = challengeString(challenge.nonce, invite.groupId, keys.machineId) + '\n' + keys.signPub + '\n' + keys.dhPub
  client.send({ t: 'prove', sig: signText(badKey || invite.enrolPriv, text) })
  const first = await client.until((f) => f.t === 'welcome' || f.t === 'error')
  return { client, keys, first }
}

// Signs and builds a removal record the way a member would.
export function removalRecord({ groupId, by, removedId, fromEpoch, confirm = 'c' }) {
  const body = {
    groupId,
    removedId,
    epoch: fromEpoch + 1,
    by: by.machineId,
    bySignPub: by.signPub,
    byDhPub: by.dhPub,
    byVouch: 'vouch',
    confirm,
  }
  return { ...body, sig: signText(by.signPriv, canonical(body)) }
}

export const leaveSig = (keys, groupId) => signText(keys.signPriv, 'perch-relay-leave\n' + groupId + '\n' + keys.machineId)

export const closeAll = (...clients) => Promise.all(clients.filter(Boolean).map((c) => c.ws.terminate()))

// Adds a machine to a group through the full invite path. `admin` is a
// connected member client; resolves with { client, keys } once admitted.
export async function addMember(relay, admin, groupId, { epoch = 1, now = Date.now() } = {}) {
  const { invite, reply } = await createInvite(admin, groupId, { now })
  if (reply.t !== 'ok') throw new Error('invite refused: ' + JSON.stringify(reply))
  const joined = await joinWithInvite(relay, invite)
  if (joined.first.t !== 'welcome') throw new Error('join refused: ' + JSON.stringify(joined.first))
  const request = await admin.until((f) => f.t === 'join.request' && f.machineId === joined.keys.machineId)
  admin.send({ t: 'admit', machineId: request.machineId, inviteId: request.inviteId, epoch })
  const ok = await admin.until((f) => f.t === 'admit.ok' || f.t === 'admit.refused')
  if (ok.t !== 'admit.ok') throw new Error('admit refused: ' + JSON.stringify(ok))
  await joined.client.until('directory')
  return { client: joined.client, keys: joined.keys }
}
