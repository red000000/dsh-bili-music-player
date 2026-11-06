/**
 * 播放条中段的三件小展示：时间（兼加载百分比）、进度条、调试读数。
 *
 * 只接收渲染所需的数值与回调，不读组件状态；格式化与样式留在这里，
 * 采样和跳转仍由 player-bar.js 决定。
 */
export function createProgress({ React, colors, getAudioElement }) {
  const h = React.createElement;

  const formatTime = (seconds) => {
    if (!Number.isFinite(seconds) || seconds < 0) return '0:00';
    return `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`;
  };

  /** 时间标签：加载中显示百分比，点击切换调试读数。 */
  function timeLabel({ loading, loadPercent, position, duration, onToggleDebug }) {
    return h(
      'span',
      {
        title: '点击切换调试信息（桌面版没有 DevTools 也能看）',
        onClick: onToggleDebug,
        style: {
          color: loading ? colors.brand : colors.label3,
          fontVariantNumeric: 'tabular-nums',
          flexShrink: 0,
          width: 82,
          textAlign: 'right',
          cursor: 'pointer',
        },
      },
      loading
        ? `加载 ${Math.round(loadPercent * 100)}%`
        : `${formatTime(position)}/${formatTime(duration)}`,
    );
  }

  /** 进度条：点击按比例换算成秒，换算与兜底时长在调用方。 */
  function progressBar({ position, duration, onSeek }) {
    return h(
      'div',
      {
        onClick: onSeek,
        title: '点击跳转',
        style: {
          flex: 1,
          minWidth: 60,
          height: 14,
          display: 'flex',
          alignItems: 'center',
          cursor: 'pointer',
        },
      },
      h(
        'div',
        {
          style: {
            position: 'relative',
            width: '100%',
            height: 3,
            background: colors.layer3,
            borderRadius: 2,
          },
        },
        h('div', {
          style: {
            position: 'absolute',
            inset: 0,
            width: `${duration ? Math.min(100, (position / duration) * 100) : 0}%`,
            background: colors.brand,
            borderRadius: 2,
          },
        }),
      ),
    );
  }

  /** 调试读数：直接问 audio 元素要状态，只在打开调试开关时渲染。 */
  function debugReadout() {
    const el = getAudioElement();
    let seekable = '-';
    try {
      seekable =
        el.seekable && el.seekable.length
          ? `${el.seekable.start(0).toFixed(0)}-${el.seekable.end(el.seekable.length - 1).toFixed(0)}`
          : 'none';
    } catch {
      /* 忽略 */
    }
    return h(
      'span',
      {
        title: '调试：readyState / duration / currentTime / seekable',
        style: { color: colors.err, fontFamily: 'monospace', fontSize: 10, flexShrink: 0 },
      },
      `rs${el.readyState} d${Number.isFinite(el.duration) ? el.duration.toFixed(0) : '∞'} t${el.currentTime.toFixed(1)} sk${seekable}`,
    );
  }

  return { timeLabel, progressBar, debugReadout };
}
