// Sliding-window counters and client address resolution.
import { BlockList, isIP } from 'node:net'

// Counts events per key in the last `windowMs`.
export function createCounter(windowMs = 60000, now = Date.now) {
  const hits = new Map()
  const prune = (key) => {
    const list = hits.get(key)
    if (!list) return null
    const cutoff = now() - windowMs
    let i = 0
    while (i < list.length && list[i] <= cutoff) i++
    if (i) list.splice(0, i)
    if (!list.length) {
      hits.delete(key)
      return null
    }
    return list
  }
  return {
    // Records one event and returns how many are in the window, this one included.
    hit(key) {
      prune(key)
      let list = hits.get(key)
      if (!list) hits.set(key, (list = []))
      list.push(now())
      return list.length
    },
    count(key) {
      return prune(key)?.length ?? 0
    },
    reset(key) {
      hits.delete(key)
    },
    // Drops keys that have gone quiet, so the map cannot grow without bound.
    sweep() {
      for (const key of [...hits.keys()]) prune(key)
    },
  }
}

// Turns a list of addresses and CIDR ranges into a BlockList used as an allow list.
export function trustedList(entries) {
  if (!entries || !entries.length) return null
  const list = new BlockList()
  for (const entry of entries) {
    const [addr, prefix] = entry.split('/')
    const type = isIP(addr) === 6 ? 'ipv6' : 'ipv4'
    if (prefix === undefined) list.addAddress(addr, type)
    else list.addSubnet(addr, Number(prefix), type)
  }
  return list
}

function normalize(address) {
  if (!address) return ''
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address)
  return mapped ? mapped[1] : address
}

function isTrusted(address, trusted) {
  if (!trusted) return false
  const addr = normalize(address)
  const family = isIP(addr)
  if (!family) return false
  return trusted.check(addr, family === 6 ? 'ipv6' : 'ipv4')
}

// The address to count limits against. The forwarding header is believed only
// when the connection itself comes from a trusted proxy, and then the right-most
// entry that is not itself a trusted proxy wins (entries further left are
// whatever the client claimed).
export function clientAddress(req, trusted) {
  const socketAddress = normalize(req.socket?.remoteAddress)
  if (!isTrusted(socketAddress, trusted)) return socketAddress
  const header = req.headers?.['x-forwarded-for']
  const raw = Array.isArray(header) ? header.join(',') : header
  const entries = (raw || '')
    .split(',')
    .map((s) => normalize(s.trim()))
    .filter(Boolean)
  for (let i = entries.length - 1; i >= 0; i--) {
    if (!isTrusted(entries[i], trusted)) return entries[i]
  }
  return entries[0] || socketAddress
}
