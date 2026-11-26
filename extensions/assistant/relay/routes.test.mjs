import assert from 'node:assert/strict'
import { after, test } from 'node:test'
import { startTestRelay } from '../../../relay/test/helpers.mjs'
import { until } from '../test/relayRig.mjs'
import { fakeHost } from '../test/fakeHost.mjs'
import { decodeInvite } from './crypto.mjs'
import { noticeFor } from './routes.mjs'

// Each host gets its own copy of server.js, which keeps module state (the
// cleanup hook) per instance.
let counter = 0
async function startHost(relayHost = fakeHost(), { withRelay = true } = {}) {
  const mod = await import(`../server.js?instance=${++counter}`)
  mod.activate({
    router: relayHost.router,
    host: relayHost.host,
    getSettings: relayHost.getSettings,
    log: relayHost.log,
    ...(withRelay ? { secrets: relayHost.secrets, storage: relayHost.storage } : {}),
  })
  const get = async (path) => (await relayHost.request('GET', path)).body
  const post = async (path, body) => {
    const r = await relayHost.request('POST', path, body)
    return { status: r.statusCode, body: r.body }
  }
  return { fh: relayHost, mod, get, post, stop: () => mod.deactivate() }
}

const adminSecret = 'admin-secret-for-tests'

test('without secrets or storage the relay is skipped with one log line and no relay routes except an unavailable state', async () => {
  const h = await startHost(fakeHost(), { withRelay: false })
  try {
    assert.ok(h.fh.logs.some((l) => l[0] === 'relay needs Perch 0.9 or later'))
    assert.deepEqual((await h.fh.request('GET', '/relay/state')).body, { available: false, reason: 'The relay needs Perch 0.9 or later.' })
    await assert.rejects(h.fh.request('POST', '/relay/create', {}), /No handler/)
    assert.equal((await h.fh.request('GET', '/tools')).statusCode, 200)
  } finally {
    h.stop()
  }
})

test('two hosts: create, invite, join, rename, label, permission, remove, leave; no response carries a secret', async () => {
  const relay = await startTestRelay()
  const a = await startHost()
  const b = await startHost()
  const responses = []
  const keep = (r) => (responses.push(JSON.stringify(r)), r)
  after(async () => {
    a.stop()
    b.stop()
    await relay.close()
  })

  // Not in a group.
  const empty = keep(await a.get('/relay/state'))
  assert.equal(empty.joined, false)
  assert.match(empty.defaultName, /^[A-Za-z0-9._-]{1,40}$/)
  assert.deepEqual(empty.machines, [])

  // Refusals come back as { error } with a status.
  let r = keep(await a.post('/relay/create', { relayUrl: 'ws://relay.example.com', adminSecret, name: 'alpha' }))
  assert.equal(r.status, 400)
  assert.match(r.body.error, /must start with wss:\/\//)
  r = keep(await a.post('/relay/create', { relayUrl: relay.url, adminSecret, name: 'bad name', allowInsecure: true }))
  assert.equal(r.status, 400)
  r = keep(await a.post('/relay/create', { relayUrl: relay.url, adminSecret: 'wrong', name: 'alpha', allowInsecure: true }))
  assert.equal(r.status, 400)
  assert.equal(r.body.error, 'The relay did not accept that admin secret.')
  r = keep(await a.post('/relay/invites', {}))
  assert.equal(r.status, 409)
  r = keep(await a.post('/relay/leave', {}))
  assert.equal(r.status, 409)

  // Create.
  const events = await a.fh.request('GET', '/events')
  const bEvents = await b.fh.request('GET', '/events')
  r = keep(await a.post('/relay/create', { relayUrl: relay.url, adminSecret, name: 'alpha', allowInsecure: true }))
  assert.equal(r.status, 200)
  assert.equal(r.body.joined, true)
  assert.equal(r.body.machine.name, 'alpha')
  assert.equal(r.body.inbound, 'send')
  assert.equal(r.body.relayHost, relay.url.replace('ws://', ''))
  await until(async () => (await a.get('/relay/state')).connection === 'connected', 3000, 'alpha connected')
  r = keep(await a.post('/relay/create', { relayUrl: relay.url, adminSecret, name: 'alpha', allowInsecure: true }))
  assert.equal(r.status, 409)
  assert.match(r.body.error, /already in a relay group/)

  // Invite.
  const made = await a.post('/relay/invites', { uses: 1, expiresMinutes: 30 })
  assert.equal(made.status, 200)
  assert.match(made.body.invite, /^perch-invite:1:/)
  const inv = decodeInvite(made.body.invite)
  // The invite list comes from the relay's next directory frame: wait for it (T3.F7 race).
  await until(async () => (await a.get('/relay/state')).invites.length === 1, 3000, 'invite listed')
  let st = keep(await a.get('/relay/state'))
  assert.equal(st.invites.length, 1)
  assert.equal(st.invites[0].held, true)
  assert.equal(st.invites[0].usesLeft, 1)
  assert.equal(st.invites[0].createdBy, 'alpha')

  // Join.
  r = keep(await b.post('/relay/join', { invite: made.body.invite, name: 'bravo', allowInsecure: true }))
  assert.equal(r.status, 200)
  assert.equal(r.body.joined, true)
  await until(async () => (await a.get('/relay/state')).machines.find((m) => m.name === 'bravo')?.trust === 'verified', 5000, 'alpha lists bravo')
  await until(async () => (await b.get('/relay/state')).machines.find((m) => m.name === 'alpha')?.trust === 'verified', 5000, 'bravo lists alpha')
  await until(async () => (await a.get('/relay/state')).invites.length === 0, 3000, 'spent invite gone')
  st = keep(await a.get('/relay/state'))
  assert.deepEqual(st.machines.map((m) => [m.name, m.self]), [['alpha', true], ['bravo', false]])
  assert.equal(st.machines[1].online, true)
  assert.equal(st.machines[1].accepts, 'send')
  assert.equal(st.invites.length, 0)
  const notice = events.written.join('')
  assert.match(notice, /event: relay\ndata: \{"kind":"state"\}/)
  assert.match(notice, /event: relay-notice\ndata: \{"title":"bravo joined, admitted by alpha"/)

  // Label, rename, permission.
  r = keep(await b.post('/relay/label', { label: 'build-box' }))
  assert.equal(r.body.machine.label, 'build-box')
  r = keep(await b.post('/relay/label', { label: 'no good' }))
  assert.equal(r.status, 400)
  r = keep(await b.post('/relay/rename', { name: 'alpha' }))
  assert.equal(r.status, 400)
  assert.match(r.body.error, /already in this group/)
  r = keep(await b.post('/relay/rename', { name: 'bravo2' }))
  assert.equal(r.body.machine.name, 'bravo2')
  await until(async () => (await a.get('/relay/state')).machines.some((m) => m.name === 'bravo2'), 5000, 'rename visible')
  r = keep(await b.post('/relay/permission', { inbound: 'read' }))
  assert.equal(r.body.inbound, 'read')
  await until(async () => (await a.get('/relay/state')).machines.find((m) => m.name === 'bravo2')?.accepts === 'read', 5000, 'permission visible')
  r = keep(await b.post('/relay/permission', { inbound: 'sometimes' }))
  assert.equal(r.status, 400)
  await b.post('/relay/permission', { inbound: 'send' })

  // Assistant Read-only limits what is published.
  b.fh.settings['assistant.readOnly'] = true
  st = keep(await b.get('/relay/state'))
  assert.equal(st.readOnlyLimiting, true)
  await until(async () => (await a.get('/relay/state')).machines.find((m) => m.name === 'bravo2')?.accepts === 'read', 5000, 'read-only limits accepts')
  b.fh.settings['assistant.readOnly'] = false
  assert.equal((await b.get('/relay/state')).readOnlyLimiting, false)

  // Revoke an invite.
  const second = await a.post('/relay/invites', { uses: 2, expiresMinutes: 60 })
  // The invite list comes from the relay's next directory frame, not the ok: wait for it (same race as T3.F7).
  await until(async () => keep(await a.get('/relay/state')).invites.length === 1, 3000, 'invite listed')
  r = keep(await a.fh.request('DELETE', '/relay/invites/:id', { id: second.body.id }))
  assert.equal(r.statusCode, 200)
  await until(async () => (await a.get('/relay/state')).invites.length === 0, 3000, 'revoked')

  // Activity: newest first, at most 200.
  // Only membership events so far (T4.3 records them); no call has been received.
  const early = keep(await a.get('/relay/activity'))
  assert.ok(early.length > 0 && early.every((e) => e.event && e.tool === null))
  a.fh.storage.sql.exec('CREATE TABLE IF NOT EXISTS relay_activity (id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, machine TEXT NOT NULL, tool TEXT, target TEXT, outcome TEXT, event TEXT)')
  const ins = a.fh.storage.sql.prepare('INSERT INTO relay_activity (at, machine, tool, outcome) VALUES (?, ?, ?, ?)')
  for (let i = 0; i < 250; i++) ins.run(i, 'bravo2', `tool${i}`, 'allowed')
  // Calls and membership events are capped separately, 200 each (T4.F5b): count the call rows only.
  const activity = keep(await a.get('/relay/activity'))
  const rows = activity.filter((e) => e.tool)
  assert.equal(rows.length, 200)
  assert.ok(activity.some((e) => e.event), 'membership events are not pushed out by calls')
  assert.equal(rows[0].tool, 'tool249')
  assert.deepEqual(Object.keys(rows[0]), ['id', 'at', 'machine', 'tool', 'target', 'outcome', 'event'])

  // Remove by display name.
  r = keep(await a.post('/relay/remove', { machine: 'nobody' }))
  assert.equal(r.status, 409)
  assert.match(r.body.error, /No machine named "nobody"/)
  r = keep(await a.post('/relay/remove', { machine: 'bravo2' }))
  assert.equal(r.status, 200)
  await until(async () => (await b.get('/relay/state')).joined === false, 5000, 'bravo cleared')
  st = keep(await a.get('/relay/state'))
  assert.deepEqual(st.machines.map((m) => m.name), ['alpha'])
  assert.deepEqual(await b.fh.secrets.list(), [])
  const gone = keep(await b.get('/relay/state'))
  assert.equal(gone.removedBy?.by, 'alpha')
  assert.equal(typeof gone.removedBy.at, 'number')
  // The machine that removed bravo gets no notice for it; bravo, the other one, does.
  assert.doesNotMatch(events.written.join(''), /was removed by alpha/)
  assert.match(bEvents.written.join(''), /This machine was removed from the relay group by alpha/)
  // Same for the rename: alpha (the other member) heard it, bravo (who did it) did not.
  await until(() => /bravo is now called bravo2/.test(events.written.join('')), 3000, 'alpha hears the rename')
  assert.doesNotMatch(bEvents.written.join(''), /now called bravo2/)

  // A new create drops the removal note.
  keep(await b.post('/relay/create', { relayUrl: relay.url, adminSecret, name: 'bravo3', allowInsecure: true }))
  assert.equal((await b.get('/relay/state')).removedBy, undefined)
  keep(await b.post('/relay/leave', {}))

  // Leave clears everything, including the activity list.
  const stored = []
  for (const k of ['relay.signKey', 'relay.dhKey']) stored.push(await a.fh.secrets.get(k))
  stored.push(JSON.parse(await a.fh.secrets.get('relay.group')).secret)
  r = keep(await a.post('/relay/leave', {}))
  assert.deepEqual(r.body, { relayEntryRemoved: true })
  assert.deepEqual(await a.fh.secrets.list(), [])
  assert.equal(a.fh.storage.sql.prepare('SELECT COUNT(*) AS n FROM relay_activity').get().n, 0)
  assert.equal((await a.get('/relay/state')).joined, false)

  // No response except the invite creation carries a stored secret.
  const all = responses.join('\n')
  for (const [what, value] of [
    ['admin secret', adminSecret],
    ['invite string', made.body.invite],
    ['admission secret', inv.admit],
    ['enrolment key', inv.enrolKey],
    ...stored.map((v) => ['key or group secret', v]),
  ]) {
    assert.ok(!all.includes(value), `a response carried the ${what}`)
  }
})

test('state survives a restart: a host with stored membership reconnects on activate', async () => {
  const relay = await startTestRelay()
  const a = await startHost()
  let b2
  after(async () => {
    a.stop()
    b2?.stop()
    await relay.close()
  })
  await a.post('/relay/create', { relayUrl: relay.url, adminSecret, name: 'alpha', allowInsecure: true })
  const made = await a.post('/relay/invites', {})
  const b = await startHost()
  await b.post('/relay/join', { invite: made.body.invite, name: 'bravo', allowInsecure: true })
  await until(async () => (await a.get('/relay/state')).machines.find((m) => m.name === 'bravo')?.online, 5000, 'bravo online')
  b.stop()
  await until(async () => (await a.get('/relay/state')).machines.find((m) => m.name === 'bravo')?.online === false, 5000, 'bravo offline')
  // Same secrets, a new Assistant instance.
  const again = fakeHost({ db: b.fh.storage.db })
  again.secrets = b.fh.secrets
  b2 = await startHost(again)
  await until(async () => (await b2.get('/relay/state')).connection === 'connected', 5000, 'bravo reconnected')
  await until(async () => (await a.get('/relay/state')).machines.find((m) => m.name === 'bravo')?.online === true, 5000, 'alpha sees bravo again')
})

test('notices read as the spec words them', () => {
  assert.equal(noticeFor({ kind: 'joined', name: 'buildbox', by: 'laptop' }).title, 'buildbox joined, admitted by laptop')
  assert.equal(noticeFor({ kind: 'left', by: 'buildbox' }).title, 'buildbox left the group')
  assert.equal(noticeFor({ kind: 'removed', name: 'buildbox', by: 'laptop' }).title, 'buildbox was removed by laptop')
  assert.equal(noticeFor({ kind: 'invite-created', by: 'laptop' }).title, 'laptop created an invite')
  assert.equal(noticeFor({ kind: 'invite-revoked', by: 'laptop' }).title, 'laptop revoked an invite')
  assert.equal(
    noticeFor({ kind: 'blocked', name: 'buildbox' }).title,
    'buildbox was blocked by the relay admin; remove it here to replace the group secret',
  )
  assert.equal(noticeFor({ kind: 'nothing' }), null)
})
