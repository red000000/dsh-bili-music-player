/**
 * 模块级音频引擎：audio 元素、播放器与加载器只建一次。
 *
 * 会话切换会卸载播放条组件，但音乐要继续播：引擎不随组件销毁，
 * 播放状态写进 playback-store，组件只订阅状态；播完的后续动作（循环、下一首）
 * 以 ended 事件交给当前挂载的播放条决定。
 */
import { getAudio } from './audio.js';
import { createLoader } from './loader.js';
import { createPlayer } from './player.js';
import { updatePlayback } from './playback-store.js';
import { diag } from './diag.js';

let engine = null;

/** 取共享引擎；第一次调用时创建 audio 元素、播放器与加载器。 */
export function getAudioEngine() {
  if (engine) return engine;
  const el = getAudio();
  const endedHandlers = new Set();

  const player = createPlayer({
    element: el,
    diag,
    onState: (snapshot) =>
      updatePlayback({ playing: snapshot.playing, now: snapshot.now, dur: snapshot.dur }),
    onError: (message) => updatePlayback({ error: message }),
    onEnded: () => {
      for (const handler of endedHandlers) handler();
    },
  });
  const loader = createLoader({
    el,
    diag,
    onLoading: (value) => updatePlayback({ loading: value }),
    onProgress: (value) => updatePlayback({ loadPct: value }),
    onPlaying: (value) => updatePlayback({ playing: value }),
    onError: (message) => updatePlayback({ error: message }),
  });

  engine = {
    player,
    loader,
    /** 订阅「播放结束」，返回退订函数。 */
    subscribeEnded(handler) {
      endedHandlers.add(handler);
      return () => endedHandlers.delete(handler);
    },
  };
  return engine;
}
