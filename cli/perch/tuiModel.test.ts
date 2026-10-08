import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  attachChoice, buildRows, bumpRecent, completePath, completionDir, findRowIndex, fit, pickerItems, projectName, sanitizeProjects,
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
