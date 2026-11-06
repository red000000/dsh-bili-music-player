import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  inDurationRange,
  parseDurationSec,
  createRecommendation,
} from '../src/domain/recommendation.js';

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
  assert.equal(inDurationRange('0:30'), false);
  assert.equal(inDurationRange('1:00'), true);
  assert.equal(inDurationRange('29:59'), true);
  assert.equal(inDurationRange('31:00'), false);
  assert.equal(inDurationRange(''), true); // 未知时长不拦
});

test('dislike 的曲目与歌手不会进入候选', () => {
  const store = fakeStore(profile, {
    BV1: { action: 'dislike', title: '稻香', artist: '周杰伦' },
  });
  const recommendation = createRecommendation({
    store,
    state: { recent: [], history: [] },
    searchMusic: async () => [],
    relatedCandidates: async () => [],
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
    relatedCandidates: async () => [],
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
    relatedCandidates: async () => [],
  });
  assert.equal(recommendation.recommend({}).pick, null);
});
