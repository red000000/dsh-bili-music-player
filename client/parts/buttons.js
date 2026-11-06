/**
 * 播放条上的两种按钮：图标按钮与反馈按钮。
 * 只接收渲染所需的参数，不再依赖组件闭包，便于单独调整样式。
 */
export function createButtons({ React, colors }) {
  const h = React.createElement;

  function iconButton({ glyph, title, onClick, disabled = false, active = false, size = 13 }) {
    return h(
      'button',
      {
        type: 'button',
        title,
        onClick,
        disabled,
        style: {
          border: 'none',
          background: 'transparent',
          color: active ? colors.brand : colors.label2,
          borderRadius: 6,
          width: 24,
          height: 22,
          cursor: 'pointer',
          fontSize: size,
          lineHeight: 1,
          padding: 0,
          flexShrink: 0,
          fontWeight: active ? 700 : 400,
        },
      },
      glyph,
    );
  }

  function feedbackButton({ item, active, pending, onClick }) {
    const isActive = active === item.key;
    const isBusy = pending === item.key;
    return h(
      'button',
      {
        key: item.key,
        type: 'button',
        title: isActive ? `已标记：${item.label}（再点一次取消）` : item.tip,
        disabled: !!pending,
        'aria-pressed': isActive,
        onClick,
        style: {
          border: 'none',
          background: isActive
            ? `color-mix(in srgb, ${colors.brand} 16%, transparent)`
            : 'transparent',
          color: isActive ? colors.brand : colors.label2,
          borderRadius: 6,
          width: 24,
          height: 22,
          cursor: pending ? 'wait' : 'pointer',
          fontSize: 13,
          lineHeight: 1,
          padding: 0,
          flexShrink: 0,
          fontWeight: isActive ? 700 : 400,
        },
      },
      isBusy ? '…' : isActive ? '✓' : item.icon,
    );
  }

  /** 播放模式按钮：单曲循环与推荐连播互切，切换后的值交给调用方保存。 */
  function modeButton({ mode, onToggle }) {
    const loop = mode === 'loop';
    return iconButton({
      glyph: loop ? '🔁' : '▶▶',
      title: loop ? '单曲循环（点击改为推荐连播）' : '推荐连播（点击改为单曲循环）',
      onClick: () => onToggle(loop ? 'recommend' : 'loop'),
      active: true,
      size: 11,
    });
  }

  return { iconButton, feedbackButton, modeButton };
}
