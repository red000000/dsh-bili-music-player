import { test } from 'node:test';
import assert from 'node:assert/strict';

/**
 * 浮层定位的回归：宿主给 composer seat 加了 will-change: transform，
 * fixed 元素会以它为包含块，被丢到输入框下方几百像素，把会话滚动区撑大。
 * 所以两个浮层必须相对播放条绝对定位。
 */

import { createErrorToast, createNoticePart } from '../../client/parts/notice.js';

const fakeReact = {
  createElement: (tag, props, ...children) => ({ tag, props, children }),
};

const colors = { err: '#c62828' };

test('提示浮层相对播放条绝对定位，并换算成播放条坐标', () => {
  const Notice = createNoticePart({ React: fakeReact, colors });
  const anchor = { getBoundingClientRect: () => ({ left: 100, top: 900, width: 400 }) };

  const node = Notice({ notice: { text: '已取消标记', tone: 'info', x: 180, y: 916 }, anchor });

  assert.equal(node.props.style.position, 'absolute', '不能用 fixed，否则会撑大宿主滚动区');
  assert.equal(node.props.style.left, 80);
  assert.equal(node.props.style.top, 16);
});

test('错误条同样绝对定位，贴在播放条左上方', () => {
  const ErrorToast = createErrorToast({ React: fakeReact, colors });

  const node = ErrorToast({ message: '音源加载失败，点 ▶ 重试' });

  assert.equal(node.props.style.position, 'absolute');
  assert.equal(node.props.style.left, 90);
  assert.equal(node.props.style.top, -8);
});
