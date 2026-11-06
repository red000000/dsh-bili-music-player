/**
 * 反馈区：喜欢 / 跳过 / 不喜欢三个按钮。
 *
 * 只把点击转成 onSend(action, bvid, event)；提交、乐观更新与提示都在 player-bar.js。
 */
export function createFeedbackButtons({ buttons, actions }) {
  return function feedbackArea({ activeFeedback, pendingFeedback, onSend }) {
    return actions.map((item) =>
      buttons.feedbackButton({
        item,
        activeFeedback,
        pendingFeedback,
        onClick: (event) => onSend(item.key, '', event),
      }),
    );
  };
}
