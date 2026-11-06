/**
 * 反馈领域逻辑：一首歌只保留一个反馈（可改），并决定要不要动代理收藏夹。
 * 收藏夹是唯一允许写入的远端资源，由调用方注入具体 adapter。
 */

export const FEEDBACK_WEIGHT = { like: 2.0, skip: -0.2, dislike: -1.5 };

const assertAction = (action) => {
  if (!FEEDBACK_WEIGHT[action]) throw new Error(`未知反馈: ${action}`);
};

export function createFeedback({
  store,
  state,
  saveState,
  trackMetadata,
  feedbackOf,
  addToAgentFolder,
  removeFromAgentFolder,
}) {
  /** 写入反馈状态并追加审计流水；dislike 还要把它从最近播放与队列里抹掉。 */
  function apply(action, reason = '', targetBvid = '') {
    const bvid = targetBvid || state.current?.bvid;
    if (!bvid) throw new Error('没有可反馈的曲目');
    assertAction(action);
    const meta = trackMetadata(bvid);
    const map = store.readFeedbackState();
    const prev = map[bvid]?.action || null;
    map[bvid] = {
      at: new Date().toISOString(),
      bvid,
      title: meta.title,
      artist: meta.artist,
      action,
      reason,
    };
    store.writeFeedbackState(map);
    store.appendFeedbackLog({ ...map[bvid], prev: prev || undefined });
    if (action === 'dislike') {
      // 不喜欢要从「最近播放」和「待播队列」里都抹掉，否则排队中的它照样会播
      state.recent = (state.recent || []).filter((item) => item !== bvid);
      state.queue = (state.queue || []).filter((item) => item.bvid !== bvid);
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

  /** 取消标记：删掉这首歌的反馈记录，审计流水留一条 clear。 */
  function clear(bvid) {
    const map = store.readFeedbackState();
    const prev = map[bvid]?.action || null;
    if (!prev) {
      return {
        action: null,
        prev: null,
        changed: false,
        track: { ...trackMetadata(bvid), feedback: null },
      };
    }
    const meta = map[bvid];
    delete map[bvid];
    store.writeFeedbackState(map);
    store.appendFeedbackLog({
      at: new Date().toISOString(),
      bvid,
      title: meta.title,
      artist: meta.artist,
      action: 'clear',
      prev,
    });
    return {
      action: null,
      prev,
      changed: true,
      track: { ...trackMetadata(bvid), feedback: null },
      stats: { total: Object.keys(map).length, unique: Object.keys(map).length },
    };
  }

  /**
   * 唯一反馈入口：HTTP 按钮与 agent 工具都走这里。
   * like 会写进代理收藏夹；从 like 改成别的、或取消标记，会把它撤出收藏夹。
   * action 传 clear 表示取消标记。
   */
  async function submit(action, reason = '', targetBvid = '') {
    const bvid = targetBvid || state.current?.bvid;
    if (!bvid) throw new Error('没有可反馈的曲目');
    if (action === 'clear') {
      const prev = feedbackOf(bvid);
      if (!prev) {
        return {
          action: null,
          prev: null,
          changed: false,
          track: { ...trackMetadata(bvid), feedback: null },
          saved: null,
        };
      }
      let saved = null;
      try {
        if (prev === 'like') saved = await removeFromAgentFolder(bvid);
      } catch (error) {
        saved = { error: String(error.message || error) };
      }
      return { ...clear(bvid), saved };
    }
    assertAction(action);
    const prev = feedbackOf(bvid);
    if (prev === action) {
      return {
        action,
        prev,
        changed: false,
        duplicated: true,
        track: { ...trackMetadata(bvid), feedback: action },
        saved: null,
      };
    }

    let saved = null;
    try {
      if (action === 'like') saved = await addToAgentFolder(bvid);
      else if (prev === 'like') saved = await removeFromAgentFolder(bvid);
    } catch (error) {
      saved = { error: String(error.message || error) };
    }
    return { ...apply(action, reason, bvid), saved };
  }

  return { apply, submit };
}
