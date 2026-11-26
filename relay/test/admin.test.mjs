import assert from 'node:assert/strict'
import { spawn, execFile } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { createConnection } from 'node:net'
import { networkInterfaces, tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { ADMIN, addMember, connect, connectMember, createGroup, helloFrame, joinAsMember, leaveSig, startTestRelay } from './helpers.mjs'

const run = promisify(execFile)
const MAIN = fileURLToPath(new URL('../src/main.mjs', import.meta.url))

let relay
let clients = []
afterEach(async () => {
  for (const c of clients) c.ws.terminate()
  clients = []
  await relay?.close()
  relay = null
})

const admin = (path, { method = 'GET', secret = ADMIN } = {}) =>
  fetch(`http://127.0.0.1:${relay.adminPort}${path}`, { method, headers: secret === null ? {} : { 'x-relay-admin': secret } })

test('admin routes need the admin secret', async () => {
  relay = await startTestRelay()
  assert.equal((await admin('/groups', { secret: null })).status, 403)
  assert.equal((await admin('/groups', { secret: 'wrong' })).status, 403)
  assert.equal((await admin('/groups')).status, 200)
})

test('with no admin secret configured every admin request is refused', async () => {
  relay = await startTestRelay({ env: { RELAY_ADMIN_SECRET: '' } })
  assert.equal((await admin('/groups', { secret: '' })).status, 403)
  assert.equal((await admin('/groups', { secret: 'x' })).status, 403)
})

test('more than 5 wrong secrets in a minute give 429 for that minute (mock clock)', async () => {
  const { fakeClock } = await import('./helpers.mjs')
  const clock = fakeClock()
  relay = await startTestRelay({ clock })
  for (let i = 0; i < 5; i++) assert.equal((await admin('/groups', { secret: 'bad' + i })).status, 403)
  assert.equal((await admin('/groups', { secret: 'bad' })).status, 429)
  assert.equal((await admin('/groups')).status, 429, 'even the right secret waits out the minute')
  clock.tick(61000)
  assert.equal((await admin('/groups')).status, 200)
})

test('the admin listener is bound to 127.0.0.1 only; the public port serves no admin routes', async () => {
  relay = await startTestRelay({ env: { RELAY_HOST: '0.0.0.0' } })
  for (const path of ['/groups', '/admin/groups', '/groups/x/machines']) {
    const r = await fetch(`http://127.0.0.1:${relay.port}${path}`, { headers: { 'x-relay-admin': ADMIN } })
    assert.equal(r.status, 404, path)
  }
  const external = Object.values(networkInterfaces())
    .flat()
    .find((i) => i && i.family === 'IPv4' && !i.internal)
  if (!external) return // no non-loopback address on this machine to probe
  const reach = (port) =>
    new Promise((resolve) => {
      const s = createConnection({ port, host: external.address }, () => {
        s.destroy()
        resolve(true)
      })
      s.on('error', () => resolve(false))
    })
  assert.equal(await reach(relay.port), true, 'the public port listens on every address')
  assert.equal(await reach(relay.adminPort), false, 'the admin port does not')
  assert.equal((await admin('/groups')).status, 200, 'but loopback works')
})

test('GET /groups and /groups/:id/machines list ids, labels and status but never names or profiles', async () => {
  relay = await startTestRelay()
  const a = await createGroup(relay, { label: 'rack' })
  clients.push(a.client)
  a.client.send({ t: 'profile.put', blob: 'PROFILE-SECRET-BLOB', epoch: 1 })
  await a.client.until('ok')
  const b = await addMember(relay, a.client, a.groupId)
  clients.push(b.client)

  const groups = await (await admin('/groups')).json()
  assert.deepEqual(groups.map((g) => [g.id, g.epoch, g.machines, g.online]), [[a.groupId, 1, 2, 2]])
  const machines = await (await admin(`/groups/${a.groupId}/machines`)).json()
  assert.equal(machines.length, 2)
  const first = machines.find((m) => m.id === a.keys.machineId)
  assert.deepEqual([first.label, first.online, first.status], ['rack', true, 'member'])
  assert.deepEqual(Object.keys(first).sort(), ['id', 'label', 'lastSeen', 'online', 'status'])
  const text = JSON.stringify(groups) + JSON.stringify(machines)
  assert.ok(!text.includes('PROFILE-SECRET-BLOB'))
  assert.equal((await admin('/groups/nope/machines')).status, 404)
})

test('DELETE machine blocks it, closes its connection and marks it blocked for the others; no re-key', async () => {
  relay = await startTestRelay()
  const a = await createGroup(relay)
  const b = await addMember(relay, a.client, a.groupId)
  clients.push(a.client, b.client)
  const res = await admin(`/groups/${a.groupId}/machines/${b.keys.machineId}`, { method: 'DELETE' })
  assert.equal(res.status, 200)
  const e = await b.client.until('error')
  assert.equal(e.code, 'blocked')
  await b.client.closedPromise
  const dir = await a.client.until((f) => f.t === 'directory' && f.machines.some((m) => m.blocked))
  const entry = dir.machines.find((m) => m.id === b.keys.machineId)
  assert.deepEqual([entry.blocked, entry.online], [true, false])
  assert.equal(await a.client.quiet('rekey', 100), true)
  assert.equal((await (await admin('/groups')).json())[0].epoch, 1, 'blocking does not re-key')

  // Reconnect: blocked only after a valid signature.
  const bad = await connect(relay)
  bad.send(helloFrame(b.keys, { groupId: a.groupId }))
  await bad.until('challenge')
  bad.send({ t: 'prove', sig: 'AAAA' })
  assert.equal((await bad.until('error')).code, 'credential')
  const again = await connectMember(relay, a.groupId, b.keys)
  assert.equal((await again.until('error')).code, 'blocked')
  const machines = await (await admin(`/groups/${a.groupId}/machines`)).json()
  assert.equal(machines.find((m) => m.id === b.keys.machineId).status, 'blocked')
  assert.equal((await admin(`/groups/${a.groupId}/machines/${'9'.repeat(32)}`, { method: 'DELETE' })).status, 404)
})

test('DELETE group disconnects every member and refuses them afterwards', async () => {
  relay = await startTestRelay()
  const a = await createGroup(relay)
  const b = await addMember(relay, a.client, a.groupId)
  clients.push(a.client, b.client)
  assert.equal((await admin(`/groups/${a.groupId}`, { method: 'DELETE' })).status, 200)
  await Promise.all([a.client.closedPromise, b.client.closedPromise])
  assert.deepEqual(await (await admin('/groups')).json(), [])
  const back = await joinAsMember(relay, a.groupId, a.keys)
  assert.equal(back.error.code, 'credential')
  assert.equal((await admin(`/groups/${a.groupId}`, { method: 'DELETE' })).status, 404)
})

test('/healthz body is exactly {"ok":true}', async () => {
  relay = await startTestRelay()
  assert.equal(await (await fetch(`http://127.0.0.1:${relay.port}/healthz`)).text(), '{"ok":true}')
})

// ---- the real entry point -------------------------------------------------

function startMain(env) {
  const child = spawn(process.execPath, [MAIN, 'serve'], { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] })
  let out = ''
  const ready = new Promise((resolve, reject) => {
    child.stdout.on('data', (d) => {
      out += d
      if (/Data folder:/.test(out)) resolve()
    })
    child.stderr.on('data', (d) => (out += d))
    child.on('exit', (code) => reject(new Error(`exited ${code}: ${out}`)))
  })
  return { child, ready, output: () => out }
}

test('serve prints the addresses and data folder; the subcommands print tables without names', async () => {
  const dir = mkdtempSync(join(process.env.TMPDIR || tmpdir(), 'relay-main-'))
  const env = { RELAY_HOST: '127.0.0.1', RELAY_PORT: '0', RELAY_ADMIN_PORT: '0', RELAY_DATA_DIR: dir, RELAY_ADMIN_SECRET: ADMIN }
  const main = startMain(env)
  try {
    await main.ready
    const out = main.output()
    const port = /ws:\/\/127\.0\.0\.1:(\d+)/.exec(out)[1]
    const adminPort = /http:\/\/127\.0\.0\.1:(\d+)/.exec(out)[1]
    assert.match(out, new RegExp('Data folder: ' + dir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/^\/private/, '(?:/private)?')))
    assert.equal(await (await fetch(`http://127.0.0.1:${port}/healthz`)).text(), '{"ok":true}')

    const fake = { url: `ws://127.0.0.1:${port}` }
    const a = await createGroup(fake, { label: 'rack' })
    clients.push(a.client)
    const cli = (...args) => run(process.execPath, [MAIN, ...args], { env: { ...process.env, ...env, RELAY_ADMIN_PORT: adminPort } })
    const groups = await cli('groups')
    assert.match(groups.stdout, /GROUP\s+EPOCH\s+MACHINES\s+ONLINE\s+CREATED/)
    assert.ok(groups.stdout.includes(a.groupId))
    const machines = await cli('machines', a.groupId)
    assert.ok(machines.stdout.includes(a.keys.machineId) && machines.stdout.includes('rack') && machines.stdout.includes('member'))
    await cli('remove-machine', a.groupId, a.keys.machineId)
    assert.equal((await a.client.until('error')).code, 'blocked')
    assert.match((await cli('machines', a.groupId)).stdout, /blocked/)
    const del = await cli('delete-group', a.groupId)
    assert.match(del.stdout, /Deleted group/)
    assert.equal((await cli('groups')).stdout.includes(a.groupId), false)
    await assert.rejects(cli('machines', 'nope'), (err) => err.code === 1 && /No such group/.test(err.stderr))
  } finally {
    main.child.kill('SIGTERM')
    await new Promise((r) => main.child.once('exit', r))
    rmSync(dir, { recursive: true, force: true })
  }
})

test('an unknown subcommand prints usage and exits 1; a bad auth mode exits 1', async () => {
  await assert.rejects(run(process.execPath, [MAIN, 'frobnicate']), (err) => err.code === 1 && /Usage:/.test(err.stderr))
  await assert.rejects(run(process.execPath, [MAIN]), (err) => err.code === 1 && /Usage:/.test(err.stderr))
  await assert.rejects(run(process.execPath, [MAIN, 'machines']), (err) => err.code === 1 && /Usage:/.test(err.stderr))
  for (const [mode, text] of [['account', /accounts are not available in this version of the relay/], ['both', /accounts are not available/], ['weird', /RELAY_AUTH_MODE must be "token"/]]) {
    await assert.rejects(
      run(process.execPath, [MAIN, 'serve'], { env: { ...process.env, RELAY_AUTH_MODE: mode, RELAY_DATA_DIR: tmpdir() } }),
      (err) => err.code === 1 && text.test(err.stderr),
      mode,
    )
  }
})

test('admin subcommands fail clearly without a secret or a running relay', async () => {
  const env = { ...process.env, RELAY_ADMIN_SECRET: '', RELAY_ADMIN_PORT: '1' }
  await assert.rejects(run(process.execPath, [MAIN, 'groups'], { env }), (err) => err.code === 1 && /RELAY_ADMIN_SECRET is not set/.test(err.stderr))
  await assert.rejects(
    run(process.execPath, [MAIN, 'groups'], { env: { ...env, RELAY_ADMIN_SECRET: 'x' } }),
    (err) => err.code === 1 && /Could not reach/.test(err.stderr),
  )
})

test('a malformed admin URL answers 400 and the relay keeps serving', async () => {
  relay = await startTestRelay()
  for (const path of ['/groups/%', '/groups/%E0%A4%A/machines', '/groups/%zz']) {
    assert.equal((await admin(path)).status, 400, path)
  }
  assert.equal((await admin('/groups')).status, 200)
  assert.equal(await (await fetch(`http://127.0.0.1:${relay.port}/healthz`)).text(), '{"ok":true}')
})

test('a group whose last member leaves is dropped even when blocked machines remain', async () => {
  relay = await startTestRelay()
  const a = await createGroup(relay)
  const b = await addMember(relay, a.client, a.groupId)
  clients.push(a.client, b.client)
  assert.equal((await admin(`/groups/${a.groupId}/machines/${b.keys.machineId}`, { method: 'DELETE' })).status, 200)
  await a.client.until((f) => f.t === 'directory' && f.machines.some((m) => m.blocked))
  a.client.send({ t: 'leave', sig: leaveSig(a.keys, a.groupId) })
  await a.client.until('ok')
  assert.deepEqual(await (await admin('/groups')).json(), [])
})

test('a refusal of a member frame names the frame it answers', async () => {
  relay = await startTestRelay()
  const a = await createGroup(relay)
  clients.push(a.client)
  a.client.send({ t: 'label.set', label: 'has space' })
  const e = await a.client.until('error')
  assert.deepEqual([e.code, e.re], ['bad-frame', 'label.set'])
})
