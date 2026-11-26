#!/usr/bin/env node
// Perch relay entry point.
//   serve                              run the relay
//   groups                             list groups
//   machines <group>                   list a group's machines
//   remove-machine <group> <machine>   block a machine (no re-key)
//   delete-group <group>               delete a group and disconnect its members
// The admin subcommands talk to the loopback admin listener of a running relay,
// using $RELAY_ADMIN_SECRET and $RELAY_ADMIN_PORT (default 8788).
import { resolve } from 'node:path'
import { ConfigError, loadConfig } from './config.mjs'
import { startRelay } from './server.mjs'

const USAGE = `Usage: node src/main.mjs <command>

  serve                              Run the relay
  groups                             List groups
  machines <group>                   List the machines of a group
  remove-machine <group> <machine>   Block a machine (the group secret is not replaced)
  delete-group <group>               Delete a group and disconnect its machines

Settings come from environment variables; see README.md.`

function usage(code) {
  const out = code === 0 ? console.log : console.error
  out(USAGE)
  process.exit(code)
}

function table(rows, columns) {
  const cells = [columns.map(([title]) => title), ...rows.map((r) => columns.map(([, get]) => String(get(r) ?? '')))]
  const widths = columns.map((_, i) => Math.max(...cells.map((row) => row[i].length)))
  for (const row of cells) console.log(row.map((c, i) => c.padEnd(widths[i])).join('  ').trimEnd())
}

const when = (ms) => (ms ? new Date(ms).toISOString() : '')

async function serve() {
  let config
  try {
    config = loadConfig(process.env)
  } catch (err) {
    if (err instanceof ConfigError) {
      console.error(err.message)
      process.exit(1)
    }
    throw err
  }
  const stamp = () => new Date().toISOString()
  const relay = await startRelay({
    config,
    // Per-frame lines (send/recv) are left out; connection events are enough to operate the relay.
    log: (line) => {
      if (!line.startsWith('send ') && !line.startsWith('recv ')) console.log(`${stamp()} ${line}`)
    },
  })
  console.log(`Perch relay listening on ws://${config.host}:${relay.port}`)
  console.log(`Admin commands on http://127.0.0.1:${relay.adminPort} (this machine only)`)
  console.log(`Data folder: ${resolve(config.dataDir)}`)
  if (!config.adminSecret) {
    console.log('RELAY_ADMIN_SECRET is not set: groups cannot be created and admin commands are refused.')
  }
  let stopping = false
  const stop = async () => {
    if (stopping) return
    stopping = true
    await relay.close()
    process.exit(0)
  }
  process.on('SIGINT', stop)
  process.on('SIGTERM', stop)
}

async function admin(method, path) {
  const secret = process.env.RELAY_ADMIN_SECRET || ''
  const port = process.env.RELAY_ADMIN_PORT || '8788'
  if (!secret) {
    console.error('RELAY_ADMIN_SECRET is not set.')
    process.exit(1)
  }
  let res
  try {
    res = await fetch(`http://127.0.0.1:${port}${path}`, { method, headers: { 'x-relay-admin': secret } })
  } catch {
    console.error(`Could not reach the relay's admin listener on 127.0.0.1:${port}. Is it running on this machine?`)
    process.exit(1)
  }
  const body = await res.json().catch(() => ({}))
  if (!res.ok) {
    console.error(body.error || `The relay answered ${res.status}.`)
    process.exit(1)
  }
  return body
}

const [command, ...args] = process.argv.slice(2)
const need = (n) => {
  if (args.length !== n) usage(1)
}
const seg = encodeURIComponent

switch (command) {
  case 'serve':
    need(0)
    await serve()
    break
  case 'groups': {
    need(0)
    const groups = await admin('GET', '/groups')
    table(groups, [
      ['GROUP', (g) => g.id],
      ['EPOCH', (g) => g.epoch],
      ['MACHINES', (g) => g.machines],
      ['ONLINE', (g) => g.online],
      ['CREATED', (g) => when(g.createdAt)],
    ])
    break
  }
  case 'machines': {
    need(1)
    const machines = await admin('GET', `/groups/${seg(args[0])}/machines`)
    table(machines, [
      ['MACHINE', (m) => m.id],
      ['LABEL', (m) => m.label],
      ['STATUS', (m) => m.status],
      ['ONLINE', (m) => (m.online ? 'yes' : 'no')],
      ['LAST SEEN', (m) => when(m.lastSeen)],
    ])
    break
  }
  case 'remove-machine':
    need(2)
    await admin('DELETE', `/groups/${seg(args[0])}/machines/${seg(args[1])}`)
    console.log(`Blocked machine ${args[1]}. Its keys and the group secret are unchanged; remove it from a Perch in the group to replace the secret.`)
    break
  case 'delete-group':
    need(1)
    await admin('DELETE', `/groups/${seg(args[0])}`)
    console.log(`Deleted group ${args[0]}.`)
    break
  default:
    usage(1)
}
