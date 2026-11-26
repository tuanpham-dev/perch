import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fakeHost } from '../test/fakeHost.mjs'
import { newIdentity, vouchFor } from './crypto.mjs'
import { checkRelayUrl, createMembership, defaultName, displayNames, URL_MESSAGE } from './membership.mjs'

const SECRET = Buffer.alloc(32, 9).toString('base64url')

async function joined(extra = {}) {
  const fh = fakeHost()
  const m = createMembership({ secrets: fh.secrets })
  const identity = newIdentity()
  await m.saveNew({
    identity,
    group: { secret: SECRET, epoch: 1 },
    state: { relayUrl: 'wss://r.example', groupId: 'a'.repeat(32), machineId: identity.machineId, name: 'laptop', ...extra },
  })
  return { fh, m, identity }
}

test('relay URL rules: wss always, ws only for loopback or when allowed', () => {
  assert.equal(checkRelayUrl('wss://relay.example.com'), 'wss://relay.example.com')
  assert.equal(checkRelayUrl('wss://relay.example.com/path?x=1'), 'wss://relay.example.com/path?x=1')
  for (const ok of ['ws://localhost:8787', 'ws://127.0.0.1:8787', 'ws://[::1]:8787']) assert.ok(checkRelayUrl(ok))
  for (const bad of ['ws://relay.example.com', 'http://relay.example.com', 'https://relay.example.com', 'relay.example.com', '', null, undefined]) {
    assert.throws(() => checkRelayUrl(bad), { message: URL_MESSAGE })
  }
  assert.equal(checkRelayUrl('ws://relay.lan:8787', true), 'ws://relay.lan:8787')
  assert.throws(() => checkRelayUrl('ws://relay.lan:8787', false), { message: URL_MESSAGE })
  assert.throws(() => checkRelayUrl('http://relay.lan', true), { message: URL_MESSAGE })
})

test('defaultName reduces a host name to allowed characters, 40 long, with a fallback', () => {
  assert.equal(defaultName('Tuan’s MacBook Pro.local'), 'TuansMacBookPro.local')
  assert.equal(defaultName('x'.repeat(60)), 'x'.repeat(40))
  assert.equal(defaultName('   '), 'perch')
  assert.equal(defaultName('日本語'), 'perch')
  assert.match(defaultName(), /^[A-Za-z0-9._-]{1,40}$/)
})

test('displayNames marks every machine that shares a name', () => {
  const names = displayNames([
    { id: 'aaaa' + '0'.repeat(28), name: 'box' },
    { id: 'bbbb' + '0'.repeat(28), name: 'box' },
    { id: 'cccc' + '0'.repeat(28), name: 'laptop' },
    { id: 'dddd' + '0'.repeat(28), name: null },
  ])
  assert.equal(names.get('aaaa' + '0'.repeat(28)), 'box~aaaa')
  assert.equal(names.get('bbbb' + '0'.repeat(28)), 'box~bbbb')
  assert.equal(names.get('cccc' + '0'.repeat(28)), 'laptop')
  assert.equal(names.get('dddd' + '0'.repeat(28)), '?dddd0000')
})

test('state, keys and group survive a reload; saveGroup is one secrets.set', async () => {
  const { fh, m, identity } = await joined({ inbound: 'read' })
  const sets = []
  const orig = fh.secrets.set
  fh.secrets.set = async (k, v) => (sets.push(k), orig(k, v))
  await m.saveGroup({ secret: SECRET, epoch: 2 })
  assert.deepEqual(sets, ['relay.group'])
  const again = createMembership({ secrets: fh.secrets })
  assert.equal(await again.load(), true)
  assert.equal(again.state.inbound, 'read')
  assert.equal(again.state.name, 'laptop')
  assert.deepEqual(again.group, { secret: SECRET, epoch: 2 })
  assert.equal(again.identity.signPub, identity.signPub)
  assert.equal(again.identity.dhPub, identity.dhPub)
  assert.deepEqual(m.state.pinned, {})
})

test('a half-written membership is not a group', async () => {
  const fh = fakeHost()
  const m = createMembership({ secrets: fh.secrets })
  await fh.secrets.set('relay.group', JSON.stringify({ secret: SECRET, epoch: 1 }))
  assert.equal(await m.load(), false)
  assert.equal(m.joined, false)
})

test('clear() leaves none of the four secrets', async () => {
  const { fh, m } = await joined()
  assert.deepEqual((await fh.secrets.list()).sort(), ['relay.dhKey', 'relay.group', 'relay.signKey', 'relay.state'])
  await m.clear()
  assert.deepEqual(await fh.secrets.list(), [])
  assert.equal(m.joined, false)
})

test('dropInvite deletes the held invite and keeps the newest 200 gone ids', async () => {
  const { m } = await joined({ invites: { a: { admit: 'x', expiresAt: 1 } } })
  m.dropInvite('a')
  assert.deepEqual(m.state.invites, {})
  assert.deepEqual(m.state.goneInvites, ['a'])
  for (let i = 0; i < 250; i++) m.dropInvite('i' + i)
  assert.equal(m.state.goneInvites.length, 200)
  assert.equal(m.state.goneInvites.at(-1), 'i249')
  assert.ok(!m.state.goneInvites.includes('a'))
})

test('trust: vouched, pinned, swapped keys, blocked and removed machines', async () => {
  const { m } = await joined()
  const peer = newIdentity()
  const keys = { machineId: peer.machineId, signPub: peer.signPub, dhPub: peer.dhPub }
  const vouch = vouchFor(SECRET, 1, keys)
  const machine = { id: peer.machineId, signPub: peer.signPub, dhPub: peer.dhPub, vouch }

  assert.equal(m.trust(machine), 'verified', 'vouched')
  assert.equal(m.trust({ ...machine, vouch: undefined }), 'unverified', 'no vouch, not pinned')
  assert.equal(m.trust({ ...machine, vouch: vouchFor(Buffer.alloc(32, 1).toString('base64url'), 1, keys) }), 'unverified', 'wrong secret')
  assert.equal(m.trust({ ...machine, vouch: vouchFor(SECRET, 2, keys) }), 'unverified', 'wrong epoch')

  const other = newIdentity()
  const swapped = { ...machine, signPub: other.signPub }
  assert.equal(m.trust(swapped), 'unverified', 'swapped keys fail the vouch')

  m.state.pinned[peer.machineId] = { signPub: peer.signPub, dhPub: peer.dhPub, name: 'p' }
  assert.equal(m.trust({ ...machine, vouch: undefined }), 'verified', 'pinned keys need no vouch')
  assert.equal(m.trust({ ...swapped, vouch: undefined }), 'unverified', 'pinned machine with other keys')
  // A vouch that is valid for the new keys still does not override the pin.
  const k2 = { machineId: peer.machineId, signPub: other.signPub, dhPub: other.dhPub }
  assert.equal(m.trust({ id: peer.machineId, signPub: other.signPub, dhPub: other.dhPub, vouch: vouchFor(SECRET, 1, k2) }), 'unverified')

  assert.equal(m.trust({ ...machine, blocked: true }), 'unverified', 'blocked')
  m.state.removed.push(peer.machineId)
  assert.equal(m.trust(machine), 'unverified', 'removed')
})
