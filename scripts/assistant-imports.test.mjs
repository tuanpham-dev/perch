// The desktop app stages extensions/assistant without its src/, test/ and
// node_modules folders and without *.test.mjs files, plus the plain .mjs/.js
// files of extensions/_shared (desktop/scripts/stage-server.mjs). Every file
// server.js imports, directly or through other imports, must survive that.
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const repo = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const assistant = path.join(repo, 'extensions', 'assistant')
const shared = path.join(repo, 'extensions', '_shared')

// Static `import ... from 'x'`, `export ... from 'x'` and bare `import 'x'`.
const SPECIFIER = /(?:^|[\n;])\s*(?:import|export)\s+(?:[^'"()]*?\s+from\s+)?(['"])([^'"]+)\1/g
// Dynamic `import('x')` with a string literal.
const DYNAMIC = /\bimport\s*\(\s*(['"`])([^'"`]+)\1\s*\)/g

export function specifiersOf(source) {
  const found = []
  for (const m of source.matchAll(SPECIFIER)) found.push(m[2])
  for (const m of source.matchAll(DYNAMIC)) found.push(m[2])
  return found
}

// The staged tree has no node_modules, so only relative paths and `node:`
// built-ins can resolve there. Anything else is a problem.
export function bareProblem(spec) {
  if (spec.startsWith('.') || spec.startsWith('node:')) return null
  return `imports '${spec}', which is not a relative path or node: built-in`
}

function relativeSpecifiers(source) {
  return specifiersOf(source).filter((spec) => spec.startsWith('.'))
}

export function importedFiles(entry) {
  const seen = new Set()
  const queue = [entry]
  while (queue.length) {
    const file = queue.pop()
    if (seen.has(file)) continue
    seen.add(file)
    for (const spec of relativeSpecifiers(readFileSync(file, 'utf8'))) {
      queue.push(path.resolve(path.dirname(file), spec))
    }
  }
  return [...seen]
}

export function stagedProblem(file) {
  const inShared = path.dirname(file) === shared && /\.m?js$/.test(file)
  const rel = path.relative(assistant, file)
  const inAssistant = !rel.startsWith('..') && !path.isAbsolute(rel)
  if (/\.test\.m?js$/.test(file)) return 'is a test file'
  if (inShared) return null
  if (!inAssistant) return 'is outside extensions/assistant and is not extensions/_shared/<name>.mjs'
  const bad = rel.split(path.sep).find((s) => ['src', 'test', 'node_modules'].includes(s))
  return bad ? `has a path segment named ${bad}, which staging leaves out` : null
}

test('every file server.js imports is carried into the staged tree', () => {
  const files = importedFiles(path.join(assistant, 'server.js'))
  assert.ok(files.length > 5, 'the walk should reach the relay modules')
  for (const file of files) {
    assert.ok(existsSync(file), `${path.relative(repo, file)} is imported but missing`)
    const problem = stagedProblem(file)
    assert.equal(problem, null, `${path.relative(repo, file)} ${problem}`)
    for (const spec of specifiersOf(readFileSync(file, 'utf8'))) {
      assert.equal(bareProblem(spec), null, `${path.relative(repo, file)} ${bareProblem(spec)}`)
    }
  }
})

test('bare and dynamic imports are seen', () => {
  assert.match(bareProblem('ws'), /ws/)
  assert.match(bareProblem('fs'), /not a relative/)
  assert.equal(bareProblem('node:fs'), null)
  assert.equal(bareProblem('./a.mjs'), null)
  assert.deepEqual(specifiersOf("import 'ws'\n"), ['ws'])
  assert.deepEqual(specifiersOf("const m = await import('./src/notice.tsx')"), ['./src/notice.tsx'])
  assert.deepEqual(specifiersOf("import { a } from 'node:fs'\nexport * from './b.mjs'"), ['node:fs', './b.mjs'])
})

test('the staging rules reject src, test, node_modules and stray files', () => {
  assert.match(stagedProblem(path.join(assistant, 'src', 'x.mjs')), /src/)
  assert.match(stagedProblem(path.join(assistant, 'relay', 'test', 'x.mjs')), /test/)
  assert.match(stagedProblem(path.join(assistant, 'node_modules', 'x.mjs')), /node_modules/)
  assert.match(stagedProblem(path.join(assistant, 'relay', 'a.test.mjs')), /test file/)
  assert.match(stagedProblem(path.join(shared, 'Icon.tsx')), /outside/)
  assert.match(stagedProblem(path.join(shared, 'sub', 'x.mjs')), /outside/)
  assert.equal(stagedProblem(path.join(shared, 'relayWire.mjs')), null)
  assert.equal(stagedProblem(path.join(assistant, 'relay', 'link.mjs')), null)
})
