// Test rig for the relay link: an in-process relay plus any number of fake-host
// Assistant instances, each with its own secrets store and link. Test-only.
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { startTestRelay } from '../../../relay/test/helpers.mjs'
import { createLink } from '../relay/link.mjs'
import { createMembership } from '../relay/membership.mjs'
import { fakeHost } from './fakeHost.mjs'

export async function until(pred, ms = 5000, what = 'condition') {
  const end = Date.now() + ms
  for (;;) {
    const v = await pred()
    if (v) return v
    if (Date.now() > end) throw new Error('timed out waiting for ' + what)
    await new Promise((r) => setTimeout(r, 10))
  }
}

// One Assistant instance. `db` and `secrets` can be kept from an earlier node
// to model a restart.
export function makeNode(name, relayUrl, opts = {}) {
  const fh = opts.fh || fakeHost({ db: opts.db })
  const membership = createMembership({ secrets: fh.secrets })
  const node = {
    name,
    fh,
    membership,
    events: [],
    states: [],
    inboundCalls: [],
    inboundSettings: [],
    readOnly: false,
    onCall:
      opts.onCall ||
      ((peer, msg, respond) => {
        node.inboundCalls.push({ peer, msg })
        respond({ content: [{ type: 'text', text: `${name} ran ${msg.tool}` }], isError: false })
      }),
  }
  const build = () =>
    createLink({
      membership,
      log: (t) => (node.logs ||= []).push(t),
      onState: (s) => node.states.push(s),
      onEvent: (e) => node.events.push(e),
      onInbound: (v) => node.inboundSettings.push(v),
      onCall: (...a) => node.onCall(...a),
      readOnly: () => node.readOnly,
      clock: opts.clock,
      WebSocketImpl: opts.WebSocketImpl,
      clearActivity: async () => void (node.activityCleared = (node.activityCleared || 0) + 1),
    })
  node.link = build()
  // A killed and restarted Assistant: same secrets, a new link.
  node.stop = () => node.link.close()
  node.restart = async () => {
    node.link.close()
    await membership.load()
    node.link = build()
    node.link.start()
  }
  node.snap = () => node.link.snapshot()
  node.machine = (display) => node.snap().machines.find((m) => m.display === display)
  node.trustOf = (display) => node.machine(display)?.trust
  node.waitVerified = (display, ms) => until(() => node.trustOf(display) === 'verified', ms, `${name} to verify ${display}`)
  node.waitOnline = (display, online = true, ms) => until(() => node.machine(display)?.online === online, ms, `${display} online=${online}`)
  node.mid = () => (node.cachedId ||= node.membership.identity?.machineId)
  return node
}

export async function startRig(relayOpts = {}) {
  const relay = await startTestRelay(relayOpts)
  const nodes = []
  const rig = {
    relay,
    nodes,
    node(name, opts) {
      const n = makeNode(name, relay.url, opts)
      nodes.push(n)
      return n
    },
    // Creates a group on a fresh node.
    async creator(name = 'alpha', opts) {
      const n = rig.node(name, opts)
      await n.link.create({ relayUrl: relay.url, adminSecret: 'admin-secret-for-tests', name, allowInsecure: true })
      n.mid()
      return n
    },
    // Invites and joins a fresh node through `via`; resolves when both list each other as verified.
    async joiner(via, name, opts) {
      const n = rig.node(name, opts)
      const { invite } = await via.link.createInvite({ uses: 1, expiresMinutes: 60 })
      await n.link.join({ invite, name, allowInsecure: true })
      await via.waitVerified(name)
      await n.waitVerified(via.membership.state.name)
      n.mid()
      return n
    },
    async close() {
      for (const n of nodes) n.link.close()
      await relay.close()
    },
  }
  return rig
}

// Every byte under a folder, as one buffer, for "no secret on the relay's disk" checks.
export function folderBytes(dir) {
  const parts = []
  const walk = (d) => {
    for (const name of readdirSync(d)) {
      const p = join(d, name)
      if (statSync(p).isDirectory()) walk(p)
      else parts.push(readFileSync(p))
    }
  }
  walk(dir)
  return Buffer.concat(parts)
}
