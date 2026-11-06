import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  getPlaybackState,
  subscribePlayback,
  updatePlayback,
} from '../../client/playback-store.js';

test('状态是同一份对象，字段合并更新', () => {
  const before = getPlaybackState();
  updatePlayback({ now: 42, loading: true });
  assert.equal(getPlaybackState(), before, '快照对象应保持同一引用');
  assert.equal(before.now, 42);
  assert.equal(before.loading, true);
});

test('订阅者只在字段真的变化时收到通知，退订后不再收到', () => {
  let calls = 0;
  const off = subscribePlayback(() => calls++);

  updatePlayback({ now: 42 });
  assert.equal(calls, 0, '值没变不该通知');

  updatePlayback({ now: 43 });
  assert.equal(calls, 1);

  off();
  updatePlayback({ now: 44 });
  assert.equal(calls, 1, '退订后不该再收到通知');
});
