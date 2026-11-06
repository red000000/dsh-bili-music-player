import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

/**
 * 构建产物冒烟：用假的 React 与 DOM 执行 client.js，确认
 * bundle 能注册、能挂到插槽、组件能渲染出一棵带文字的树。
 *
 * 这一条专门抓「重构搬代码时漏掉变量/函数」的错误——那类错误在浏览器里
 * 表现为整条播放条消失，没有 DevTools 时很难定位。
 */

const source = fs.readFileSync(new URL('../../client.js', import.meta.url), 'utf8');

const fakeReact = {
  createElement: (tag, props, ...children) => ({
    tag,
    props: { ...(props || {}), children: children.length > 1 ? children : children[0] },
  }),
  Component: class Component {
    constructor(props) {
      this.props = props;
      this.state = {};
    }
    setState(next) {
      this.state = { ...this.state, ...(typeof next === 'function' ? next(this.state) : next) };
    }
  },
  useState: (initial) => {
    const value = typeof initial === 'function' ? initial() : initial;
    if (initial && typeof initial === 'object' && 'current' in initial) {
      return [
        {
          current: {
            bvid: 'BV1',
            title: '测试曲目',
            artist: '测试歌手',
            duration: 200,
            stream: '/bili-music/stream/BV1',
            reason: '测试',
            feedback: 'like',
            startedAt: '2026-11-06T00:00:00.000Z',
          },
          history: [
            {
              bvid: 'BV1',
              title: '测试曲目',
              artist: '测试歌手',
              feedback: 'like',
              current: true,
            },
          ],
        },
        () => {},
      ];
    }
    return [value, () => {}];
  },
  useEffect: () => {},
  useRef: (initial) => ({ current: initial }),
  useCallback: (fn) => fn,
};

function loadBundle() {
  let registered = null;
  globalThis.window = {
    __ModuleLoader__: {
      load(options) {
        registered = options;
      },
    },
  };
  globalThis.document = {
    body: { appendChild: () => {} },
    head: { appendChild: () => {} },
    getElementById: () => null,
    createElement: () => ({ style: {}, setAttribute: () => {}, appendChild: () => {} }),
    addEventListener: () => {},
    visibilityState: 'visible',
  };
  globalThis.localStorage = { getItem: () => null, setItem: () => {} };
  globalThis.Audio = class Audio {
    constructor() {
      this.style = {};
      this.paused = true;
      this.currentTime = 0;
      this.duration = 200;
      this.volume = 1;
      this.seekable = { length: 0 };
    }
    addEventListener() {}
    removeEventListener() {}
    setAttribute() {}
    load() {}
    play() {
      return Promise.resolve();
    }
    pause() {}
  };
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ ok: true, history: [] }) });

  new Function(source)();
  return registered;
}

const collectText = (root) => {
  const text = [];
  const walk = (node) => {
    if (node == null || node === false) return;
    if (typeof node === 'string' || typeof node === 'number') {
      text.push(String(node));
      return;
    }
    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }
    const children = node.props?.children;
    if (Array.isArray(children)) children.forEach(walk);
    else if (children != null) walk(children);
  };
  walk(root);
  return text;
};

test('bundle 注册到正确的模块 id 并暴露 apply', () => {
  const registered = loadBundle();
  assert.ok(registered, 'bundle 没有调用 __ModuleLoader__.load');
  assert.equal(registered.id, 'dsh-bili-music-player');
  const mod = registered.factory((id) => {
    if (id === 'react') return fakeReact;
    throw new Error(`未知模块: ${id}`);
  });
  assert.equal(typeof mod.apply, 'function');
});

test('组件挂到 composer dock 并能渲染出播放条文字', () => {
  const registered = loadBundle();
  const mod = registered.factory(() => fakeReact);

  let component = null;
  mod.apply({
    slots: {
      inject: (_name, register) => register(),
      register: (_options, target) => {
        component = target;
        return () => {};
      },
    },
  });
  assert.equal(typeof component, 'function', '没有注册组件');

  let tree = component();
  assert.ok(tree, '组件首帧返回空');
  for (let depth = 0; depth < 4 && tree && typeof tree.tag === 'function'; depth++) {
    const tag = tree.tag;
    tree = tag.prototype && tag.prototype.render ? new tag(tree.props).render() : tag(tree.props);
  }
  assert.equal(tree.tag, 'div');

  const text = collectText(tree);
  assert.ok(text.includes('测试曲目'), '没有渲染出曲目标题');
  assert.ok(text.includes('测试歌手'), '没有渲染出歌手');
  assert.ok(
    text.some((item) => item.includes('3:20')),
    '没有渲染出时长',
  );
});
