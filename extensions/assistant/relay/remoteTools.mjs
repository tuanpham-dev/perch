// Tools across machines: the outbound call (callRemote, list_machines,
// reply_to_agent), the inbound dispatcher (allowlist, permission, activity)
// and delivery of text from another machine into a local agent window.
// Plain ESM. server.js hands in everything that touches the host.

import { cleanRemoteText, senderLabel, typedBlock, validSenderWindow } from './framing.mjs'
import { noticeFor } from './routes.mjs'

export const ACTIVITY_KEEP = 200
const EMIT_MIN_MS = 1000
const CALL_MS = 30000
const WAIT_DEFAULT_S = 120
const WAIT_MAX_S = 600
const MAX_SENDERS = 200
const FIELD_MAX = 200

export const NOT_IN_GROUP = 'This Perch is not in a relay group. Join one in Settings → Assistant → Relay or with: perch relay join'
export const ALREADY_CONNECTED =
  'This machine is already connected to the relay from another Perch instance that shares its configuration folder.'
const TOO_LONG = 'Text from another machine is limited to 32,000 characters.'
const NO_SENDER = 'No agent on another machine has messaged this window. Give reply_to_agent a "to" address (machine/project:index).'

// Tools another machine may call; nothing else is run for it.
export const INBOUND_TOOLS = Object.freeze([
  'list_projects',
  'agent_status',
  'agent_conversation',
  'read_terminal',
  'wait_for_agent',
  'send_to_agent',
  'reply_to_agent',
])
const INBOUND_WRITES = new Set(['send_to_agent', 'reply_to_agent'])

const ACCEPTS_TEXT = { off: 'off', read: 'read-only', send: 'read and send', unknown: 'unknown' }

const textResult = (text, isError = false) => ({ content: [{ type: 'text', text }], isError })
const clampSeconds = (v) => {
  const n = Number(v)
  return Number.isFinite(n) ? Math.min(Math.max(Math.trunc(n), 1), WAIT_MAX_S) : WAIT_DEFAULT_S
}

// options:
//   link, membership        the relay link and its persisted state
//   readOnly()              true while Assistant Read-only is on (may be async)
//   readOnlyStrict()        the same, but throws when the setting cannot be read;
//                           inbound writes are refused then (defaults to readOnly)
//   runLocalTool(name, args, call)  -> { content, isError }
//   callerTerminal(windowId) -> { session, index } | null
//   resolveWindow(ref)      -> { session, window, agent } (throws ToolError)
//   sendText(windowId, typed, submit)  types into a window
//   markSent(windowId)      remembers that something was just typed there
//   sql                     storage.sql, for the activity table
//   ToolError               the class server.js turns into a tool error
//   log(text), emit(name, data), now()
export function createRemoteTools({
  link,
  membership,
  readOnly = async () => false,
  readOnlyStrict = null,
  runLocalTool,
  callerTerminal,
  resolveWindow,
  sendText,
  markSent,
  sql,
  ToolError,
  log = () => {},
  emit = () => {},
  now = () => Date.now(),
}) {
  // window id -> { machineId, window } of the last text received there
  const lastSender = new Map()
  // In-flight inbound calls: { tool, abort(), respond(result) }
  const inflight = new Set()

  const machines = () => link.snapshot().machines
  const ownName = () => membership.state?.name ?? ''
  // This machine as others write it: the directory's display name (name~xxxx
  // when the name is shared), or the plain name before the first directory.
  const ownAddress = () => machines().find((m) => m.self)?.display || ownName()
  const isRo = async () => {
    try {
      return (await readOnly()) === true
    } catch {
      return false
    }
  }
  // For inbound writes: a setting that cannot be read counts as Read-only.
  const isRoClosed = async () => {
    try {
      return ((await (readOnlyStrict ?? readOnly)()) === true)
    } catch {
      return true
    }
  }
  const displayOf = (id) => machines().find((m) => m.id === id)?.display ?? '?' + String(id).slice(0, 8)

  function isSelf(name) {
    return membership.joined && typeof name === 'string' && name !== '' && name === ownAddress()
  }

  // ---- activity ----

  let tableReady = false
  function ensureTable() {
    if (tableReady || !sql) return
    sql.exec(
      'CREATE TABLE IF NOT EXISTS relay_activity (id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, machine TEXT NOT NULL, tool TEXT, target TEXT, outcome TEXT, event TEXT, count INTEGER NOT NULL DEFAULT 1)',
    )
    try {
      // A table made before rows were collapsed has no count.
      sql.exec('ALTER TABLE relay_activity ADD COLUMN count INTEGER NOT NULL DEFAULT 1')
    } catch {}
    tableReady = true
  }

  // The relay state event for activity goes out at most once a second; a
  // change inside that second is announced when it ends.
  let lastEmit = -Infinity
  let emitTimer = null
  function emitActivity(immediate) {
    const wait = lastEmit + EMIT_MIN_MS - now()
    if (immediate || wait <= 0) {
      clearTimeout(emitTimer)
      emitTimer = null
      lastEmit = now()
      emit('relay', { kind: 'state' })
    } else if (!emitTimer) {
      emitTimer = setTimeout(() => {
        emitTimer = null
        lastEmit = now()
        emit('relay', { kind: 'state' })
      }, wait)
      emitTimer.unref?.()
    }
  }

  // Never given message text or a result: only who, what and the verdict.
  // Calls and membership events each keep their newest 200 rows. A call that
  // repeats the row just before it adds to that row's count instead.
  // Returns an id for retract(), or null.
  function record({ machine, tool = null, target = null, outcome = null, event = null }) {
    if (!sql) return null
    let id = null
    try {
      ensureTable()
      machine = String(machine ?? '')
      const last = sql.prepare('SELECT * FROM relay_activity ORDER BY id DESC LIMIT 1').get()
      if (!event && last && !last.event && last.machine === machine && last.tool === tool && last.target === target && last.outcome === outcome) {
        sql.prepare('UPDATE relay_activity SET count = count + 1, at = ? WHERE id = ?').run(now(), last.id)
        id = last.id
      } else {
        sql
          .prepare('INSERT INTO relay_activity (at, machine, tool, target, outcome, event) VALUES (?, ?, ?, ?, ?, ?)')
          .run(now(), machine, tool, target, outcome, event)
        id = sql.prepare('SELECT id FROM relay_activity ORDER BY id DESC LIMIT 1').get()?.id ?? null
        const kind = event ? 'event IS NOT NULL' : 'event IS NULL'
        sql
          .prepare(`DELETE FROM relay_activity WHERE ${kind} AND id NOT IN (SELECT id FROM relay_activity WHERE ${kind} ORDER BY id DESC LIMIT ?)`)
          .run(ACTIVITY_KEEP)
      }
    } catch (e) {
      log(`activity not recorded: ${e?.message ?? e}`)
      return null
    }
    emitActivity(Boolean(event))
    return id
  }

  // Takes back one counted call (an "allowed" that was refused after all).
  function retract(id) {
    if (!sql || id == null) return
    try {
      const row = sql.prepare('SELECT count FROM relay_activity WHERE id = ?').get(id)
      if (!row) return
      if (row.count > 1) sql.prepare('UPDATE relay_activity SET count = count - 1 WHERE id = ?').run(id)
      else sql.prepare('DELETE FROM relay_activity WHERE id = ?').run(id)
    } catch (e) {
      log(`activity not updated: ${e?.message ?? e}`)
    }
  }

  // The Activity row names the machine in its own column, so the text leaves
  // the name out ("joined, admitted by laptop").
  function activityText(e) {
    const who = (v) => v || 'a machine'
    switch (e.kind) {
      case 'joined':
        return { machine: e.name || '', text: `joined, admitted by ${who(e.by)}` }
      case 'left':
        return { machine: e.by || '', text: 'left the group' }
      case 'removed':
        return { machine: e.name || '', text: `removed by ${who(e.by)}` }
      case 'invite-created':
        return { machine: e.by || '', text: 'created an invite' }
      case 'invite-revoked':
        return { machine: e.by || '', text: 'revoked an invite' }
      case 'renamed': {
        const to = e.to || e.name || ''
        // This machine's own rename carries the old name in `by`; a peer's carries it in `name`.
        const was = e.name && e.name !== e.to ? e.name : e.by
        return { machine: to, text: `renamed from ${who(was)} to ${who(to)}` }
      }
      default:
        return null
    }
  }

  function recordEvent(e) {
    const row = activityText(e)
    if (row) return record({ machine: row.machine, event: row.text })
    const title = noticeFor(e)?.title
    if (!title) return
    record({ machine: e.name || e.by || '', event: title })
  }

  function clearActivity() {
    if (!sql) return
    try {
      ensureTable()
      sql.exec('DELETE FROM relay_activity')
    } catch (e) {
      log(`activity not cleared: ${e?.message ?? e}`)
    }
  }

  // ---- outbound ----

  function notInGroup() {
    return new ToolError(NOT_IN_GROUP)
  }

  function mapLinkError(e, name, startedAt = null) {
    if (e instanceof ToolError) return e
    const display = e?.machine ? displayOf(e.machine) : name
    switch (e?.code) {
      case 'not-in-group':
        return notInGroup()
      case 'not-connected':
        return new ToolError(link.reasonCode === 'already-connected' ? ALREADY_CONNECTED : e.message)
      case 'offline': {
        // The error may carry no time: then the directory's, else when the call began (it was live then).
        const row = machines().find((m) => m.id === e.machine)
        const at = [e.lastSeen, row?.lastSeen, startedAt, now()].find((v) => Number.isFinite(v))
        return new ToolError(`${display} is offline (last seen ${new Date(at).toISOString()}).`)
      }
      case 'unverified':
        return new ToolError(`${display} is not verified, so Perch will not talk to it. Remove it and invite it again.`)
      case 'no-answer':
        return new ToolError(
          Number.isFinite(e.seconds) ? `${display} did not answer within ${e.seconds} seconds.` : `${display} did not answer within ${CALL_MS / 1000} seconds.`,
        )
      case 'too-large':
        return new ToolError(
          e.direction === 'out'
            ? `The request to ${display} is larger than 8 MB.`
            : `The result from ${display} is larger than 8 MB. Ask for fewer messages or less scrollback.`,
        )
      case 'version':
        return new ToolError(
          e.older === 'peer'
            ? `${display} runs a Perch that is too old to talk to this one. Update ${display}.`
            : `${display} runs a Perch that is too new to talk to this one. Update this machine.`,
        )
      default:
        return new ToolError(e?.message || 'The call to the other machine failed.')
    }
  }

  async function repliesNote() {
    const inbound = membership.state?.inbound
    const ro = await isRo()
    if (inbound === 'send' && !ro) return ''
    const label = inbound === 'off' ? 'Off' : 'Read-only'
    return ` Replies from that agent will be refused here: this machine's "Others may" setting is ${label}.`
  }

  async function senderWindowOf(call) {
    if (!call?.callerWindow) return null
    const t = await callerTerminal(call.callerWindow)
    return t ? `${t.session}:${t.index}` : null
  }

  // Calls `tool` on another machine and returns its { content, isError }.
  // Anything that stops the call from being answered is thrown as a ToolError
  // with the Messages text.
  async function remoteCall(machineName, tool, args, call) {
    if (!membership.joined) throw notInGroup()
    // A second instance on the same configuration never gets a directory, so say why before looking for the name.
    if (!link.connected && link.reasonCode === 'already-connected') throw new ToolError(ALREADY_CONNECTED)
    const list = machines()
    const target = list.find((m) => m.display === machineName)
    if (!target || target.self) {
      throw new ToolError(`No machine named "${machineName}" in this group. Machines: ${list.map((m) => m.display).join(', ')}.`)
    }
    let timeoutMs = CALL_MS
    if (tool === 'wait_for_agent') timeoutMs = (clampSeconds(args.timeoutSeconds) + 30) * 1000
    const startedAt = now()
    let result
    try {
      const senderWindow = await senderWindowOf(call)
      result = await link.call(target.id, tool, args, { senderWindow, timeoutMs })
    } catch (e) {
      throw mapLinkError(e, machineName, startedAt)
    }
    // Only text items a client can show get through.
    const content = (Array.isArray(result?.content) ? result.content : [])
      .filter((c) => c && typeof c === 'object' && c.type === 'text' && typeof c.text === 'string')
      .map((c) => ({ type: 'text', text: c.text }))
    if (!content.length) throw new ToolError(`${target.display} sent a result Perch cannot show.`)
    return { content, isError: result.isError === true }
  }

  async function callRemote(machineName, tool, args = {}, call = {}) {
    const result = await remoteCall(machineName, tool, args, call)
    if (tool === 'send_to_agent' && !result.isError) {
      const note = await repliesNote()
      if (note) {
        const content = [...result.content]
        const i = content.map((c) => c?.type).lastIndexOf('text')
        if (i >= 0) content[i] = { ...content[i], text: `${content[i].text}${note}` }
        else content.push({ type: 'text', text: note.trim() })
        return { ...result, content }
      }
    }
    return result
  }

  // list_machines. Not being in a group is an answer, not an error.
  function listMachines() {
    if (!membership.joined) return NOT_IN_GROUP
    if (!link.connected && link.reasonCode === 'already-connected') throw new ToolError(ALREADY_CONNECTED)
    return machines()
      .sort((a, b) => Number(b.self) - Number(a.self) || a.display.localeCompare(b.display))
      .map((m) => ({
        name: m.display,
        thisMachine: m.self,
        online: m.online,
        lastSeen: Number.isFinite(m.lastSeen) ? new Date(m.lastSeen).toISOString() : null,
        verified: m.trust === 'verified',
        accepts: ACCEPTS_TEXT[m.accepts] ?? 'unknown',
      }))
  }

  // ---- delivery of text from another machine ----

  // Thrown when a send stopped being allowed while it was being set up.
  class Refused extends Error {}

  // `signal` is given for text from another machine: just before typing, the
  // call must still be live and this machine must still accept sends.
  async function deliverRemoteText({ target, text, submit = true, peer, senderWindow = null, signal = null }) {
    let clean
    try {
      clean = cleanRemoteText(text)
    } catch (e) {
      if (e?.code === 'too-long') throw new ToolError(TOO_LONG)
      throw e
    }
    const { session, window, agent } = await resolveWindow(String(target ?? ''))
    if (!agent) {
      throw new ToolError(
        `No AI agent is running in ${session.name}:${window.index} on ${ownAddress()}. Messages from other machines only go to agent windows.`,
      )
    }
    const label = senderLabel(peer.name, senderWindow)
    const typed = typedBlock(`${label}\n${clean}`, agent.program)
    if (signal) {
      const ro = await isRoClosed()
      if (signal.aborted || membership.state?.inbound !== 'send' || ro) throw new Refused()
    }
    await sendText(window.id, typed, submit !== false)
    if (submit !== false) markSent(window.id)
    lastSender.delete(window.id)
    lastSender.set(window.id, { machineId: peer.id, window: validSenderWindow(senderWindow) ? senderWindow : null })
    if (lastSender.size > MAX_SENDERS) lastSender.delete(lastSender.keys().next().value)
    return `Typed into ${session.name}:${window.index} (${window.name})${submit !== false ? ' and pressed Enter' : ''}.`
  }

  // reply_to_agent
  async function replyToAgent(args, call) {
    const text = String(args.text ?? '')
    if (!text) throw new ToolError('Give the text to send.')
    if (!membership.joined) throw notInGroup()
    let machineName
    let target
    if (args.to !== undefined && args.to !== null && args.to !== '') {
      const to = String(args.to)
      const slash = to.indexOf('/')
      if (slash <= 0 || slash === to.length - 1) throw new ToolError('Give "to" as machine/project:index.')
      machineName = to.slice(0, slash)
      target = to.slice(slash + 1)
    } else {
      const entry = call?.callerWindow ? lastSender.get(call.callerWindow) : null
      if (!entry || !entry.window) throw new ToolError(NO_SENDER)
      const m = machines().find((x) => x.id === entry.machineId)
      if (!m) throw new ToolError(NO_SENDER)
      machineName = m.display
      target = entry.window
    }
    const self = isSelf(machineName)
    if (self) {
      await deliverRemoteText({
        target,
        text,
        submit: true,
        peer: { id: membership.identity.machineId, name: ownAddress() },
        senderWindow: await senderWindowOf(call),
      })
    } else {
      const result = await remoteCall(machineName, 'reply_to_agent', { target, text }, call)
      if (result.isError) throw new ToolError(result.content?.map((c) => c?.text ?? '').join('\n') || 'The other machine refused that.')
    }
    return `Sent to ${machineName}/${target}.${self ? '' : await repliesNote()}`
  }

  // ---- inbound ----

  // setting: 'off' | 'read-only' (the machine's inbound setting) | 'assistant-read-only' (Assistant Read-only is on).
  const refusedText = (tool, setting) =>
    `${ownAddress()} does not accept ${tool} from other machines (${setting === 'assistant-read-only' ? 'its Assistant is set to Read-only' : `its setting is ${setting}`}).`

  async function onCall(peer, msg, respond, signal) {
    const tool = String(msg.tool)
    const args = { ...(msg.args ?? {}) }
    delete args.machine
    const pick = (v) => (typeof v === 'string' ? v.slice(0, FIELD_MAX) : null)
    const target = pick(args.target) ?? pick(args.project) ?? 'all'
    const log_ = (outcome) => record({ machine: peer.name, tool: tool.slice(0, FIELD_MAX), target, outcome })

    if (!INBOUND_TOOLS.includes(tool)) {
      log_('refused')
      return respond(textResult(`${tool} cannot be called from another machine.`, true))
    }
    const inbound = membership.state?.inbound
    if (inbound !== 'send' && inbound !== 'read') {
      log_('refused')
      return respond(textResult(refusedText(tool, 'off'), true))
    }
    if (INBOUND_WRITES.has(tool) && (inbound !== 'send' || (await isRoClosed()))) {
      log_('refused')
      return respond(textResult(refusedText(tool, inbound === 'send' ? 'assistant-read-only' : 'read-only'), true))
    }
    const rowId = log_('allowed')

    const ac = new AbortController()
    const entry = {
      tool,
      abort: () => ac.abort(),
      respond,
    }
    inflight.add(entry)
    const onAbort = () => ac.abort()
    signal?.addEventListener?.('abort', onAbort, { once: true })
    try {
      if (INBOUND_WRITES.has(tool)) {
        const out = await deliverRemoteText({
          target: args.target,
          text: args.text,
          submit: tool === 'reply_to_agent' ? true : args.submit,
          peer,
          senderWindow: msg.senderWindow,
          signal: ac.signal,
        })
        respond(textResult(out))
      } else {
        respond(await runLocalTool(tool, args, { callerWindow: null, signal: ac.signal }))
      }
    } catch (e) {
      if (e instanceof Refused) {
        retract(rowId)
        log_('refused')
        return respond(textResult(refusedText(tool, membership.state?.inbound === 'send' ? 'assistant-read-only' : 'off'), true))
      }
      if (!(e instanceof ToolError)) log(`inbound ${tool} failed: ${e?.message ?? e}`)
      respond(textResult(e instanceof ToolError ? e.message : 'The call failed on the other machine.', true))
    } finally {
      inflight.delete(entry)
      signal?.removeEventListener?.('abort', onAbort)
    }
  }

  // The inbound setting changed. Off ends calls already waiting.
  function onInbound(value) {
    if (value !== 'off') return
    for (const entry of [...inflight]) {
      entry.respond(textResult(refusedText(entry.tool, 'off'), true))
      entry.abort()
    }
  }

  return {
    isSelf,
    callRemote,
    listMachines,
    replyToAgent,
    deliverRemoteText,
    onCall,
    onInbound,
    recordEvent,
    clearActivity,
  }
}
