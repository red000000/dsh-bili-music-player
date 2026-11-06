/**
 * 播放历史面板：贴着播放条上方展开，可对历史曲目补/改反馈。
 *
 * 纯展示：取数、提交与提示都在 player-bar.js；这里只把点击转成 onFeedback 回调。
 */
export function createHistoryPanel({ React, colors, actions }) {
  const h = React.createElement;

  const feedbackText = (feedback) =>
    feedback === 'like' ? '喜欢' : feedback === 'skip' ? '跳过' : feedback ? '不喜欢' : '';

  return function HistoryPanel({ open, history, currentBvid, onClose, onFeedback }) {
    if (!open) return null;

    return h(
      'div',
      {
        style: {
          position: 'absolute',
          bottom: '100%',
          left: 0,
          right: 0,
          marginBottom: 6,
          maxHeight: 260,
          overflowY: 'auto',
          border: `1px solid ${colors.border}`,
          borderRadius: 10,
          background: colors.layer1,
          color: colors.label,
          boxShadow: '0 8px 24px rgba(0,0,0,.18)',
          padding: 6,
          zIndex: 30,
          font: '12px/1.5 system-ui, sans-serif',
        },
      },
      h(
        'div',
        {
          style: {
            display: 'flex',
            justifyContent: 'space-between',
            padding: '2px 6px 6px',
            color: colors.label3,
          },
        },
        h('span', null, `播放历史（${history.length}）`),
        h('span', { style: { cursor: 'pointer' }, onClick: onClose }, '收起 ✕'),
      ),
      history.length === 0
        ? h('div', { style: { padding: 8, color: colors.label3 } }, '还没有播放记录')
        : history.map((item) => {
            const isCurrent = currentBvid === item.bvid;
            return h(
              'div',
              {
                key: item.bvid,
                style: {
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  padding: '4px 6px',
                  borderRadius: 6,
                  background: isCurrent ? colors.layer2 : 'transparent',
                },
              },
              h(
                'div',
                { style: { minWidth: 0, flex: 1 } },
                h(
                  'div',
                  {
                    style: {
                      whiteSpace: 'nowrap',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      fontWeight: isCurrent ? 600 : 400,
                    },
                  },
                  item.title,
                ),
                h(
                  'div',
                  {
                    style: {
                      color: colors.label3,
                      whiteSpace: 'nowrap',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                    },
                  },
                  `${item.artist || ''}${item.feedback ? ` · 已${feedbackText(item.feedback)}` : ''}`,
                ),
              ),
              ...actions.map((action) => {
                const on = item.feedback === action.key;
                return h(
                  'button',
                  {
                    key: action.key,
                    type: 'button',
                    title: action.tip,
                    onClick: (event) => onFeedback(action.key, item.bvid, event),
                    style: {
                      border: 'none',
                      background: on
                        ? `color-mix(in srgb, ${colors.brand} 16%, transparent)`
                        : 'transparent',
                      color: on ? colors.brand : colors.label3,
                      borderRadius: 6,
                      width: 22,
                      height: 20,
                      cursor: 'pointer',
                      fontSize: 12,
                      lineHeight: 1,
                      padding: 0,
                    },
                  },
                  on ? '✓' : action.icon,
                );
              }),
            );
          }),
    );
  };
}
