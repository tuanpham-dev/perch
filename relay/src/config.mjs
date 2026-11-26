// Relay settings, read from environment variables.
import { DEFAULT_LIMITS } from './wire.mjs'

export class ConfigError extends Error {}

function intFrom(env, name, fallback, { min = 1, max = 65535 * 65535 } = {}) {
  const raw = env[name]
  if (raw === undefined || raw === '') return fallback
  const n = Number(raw)
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new ConfigError(`${name} must be a whole number from ${min} to ${max}`)
  }
  return n
}

// Throws ConfigError with the message to print. main.mjs prints it and exits 1.
export function loadConfig(env = process.env) {
  const authMode = env.RELAY_AUTH_MODE || 'token'
  if (authMode === 'account' || authMode === 'both') {
    throw new ConfigError('accounts are not available in this version of the relay')
  }
  if (authMode !== 'token') {
    throw new ConfigError(`RELAY_AUTH_MODE must be "token" (got "${authMode}")`)
  }
  const trustedProxies = (env.RELAY_TRUSTED_PROXIES || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
  for (const entry of trustedProxies) {
    if (!isAddressOrRange(entry)) {
      throw new ConfigError(`RELAY_TRUSTED_PROXIES has an entry that is not an address or CIDR range: ${entry}`)
    }
  }
  return {
    host: env.RELAY_HOST || '0.0.0.0',
    port: intFrom(env, 'RELAY_PORT', 8787, { min: 0, max: 65535 }),
    adminPort: intFrom(env, 'RELAY_ADMIN_PORT', 8788, { min: 0, max: 65535 }),
    dataDir: env.RELAY_DATA_DIR || './data',
    adminSecret: env.RELAY_ADMIN_SECRET || '',
    authMode,
    trustedProxies,
    maxPreauthPerAddress: intFrom(env, 'RELAY_MAX_PREAUTH_PER_ADDRESS', 20, { min: 1 }),
    maxPendingPerInvite: intFrom(env, 'RELAY_MAX_PENDING_PER_INVITE', 5, { min: 1 }),
    limits: {
      frameBytes: intFrom(env, 'RELAY_MAX_FRAME_BYTES', DEFAULT_LIMITS.frameBytes, { min: 4096 }),
      framesPerMinute: intFrom(env, 'RELAY_FRAMES_PER_MINUTE', DEFAULT_LIMITS.framesPerMinute, { min: 1 }),
      machinesPerGroup: intFrom(env, 'RELAY_MAX_MACHINES', DEFAULT_LIMITS.machinesPerGroup, { min: 1 }),
      authFailsPerMinute: intFrom(env, 'RELAY_AUTH_FAILS_PER_MINUTE', DEFAULT_LIMITS.authFailsPerMinute, { min: 1 }),
    },
  }
}

function isAddressOrRange(entry) {
  const [addr, prefix, extra] = entry.split('/')
  if (extra !== undefined) return false
  const family = addr.includes(':') ? 6 : 4
  const parts = family === 4 ? addr.split('.') : null
  const okAddr =
    family === 4
      ? parts.length === 4 && parts.every((p) => /^\d{1,3}$/.test(p) && Number(p) <= 255)
      : /^[0-9a-fA-F:.]+$/.test(addr) && addr.includes(':')
  if (!okAddr) return false
  if (prefix === undefined) return true
  const max = family === 4 ? 32 : 128
  return /^\d{1,3}$/.test(prefix) && Number(prefix) <= max
}
