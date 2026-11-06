/**
 * 播放器的共享音频元素：模块级单例，切换会话导致组件卸载时音乐继续播。
 */

let sharedAudio = null;

export function getAudio() {
  if (sharedAudio) return sharedAudio;
  const element = new Audio();
  // preload=auto：preload=none 时浏览器不建立 seekable 区间，
  // 设置 currentTime 会被忽略或回退到 0，这是「跳不动/跳回开头」的主因。
  element.preload = 'auto';
  element.style.position = 'absolute';
  element.style.width = '0';
  element.style.height = '0';
  element.style.opacity = '0';
  element.setAttribute('data-bili-music-audio', '1');
  document.body.appendChild(element);
  sharedAudio = element;
  return element;
}
