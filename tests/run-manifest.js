/**
 * 回归：MSE 分段清单与按段取流。
 * 验证 /manifest 返回的 init / segments 与实际 Range 响应一致。
 */
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';

const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\//, ''));
const WORK = 'C:/Users/Qq320/work';
const dataDir = path.join(WORK, '.tmp/manifest-test');
fs.rmSync(dataDir, { recursive: true, force: true });
fs.mkdirSync(dataDir, { recursive: true });

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
  const r = routes.find((x) => req.url.startsWith(x.path));
  if (!r) { res.writeHead(404); res.end(); return; }
  Promise.resolve(r.handler(req, res)).catch((e) => { try { res.writeHead(500); res.end(String(e)); } catch { /* 忽略 */ } });
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;

const played = await tools.get('bili_music_play').execute({ query: '周杰伦 稻香' }, {});
const bvid = played.track.bvid;

const t0 = Date.now();
const mfRes = await fetch(`${base}/bili-music/manifest/${bvid}`);
const mfText = await mfRes.text();
const mf = JSON.parse(mfText);
const manifestMs = Date.now() - t0;
if (!mf.init) {
  console.log('RAW:', mfRes.status, mfText.slice(0, 300));
  process.exit(1);
}

const initRes = await fetch(`${base}/bili-music/stream/${bvid}`, { headers: { Range: `bytes=${mf.init.start}-${mf.init.end}` } });
const initBuf = await initRes.arrayBuffer();
const seg = mf.segments[0];
const segRes = await fetch(`${base}/bili-music/stream/${bvid}`, { headers: { Range: `bytes=${seg.start}-${seg.end}` } });
const segBuf = await segRes.arrayBuffer();
const last = mf.segments[mf.segments.length - 1];
const lastRes = await fetch(`${base}/bili-music/stream/${bvid}`, { headers: { Range: `bytes=${last.start}-${last.end}` } });
const lastBuf = await lastRes.arrayBuffer();

server.close();
console.log(JSON.stringify({
  bvid,
  manifestMs,
  codec: mf.codec,
  duration: +Number(mf.duration).toFixed(2),
  segments: mf.segments.length,
  initBytes: initBuf.byteLength,
  initExpected: mf.init.end - mf.init.start + 1,
  seg0Bytes: segBuf.byteLength,
  seg0Expected: seg.end - seg.start + 1,
  seg0Range: `${seg.tStart.toFixed(2)}-${seg.tEnd.toFixed(2)}s`,
  lastBytes: lastBuf.byteLength,
  lastExpected: last.end - last.start + 1,
  lastRange: `${last.tStart.toFixed(2)}-${last.tEnd.toFixed(2)}s`,
  statuses: { init: initRes.status, seg: segRes.status, last: lastRes.status },
}, null, 2));
