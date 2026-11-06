/**
 * 播放条的外观常量与一次性样式注入。
 * 颜色全部走宿主的设计令牌，取不到时退回硬编码值。
 */

export const FEEDBACK_ACTIONS = [
  { key: 'like', icon: '👍', label: '喜欢', tip: '收进「点歌助手」收藏夹' },
  { key: 'skip', icon: '⏭', label: '跳过', tip: '跳过，权重几乎不变' },
  { key: 'dislike', icon: '👎', label: '不喜欢', tip: '之后不再推荐这首' },
];

export const PLAY_MODE_KEY = 'bili-music-mode';
export const DOCK_STYLE_ID = 'bili-music-bar-style';

export const COLORS = {
  label: 'var(--dsw-alias-label-primary, #1f1f1f)',
  label2: 'var(--dsw-alias-label-secondary, #666)',
  label3: 'var(--dsw-alias-label-caption, #8a8a8a)',
  border: 'var(--dsw-alias-border-l2, #e2e2e2)',
  layer1: 'var(--dsw-alias-bg-layer-1, #fff)',
  layer2: 'var(--dsw-alias-bg-layer-2, #f7f7f7)',
  layer3: 'var(--dsw-alias-bg-layer-3, #eee)',
  brand: 'var(--dsw-alias-brand-primary, #4a7cff)',
  ok: 'var(--dsw-alias-state-success-primary, #12805c)',
  err: 'var(--dsw-alias-state-error-primary, #c62828)',
};

/** 让 dock 换行并把内容靠左；只注入一次，之后靠 id 命中。 */
export function ensureDockStyle() {
  if (document.getElementById(DOCK_STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = DOCK_STYLE_ID;
  // 只让 dock 换行；行内对齐交给各自元素，统计行保持默认居中
  style.textContent = '[data-composer-dock]{flex-wrap:wrap!important}';
  document.head.appendChild(style);
}
