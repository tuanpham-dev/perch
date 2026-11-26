// What this Perch remembers about its relay group, kept in the extension's
// secrets store (never served to the browser, untouched by settings import,
// export and reset). Four secrets: relay.state (JSON, no key material),
// relay.signKey and relay.dhKey (private keys, PKCS#8 base64url) and
// relay.group (JSON {secret, epoch}, always written as one value).
//
// The operations that talk to the relay (create, invite, join, admit, remove,
// leave ...) live in link.mjs; this file is only state and the pure rules.

import { createPrivateKey, createPublicKey } from 'node:crypto'
import { hostname } from 'node:os'
import { NAME_RE } from '../../_shared/relayWire.mjs'
import { checkVouch } from './crypto.mjs'

const KEY_STATE = 'relay.state'
const KEY_SIGN = 'relay.signKey'
const KEY_DH = 'relay.dhKey'
const KEY_GROUP = 'relay.group'
const GONE_MAX = 200

export const INBOUND_VALUES = Object.freeze(['off', 'read', 'send'])

export const URL_MESSAGE =
  'The relay address must start with wss://. Turn on "allow unencrypted connection" only on a network you trust.'

// Accepts wss:; accepts ws: only for loopback hosts or with allowInsecure.
// Returns the URL string, or throws an Error with the user-facing text.
export function checkRelayUrl(url, allowInsecure = false) {
  let u
  try {
    u = new URL(String(url ?? '').trim())
  } catch {
    throw new Error(URL_MESSAGE)
  }
  const clean = () => (u.pathname === '/' && !u.search && !u.hash ? u.protocol + '//' + u.host : u.href)
  if (u.protocol === 'wss:') return clean()
  const loopback = u.hostname === 'localhost' || u.hostname === '127.0.0.1' || u.hostname === '[::1]'
  if (u.protocol === 'ws:' && (loopback || allowInsecure === true)) return clean()
  throw new Error(URL_MESSAGE)
}

// The host name reduced to the characters a machine name allows.
export function defaultName(host = hostname()) {
  const name = String(host ?? '').replace(/[^A-Za-z0-9._-]/g, '').slice(0, 40)
  return NAME_RE.test(name) ? name : 'perch'
}

// machines: [{ id, name }]. Returns Map(id -> display name). A name shared by
// several machines shows as name~xxxx (the first four id characters) for each
// of them; a machine with no known name shows as ?xxxxxxxx.
export function displayNames(machines) {
  const count = new Map()
  for (const m of machines) if (m.name) count.set(m.name, (count.get(m.name) || 0) + 1)
  const out = new Map()
  for (const m of machines) {
    if (!m.name) out.set(m.id, '?' + m.id.slice(0, 8))
    else out.set(m.id, count.get(m.name) > 1 ? `${m.name}~${m.id.slice(0, 4)}` : m.name)
  }
  return out
}

function publicOf(privateDer) {
  return createPublicKey(createPrivateKey({ key: Buffer.from(privateDer, 'base64url'), format: 'der', type: 'pkcs8' })).export({ format: 'jwk' }).x
}

function emptyState() {
  return {
    relayUrl: '',
    allowInsecure: false,
    groupId: '',
    machineId: '',
    name: '',
    label: '',
    inbound: 'send',
    pinned: {},
    removed: [],
    invites: {},
    goneInvites: [],
  }
}

function parseJson(text) {
  try {
    const v = JSON.parse(text)
    return v !== null && typeof v === 'object' && !Array.isArray(v) ? v : null
  } catch {
    return null
  }
}

export function createMembership({ secrets }) {
  let writes = Promise.resolve()
  const queue = (fn) => {
    const run = writes.then(fn)
    writes = run.catch(() => {})
    return run
  }

  const m = {
    state: null,
    identity: null,
    group: null,

    get joined() {
      return !!(m.state && m.identity && m.group)
    },

    // Reads the four secrets. Joined only when all of them are present and fit
    // together; anything else is "not in a group".
    async load() {
      m.state = m.identity = m.group = null
      const [stateText, signKey, dhKey, groupText] = await Promise.all([
        secrets.get(KEY_STATE),
        secrets.get(KEY_SIGN),
        secrets.get(KEY_DH),
        secrets.get(KEY_GROUP),
      ])
      const state = stateText && parseJson(stateText)
      const group = groupText && parseJson(groupText)
      if (!state || !group || !signKey || !dhKey) return false
      if (typeof group.secret !== 'string' || !Number.isSafeInteger(group.epoch)) return false
      try {
        m.identity = { machineId: state.machineId, signKey, signPub: publicOf(signKey), dhKey, dhPub: publicOf(dhKey) }
      } catch {
        return false
      }
      m.state = { ...emptyState(), ...state }
      m.group = { secret: group.secret, epoch: group.epoch }
      return true
    },

    saveState() {
      const text = JSON.stringify(m.state)
      return queue(() => secrets.set(KEY_STATE, text))
    },

    // One secrets.set, so the secret and its epoch never disagree on disk.
    // Memory follows the disk: m.group changes only after the write resolved.
    async saveGroup(group) {
      const next = { secret: group.secret, epoch: group.epoch }
      const text = JSON.stringify(next)
      await queue(() => secrets.set(KEY_GROUP, text))
      m.group = next
    },

    // Group, then keys, then state: the state is what makes a half-written
    // membership count as joined, so it goes last.
    async saveNew({ identity, group, state }) {
      await m.saveGroup(group)
      m.identity = identity
      await queue(async () => {
        await secrets.set(KEY_SIGN, identity.signKey)
        await secrets.set(KEY_DH, identity.dhKey)
      })
      m.state = { ...emptyState(), ...state }
      await m.saveState()
    },

    async clear() {
      m.state = m.identity = m.group = null
      await queue(async () => {
        for (const k of [KEY_STATE, KEY_SIGN, KEY_DH, KEY_GROUP]) await secrets.set(k, null)
      })
    },

    // Remember that an invite is finished (revoked, used up, cancelled, or
    // reported gone by a peer) so it is never accepted again.
    dropInvite(id) {
      if (!m.state) return
      delete m.state.invites[id]
      if (!m.state.goneInvites.includes(id)) m.state.goneInvites.push(id)
      if (m.state.goneInvites.length > GONE_MAX) m.state.goneInvites = m.state.goneInvites.slice(-GONE_MAX)
    },

    // machine: { id, signPub, dhPub, blocked?, vouch? } where vouch is the one
    // from the machine's opened profile. Verified needs the id not removed, not
    // blocked, and keys that equal the pinned ones or a vouch that checks under
    // the current group. A pinned machine never passes with other keys.
    trust(machine) {
      const { state, group } = m
      if (!state || !group) return 'unverified'
      if (state.removed.includes(machine.id) || machine.blocked) return 'unverified'
      const pin = Object.hasOwn(state.pinned, machine.id) ? state.pinned[machine.id] : null
      if (pin) return pin.signPub === machine.signPub && pin.dhPub === machine.dhPub ? 'verified' : 'unverified'
      return checkVouch(group.secret, group.epoch, { machineId: machine.id, signPub: machine.signPub, dhPub: machine.dhPub }, machine.vouch) ? 'verified' : 'unverified'
    },
  }
  return m
}
