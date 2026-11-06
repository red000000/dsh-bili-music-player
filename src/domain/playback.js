/**
 * 播放领域逻辑：当前曲、播放历史、待播队列与上下首切换。
 * 不直接发请求也不写文件——稿件信息、音频缓存、状态持久化都由调用方注入。
 */

const HISTORY_LIMIT = 50;
const QUEUE_TARGET = 3;
const QUEUE_FILL_GUARD = 6;

export function createPlayback({
  state,
  saveState,
  fetchVideoInfo,
  fetchAudioStream,
  ensureAudioFile,
  searchMusic,
  pickNext,
  feedbackOf,
  isInDurationRange,
  recentWindow,
  queueTarget = QUEUE_TARGET,
}) {
  const historyAt = (index) => (state.history || [])[index];

  /** 历史、队列里都能查到元数据；都没有时给占位标题。 */
  function trackMetadata(bvid) {
    if (state.current?.bvid === bvid) return state.current;
    const known =
      (state.history || []).find((entry) => entry.bvid === bvid) ||
      (state.queue || []).find((entry) => entry.bvid === bvid);
    return known
      ? { bvid, title: known.title, artist: known.artist }
      : { bvid, title: '(未知曲目)', artist: '' };
  }

  /**
   * 补队列：history 只读，queue 才是「接下来播什么」，
   * 这样 ⏭ 永远拿到没听过的歌，不会在历史里来回走。
   */
  let filling = false;
  async function fillQueue() {
    state.queue = state.queue || [];
    if (filling) return state.queue; // 播放与 next 可能同时触发
    filling = true;
    try {
      const queued = new Set(state.queue.map((item) => item.bvid));
      const recent = new Set((state.recent || []).slice(0, recentWindow));
      let guard = 0;
      while (state.queue.length < queueTarget && guard < QUEUE_FILL_GUARD) {
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
   * 播放一首歌：取稿件与直链，写入当前曲与历史，触发预取与补队列。
   * - 默认：写入历史头部（cursor = 0）
   * - fromHistory：只在历史里移动光标，不改写历史顺序
   */
  async function playBvid(bvid, { reason = '', fromHistory = false, source = 'profile' } = {}) {
    const info = await fetchVideoInfo(bvid);
    await fetchAudioStream(bvid, info.cid); // 先确认可播放，失败时不污染状态
    const track = {
      bvid,
      aid: info.aid,
      cid: info.cid,
      title: info.title,
      artist: info.owner,
      tname: info.tname,
      cover: info.cover,
      tags: info.tags.slice(0, 8),
      duration: info.duration,
      stream: `/bili-music/stream/${bvid}`,
      reason,
      feedback: feedbackOf(bvid),
      startedAt: new Date().toISOString(),
    };
    state.current = track;
    state.recent = [bvid, ...(state.recent || []).filter((item) => item !== bvid)].slice(
      0,
      recentWindow,
    );

    if (fromHistory) {
      const index = (state.history || []).findIndex((entry) => entry.bvid === bvid);
      state.cursor = index >= 0 ? index : 0;
    } else {
      state.history = [
        {
          bvid,
          title: track.title,
          artist: track.artist,
          at: track.startedAt,
          tname: track.tname,
          duration: track.duration,
        },
        ...(state.history || []).filter((entry) => entry.bvid !== bvid),
      ].slice(0, HISTORY_LIMIT);
      state.cursor = 0;
      // 在线补充后重置计数，否则会连续触发
      state.playsSinceOnline = source === 'online' ? 0 : (state.playsSinceOnline || 0) + 1;
    }
    saveState();

    // 预取：立刻把整首音频缓存到本地，浏览器请求时直接按 Range 提供
    ensureAudioFile(bvid, info.cid).catch((error) =>
      console.error('[bili-music] 预取失败', bvid, String(error.message || error)),
    );
    if (!fromHistory) fillQueue().catch(() => {});
    return track;
  }

  /** 按关键词点歌：优先取时长正常的那条，搜索首条常是长合集或切片。 */
  async function playByQuery(query) {
    const results = await searchMusic(query, 10);
    if (!results.length) throw new Error(`没有搜到「${query}」`);
    const inRange = results.filter((candidate) => isInDurationRange(candidate.duration));
    const best = inRange[0] || results[0];
    return playBvid(best.bvid, { reason: `搜索「${query}」首条` });
  }

  /**
   * 下一首 = 消费队列；队列空了现取一首。
   * 队列条目可能已失效（稿件被删、版权下架），失败时丢弃换下一个。
   */
  async function playNext() {
    for (let attempt = 0; attempt < 3; attempt++) {
      const queue = state.queue || [];
      if (queue.length) {
        const item = queue.shift();
        saveState();
        const reason =
          item.source === 'online' ? `在线补充（${item.keyword || '画像'}）` : '队列下一首';
        try {
          const track = await playBvid(item.bvid, { reason, source: item.source });
          fillQueue().catch(() => {});
          return { track, atEnd: false };
        } catch (error) {
          console.error(
            '[bili-music] 队列条目失效，跳过',
            item.bvid,
            String(error.message || error),
          );
          continue;
        }
      }
      const pick = await pickNext({ exclude: state.current ? [state.current.bvid] : [] });
      if (!pick) throw new Error('画像和在线搜索都没有找到可播放的曲目');
      const reason =
        pick.source === 'online' ? `在线补充（${pick.keyword || '画像'}）` : '连播推荐';
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
    return {
      track: await playBvid(prev.bvid, { reason: '上一首（来自播放历史）', fromHistory: true }),
      atEnd: false,
    };
  }

  return { playBvid, playByQuery, fillQueue, playNext, playPrev, trackMetadata };
}
