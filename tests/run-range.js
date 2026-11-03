/**
 * 针对性测试：本地音频缓存 + Range 语义（seek 的关键）。
 * 覆盖：首次请求触发下载 → 200 全量 → 206 分段 → 206 后缀范围 → 416 越界。
 */
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';

const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\//, ''));
const WORK = 'C:/Users/Qq320/work';

const plugin = await import(new URL('../index.js', import.meta.url).href + '?v=' + Date.now());

const tools = new Map();
const routes = [];
plugin.apply({
  effect(fn) { return fn(); },
  tools: { register(t) { tools.set(t.name, t); } },
  webServer: { register(e) { routes.push(e); return () => {}; } },
}, {
  dataDir: path.join(WORK, '.tmp/plugin-test/data3'),
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

const play = await tools.get('bili_music_play').execute({ query: '周杰伦 稻香' }, {});
const bvid = play.track.bvid;

const grab = async (headers) => {
  const r = await fetch(`${base}/bili-music/stream/${bvid}`, { headers });
  const buf = await r.arrayBuffer();
  return { status: r.status, len: Number(r.headers.get('content-length')), range: r.headers.get('content-range'), bytes: buf.byteLength, type: r.headers.get('content-type') };
};

const out = {};
const t0 = Date.now();
out.firstFull = await grab({});
out.firstFullMs = Date.now() - t0;
out.partial = await grab({ Range: 'bytes=1000-1999' });
out.suffix = await grab({ Range: 'bytes=-500' });
out.beyond = await grab({ Range: `bytes=99999999-` });
out.secondFullFast = (await (async () => { const s = Date.now(); const r = await grab({}); return { ms: Date.now() - s, status: r.status, bytes: r.bytes }; })());

const cacheDir = path.join(WORK, '.tmp/plugin-test/data3/cache');
out.cachedFiles = fs.existsSync(cacheDir) ? fs.readdirSync(cacheDir) : [];

server.close();
console.log(JSON.stringify(out, null, 2));
