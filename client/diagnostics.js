/**
 * 诊断上报：桌面版没有 DevTools 时，把前端事件写进 Host 的 debug.log。
 * 默认关闭，由播放条上的调试开关打开，避免日常运行产生垃圾日志。
 */

let enabled = false;

export function setDiagnosticsEnabled(value) {
  enabled = Boolean(value);
}

export function reportDiagnostic(tag, data) {
  if (!enabled) return;
  try {
    fetch('/bili-music/debug', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ tag, ...data, at: Date.now() }),
    }).catch(() => {});
  } catch {
    /* 忽略 */
  }
}
