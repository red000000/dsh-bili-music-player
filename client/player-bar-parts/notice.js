/**
 * 浮层：操作提示与错误条。
 *
 * 提示贴在鼠标点击处，没有坐标时退回播放条上方；错误条贴在播放条左上方。
 * 两者都相对播放条绝对定位，不用 fixed：宿主给 composer seat 加了
 * `will-change: transform`，fixed 元素会以它为包含块，被丢到输入框下方几百像素，
 * 把会话滚动区撑大（表现为整块会话跳上去、下面一大片空白）。
 */
export function createNotice({ React, colors }) {
  const h = React.createElement;

  return function Notice({ notice, anchor }) {
    if (!notice) return null;
    const rect = anchor ? anchor.getBoundingClientRect() : null;
    const left = rect
      ? Number.isFinite(notice.x)
        ? notice.x - rect.left
        : rect.width / 2
      : undefined;
    const top = rect ? (Number.isFinite(notice.y) ? notice.y - rect.top : -6) : undefined;
    return h(
      'div',
      {
        role: 'status',
        style: {
          position: 'absolute',
          left,
          top,
          transform: 'translate(-50%, -100%)',
          background: 'var(--dsw-alias-toast-bg, rgba(20,20,20,.92))',
          color: 'var(--dsw-alias-toast-label, #fff)',
          border: `1px solid ${notice.tone === 'err' ? colors.err : 'transparent'}`,
          padding: '5px 10px',
          borderRadius: 8,
          fontSize: 12,
          lineHeight: 1.4,
          maxWidth: 320,
          whiteSpace: 'nowrap',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          boxShadow: '0 6px 20px rgba(0,0,0,.28)',
          pointerEvents: 'none',
          zIndex: 9999,
        },
      },
      `${notice.tone === 'err' ? '!' : notice.tone === 'ok' ? '✓' : '·'} ${notice.text}`,
    );
  };
}

/** 加载/播放失败的常驻错误条：固定在播放条左上方，点播放键重试后清空。 */
export function createErrorToast({ React, colors }) {
  const h = React.createElement;

  return function ErrorToast({ message }) {
    if (!message) return null;
    return h(
      'div',
      {
        role: 'status',
        style: {
          position: 'absolute',
          left: 90,
          top: -8,
          transform: 'translateY(-100%)',
          background: 'var(--dsw-alias-toast-bg, rgba(20,20,20,.92))',
          color: 'var(--dsw-alias-toast-label, #fff)',
          border: `1px solid ${colors.err}`,
          padding: '5px 10px',
          borderRadius: 8,
          fontSize: 12,
          maxWidth: 380,
          boxShadow: '0 6px 20px rgba(0,0,0,.28)',
          pointerEvents: 'none',
          zIndex: 9999,
        },
      },
      message,
    );
  };
}
