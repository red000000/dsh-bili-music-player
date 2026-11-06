/**
 * 播放条组件：dock 内的一行，含播放控制、进度、模式、历史与反馈。
 *
 * 这里是编排层：持有状态、串起副作用，把展示交给 parts/、音频交给
 * audio-player.js 与 audio-loader.js。组件不直接引用 React，由调用方注入，因此可以
 * 脱离 DSH loader 单独渲染测试。
 */
import { reportDiagnostic, setDiagnosticsEnabled } from './diagnostics.js';
import { getAudioElement } from './audio-element.js';
import { getAudioEngine } from './audio-engine.js';
import { createPlayerBarBoundary } from './player-bar-boundary.js';
import { createHooks } from './player-bar-hooks.js';
import { createButtons } from './player-bar-parts/buttons.js';
import { createFeedbackButtons } from './player-bar-parts/feedback.js';
import { createHistoryPanel } from './player-bar-parts/history.js';
import { createErrorToast, createNotice } from './player-bar-parts/notice.js';
import { createProgress } from './player-bar-parts/progress.js';
import { updatePlayback } from './playback-store.js';
import { FEEDBACK_ACTIONS, COLORS, ensureDockStyle } from './player-bar-theme.js';

export function createPlayerBar(React) {
  const h = React.createElement;
  const { useEffect, useRef, useState, useCallback } = React;
  const hooks = createHooks(React);
  const buttons = createButtons({ React, colors: COLORS });
  const feedbackArea = createFeedbackButtons({ buttons, actions: FEEDBACK_ACTIONS });
  const Notice = createNotice({ React, colors: COLORS });
  const ErrorToast = createErrorToast({ React, colors: COLORS });
  const progress = createProgress({ React, colors: COLORS, getAudioElement });
  const HistoryPanel = createHistoryPanel({ React, colors: COLORS, actions: FEEDBACK_ACTIONS });
  const BarBoundary = createPlayerBarBoundary({ React, reportDiagnostic });

  function Bar() {
    const [pendingFeedback, setPendingFeedback] = useState(null);
    const [mode, setMode] = hooks.useMode();
    const [showHistory, setShowHistory] = useState(false);
    const [debugOn, setDebugOn] = useState(() => {
      try {
        return localStorage.getItem('bili-music-debug') === '1';
      } catch {
        return false;
      }
    });
    const [volume, setVolume] = useState(() => {
      try {
        const v = parseFloat(localStorage.getItem('bili-music-volume'));
        return Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : 0.8;
      } catch {
        return 0.8;
      }
    });
    const [switching, setSwitching] = useState(false);

    const autoPlayRef = useRef(false);
    const changeTrackRef = useRef(null);
    const barRef = useRef(null);
    const switchingRef = useRef(false);
    const engineRef = useRef(null);
    const volumeRef = useRef(0.5);
    const modeRef = useRef('recommend');
    const pendingFeedbackRef = useRef(false);

    const { useServerState, useNotice, usePlayback } = hooks;
    const { serverState, refreshServerState, setServerState } = useServerState();
    const { notice, showNotice } = useNotice(barRef);
    // 播放状态来自模块级 store：切会话重建组件后进度、加载与错误都还在
    const { playing, position, duration, loading, loadPercent, error } = usePlayback();

    useEffect(() => {
      modeRef.current = mode;
    }, [mode]);

    useEffect(() => {
      setDiagnosticsEnabled(debugOn);
    }, [debugOn]);

    useEffect(() => {
      volumeRef.current = volume;
      if (engineRef.current) engineRef.current.player.setVolume(volume);
      try {
        localStorage.setItem('bili-music-volume', String(volume));
      } catch {
        /* 忽略 */
      }
    }, [volume]);

    useEffect(() => {
      ensureDockStyle();
    }, []);

    const currentTrack = serverState.current;
    const activeFeedback = (currentTrack && currentTrack.feedback) || null;

    // 模块级音频引擎：播放器与加载器只建一次。会话切换会卸载本组件，
    // 但引擎与 playback-store 都不销毁，音乐继续播；这里只订阅「播完」。
    useEffect(() => {
      const engine = getAudioEngine();
      engineRef.current = engine;
      engine.player.setVolume(volumeRef.current);
      const off = engine.subscribeEnded(() => {
        if (modeRef.current === 'loop') {
          const { player } = engine;
          player.el.currentTime = 0;
          player.el
            .play()
            .then(() => updatePlayback({ playing: true }))
            .catch(() => updatePlayback({ error: '循环播放被浏览器拦截，点 ▶ 继续' }));
          return;
        }
        changeTrackRef.current?.();
      });
      return () => {
        off();
        engineRef.current = null;
      };
    }, []);

    const loadAndMaybePlay = useCallback((track) => {
      const engine = engineRef.current;
      if (!engine) return;
      const key = `${track.bvid}|${track.startedAt || ''}`;
      if (engine.loader.key === key) return;
      const streamUrl = `${track.stream}?t=${encodeURIComponent(track.startedAt || '')}`;
      updatePlayback({ position: 0, duration: 0, playing: false });
      const shouldPlay = autoPlayRef.current;
      autoPlayRef.current = false;
      engine.loader.load({ track, key, shouldPlay, streamUrl });
    }, []);

    useEffect(() => {
      if (!currentTrack) return;
      loadAndMaybePlay(currentTrack);
    }, [currentTrack, loadAndMaybePlay]);

    const togglePlayback = useCallback(async () => {
      if (!currentTrack) return;
      updatePlayback({ error: '' });
      const engine = engineRef.current;
      if (!engine) return;
      // 上次加载失败（或元素进入 error）：重新走一遍完整加载，而不是退回流式
      if (engine.loader.failed || engine.player.el.error) {
        engine.loader.reset();
        loadAndMaybePlay(currentTrack);
        return;
      }
      try {
        await engine.player.togglePlayback();
      } catch (e) {
        if (e && e.name === 'NotAllowedError')
          updatePlayback({ error: '浏览器拦截了自动播放，点一下页面再按 ▶', playing: false });
        else updatePlayback({ error: `播放失败：${(e && e.message) || e}`, playing: false });
      }
    }, [currentTrack, loadAndMaybePlay]);

    const changeTrack = useCallback(
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
            autoPlayRef.current = false;
            showNotice(
              data.message || (dir === 'next' ? '没有下一首了喵' : '没有上一首歌了喵'),
              'info',
              ev,
            );
            return;
          }
          autoPlayRef.current = true;
          await refreshServerState();
        } catch (e) {
          autoPlayRef.current = false;
          updatePlayback({
            error: `${dir === 'next' ? '下一首' : '上一首'}失败：${e.message || e}`,
          });
        } finally {
          switchingRef.current = false;
          setSwitching(false);
        }
      },
      [mode, refreshServerState, showNotice],
    );

    changeTrackRef.current = () => {
      void changeTrack('next');
    };

    /** 进度条点击：按比例换算成秒，媒体未就绪时用后端时长兜底。 */
    const seek = useCallback(
      (event) => {
        const rect = event.currentTarget.getBoundingClientRect();
        if (!rect.width) return;
        const ratio = Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width));
        reportDiagnostic('click', {
          ratio: +ratio.toFixed(3),
          biliDur: currentTrack && currentTrack.duration,
        });
        engineRef.current?.player.seekRatio(ratio, currentTrack && currentTrack.duration);
      },
      [currentTrack],
    );

    const sendFeedback = useCallback(
      async (action, targetBvid, ev) => {
        if (pendingFeedbackRef.current) return;
        const bvid = targetBvid || (currentTrack && currentTrack.bvid);
        const curFb = targetBvid
          ? (serverState.history.find((x) => x.bvid === targetBvid) || {}).feedback
          : activeFeedback;
        // 再点一次已选中的反馈 = 取消标记（feedback.json 里删掉这条）
        const next = curFb === action ? 'clear' : action;
        pendingFeedbackRef.current = true;
        setPendingFeedback(action + (targetBvid || ''));
        try {
          const res = await fetch('/bili-music/feedback', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ action: next, bvid: targetBvid || '' }),
          });
          const data = await res.json().catch(() => ({}));
          if (!res.ok || !data.ok) throw new Error(data.error || `HTTP ${res.status}`);
          // 先本地标记：refreshServerState 可能正被轮询占用而跳过，否则按钮看起来没反应
          setServerState((s) => ({
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
          await refreshServerState();
        } catch (e) {
          showNotice(`反馈失败：${e.message || e}`, 'err', ev);
        } finally {
          pendingFeedbackRef.current = false;
          setPendingFeedback(null);
        }
      },
      [activeFeedback, currentTrack, refreshServerState, showNotice, serverState.history],
    );

    if (!currentTrack) return null;

    // 调用点用的是位置参数，这里做一次形状适配，渲染逻辑在 parts/buttons.js
    const iconBtn = (glyph, title, onClick, opts = {}) =>
      buttons.iconButton({ glyph, title, onClick, ...opts });

    const displayDuration = duration || currentTrack.duration || 0;

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
          color: COLORS.label,
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
          iconBtn('⏮', '上一首', (e) => changeTrack('prev', e), { disabled: switching }),
          iconBtn(
            loading ? '…' : playing ? '⏸' : '▶',
            loading ? '加载中' : playing ? '暂停' : '播放',
            togglePlayback,
            { size: 14 },
          ),
          iconBtn('⏭', '下一首', (e) => changeTrack('next', e), { disabled: switching }),
        ),

        // 封面：切歌时能一眼认出来
        currentTrack.cover
          ? h('img', {
              src: currentTrack.cover,
              alt: '',
              referrerPolicy: 'no-referrer',
              style: {
                width: 26,
                height: 26,
                borderRadius: 4,
                objectFit: 'cover',
                flexShrink: 0,
                background: COLORS.layer3,
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
            title: currentTrack.title,
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
            currentTrack.title,
          ),
          h(
            'span',
            {
              style: {
                color: COLORS.label2,
                whiteSpace: 'nowrap',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                flexShrink: 2,
              },
            },
            currentTrack.artist || '',
          ),
        ),

        progress.timeLabel({
          loading,
          loadPercent,
          position,
          duration: displayDuration,
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

        progress.progressBar({ position, duration, onSeek: seek }),

        // 音量：喇叭点一下静音/恢复，滑条微调
        h(
          'div',
          { style: { display: 'flex', alignItems: 'center', gap: 3, flexShrink: 0 } },
          h(
            'span',
            {
              title: volume > 0 ? '静音' : '恢复音量',
              onClick: () => setVolume(volume > 0 ? 0 : 0.8),
              style: { fontSize: 11, cursor: 'pointer', color: COLORS.label3, lineHeight: 1 },
            },
            volume === 0 ? '🔇' : volume < 0.5 ? '🔉' : '🔊',
          ),
          h('input', {
            type: 'range',
            min: 0,
            max: 1,
            step: 0.01,
            value: volume,
            onChange: (e) => setVolume(Number(e.currentTarget.value)),
            title: `音量 ${Math.round(volume * 100)}%`,
            style: {
              width: 48,
              height: 14,
              cursor: 'pointer',
              accentColor: COLORS.brand,
              margin: 0,
            },
          }),
        ),

        buttons.modeButton({ mode, onToggle: setMode }),
        iconBtn(
          '🕘',
          '播放历史 / 补反馈',
          () => {
            setShowHistory((v) => !v);
            refreshServerState();
          },
          { active: showHistory, size: 12 },
        ),

        feedbackArea({ activeFeedback, pendingFeedback, onSend: sendFeedback }),
      ),

      // 浮动提示与错误条：定位与样式在 parts/notice.js
      h(Notice, { notice, anchor: barRef.current }),

      h(ErrorToast, { message: error }),

      h(HistoryPanel, {
        open: showHistory,
        history: serverState.history,
        currentBvid: currentTrack.bvid,
        onClose: () => setShowHistory(false),
        onFeedback: sendFeedback,
      }),
    );
  }

  function BarWithBoundary() {
    return h(BarBoundary, null, h(Bar));
  }

  return BarWithBoundary;
}
