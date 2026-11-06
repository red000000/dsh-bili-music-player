import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Writable } from 'node:stream';

/**
 * HTTP 入口冒烟：只测路由层的契约——状态码、响应体、以及「已缓存的音频
 * 不该再访问 B 站接口」这条回归。领域动作全部用假实现。
 */

import { createHandler } from '../../src/surface/routes.js';

const tempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'bili-music-routes-'));

/** 够小的假响应对象：Writable 才能给 fs.createReadStream().pipe() 用。 */
function makeRes() {
  const res = new Writable({
    write(chunk, _enc, callback) {
      res.chunks.push(chunk);
      callback();
    },
  });
  res.chunks = [];
  res.writeHead = (code, headers) => {
    res.statusCode = code;
    res.headers = headers;
  };
  res.text = () => Buffer.concat(res.chunks).toString('utf8');
  res.json = () => JSON.parse(res.text());
  return res;
}

const makeReq = ({ method = 'GET', url = '/', headers = {}, body } = {}) => ({
  method,
  url,
  headers,
  [Symbol.asyncIterator]: async function* () {
    if (body !== undefined) yield Buffer.from(body);
  },
});

const finished = (res) => new Promise((resolve) => res.on('finish', resolve));

function makeDeps(overrides = {}) {
  const dir = tempDir();
  const deps = {
    base: dir,
    store: { readFeedbackState: () => ({}), paths: {} },
    state: { current: null, history: [], cursor: 0 },
    feedbackStats: () => ({ total: 0 }),
    feedbackOf: () => null,
    profileSummary: () => ({ songs: [] }),
    playNext: async () => ({ track: null }),
    playPrev: async () => ({ atEnd: true }),
    submitFeedback: async () => ({ action: 'like' }),
    videoInfo: async () => {
      throw new Error('已缓存时不该访问 B 站接口');
    },
    audioStream: async () => ({ url: 'https://example.invalid/audio' }),
    manifestReader: { get: async () => null },
    audioCache: {
      fileOf: (bvid) => path.join(dir, `${bvid}.m4a`),
      isComplete: (file) => fs.existsSync(file) && fs.statSync(file).size > 100 * 1024,
    },
    ensureAudioFile: async () => {},
    userAgent: 'test-agent',
    ...overrides,
  };
  return { deps, dir };
}

test('已缓存的音频直接按 Range 返回，不再请求 B 站接口', async () => {
  const { deps, dir } = makeDeps();
  const size = 200 * 1024;
  fs.writeFileSync(path.join(dir, 'BV1.m4a'), Buffer.alloc(size, 7));

  const handler = createHandler(deps);
  const res = makeRes();
  await handler(makeReq({ url: '/bili-music/stream/BV1', headers: { range: 'bytes=0-9' } }), res);
  await finished(res);

  assert.equal(res.statusCode, 206);
  assert.equal(res.headers['content-range'], `bytes 0-9/${size}`);
  assert.equal(
    res.chunks.reduce((sum, chunk) => sum + chunk.length, 0),
    10,
  );
});

test('Range 越界返回 416', async () => {
  const { deps, dir } = makeDeps();
  fs.writeFileSync(path.join(dir, 'BV2.m4a'), Buffer.alloc(200 * 1024, 1));

  const handler = createHandler(deps);
  const res = makeRes();
  await handler(
    makeReq({ url: '/bili-music/stream/BV2', headers: { range: 'bytes=999999-' } }),
    res,
  );
  await finished(res);

  assert.equal(res.statusCode, 416);
});

test('/state 把反馈并进当前曲与历史', async () => {
  const { deps } = makeDeps({
    store: { readFeedbackState: () => ({ BV1: { action: 'like' } }), paths: {} },
    state: {
      current: { bvid: 'BV1', title: '稻香' },
      history: [{ bvid: 'BV1', title: '稻香' }],
      cursor: 0,
    },
    feedbackOf: (bvid) => (bvid === 'BV1' ? 'like' : null),
    feedbackStats: () => ({ total: 1 }),
  });

  const res = makeRes();
  await createHandler(deps)(makeReq({ url: '/bili-music/state' }), res);
  const payload = res.json();

  assert.equal(payload.ok, true);
  assert.equal(payload.current.feedback, 'like');
  assert.equal(payload.history[0].feedback, 'like');
  assert.equal(payload.history[0].current, true);
  assert.equal(payload.feedbackTotal, 1);
});

test('反馈失败返回 400 与错误信息', async () => {
  const { deps } = makeDeps({
    submitFeedback: async () => {
      throw new Error('未知反馈: love');
    },
  });

  const res = makeRes();
  await createHandler(deps)(
    makeReq({ method: 'POST', url: '/bili-music/feedback', body: '{"action":"love"}' }),
    res,
  );

  assert.equal(res.statusCode, 400);
  assert.match(res.json().error, /未知反馈/);
});

test('诊断通道把客户端日志写进 debug.log', async () => {
  const { deps, dir } = makeDeps();

  const res = makeRes();
  await createHandler(deps)(
    makeReq({ method: 'POST', url: '/bili-music/debug', body: '{"tag":"probe"}' }),
    res,
  );

  assert.equal(res.statusCode, 200);
  const log = fs.readFileSync(path.join(dir, 'debug.log'), 'utf8');
  assert.match(log, /"tag":"probe"/);
});

test('未知路径返回 404', async () => {
  const { deps } = makeDeps();
  const res = makeRes();
  await createHandler(deps)(makeReq({ url: '/bili-music/nope' }), res);
  assert.equal(res.statusCode, 404);
});
