import assert from 'node:assert/strict';
import { test } from 'node:test';
import { renderUnit } from './systemd.ts';

const TEMPLATE = '[Unit]\nDescription=Perch\n\n[Service]\nType=simple\nExecStart=%h/.local/share/perch/bin/perch run\n';

test('the installed unit carries a PATH with the installing node first', () => {
  const unit = renderUnit(TEMPLATE, '/home/me/.nvm/versions/node/v24.0.0/bin', '/usr/local/bin:/usr/bin:/bin');
  assert.equal(
    unit,
    '[Unit]\nDescription=Perch\n\n[Service]\nEnvironment="PATH=/home/me/.nvm/versions/node/v24.0.0/bin:/usr/local/bin:/usr/bin:/bin"\nType=simple\nExecStart=%h/.local/share/perch/bin/perch run\n',
  );
});

test('a node folder already on PATH is not listed twice, and an empty PATH is fine', () => {
  assert.match(renderUnit(TEMPLATE, '/usr/bin', '/usr/bin:/bin'), /Environment="PATH=\/usr\/bin:\/bin"/);
  assert.match(renderUnit(TEMPLATE, '/opt/node/bin', undefined), /Environment="PATH=\/opt\/node\/bin"/);
});

test('percent signs are escaped for systemd', () => {
  assert.match(renderUnit(TEMPLATE, '/odd%dir/bin', ''), /PATH=\/odd%%dir\/bin"/);
});
