// HTTP routes of the relay link, for the Settings section and `perch relay`.
// Everything answers JSON; failures are { error } with 400 (bad request) or
// 409 (not possible in the current state). No response carries a key, the
// group secret, an invite secret or the admin secret, except the invite string
// in the answer to creating that invite.

import { defaultName } from './membership.mjs'

export const ACTIVITY_MAX = 200

// The title and detail of the notice overlay for a membership event.
export function noticeFor(e) {
  const who = (v) => v || 'A machine'
  switch (e.kind) {
    case 'joined':
      return { title: `${who(e.name)} joined, admitted by ${who(e.by)}`, detail: 'A new machine is now in this relay group.' }
    case 'left':
      return { title: `${who(e.by)} left the group`, detail: '' }
    case 'removed':
      return { title: `${who(e.name)} was removed by ${who(e.by)}`, detail: 'The group secret was replaced.' }
    case 'self-removed':
      return { title: `This machine was removed from the relay group${e.by ? ` by ${e.by}` : ''}`, detail: 'Its relay keys were deleted.' }
    case 'invite-created':
      return { title: `${who(e.by)} created an invite`, detail: '' }
    case 'invite-revoked':
      return { title: `${who(e.by)} revoked an invite`, detail: '' }
    case 'renamed':
      // A peer's event carries the old name in `name`; this machine's own has it in `by`.
      return { title: `${who(e.name && e.name !== e.to ? e.name : e.by)} is now called ${who(e.to || e.name)}`, detail: '' }
    case 'package-missing':
      return { title: `${who(e.name)} did not get the new group key; invite it again`, detail: '' }
    case 'blocked':
      return { title: `${who(e.name)} was blocked by the relay admin; remove it here to replace the group secret`, detail: '' }
    default:
      return null
  }
}

function statusFor(message) {
  return /already in a relay group|not in a relay group|still running|not connected|no such machine|No machine named/i.test(message) ? 409 : 400
}

// options: { router, membership, link, readOnly(), sql, emit(name, data) }
export function registerRelayRoutes({ router, membership, link, readOnly = async () => false, sql }) {
  const fail = (res, err) => {
    const message = err instanceof Error ? err.message : String(err)
    res.status(statusFor(message)).json({ error: message })
  }
  const body = (req) => (req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {})
  const str = (v) => (typeof v === 'string' ? v : '')

  // Assistant Read-only can change in Settings without this extension hearing
  // of it; the next state request notices and republishes the profile.
  let lastReadOnly = null
  async function currentReadOnly() {
    let ro = false
    try {
      ro = (await readOnly()) === true
    } catch {}
    if (lastReadOnly !== null && ro !== lastReadOnly && membership.joined) void link.refreshProfile().catch(() => {})
    lastReadOnly = ro
    return ro
  }

  async function stateBody() {
    const ro = await currentReadOnly()
    if (!membership.joined) {
      return {
        joined: false,
        defaultName: defaultName(),
        relayHost: null,
        connection: null,
        reason: '',
        machine: null,
        inbound: null,
        readOnlyLimiting: false,
        machines: [],
        invites: [],
        ...(link.removedBy ? { removedBy: link.removedBy } : {}),
      }
    }
    const { state, identity } = membership
    const snap = link.snapshot()
    let relayHost = ''
    try {
      relayHost = new URL(state.relayUrl).host
    } catch {}
    // Removed machines stay in the link's directory (a relay may re-list them; they must stay
    // unverified) but are not shown: neither Settings nor `perch relay machines` lists them.
    const machines = snap.machines
      .filter((m) => !m.removed)
      .map((m) => ({
        id: m.id,
        name: m.display,
        self: m.self,
        online: m.online,
        lastSeen: m.lastSeen,
        trust: m.trust,
        blocked: m.blocked,
        accepts: m.accepts,
      }))
      .sort((a, b) => Number(b.self) - Number(a.self) || a.name.localeCompare(b.name))
    return {
      joined: true,
      defaultName: defaultName(),
      relayHost,
      connection: snap.status,
      reason: snap.reason,
      machine: { id: identity.machineId, name: state.name, label: state.label },
      inbound: state.inbound,
      readOnlyLimiting: ro && state.inbound === 'send',
      machines,
      invites: snap.invites,
    }
  }

  router.get('/relay/state', async (_req, res) => {
    try {
      res.json(await stateBody())
    } catch (e) {
      fail(res, e)
    }
  })

  router.post('/relay/create', async (req, res) => {
    const b = body(req)
    try {
      await link.create({ relayUrl: str(b.relayUrl), adminSecret: str(b.adminSecret), name: str(b.name), allowInsecure: b.allowInsecure === true })
      res.json(await stateBody())
    } catch (e) {
      fail(res, e)
    }
  })

  router.post('/relay/join', async (req, res) => {
    const b = body(req)
    try {
      await link.join({ invite: str(b.invite), name: str(b.name), allowInsecure: b.allowInsecure === true })
      res.json(await stateBody())
    } catch (e) {
      fail(res, e)
    }
  })

  router.post('/relay/invites', async (req, res) => {
    const b = body(req)
    try {
      const opts = {}
      if (b.uses !== undefined) opts.uses = b.uses
      if (b.expiresMinutes !== undefined) opts.expiresMinutes = b.expiresMinutes
      res.json(await link.createInvite(opts))
    } catch (e) {
      fail(res, e)
    }
  })

  // The id comes from the path; a caller without path parameters (the tests'
  // fake router) may put it in the body.
  router.delete('/relay/invites/:id', async (req, res) => {
    const id = str(req.params?.id) || str(body(req).id)
    try {
      if (!id) throw new Error('An invite id is needed.')
      await link.revokeInvite(id)
      res.json({ ok: true })
    } catch (e) {
      fail(res, e)
    }
  })

  router.post('/relay/remove', async (req, res) => {
    const name = str(body(req).machine)
    try {
      if (!membership.joined) throw new Error('This Perch is not in a relay group.')
      const target = link.machineByName(name)
      if (!target) throw new Error(`No machine named "${name}" in this group.`)
      await link.remove(target.id)
      res.json({ ok: true })
    } catch (e) {
      fail(res, e)
    }
  })

  router.post('/relay/rename', async (req, res) => {
    try {
      await link.rename(str(body(req).name))
      res.json(await stateBody())
    } catch (e) {
      fail(res, e)
    }
  })

  router.post('/relay/label', async (req, res) => {
    try {
      await link.setLabel(str(body(req).label))
      res.json(await stateBody())
    } catch (e) {
      fail(res, e)
    }
  })

  router.post('/relay/permission', async (req, res) => {
    try {
      await link.setInbound(body(req).inbound)
      res.json(await stateBody())
    } catch (e) {
      fail(res, e)
    }
  })

  router.post('/relay/leave', async (_req, res) => {
    try {
      res.json(await link.leave())
    } catch (e) {
      fail(res, e)
    }
  })

  router.get('/relay/activity', (_req, res) => {
    let rows = []
    try {
      // Calls and membership events each keep their own newest ACTIVITY_MAX.
      const q = (where) => sql.prepare(`SELECT * FROM relay_activity WHERE ${where} ORDER BY id DESC LIMIT ?`).all(ACTIVITY_MAX)
      rows = [...q('event IS NULL'), ...q('event IS NOT NULL')].sort((x, y) => y.id - x.id)
    } catch {
      // The table is created on first use; until then there is nothing to show.
    }
    res.json(rows.map((r) => ({ id: r.id, at: r.at, machine: r.machine, tool: r.tool, target: r.target, outcome: r.outcome, event: r.event, ...(r.count > 1 ? { count: r.count } : {}) })))
  })
}
