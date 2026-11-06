import { getAudio } from './audio.js';

/**
 * 音频外部系统：持有 audio 元素、监听媒体事件、处理 seek 与播放开关。
 *
 * 按 React 官方建议，这类需要多个 Effect 协调的命令式逻辑不放在组件里，
 * 而抽成一个普通对象；组件只订阅 onState 拿快照，不关心内部细节。
 *
 * @param {{diag: Function, onState: (state: {playing: boolean, now: number, dur: number}) => void,
 *   onError: (message: string) => void, onEnded: () => void, element?: HTMLAudioElement}} deps
 *   element 可注入，便于测试；不传时用模块级单例。
 */
export function createPlayer({ diag, onState, onError, onEnded, element }) {
  const el = element || getAudio();
  let lastSeekAt = 0;

  const snapshot = () => ({
    playing: !el.paused,
    now: el.currentTime || 0,
    dur: Number.isFinite(el.duration) ? el.duration : 0,
  });
  const notify = () => onState(snapshot());

  const onTime = () => notify();
  const onPlay = () => {
    onError('');
    notify();
  };
  const onPause = () => notify();
  const onEndedEvent = () => {
    // 防御：seek 越界或抖动时浏览器可能立刻抛 ended，不能当成真的播完
    if (Date.now() - lastSeekAt < 800) return;
    const total = el.duration;
    if (Number.isFinite(total) && el.currentTime < total - 0.5) return;
    onState(snapshot());
    onEnded();
  };
  const onErrorEvent = () => {
    if (el.error) onError(`音频加载失败（${el.error.code}），点 ▶ 重试`);
  };

  /**
   * B 站音频是 fragmented MP4，浏览器常报 duration=Infinity、seekable=[]，
   * 这时设置 currentTime 会被忽略或回退到 0。行业通行做法：先把 currentTime
   * 设到一个极大值强制浏览器解析出真实时长，再回到 0。
   */
  const onLoadedMetadata = () => {
    notify();
    if (Number.isFinite(el.duration)) return;
    diag('duration-infinity', { rs: el.readyState, cur: el.currentTime });
    const onDuration = () => {
      el.removeEventListener('durationchange', onDuration);
      if (Number.isFinite(el.duration)) {
        diag('duration-resolved', { dur: +el.duration.toFixed(2) });
        try {
          el.currentTime = 0;
        } catch {
          /* 忽略 */
        }
        notify();
      }
    };
    el.addEventListener('durationchange', onDuration);
    try {
      el.currentTime = 1e101;
    } catch {
      /* 忽略 */
    }
  };

  el.addEventListener('timeupdate', onTime);
  el.addEventListener('loadedmetadata', onLoadedMetadata);
  el.addEventListener('play', onPlay);
  el.addEventListener('pause', onPause);
  el.addEventListener('ended', onEndedEvent);
  el.addEventListener('error', onErrorEvent);

  /** 切换播放/暂停；返回是否成功，失败时由组件决定提示什么。 */
  async function toggle() {
    if (el.ended || (el.duration && el.currentTime >= el.duration - 0.2)) el.currentTime = 0;
    if (el.paused) {
      await el.play();
      notify();
      return true;
    }
    el.pause();
    notify();
    return false;
  }

  function applySeek(target) {
    lastSeekAt = Date.now();
    try {
      el.currentTime = target;
      onState({ ...snapshot(), now: target });
    } catch (error) {
      diag('seek-throw', { target, err: String(error && error.message) });
      return;
    }
    diag('seek-applied', { target: +target.toFixed(2), dur: el.duration, rs: el.readyState });
  }

  /**
   * 标准 seek：只有 readyState >= HAVE_CURRENT_DATA 才设 currentTime，
   * 否则等 canplay/loadeddata；不重设 src，避免回到 0 秒。
   */
  function seekTo(target) {
    if (!Number.isFinite(target) || target < 0) return;
    let bounded = target;
    if (Number.isFinite(el.duration) && el.duration > 0) {
      bounded = Math.min(bounded, el.duration - 0.25);
    }
    try {
      if (el.seekable && el.seekable.length > 0) {
        const start = el.seekable.start(el.seekable.length - 1);
        const end = el.seekable.end(el.seekable.length - 1);
        // 只在目标已落在可跳区间内时夹紧；未缓冲区域交给浏览器缓冲
        if (end > start && bounded <= end) {
          bounded = Math.min(Math.max(bounded, start), end - 0.25);
        }
      }
    } catch {
      /* 忽略 */
    }
    if (!Number.isFinite(bounded) || bounded < 0) return;
    if (el.readyState >= 2) {
      applySeek(bounded);
      return;
    }
    const onReady = () => {
      el.removeEventListener('canplay', onReady);
      el.removeEventListener('loadeddata', onReady);
      applySeek(bounded);
    };
    el.addEventListener('canplay', onReady);
    el.addEventListener('loadeddata', onReady);
  }

  /** 按进度条比例跳转；媒体还没元数据时用后端给的时长兜底。 */
  function seekRatio(ratio, fallbackDuration) {
    const total =
      Number.isFinite(el.duration) && el.duration > 0 ? el.duration : fallbackDuration || 0;
    if (!total) return;
    seekTo(ratio * total);
  }

  function setVolume(value) {
    el.volume = Math.max(0, Math.min(1, value));
  }

  function destroy() {
    el.removeEventListener('timeupdate', onTime);
    el.removeEventListener('loadedmetadata', onLoadedMetadata);
    el.removeEventListener('play', onPlay);
    el.removeEventListener('pause', onPause);
    el.removeEventListener('ended', onEndedEvent);
    el.removeEventListener('error', onErrorEvent);
  }

  return { el, toggle, seekTo, seekRatio, setVolume, destroy };
}
