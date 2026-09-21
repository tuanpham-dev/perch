import { test } from 'node:test';
import assert from 'node:assert/strict';
import { needsCommandLine, processLabel, withoutThreadName } from '../src/util/process-label.ts';

test('a program already named after itself is left alone', () => {
  assert.equal(processLabel(['/usr/local/bin/cloudflared', 'tunnel', 'run'], '/home/me'), 'cloudflared');
});

test('a dependency CLI is named after its bin entry, not the runtime', () => {
  // ss, lsof and /proc's comm all report "node-MainThread" for this, Node
  // having renamed its own main thread.
  assert.equal(processLabel(['node', '/works/app/node_modules/.bin/vite'], '/works/app/client'), 'vite');
});

test('flags that take their value as the next argument are skipped', () => {
  const argv = [
    '/home/me/.nvm/versions/node/v26.3.1/bin/node',
    '--require', '/works/app/node_modules/tsx/dist/preflight.cjs',
    '--import', 'file:///works/app/node_modules/tsx/dist/loader.mjs',
    'scripts/worker.ts',
  ];
  assert.equal(processLabel(argv, '/works/app'), 'worker.ts');
});

test('a script named by position falls back to the working directory', () => {
  assert.equal(processLabel(['node', '--enable-source-maps', 'src/index.ts'], '/works/perch/server'), 'perch/server');
});

test("a package's own entry file is named after the package", () => {
  const argv = ['node', 'node_modules/.pnpm/@react-router+serve@7.18.2/node_modules/@react-router/serve/bin.js'];
  assert.equal(processLabel(argv, '/works/shop'), '@react-router/serve');
});

test('a module run with -m is named after the module', () => {
  assert.equal(processLabel(['python3', '-m', 'http.server'], '/works/notes'), 'http.server');
});

test('an empty command line has nothing to say', () => {
  assert.equal(processLabel([], '/works/app'), null);
});

test('the working directory is only read when the argv cannot name the process', () => {
  let reads = 0;
  const cwd = (): string => { reads++; return '/works/notes'; };
  assert.equal(processLabel(['node', '/works/app/node_modules/.bin/vite'], cwd), 'vite');
  assert.equal(reads, 0, 'a named script should not cost a working-directory lookup');
  assert.equal(processLabel(['node', 'src/index.ts'], cwd), 'notes');
  assert.equal(reads, 1);
});

test('a name that answers nothing sends the caller to the command line', () => {
  assert.ok(needsCommandLine('node-MainThread'));
  assert.ok(needsCommandLine('MainThread'));
  assert.ok(needsCommandLine('node'));
  assert.ok(needsCommandLine('python3'));
  // comm's 15-character cut, which must never be parsed as the answer.
  assert.ok(needsCommandLine('npm exec chrome'));
  assert.ok(needsCommandLine('npm run dev'));
  assert.ok(!needsCommandLine('npm install'), 'npm doing its own work is named after itself');
  assert.ok(!needsCommandLine('vite'));
  assert.ok(!needsCommandLine('zsh'));
  assert.equal(withoutThreadName('node-MainThread'), 'node');
  assert.equal(withoutThreadName('MainThread'), 'MainThread');
});

test('a package runner is named after what it runs, not after itself', () => {
  // What npm actually leaves in /proc: one argv entry, spaces and all.
  assert.equal(processLabel(['npm exec vite --port 5599'], '/works/perch/client'), 'vite');
  assert.equal(processLabel(['npm run dev'], '/works/perch'), 'dev');
  assert.equal(processLabel(['npm exec chrome-devtools-mcp@latest --headless=true'], '/works/app'), 'chrome-devtools-mcp');
  // The plain argv, before npm rewrites its own title.
  assert.equal(processLabel(['/usr/bin/npm', 'run', 'build'], '/works/app'), 'build');
  assert.equal(processLabel(['npx', 'vite'], '/works/app'), 'vite');
});

test('a runner argument keeps its scope but loses its path and version', () => {
  assert.equal(processLabel(['npm exec @react-router/serve@7.18.2'], '/works/shop'), '@react-router/serve');
  assert.equal(processLabel(['npm exec ./tools/seed.js'], '/works/shop'), 'seed.js');
  // Flags, and run-script's remainder, are skipped to reach the real word.
  assert.equal(processLabel(['npm exec -- vite'], '/works/shop'), 'vite');
  assert.equal(processLabel(['npm run-script build'], '/works/shop'), 'build');
});

test('a runner pointed at a script named by position falls back to the folder', () => {
  assert.equal(processLabel(['bun run index.ts'], '/works/notes'), 'notes');
});

test('a lifecycle shorthand reads the same as its long form', () => {
  assert.equal(processLabel(['npm start'], '/works/app'), 'start');
  assert.equal(processLabel(['npm run start'], '/works/app'), 'start');
  assert.equal(processLabel(['npm test'], '/works/app'), 'test');
});

test('npm doing its own work is left alone', () => {
  assert.equal(processLabel(['npm install'], '/works/app'), 'npm install');
  assert.equal(processLabel(['npm ci'], '/works/app'), 'npm ci');
  assert.ok(!needsCommandLine('npm install'));
});
