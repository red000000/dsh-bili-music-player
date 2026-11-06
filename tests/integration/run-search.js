import fs from 'node:fs';
import path from 'node:path';

const WORK = 'C:/Users/Qq320/work';
const dataDir = path.join(WORK, '.tmp/search-test');
fs.rmSync(dataDir, { recursive: true, force: true });
fs.mkdirSync(dataDir, { recursive: true });

const plugin = await import(new URL('../../index.js', import.meta.url).href + '?v=' + Date.now());
const tools = new Map();
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
      register() {
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

for (const q of ['周杰伦 稻香', '音乐', '陈奕迅']) {
  try {
    const r = await tools.get('bili_music_play').execute({ query: q }, {});
    console.log(q, '=> OK', r.track.bvid, r.track.title.slice(0, 30));
  } catch (e) {
    console.log(q, '=> FAIL', String(e.message || e));
  }
}
