import { test } from 'node:test';
import assert from 'node:assert/strict';

/**
 * 资源加载器：MSE 优先、整首下载兜底、同曲去重、失败可重试。
 * 用假的 fetch / MediaSource / audio 元素跑，不联网也不需要浏览器。
 */

import { createLoader } from '../../client/loader.js';

const TRACK = { bvid: 'BV1', startedAt: '2026-11-06T00:00:00.000Z' };
const KEY = 'BV1|2026-11-06T00:00:00.000Z';
const STREAM = '/bili-music/stream/BV1';

function fakeAudio() {
  return {
    src: '',
    paused: true,
    pauseCalls: 0,
    loadCalls: 0,
    pause() {
      this.pauseCalls += 1;
      this.paused = true;
    },
    play() {
      this.paused = false;
      return Promise.resolve();
    },
    load() {
      this.loadCalls += 1;
    },
    removeAttribute(name) {
      if (name === 'src') this.src = '';
    },
  };
}

const chunksReader = (chunks) => {
  let index = 0;
  return {
    read: async () =>
      index < chunks.length ? { done: false, value: chunks[index++] } : { done: true },
    cancel: async () => {},
  };
};

function fakeFetch({
  manifestOk = false,
  streamOk = true,
  chunks = [new Uint8Array([1, 2, 3, 4])],
} = {}) {
  const calls = { manifest: 0, stream: 0 };
  const fetch = async (url) => {
    if (String(url).includes('/manifest/')) {
      calls.manifest += 1;
      return manifestOk
        ? {
            ok: true,
            json: async () => ({
              ok: true,
              codec: 'audio/mp4',
              duration: 10,
              init: { start: 0, end: 9 },
              segments: [{ start: 0, end: 9 }],
            }),
          }
        : { ok: false, status: 404 };
    }
    calls.stream += 1;
    if (!streamOk) return { ok: false, status: 500 };
    return {
      ok: true,
      headers: { get: () => String(chunks.reduce((sum, chunk) => sum + chunk.length, 0)) },
      body: { getReader: () => chunksReader(chunks) },
    };
  };
  return { fetch, calls };
}

function collect() {
  const events = [];
  return {
    events,
    onLoading: (value) => events.push(['loading', value]),
    onProgress: (value) => events.push(['progress', value]),
    onPlaying: (value) => events.push(['playing', value]),
    onError: (value) => events.push(['error', value]),
  };
}

async function waitFor(predicate) {
  for (let i = 0; i < 100; i++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('等待超时');
}

const lastEvent = (events, name) => events.filter(([event]) => event === name).at(-1);

test('manifest 不可用时退回整首下载，并回调起播', async (t) => {
  const el = fakeAudio();
  const ui = collect();
  t.after(() => {
    delete globalThis.fetch;
  });
  globalThis.fetch = fakeFetch().fetch;

  const loader = createLoader({ el, diag: () => {}, ...ui });
  loader.load({ track: TRACK, key: KEY, shouldPlay: true, streamUrl: STREAM });
  await waitFor(() => lastEvent(ui.events, 'playing')?.[1] === true);

  assert.equal(el.src.startsWith('blob:'), true);
  assert.equal(el.paused, false);
  assert.equal(loader.failed, false);
  assert.deepEqual(lastEvent(ui.events, 'loading'), ['loading', false]);
  assert.deepEqual(lastEvent(ui.events, 'progress'), ['progress', 1]);
});

test('MSE 可用时分片喂给 SourceBuffer，首段就绪即起播', async (t) => {
  const appended = [];
  class FakeMediaSource {
    constructor() {
      this.duration = 0;
    }
    addEventListener(type, callback) {
      if (type === 'sourceopen') setTimeout(callback, 0);
    }
    addSourceBuffer() {
      return {
        updating: false,
        appendBuffer: (buffer) => appended.push(buffer.length),
        addEventListener() {},
        removeEventListener() {},
      };
    }
    endOfStream() {}
  }
  const realMediaSource = globalThis.MediaSource;
  const realCreateObjectURL = URL.createObjectURL;
  const realRevokeObjectURL = URL.revokeObjectURL;
  globalThis.MediaSource = FakeMediaSource;
  URL.createObjectURL = () => 'blob:fake';
  URL.revokeObjectURL = () => {};
  t.after(() => {
    globalThis.MediaSource = realMediaSource;
    URL.createObjectURL = realCreateObjectURL;
    URL.revokeObjectURL = realRevokeObjectURL;
    delete globalThis.fetch;
  });
  globalThis.fetch = fakeFetch({ manifestOk: true, chunks: [new Uint8Array(10)] }).fetch;

  const el = fakeAudio();
  const ui = collect();
  const loader = createLoader({ el, diag: () => {}, ...ui });
  loader.load({ track: TRACK, key: KEY, shouldPlay: true, streamUrl: STREAM });
  await waitFor(() => lastEvent(ui.events, 'playing')?.[1] === true);

  assert.equal(el.src, 'blob:fake');
  assert.deepEqual(appended, [10, 10]);
  assert.equal(loader.failed, false);
  assert.equal(lastEvent(ui.events, 'error')?.[1], '');
});

test('同一个 key 重复调用不会重新加载', async (t) => {
  const el = fakeAudio();
  const ui = collect();
  const net = fakeFetch();
  t.after(() => {
    delete globalThis.fetch;
  });
  globalThis.fetch = net.fetch;

  const loader = createLoader({ el, diag: () => {}, ...ui });
  loader.load({ track: TRACK, key: KEY, shouldPlay: true, streamUrl: STREAM });
  await waitFor(() => lastEvent(ui.events, 'playing')?.[1] === true);
  loader.load({ track: TRACK, key: KEY, shouldPlay: true, streamUrl: STREAM });
  await new Promise((resolve) => setTimeout(resolve, 10));

  assert.equal(net.calls.manifest, 1);
  assert.equal(net.calls.stream, 1);
  assert.equal(el.pauseCalls, 1, '重复调用不应该打断正在播的音频');
});

test('reset 清空当前键，同一首可以重新加载', async (t) => {
  const el = fakeAudio();
  const ui = collect();
  const net = fakeFetch();
  t.after(() => {
    delete globalThis.fetch;
  });
  globalThis.fetch = net.fetch;

  const loader = createLoader({ el, diag: () => {}, ...ui });
  loader.load({ track: TRACK, key: KEY, shouldPlay: true, streamUrl: STREAM });
  await waitFor(() => lastEvent(ui.events, 'playing')?.[1] === true);

  loader.reset();
  assert.equal(loader.key, '');
  assert.equal(el.src, '');

  loader.load({ track: TRACK, key: KEY, shouldPlay: true, streamUrl: STREAM });
  await waitFor(() => net.calls.stream === 2);
});

test('两条链路都失败时报告错误并标记 failed，供重试判断', async (t) => {
  const el = fakeAudio();
  const ui = collect();
  t.after(() => {
    delete globalThis.fetch;
  });
  globalThis.fetch = fakeFetch({ streamOk: false }).fetch;

  const loader = createLoader({ el, diag: () => {}, ...ui });
  loader.load({ track: TRACK, key: KEY, shouldPlay: false, streamUrl: STREAM });
  await waitFor(() => Boolean(lastEvent(ui.events, 'error')?.[1]));

  assert.equal(loader.failed, true);
  assert.deepEqual(lastEvent(ui.events, 'loading'), ['loading', false]);
  assert.match(lastEvent(ui.events, 'error')[1], /音源加载失败/);
});
