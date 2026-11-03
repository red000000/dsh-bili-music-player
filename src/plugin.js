/**
 * B 站音乐点歌助手 —— Host 半区。
 *
 * 能力：
 *  - 按画像 + 反馈推荐 / 按关键词搜索并播放 B 站音频（192k DASH 轨）
 *  - 软反馈（like / skip / dislike），写本地 feedback.jsonl，参与下一次推荐
 *  - 仅向「代理专属收藏夹」写回（点歌助手，私密），绝不触碰用户既有收藏夹
 *  - /bili-music/stream/<bvid> 音频代理（带 Referer + Range）供浏览器播放
 *
 * 凭据与数据默认放 ~/.dsh/bili-music/，可用 config 覆盖。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

export const name = 'bili-music-player';
export const inject = ['tools', 'webServer'];

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const HEADERS = {
  'User-Agent': UA,
  Referer: 'https://www.bilibili.com/',
  Accept: 'application/json, text/plain, */*',
  'Accept-Language': 'zh-CN,zh;q=0.9',
};

const DEFAULT_FOLDER_TITLE = '点歌助手';

const MIXIN_TAB = [
  46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49,
  33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40,
  61, 26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11,
  36, 20, 34, 44, 52,
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function apply(ctx, config = {}) {
  const base = config.dataDir || path.join(os.homedir(), '.dsh', 'bili-music');
  const cookieFile = config.cookieFile || path.join(base, 'cookies.json');
  const profileFile = config.profileFile || path.join(base, 'profile.json');
  const feedbackFile = path.join(base, 'feedback.jsonl');
  const stateFile = path.join(base, 'state.json');
  const folderFile = path.join(base, 'agent-folder.json');

  fs.mkdirSync(base, { recursive: true });

  // ---------- 存储 ----------
  const readJson = (file, fallback) => {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
  };
  const writeJson = (file, value) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(value, null, 2), { mode: 0o600 });
  };

  const cookies = () => readJson(cookieFile, {});
  const cookieHeader = () => {
    const jar = cookies();
    return Object.entries(jar)
      .filter(([, v]) => v !== undefined && v !== null && String(v) !== '')
      .map(([k, v]) => `${k}=${v}`)
      .join('; ');
  };

  let state = readJson(stateFile, { current: null, playedAt: null });
  const saveState = () => writeJson(stateFile, state);

  // 反馈状态：每首歌只保留一条（最新覆盖），bvid -> { action, at, title, artist, reason }
  const feedbackStateFile = path.join(base, 'feedback.json');
  const readFeedbackState = () => readJson(feedbackStateFile, {});
  const writeFeedbackState = (map) => writeJson(feedbackStateFile, map);

  // 追加式审计流水（便于回放，不参与统计）
  const readFeedbackLog = () => {
    try {
      return fs.readFileSync(feedbackFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
    } catch { return []; }
  };
  const appendFeedbackLog = (rec) => {
    fs.mkdirSync(base, { recursive: true });
    fs.appendFileSync(feedbackFile, JSON.stringify(rec) + '\n', 'utf8');
  };

  // 从旧版追加流水迁移成「每首歌一条状态」（最后一条胜出）
  if (!fs.existsSync(feedbackStateFile)) {
    const rows = readFeedbackLog();
    if (rows.length) {
      const map = {};
      for (const r of rows) if (r && r.bvid) map[r.bvid] = r;
      writeFeedbackState(map);
      console.log(`[bili-music] migrated ${rows.length} feedback rows -> ${Object.keys(map).length} track states`);
    }
  }

  // ---------- B 站请求 ----------
  let wbi = null;
  async function bili(pathname, { params, method = 'GET', body, timeoutMs = 8000 } = {}) {
    const url = new URL(pathname, 'https://api.bilibili.com');
    if (params) for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
    }
    const headers = { ...HEADERS, Cookie: cookieHeader() };
    if (method === 'POST') headers['Content-Type'] = 'application/x-www-form-urlencoded';
    const res = await fetch(url, { method, headers, body, signal: AbortSignal.timeout(timeoutMs) });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* 风控页 */ }
    return { status: res.status, json, text };
  }

  async function getWbiKey() {
    if (wbi && Date.now() - wbi.at < 30 * 60 * 1000) return wbi.key;
    const r = await bili('/x/web-interface/nav');
    const img = r.json?.data?.wbi_img || {};
    const pick = (u) => (String(u).match(/\/([^/]+)\.png/) || [])[1] || '';
    const raw = pick(img.img_url) + pick(img.sub_url);
    const key = MIXIN_TAB.map((i) => raw[i] || '').join('').slice(0, 32);
    wbi = { key, at: Date.now() };
    return key;
  }

  const mapSearch = (list, limit) => list.slice(0, limit).map((it) => ({
    bvid: it.bvid,
    title: String(it.title || '').replace(/<[^>]+>/g, ''),
    author: it.author,
    duration: it.duration,
    play: it.play,
    tname: it.type_name || '',
  }));

  /**
   * 搜索。优先 WBI 接口；它有时会返回 code 0 但 result 为空（风控/签名失配），
   * 这时退回普通接口——否则在线补充永远拿不到歌，推荐就只能回放画像曲。
   */
  const searchCache = new Map(); // `${keyword}|${page}` -> { at, list }
  let wbiBrokenUntil = 0;
  const SEARCH_TTL = 5 * 60 * 1000;

  async function searchMusic(keyword, limit = 10, page = 1) {
    const ck = `${keyword}|${page}`;
    const hit = searchCache.get(ck);
    if (hit && Date.now() - hit.at < SEARCH_TTL) return hit.list.slice(0, limit);
    // WBI 失效后直接走普通接口，避免每次搜索都白打一次
    if (Date.now() < wbiBrokenUntil) return searchPlain(keyword, limit, page);
    try {
      const key = await getWbiKey();
      const params = { search_type: 'video', keyword, page, wts: Math.floor(Date.now() / 1000) };
      const query = Object.keys(params).sort().map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(params[k])}`).join('&');
      params.w_rid = crypto.createHash('md5').update(query + key).digest('hex');
      const r = await bili('/x/web-interface/wbi/search/type', { params });
      const wbiList = mapSearch(r.json?.data?.result || [], limit);
      if (wbiList.length) {
        searchCache.set(ck, { at: Date.now(), list: wbiList });
        if (searchCache.size > 100) searchCache.delete(searchCache.keys().next().value);
        return wbiList;
      }
      wbiBrokenUntil = Date.now() + 10 * 60 * 1000;
      console.error('[bili-music] WBI 搜索为空，改用普通接口', keyword);
    } catch (e) {
      console.error('[bili-music] WBI 搜索失败，改用普通接口', keyword, String(e.message || e));
    }
    return searchPlain(keyword, limit, page, ck);
  }

  async function searchPlain(keyword, limit, page, cacheKey) {
    const ck = cacheKey || `${keyword}|${page}`;
    const hit = searchCache.get(ck);
    if (hit && Date.now() - hit.at < SEARCH_TTL) return hit.list.slice(0, limit);
    const plain = await bili('/x/web-interface/search/type', { params: { search_type: 'video', keyword, page } });
    const list = mapSearch(plain.json?.data?.result || [], limit);
    if (list.length) searchCache.set(ck, { at: Date.now(), list });
    return list;
  }

  async function videoInfo(bvid) {
    const r = await bili('/x/web-interface/view', { params: { bvid, tag: 1 } });
    if (r.json?.code !== 0) throw new Error(`取稿件失败: ${r.json?.message || r.status}`);
    const d = r.json.data;
    return { bvid, aid: d.aid, cid: d.cid, title: d.title, owner: d.owner?.name, duration: d.duration, tname: d.tname, cover: String(d.pic || '').replace(/^http:/, 'https:'), tags: (d.tags || []).map((t) => t.tag_name) };
  }

  // 音频直链缓存：同一 BV 的后续 Range 请求必须命中同一条直链，
  // 否则浏览器会因 Content-Range 总长变化而放弃 seek、跳回开头。
  const streamCache = new Map(); // bvid -> { url, at }
  const STREAM_TTL_MS = 30 * 60 * 1000;

  async function audioStream(bvid, cid, { fresh = false } = {}) {
    const hit = streamCache.get(bvid);
    if (!fresh && hit && Date.now() - hit.at < STREAM_TTL_MS) return hit;

    const r = await bili('/x/player/playurl', { params: { bvid, cid, fnval: 4048, fourk: 1 } });
    const dash = r.json?.data?.dash;
    if (!dash) throw new Error(`取流失败: ${r.json?.message || 'no dash'}`);
    const audios = dash.audio || [];
    if (!audios.length) throw new Error('没有可用音频轨');
    // 固定优先级：30280(192k) > 30232(132k) > 30216(64k)，避免每次解析结果不同
    const rank = (a) => (a.id === 30280 ? 3 : a.id === 30232 ? 2 : a.id === 30216 ? 1 : 0);
    const best = [...audios].sort((a, b) => rank(b) - rank(a) || (b.bandwidth || 0) - (a.bandwidth || 0))[0];
    const urls = [best.baseUrl || best.base_url, ...(best.backupUrl || best.backup_url || [])].filter(Boolean);
    // 多镜像择优：B 站每个音轨通常给 3 个 mirror，不同线路 TTFB 差异很大
    const chosen = urls.length > 1 ? await fastestUrl(urls) : urls[0];
    const rec = { url: chosen, urls, bandwidth: best.bandwidth, id: best.id, at: Date.now() };
    streamCache.set(bvid, rec);
    return rec;
  }

  /** 并发探测各镜像的首包耗时，取第一个成功的；全失败则退回第一个。 */
  async function fastestUrl(urls) {
    const probe = (u) => fetch(u, {
      headers: { 'User-Agent': UA, Referer: 'https://www.bilibili.com/', Range: 'bytes=0-2047' },
      signal: AbortSignal.timeout(6000),
    }).then((r) => {
      try { r.body?.cancel?.(); } catch { /* 忽略 */ }
      if (!r.ok && r.status !== 206) throw new Error(`HTTP ${r.status}`);
      return u;
    });
    try {
      return await Promise.any(urls.map(probe));
    } catch {
      return urls[0];
    }
  }

  // ---------- 本地音频缓存 ----------
  // 把每首歌完整下载到本地后再按 Range 提供，浏览器拿到的是稳定字节流，
  // seek 不再受上游 CDN 抖动/并发/直链过期影响（播放器通行做法）。
  const audioCacheDir = path.join(base, 'cache');
  const downloading = new Map(); // bvid -> Promise<filePath>
  const CACHE_MAX_FILES = 40;

  function pruneCache() {
    try {
      const dir = audioCacheDir;
      // 进程被杀会留下 .part 半成品，超过 1 小时的一律清掉
      const now = Date.now();
      for (const f of fs.readdirSync(dir)) {
        if (!f.endsWith('.part')) continue;
        const p = path.join(dir, f);
        try {
          if (now - fs.statSync(p).mtimeMs > 60 * 60 * 1000) fs.unlinkSync(p);
        } catch { /* 忽略 */ }
      }
      const files = fs.readdirSync(dir)
        .filter((f) => f.endsWith('.m4a'))
        .map((f) => {
          const p = path.join(dir, f);
          return { p, t: fs.statSync(p).mtimeMs };
        })
        .sort((a, b) => a.t - b.t);
      while (files.length > CACHE_MAX_FILES) {
        const old = files.shift();
        try { fs.unlinkSync(old.p); } catch { /* 忽略 */ }
      }
    } catch { /* 忽略 */ }
  }

  /** 下载一次；失败会清掉半成品，由上层决定是否重取直链重试。 */
  async function downloadOnce(bvid, cid, file, fresh) {
    const stream = await audioStream(bvid, cid, { fresh });
    const res = await fetch(stream.url, {
      headers: { 'User-Agent': UA, Referer: 'https://www.bilibili.com/' },
      signal: AbortSignal.timeout(40000),
    });
    if (!res.ok || !res.body) throw new Error(`下载音频失败: HTTP ${res.status}`);
    const part = `${file}.part`;
    const handle = fs.createWriteStream(part);
    let ended = false;
    const endOnce = () => new Promise((resolve) => {
      if (ended) { resolve(); return; }
      ended = true;
      handle.end(resolve);
    });
    try {
      for await (const chunk of res.body) {
        if (!handle.write(chunk)) await new Promise((r) => handle.once('drain', r));
      }
    } catch (e) {
      await endOnce();
      try { fs.unlinkSync(part); } catch { /* 忽略 */ }
      throw e;
    } finally {
      await endOnce();
    }
    if (fs.statSync(part).size < 1024) {
      try { fs.unlinkSync(part); } catch { /* 忽略 */ }
      throw new Error('下载的音频为空');
    }
    fs.renameSync(part, file);
    return file;
  }

  async function ensureAudioFile(bvid, cid) {
    fs.mkdirSync(audioCacheDir, { recursive: true });
    const file = path.join(audioCacheDir, `${bvid}.m4a`);
    // 小于 100KB 视为半截文件，重新下载
    if (fs.existsSync(file) && fs.statSync(file).size > 100 * 1024) return file;
    if (downloading.has(bvid)) return downloading.get(bvid);

    const task = (async () => {
      try {
        return await downloadOnce(bvid, cid, file, false);
      } catch (e1) {
        // 直链可能已过期（默认缓存 30 分钟）：强制重新解析再试一次
        console.error('[bili-music] 首次下载失败，重取直链重试', bvid, String(e1.message || e1));
        return await downloadOnce(bvid, cid, file, true);
      } finally {
        pruneCache();
      }
    })().finally(() => downloading.delete(bvid));

    downloading.set(bvid, task);
    return task;
  }

  // ---------- 分段清单（MSE 边下边播用） ----------
  // B 站音频是 fragmented MP4，自带 sidx 索引：第 N 个分段的字节偏移与时长。
  // 客户端拿到这张表就能「先播 init 段，再按需追加」，不必等整首下载完。
  const manifestCache = new Map(); // bvid -> manifest

  function parseManifest(buf, bvid = '') {
    const boxes = (start, end) => {
      const out = [];
      let o = start;
      while (o + 8 <= end) {
        const size = buf.readUInt32BE(o);
        if (size < 8 || o + size > end) break;
        out.push({ type: buf.toString('ascii', o + 4, o + 8), start: o, size });
        o += size;
      }
      return out;
    };

    const top = boxes(0, buf.length);
    const moov = top.find((b) => b.type === 'moov');
    const sidx = top.find((b) => b.type === 'sidx');
    if (!moov || !sidx) return null;

    const s = sidx.start;
    const version = buf[s + 8];
    const timescale = buf.readUInt32BE(s + 16);
    let o = s + 20;
    const ept = version === 0 ? buf.readUInt32BE(o) : Number(buf.readBigUInt64BE(o));
    o += version === 0 ? 4 : 8;
    const firstOffset = version === 0 ? buf.readUInt32BE(o) : Number(buf.readBigUInt64BE(o));
    o += version === 0 ? 4 : 8;
    o += 2; // reserved
    const count = buf.readUInt16BE(o);
    o += 2;

    const segments = [];
    let pos = s + sidx.size + firstOffset;
    let t = 0;
    for (let i = 0; i < count; i++) {
      const ref = buf.readUInt32BE(o);
      const refSize = ref & 0x7fffffff;
      const dur = buf.readUInt32BE(o + 4);
      o += 12;
      if ((ref >>> 31) === 1) continue; // 只处理 media 分段
      if (refSize <= 0) continue;
      segments.push({ start: pos, end: pos + refSize - 1, tStart: t / timescale, tEnd: (t + dur) / timescale });
      pos += refSize;
      t += dur;
    }
    if (!segments.length || !timescale) return null;

    return {
      ok: true,
      bvid,
      codec: 'mp4a.40.2',
      timescale,
      duration: t / timescale,
      startTime: ept / timescale,
      init: { start: 0, end: s - 1 },
      segments,
    };
  }

  /** 清单优先从本地缓存解析；没有缓存时只取文件头部（moov+sidx），不等整首下载。 */
  async function getManifest(bvid, cid) {
    if (manifestCache.has(bvid)) return manifestCache.get(bvid);
    const file = path.join(audioCacheDir, `${bvid}.m4a`);
    let mf = null;
    if (fs.existsSync(file) && fs.statSync(file).size > 100 * 1024) {
      mf = parseManifest(fs.readFileSync(file), bvid);
    }
    if (!mf) {
      const stream = await audioStream(bvid, cid);
      const res = await fetch(stream.url, {
        headers: { 'User-Agent': UA, Referer: 'https://www.bilibili.com/', Range: 'bytes=0-262143' },
        signal: AbortSignal.timeout(15000),
      });
      if (!res.ok && res.status !== 206) throw new Error(`取头部失败: HTTP ${res.status}`);
      mf = parseManifest(Buffer.from(await res.arrayBuffer()), bvid);
    }
    if (mf) manifestCache.set(bvid, mf);
    return mf;
  }


  // ---------- 代理专属收藏夹（唯一可写目标） ----------
  const folderTitle = config.agentFolderTitle || DEFAULT_FOLDER_TITLE;

  async function agentFolder() {
    const cached = readJson(folderFile, null);
    if (cached?.id && cached.title === folderTitle) return cached;
    const jar = cookies();
    const mid = jar.DedeUserID;
    if (!mid) throw new Error('未登录：先配置 cookie');
    const list = await bili('/x/v3/fav/folder/created/list-all', { params: { up_mid: mid } });
    const found = (list.json?.data?.list || []).find((f) => f.title === folderTitle);
    if (found) {
      const rec = { id: found.id, title: found.title };
      writeJson(folderFile, rec);
      return rec;
    }
    const created = await bili('/x/v3/fav/folder/add', {
      method: 'POST',
      body: new URLSearchParams({ title: folderTitle, privacy: '1', csrf: jar.bili_jct || '' }).toString(),
    });
    if (created.json?.code !== 0) throw new Error(`创建收藏夹失败: ${created.json?.message}`);
    const rec = { id: created.json.data.id, title: folderTitle };
    writeJson(folderFile, rec);
    return rec;
  }

  async function addToAgentFolder(bvid) {
    const folder = await agentFolder();
    const info = await videoInfo(bvid);
    const jar = cookies();
    const r = await bili('/x/v3/fav/resource/deal', {
      method: 'POST',
      body: new URLSearchParams({
        rid: String(info.aid), type: '2', add_media_ids: String(folder.id), del_media_ids: '', csrf: jar.bili_jct || '',
      }).toString(),
    });
    if (r.json?.code !== 0) throw new Error(`收藏失败: ${r.json?.message}`);
    return { folder: folder.title, folderId: folder.id };
  }

  async function removeFromAgentFolder(bvid) {
    const folder = await agentFolder();
    const info = await videoInfo(bvid);
    const jar = cookies();
    const r = await bili('/x/v3/fav/resource/deal', {
      method: 'POST',
      body: new URLSearchParams({
        rid: String(info.aid), type: '2', add_media_ids: '', del_media_ids: String(folder.id), csrf: jar.bili_jct || '',
      }).toString(),
    });
    if (r.json?.code !== 0) throw new Error(`取消收藏失败: ${r.json?.message}`);
    return { folder: folder.title, folderId: folder.id };
  }

  // ---------- 推荐引擎 ----------
  const WEIGHT = { like: 2.0, skip: -0.2, dislike: -1.5 };
  const RECENT_WINDOW = 300; // 去重视野：最近 300 首听过的都不再出现（约等于一整个工作日的听歌量）

  /**
   * 有效画像 = 静态画像文件 + 实时反馈合并。
   *
   * 画像文件由 `tools/bili-music profile` 生成，不会自己变；但反馈必须立即且永久
   * 影响推荐，所以读取时合并：
   *   - like：曲目 +3、歌手 +2；不在画像里的 like 曲目（在线补充发现的）直接补进来
   *   - dislike：曲目剔除、歌手 −3
   * 这样不用重跑工具，反馈也一定生效；重跑工具相当于重新采集 B 站行为，两者互补。
   */
  function profileSummary() {
    const p = readJson(profileFile, null);
    if (!p) return null;
    const fb = readFeedbackState();

    const artistAdj = new Map();
    const likedSongs = new Map();
    for (const [bvid, rec] of Object.entries(fb || {})) {
      if (!rec) continue;
      const name = (rec.artist || '').trim();
      if (name) {
        const delta = rec.action === 'like' ? 2 : rec.action === 'dislike' ? -3 : 0;
        if (delta) artistAdj.set(name, (artistAdj.get(name) || 0) + delta);
      }
      if (rec.action === 'like') likedSongs.set(bvid, rec);
    }

    const artists = (p.topArtists || [])
      .map((a) => ({ ...a, score: (a.score || 0) + (artistAdj.get(a.name) || 0) }))
      .filter((a) => a.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 20)
      .map((a) => ({ name: a.name, score: +a.score.toFixed(2) }));

    const songs = (p.topSongs || [])
      .filter((s) => fb[s.bvid]?.action !== 'dislike')
      .map((s) => ({ ...s, score: (s.score || 0) + (likedSongs.has(s.bvid) ? 3 : 0) }));

    // like 过但画像里没有的曲目（多来自在线补充）也纳入候选
    const known = new Set(songs.map((s) => s.bvid));
    for (const [bvid, rec] of likedSongs) {
      if (known.has(bvid)) continue;
      songs.push({ bvid, title: rec.title, artist: rec.artist, score: 6, confidence: 'high', tags: [] });
    }
    songs.sort((a, b) => b.score - a.score);

    return {
      user: p.user,
      generatedAt: p.generatedAt,
      clusters: (p.clusters || []).slice(0, 6).map((c) => ({ name: c.name, score: c.score })),
      artists,
      songs: songs.slice(0, 80),
      feedbackApplied: Object.keys(fb || {}).length,
    };
  }

  /** 统计基于「每首歌一条状态」：同一首歌改反馈只算最新一条。 */
  function feedbackStats() {
    const map = readFeedbackState();
    const byBvid = new Map();
    const byArtist = new Map();
    for (const [bvid, rec] of Object.entries(map)) {
      if (!bvid || !rec) continue;
      const b = byBvid.get(bvid) || { like: 0, skip: 0, dislike: 0 };
      if (b[rec.action] !== undefined) b[rec.action]++;
      byBvid.set(bvid, b);
      const a = (rec.artist || '').trim();
      if (a) {
        const agg = byArtist.get(a) || { like: 0, dislike: 0 };
        if (rec.action === 'like') agg.like++;
        if (rec.action === 'dislike') agg.dislike++;
        byArtist.set(a, agg);
      }
    }
    return { total: Object.keys(map).length, byBvid, byArtist, map };
  }

  const feedbackOf = (bvid) => (bvid ? readFeedbackState()[bvid]?.action || null : null);

  /**
   * 打分式推荐（不做「最近 N 首硬排除」这种窗口滚动）。
   *
   * 业界做法（Spotify / Pandora 电台）：
   *   1. recency decay：听过越近，分数乘越小，但不禁用
   *   2. 会话级保底：最近 NO_REPEAT 首硬排除，避免刚听完又放
   *   3. artist diversity：同歌手在近期出现过就降权
   *   4. 保留 exploration：由 pickNext 按比例注入「没听过的」
   */
  const NO_REPEAT = 90;       // 会话护栏：最近 90 首绝不重播（画像只有 60 首，等于听过的画像曲不再回放）
  const RECENCY_FLOOR = 0.15; // 衰减下限：再久以前听过的也不会被压到 0
  const ARTIST_RECENT = 5;    // 最近 5 首出现过的歌手降权

  function recommend({ exclude = [] } = {}) {
    const p = profileSummary();
    const stats = feedbackStats();
    const recent = state.recent || [];
    const recentIdx = new Map();
    recent.forEach((bvid, i) => { if (!recentIdx.has(bvid)) recentIdx.set(bvid, i); });
    const recentArtists = new Set(
      (state.history || []).slice(0, ARTIST_RECENT).map((h) => (h.artist || '').trim()).filter(Boolean),
    );
    const pool = [];
    let unheard = 0;

    for (const s of p?.songs || []) {
      if (!s.bvid) continue;
      if (exclude.includes(s.bvid)) continue;
      const idx = recentIdx.get(s.bvid);
      // 硬护栏只保最近 NO_REPEAT 首，其余按「听得多近」打折
      if (idx !== undefined && idx < NO_REPEAT) continue;

      const fb = stats.byBvid.get(s.bvid) || {};
      if (fb.dislike) continue; // dislike 永久排除
      const artistFb = stats.byArtist.get((s.artist || '').trim()) || {};

      let score = (s.score || 1) * (s.confidence === 'low' ? 0.6 : 1);
      score += (fb.like || 0) * WEIGHT.like;
      score += (artistFb.like || 0) * 0.5 - (artistFb.dislike || 0) * 0.8;

      if (idx !== undefined) {
        // 越近越小：idx=NO_REPEAT → 接近 1，越往后趋向下限
        const span = Math.max(1, recent.length - NO_REPEAT);
        const decay = 1 - (idx - NO_REPEAT) / span;
        score *= Math.max(RECENCY_FLOOR, Math.min(1, decay));
      }
      if (recentArtists.has((s.artist || '').trim())) score *= 0.55;

      if (score <= 0) continue;
      if (idx === undefined) unheard++;
      pool.push({ ...s, finalScore: score });
    }
    if (!pool.length) return { pick: null, poolSize: 0, unheard: 0 };
    const total = pool.reduce((acc, x) => acc + x.finalScore, 0);
    let roll = Math.random() * total;
    for (const x of pool) {
      roll -= x.finalScore;
      if (roll <= 0) return { pick: { ...x, source: 'profile' }, poolSize: pool.length, unheard };
    }
    return { pick: { ...pool[0], source: 'profile' }, poolSize: pool.length, unheard };
  }

  // ---------- 在线兜底：画像池不足时按口味搜 B 站 ----------
  const MUSIC_TITLE_RE = /(翻唱|cover|无损|hi-?res|纯享|完整版|歌曲|音乐|演奏|原唱|mv|现场|伴奏)/i;
  const MUSIC_TNAME_RE = /(音乐|翻唱|演奏|mv|vocaloid|乐评|音乐现场|音乐综合)/i;
  // 明显不是「听歌」的标题：教程/解说/剪辑混剪之类，搜索结果里占比不小
  const JUNK_RE = /(教程|教学|申请|攻略|解说|课程|广告|招聘|测评|开箱|直播回放|花絮|混剪|剪辑)/;
  const POOL_MIN = 5;
  // 探索率：即使画像里有候选，也按这个概率优先给「没听过的」
  const EXPLORE_RATE = 0.5;
  // 泛风格词：用来跳出「你的 Top 歌手」这个小圈子
  const GENRE_WORDS = ['华语 歌曲', '粤语 歌', '民谣', '摇滚 现场', '说唱', '纯音乐', '翻唱 高质量', '电音', '经典老歌', '动漫 主题曲'];

  function parseDurationSec(d) {
    if (typeof d === 'number') return d;
    const m = String(d || '').match(/^(\d+):(\d+)$/);
    return m ? Number(m[1]) * 60 + Number(m[2]) : 0;
  }

  /** 候选过滤：时长、类型、垃圾标题、已播/不喜欢 */
  function usableCandidate(r, blocked) {
    if (!r.bvid || blocked.has(r.bvid)) return false;
    if (JUNK_RE.test(r.title || '')) return false;
    const secs = parseDurationSec(r.duration);
    if (secs && (secs < 60 || secs > 900)) return false;
    return MUSIC_TITLE_RE.test(r.title || '') || MUSIC_TNAME_RE.test(r.tname || '');
  }

  /** 相关推荐：拿一首听过/喜欢的歌当种子，找相似但没听过的。 */
  async function relatedCandidates(seedBvid, blocked) {
    try {
      const r = await bili('/x/web-interface/archive/related', { params: { bvid: seedBvid } });
      return (r.json?.data || [])
        .map((it) => ({
          bvid: it.bvid,
          title: String(it.title || '').replace(/<[^>]+>/g, ''),
          author: it.owner?.name || it.author,
          duration: it.duration,
          tname: it.tname || '',
        }))
        .filter((x) => usableCandidate(x, blocked));
    } catch {
      return [];
    }
  }

  async function recommendOnline({ exclude = [] } = {}) {
    const p = profileSummary();
    const stats = feedbackStats();
    const recent = state.recent || [];
    const disliked = new Set();
    for (const [bvid, rec] of Object.entries(stats.map || {})) if (rec && rec.action === 'dislike') disliked.add(bvid);

    const shuffle = (arr) => arr.map((v) => [Math.random(), v]).sort((a, b) => a[0] - b[0]).map((x) => x[1]);
    const artists = (p?.artists || []).slice(0, 15).map((a) => a.name).filter(Boolean);
    const tags = (p?.clusters || []).flatMap((c) => c.tags || []).filter(Boolean);
    const pool = [
      ...shuffle(artists).slice(0, 2),
      ...shuffle(tags).slice(0, 2),
      ...shuffle(GENRE_WORDS).slice(0, 2),
    ];
    const keywords = shuffle([...new Set(pool)]);

    // 严格档：只排除「最近听过」。搜索/相关推荐都先按这一档找，
    // 找不到再放宽——但放宽时要明确记录，方便判断是不是「池子被听穿」。
    const strictBlock = new Set([...exclude, ...recent.slice(0, RECENT_WINDOW), ...disliked]);
    const relaxedBlock = new Set([...exclude, ...recent.slice(0, NO_REPEAT), ...disliked]);

    // 来源 1：相关推荐（种子 = 最近听过的一首，找相似但没听过的）
    if (recent.length && Math.random() < 0.5) {
      const seed = recent[Math.floor(Math.random() * Math.min(recent.length, 60))];
      const rel = await relatedCandidates(seed, strictBlock);
      if (rel.length) {
        const pick = rel[Math.floor(Math.random() * Math.min(rel.length, 4))];
        return { ...pick, source: 'online', keyword: '相关推荐' };
      }
    }

    // 来源 2：搜索（多关键词、随机 1–4 页）
    for (const blocked of [strictBlock, relaxedBlock]) {
      let tried = 0;
      for (const kw of keywords) {
        if (tried >= 3) break;
        tried++;
        const page = 1 + Math.floor(Math.random() * 4);
        try {
          const results = await searchMusic(kw, 20, page);
          const usable = results.filter((r) => usableCandidate(r, blocked));
          if (!usable.length) continue;
          const pick = usable[Math.floor(Math.random() * Math.min(usable.length, 5))];
          return { ...pick, source: 'online', keyword: kw };
        } catch { /* 换下一个关键词 */ }
      }
    }
    return null;
  }

  /**
   * 选下一首。
   * 触发在线补充的两种条件：
   *  1) 画像池快干了（poolSize <= POOL_MIN）
   *  2) 命中探索配额（EXPLORE_RATE）：主动给没听过的
   * 不再依赖「连续 N 首之后才补」，避免节奏固定、体感像循环。
   */
  async function pickNext({ exclude = [], allowOnline = true } = {}) {
    const { pick, poolSize, unheard } = recommend({ exclude });
    // 探索配额：即使还有画像候选，也按 EXPLORE_RATE 优先给没听过的
    const explore = Math.random() < EXPLORE_RATE;
    // 画像里已经没有「完全没听过」的曲目时，优先去在线找，避免回放
    const needOnline = allowOnline && (poolSize <= POOL_MIN || explore || unheard === 0);
    if (!needOnline && pick) return pick;
    const online = await recommendOnline({ exclude });
    if (online) return online;
    return pick || null;
  }

  /**
   * 播放一首歌。
   * - 默认：写入历史头部（cursor=0）
   * - fromHistory：只在历史里移动光标，不改写历史顺序
   */
  async function playBvid(bvid, { reason = '', fromHistory = false, source = 'profile' } = {}) {
    const info = await videoInfo(bvid);
    const stream = await audioStream(bvid, info.cid);
    const track = {
      bvid, aid: info.aid, cid: info.cid, title: info.title, artist: info.owner,
      tname: info.tname, cover: info.cover, tags: info.tags.slice(0, 8), duration: info.duration,
      stream: `/bili-music/stream/${bvid}`, reason,
      feedback: feedbackOf(bvid),
      startedAt: new Date().toISOString(),
    };
    state.current = track;
    state.recent = [bvid, ...(state.recent || []).filter((x) => x !== bvid)].slice(0, RECENT_WINDOW);

    if (fromHistory) {
      const idx = (state.history || []).findIndex((h) => h.bvid === bvid);
      state.cursor = idx >= 0 ? idx : 0;
    } else {
      // 播放历史：保留最近 50 条曲目元数据，供事后挑选反馈
      state.history = [
        { bvid, title: track.title, artist: track.artist, at: track.startedAt, tname: track.tname, duration: track.duration },
        ...(state.history || []).filter((h) => h.bvid !== bvid),
      ].slice(0, 50);
      state.cursor = 0;
      // 在线补充后重置计数，否则会连续触发
      state.playsSinceOnline = source === 'online' ? 0 : (state.playsSinceOnline || 0) + 1;
    }
    saveState();
    // 预取：立刻把整首音频缓存到本地，浏览器请求时直接按 Range 提供
    ensureAudioFile(bvid, info.cid).catch((e) => console.error('[bili-music] 预取失败', bvid, String(e.message || e)));
    if (!fromHistory) fillQueue().catch(() => { /* 补队列失败不影响播放 */ });
    return track;
  }

  async function playByQuery(query) {
    const results = await searchMusic(query, 10);
    if (!results.length) throw new Error(`没有搜到「${query}」`);
    const best = results[0];
    return playBvid(best.bvid, { reason: `搜索「${query}」首条` });
  }

  const historyAt = (i) => (state.history || [])[i];

  /**
   * 播放队列：history 只读（已播记录），queue 才是「接下来播什么」。
   * 这样 ⏭ 永远拿到没听过的歌，不会在历史里来回走。
   */
  const QUEUE_TARGET = 3;
  let filling = false;

  async function fillQueue() {
    state.queue = state.queue || [];
    // 并发保护：播放和 next 可能同时触发补充，否则会塞重复条目
    if (filling) return state.queue;
    filling = true;
    try {
      const queue = state.queue;
      const queued = new Set(queue.map((q) => q.bvid));
      const recent = new Set((state.recent || []).slice(0, RECENT_WINDOW));
      let guard = 0;
      while (state.queue.length < QUEUE_TARGET && guard < 6) {
        guard++;
        const pick = await pickNext({
        exclude: [...queued, ...(state.current ? [state.current.bvid] : [])],
        allowOnline: state.queue.length === 0, // 一次补队列只搜一轮，避免触发风控
      });
        if (!pick || queued.has(pick.bvid) || recent.has(pick.bvid)) break;
        queued.add(pick.bvid);
        state.queue.push({
          bvid: pick.bvid,
          title: pick.title,
          artist: pick.artist || pick.author || '',
          source: pick.source || 'profile',
          keyword: pick.keyword || '',
        });
        saveState();
      }
      return state.queue;
    } finally {
      filling = false;
    }
  }

  /**
   * 下一首 = 消费队列；队列空了现取一首。
   * 队列里的条目可能已失效（稿件被删/版权下架），失败时丢弃并换下一首。
   */
  async function playNext() {
    // 最多尝试 3 次：队列条目失效就丢弃，再取新的
    for (let attempt = 0; attempt < 3; attempt++) {
      const queue = state.queue || [];
      if (queue.length) {
        const item = queue.shift();
        saveState();
        const reason = item.source === 'online' ? `在线补充（${item.keyword || '画像'}）` : '队列下一首';
        try {
          const track = await playBvid(item.bvid, { reason, source: item.source });
          fillQueue().catch(() => {});
          return { track, atEnd: false };
        } catch (e) {
          console.error('[bili-music] 队列条目失效，跳过', item.bvid, String(e.message || e));
          continue;
        }
      }
      const pick = await pickNext({ exclude: state.current ? [state.current.bvid] : [] });
      if (!pick) throw new Error('画像和在线搜索都没有找到可播放的曲目');
      const reason = pick.source === 'online' ? `在线补充（${pick.keyword || '画像'}）` : '连播推荐';
      const track = await playBvid(pick.bvid, { reason, source: pick.source || 'profile' });
      fillQueue().catch(() => {});
      return { track, atEnd: false };
    }
    throw new Error('队列里连续几首都无法播放，请稍后再试');
  }

  /** 上一首：在历史里往更早走一格；到头返回提示。 */
  async function playPrev() {
    const cursor = Number.isInteger(state.cursor) ? state.cursor : 0;
    const prev = historyAt(cursor + 1);
    if (!prev) return { atEnd: true, message: '没有上一首歌了喵', track: state.current };
    return { track: await playBvid(prev.bvid, { reason: '上一首（来自播放历史）', fromHistory: true }), atEnd: false };
  }

  function trackMeta(bvid) {
    if (state.current?.bvid === bvid) return state.current;
    const h = (state.history || []).find((x) => x.bvid === bvid)
      || (state.queue || []).find((x) => x.bvid === bvid);
    return h ? { bvid, title: h.title, artist: h.artist } : { bvid, title: '(未知曲目)', artist: '' };
  }

  function applyFeedback(action, reason = '', targetBvid = '') {
    const bvid = targetBvid || state.current?.bvid;
    if (!bvid) throw new Error('没有可反馈的曲目');
    if (!WEIGHT[action]) throw new Error(`未知反馈: ${action}`);
    const meta = trackMeta(bvid);
    const map = readFeedbackState();
    const prev = map[bvid]?.action || null;
    map[bvid] = {
      at: new Date().toISOString(), bvid, title: meta.title, artist: meta.artist,
      action, reason,
    };
    writeFeedbackState(map);
    appendFeedbackLog({ ...map[bvid], prev: prev || undefined });
    if (action === 'dislike') {
      // 不喜欢要从「最近播放」和「待播队列」里都抹掉，否则排队中的它照样会播
      state.recent = (state.recent || []).filter((x) => x !== bvid);
      state.queue = (state.queue || []).filter((q) => q.bvid !== bvid);
      saveState();
    }
    return {
      action,
      prev,
      changed: prev !== action,
      track: { ...meta, feedback: action },
      stats: { total: Object.keys(map).length, unique: Object.keys(map).length },
    };
  }

  /**
   * 唯一的反馈入口：HTTP 按钮与 agent 工具都走这里。
   * 规则：一首歌只保留一个反馈（可改），同一反馈重复点不会重复计数。
   * like 会写进代理收藏夹；从 like 改成别的会把它撤出收藏夹。
   */
  async function submitFeedback(action, reason = '', targetBvid = '') {
    const bvid = targetBvid || state.current?.bvid;
    if (!bvid) throw new Error('没有可反馈的曲目');
    if (!WEIGHT[action]) throw new Error(`未知反馈: ${action}`);
    const prev = feedbackOf(bvid);
    if (prev === action) {
      return { action, prev, changed: false, duplicated: true, track: { ...trackMeta(bvid), feedback: action }, saved: null };
    }

    let saved = null;
    try {
      if (action === 'like') saved = await addToAgentFolder(bvid);
      else if (prev === 'like') saved = { removed: await removeFromAgentFolder(bvid) };
    } catch (e) {
      saved = { error: String(e.message || e) };
    }
    const result = applyFeedback(action, reason, bvid);
    return { ...result, saved };
  }

  // ---------- HTTP 路由 ----------
  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: '/bili-music',
    handler: async (req, res) => {
      const url = new URL(req.url, 'http://127.0.0.1');
      const send = (code, obj) => {
        res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify(obj));
      };

      if (url.pathname === '/bili-music/state') {
        const s = feedbackStats();
        const map = readFeedbackState();
        const current = state.current
          ? { ...state.current, feedback: feedbackOf(state.current.bvid) }
          : null;
        const history = (state.history || []).slice(0, 50).map((h, i) => ({
          ...h, feedback: map[h.bvid]?.action || null, current: i === (state.cursor || 0),
        }));
        return send(200, { ok: true, current, feedbackTotal: s.total, history, cursor: state.cursor || 0 });
      }
      if (url.pathname === '/bili-music/next' && req.method === 'POST') {
        const chunks = [];
        for await (const c of req) chunks.push(c);
        let body = {};
        try { body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch { /* */ }
        try {
          const out = await playNext({ mode: String(body.mode || 'recommend') });
          return send(200, { ok: true, ...out });
        } catch (e) {
          return send(400, { ok: false, error: String(e.message || e) });
        }
      }
      if (url.pathname === '/bili-music/prev' && req.method === 'POST') {
        try {
          const out = await playPrev();
          return send(200, { ok: true, ...out });
        } catch (e) {
          return send(400, { ok: false, error: String(e.message || e) });
        }
      }
      if (url.pathname === '/bili-music/profile') {
        return send(200, { ok: true, profile: profileSummary(), feedback: { total: feedbackStats().total } });
      }
      if (url.pathname === '/bili-music/feedback' && req.method === 'POST') {
        const chunks = [];
        for await (const c of req) chunks.push(c);
        let body = {};
        try { body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch { /* */ }
        try {
          return send(200, { ok: true, ...(await submitFeedback(String(body.action), String(body.reason || ''), String(body.bvid || ''))) });
        } catch (e) {
          return send(400, { ok: false, error: String(e.message || e) });
        }
      }
      if (url.pathname.startsWith('/bili-music/manifest/')) {
        const bvid = url.pathname.slice('/bili-music/manifest/'.length).replace(/[^A-Za-z0-9]/g, '');
        try {
          const info = await videoInfo(bvid);
          const mf = await getManifest(bvid, info.cid);
          if (!mf) return send(415, { ok: false, error: '该音频没有分段索引，无法边下边播' });
          return send(200, mf);
        } catch (e) {
          return send(502, { ok: false, error: String(e.message || e) });
        }
      }
      if (url.pathname.startsWith('/bili-music/stream/')) {
        const bvid = url.pathname.slice('/bili-music/stream/'.length).replace(/[^A-Za-z0-9]/g, '');
        const range = req.headers.range;
        try {
          const info = await videoInfo(bvid);
          const cachedFile = path.join(audioCacheDir, `${bvid}.m4a`);
          const cachedReady = fs.existsSync(cachedFile) && fs.statSync(cachedFile).size > 100 * 1024;

          // 未缓存：直接把 Range 透传给 CDN（起播快），同时后台落盘做缓存
          if (!cachedReady) {
            ensureAudioFile(bvid, info.cid).catch((e) => console.error('[bili-music] 后台缓存失败', bvid, String(e.message || e)));
            const stream = await audioStream(bvid, info.cid);
            const up = await fetch(stream.url, {
              headers: {
                'User-Agent': UA,
                Referer: 'https://www.bilibili.com/',
                ...(range ? { Range: range } : {}),
              },
              signal: AbortSignal.timeout(30000),
            });
            const len = up.headers.get('content-length');
            res.writeHead(up.status, {
              'content-type': 'audio/mp4',
              ...(len ? { 'content-length': len } : {}),
              ...(up.headers.get('content-range') ? { 'content-range': up.headers.get('content-range') } : {}),
              'accept-ranges': 'bytes',
              'cache-control': 'private, max-age=3600',
            });
            if (up.body) {
              for await (const chunk of up.body) res.write(chunk);
            }
            res.end();
            return;
          }

          const file = cachedFile;
          const size = fs.statSync(file).size;

          // 解析 Range: bytes=start-end
          let start = 0;
          let end = size - 1;
          let partial = false;
          if (range) {
            const m = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
            if (m) {
              partial = true;
              if (m[1] === '' && m[2] !== '') {
                // 后缀范围：最后 N 字节
                const n = Number(m[2]);
                start = Math.max(0, size - n);
                end = size - 1;
              } else {
                start = m[1] === '' ? 0 : Number(m[1]);
                end = m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1);
              }
            }
          }
          if (start > end || start >= size) {
            res.writeHead(416, { 'content-range': `bytes */${size}` });
            res.end();
            return;
          }
          const chunkSize = end - start + 1;

          res.writeHead(partial ? 206 : 200, {
            'content-type': 'audio/mp4',
            'content-length': String(chunkSize),
            'accept-ranges': 'bytes',
            ...(partial ? { 'content-range': `bytes ${start}-${end}/${size}` } : {}),
            'cache-control': 'private, max-age=3600',
          });
          const rs = fs.createReadStream(file, { start, end });
          rs.on('error', () => { try { res.end(); } catch { /* 忽略 */ } });
          rs.pipe(res);
          return;
        } catch (e) {
          return send(502, { ok: false, error: String(e.message || e) });
        }
      }
      // 前端诊断通道：桌面版没有 DevTools 时，把日志写进文件由 agent 读取
      if (url.pathname === '/bili-music/debug' && req.method === 'POST') {
        try {
          const chunks = [];
          for await (const c of req) chunks.push(c);
          const line = Buffer.concat(chunks).toString('utf8').slice(0, 4000);
          fs.mkdirSync(base, { recursive: true });
          const logFile = path.join(base, 'debug.log');
          fs.appendFileSync(logFile, `${new Date().toISOString()} ${line}\n`, 'utf8');
          try {
            const stat = fs.statSync(logFile);
            if (stat.size > 512 * 1024) fs.writeFileSync(logFile, '', 'utf8');
          } catch { /* 忽略 */ }
          return send(200, { ok: true });
        } catch (e) {
          return send(500, { ok: false, error: String(e.message || e) });
        }
      }
      return send(404, { ok: false, error: 'not found' });
    },
  }));

  // ---------- 工具 ----------
  // 用标准 JSON Schema 直接注册，不依赖 @deepseek-ai/dsh-tools 的 defineTool
  const textRender = (_args, value) => [{ type: 'text', text: JSON.stringify(value) }];
  const output = { schema: { type: 'object', additionalProperties: true }, render: textRender };

  ctx.tools.register({
    name: 'bili_music_play',
    description: '播放 B 站音乐。给 query 则搜索并播放；不给则按用户画像与历史反馈推荐一首。返回曲目信息与浏览器播放地址。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: { query: { type: 'string', description: '歌曲名/歌手，可省略' } },
    },
    output,
    async execute(args) {
      const track = args.query ? await playByQuery(String(args.query)) : await (async () => {
        const pick = await pickNext();
        if (!pick) throw new Error('画像和在线搜索都没有找到可播放的曲目');
        return playBvid(pick.bvid, { reason: `推荐：${pick.artist || '未知'} · ${pick.title}`, source: pick.source || 'profile' });
      })();
      return { ok: true, track };
    },
  });

  ctx.tools.register({
    name: 'bili_music_feedback',
    description: '对当前播放曲目给出反馈：like（喜欢，会写入代理专属收藏夹）、skip（跳过）、dislike（不喜欢，永久排除且从待播队列移除）。一首歌只保留一个反馈，可改不可叠；反馈写入 feedback.json 并影响下一次推荐。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['action'],
      properties: {
        action: { type: 'string', enum: ['like', 'skip', 'dislike'], description: '反馈类型' },
        reason: { type: 'string', description: '可选原因' },
      },
    },
    output,
    async execute(args) {
      const result = await submitFeedback(String(args.action), String(args.reason || ''));
      return { ok: true, ...result };
    },
  });

  ctx.tools.register({
    name: 'bili_music_status',
    description: '查看点歌助手状态：当前曲目、画像摘要、反馈统计。',
    parameters: { type: 'object', additionalProperties: false, properties: {} },
    output,
    async execute() {
      const map = readFeedbackState();
      return {
        ok: true,
        current: state.current ? { ...state.current, feedback: feedbackOf(state.current.bvid) } : null,
        profile: profileSummary(),
        feedback: { total: feedbackStats().total },
        history: (state.history || []).slice(0, 20).map((h) => ({ ...h, feedback: map[h.bvid]?.action || null })),
        paths: { base, cookieFile, profileFile, feedbackFile },
      };
    },
  });

  ctx.tools.register({
    name: 'bili_music_import',
    description: '导入 B 站登录 cookie 与画像文件到插件数据目录（从给定绝对路径复制），让点歌助手可用。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        cookieFile: { type: 'string', description: 'cookies.json 的绝对路径' },
        profileFile: { type: 'string', description: '画像 JSON 的绝对路径（可选）' },
      },
    },
    output,
    async execute(args) {
      const out = { ok: true, imported: [] };
      if (args.cookieFile) {
        const src = String(args.cookieFile);
        const raw = fs.readFileSync(src, 'utf8');
        JSON.parse(raw);
        fs.mkdirSync(path.dirname(cookieFile), { recursive: true });
        fs.writeFileSync(cookieFile, raw, { mode: 0o600 });
        out.imported.push({ kind: 'cookie', to: cookieFile });
      }
      if (args.profileFile) {
        const src = String(args.profileFile);
        const raw = fs.readFileSync(src, 'utf8');
        JSON.parse(raw);
        fs.mkdirSync(path.dirname(profileFile), { recursive: true });
        fs.writeFileSync(profileFile, raw);
        out.imported.push({ kind: 'profile', to: profileFile });
      }
      out.status = { cookie: fs.existsSync(cookieFile), profile: fs.existsSync(profileFile) };
      return out;
    },
  });
}
