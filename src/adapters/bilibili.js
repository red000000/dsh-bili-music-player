import crypto from 'node:crypto';

export const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

const HEADERS = {
  'User-Agent': USER_AGENT,
  Referer: 'https://www.bilibili.com/',
  Accept: 'application/json, text/plain, */*',
  'Accept-Language': 'zh-CN,zh;q=0.9',
};

// WBI 签名用的重排表（B 站前端同款），用于给搜索、导航等接口签名。
const MIXIN_TAB = [
  46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49, 33, 9, 42, 19, 29, 28,
  14, 39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40, 61, 26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54,
  21, 56, 59, 6, 63, 57, 62, 11, 36, 20, 34, 44, 52,
];

const mapSearch = (list, limit) =>
  list.slice(0, limit).map((item) => ({
    bvid: item.bvid,
    title: String(item.title || '').replace(/<[^>]+>/g, ''),
    author: item.author,
    duration: item.duration,
    play: item.play,
    tname: item.type_name || '',
  }));

/**
 * B 站 API 适配器：登录态由调用方注入，本模块只负责发请求、签名与字段归一化。
 * 返回的搜索结果、稿件信息都是传输层形状，业务过滤留给领域层。
 *
 * @param {{cookieHeader: () => string, userAgent?: string}} deps
 */
export function createBilibili({ cookieHeader, userAgent = USER_AGENT }) {
  let wbi = null;
  const searchCache = new Map(); // `${keyword}|${page}` -> { at, list }
  const streamCache = new Map(); // bvid -> { url, at }
  const SEARCH_TTL = 5 * 60 * 1000;
  const STREAM_TTL_MS = 30 * 60 * 1000;
  let wbiBrokenUntil = 0;

  async function requestBili(pathname, { params, method = 'GET', body, timeoutMs = 8000 } = {}) {
    const url = new URL(pathname, 'https://api.bilibili.com');
    if (params) {
      for (const [key, value] of Object.entries(params)) {
        if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
      }
    }
    const headers = { ...HEADERS, 'User-Agent': userAgent, Cookie: cookieHeader() };
    if (method === 'POST') headers['Content-Type'] = 'application/x-www-form-urlencoded';
    const res = await fetch(url, { method, headers, body, signal: AbortSignal.timeout(timeoutMs) });
    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      /* 风控页不是 JSON */
    }
    return { status: res.status, json, text };
  }

  async function getWbiKey() {
    if (wbi && Date.now() - wbi.at < 30 * 60 * 1000) return wbi.key;
    const res = await requestBili('/x/web-interface/nav');
    const img = res.json?.data?.wbi_img || {};
    const pick = (url) => (String(url).match(/\/([^/]+)\.png/) || [])[1] || '';
    const raw = pick(img.img_url) + pick(img.sub_url);
    const key = MIXIN_TAB.map((i) => raw[i] || '')
      .join('')
      .slice(0, 32);
    wbi = { key, at: Date.now() };
    return key;
  }

  /**
   * 搜索。优先 WBI 接口；它有时返回 code 0 但结果为空（风控或签名失配），
   * 这时退回普通接口——否则在线补充永远拿不到歌，推荐只能回放画像曲。
   */
  async function searchMusic(keyword, limit = 10, page = 1) {
    const cacheKey = `${keyword}|${page}`;
    const hit = searchCache.get(cacheKey);
    if (hit && Date.now() - hit.at < SEARCH_TTL) return hit.list.slice(0, limit);
    if (Date.now() < wbiBrokenUntil) return searchPlain(keyword, limit, page);
    try {
      const key = await getWbiKey();
      const params = { search_type: 'video', keyword, page, wts: Math.floor(Date.now() / 1000) };
      const query = Object.keys(params)
        .sort()
        .map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(params[k])}`)
        .join('&');
      params.w_rid = crypto
        .createHash('md5')
        .update(query + key)
        .digest('hex');
      const res = await requestBili('/x/web-interface/wbi/search/type', { params });
      const list = mapSearch(res.json?.data?.result || [], limit);
      if (list.length) {
        searchCache.set(cacheKey, { at: Date.now(), list });
        if (searchCache.size > 100) searchCache.delete(searchCache.keys().next().value);
        return list;
      }
      wbiBrokenUntil = Date.now() + 10 * 60 * 1000;
      console.error('[bili-music] WBI 搜索为空，改用普通接口', keyword);
    } catch (error) {
      console.error(
        '[bili-music] WBI 搜索失败，改用普通接口',
        keyword,
        String(error.message || error),
      );
    }
    return searchPlain(keyword, limit, page, cacheKey);
  }

  async function searchPlain(keyword, limit, page, cacheKey) {
    const key = cacheKey || `${keyword}|${page}`;
    const hit = searchCache.get(key);
    if (hit && Date.now() - hit.at < SEARCH_TTL) return hit.list.slice(0, limit);
    const res = await requestBili('/x/web-interface/search/type', {
      params: { search_type: 'video', keyword, page },
    });
    const list = mapSearch(res.json?.data?.result || [], limit);
    if (list.length) searchCache.set(key, { at: Date.now(), list });
    return list;
  }

  async function fetchVideoInfo(bvid) {
    const res = await requestBili('/x/web-interface/view', { params: { bvid, tag: 1 } });
    if (res.json?.code !== 0) throw new Error(`取稿件失败: ${res.json?.message || res.status}`);
    const data = res.json.data;
    return {
      bvid,
      aid: data.aid,
      cid: data.cid,
      title: data.title,
      owner: data.owner?.name,
      duration: data.duration,
      tname: data.tname,
      cover: String(data.pic || '').replace(/^http:/, 'https:'),
      tags: (data.tags || []).map((t) => t.tag_name),
    };
  }

  /** 并发探测各镜像首包耗时，取第一个成功的；全失败退回第一个。 */
  async function pickFastestUrl(urls) {
    const probe = (url) =>
      fetch(url, {
        headers: {
          'User-Agent': userAgent,
          Referer: 'https://www.bilibili.com/',
          Range: 'bytes=0-2047',
        },
        signal: AbortSignal.timeout(6000),
      }).then((res) => {
        try {
          res.body?.cancel?.();
        } catch {
          /* 忽略 */
        }
        if (!res.ok && res.status !== 206) throw new Error(`HTTP ${res.status}`);
        return url;
      });
    try {
      return await Promise.any(urls.map(probe));
    } catch {
      return urls[0];
    }
  }

  /**
   * 音频直链：同一 BV 的后续 Range 请求必须命中同一条直链，
   * 否则浏览器会因 Content-Range 总长变化而放弃 seek。
   */
  async function fetchAudioStream(bvid, cid, { fresh = false } = {}) {
    const hit = streamCache.get(bvid);
    if (!fresh && hit && Date.now() - hit.at < STREAM_TTL_MS) return hit;

    const res = await requestBili('/x/player/playurl', {
      params: { bvid, cid, fnval: 4048, fourk: 1 },
    });
    const dash = res.json?.data?.dash;
    if (!dash) throw new Error(`取流失败: ${res.json?.message || 'no dash'}`);
    const audios = dash.audio || [];
    if (!audios.length) throw new Error('没有可用音频轨');
    const rank = (track) =>
      track.id === 30280 ? 3 : track.id === 30232 ? 2 : track.id === 30216 ? 1 : 0;
    const best = [...audios].sort(
      (a, b) => rank(b) - rank(a) || (b.bandwidth || 0) - (a.bandwidth || 0),
    )[0];
    const urls = [
      best.baseUrl || best.base_url,
      ...(best.backupUrl || best.backup_url || []),
    ].filter(Boolean);
    const chosen = urls.length > 1 ? await pickFastestUrl(urls) : urls[0];
    const record = { url: chosen, urls, bandwidth: best.bandwidth, id: best.id, at: Date.now() };
    streamCache.set(bvid, record);
    return record;
  }

  /** 相关推荐：以一首歌为种子找相似稿件，返回未过滤的传输层形状。 */
  async function fetchRelated(bvid) {
    const res = await requestBili('/x/web-interface/archive/related', { params: { bvid } });
    return (res.json?.data || []).map((item) => ({
      bvid: item.bvid,
      title: String(item.title || '').replace(/<[^>]+>/g, ''),
      author: item.owner?.name || item.author,
      duration: item.duration,
      tname: item.tname || '',
    }));
  }

  return {
    requestBili,
    getWbiKey,
    searchMusic,
    fetchVideoInfo,
    fetchAudioStream,
    pickFastestUrl,
    fetchRelated,
  };
}
