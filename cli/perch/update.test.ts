// perch update's decision: where a release-following install moves, stays
// or stops (plans/app-versioning.md R12, R13).
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parseLsRemoteTags, planUpdate } from './update.ts';

const tags = (entries: Record<string, string>) => new Map(Object.entries(entries));

describe('planUpdate', () => {
  const released = tags({ 'v0.1.0': 'a1', 'v0.2.0': 'b2', 'v0.3.0-rc.1': 'c3' });

  it('moves to the latest stable release', () => {
    assert.deepEqual(planUpdate({ current: '0.1.0', head: 'a1', tags: released, channel: 'stable' }), {
      action: 'move', tag: 'v0.2.0', message: 'updating 0.1.0 -> 0.2.0',
    });
  });

  it('includes pre-releases on beta', () => {
    assert.equal(planUpdate({ current: '0.2.0', head: 'b2', tags: released, channel: 'beta' }).tag, 'v0.3.0-rc.1');
  });

  it('says so when already on the latest', () => {
    assert.equal(planUpdate({ current: '0.2.0', head: 'b2', tags: released, channel: 'stable' }).action, 'current');
  });

  it('stays on main ahead of a release with the same version', () => {
    const plan = planUpdate({ current: '0.2.0', head: 'ff', tags: released, channel: 'stable' });
    assert.equal(plan.action, 'stay');
    assert.match(plan.message, /perch update --main/);
  });

  it('never moves to an older version', () => {
    assert.equal(planUpdate({ current: '0.3.0-rc.1', head: 'c3', tags: released, channel: 'stable' }).action, 'stay');
    assert.equal(planUpdate({ current: '0.4.0', head: 'zz', tags: released, channel: 'beta' }).action, 'stay');
  });

  it('stops when there is no release yet', () => {
    assert.equal(planUpdate({ current: '0.1.0', head: 'a1', tags: tags({ 'desktop-v0.1.0': 'x', 'v0.2.0-rc.1': 'y' }), channel: 'stable' }).action, 'no-releases');
  });
});

describe('parseLsRemoteTags', () => {
  it('resolves annotated tags to their commit', () => {
    const text = 'aaa\trefs/tags/v0.1.0\nbbb\trefs/tags/v0.1.0^{}\nccc\trefs/tags/v0.2.0\n';
    assert.deepEqual([...parseLsRemoteTags(text)], [['v0.1.0', 'bbb'], ['v0.2.0', 'ccc']]);
  });
});
