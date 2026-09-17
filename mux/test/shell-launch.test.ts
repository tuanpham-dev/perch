import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { shellLaunchArgs } from '../src/util/shell-launch.ts';

const dir = '/home/me/.config/perch';
const all = () => true;
const none = () => false;

test('bash starts with the init file the server wrote as its rcfile', () => {
  assert.deepEqual(shellLaunchArgs('/bin/bash', dir, all), ['--rcfile', join(dir, 'bash-init.sh')]);
  assert.deepEqual(shellLaunchArgs('bash', dir, all), ['--rcfile', join(dir, 'bash-init.sh')]);
});

test('PowerShell dot-sources the .ps1 after its profiles and stays interactive', () => {
  for (const shell of ['pwsh.exe', 'C:\\Program Files\\PowerShell\\7\\pwsh.exe', 'powershell.exe', 'pwsh']) {
    const args = shellLaunchArgs(shell, dir, all);
    assert.equal(args[0], '-NoExit');
    assert.equal(args[1], '-Command');
    assert.match(args[2]!, /^try \{ \. '.*shell-integration\.ps1' \} catch \{\}$/);
  }
});

test('zsh and other shells start plain, and so does bash without the file', () => {
  assert.deepEqual(shellLaunchArgs('/bin/zsh', dir, all), []);
  assert.deepEqual(shellLaunchArgs('/usr/bin/fish', dir, all), []);
  assert.deepEqual(shellLaunchArgs('cmd.exe', dir, all), []);
  assert.deepEqual(shellLaunchArgs('/bin/bash', dir, none), []);
  assert.deepEqual(shellLaunchArgs('pwsh.exe', dir, none), []);
});

test("a quote in the config path can't break out of the PowerShell command", () => {
  const args = shellLaunchArgs('pwsh', "C:\\Users\\O'Brien\\perch", all);
  assert.ok(args[2]!.includes("O''Brien"));
});
