/**
 * 反馈区：喜欢 / 跳过 / 不喜欢三个按钮。
 *
 * 只把点击转成 onSend(action, bvid, event)；提交、乐观更新与提示都在 bar.js。
 */
export function createFeedbackArea({ buttons, actions }) {
  return function feedbackArea({ active, pending, onSend }) {
    return actions.map((item) =>
      buttons.feedbackButton({
        item,
        active,
        pending,
        onClick: (event) => onSend(item.key, '', event),
      }),
    );
  };
}
