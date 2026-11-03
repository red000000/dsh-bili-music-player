/**
 * 测试：画像池耗尽时的在线兜底。
 * 做法：把 profile 里所有 bvid 都塞进 recent，池子归零，看是否走 online 搜索。
 */
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';

const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\//, ''));
const WORK = 'C:/Users/Qq320/work';

const dataDir = path.join(WORK, '.tmp/plugin-test/data4');
fs.rmSync(dataDir, { recursive: true, force: true });
fs.mkdirSync(dataDir, { recursive: true });

// 预置：把画像全部曲目放进 recent，制造"池子耗尽"
const profile = JSON.parse(fs.readFileSync(path.join(WORK, 'data/bili-music-profile-2026-10-31.json'), 'utf8'));
const allBvids = (profile.topSongs || []).map((s) => s.bvid).filter(Boolean);
fs.writeFileSync(path.join(dataDir, 'state.json'), JSON.stringify({
  current: null, playedAt: null, cursor: 0, history: [], recent: allBvids, playsSinceOnline: 8,
}), 'utf8');

const plugin = await import(new URL('../index.js', import.meta.url).href + '?v=' + Date.now());
const tools = new Map();
const routes = [];
plugin.apply({
  effect(fn) { return fn(); },
  tools: { register(t) { tools.set(t.name, t); } },
  webServer: { register(e) { routes.push(e); return () => {}; } },
}, {
  dataDir,
  cookieFile: path.join(WORK, '.tmp/bili-music/cookies.json'),
  profileFile: path.join(WORK, 'data/bili-music-profile-2026-10-31.json'),
});

const server = http.createServer((req, res) => {
  const r = routes.find(x => req.url.startsWith(x.path));
  if (!r) { res.writeHead(404); res.end(); return; }
  Promise.resolve(r.handler(req, res)).catch(e => { try { res.writeHead(500); res.end(String(e)); } catch {} });
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;

const out = { recentSeeded: allBvids.length };
const results = [];
for (let i = 0; i < 3; i++) {
  const res = await fetch(`${base}/bili-music/next`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ mode: 'recommend' }),
  });
  const json = await res.json();
  results.push(json.ok
    ? { title: (json.track?.title || '').slice(0, 40), source: json.track?.reason || json.track?.source || '', bvid: json.track?.bvid }
    : { error: json.error });
}
out.results = results;
server.close();
console.log(JSON.stringify(out, null, 2));
