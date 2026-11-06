/**
 * 播放状态：模块级单一来源，跨会话保留。
 *
 * 播放条会随会话卸载重建，进度、加载百分比、错误提示不能跟着丢。播放器与
 * 加载器把状态写到这里，组件只订阅、不再各存一份。
 */

const state = {
  playing: false,
  position: 0,
  duration: 0,
  loading: false,
  loadPercent: 0,
  error: '',
};

const listeners = new Set();

/** 当前状态快照；调用方只读。 */
export function getPlaybackState() {
  return state;
}

/** 合并更新并通知订阅者；字段没有实际变化时不通知。 */
export function updatePlayback(patch) {
  let changed = false;
  for (const [key, value] of Object.entries(patch)) {
    if (state[key] !== value) {
      state[key] = value;
      changed = true;
    }
  }
  if (changed) for (const listener of listeners) listener();
}

/** 订阅状态变化，返回退订函数。 */
export function subscribePlayback(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
