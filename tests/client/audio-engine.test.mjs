import { test } from 'node:test';
import assert from 'node:assert/strict';

/**
 * 音频引擎必须是模块级单例：会话切换会卸载播放条，播放器/加载器不能跟着重建，
 * 否则切会话会重新加载当前曲目（表现为音乐中断或从头播）。
 */

const makeAudio = () => ({
  style: {},
  preload: '',
  paused: true,
  currentTime: 0,
  duration: 0,
  volume: 1,
  error: null,
  seekable: { length: 0 },
  addEventListener() {},
  removeEventListener() {},
  setAttribute() {},
  load() {},
  play() {
    this.paused = false;
    return Promise.resolve();
  },
  pause() {
    this.paused = true;
  },
});

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
  assert.equal(typeof first.snapshot, 'function');
});

test('订阅者收到播放状态，退订后不再收到', async () => {
  const { getAudioEngine } = await import('../../client/audio-engine.js');
  const engine = getAudioEngine();
  const events = [];
  const off = engine.subscribe((name, value) => events.push([name, value]));

  await engine.player.toggle();
  assert.ok(
    events.some(([name]) => name === 'state'),
    '播放状态变化应推给订阅者',
  );

  off();
  const before = events.length;
  await engine.player.toggle();
  assert.equal(events.length, before, '退订后不该再收到事件');
});
