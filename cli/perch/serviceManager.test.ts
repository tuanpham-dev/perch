import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { plist, LABEL } from './launchd.ts';
import { REPO_DIR } from './paths.ts';
import { taskXml, TASK_NAME } from './taskScheduler.ts';

test('the launchd agent runs the CLI, restarts on crash and leaves the daemon alone', () => {
  const text = plist('/Users/me/.local/share/perch/bin/perch', '/Users/me/Library/Logs/perch.log', '/opt/homebrew/bin:/usr/bin');
  assert.match(text, new RegExp(`<key>Label</key>\\s*<string>${LABEL}</string>`));
  assert.match(text, /<string>\/Users\/me\/.local\/share\/perch\/bin\/perch<\/string>\s*<string>run<\/string>/);
  assert.match(text, /<key>SuccessfulExit<\/key>\s*<false\/>/);
  assert.match(text, /<key>AbandonProcessGroup<\/key>\s*<true\/>/);
  assert.match(text, /<string>\/opt\/homebrew\/bin:\/usr\/bin<\/string>/);
});

test('launchd values are escaped for XML', () => {
  const text = plist('/tmp/a&b<c>/perch', '/tmp/log', '/bin');
  assert.match(text, /\/tmp\/a&amp;b&lt;c&gt;\/perch/);
});

test('the systemd unit runs the CLI and only signals its main process', () => {
  const unit = readFileSync(join(REPO_DIR, 'systemd', 'perch.service'), 'utf8');
  assert.match(unit, /^ExecStart=.*\/bin\/perch run$/m);
  // The terminal daemon the server starts must survive a restart.
  assert.match(unit, /^KillMode=process$/m);
});

test('the Windows task starts at logon, headless, logging, and never times out', () => {
  const text = taskXml({ user: 'PC\\me', node: 'C:\\Program Files\\nodejs\\node.exe', self: 'C:\\Users\\me\\perch\\bin\\perch', logPath: 'C:\\Users\\me\\AppData\\Local\\perch\\perch.log' });
  assert.equal(TASK_NAME, 'perch');
  assert.match(text, /<LogonTrigger>[\s\S]*<UserId>PC\\me<\/UserId>/);
  assert.match(text, /<Command>conhost\.exe<\/Command>/);
  assert.match(text, /<Arguments>--headless cmd\.exe \/d \/c &quot;set PERCH_LAUNCHER=service&amp;&amp; &quot;C:\\Program Files\\nodejs\\node\.exe&quot; &quot;C:\\Users\\me\\perch\\bin\\perch&quot; run &gt;&gt; &quot;C:\\Users\\me\\AppData\\Local\\perch\\perch\.log&quot; 2&gt;&amp;1&quot;<\/Arguments>/);
  assert.match(text, /<ExecutionTimeLimit>PT0S<\/ExecutionTimeLimit>/);
  assert.match(text, /<MultipleInstancesPolicy>IgnoreNew<\/MultipleInstancesPolicy>/);
});
