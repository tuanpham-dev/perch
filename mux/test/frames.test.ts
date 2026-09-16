import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encodeFrame, encodeControl, FrameReader, FRAME_CONTROL, FRAME_OUTPUT, MAX_PAYLOAD } from '../src/protocol/frames.ts';

test('round-trips a single frame', () => {
  const r = new FrameReader();
  const frames = r.push(encodeFrame(FRAME_OUTPUT, 'hello'));
  assert.equal(frames.length, 1);
  assert.equal(frames[0]!.type, FRAME_OUTPUT);
  assert.equal(frames[0]!.payload.toString(), 'hello');
});

test('reassembles a frame fed one byte at a time', () => {
  const r = new FrameReader();
  const wire = encodeControl({ id: 7, kind: 'session.list' });
  const got: unknown[] = [];
  for (const byte of wire) {
    for (const f of r.push(Buffer.from([byte]))) got.push(f);
  }
  assert.equal(got.length, 1);
  const f = got[0] as { type: number; payload: Buffer };
  assert.equal(f.type, FRAME_CONTROL);
  assert.deepEqual(JSON.parse(f.payload.toString()), { id: 7, kind: 'session.list' });
});

test('splits three frames arriving in one chunk', () => {
  const r = new FrameReader();
  const wire = Buffer.concat([
    encodeFrame(FRAME_OUTPUT, 'a'),
    encodeFrame(FRAME_CONTROL, '{"id":1,"ok":true}'),
    encodeFrame(FRAME_OUTPUT, Buffer.from([0x00, 0xff, 0x1b])),
  ]);
  const frames = r.push(wire);
  assert.equal(frames.length, 3);
  assert.equal(frames[0]!.payload.toString(), 'a');
  assert.equal(frames[1]!.type, FRAME_CONTROL);
  assert.deepEqual([...frames[2]!.payload], [0x00, 0xff, 0x1b]);
});

test('a partial frame is held until the rest arrives', () => {
  const r = new FrameReader();
  const wire = encodeFrame(FRAME_OUTPUT, 'delayed');
  assert.equal(r.push(wire.subarray(0, 8)).length, 0);
  const frames = r.push(wire.subarray(8));
  assert.equal(frames.length, 1);
  assert.equal(frames[0]!.payload.toString(), 'delayed');
});

test('rejects a frame claiming an oversized payload', () => {
  const r = new FrameReader();
  const head = Buffer.alloc(5);
  head.writeUInt32BE(MAX_PAYLOAD + 1, 0);
  head.writeUInt8(FRAME_OUTPUT, 4);
  assert.throws(() => r.push(head), /over the/);
});

test('encodeFrame refuses an oversized payload', () => {
  assert.throws(() => encodeFrame(FRAME_OUTPUT, Buffer.alloc(MAX_PAYLOAD + 1)), /exceeds/);
});
