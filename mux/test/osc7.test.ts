import { test } from 'node:test';
import assert from 'node:assert/strict';
import { directoryFromOsc7 } from '../src/util/osc7.ts';

test('reads a POSIX directory, with or without a host', () => {
  assert.equal(directoryFromOsc7('file://myhost/home/me/work'), '/home/me/work');
  assert.equal(directoryFromOsc7('file:///tmp'), '/tmp');
});

test('decodes percent-escapes', () => {
  assert.equal(directoryFromOsc7('file://h/home/me/my%20project'), '/home/me/my project');
});

test('turns a Windows drive path into Windows form', () => {
  assert.equal(directoryFromOsc7('file://PC/c:/Users/me/src'), 'C:\\Users\\me\\src');
  assert.equal(directoryFromOsc7('file:///D:'), 'D:\\');
});

test('ignores anything that is not a file URL', () => {
  assert.equal(directoryFromOsc7('http://example.com/x'), null);
  assert.equal(directoryFromOsc7('file://host'), null);
  assert.equal(directoryFromOsc7('file://h/%E0%A4%A'), null);
});
