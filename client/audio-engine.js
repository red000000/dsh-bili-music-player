/**
 * 模块级音频引擎：audio 元素、播放器与加载器只建一次。
 *
 * 会话切换会卸载播放条组件，但音乐要继续播：引擎不随组件销毁，
 * 播放状态写进 playback-store，组件只订阅状态；播完的后续动作（循环、下一首）
 * 以 ended 事件交给当前挂载的播放条决定。
 */
import { getAudioElement } from './audio-element.js';
import { createAudioLoader } from './audio-loader.js';
import { createAudioPlayer } from './audio-player.js';
import { updatePlayback } from './playback-store.js';
import { reportDiagnostic } from './diagnostics.js';

let engine = null;

/** 取共享引擎；第一次调用时创建 audio 元素、播放器与加载器。 */
export function getAudioEngine() {
  if (engine) return engine;
  const el = getAudioElement();
  const endedHandlers = new Set();

  const player = createAudioPlayer({
    element: el,
    reportDiagnostic,
    onState: (snapshot) =>
      updatePlayback({
        playing: snapshot.playing,
        position: snapshot.position,
        duration: snapshot.duration,
      }),
    onError: (message) => updatePlayback({ error: message }),
    onEnded: () => {
      for (const handler of endedHandlers) handler();
    },
  });
  const loader = createAudioLoader({
    el,
    reportDiagnostic,
    onLoading: (value) => updatePlayback({ loading: value }),
    onProgress: (value) => updatePlayback({ loadPercent: value }),
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
