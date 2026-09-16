import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseInstanceFlags, quoteEnvValue, upsertEnvLine } from './envFile.ts';

test('flags accept both --flag value and --flag=value', () => {
  const flags = parseInstanceFlags(['--port', '8040', '--app-name=Work Server']);
  assert.deepEqual(flags.values, { PORT: '8040', APP_NAME: 'Work Server' });
  assert.equal(flags.help, false);
  assert.equal(parseInstanceFlags(['-h']).help, true);
});

test('a value with a double quote stays parseable', () => {
  assert.equal(quoteEnvValue('say "hi"'), `"say 'hi'"`);
});

test('upserting replaces only the matching line', () => {
  const before = '# config\nPORT="3001"\nAPP_NAME="x"\n';
  assert.equal(upsertEnvLine(before, 'PORT', '8044'), '# config\nPORT="8044"\nAPP_NAME="x"\n');
});

test('upserting appends a new key and keeps a trailing newline', () => {
  assert.equal(upsertEnvLine('A="1"\n', 'B', '2'), 'A="1"\nB="2"\n');
  assert.equal(upsertEnvLine('', 'B', '2'), 'B="2"\n');
});
