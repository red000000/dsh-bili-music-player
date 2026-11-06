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
import os from 'node:os';
import path from 'node:path';
import { createManifestReader } from './adapters/manifest.js';
import { createStore } from './adapters/state-store.js';
import { UA, createBilibili } from './adapters/bilibili.js';
import { createAudioCache } from './adapters/audio-cache.js';
import { createPlayback } from './domain/playback.js';
import { registerRoutes } from './surface/routes.js';
import { registerTools } from './surface/tools.js';
import { createFeedback } from './domain/feedback.js';
import { createRecommendation, inDurationRange, RECENT_WINDOW } from './domain/recommendation.js';

export const name = 'bili-music-player';
export const inject = ['tools', 'webServer'];

const DEFAULT_FOLDER_TITLE = '点歌助手';

export function apply(ctx, config = {}) {
  const base = config.dataDir || path.join(os.homedir(), '.dsh', 'bili-music');
  // ---------- 存储 ----------
  // 存储细节在 adapters/state-store.js；这里解构出与旧代码兼容的读写函数。
  const store = createStore({
    base,
    cookieFile: config.cookieFile,
    profileFile: config.profileFile,
  });
  const { cookies, cookieHeader, state, saveState, readJson, writeJson } = store;
  const profileFile = store.paths.profileFile;
  const cookieFile = store.paths.cookieFile;
  const folderFile = store.paths.folderFile;

  // ---------- B 站请求 ----------
  // 传输细节在 adapters/bilibili.js；这里只保留共享实例。
  const {
    bili,
    searchMusic,
    videoInfo,
    audioStream,
    related: relatedRaw,
  } = createBilibili({ cookieHeader });

  // ---------- 本地音频缓存 ----------
  // 下载与 LRU 在 adapters/audio-cache.js；这里注入缓存目录与取流方式。
  const audioCache = createAudioCache({
    dir: path.join(base, 'cache'),
    resolveStream: (b, c, opts) => audioStream(b, c, opts || {}),
    userAgent: UA,
  });
  const audioCacheDir = audioCache.dir;
  const ensureAudioFile = (bvid, cid) => audioCache.ensure(bvid, cid);

  // ---------- 分段清单（MSE 边下边播用） ----------
  // 解析在 adapters/manifest.js；这里只负责装配缓存目录与取流方式。
  const manifestReader = createManifestReader({
    cacheDir: audioCacheDir,
    resolveStream: (b, c) => audioStream(b, c),
    userAgent: UA,
  });

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
      body: new URLSearchParams({
        title: folderTitle,
        privacy: '1',
        csrf: jar.bili_jct || '',
      }).toString(),
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
        rid: String(info.aid),
        type: '2',
        add_media_ids: String(folder.id),
        del_media_ids: '',
        csrf: jar.bili_jct || '',
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
        rid: String(info.aid),
        type: '2',
        add_media_ids: '',
        del_media_ids: String(folder.id),
        csrf: jar.bili_jct || '',
      }).toString(),
    });
    if (r.json?.code !== 0) throw new Error(`取消收藏失败: ${r.json?.message}`);
    return { folder: folder.title, folderId: folder.id };
  }

  // ---------- 推荐 ----------
  // 规则在 domain/recommendation.js；这里注入状态、搜索与相关推荐。
  const relatedCandidates = async (seedBvid, blocked) => {
    try {
      const list = await relatedRaw(seedBvid);
      return list.filter((item) => recommendation.usableCandidate(item, blocked));
    } catch {
      return [];
    }
  };
  const recommendation = createRecommendation({
    store,
    state,
    searchMusic,
    relatedCandidates,
  });
  const { profileSummary, feedbackStats, feedbackOf, pickNext } = recommendation;

  /**
   * 播放一首歌。
   * - 默认：写入历史头部（cursor=0）
   * - fromHistory：只在历史里移动光标，不改写历史顺序
   */
  // ---------- 播放与反馈 ----------
  // 规则分别在 domain/playback.js 与 domain/feedback.js；这里把依赖接起来。
  const playback = createPlayback({
    state,
    saveState,
    videoInfo,
    audioStream,
    ensureAudioFile,
    searchMusic,
    pickNext,
    feedbackOf,
    inDurationRange,
    recentWindow: RECENT_WINDOW,
  });
  const feedback = createFeedback({
    store,
    state,
    saveState,
    trackMeta: playback.trackMeta,
    feedbackOf,
    addToAgentFolder,
    removeFromAgentFolder,
  });
  const { playBvid, playByQuery, playNext, playPrev } = playback;
  const { submit: submitFeedback } = feedback;

  // ---------- 入口 ----------
  // 路由与工具在 surface/；这里只把依赖装配进去。
  registerRoutes(ctx, {
    base,
    store,
    state,
    feedbackStats,
    feedbackOf,
    profileSummary,
    playNext,
    playPrev,
    submitFeedback,
    videoInfo,
    audioStream,
    manifestReader,
    audioCache,
    ensureAudioFile,
    userAgent: UA,
  });

  registerTools({
    ctx,
    state,
    store,
    feedbackOf,
    profileSummary,
    feedbackStats,
    pickNext,
    playBvid,
    playByQuery,
    submitFeedback,
    base,
    cookieFile,
    profileFile,
  });
}
