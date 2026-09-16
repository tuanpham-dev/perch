import { test, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { SessionStore, StoreError, sessionNameFromCwd, dedupeName } from '../src/daemon/session-store.ts';

type Stub = { id: string; name: string };
let n = 0;
const win = (name: string): Stub => ({ id: `w${n++}`, name });

function storeWith(windows: string[]): { store: SessionStore<Stub>; name: string } {
  const store = new SessionStore<Stub>();
  const s = store.createSession('dev', win(windows[0] ?? 'shell'), '/tmp/root');
  for (const w of windows.slice(1)) store.addWindow(s, win(w));
  return { store, name: s.name };
}

test('resolveTarget handles bare session, numeric index, and window name', () => {
  const { store } = storeWith(['shell', 'build', 'logs']);
  store.selectWindow('dev:1');
  assert.equal(store.resolveTarget('dev').window.name, 'build'); // bare = current
  assert.equal(store.resolveTarget('dev:2').window.name, 'logs');
  assert.equal(store.resolveTarget('dev:logs').index, 2);
  assert.throws(() => store.resolveTarget('dev:9'), (e: unknown) => (e as StoreError).code === 'NO_WINDOW');
  assert.throws(() => store.resolveTarget('nope:0'), (e: unknown) => (e as StoreError).code === 'NO_SESSION');
});

test('next and prev wrap around', () => {
  const { store } = storeWith(['a', 'b', 'c']);
  const s = store.getSession('dev');
  assert.equal(s.currentIndex, 2); // last added became current
  store.rotateWindow(s, 1);
  assert.equal(s.currentIndex, 0); // wrapped past the end
  store.rotateWindow(s, -1);
  assert.equal(s.currentIndex, 2); // wrapped backwards
});

test('killing a middle window recomputes indices and current', () => {
  const { store } = storeWith(['a', 'b', 'c']);
  const s = store.getSession('dev');
  store.selectWindow('dev:2');
  const r = store.removeWindow('dev:1');
  assert.equal(r.wasCurrent, false);
  assert.equal(s.windows.map((w) => w.name).join(','), 'a,c');
  assert.equal(s.currentIndex, 1); // "c" slid down from 2 to 1 and stays current
  assert.equal(store.resolveTarget('dev:1').window.name, 'c');
});

test('killing the current last window clamps current', () => {
  const { store } = storeWith(['a', 'b']);
  store.selectWindow('dev:1');
  const r = store.removeWindow('dev:1');
  assert.equal(r.wasCurrent, true);
  assert.equal(store.getSession('dev').currentIndex, 0);
});

test('killing the only window reports an empty session', () => {
  const { store } = storeWith(['a']);
  assert.equal(store.removeWindow('dev:0').sessionEmpty, true);
});

test('session auto-naming and collision handling', () => {
  const store = new SessionStore<Stub>();
  assert.equal(store.createSession(undefined, win('x'), '/tmp/root').name, 'session-1');
  assert.equal(store.createSession(undefined, win('x'), '/tmp/root').name, 'session-2');
  assert.throws(() => store.createSession('session-1', win('x'), '/tmp/root'), (e: unknown) => (e as StoreError).code === 'SESSION_EXISTS');
});

test('all-digit window names are rejected to keep index targets unambiguous', () => {
  const { store } = storeWith(['a']);
  assert.throws(() => store.renameWindow('dev:0', '42'), (e: unknown) => (e as StoreError).code === 'BAD_NAME');
});

test('window names allow spaces and brackets but not target syntax', () => {
  const { store } = storeWith(['a']);
  store.renameWindow('dev:0', 'dev [web]');
  assert.equal(store.resolveTarget('dev:dev [web]').index, 0);
  const bad = (e: unknown) => (e as StoreError).code === 'BAD_NAME';
  assert.throws(() => store.renameWindow('dev:0', 'a:b'), bad);
  assert.throws(() => store.renameWindow('dev:0', '@x'), bad);
  assert.throws(() => store.renameWindow('dev:0', 'tab\there'), bad);
});

test('defaultSession picks the sole session or demands a target', () => {
  const store = new SessionStore<Stub>();
  assert.throws(() => store.defaultSession(), (e: unknown) => (e as StoreError).code === 'NO_SESSION');
  store.createSession('one', win('x'), '/tmp/root');
  assert.equal(store.defaultSession().name, 'one');
  store.createSession('two', win('x'), '/tmp/root');
  assert.throws(() => store.defaultSession(), (e: unknown) => (e as StoreError).code === 'AMBIGUOUS_SESSION');
});

describe('sessionNameFromCwd', () => {
  it('names a session after the folder it runs in', () => {
    assert.equal(sessionNameFromCwd('/works/perch'), 'perch');
    assert.equal(sessionNameFromCwd('/home/me/src/my-api'), 'my-api');
  });

  it('ignores a trailing slash', () => {
    assert.equal(sessionNameFromCwd('/works/perch/'), 'perch');
  });

  it('replaces characters a session name cannot hold', () => {
    // Better a recognisable "my-project-v2-" than a rejected name.
    assert.equal(sessionNameFromCwd('/x/my project (v2)'), 'my-project-v2');
    assert.equal(sessionNameFromCwd('/x/a:b'), 'a-b');
  });

  it('trims leading and trailing punctuation', () => {
    assert.equal(sessionNameFromCwd('/x/.config'), 'config');
    assert.equal(sessionNameFromCwd('/x/--weird--'), 'weird');
  });

  it('caps a very long folder name', () => {
    const name = sessionNameFromCwd(`/x/${'a'.repeat(80)}`);
    assert.equal(name!.length, 32);
  });

  it('gives up rather than inventing a name', () => {
    // The caller falls back to session-N for each of these.
    for (const cwd of ['/', '', '.', '/x/...', '/x/---', undefined]) {
      assert.equal(sessionNameFromCwd(cwd), null, `expected null for ${JSON.stringify(cwd)}`);
    }
  });
});

describe('dedupeName', () => {
  it('leaves a free name alone', () => {
    assert.equal(dedupeName('perch', () => false), 'perch');
  });

  it('starts duplicates at 2, since there is no perch-1', () => {
    assert.equal(dedupeName('perch', (c) => c === 'perch'), 'perch-2');
  });

  it('keeps counting past a taken suffix', () => {
    const taken = new Set(['perch', 'perch-2', 'perch-3']);
    assert.equal(dedupeName('perch', (c) => taken.has(c)), 'perch-4');
  });
});

describe('resolveNewSessionName', () => {
  const store = () => new SessionStore<{ id: string; name: string }>();
  const win = (id: string) => ({ id, name: 'sh' });

  it('names an unnamed session after its folder', () => {
    assert.equal(store().resolveNewSessionName(undefined, '/works/perch'), 'perch');
  });

  it('dedupes against a session already using that folder name', () => {
    const s = store();
    s.createSession(undefined, win('a'), '/tmp/root');   // no cwd: session-1
    s.sessions.set('perch', { id: 'p', name: 'perch', windows: [win('b')], currentIndex: 0, createdAt: 0, rootCwd: '/works/perch' });
    assert.equal(s.resolveNewSessionName(undefined, '/works/perch'), 'perch-2');
  });

  it('falls back to session-N when the path yields nothing', () => {
    assert.equal(store().resolveNewSessionName(undefined, '/'), 'session-1');
    assert.equal(store().resolveNewSessionName(undefined, undefined), 'session-1');
  });

  it('never silently renames an explicitly requested name', () => {
    // A caller that asked for "build" and got "build-2" would go on to address
    // the wrong session.
    const s = store();
    s.sessions.set('build', { id: 'b', name: 'build', windows: [win('a')], currentIndex: 0, createdAt: 0, rootCwd: '/works/build' });
    assert.throws(() => s.resolveNewSessionName('build', '/works/perch'), /already exists/);
  });
});
