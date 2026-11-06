/**
 * 模块级音频引擎：audio 元素、播放器与加载器只建一次。
 *
 * 会话切换会卸载播放条组件，但音乐要继续播：引擎不随组件销毁，
 * 组件只在挂载时订阅状态、卸载时退订，重新挂载时先取一次快照对齐进度。
 */
import { getAudio } from './audio.js';
import { createLoader } from './loader.js';
import { createPlayer } from './player.js';
import { diag } from './diag.js';

let engine = null;

/**
 * 取共享引擎；第一次调用时创建 audio 元素、播放器与加载器。
 * 多个播放条同时挂载时都会收到同一份事件。
 */
export function getAudioEngine() {
  if (engine) return engine;
  const el = getAudio();
  const handlers = new Set();
  const emit = (name, value) => {
    for (const handler of handlers) handler(name, value);
  };

  const player = createPlayer({
    element: el,
    diag,
    onState: (snapshot) => emit('state', snapshot),
    onError: (message) => emit('error', message),
    onEnded: () => emit('ended'),
  });
  const loader = createLoader({
    el,
    diag,
    onLoading: (value) => emit('loading', value),
    onProgress: (value) => emit('progress', value),
    onPlaying: (value) => emit('playing', value),
    onError: (message) => emit('error', message),
  });

  engine = {
    player,
    loader,
    /** 订阅状态事件，返回退订函数。 */
    subscribe(handler) {
      handlers.add(handler);
      return () => handlers.delete(handler);
    },
    /** 当前播放快照：重新挂载时用来立刻对齐界面。 */
    snapshot: () => player.snapshot(),
  };
  return engine;
}
