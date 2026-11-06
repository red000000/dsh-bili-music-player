/**
 * Client 入口：把播放条挂到 composer dock 的插槽上。
 *
 * DSH 的浏览器侧只加载一个自包含 bundle，运行时 require 只解析平台模块
 * （react 等）、boot graph 行与已注册 factory，不解析相对路径。
 * 因此本目录的源码由 esbuild 打包成根目录的 client.js 交付。
 */

import { createPlayerBar } from './player-bar.js';

window.__ModuleLoader__.load({
  id: 'dsh-bili-music-player',
  factory(require) {
    const React = require('react');
    const Bar = createPlayerBar(React);

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('conversation.composer.dock', () =>
          ctx.slots.register(
            {
              name: 'conversation.composer.dock',
              id: 'bili-music-bar',
              order: 20,
            },
            Bar,
          ),
        );
      },
    };
  },
});
