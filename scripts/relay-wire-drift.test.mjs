// The relay folder must run on its own, so it keeps a copy of the wire format
// that Perch imports from extensions/_shared. The two files must be identical.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

const read = (rel) => readFileSync(new URL(rel, import.meta.url))

test('relay/src/wire.mjs is byte-identical to extensions/_shared/relayWire.mjs', () => {
  const source = read('../extensions/_shared/relayWire.mjs')
  const copy = read('../relay/src/wire.mjs')
  assert.ok(
    source.equals(copy),
    'relay/src/wire.mjs differs from extensions/_shared/relayWire.mjs; copy the shared file over it',
  )
})
