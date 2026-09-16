import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { ProcessSnapshots, childrenOf, parseProcessCsv, pickShell, pipeName } from '../src/platform/windows.ts';

test('a pipe name is stable per user and state dir, and differs between them', () => {
  const a = pipeName('me', 'C:\\Users\\me\\AppData\\Local\\perch');
  assert.match(a, /^\\\\\.\\pipe\\perch-[0-9a-f]{12}$/);
  assert.equal(a, pipeName('me', 'c:\\users\\me\\appdata\\local\\perch'), 'case-insensitive like the filesystem');
  assert.notEqual(a, pipeName('you', 'C:\\Users\\me\\AppData\\Local\\perch'));
  assert.notEqual(a, pipeName('me', 'C:\\Users\\me\\AppData\\Local\\perch-next'));
});

const CSV = [
  '"ProcessId","ParentProcessId","Name"',
  '"100","4","explorer.exe"',
  '"200","100","pwsh.exe"',
  '"201","100","conhost.exe"',
  '"300","200","nvim.exe"',
  '"301","200","OpenConsole.exe"',
  '"302","200","node.exe"',
  '"400","300","a ""quoted"", name.exe"',
].join('\r\n');

test('parses the process list and drops .exe', () => {
  const entries = parseProcessCsv(CSV);
  assert.equal(entries.length, 7);
  assert.deepEqual(entries[1], { pid: 200, ppid: 100, name: 'pwsh' });
  assert.equal(entries[6]!.name, 'a "quoted", name');
});

test("a shell's children leave out the console hosts", () => {
  assert.deepEqual(childrenOf(parseProcessCsv(CSV), 200), [300, 302]);
});

test('a list with unexpected columns yields nothing rather than garbage', () => {
  assert.deepEqual(parseProcessCsv('"Id","Name"\r\n"1","x.exe"'), []);
});

test('prefers pwsh, then Windows PowerShell, then COMSPEC', () => {
  assert.equal(pickShell((n) => n === 'pwsh.exe', 'C:\\Windows\\system32\\cmd.exe'), 'pwsh.exe');
  assert.equal(pickShell((n) => n === 'powershell.exe', undefined), 'powershell.exe');
  assert.equal(pickShell(() => false, 'C:\\Windows\\system32\\cmd.exe'), 'C:\\Windows\\system32\\cmd.exe');
  assert.equal(pickShell(() => false, undefined), 'cmd.exe');
});

// A stand-in for the PowerShell helper: prints one CSV snapshot and the end
// marker per line it reads, and counts how many it was asked for.
function fakeHelper(script: string) {
  return () => spawn(process.execPath, ['-e', script], { stdio: ['pipe', 'pipe', 'ignore'] }) as never;
}
const HELPER = `
let n = 0;
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => {
  for (const _ of d.split('\\n').slice(1)) {
    n++;
    process.stdout.write('"ProcessId","ParentProcessId","Name"\\r\\n"' + (1000 + n) + '","1","pwsh.exe"\\r\\n--perch-snapshot-end--\\r\\n');
  }
});
`;
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

test('the process list comes from one helper, asked at most once a second', async () => {
  let spawned = 0;
  const snapshots = new ProcessSnapshots(() => { spawned++; return fakeHelper(HELPER)(); }, () => assert.fail('no fallback expected'));
  try {
    assert.deepEqual(snapshots.get(), [], 'nothing until the first answer');
    let first: ReturnType<typeof snapshots.get> = [];
    for (let i = 0; i < 100 && first.length === 0; i++) { await wait(50); first = snapshots.get(); }
    assert.deepEqual(first, [{ pid: 1001, ppid: 1, name: 'pwsh' }]);
    for (let i = 0; i < 5; i++) snapshots.get();
    await wait(100);
    assert.equal(snapshots.get()[0]!.pid, 1001, 'not asked again within a second');
    await wait(1100);
    snapshots.get();
    let second = snapshots.get();
    for (let i = 0; i < 100 && second[0]!.pid === 1001; i++) { await wait(50); second = snapshots.get(); }
    assert.equal(second[0]!.pid, 1002, 'asked again after a second');
    assert.equal(spawned, 1, 'the same helper answered both');
  } finally {
    snapshots.dispose();
  }
});

test('a helper that dies is replaced by a one-off query', async () => {
  let fallbacks = 0;
  const snapshots = new ProcessSnapshots(fakeHelper('process.exit(0)'), (done) => {
    fallbacks++;
    done('"ProcessId","ParentProcessId","Name"\r\n"42","1","cmd.exe"\r\n');
  });
  try {
    snapshots.get();
    let got = snapshots.get();
    for (let i = 0; i < 100 && got.length === 0; i++) { await wait(50); got = snapshots.get(); }
    assert.deepEqual(got, [{ pid: 42, ppid: 1, name: 'cmd' }]);
    assert.equal(fallbacks, 1);
  } finally {
    snapshots.dispose();
  }
});
