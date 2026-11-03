/**
 * 量化「推荐里有多少是听过的」。
 *
 * 用真实的 state.json（recent/feedback）跑 N 次 /next，统计：
 *   - 来源（连播推荐 / 在线补充）
 *   - bvid 是否在 recent 里、排在多近
 *   - 标题是否重复出现
 */
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';

const WORK = 'C:/Users/Qq320/work';
const HOME = path.join(process.env.USERPROFILE, '.dsh/bili-music');
const dataDir = path.join(WORK, '.tmp/sim-picks');
fs.rmSync(dataDir, { recursive: true, force: true });
fs.mkdirSync(dataDir, { recursive: true });

// 复用真实状态：recent / feedback / profile
for (const f of ['state.json', 'feedback.json', 'profile.json']) {
  const src = path.join(HOME, f);
  if (fs.existsSync(src)) fs.copyFileSync(src, path.join(dataDir, f));
}
const real = JSON.parse(fs.readFileSync(path.join(dataDir, 'state.json'), 'utf8'));
const recentIdx = new Map();
(real.recent || []).forEach((b, i) => { if (!recentIdx.has(b)) recentIdx.set(b, i); });
console.log('recent =', (real.recent || []).length, '| history =', (real.history || []).length);

const plugin = await import(new URL('../index.js', import.meta.url).href + '?v=' + Date.now());
const routes = [];
plugin.apply({
  effect(fn) { return fn(); },
  tools: { register() {} },
  webServer: { register(e) { routes.push(e); return () => {}; } },
}, {
  dataDir,
  cookieFile: path.join(HOME, 'cookies.json'),
  profileFile: path.join(HOME, 'profile.json'),
});

const server = http.createServer((req, res) => {
  const r = routes.find((x) => req.url.startsWith(x.path));
  if (!r) { res.writeHead(404); res.end(); return; }
  Promise.resolve(r.handler(req, res)).catch((e) => { try { res.writeHead(500); res.end(String(e)); } catch { /* 忽略 */ } });
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;

const rows = [];
for (let i = 0; i < 12; i++) {
  const res = await fetch(base + '/bili-music/next', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  const j = await res.json().catch(() => ({}));
  if (!j.ok) { rows.push({ i, error: j.error }); continue; }
  const t = j.track;
  const idx = recentIdx.get(t.bvid);
  rows.push({
    i,
    source: (t.reason || '').startsWith('在线补充') ? 'online' : 'profile',
    bvid: t.bvid,
    heard: idx !== undefined,
    recentIdx: idx ?? null,
    title: String(t.title).slice(0, 34),
  });
}

server.close();
const heard = rows.filter((r) => r.heard).length;
const uniq = new Set(rows.map((r) => r.bvid)).size;
console.log(JSON.stringify({
  picks: rows.length,
  heard,
  heardRate: +(heard / rows.length * 100).toFixed(1),
  unique: uniq,
  bySource: rows.reduce((a, r) => { a[r.source] = (a[r.source] || 0) + 1; return a; }, {}),
  rows,
}, null, 2));
