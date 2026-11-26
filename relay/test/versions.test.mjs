import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import { DatabaseSync } from 'node:sqlite'
import { join } from 'node:path'
import { ADMIN, connect, createGroup, helloFrame, newKeys, startTestRelay } from './helpers.mjs'

let relay
afterEach(async () => {
  await relay?.close()
  relay = null
})

async function hello(v, extra = {}) {
  const keys = newKeys()
  const c = await connect(relay)
  c.send(helloFrame(keys, { v, auth: 'create', adminSecret: ADMIN, signPub: keys.signPub, dhPub: keys.dhPub, ...extra }))
  return c
}

test('an overlapping range connects at the highest common version', async () => {
  relay = await startTestRelay()
  for (const range of [[1, 1], [0, 5], [1, 9]]) {
    const c = await hello(range)
    const welcome = await c.until((f) => f.t === 'welcome' || f.t === 'error')
    assert.equal(welcome.t, 'welcome', JSON.stringify(range))
    assert.equal(welcome.v, 1)
    c.ws.terminate()
  }
})

test('a disjoint range is refused with the update message for the older side', async () => {
  relay = await startTestRelay()
  const newer = await hello([2, 3])
  const e1 = await newer.until('error')
  assert.equal(e1.code, 'version')
  assert.equal(e1.message, 'the relay is too old for this Perch; update the relay')
  await newer.closedPromise

  const older = await hello([0, 0])
  const e2 = await older.until('error')
  assert.equal(e2.code, 'version')
  assert.equal(e2.message, 'this Perch is too old for the relay; update Perch')
  await older.closedPromise
})

test('an unknown auth method is refused', async () => {
  relay = await startTestRelay()
  const keys = newKeys()
  const c = await connect(relay)
  c.send(helloFrame(keys, { auth: 'password' }))
  const e = await c.until('error')
  assert.equal(e.code, 'auth-method')
  await c.closedPromise
})

test('a stored group has owner kind key and no owner id', async () => {
  relay = await startTestRelay()
  const { client, groupId } = await createGroup(relay)
  const raw = new DatabaseSync(join(relay.dir, 'relay.sqlite'), { readOnly: true })
  const row = raw.prepare('SELECT owner_kind, owner_id, epoch FROM groups WHERE id = ?').get(groupId)
  raw.close()
  assert.deepEqual({ ...row }, { owner_kind: 'key', owner_id: null, epoch: 1 })
  client.ws.terminate()
})
