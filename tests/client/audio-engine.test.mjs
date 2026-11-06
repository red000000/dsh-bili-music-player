import { test } from 'node:test';
import assert from 'node:assert/strict';

/**
 * 音频引擎必须是模块级单例：会话切换会卸载播放条，播放器/加载器不能跟着重建，
 * 否则切会话会重新加载当前曲目（表现为音乐中断或从头播）。
 */

const makeAudio = () => {
  const handlers = new Map();
  return {
    __handlers: handlers,
    style: {},
    preload: '',
    paused: true,
    currentTime: 0,
    duration: 0,
    volume: 1,
    error: null,
    seekable: { length: 0 },
    addEventListener(type, handler) {
      handlers.set(type, handler);
    },
    removeEventListener(type) {
      handlers.delete(type);
    },
    setAttribute() {},
    load() {},
    play() {
      this.paused = false;
      return Promise.resolve();
    },
    pause() {
      this.paused = true;
    },
  };
};

test('引擎是模块级单例，重复获取得到同一个播放器与加载器', async () => {
  globalThis.Audio = function Audio() {
    return makeAudio();
  };
  globalThis.document = { body: { appendChild() {} } };

  const { getAudioEngine } = await import('../../client/audio-engine.js');
  const first = getAudioEngine();
  const second = getAudioEngine();

  assert.equal(first, second);
  assert.equal(first.player, second.player);
  assert.equal(first.loader, second.loader);
  assert.equal(typeof first.subscribeEnded, 'function');
});

test('播放状态写进模块级 store 并通知订阅者', async () => {
  const { getAudioEngine } = await import('../../client/audio-engine.js');
  const { getPlaybackState, subscribePlayback } = await import('../../client/playback-store.js');
  const engine = getAudioEngine();

  let notified = 0;
  const off = subscribePlayback(() => notified++);
  await engine.player.togglePlayback();

  assert.equal(getPlaybackState().playing, true);
  assert.ok(notified > 0, '状态变化应通知订阅者');
  off();
});

test('播放结束会通知订阅者，退订后不再通知', async () => {
  const { getAudioEngine } = await import('../../client/audio-engine.js');
  const engine = getAudioEngine();

  let ended = 0;
  const off = engine.subscribeEnded(() => ended++);
  const onEnded = engine.player.el.__handlers.get('ended');
  assert.equal(typeof onEnded, 'function');

  engine.player.el.duration = 200;
  engine.player.el.currentTime = 199.9;
  onEnded();
  assert.equal(ended, 1);

  off();
  onEnded();
  assert.equal(ended, 1, '退订后不该再收到 ended');
});
