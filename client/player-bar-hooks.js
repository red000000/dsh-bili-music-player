/**
 * 自定义 hook 工厂：client 侧不能 import react，统一从宿主注入的 React 上取。
 * 由 createPlayerBar 调用一次，返回稳定的 hook 引用。
 */
import { getPlaybackState, subscribePlayback } from './playback-store.js';
import { PLAY_MODE_KEY } from './player-bar-theme.js';

export function createHooks(React) {
  const { useCallback, useEffect, useRef, useState } = React;
  const NOTICE_TTL_MS = 2400;

  /**
   * 轮询后端状态：当前曲目与播放历史。
   * 并发保护：上一次请求没回来就跳过，避免慢请求叠加把新状态覆盖成旧的。
   * 同时暴露 setState，供反馈成功后做乐观更新。
   */
  function useServerState() {
    const [serverState, setServerState] = useState({ current: null, history: [] });
    const refreshing = useRef(false);
    const mounted = useRef(false);

    const refreshServerState = useCallback(async () => {
      if (refreshing.current) return;
      refreshing.current = true;
      try {
        const res = await fetch('/bili-music/state', { cache: 'no-store' });
        if (!res.ok) return;
        const data = await res.json();
        if (!mounted.current) return;
        setServerState({ current: data.current || null, history: data.history || [] });
      } catch {
        /* 网络抖动忽略，下次轮询会补上 */
      } finally {
        refreshing.current = false;
      }
    }, []);

    useEffect(() => {
      mounted.current = true;
      refreshServerState();
      const timer = setInterval(refreshServerState, 5000);
      return () => {
        mounted.current = false;
        clearInterval(timer);
      };
    }, [refreshServerState]);

    return { serverState, refreshServerState, setServerState };
  }

  /** 浮层提示：优先从鼠标点击处冒出，没有坐标时退回播放条上方。 */
  function useNotice(anchorRef) {
    const [notice, setNotice] = useState(null);
    const timer = useRef(null);
    const mounted = useRef(true);

    const showNotice = useCallback(
      (text, tone = 'ok', ev) => {
        let x;
        let y;
        if (ev && Number.isFinite(ev.clientX)) {
          x = ev.clientX;
          y = ev.clientY;
        } else if (anchorRef?.current) {
          const rect = anchorRef.current.getBoundingClientRect();
          x = rect.left + rect.width / 2;
          y = rect.top;
        }
        setNotice({ text, tone, x, y });
        if (timer.current) clearTimeout(timer.current);
        timer.current = setTimeout(() => {
          if (mounted.current) setNotice(null);
        }, NOTICE_TTL_MS);
      },
      [anchorRef],
    );

    useEffect(() => {
      mounted.current = true;
      return () => {
        mounted.current = false;
        if (timer.current) clearTimeout(timer.current);
      };
    }, []);

    return { notice, showNotice };
  }

  /**
   * 播放模式（推荐连播 / 单曲循环）：写进 localStorage，刷新后保持。
   */
  function useMode() {
    const [mode, setMode] = useState(() => {
      try {
        return localStorage.getItem(PLAY_MODE_KEY) || 'recommend';
      } catch {
        return 'recommend';
      }
    });

    useEffect(() => {
      try {
        localStorage.setItem(PLAY_MODE_KEY, mode);
      } catch {
        /* 忽略 */
      }
    }, [mode]);

    return [mode, setMode];
  }

  /**
   * 订阅模块级播放状态：切会话重建组件后仍是同一份数据。
   */
  function usePlayback() {
    const [, bump] = useState(0);
    useEffect(() => subscribePlayback(() => bump((value) => value + 1)), []);
    return getPlaybackState();
  }

  return { useServerState, useNotice, useMode, usePlayback };
}
