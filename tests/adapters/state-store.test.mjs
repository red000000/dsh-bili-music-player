import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createStateStore } from '../../src/adapters/state-store.js';

const tempBase = () => fs.mkdtempSync(path.join(os.tmpdir(), 'bili-music-store-'));

test('没有 state 文件时给出默认状态', () => {
  const store = createStateStore({ dataDir: tempBase() });
  assert.equal(store.state.current, null);
  assert.deepEqual(store.readFeedbackState(), {});
  assert.deepEqual(store.state.history, []);
  assert.deepEqual(store.state.queue, []);
  assert.deepEqual(store.state.recent, []);
});

test('损坏的 state.json 会把列表字段补成数组，而不是留成对象', () => {
  const dataDir = tempBase();
  fs.writeFileSync(
    path.join(dataDir, 'state.json'),
    JSON.stringify({ current: null, history: {}, queue: 'x', recent: null }),
  );
  const store = createStateStore({ dataDir });
  assert.ok(Array.isArray(store.state.history));
  assert.ok(Array.isArray(store.state.queue));
  assert.ok(Array.isArray(store.state.recent));
});

test('cookie header 过滤空值并按 k=v 拼接', () => {
  const dataDir = tempBase();
  fs.writeFileSync(
    path.join(dataDir, 'cookies.json'),
    JSON.stringify({ SESSDATA: 'a', empty: '', bili_jct: 'b' }),
  );
  const store = createStateStore({ dataDir });
  assert.equal(store.cookieHeader(), 'SESSDATA=a; bili_jct=b');
});

test('首次启动把追加流水迁移成每首歌一条状态', () => {
  const dataDir = tempBase();
  const rows = [
    { bvid: 'BV1', action: 'skip', title: '旧' },
    { bvid: 'BV1', action: 'like', title: '新' },
    { bvid: 'BV2', action: 'dislike', title: '另一首' },
  ];
  fs.writeFileSync(
    path.join(dataDir, 'feedback.jsonl'),
    rows.map((row) => JSON.stringify(row)).join('\n'),
  );
  const store = createStateStore({ dataDir });
  const map = store.readFeedbackState();
  assert.equal(map.BV1.action, 'like', '同一首歌取最后一条');
  assert.equal(map.BV2.action, 'dislike');
});

test('迁移时 clear 流水会把之前的反馈删掉', () => {
  const dataDir = tempBase();
  const rows = [
    { bvid: 'BV1', action: 'like', title: '一首' },
    { bvid: 'BV1', action: 'clear', title: '一首' },
    { bvid: 'BV2', action: 'dislike', title: '另一首' },
  ];
  fs.writeFileSync(
    path.join(dataDir, 'feedback.jsonl'),
    rows.map((row) => JSON.stringify(row)).join('\n'),
  );
  const store = createStateStore({ dataDir });
  const map = store.readFeedbackState();
  assert.equal(map.BV1, undefined, 'clear 之后不该再有这首');
  assert.equal(map.BV2.action, 'dislike');
});

test('writeJson 落盘后能读回，且保留 0600 权限', () => {
  const dataDir = tempBase();
  const store = createStateStore({ dataDir });
  const file = path.join(dataDir, 'nested', 'x.json');
  store.writeJson(file, { ok: 1 });
  assert.deepEqual(store.readJson(file, null), { ok: 1 });
});

test('反馈状态与审计流水分开存放', () => {
  const dataDir = tempBase();
  const store = createStateStore({ dataDir });
  store.writeFeedbackState({ BV1: { action: 'like' } });
  store.appendFeedbackLog({ bvid: 'BV1', action: 'like' });
  assert.deepEqual(store.readFeedbackState(), { BV1: { action: 'like' } });
  assert.equal(store.readFeedbackLog().length, 1);
});
