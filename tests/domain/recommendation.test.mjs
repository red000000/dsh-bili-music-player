import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  isInDurationRange,
  parseDurationSec,
  createRecommendation,
} from '../../src/domain/recommendation.js';

const fakeStore = (profile, feedback) => ({
  readProfile: () => profile,
  readFeedbackState: () => feedback,
});

const profile = {
  topArtists: [{ name: '周杰伦', score: 6 }],
  topSongs: [
    { bvid: 'BV1', title: '稻香', artist: '周杰伦', score: 5, confidence: 'high' },
    { bvid: 'BV2', title: '晴天', artist: '周杰伦', score: 4, confidence: 'high' },
  ],
  clusters: [],
};

test('时长解析支持 m:ss 与秒数', () => {
  assert.equal(parseDurationSec('3:45'), 225);
  assert.equal(parseDurationSec(200), 200);
  assert.equal(parseDurationSec(''), 0);
});

test('时长区间过滤：45 秒到 30 分钟', () => {
  assert.equal(isInDurationRange('0:30'), false);
  assert.equal(isInDurationRange('1:00'), true);
  assert.equal(isInDurationRange('29:59'), true);
  assert.equal(isInDurationRange('31:00'), false);
  assert.equal(isInDurationRange(''), true); // 未知时长不拦
});

test('dislike 的曲目与歌手不会进入候选', () => {
  const store = fakeStore(profile, {
    BV1: { action: 'dislike', title: '稻香', artist: '周杰伦' },
  });
  const recommendation = createRecommendation({
    store,
    state: { recent: [], history: [] },
    searchMusic: async () => [],
    fetchRelated: async () => [],
  });
  const songs = recommendation.profileSummary().songs.map((song) => song.bvid);
  assert.deepEqual(songs, ['BV2']);
});

test('like 不在画像里的曲目会被补进候选', () => {
  const store = fakeStore(profile, {
    BV9: { action: 'like', title: '夜曲', artist: '周杰伦' },
  });
  const recommendation = createRecommendation({
    store,
    state: { recent: [], history: [] },
    searchMusic: async () => [],
    fetchRelated: async () => [],
  });
  const songs = recommendation.profileSummary().songs;
  assert.ok(songs.some((song) => song.bvid === 'BV9' && song.score === 6));
});

test('最近听过的曲目被会话护栏挡住', () => {
  const store = fakeStore(profile, {});
  const state = { recent: ['BV1', 'BV2'], history: [] };
  const recommendation = createRecommendation({
    store,
    state,
    searchMusic: async () => [],
    fetchRelated: async () => [],
  });
  assert.equal(recommendation.recommend({}).pick, null);
});

test('相关推荐里被拉黑、或明显不是歌的候选会在领域层被过滤', async () => {
  const store = fakeStore(profile, {
    BV9: { action: 'dislike', title: '旧曲', artist: '周杰伦' },
  });
  const state = { recent: ['BV1'], history: [] };
  const recommendation = createRecommendation({
    store,
    state,
    searchMusic: async () => [],
    fetchRelated: async () => [
      { bvid: 'BV9', title: '稻香 完整版', duration: '3:00', tname: '音乐' },
      { bvid: 'BV8', title: '某教程 第 1 集', duration: '3:00', tname: '音乐' },
      { bvid: 'BV7', title: '晴天 翻唱', duration: '3:00', tname: '音乐' },
    ],
  });

  const realRandom = Math.random;
  Math.random = () => 0;
  try {
    const online = await recommendation.recommendOnline({});
    assert.equal(online.bvid, 'BV7', '应跳过已 dislike 与教程类候选');
    assert.equal(online.keyword, '相关推荐');
  } finally {
    Math.random = realRandom;
  }
});
