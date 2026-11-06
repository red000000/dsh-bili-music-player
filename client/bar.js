/**
 * 播放条组件：dock 内的一行，含播放控制、进度、模式、历史与反馈。
 *
 * 组件不直接引用 React，由调用方注入，因此可以脱离 DSH loader 单独渲染测试。
 * 颜色与动作定义留在本文件，属于表现层细节。
 */
import { diag, setDiagEnabled } from './diag.js';
import { getAudio } from './audio.js';

export function createBar(React) {
  const h = React.createElement;
  const { useEffect, useRef, useState, useCallback } = React;

  // 当前已加载的曲目键，用于避免重复加载同一条
  let sharedKey = '';

  const ACTIONS = [
    { key: 'like', icon: '👍', label: '喜欢', tip: '收进「点歌助手」收藏夹' },
    { key: 'skip', icon: '⏭', label: '跳过', tip: '跳过，权重几乎不变' },
    { key: 'dislike', icon: '👎', label: '不喜欢', tip: '之后不再推荐这首' },
  ];
  const MODE_KEY = 'bili-music-mode';
  const STYLE_ID = 'bili-music-bar-style';

  const C = {
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

  const fmt = (sec) => {
    if (!Number.isFinite(sec) || sec < 0) return '0:00';
    return `${Math.floor(sec / 60)}:${String(Math.floor(sec % 60)).padStart(2, '0')}`;
  };

  function Bar() {
    const [state, setState] = useState({ current: null, history: [] });
    const [playing, setPlaying] = useState(false);
    const [now, setNow] = useState(0);
    const [dur, setDur] = useState(0);
    const [notice, setNotice] = useState(null);
    const [pending, setPending] = useState(null);
    const [error, setError] = useState('');
    const [mode, setMode] = useState(() => {
      try {
        return localStorage.getItem(MODE_KEY) || 'recommend';
      } catch {
        return 'recommend';
      }
    });
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

    const noticeTimer = useRef(null);
    const autoNextRef = useRef(false);
    const mountRef = useRef(true);
    const goNextRef = useRef(null);
    const barRef = useRef(null);
    const lastSeekAt = useRef(0);
    const switchingRef = useRef(false);
    const refreshingRef = useRef(false);
    const failKeyRef = useRef('');
    const pendingRef = useRef(false);

    /** 提示优先从鼠标点击处冒出；没有坐标时退回播放条上方。 */
    const showNotice = useCallback((text, tone = 'ok', ev) => {
      let x;
      let y;
      if (ev && Number.isFinite(ev.clientX)) {
        x = ev.clientX;
        y = ev.clientY;
      } else if (barRef.current) {
        const r = barRef.current.getBoundingClientRect();
        x = r.left + r.width / 2;
        y = r.top;
      }
      setNotice({ text, tone, x, y });
      if (noticeTimer.current) clearTimeout(noticeTimer.current);
      noticeTimer.current = setTimeout(() => {
        if (mountRef.current) setNotice(null);
      }, 2400);
    }, []);

    const refresh = useCallback(async () => {
      // 上一次还没回来就跳过，避免慢请求叠加导致状态回退
      if (refreshingRef.current) return;
      refreshingRef.current = true;
      try {
        const res = await fetch('/bili-music/state', { cache: 'no-store' });
        if (!res.ok) return;
        const data = await res.json();
        if (!mountRef.current) return;
        setState({ current: data.current || null, history: data.history || [] });
      } catch {
        /* 忽略 */
      } finally {
        refreshingRef.current = false;
      }
    }, []);

    useEffect(() => {
      mountRef.current = true;
      refresh();
      const timer = setInterval(refresh, 5000);
      return () => {
        mountRef.current = false;
        clearInterval(timer);
        if (noticeTimer.current) clearTimeout(noticeTimer.current);
      };
    }, [refresh]);

    useEffect(() => {
      try {
        localStorage.setItem(MODE_KEY, mode);
      } catch {
        /* 忽略 */
      }
    }, [mode]);

    useEffect(() => {
      setDiagEnabled(debugOn);
    }, [debugOn]);

    useEffect(() => {
      getAudio().volume = vol;
      try {
        localStorage.setItem('bili-music-volume', String(vol));
      } catch {
        /* 忽略 */
      }
    }, [vol]);

    // 让 dock 换行并把内容靠左：否则整行参与居中，宽度会随标题长度变化
    useEffect(() => {
      if (document.getElementById(STYLE_ID)) return;
      const st = document.createElement('style');
      st.id = STYLE_ID;
      // 只让 dock 换行；行内对齐交给各自元素，统计行保持默认居中
      st.textContent = '[data-composer-dock]{flex-wrap:wrap!important}';
      document.head.appendChild(st);
    }, []);

    const current = state.current;
    const active = (current && current.feedback) || null;

    // 音频事件：只挂监听，不销毁元素
    useEffect(() => {
      const el = getAudio();
      // 挂载时从媒体元素同步真实状态：切换会话后组件会重建，
      // 若只依赖 play/pause 事件，按钮会错误地显示成未播放。
      setPlaying(!el.paused);
      setNow(el.currentTime || 0);
      setDur(Number.isFinite(el.duration) ? el.duration : 0);
      const onTime = () => {
        setNow(el.currentTime || 0);
        setDur(Number.isFinite(el.duration) ? el.duration : 0);
      };
      const onPlay = () => {
        setPlaying(true);
        setError('');
      };
      const onPause = () => setPlaying(false);
      const onEnded = () => {
        // 防御：seek 越界/抖动时浏览器可能立刻抛 ended，别把它当成真的播完
        if (Date.now() - lastSeekAt.current < 800) return;
        const total = el.duration;
        if (Number.isFinite(total) && el.currentTime < total - 0.5) return;
        setPlaying(false);
        if (mode === 'loop') {
          el.currentTime = 0;
          el.play()
            .then(() => setPlaying(true))
            .catch(() => setError('循环播放被浏览器拦截，点 ▶ 继续'));
        } else if (goNextRef.current) {
          goNextRef.current();
        }
      };
      const onError = () => {
        if (el.error) setError(`音频加载失败（${el.error.code}），点 ▶ 重试`);
      };

      /**
       * B 站音频是 fragmented MP4，浏览器常常报 duration=Infinity、seekable=[]，
       * 这时设置 currentTime 会被忽略或回退到 0。行业通行做法：先把 currentTime
       * 设到一个极大值强制浏览器解析出真实时长，再回到 0。
       */
      const resolveDuration = () => {
        setDur(Number.isFinite(el.duration) ? el.duration : 0);
        if (Number.isFinite(el.duration)) return;
        diag('duration-infinity', { rs: el.readyState, cur: el.currentTime });
        const onDuration = () => {
          el.removeEventListener('durationchange', onDuration);
          if (Number.isFinite(el.duration)) {
            diag('duration-resolved', { dur: +el.duration.toFixed(2) });
            try {
              el.currentTime = 0;
            } catch {
              /* 忽略 */
            }
            setDur(el.duration);
          }
        };
        el.addEventListener('durationchange', onDuration);
        try {
          el.currentTime = 1e101;
        } catch {
          /* 忽略 */
        }
      };
      el.addEventListener('loadedmetadata', resolveDuration);

      el.addEventListener('timeupdate', onTime);
      el.addEventListener('loadedmetadata', onTime);
      el.addEventListener('play', onPlay);
      el.addEventListener('pause', onPause);
      el.addEventListener('ended', onEnded);
      el.addEventListener('error', onError);
      return () => {
        el.removeEventListener('timeupdate', onTime);
        el.removeEventListener('loadedmetadata', onTime);
        el.removeEventListener('loadedmetadata', resolveDuration);
        el.removeEventListener('play', onPlay);
        el.removeEventListener('pause', onPause);
        el.removeEventListener('ended', onEnded);
        el.removeEventListener('error', onError);
      };
    }, [mode]);

    // 播放资源引用：blob/MS 的 object URL、当前 MediaSource、MSE 是否已起播
    const blobUrlRef = useRef(null);
    const mediaSrcRef = useRef(null);
    const mseStartedRef = useRef(false);

    // 把「按绝对偏移切片」封装成流式读取：一次连接拿完整文件，
    // 读到某段边界就把那段灌给 MSE，避免逐段请求的高 TTFB。
    const makeSlicer = () => {
      const chunks = [];
      let received = 0;
      return {
        get received() {
          return received;
        },
        push(chunk) {
          chunks.push(chunk);
          received += chunk.length;
        },
        slice(start, end) {
          const out = new Uint8Array(end - start + 1);
          let written = 0;
          let offset = 0;
          for (const c of chunks) {
            const cStart = offset;
            const cEnd = offset + c.length - 1;
            offset += c.length;
            if (cEnd < start) continue;
            if (cStart > end) break;
            const from = Math.max(0, start - cStart);
            const to = Math.min(c.length - 1, end - cStart);
            out.set(c.subarray(from, to + 1), written);
            written += to - from + 1;
          }
          return written === out.length ? out : out.subarray(0, written);
        },
      };
    };

    const loadMse = useCallback(async (track, key, shouldPlay, streamUrl) => {
      const el = getAudio();
      const res = await fetch(`/bili-music/manifest/${track.bvid}`, { cache: 'no-store' });
      if (!res.ok) throw new Error(`manifest HTTP ${res.status}`);
      const mf = await res.json();
      if (!mf.ok || !mf.segments?.length) throw new Error('no segments');

      const ms = new MediaSource();
      mediaSrcRef.current = ms;
      if (blobUrlRef.current) URL.revokeObjectURL(blobUrlRef.current);
      const url = URL.createObjectURL(ms);
      blobUrlRef.current = url;
      el.src = url;

      await new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error('sourceopen timeout')), 8000);
        ms.addEventListener(
          'sourceopen',
          () => {
            clearTimeout(t);
            resolve();
          },
          { once: true },
        );
      });
      if (sharedKey !== key) return;

      const sb = ms.addSourceBuffer(mf.codec);
      // updateend 有可能永远不来（解码器/分段异常），加超时避免整条链路挂死
      const waitUpdate = () =>
        new Promise((resolve, reject) => {
          if (!sb.updating) {
            resolve();
            return;
          }
          const t = setTimeout(() => {
            sb.removeEventListener('updateend', onEnd);
            reject(new Error('append timeout'));
          }, 5000);
          const onEnd = () => {
            clearTimeout(t);
            resolve();
          };
          sb.addEventListener('updateend', onEnd, { once: true });
        });

      // 单次请求拿完整文件（服务端已缓存则走磁盘，未缓存则透传 CDN）
      const body = await fetch(streamUrl, { cache: 'force-cache' });
      if (!body.ok) throw new Error(`stream HTTP ${body.status}`);
      const reader = body.body.getReader();
      const slicer = makeSlicer();
      const total = mf.segments.length;
      let appendedInit = false;
      let segIndex = 0;
      let started = false;

      const tryStart = () => {
        if (started) return;
        started = true;
        mseStartedRef.current = true;
        setLoading(false);
        failKeyRef.current = '';
        setError('');
        diag('mse-ready', { bvid: track.bvid, segments: total, duration: mf.duration });
        if (shouldPlay) {
          el.play()
            .then(() => setPlaying(true))
            .catch(() => setError('浏览器拦截了自动播放，点 ▶ 继续'));
        }
      };

      for (;;) {
        const { done, value } = await reader.read();
        if (sharedKey !== key) {
          try {
            await reader.cancel();
          } catch {
            /* 忽略 */
          }
          try {
            ms.endOfStream();
          } catch {
            /* 忽略 */
          }
          return;
        }
        if (done) break;
        slicer.push(value);

        if (!appendedInit && slicer.received > mf.init.end) {
          await waitUpdate();
          sb.appendBuffer(slicer.slice(mf.init.start, mf.init.end));
          await waitUpdate();
          try {
            ms.duration = mf.duration;
          } catch {
            /* 忽略 */
          }
          appendedInit = true;
        }
        while (appendedInit && segIndex < total && slicer.received > mf.segments[segIndex].end) {
          const seg = mf.segments[segIndex];
          await waitUpdate();
          sb.appendBuffer(slicer.slice(seg.start, seg.end));
          await waitUpdate();
          segIndex++;
          setLoadPct(segIndex / total);
          // 第一段就绪即可起播
          if (segIndex >= 1) tryStart();
        }
      }
      // 文件读完：把剩余分段补完
      while (appendedInit && segIndex < total) {
        const seg = mf.segments[segIndex];
        await waitUpdate();
        sb.appendBuffer(slicer.slice(seg.start, seg.end));
        await waitUpdate();
        segIndex++;
        setLoadPct(segIndex / total);
        if (segIndex >= 1) tryStart();
      }
      tryStart();
      setLoading(false);
      try {
        ms.endOfStream();
      } catch {
        /* 忽略 */
      }
    }, []);

    const loadBlob = useCallback(async (track, key, shouldPlay, streamUrl) => {
      const el = getAudio();
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 45000);
      try {
        const r = await fetch(streamUrl, { cache: 'force-cache', signal: controller.signal });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const total = Number(r.headers.get('content-length')) || 0;
        const reader = r.body.getReader();
        const chunks = [];
        let received = 0;
        let lastTick = 0;
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          chunks.push(value);
          received += value.length;
          const now = Date.now();
          if (total && now - lastTick > 200) {
            lastTick = now;
            setLoadPct(Math.min(0.99, received / total));
            if (sharedKey !== key) {
              try {
                await reader.cancel();
              } catch {
                /* 忽略 */
              }
              break;
            }
          }
        }
        if (sharedKey !== key) return;
        const blob = new Blob(chunks, { type: 'audio/mp4' });
        if (blobUrlRef.current) URL.revokeObjectURL(blobUrlRef.current);
        const url = URL.createObjectURL(blob);
        blobUrlRef.current = url;
        el.src = url;
        el.load();
        setLoading(false);
        setLoadPct(1);
        setError('');
        failKeyRef.current = '';
        diag('blob-ready', { bvid: track.bvid, size: blob.size });
        if (shouldPlay) {
          el.play()
            .then(() => setPlaying(true))
            .catch(() => setError('浏览器拦截了自动播放，点 ▶ 继续'));
        }
      } finally {
        clearTimeout(timer);
      }
    }, []);

    const loadAndMaybePlay = useCallback(
      (track) => {
        const el = getAudio();
        const key = `${track.bvid}|${track.startedAt || ''}`;
        if (sharedKey === key) return;
        sharedKey = key;
        const streamUrl = `${track.stream}?t=${encodeURIComponent(track.startedAt || '')}`;
        setNow(0);
        setDur(0);
        setLoadPct(0);
        setLoading(true);

        const shouldPlay = autoNextRef.current;
        autoNextRef.current = false;

        // 先停掉旧音频，避免「标题是新歌、声音还是上一首」
        try {
          el.pause();
        } catch {
          /* 忽略 */
        }
        setPlaying(false);

        mseStartedRef.current = false;
        // 看门狗：MSE 10 秒内没起来（卡在 sourceopen/append）就切整首下载，避免整条链路挂死
        const watchdog = setTimeout(() => {
          if (sharedKey !== key || mseStartedRef.current) return;
          diag('mse-watchdog', { bvid: track.bvid });
          try {
            mediaSrcRef.current?.endOfStream();
          } catch {
            /* 忽略 */
          }
          loadBlob(track, key, true, streamUrl).catch(() => {
            if (sharedKey !== key) return;
            setLoading(false);
            failKeyRef.current = key;
            setError('音源加载失败，点 ▶ 重试');
          });
        }, 10000);

        loadMse(track, key, shouldPlay, streamUrl).catch((e) => {
          if (sharedKey !== key) return;
          clearTimeout(watchdog);
          diag('mse-fail', { bvid: track.bvid, err: String(e && e.message) });
          // MSE 不可用（极少见）时退回整首下载，保证能播且能 seek
          loadBlob(track, key, shouldPlay, streamUrl).catch((e2) => {
            if (sharedKey !== key) return;
            setLoading(false);
            failKeyRef.current = key;
            const reason = e2 && e2.name === 'AbortError' ? '加载超时' : e2.message || e2;
            setError(`音源加载失败（${reason}），点 ▶ 重试`);
          });
        });
      },
      [loadMse, loadBlob],
    );

    useEffect(() => {
      if (!current) return;
      loadAndMaybePlay(current);
    }, [current, loadAndMaybePlay]);

    const toggle = useCallback(async () => {
      const el = getAudio();
      if (!current) return;
      setError('');
      // 上次加载失败（或元素进入 error）：重新走一遍完整加载，而不是退回流式
      if (failKeyRef.current || el.error) {
        sharedKey = '';
        el.removeAttribute('src');
        el.load();
        loadAndMaybePlay(current);
        return;
      }
      if (el.ended || (el.duration && el.currentTime >= el.duration - 0.2)) el.currentTime = 0;
      try {
        if (el.paused) {
          await el.play();
          setPlaying(true);
        } else {
          el.pause();
          setPlaying(false);
        }
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

    /**
     * 标准 seek 流程（参考 HTMLMediaElement 规范与常见播放器实现）：
     * 1) 只有 readyState >= HAVE_CURRENT_DATA 时才允许设置 currentTime；
     * 2) 否则等 canplay，期间不重设 src（重设 = 回到 0 秒，这是之前抖动的根源）；
     * 3) 用 seeked 事件确认，不做「超时就重载」这种猜测性补救。
     */
    const seekTo = useCallback((target) => {
      const el = getAudio();
      if (!Number.isFinite(target) || target < 0) return;
      let bounded = target;
      if (Number.isFinite(el.duration) && el.duration > 0) {
        bounded = Math.min(bounded, el.duration - 0.25);
      }
      // 有 seekable 区间时再夹一次，避免落到未缓冲区导致立刻 ended
      try {
        if (el.seekable && el.seekable.length > 0) {
          const s = el.seekable.start(el.seekable.length - 1);
          const e = el.seekable.end(el.seekable.length - 1);
          // 只在目标已落在可跳区间内时才夹紧；落在未缓冲区域就交给浏览器缓冲，
          // 否则 MSE 边下边播时拖动会被拉回当前缓冲末尾。
          if (e > s && bounded <= e) bounded = Math.min(Math.max(bounded, s), e - 0.25);
        }
      } catch {
        /* 忽略 */
      }
      if (!Number.isFinite(bounded) || bounded < 0) return;

      const apply = () => {
        lastSeekAt.current = Date.now();
        const snap = () => ({
          bvid: current && current.bvid,
          rs: el.readyState,
          dur: Number.isFinite(el.duration) ? +el.duration.toFixed(2) : String(el.duration),
          cur: +el.currentTime.toFixed(2),
          paused: el.paused,
          seekable: (() => {
            try {
              return el.seekable && el.seekable.length
                ? [el.seekable.start(0), el.seekable.end(el.seekable.length - 1)]
                : [];
            } catch {
              return [];
            }
          })(),
        });
        try {
          el.currentTime = bounded;
          setNow(bounded);
        } catch (e) {
          diag('seek-throw', { target: bounded, err: String(e && e.message) });
          return;
        }
        diag('seek-before', { target: +bounded.toFixed(2), ...snap() });
        setTimeout(() => diag('seek-after', { target: +bounded.toFixed(2), ...snap() }), 350);
        setTimeout(() => diag('seek-after-1s', { target: +bounded.toFixed(2), ...snap() }), 1100);
      };

      if (el.readyState >= 2) {
        apply();
        return;
      }
      const onReady = () => {
        el.removeEventListener('canplay', onReady);
        el.removeEventListener('loadeddata', onReady);
        apply();
      };
      el.addEventListener('canplay', onReady);
      el.addEventListener('loadeddata', onReady);
    }, []);

    const seek = useCallback(
      (event) => {
        const el = getAudio();
        const rect = event.currentTarget.getBoundingClientRect();
        if (!rect.width) return;
        const ratio = Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width));
        // 优先用媒体自身的 duration；未加载元数据时才退回 B 站给的时长
        const total =
          Number.isFinite(el.duration) && el.duration > 0
            ? el.duration
            : (current && current.duration) || 0;
        if (!total) return;
        diag('click', {
          ratio: +ratio.toFixed(3),
          total: +total.toFixed(1),
          rs: el.readyState,
          cur: +el.currentTime.toFixed(2),
          dur: el.duration,
          biliDur: current && current.duration,
          paused: el.paused,
        });
        seekTo(ratio * total);
      },
      [current, seekTo],
    );

    const send = useCallback(
      async (action, targetBvid, ev) => {
        if (pendingRef.current) return;
        const bvid = targetBvid || (current && current.bvid);
        const curFb = targetBvid
          ? (state.history.find((x) => x.bvid === targetBvid) || {}).feedback
          : active;
        // 提前返回必须在加锁之前，否则锁不会释放，整个反馈区会卡死
        if (curFb === action) {
          showNotice('已经是这个反馈了', 'info', ev);
          return;
        }
        pendingRef.current = true;
        setPending(action + (targetBvid || ''));
        try {
          const res = await fetch('/bili-music/feedback', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ action, bvid: targetBvid || '' }),
          });
          const data = await res.json().catch(() => ({}));
          if (!res.ok || !data.ok) throw new Error(data.error || `HTTP ${res.status}`);
          // 先本地标记：refresh 可能正被轮询占用而跳过，否则按钮看起来没反应
          setState((s) => ({
            ...s,
            current:
              s.current && s.current.bvid === (bvid || s.current.bvid)
                ? { ...s.current, feedback: action }
                : s.current,
            history: s.history.map((row) =>
              row.bvid === bvid ? { ...row, feedback: action } : row,
            ),
          }));
          if (action === 'like') {
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

    const iconBtn = (glyph, title, onClick, opts = {}) =>
      h(
        'button',
        {
          type: 'button',
          title,
          onClick,
          disabled: !!opts.disabled,
          style: {
            border: 'none',
            background: 'transparent',
            color: opts.active ? C.brand : C.label2,
            borderRadius: 6,
            width: 24,
            height: 22,
            cursor: 'pointer',
            fontSize: opts.size || 13,
            lineHeight: 1,
            padding: 0,
            flexShrink: 0,
            fontWeight: opts.active ? 700 : 400,
          },
        },
        glyph,
      );

    const fbBtn = (item) => {
      const on = active === item.key;
      const busy = pending === item.key;
      return h(
        'button',
        {
          type: 'button',
          title: on ? `已标记：${item.label}` : item.tip,
          disabled: !!pending,
          'aria-pressed': on,
          onClick: (e) => send(item.key, '', e),
          style: {
            border: 'none',
            background: on ? `color-mix(in srgb, ${C.brand} 16%, transparent)` : 'transparent',
            color: on ? C.brand : C.label2,
            borderRadius: 6,
            width: 24,
            height: 22,
            cursor: pending ? 'wait' : 'pointer',
            fontSize: 13,
            lineHeight: 1,
            padding: 0,
            flexShrink: 0,
            fontWeight: on ? 700 : 400,
          },
        },
        busy ? '…' : on ? '✓' : item.icon,
      );
    };

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

        h(
          'span',
          {
            title: '点击切换调试信息（桌面版没有 DevTools 也能看）',
            onClick: () => {
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
            style: {
              color: loading ? C.brand : C.label3,
              fontVariantNumeric: 'tabular-nums',
              flexShrink: 0,
              width: 82,
              textAlign: 'right',
              cursor: 'pointer',
            },
          },
          loading
            ? `加载 ${Math.round(loadPct * 100)}%`
            : `${fmt(now)}/${fmt(dur || current.duration || 0)}`,
        ),

        debugOn
          ? h(
              'span',
              {
                title: '调试：readyState / duration / currentTime / seekable',
                style: { color: C.err, fontFamily: 'monospace', fontSize: 10, flexShrink: 0 },
              },
              (() => {
                const el = getAudio();
                let sk = '-';
                try {
                  sk =
                    el.seekable && el.seekable.length
                      ? `${el.seekable.start(0).toFixed(0)}-${el.seekable.end(el.seekable.length - 1).toFixed(0)}`
                      : 'none';
                } catch {
                  /* 忽略 */
                }
                return `rs${el.readyState} d${Number.isFinite(el.duration) ? el.duration.toFixed(0) : '∞'} t${el.currentTime.toFixed(1)} sk${sk}`;
              })(),
            )
          : null,

        h(
          'div',
          {
            onClick: seek,
            title: '点击跳转',
            style: {
              flex: 1,
              minWidth: 60,
              height: 14,
              display: 'flex',
              alignItems: 'center',
              cursor: 'pointer',
            },
          },
          h(
            'div',
            {
              style: {
                position: 'relative',
                width: '100%',
                height: 3,
                background: C.layer3,
                borderRadius: 2,
              },
            },
            h('div', {
              style: {
                position: 'absolute',
                inset: 0,
                width: `${dur ? Math.min(100, (now / dur) * 100) : 0}%`,
                background: C.brand,
                borderRadius: 2,
              },
            }),
          ),
        ),

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

        iconBtn(
          mode === 'loop' ? '🔁' : '▶▶',
          mode === 'loop' ? '单曲循环（点击改为推荐连播）' : '推荐连播（点击改为单曲循环）',
          () => setMode(mode === 'loop' ? 'recommend' : 'loop'),
          { active: true, size: 11 },
        ),
        iconBtn(
          '🕘',
          '播放历史 / 补反馈',
          () => {
            setShowHistory((v) => !v);
            refresh();
          },
          { active: showHistory, size: 12 },
        ),

        ...ACTIONS.map(fbBtn),
      ),

      // 浮动提示：贴在鼠标点击处（没有坐标时退回播放条上方）
      notice
        ? h(
            'div',
            {
              role: 'status',
              style: {
                position: 'fixed',
                left: Number.isFinite(notice.x) ? notice.x : undefined,
                top: Number.isFinite(notice.y) ? notice.y - 34 : undefined,
                transform: 'translate(-50%, -100%)',
                background: 'var(--dsw-alias-toast-bg, rgba(20,20,20,.92))',
                color: 'var(--dsw-alias-toast-label, #fff)',
                border: `1px solid ${notice.tone === 'err' ? C.err : 'transparent'}`,
                padding: '5px 10px',
                borderRadius: 8,
                fontSize: 12,
                lineHeight: 1.4,
                maxWidth: 320,
                whiteSpace: 'nowrap',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                boxShadow: '0 6px 20px rgba(0,0,0,.28)',
                pointerEvents: 'none',
                zIndex: 9999,
              },
            },
            `${notice.tone === 'err' ? '!' : notice.tone === 'ok' ? '✓' : '·'} ${notice.text}`,
          )
        : null,

      error
        ? h(
            'div',
            {
              role: 'status',
              style: {
                position: 'fixed',
                left: barRef.current ? barRef.current.getBoundingClientRect().left + 90 : undefined,
                top: barRef.current ? barRef.current.getBoundingClientRect().top - 8 : undefined,
                transform: 'translateY(-100%)',
                background: 'var(--dsw-alias-toast-bg, rgba(20,20,20,.92))',
                color: 'var(--dsw-alias-toast-label, #fff)',
                border: `1px solid ${C.err}`,
                padding: '5px 10px',
                borderRadius: 8,
                fontSize: 12,
                maxWidth: 380,
                boxShadow: '0 6px 20px rgba(0,0,0,.28)',
                pointerEvents: 'none',
                zIndex: 9999,
              },
            },
            error,
          )
        : null,

      showHistory
        ? h(
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
                border: `1px solid ${C.border}`,
                borderRadius: 10,
                background: C.layer1,
                color: C.label,
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
                  color: C.label3,
                },
              },
              h('span', null, `播放历史（${state.history.length}）`),
              h(
                'span',
                { style: { cursor: 'pointer' }, onClick: () => setShowHistory(false) },
                '收起 ✕',
              ),
            ),
            state.history.length === 0
              ? h('div', { style: { padding: 8, color: C.label3 } }, '还没有播放记录')
              : state.history.map((item) =>
                  h(
                    'div',
                    {
                      key: item.bvid,
                      style: {
                        display: 'flex',
                        alignItems: 'center',
                        gap: 8,
                        padding: '4px 6px',
                        borderRadius: 6,
                        background: current.bvid === item.bvid ? C.layer2 : 'transparent',
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
                            fontWeight: current.bvid === item.bvid ? 600 : 400,
                          },
                        },
                        item.title,
                      ),
                      h(
                        'div',
                        {
                          style: {
                            color: C.label3,
                            whiteSpace: 'nowrap',
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                          },
                        },
                        `${item.artist || ''}${item.feedback ? ' · 已' + (item.feedback === 'like' ? '喜欢' : item.feedback === 'skip' ? '跳过' : '不喜欢') : ''}`,
                      ),
                    ),
                    ...ACTIONS.map((a) => {
                      const on = item.feedback === a.key;
                      return h(
                        'button',
                        {
                          key: a.key,
                          type: 'button',
                          title: a.tip,
                          onClick: (e) => send(a.key, item.bvid, e),
                          style: {
                            border: 'none',
                            background: on
                              ? `color-mix(in srgb, ${C.brand} 16%, transparent)`
                              : 'transparent',
                            color: on ? C.brand : C.label3,
                            borderRadius: 6,
                            width: 22,
                            height: 20,
                            cursor: 'pointer',
                            fontSize: 12,
                            lineHeight: 1,
                            padding: 0,
                          },
                        },
                        on ? '✓' : a.icon,
                      );
                    }),
                  ),
                ),
          )
        : null,
    );
  }

  /**
   * 错误边界：组件内部崩了要显示错误，而不是整条播放条消失。
   * （上一版就是因为一个未定义变量，播放条直接不见了。）
   */
  class BarBoundary extends React.Component {
    constructor(props) {
      super(props);
      this.state = { err: null };
    }

    static getDerivedStateFromError(err) {
      return { err };
    }

    componentDidCatch(err) {
      diag('bar-crash', { err: String(err && err.message) });
    }

    render() {
      if (this.state.err) {
        return h(
          'div',
          {
            style: {
              flex: '0 0 100%',
              width: '100%',
              padding: '4px 8px',
              margin: '4px 0',
              font: '12px/1.5 system-ui, sans-serif',
              color: 'var(--dsw-alias-state-error-primary, #c62828)',
              border: '1px solid var(--dsw-alias-state-error-primary, #c62828)',
              borderRadius: 8,
            },
          },
          `播放条出错：${this.state.err.message}（右键时间位置可反馈给开发者）`,
        );
      }
      return this.props.children;
    }
  }

  function BarWithBoundary() {
    return h(BarBoundary, null, h(Bar));
  }

  return BarWithBoundary;
}
