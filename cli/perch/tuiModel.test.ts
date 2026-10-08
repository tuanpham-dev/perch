import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  attachChoice, buildRows, bumpRecent, completePath, completionDir, findRowIndex, fit, osc52, osc8, pickerItems, portUrl, projectName, sanitizeProjects,
  openCommand, openMethod, tunnelCommand, wrapWords,
  scrollTop, sessionNameForProject, togglePin, type Project, type Session,
} from './tuiModel.ts';

const win = (id: string, index: number, name: string, extra: Partial<Session['windows'][number]> = {}) => ({
  id, index, name, active: index === 0, cwd: '~/works/app', activity: false, command: name, ...extra,
});

const sessions: Session[] = [
  { id: 's1', name: 'app', path: '~/works/app', windows: [win('w1', 0, 'zsh'), win('w2', 1, 'claude')] },
  { id: 's2', name: 'scratch', path: '~', windows: [win('w3', 0, 'vim', { cwd: '~/notes' })] },
];
const projects: Project[] = [
  { cwd: '~/works/app', pinned: true, lastOpened: 3 },
  { cwd: '~/works/zeta', pinned: true, lastOpened: 2 },
  { cwd: '~/works/beta', pinned: true, lastOpened: 1 },
  { cwd: '~/works/old', pinned: false, lastOpened: 0 },
];

test('rows: live sessions with terminals, then pinned projects that are not running, by name', () => {
  const rows = buildRows(sessions, projects, new Set());
  assert.deepEqual(rows.map((r) => r.key), ['s:s1', 'w:w1', 'w:w2', 's:s2', 'w:w3', 'p:~/works/beta', 'p:~/works/zeta']);
  const app = rows[0]!;
  assert.ok(app.kind === 'project' && app.pinned && app.session);
  const scratch = rows[3]!;
  assert.ok(scratch.kind === 'project' && !scratch.pinned);
  const dead = rows[5]!;
  assert.ok(dead.kind === 'project' && dead.session === undefined && dead.name === 'beta');
});

test('rows: a collapsed project hides its terminals', () => {
  const rows = buildRows(sessions, [], new Set(['s:s1']));
  assert.deepEqual(rows.map((r) => r.key), ['s:s1', 's:s2', 'w:w3']);
  assert.ok(rows[0]!.kind === 'project' && rows[0]!.collapsed);
});

test('rows: a filter keeps matching terminals and their project, even when collapsed', () => {
  const rows = buildRows(sessions, projects, new Set(['s:s1']), 'CLAUDE');
  assert.deepEqual(rows.map((r) => r.key), ['s:s1', 'w:w2']);
  const byProject = buildRows(sessions, projects, new Set(), 'scratch');
  assert.deepEqual(byProject.map((r) => r.key), ['s:s2', 'w:w3']);
  const dead = buildRows(sessions, projects, new Set(), 'zeta');
  assert.deepEqual(dead.map((r) => r.key), ['p:~/works/zeta']);
});

test('selection follows its key, else the nearest row', () => {
  const rows = buildRows(sessions, projects, new Set());
  assert.equal(findRowIndex(rows, 'w:w3', 0), 4);
  assert.equal(findRowIndex(rows, 'w:gone', 2), 2);
  assert.equal(findRowIndex(rows, 'w:gone', 99), rows.length - 1);
  assert.equal(findRowIndex([], 'w:w1', 3), 0);
});

test('scrollTop keeps the selection visible', () => {
  assert.equal(scrollTop(0, 3, 5, 20), 0);
  assert.equal(scrollTop(0, 7, 5, 20), 3);
  assert.equal(scrollTop(10, 4, 5, 20), 4);
  assert.equal(scrollTop(18, 19, 5, 20), 15);
});

test('fit truncates with an ellipsis and pads', () => {
  assert.equal(fit('hello', 8), 'hello   ');
  assert.equal(fit('hello world', 6), 'hello…');
  assert.equal(fit('abc', 0), '');
});

test('project names and session names follow the web client', () => {
  assert.equal(projectName('~/works/app/'), 'app');
  assert.equal(projectName('~'), '~');
  assert.equal(projectName('/'), '/');
  assert.equal(sessionNameForProject('~/works/my.app', []), 'my-app');
  assert.equal(sessionNameForProject('~/works/app', ['app', 'app-2']), 'app-3');
});

test('bumpRecent moves to the top, keeps the pin, caps unpinned entries', () => {
  const next = bumpRecent(projects, '~/works/beta', 100);
  assert.equal(next[0]!.cwd, '~/works/beta');
  assert.equal(next[0]!.pinned, true);
  const many = Array.from({ length: 20 }, (_, i) => ({ cwd: `/p${i}`, pinned: false, lastOpened: i }));
  const capped = bumpRecent([...many, { cwd: '/pin', pinned: true, lastOpened: -1 }], '/new', 100);
  assert.equal(capped.filter((p) => !p.pinned).length, 15);
  assert.ok(capped.some((p) => p.cwd === '/pin'));
});

test('togglePin flips, and registers an unknown folder as pinned', () => {
  assert.equal(togglePin(projects, '~/works/app').find((p) => p.cwd === '~/works/app')!.pinned, false);
  assert.equal(togglePin(projects, '~/works/old').find((p) => p.cwd === '~/works/old')!.pinned, true);
  const added = togglePin([], '~/new', 5);
  assert.deepEqual(added, [{ cwd: '~/new', pinned: true, lastOpened: 5 }]);
});

test('sanitizeProjects drops malformed entries', () => {
  assert.deepEqual(sanitizeProjects([{ cwd: '~/a', pinned: true, lastOpened: 1 }, { nope: 1 }, null, 'x']), [
    { cwd: '~/a', pinned: true, lastOpened: 1 },
  ]);
  assert.deepEqual(sanitizeProjects(undefined), []);
});

test('path completion', () => {
  const entries = [
    { name: 'works', dir: true }, { name: 'workshop', dir: true }, { name: 'worklog.txt', dir: false }, { name: 'Downloads', dir: true },
  ];
  assert.equal(completePath('~/wor', entries), '~/works');
  assert.equal(completePath('~/worksh', entries), '~/workshop/');
  assert.equal(completePath('~/x', entries), '~/x');
  assert.equal(completionDir('~/wor'), '~/');
  assert.equal(completionDir('/'), '/');
  assert.equal(completionDir('wor'), null);
});

test('attachChoice never targets the terminal the TUI runs in', () => {
  const rows = buildRows(sessions, [], new Set());
  const project = rows[0]!;
  const w1 = rows[1]!;
  const w2 = rows[2]!;
  // Not inside any listed terminal: windows pin, projects follow.
  assert.deepEqual(attachChoice(w1, undefined), { target: '@w1' });
  assert.deepEqual(attachChoice(project, 'elsewhere'), { target: 'app' });
  // Its own terminal is refused.
  assert.ok('refuse' in attachChoice(w1, 'w1'));
  // Own terminal is in the project but not current: pin to the current one.
  assert.deepEqual(attachChoice(project, 'w2'), { target: '@w1' });
  // Own terminal is the project's current one: refuse.
  assert.ok('refuse' in attachChoice(project, 'w1'));
  assert.deepEqual(attachChoice(w2, 'w1'), { target: '@w2' });
});

test('pickerItems: recents, then the folders under the typed path', () => {
  const recents: Project[] = [
    { cwd: '~/works/app', pinned: true, lastOpened: 2 },
    { cwd: '/srv/site', pinned: false, lastOpened: 1 },
  ];
  const listing = { dir: '~/works/', entries: [
    { name: 'app', dir: true }, { name: 'api', dir: true }, { name: 'Blog', dir: true },
    { name: '.cache', dir: true }, { name: 'notes.md', dir: false },
  ] };
  // Untouched field: every recent, and nothing listed for a folder not yet typed.
  assert.deepEqual(pickerItems('~/', recents, null).map((i) => i.path), ['~/works/app', '/srv/site']);
  // Browsing ~/works/: folders only, dot-folders hidden, recents filtered by the text.
  assert.deepEqual(pickerItems('~/works/', recents, listing).map((i) => `${i.kind}:${i.path}`), [
    'recent:~/works/app', 'folder:~/works/app', 'folder:~/works/api', 'folder:~/works/Blog',
  ]);
  // A partial segment narrows the folders, case-insensitively.
  assert.deepEqual(pickerItems('~/works/b', recents, listing).map((i) => i.label), ['Blog/']);
  assert.deepEqual(pickerItems('~/works/.', recents, listing).map((i) => i.label), ['.cache/']);
  // A listing for some other folder is ignored until the right one arrives.
  assert.deepEqual(pickerItems('/srv/', recents, listing).map((i) => i.kind), ['recent']);
});

test('tunnel command, with and without a token, masked for display', () => {
  assert.equal(
    tunnelCommand('http://127.0.0.1:3003/', '', false),
    'curl -s http://127.0.0.1:3003/tunnel.mjs | node --input-type=module - --url http://127.0.0.1:3003 --all',
  );
  assert.equal(
    tunnelCommand('https://h', "s3c'ret", false),
    `curl -s -H 'x-auth-token: s3c'\\''ret' https://h/tunnel.mjs | node --input-type=module - --url https://h --header 'x-auth-token: s3c'\\''ret' --all`,
  );
  const masked = tunnelCommand('https://h', 'secret', true);
  assert.ok(!masked.includes('secret'));
  assert.equal(masked.split('••••').length, 3);
  assert.ok(tunnelCommand('http://h', '', false, 'abc123').endsWith('--url http://h --client abc123 --all'));
});

test('port URLs follow the proxy rule', () => {
  assert.equal(portUrl(3000, 'http://127.0.0.1:3003', null), 'http://127.0.0.1:3003/proxy/3000/');
  assert.equal(portUrl(3000, 'https://perch.example.com', 'example.com'), 'https://3000.example.com/');
  assert.equal(portUrl(3000, 'https://perch.example.com', 'example.com', true), 'http://localhost:3000/');
});

test('clipboard and hyperlink escapes', () => {
  assert.equal(osc52('hi'), '\x1b]52;c;aGk=\x07');
  assert.equal(osc8('http://x/', 'x'), '\x1b]8;;http://x/\x1b\\x\x1b]8;;\x1b\\');
});

test('wrapWords wraps at spaces and splits long words', () => {
  assert.deepEqual(wrapWords('aa bb cc', 5), ['aa bb', 'cc']);
  assert.deepEqual(wrapWords('abcdefgh ij', 3), ['abc', 'def', 'gh', 'ij']);
});

test('opening a URL: the command per platform', () => {
  assert.deepEqual(openCommand('darwin', 'http://x/?a=1&b=2'), { cmd: 'open', args: ['http://x/?a=1&b=2'] });
  assert.deepEqual(openCommand('win32', 'http://x/'), { cmd: 'rundll32', args: ['url.dll,FileProtocolHandler', 'http://x/'] });
  assert.deepEqual(openCommand('linux', 'http://x/'), { cmd: 'xdg-open', args: ['http://x/'] });
});

test('opening a URL: only where a browser in front of you can be reached', () => {
  assert.equal(openMethod('darwin', {}), 'system');
  assert.equal(openMethod('win32', {}), 'system');
  assert.equal(openMethod('linux', { DISPLAY: ':0' }), 'system');
  assert.equal(openMethod('linux', { PERCH_WINDOW: 'w' }), 'system');
  // No display (code-server, a headless server), or a desktop reached over SSH.
  assert.equal(openMethod('linux', {}), 'none');
  assert.equal(openMethod('darwin', { SSH_CONNECTION: '1 2 3 4' }), 'none');
});
