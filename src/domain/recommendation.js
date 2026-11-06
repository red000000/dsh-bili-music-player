/**
 * 推荐领域逻辑：把画像、反馈与播放历史合成「下一首放什么」。
 * 只做规则判断，I/O 由调用方注入（搜索、相关推荐、状态读写）。
 */

const WEIGHT = { like: 2.0, skip: -0.2, dislike: -1.5 };
export const RECENT_WINDOW = 300; // 去重视野：约一整个工作日的听歌量
const NO_REPEAT = 90; // 会话护栏：最近 90 首绝不重播
const RECENCY_FLOOR = 0.15; // 衰减下限：再久以前听过的也不会被压到 0
const ARTIST_RECENT = 5; // 最近 5 首出现过的歌手降权
const POOL_MIN = 5;
const EXPLORE_RATE = 0.5; // 探索配额：主动给没听过的比例
export const MIN_TRACK_SEC = 45; // 过短多为切片
export const MAX_TRACK_SEC = 30 * 60; // 古风长曲、现场、组曲

const MUSIC_TITLE_RE = /(翻唱|cover|无损|hi-?res|纯享|完整版|歌曲|音乐|演奏|原唱|mv|现场|伴奏)/i;
const MUSIC_TNAME_RE = /(音乐|翻唱|演奏|mv|vocaloid|乐评|音乐现场|音乐综合)/i;
// 明显不是「听歌」的标题：教程/解说/剪辑混剪之类，搜索结果里占比不小
const JUNK_RE = /(教程|教学|申请|攻略|解说|课程|广告|招聘|测评|开箱|直播回放|花絮|混剪|剪辑)/;
// 泛风格词：用来跳出「你的 Top 歌手」这个小圈子
const GENRE_WORDS = [
  '华语 歌曲',
  '粤语 歌',
  '民谣',
  '摇滚 现场',
  '说唱',
  '纯音乐',
  '翻唱 高质量',
  '电音',
  '经典老歌',
  '动漫 主题曲',
];

/** 把 "3:45" 或秒数统一成秒。 */
export function isInDurationRange(duration) {
  const seconds = parseDurationSec(duration);
  return !seconds || (seconds >= MIN_TRACK_SEC && seconds <= MAX_TRACK_SEC);
}

export function parseDurationSec(duration) {
  if (typeof duration === 'number') return duration;
  const match = String(duration || '').match(/^(\d+):(\d+)$/);
  return match ? Number(match[1]) * 60 + Number(match[2]) : 0;
}

export function createRecommendation({ store, state, searchMusic, fetchRelated }) {
  /**
   * 有效画像 = 静态画像文件 + 实时反馈合并。
   * like 抬分并入池，dislike 剔除；这样不用重跑采集工具，反馈也一定生效。
   */
  function profileSummary() {
    const profile = store.readProfile();
    if (!profile) return null;
    const feedback = store.readFeedbackState();

    const artistAdj = new Map();
    const likedSongs = new Map();
    for (const [bvid, record] of Object.entries(feedback || {})) {
      if (!record) continue;
      const name = (record.artist || '').trim();
      if (name) {
        const delta = record.action === 'like' ? 2 : record.action === 'dislike' ? -3 : 0;
        if (delta) artistAdj.set(name, (artistAdj.get(name) || 0) + delta);
      }
      if (record.action === 'like') likedSongs.set(bvid, record);
    }

    const artists = (profile.topArtists || [])
      .map((artist) => ({
        ...artist,
        score: (artist.score || 0) + (artistAdj.get(artist.name) || 0),
      }))
      .filter((artist) => artist.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 20)
      .map((artist) => ({ name: artist.name, score: +artist.score.toFixed(2) }));

    const songs = (profile.topSongs || [])
      .filter((song) => feedback[song.bvid]?.action !== 'dislike')
      .map((song) => ({ ...song, score: (song.score || 0) + (likedSongs.has(song.bvid) ? 3 : 0) }));

    // like 过但画像里没有的曲目（多来自在线补充）也纳入候选
    const known = new Set(songs.map((song) => song.bvid));
    for (const [bvid, record] of likedSongs) {
      if (known.has(bvid)) continue;
      songs.push({
        bvid,
        title: record.title,
        artist: record.artist,
        score: 6,
        confidence: 'high',
        tags: [],
      });
    }
    songs.sort((a, b) => b.score - a.score);

    return {
      user: profile.user,
      generatedAt: profile.generatedAt,
      clusters: (profile.clusters || []).slice(0, 6).map(({ name, score }) => ({ name, score })),
      artists,
      songs: songs.slice(0, 80),
      feedbackApplied: Object.keys(feedback || {}).length,
    };
  }

  /** 统计基于「每首歌一条状态」：同一首歌改反馈只算最新一条。 */
  function feedbackStats() {
    const map = store.readFeedbackState();
    const byBvid = new Map();
    const byArtist = new Map();
    for (const [bvid, record] of Object.entries(map)) {
      if (!bvid || !record) continue;
      const songStat = byBvid.get(bvid) || { like: 0, skip: 0, dislike: 0 };
      if (songStat[record.action] !== undefined) songStat[record.action]++;
      byBvid.set(bvid, songStat);
      const artist = (record.artist || '').trim();
      if (artist) {
        const artistStat = byArtist.get(artist) || { like: 0, dislike: 0 };
        if (record.action === 'like') artistStat.like++;
        if (record.action === 'dislike') artistStat.dislike++;
        byArtist.set(artist, artistStat);
      }
    }
    return { total: Object.keys(map).length, byBvid, byArtist, map };
  }

  const feedbackOf = (bvid) => (bvid ? store.readFeedbackState()[bvid]?.action || null : null);

  /**
   * 打分式推荐，不做「最近 N 首硬排除」的窗口滚动：
   * 近期性衰减、会话护栏（最近 NO_REPEAT）、歌手多样性、按分数加权抽样。
   */
  function recommend({ exclude = [] } = {}) {
    const profile = profileSummary();
    const stats = feedbackStats();
    const recent = state.recent || [];
    const recentIdx = new Map();
    recent.forEach((bvid, index) => {
      if (!recentIdx.has(bvid)) recentIdx.set(bvid, index);
    });
    const recentArtists = new Set(
      (state.history || [])
        .slice(0, ARTIST_RECENT)
        .map((entry) => (entry.artist || '').trim())
        .filter(Boolean),
    );
    const pool = [];
    let unheard = 0;

    for (const song of profile?.songs || []) {
      if (!song.bvid) continue;
      if (exclude.includes(song.bvid)) continue;
      const idx = recentIdx.get(song.bvid);
      if (idx !== undefined && idx < NO_REPEAT) continue; // 会话护栏

      const songFeedback = stats.byBvid.get(song.bvid) || {};
      if (songFeedback.dislike) continue; // dislike 永久排除
      const artistFeedback = stats.byArtist.get((song.artist || '').trim()) || {};

      let score = (song.score || 1) * (song.confidence === 'low' ? 0.6 : 1);
      score += (songFeedback.like || 0) * WEIGHT.like;
      score += (artistFeedback.like || 0) * 0.5 - (artistFeedback.dislike || 0) * 0.8;

      if (idx !== undefined) {
        const span = Math.max(1, recent.length - NO_REPEAT);
        const decay = 1 - (idx - NO_REPEAT) / span;
        score *= Math.max(RECENCY_FLOOR, Math.min(1, decay));
      }
      if (recentArtists.has((song.artist || '').trim())) score *= 0.55;

      if (score <= 0) continue;
      if (idx === undefined) unheard++;
      pool.push({ ...song, finalScore: score });
    }

    if (!pool.length) return { pick: null, poolSize: 0, unheard: 0 };
    const total = pool.reduce((sum, item) => sum + item.finalScore, 0);
    let roll = Math.random() * total;
    for (const item of pool) {
      roll -= item.finalScore;
      if (roll <= 0)
        return { pick: { ...item, source: 'profile' }, poolSize: pool.length, unheard };
    }
    return { pick: { ...pool[0], source: 'profile' }, poolSize: pool.length, unheard };
  }

  /** 候选过滤：时长、类型、垃圾标题、已播/不喜欢。 */
  function usableCandidate(candidate, blocked) {
    if (!candidate.bvid || blocked.has(candidate.bvid)) return false;
    if (JUNK_RE.test(candidate.title || '')) return false;
    const seconds = parseDurationSec(candidate.duration);
    if (seconds && (seconds < MIN_TRACK_SEC || seconds > MAX_TRACK_SEC)) return false;
    return MUSIC_TITLE_RE.test(candidate.title || '') || MUSIC_TNAME_RE.test(candidate.tname || '');
  }

  /** 在线候选：相关推荐优先，其次多关键词搜索，严格档失败才放宽。 */
  async function recommendOnline({ exclude = [] } = {}) {
    const profile = profileSummary();
    const stats = feedbackStats();
    const recent = state.recent || [];
    const disliked = new Set();
    for (const [bvid, record] of Object.entries(stats.map || {})) {
      if (record && record.action === 'dislike') disliked.add(bvid);
    }

    const shuffle = (list) =>
      list
        .map((value) => [Math.random(), value])
        .sort((a, b) => a[0] - b[0])
        .map(([, value]) => value);
    const artists = (profile?.artists || [])
      .slice(0, 15)
      .map((artist) => artist.name)
      .filter(Boolean);
    const tags = (profile?.clusters || []).flatMap((cluster) => cluster.tags || []).filter(Boolean);
    const keywords = shuffle([
      ...new Set([
        ...shuffle(artists).slice(0, 2),
        ...shuffle(tags).slice(0, 2),
        ...shuffle(GENRE_WORDS).slice(0, 2),
      ]),
    ]);

    // 严格档只排除「最近听过」；找不到再放宽到 NO_REPEAT 档。
    const strictBlock = new Set([...exclude, ...recent.slice(0, RECENT_WINDOW), ...disliked]);
    const relaxedBlock = new Set([...exclude, ...recent.slice(0, NO_REPEAT), ...disliked]);

    if (recent.length && Math.random() < 0.5) {
      const seed = recent[Math.floor(Math.random() * Math.min(recent.length, 60))];
      // 相关推荐给的是传输层形状，能不能用是领域规则，过滤留在这里
      const candidates = await fetchRelated(seed).catch(() => []);
      const usable = candidates.filter((candidate) => usableCandidate(candidate, strictBlock));
      if (usable.length) {
        const pick = usable[Math.floor(Math.random() * Math.min(usable.length, 4))];
        return { ...pick, source: 'online', keyword: '相关推荐' };
      }
    }

    for (const blocked of [strictBlock, relaxedBlock]) {
      let tried = 0;
      for (const keyword of keywords) {
        if (tried >= 3) break;
        tried++;
        const page = 1 + Math.floor(Math.random() * 4);
        try {
          const results = await searchMusic(keyword, 20, page);
          const usable = results.filter((candidate) => usableCandidate(candidate, blocked));
          if (!usable.length) continue;
          const pick = usable[Math.floor(Math.random() * Math.min(usable.length, 5))];
          return { ...pick, source: 'online', keyword };
        } catch {
          /* 换下一个关键词 */
        }
      }
    }
    return null;
  }

  /** 画像池快干了，或命中探索配额，就去在线找；都没有时退回画像候选。 */
  async function pickNext({ exclude = [], allowOnline = true } = {}) {
    const { pick, poolSize, unheard } = recommend({ exclude });
    const explore = Math.random() < EXPLORE_RATE;
    const needOnline = allowOnline && (poolSize <= POOL_MIN || explore || unheard === 0);
    if (!needOnline && pick) return pick;
    const online = await recommendOnline({ exclude });
    if (online) return online;
    return pick || null;
  }

  return {
    profileSummary,
    feedbackStats,
    feedbackOf,
    recommend,
    recommendOnline,
    pickNext,
    usableCandidate,
    parseDurationSec,
  };
}
