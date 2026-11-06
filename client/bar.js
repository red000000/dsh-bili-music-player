/**
 * 播放条组件：dock 内的一行，含播放控制、进度、模式、历史与反馈。
 *
 * 这里是编排层：持有状态、串起副作用，把展示交给 parts/、音频交给
 * player.js 与 loader.js。组件不直接引用 React，由调用方注入，因此可以
 * 脱离 DSH loader 单独渲染测试。
 */
import { diag, setDiagEnabled } from './diag.js';
import { getAudio } from './audio.js';
import { createBarBoundary } from './bar-boundary.js';
import { createLoader } from './loader.js';
import { createPlayer } from './player.js';
import { createHooks } from './hooks.js';
import { createButtons } from './parts/buttons.js';
import { createFeedbackArea } from './parts/feedback.js';
import { createHistoryPanel } from './parts/history.js';
import { createErrorToast, createNoticePart } from './parts/notice.js';
import { createProgressPart } from './parts/progress.js';
import { ACTIONS, COLORS as C, ensureDockStyle } from './theme.js';

export function createBar(React) {
  const h = React.createElement;
  const { useEffect, useRef, useState, useCallback } = React;
  const hooks = createHooks(React);
  const buttons = createButtons({ React, colors: C });
  const feedbackArea = createFeedbackArea({ buttons, actions: ACTIONS });
  const Notice = createNoticePart({ React, colors: C });
  const ErrorToast = createErrorToast({ React, colors: C });
  const progress = createProgressPart({ React, colors: C, getAudio });
  const HistoryPanel = createHistoryPanel({ React, colors: C, actions: ACTIONS });
  const BarBoundary = createBarBoundary({ React, diag });

  function Bar() {
    const [playing, setPlaying] = useState(false);
    const [now, setNow] = useState(0);
    const [dur, setDur] = useState(0);
    const [pending, setPending] = useState(null);
    const [error, setError] = useState('');
    const [mode, setMode] = hooks.useMode();
    const [showHistory, setShowHistory] = useState(false);
    const [debugOn, setDebugOn] = useState(() => {
      try {
        return localStorage.getItem('bili-music-debug') === '1';
      } catch {
        return false;
      }
    });
    const [vol, setVol] = useState(() => {
      try {
        const v = parseFloat(localStorage.getItem('bili-music-volume'));
        return Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : 0.8;
      } catch {
        return 0.8;
      }
    });
    const [loading, setLoading] = useState(false);
    const [loadPct, setLoadPct] = useState(0);
    const [switching, setSwitching] = useState(false);

    const autoNextRef = useRef(false);
    const goNextRef = useRef(null);
    const barRef = useRef(null);
    const switchingRef = useRef(false);
    const loaderRef = useRef(null);
    const playerRef = useRef(null);
    const volRef = useRef(0.5);
    const modeRef = useRef('recommend');
    const pendingRef = useRef(false);

    const { useServerState, useNotice } = hooks;
    const { state, refresh, setState } = useServerState();
    const { notice, show: showNotice } = useNotice(barRef);

    useEffect(() => {
      modeRef.current = mode;
    }, [mode]);

    useEffect(() => {
      setDiagEnabled(debugOn);
    }, [debugOn]);

    useEffect(() => {
      volRef.current = vol;
      if (playerRef.current) playerRef.current.setVolume(vol);
      try {
        localStorage.setItem('bili-music-volume', String(vol));
      } catch {
        /* 忽略 */
      }
    }, [vol]);

    useEffect(() => {
      ensureDockStyle();
    }, []);

    const current = state.current;
    const active = (current && current.feedback) || null;

    // 音频外部系统：监听、时长解析与 seek 在 player.js，资源加载在 loader.js；
    // 这里只订阅状态，不关心 MSE、取消与看门狗的时序。
    useEffect(() => {
      if (!playerRef.current) {
        playerRef.current = createPlayer({
          diag,
          onState: (snapshot) => {
            setPlaying(snapshot.playing);
            setNow(snapshot.now);
            setDur(snapshot.dur);
          },
          onError: (message) => setError(message),
          onEnded: () => {
            if (modeRef.current === 'loop') {
              const player = playerRef.current;
              player.el.currentTime = 0;
              player.el
                .play()
                .then(() => setPlaying(true))
                .catch(() => setError('循环播放被浏览器拦截，点 ▶ 继续'));
              return;
            }
            goNextRef.current?.();
          },
        });
        loaderRef.current = createLoader({
          el: playerRef.current.el,
          diag,
          onLoading: setLoading,
          onProgress: setLoadPct,
          onPlaying: setPlaying,
          onError: setError,
        });
      }
      playerRef.current.setVolume(volRef.current);
      return () => {
        loaderRef.current?.destroy();
        loaderRef.current = null;
        playerRef.current?.destroy();
        playerRef.current = null;
      };
    }, []);

    const loadAndMaybePlay = useCallback((track) => {
      const loader = loaderRef.current;
      if (!loader) return;
      const key = `${track.bvid}|${track.startedAt || ''}`;
      if (loader.key === key) return;
      const streamUrl = `${track.stream}?t=${encodeURIComponent(track.startedAt || '')}`;
      setNow(0);
      setDur(0);
      const shouldPlay = autoNextRef.current;
      autoNextRef.current = false;
      setPlaying(false);
      loader.load({ track, key, shouldPlay, streamUrl });
    }, []);

    useEffect(() => {
      if (!current) return;
      loadAndMaybePlay(current);
    }, [current, loadAndMaybePlay]);

    const toggle = useCallback(async () => {
      if (!current) return;
      setError('');
      // 上次加载失败（或元素进入 error）：重新走一遍完整加载，而不是退回流式
      if (loaderRef.current?.failed || playerRef.current?.el.error) {
        loaderRef.current?.reset();
        loadAndMaybePlay(current);
        return;
      }
      try {
        await playerRef.current.toggle();
      } catch (e) {
        if (e && e.name === 'NotAllowedError') setError('浏览器拦截了自动播放，点一下页面再按 ▶');
        else setError(`播放失败：${(e && e.message) || e}`);
        setPlaying(false);
      }
    }, [current, loadAndMaybePlay]);

    const go = useCallback(
      async (dir, ev) => {
        // 用 ref 而不是 state 做并发闸门：同一帧内连点两次时 state 还没更新
        if (switchingRef.current) return;
        switchingRef.current = true;
        setSwitching(true);
        try {
          const res = await fetch(`/bili-music/${dir}`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ mode }),
          });
          const data = await res.json().catch(() => ({}));
          if (!res.ok || !data.ok) throw new Error(data.error || `HTTP ${res.status}`);
          if (data.atEnd) {
            autoNextRef.current = false;
            showNotice(
              data.message || (dir === 'next' ? '没有下一首了喵' : '没有上一首歌了喵'),
              'info',
              ev,
            );
            return;
          }
          autoNextRef.current = true;
          await refresh();
        } catch (e) {
          autoNextRef.current = false;
          setError(`${dir === 'next' ? '下一首' : '上一首'}失败：${e.message || e}`);
        } finally {
          switchingRef.current = false;
          setSwitching(false);
        }
      },
      [mode, refresh, showNotice],
    );

    goNextRef.current = () => {
      void go('next');
    };

    /** 进度条点击：按比例换算成秒，媒体未就绪时用后端时长兜底。 */
    const seek = useCallback(
      (event) => {
        const rect = event.currentTarget.getBoundingClientRect();
        if (!rect.width) return;
        const ratio = Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width));
        diag('click', { ratio: +ratio.toFixed(3), biliDur: current && current.duration });
        playerRef.current?.seekRatio(ratio, current && current.duration);
      },
      [current],
    );

    const send = useCallback(
      async (action, targetBvid, ev) => {
        if (pendingRef.current) return;
        const bvid = targetBvid || (current && current.bvid);
        const curFb = targetBvid
          ? (state.history.find((x) => x.bvid === targetBvid) || {}).feedback
          : active;
        // 再点一次已选中的反馈 = 取消标记（feedback.json 里删掉这条）
        const next = curFb === action ? 'clear' : action;
        pendingRef.current = true;
        setPending(action + (targetBvid || ''));
        try {
          const res = await fetch('/bili-music/feedback', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ action: next, bvid: targetBvid || '' }),
          });
          const data = await res.json().catch(() => ({}));
          if (!res.ok || !data.ok) throw new Error(data.error || `HTTP ${res.status}`);
          // 先本地标记：refresh 可能正被轮询占用而跳过，否则按钮看起来没反应
          setState((s) => ({
            ...s,
            current:
              s.current && s.current.bvid === (bvid || s.current.bvid)
                ? { ...s.current, feedback: next === 'clear' ? null : next }
                : s.current,
            history: s.history.map((row) =>
              row.bvid === bvid ? { ...row, feedback: next === 'clear' ? null : next } : row,
            ),
          }));
          if (next === 'clear') {
            if (data.saved && data.saved.error)
              showNotice(`已取消标记，但从收藏夹撤出失败：${data.saved.error}`, 'err', ev);
            else showNotice('已取消标记', 'info', ev);
          } else if (action === 'like') {
            if (data.saved && data.saved.folder)
              showNotice(`已喜欢 · 收进「${data.saved.folder}」`, 'ok', ev);
            else if (data.saved && data.saved.error)
              showNotice(`已喜欢，但收藏失败：${data.saved.error}`, 'err', ev);
            else showNotice('已喜欢', 'ok', ev);
          } else if (action === 'dislike') showNotice('已记不喜欢 · 不再推荐', 'err', ev);
          else showNotice('已跳过', 'info', ev);
          await refresh();
        } catch (e) {
          showNotice(`反馈失败：${e.message || e}`, 'err', ev);
        } finally {
          pendingRef.current = false;
          setPending(null);
        }
      },
      [active, current, refresh, showNotice, state.history],
    );

    if (!current) return null;

    // 调用点用的是位置参数，这里做一次形状适配，渲染逻辑在 parts/buttons.js
    const iconBtn = (glyph, title, onClick, opts = {}) =>
      buttons.iconButton({ glyph, title, onClick, ...opts });

    return h(
      'div',
      {
        'data-bili-music-bar': '1',
        ref: barRef,
        style: {
          position: 'relative',
          flex: '0 0 100%',
          order: -1,
          width: '100%',
          maxWidth: '100%',
          boxSizing: 'border-box',
          margin: '0 auto',
          justifyContent: 'flex-start',
          padding: '2px 0 4px',
          font: '12px/1.4 system-ui, sans-serif',
          color: C.label,
        },
      },
      h(
        'div',
        {
          style: {
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            width: '100%',
            justifyContent: 'flex-start',
          },
        },
        // 左侧控制簇固定宽度，标题/进度变化时按钮不会位移
        h(
          'div',
          { style: { display: 'flex', alignItems: 'center', gap: 2, flexShrink: 0, width: 78 } },
          iconBtn('⏮', '上一首', (e) => go('prev', e), { disabled: switching }),
          iconBtn(
            loading ? '…' : playing ? '⏸' : '▶',
            loading ? '加载中' : playing ? '暂停' : '播放',
            toggle,
            { size: 14 },
          ),
          iconBtn('⏭', '下一首', (e) => go('next', e), { disabled: switching }),
        ),

        // 封面：切歌时能一眼认出来
        current.cover
          ? h('img', {
              src: current.cover,
              alt: '',
              referrerPolicy: 'no-referrer',
              style: {
                width: 26,
                height: 26,
                borderRadius: 4,
                objectFit: 'cover',
                flexShrink: 0,
                background: C.layer3,
              },
              onError: (e) => {
                e.currentTarget.style.display = 'none';
              },
            })
          : null,

        h(
          'div',
          {
            style: {
              minWidth: 0,
              flex: '0 0 214px',
              width: 214,
              maxWidth: 214,
              display: 'flex',
              gap: 6,
              alignItems: 'baseline',
              overflow: 'hidden',
            },
            title: current.title,
          },
          h(
            'span',
            {
              style: {
                fontWeight: 600,
                whiteSpace: 'nowrap',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                flexShrink: 1,
              },
            },
            current.title,
          ),
          h(
            'span',
            {
              style: {
                color: C.label2,
                whiteSpace: 'nowrap',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                flexShrink: 2,
              },
            },
            current.artist || '',
          ),
        ),

        progress.timeLabel({
          loading,
          loadPct,
          now,
          duration: dur || current.duration || 0,
          onToggleDebug: () => {
            setDebugOn((v) => {
              const next = !v;
              try {
                localStorage.setItem('bili-music-debug', next ? '1' : '0');
              } catch {
                /* 忽略 */
              }
              return next;
            });
          },
        }),

        debugOn ? progress.debugReadout() : null,

        progress.progressBar({ now, dur, onSeek: seek }),

        // 音量：喇叭点一下静音/恢复，滑条微调
        h(
          'div',
          { style: { display: 'flex', alignItems: 'center', gap: 3, flexShrink: 0 } },
          h(
            'span',
            {
              title: vol > 0 ? '静音' : '恢复音量',
              onClick: () => setVol(vol > 0 ? 0 : 0.8),
              style: { fontSize: 11, cursor: 'pointer', color: C.label3, lineHeight: 1 },
            },
            vol === 0 ? '🔇' : vol < 0.5 ? '🔉' : '🔊',
          ),
          h('input', {
            type: 'range',
            min: 0,
            max: 1,
            step: 0.01,
            value: vol,
            onChange: (e) => setVol(Number(e.currentTarget.value)),
            title: `音量 ${Math.round(vol * 100)}%`,
            style: { width: 48, height: 14, cursor: 'pointer', accentColor: C.brand, margin: 0 },
          }),
        ),

        buttons.modeButton({ mode, onToggle: setMode }),
        iconBtn(
          '🕘',
          '播放历史 / 补反馈',
          () => {
            setShowHistory((v) => !v);
            refresh();
          },
          { active: showHistory, size: 12 },
        ),

        feedbackArea({ active, pending, onSend: send }),
      ),

      // 浮动提示与错误条：定位与样式在 parts/notice.js
      h(Notice, { notice, anchor: barRef.current }),

      h(ErrorToast, { message: error }),

      h(HistoryPanel, {
        open: showHistory,
        history: state.history,
        currentBvid: current.bvid,
        onClose: () => setShowHistory(false),
        onFeedback: send,
      }),
    );
  }

  function BarWithBoundary() {
    return h(BarBoundary, null, h(Bar));
  }

  return BarWithBoundary;
}
