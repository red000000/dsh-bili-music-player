import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createFeedback } from '../../src/domain/feedback.js';

const makeHarness = ({ folderFails = false } = {}) => {
  const state = { current: null, history: [], queue: [], recent: [] };
  const saved = [];
  const store = {
    map: {},
    readFeedbackState() {
      return this.map;
    },
    writeFeedbackState(map) {
      this.map = map;
    },
    appendFeedbackLog(record) {
      saved.push(record);
    },
  };
  const trackMeta = (bvid) => ({ bvid, title: `曲目${bvid}`, artist: '歌手' });
  const feedback = createFeedback({
    store,
    state,
    saveState: () => {},
    trackMeta,
    feedbackOf: (bvid) => store.map[bvid]?.action || null,
    addToAgentFolder: async (bvid) =>
      folderFails ? Promise.reject(new Error('收藏夹失败')) : { folder: '点歌助手', bvid },
    removeFromAgentFolder: async (bvid) => ({ removed: bvid, folder: '点歌助手' }),
  });
  return { feedback, state, store, saved };
};

test('同一反馈重复提交返回 duplicated，不重复计数', async () => {
  const harness = makeHarness();
  harness.state.current = { bvid: 'BV0' };
  const first = await harness.feedback.submit('skip');
  const again = await harness.feedback.submit('skip');
  assert.equal(first.duplicated, undefined);
  assert.equal(again.duplicated, true);
  assert.equal(harness.saved.length, 1, '重复提交不应再写审计流水');
});

test('改反馈会覆盖，prev 记录上一条', async () => {
  const harness = makeHarness();
  harness.state.current = { bvid: 'BV1' };
  await harness.feedback.submit('like');
  const second = await harness.feedback.submit('skip');
  assert.equal(second.prev, 'like');
  assert.equal(harness.store.map.BV1.action, 'skip');
  assert.equal(harness.saved.length, 2, '每次写入都应有审计流水');
});

test('like 写入代理收藏夹', async () => {
  const harness = makeHarness();
  harness.state.current = { bvid: 'BV2' };
  const result = await harness.feedback.submit('like');
  assert.equal(result.saved.folder, '点歌助手');
});

test('从 like 改成 dislike 会撤出收藏夹', async () => {
  const harness = makeHarness();
  harness.state.current = { bvid: 'BV3' };
  await harness.feedback.submit('like');
  const result = await harness.feedback.submit('dislike');
  assert.equal(result.saved.removed, 'BV3', '应调用移除并把结果带回');
});

test('收藏夹失败不阻断反馈落库', async () => {
  const harness = makeHarness({ folderFails: true });
  harness.state.current = { bvid: 'BV4' };
  const result = await harness.feedback.submit('like');
  assert.equal(result.saved.error, '收藏夹失败');
  assert.equal(harness.store.map.BV4.action, 'like');
});

test('dislike 会把曲目从最近播放与待播队列里移除', async () => {
  const harness = makeHarness();
  harness.state.current = { bvid: 'BV5' };
  harness.state.recent = ['BV5', 'BV9'];
  harness.state.queue = [{ bvid: 'BV5' }, { bvid: 'BV8' }];
  await harness.feedback.submit('dislike');
  assert.deepEqual(harness.state.recent, ['BV9']);
  assert.deepEqual(
    harness.state.queue.map((item) => item.bvid),
    ['BV8'],
  );
});

test('未知反馈被拒绝', async () => {
  const harness = makeHarness();
  harness.state.current = { bvid: 'BV6' };
  await assert.rejects(() => harness.feedback.submit('love'), /未知反馈/);
});

test('clear 取消标记，删掉状态并撤出收藏夹', async () => {
  const harness = makeHarness();
  harness.state.current = { bvid: 'BV7' };
  await harness.feedback.submit('like');

  const result = await harness.feedback.submit('clear');

  assert.equal(result.changed, true);
  assert.equal(result.prev, 'like');
  assert.equal(harness.store.map.BV7, undefined, '取消后不应再留下反馈记录');
  assert.equal(harness.saved.at(-1).action, 'clear', '审计流水要留一条 clear');
  assert.equal(result.saved.removed, 'BV7', '取消 like 时要撤出收藏夹');
});

test('没有反馈时取消是空操作', async () => {
  const harness = makeHarness();
  harness.state.current = { bvid: 'BV8' };

  const result = await harness.feedback.submit('clear');

  assert.equal(result.changed, false);
  assert.equal(harness.saved.length, 0);
});
