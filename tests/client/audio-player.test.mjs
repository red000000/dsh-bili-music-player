import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createAudioPlayer } from '../../client/audio-player.js';

/** 可编程的假 audio 元素，覆盖 audio-player.js 用到的全部成员。 */
class FakeAudio {
  constructor() {
    this.listeners = new Map();
    this.paused = true;
    this.ended = false;
    this.currentTime = 0;
    this.duration = 200;
    this.volume = 1;
    this.readyState = 4;
    this.error = null;
    this.seekable = { length: 1, start: () => 0, end: () => 200 };
  }
  addEventListener(type, fn) {
    this.listeners.set(type, [...(this.listeners.get(type) || []), fn]);
  }
  removeEventListener(type, fn) {
    this.listeners.set(
      type,
      (this.listeners.get(type) || []).filter((item) => item !== fn),
    );
  }
  emit(type) {
    for (const fn of this.listeners.get(type) || []) fn();
  }
  play() {
    this.paused = false;
    this.emit('play');
    return Promise.resolve();
  }
  pause() {
    this.paused = true;
    this.emit('pause');
  }
}

let audio;
let states;
const setup = () => {
  audio = new FakeAudio();
  states = [];
  return createAudioPlayer({
    element: audio,
    reportDiagnostic: () => {},
    onState: (snapshot) => states.push(snapshot),
    onError: (message) => states.push({ error: message }),
    onEnded: () => states.push({ ended: true }),
  });
};

test('创建时挂上媒体监听', () => {
  setup();
  for (const type of ['timeupdate', 'play', 'pause', 'ended', 'error', 'loadedmetadata']) {
    assert.ok(audio.listeners.get(type)?.length, `缺少 ${type} 监听`);
  }
});

test('play 与 pause 会把状态推给组件', async () => {
  const player = setup();
  await player.togglePlayback();
  assert.equal(audio.paused, false);
  assert.equal(states.at(-1).playing, true);

  await player.togglePlayback();
  assert.equal(audio.paused, true);
  assert.equal(states.at(-1).playing, false);
});

test('播放结束后立刻触发 ended 不算播完（防 seek 抖动）', () => {
  const player = setup();
  player.seekTo(100); // 更新 lastSeekAt
  audio.emit('ended');
  assert.ok(!states.some((item) => item.ended), 'seek 后立刻的 ended 不应触发下一首');
});

test('正常播完会触发 ended 回调', () => {
  setup();
  audio.currentTime = 200;
  audio.emit('ended');
  assert.ok(states.some((item) => item.ended));
});

test('seek 被夹在时长与可跳区间内', () => {
  const player = setup();
  player.seekTo(999);
  assert.ok(audio.currentTime <= 200, `currentTime 越界: ${audio.currentTime}`);
  // 落在已缓冲区间内：夹到末尾留 0.25 秒余量
  audio.seekable = { length: 1, start: () => 0, end: () => 120 };
  player.seekTo(120);
  assert.ok(audio.currentTime <= 120 && audio.currentTime >= 119, '应夹到缓冲末尾附近');
  // 超出已缓冲区间：交给浏览器缓冲，不做夹紧
  player.seekTo(150);
  assert.equal(audio.currentTime, 150, '未缓冲区域应原样设置，由浏览器缓冲');
});

test('未就绪时 seek 会等 canplay 再应用', () => {
  const player = setup();
  audio.readyState = 1;
  player.seekTo(50);
  assert.equal(audio.currentTime, 0, '未就绪时不应立即设置');
  audio.readyState = 2;
  audio.emit('canplay');
  assert.equal(audio.currentTime, 50);
});

test('seekRatio 在媒体无时长时用后端时长兜底', () => {
  const player = setup();
  audio.duration = Number.NaN;
  player.seekRatio(0.5, 100);
  assert.equal(audio.currentTime, 50);
});

test('setVolume 夹在 0 到 1 之间', () => {
  const player = setup();
  player.setVolume(2);
  assert.equal(audio.volume, 1);
  player.setVolume(-1);
  assert.equal(audio.volume, 0);
});
