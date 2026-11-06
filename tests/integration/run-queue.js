/**
 * 回归：历史只读 + 播放队列。
 *
 * 期望：
 *  - ⏭ 永远拿到「没听过」的歌（消费队列），不会在历史里来回走
 *  - ⏮ 回到真正的上一首（历史前一条）
 *  - 连点 ⏭ 不重复
 */
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';

const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\//, ''));
const WORK = 'C:/Users/Qq320/work';
const dataDir = path.join(WORK, '.tmp/queue-test');
fs.rmSync(dataDir, { recursive: true, force: true });
fs.mkdirSync(dataDir, { recursive: true });

const plugin = await import(new URL('../../index.js', import.meta.url).href + '?v=' + Date.now());
const tools = new Map();
const routes = [];
plugin.apply(
  {
    effect(fn) {
      return fn();
    },
    tools: {
      register(t) {
        tools.set(t.name, t);
      },
    },
    webServer: {
      register(e) {
        routes.push(e);
        return () => {};
      },
    },
  },
  {
    dataDir,
    cookieFile: path.join(WORK, '.tmp/bili-music/cookies.json'),
    profileFile: path.join(WORK, 'data/bili-music-profile-2026-10-31.json'),
  },
);

const server = http.createServer((req, res) => {
  const r = routes.find((x) => req.url.startsWith(x.path));
  if (!r) {
    res.writeHead(404);
    res.end();
    return;
  }
  Promise.resolve(r.handler(req, res)).catch((e) => {
    try {
      res.writeHead(500);
      res.end(String(e));
    } catch {
      /* 忽略 */
    }
  });
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;
const post = async (p) =>
  (
    await fetch(base + p, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    })
  ).json();
const state = async () => (await fetch(base + '/bili-music/state')).json();

const played = [];
for (const q of ['周杰伦 稻香', '陈奕迅 孤勇者', '朴树 平凡之路']) {
  const r = await tools.get('bili_music_play').execute({ query: q }, {});
  played.push(r.track.bvid);
}

// 等队列预热
await new Promise((r) => setTimeout(r, 3000));

const next1 = await post('/bili-music/next');
const next2 = await post('/bili-music/next');
const prev1 = await post('/bili-music/prev');

const st = await state();
const out = {
  played,
  next1: {
    bvid: next1.track?.bvid,
    reason: next1.track?.reason,
    isNew: next1.track && !played.includes(next1.track.bvid),
  },
  next2: {
    bvid: next2.track?.bvid,
    reason: next2.track?.reason,
    isNew: next2.track && !played.includes(next2.track.bvid),
  },
  nextDistinct: next1.track?.bvid !== next2.track?.bvid,
  prev1: { bvid: prev1.track?.bvid, reason: prev1.track?.reason },
  historyTop: (st.history || []).slice(0, 4).map((h) => h.bvid),
};
server.close();
console.log(JSON.stringify(out, null, 2));
