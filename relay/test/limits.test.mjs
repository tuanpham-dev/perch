import assert from 'node:assert/strict'
import { test } from 'node:test'
import { ConfigError, loadConfig } from '../src/config.mjs'
import { clientAddress, createCounter, trustedList } from '../src/limits.mjs'

test('counter counts within a sliding minute', () => {
  let t = 0
  const c = createCounter(60000, () => t)
  assert.equal(c.hit('a'), 1)
  t = 30000
  assert.equal(c.hit('a'), 2)
  assert.equal(c.hit('b'), 1)
  assert.equal(c.count('a'), 2)
  t = 60000
  assert.equal(c.count('a'), 1, 'the first hit left the window')
  t = 90000
  assert.equal(c.count('a'), 0)
  assert.equal(c.hit('a'), 1)
  c.reset('a')
  assert.equal(c.count('a'), 0)
  c.sweep()
  assert.equal(c.count('b'), 0)
})

const req = (remote, xff) => ({ socket: { remoteAddress: remote }, headers: xff === undefined ? {} : { 'x-forwarded-for': xff } })

test('clientAddress ignores the forwarding header unless the socket is a trusted proxy', () => {
  const trusted = trustedList(['10.0.0.0/8'])
  assert.equal(clientAddress(req('203.0.113.9', '1.2.3.4'), trusted), '203.0.113.9')
  assert.equal(clientAddress(req('203.0.113.9', '1.2.3.4'), null), '203.0.113.9')
  assert.equal(clientAddress(req('10.1.2.3', '1.2.3.4'), trusted), '1.2.3.4')
})

test('clientAddress takes the right-most entry that is not a trusted proxy', () => {
  const trusted = trustedList(['10.0.0.0/8', '192.168.1.5'])
  assert.equal(clientAddress(req('10.0.0.1', '6.6.6.6, 1.2.3.4, 10.0.0.7'), trusted), '1.2.3.4')
  assert.equal(clientAddress(req('10.0.0.1', '1.2.3.4, 192.168.1.5, 10.0.0.7'), trusted), '1.2.3.4')
  assert.equal(clientAddress(req('10.0.0.1', '10.0.0.7'), trusted), '10.0.0.7')
  assert.equal(clientAddress(req('10.0.0.1'), trusted), '10.0.0.1')
})

test('clientAddress handles IPv4-mapped IPv6 sockets and IPv6 ranges', () => {
  const trusted = trustedList(['127.0.0.1', 'fd00::/8'])
  assert.equal(clientAddress(req('::ffff:127.0.0.1', '1.2.3.4'), trusted), '1.2.3.4')
  assert.equal(clientAddress(req('fd00::2', '2001:db8::1'), trusted), '2001:db8::1')
  assert.equal(clientAddress(req('::ffff:8.8.8.8', '1.2.3.4'), trusted), '8.8.8.8')
})

test('config defaults', () => {
  const c = loadConfig({})
  assert.deepEqual(
    [c.host, c.port, c.adminPort, c.dataDir, c.adminSecret, c.authMode],
    ['0.0.0.0', 8787, 8788, './data', '', 'token'],
  )
  assert.deepEqual(c.limits, { frameBytes: 262144, framesPerMinute: 600, machinesPerGroup: 50, authFailsPerMinute: 5 })
  assert.deepEqual(c.trustedProxies, [])
})

test('config reads every variable', () => {
  const c = loadConfig({
    RELAY_HOST: '127.0.0.1',
    RELAY_PORT: '9000',
    RELAY_ADMIN_PORT: '9001',
    RELAY_DATA_DIR: '/x',
    RELAY_ADMIN_SECRET: 's',
    RELAY_TRUSTED_PROXIES: '10.0.0.0/8, 127.0.0.1',
    RELAY_MAX_FRAME_BYTES: '65536',
    RELAY_FRAMES_PER_MINUTE: '100',
    RELAY_MAX_MACHINES: '3',
    RELAY_AUTH_FAILS_PER_MINUTE: '2',
  })
  assert.equal(c.port, 9000)
  assert.equal(c.adminPort, 9001)
  assert.deepEqual(c.trustedProxies, ['10.0.0.0/8', '127.0.0.1'])
  assert.deepEqual(c.limits, { frameBytes: 65536, framesPerMinute: 100, machinesPerGroup: 3, authFailsPerMinute: 2 })
})

test('config refuses account and both modes, other modes and bad numbers', () => {
  for (const mode of ['account', 'both']) {
    assert.throws(() => loadConfig({ RELAY_AUTH_MODE: mode }), new ConfigError('accounts are not available in this version of the relay'))
  }
  assert.throws(() => loadConfig({ RELAY_AUTH_MODE: 'nope' }), /must be "token"/)
  assert.throws(() => loadConfig({ RELAY_PORT: 'abc' }), /RELAY_PORT/)
  assert.throws(() => loadConfig({ RELAY_MAX_MACHINES: '0' }), /RELAY_MAX_MACHINES/)
  assert.throws(() => loadConfig({ RELAY_TRUSTED_PROXIES: 'not-an-ip' }), /RELAY_TRUSTED_PROXIES/)
  assert.throws(() => loadConfig({ RELAY_TRUSTED_PROXIES: '10.0.0.0/40' }), /RELAY_TRUSTED_PROXIES/)
  assert.equal(loadConfig({ RELAY_AUTH_MODE: 'token' }).authMode, 'token')
})
