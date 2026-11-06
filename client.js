(() => {
  // client/diag.js
  var enabled = false;
  function setDiagEnabled(value) {
    enabled = Boolean(value);
  }
  function diag(tag, data) {
    if (!enabled) return;
    try {
      fetch("/bili-music/debug", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ tag, ...data, at: Date.now() })
      }).catch(() => {
      });
    } catch {
    }
  }

  // client/audio.js
  var sharedAudio = null;
  function getAudio() {
    if (sharedAudio) return sharedAudio;
    const element = new Audio();
    element.preload = "auto";
    element.style.position = "absolute";
    element.style.width = "0";
    element.style.height = "0";
    element.style.opacity = "0";
    element.setAttribute("data-bili-music-audio", "1");
    document.body.appendChild(element);
    sharedAudio = element;
    return element;
  }

  // client/loader.js
  function createLoader({ el, diag: diag2, onLoading, onProgress, onPlaying, onError }) {
    let currentKey = "";
    let failed = false;
    let abortedKey = "";
    let started = false;
    let blobUrl = null;
    let mediaSource = null;
    let watchdog = null;
    const isCurrent = (key) => currentKey === key;
    const setObjectUrl = (url, reload) => {
      if (blobUrl) {
        try {
          URL.revokeObjectURL(blobUrl);
        } catch {
        }
      }
      blobUrl = url;
      el.src = url;
      if (reload) el.load();
    };
    const stopWatchdog = (key) => {
      if (!watchdog || key && watchdog.key !== key) return;
      clearTimeout(watchdog.timer);
      watchdog = null;
    };
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
        }
      };
    };
    async function loadMse(track, key, shouldPlay, streamUrl) {
      const res = await fetch(`/bili-music/manifest/${track.bvid}`, { cache: "no-store" });
      if (!res.ok) throw new Error(`manifest HTTP ${res.status}`);
      const mf = await res.json();
      if (!mf.ok || !mf.segments?.length) throw new Error("no segments");
      const ms = new MediaSource();
      mediaSource = ms;
      setObjectUrl(URL.createObjectURL(ms));
      await new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error("sourceopen timeout")), 8e3);
        ms.addEventListener(
          "sourceopen",
          () => {
            clearTimeout(t);
            resolve();
          },
          { once: true }
        );
      });
      if (!isCurrent(key)) return;
      const sb = ms.addSourceBuffer(mf.codec);
      const waitUpdate = () => new Promise((resolve, reject) => {
        if (!sb.updating) {
          resolve();
          return;
        }
        const t = setTimeout(() => {
          sb.removeEventListener("updateend", onEnd);
          reject(new Error("append timeout"));
        }, 5e3);
        const onEnd = () => {
          clearTimeout(t);
          resolve();
        };
        sb.addEventListener("updateend", onEnd, { once: true });
      });
      const body = await fetch(streamUrl, { cache: "force-cache" });
      if (!body.ok) throw new Error(`stream HTTP ${body.status}`);
      const reader = body.body.getReader();
      const slicer = makeSlicer();
      const total = mf.segments.length;
      let appendedInit = false;
      let segIndex = 0;
      const tryStart = () => {
        if (started) return;
        started = true;
        stopWatchdog(key);
        onLoading(false);
        failed = false;
        onError("");
        diag2("mse-ready", { bvid: track.bvid, segments: total, duration: mf.duration });
        if (shouldPlay) {
          el.play().then(() => onPlaying(true)).catch(() => onError("\u6D4F\u89C8\u5668\u62E6\u622A\u4E86\u81EA\u52A8\u64AD\u653E\uFF0C\u70B9 \u25B6 \u7EE7\u7EED"));
        }
      };
      for (; ; ) {
        const { done, value } = await reader.read();
        if (!isCurrent(key) || abortedKey === key) {
          try {
            await reader.cancel();
          } catch {
          }
          try {
            ms.endOfStream();
          } catch {
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
          }
          appendedInit = true;
        }
        while (appendedInit && segIndex < total && slicer.received > mf.segments[segIndex].end) {
          if (!isCurrent(key) || abortedKey === key) return;
          const seg = mf.segments[segIndex];
          await waitUpdate();
          sb.appendBuffer(slicer.slice(seg.start, seg.end));
          await waitUpdate();
          segIndex++;
          onProgress(segIndex / total);
          if (segIndex >= 1) tryStart();
        }
      }
      while (appendedInit && segIndex < total) {
        if (!isCurrent(key) || abortedKey === key) return;
        const seg = mf.segments[segIndex];
        await waitUpdate();
        sb.appendBuffer(slicer.slice(seg.start, seg.end));
        await waitUpdate();
        segIndex++;
        onProgress(segIndex / total);
        if (segIndex >= 1) tryStart();
      }
      tryStart();
      onLoading(false);
      try {
        ms.endOfStream();
      } catch {
      }
    }
    async function loadBlob(track, key, shouldPlay, streamUrl) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 45e3);
      try {
        const r = await fetch(streamUrl, { cache: "force-cache", signal: controller.signal });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const total = Number(r.headers.get("content-length")) || 0;
        const reader = r.body.getReader();
        const chunks = [];
        let received = 0;
        let lastTick = 0;
        for (; ; ) {
          const { done, value } = await reader.read();
          if (done) break;
          chunks.push(value);
          received += value.length;
          const tick = Date.now();
          if (total && tick - lastTick > 200) {
            lastTick = tick;
            onProgress(Math.min(0.99, received / total));
            if (!isCurrent(key)) {
              try {
                await reader.cancel();
              } catch {
              }
              break;
            }
          }
        }
        if (!isCurrent(key)) return;
        const blob = new Blob(chunks, { type: "audio/mp4" });
        setObjectUrl(URL.createObjectURL(blob), true);
        onLoading(false);
        onProgress(1);
        onError("");
        failed = false;
        diag2("blob-ready", { bvid: track.bvid, size: blob.size });
        if (shouldPlay) {
          el.play().then(() => onPlaying(true)).catch(() => onError("\u6D4F\u89C8\u5668\u62E6\u622A\u4E86\u81EA\u52A8\u64AD\u653E\uFF0C\u70B9 \u25B6 \u7EE7\u7EED"));
        }
      } finally {
        clearTimeout(timer);
      }
    }
    function load({ track, key, shouldPlay, streamUrl }) {
      if (currentKey === key) return;
      currentKey = key;
      started = false;
      abortedKey = "";
      onLoading(true);
      onProgress(0);
      try {
        el.pause();
      } catch {
      }
      stopWatchdog();
      watchdog = {
        key,
        timer: setTimeout(() => {
          if (!isCurrent(key) || started) return;
          diag2("mse-watchdog", { bvid: track.bvid });
          abortedKey = key;
          try {
            mediaSource?.endOfStream();
          } catch {
          }
          loadBlob(track, key, true, streamUrl).catch(() => {
            if (!isCurrent(key)) return;
            onLoading(false);
            failed = true;
            onError("\u97F3\u6E90\u52A0\u8F7D\u5931\u8D25\uFF0C\u70B9 \u25B6 \u91CD\u8BD5");
          });
        }, 1e4)
      };
      loadMse(track, key, shouldPlay, streamUrl).catch((error) => {
        if (!isCurrent(key)) return;
        stopWatchdog(key);
        diag2("mse-fail", { bvid: track.bvid, err: String(error && error.message) });
        if (abortedKey === key) return;
        loadBlob(track, key, shouldPlay, streamUrl).catch((blobError) => {
          if (!isCurrent(key)) return;
          onLoading(false);
          failed = true;
          const reason = blobError && blobError.name === "AbortError" ? "\u52A0\u8F7D\u8D85\u65F6" : blobError.message || blobError;
          onError(`\u97F3\u6E90\u52A0\u8F7D\u5931\u8D25\uFF08${reason}\uFF09\uFF0C\u70B9 \u25B6 \u91CD\u8BD5`);
        });
      });
    }
    function reset() {
      currentKey = "";
      abortedKey = "";
      started = false;
      try {
        el.removeAttribute("src");
        el.load();
      } catch {
      }
    }
    function destroy() {
      stopWatchdog();
      currentKey = "";
      if (blobUrl) {
        try {
          URL.revokeObjectURL(blobUrl);
        } catch {
        }
        blobUrl = null;
      }
    }
    return {
      get key() {
        return currentKey;
      },
      get failed() {
        return failed;
      },
      load,
      reset,
      destroy
    };
  }

  // client/player.js
  function createPlayer({ diag: diag2, onState, onError, onEnded, element }) {
    const el = element || getAudio();
    let lastSeekAt = 0;
    const snapshot = () => ({
      playing: !el.paused,
      now: el.currentTime || 0,
      dur: Number.isFinite(el.duration) ? el.duration : 0
    });
    const notify = () => onState(snapshot());
    const onTime = () => notify();
    const onPlay = () => {
      onError("");
      notify();
    };
    const onPause = () => notify();
    const onEndedEvent = () => {
      if (Date.now() - lastSeekAt < 800) return;
      const total = el.duration;
      if (Number.isFinite(total) && el.currentTime < total - 0.5) return;
      onState(snapshot());
      onEnded();
    };
    const onErrorEvent = () => {
      if (el.error) onError(`\u97F3\u9891\u52A0\u8F7D\u5931\u8D25\uFF08${el.error.code}\uFF09\uFF0C\u70B9 \u25B6 \u91CD\u8BD5`);
    };
    const onLoadedMetadata = () => {
      notify();
      if (Number.isFinite(el.duration)) return;
      diag2("duration-infinity", { rs: el.readyState, cur: el.currentTime });
      const onDuration = () => {
        el.removeEventListener("durationchange", onDuration);
        if (Number.isFinite(el.duration)) {
          diag2("duration-resolved", { dur: +el.duration.toFixed(2) });
          try {
            el.currentTime = 0;
          } catch {
          }
          notify();
        }
      };
      el.addEventListener("durationchange", onDuration);
      try {
        el.currentTime = 1e101;
      } catch {
      }
    };
    el.addEventListener("timeupdate", onTime);
    el.addEventListener("loadedmetadata", onLoadedMetadata);
    el.addEventListener("play", onPlay);
    el.addEventListener("pause", onPause);
    el.addEventListener("ended", onEndedEvent);
    el.addEventListener("error", onErrorEvent);
    async function toggle() {
      if (el.ended || el.duration && el.currentTime >= el.duration - 0.2) el.currentTime = 0;
      if (el.paused) {
        await el.play();
        notify();
        return true;
      }
      el.pause();
      notify();
      return false;
    }
    function applySeek(target) {
      lastSeekAt = Date.now();
      try {
        el.currentTime = target;
        onState({ ...snapshot(), now: target });
      } catch (error) {
        diag2("seek-throw", { target, err: String(error && error.message) });
        return;
      }
      diag2("seek-applied", { target: +target.toFixed(2), dur: el.duration, rs: el.readyState });
    }
    function seekTo(target) {
      if (!Number.isFinite(target) || target < 0) return;
      let bounded = target;
      if (Number.isFinite(el.duration) && el.duration > 0) {
        bounded = Math.min(bounded, el.duration - 0.25);
      }
      try {
        if (el.seekable && el.seekable.length > 0) {
          const start = el.seekable.start(el.seekable.length - 1);
          const end = el.seekable.end(el.seekable.length - 1);
          if (end > start && bounded <= end) {
            bounded = Math.min(Math.max(bounded, start), end - 0.25);
          }
        }
      } catch {
      }
      if (!Number.isFinite(bounded) || bounded < 0) return;
      if (el.readyState >= 2) {
        applySeek(bounded);
        return;
      }
      const onReady = () => {
        el.removeEventListener("canplay", onReady);
        el.removeEventListener("loadeddata", onReady);
        applySeek(bounded);
      };
      el.addEventListener("canplay", onReady);
      el.addEventListener("loadeddata", onReady);
    }
    function seekRatio(ratio, fallbackDuration) {
      const total = Number.isFinite(el.duration) && el.duration > 0 ? el.duration : fallbackDuration || 0;
      if (!total) return;
      seekTo(ratio * total);
    }
    function setVolume(value) {
      el.volume = Math.max(0, Math.min(1, value));
    }
    function destroy() {
      el.removeEventListener("timeupdate", onTime);
      el.removeEventListener("loadedmetadata", onLoadedMetadata);
      el.removeEventListener("play", onPlay);
      el.removeEventListener("pause", onPause);
      el.removeEventListener("ended", onEndedEvent);
      el.removeEventListener("error", onErrorEvent);
    }
    return { el, snapshot, toggle, seekTo, seekRatio, setVolume, destroy };
  }

  // client/audio-engine.js
  var engine = null;
  function getAudioEngine() {
    if (engine) return engine;
    const el = getAudio();
    const handlers = /* @__PURE__ */ new Set();
    const emit = (name, value) => {
      for (const handler of handlers) handler(name, value);
    };
    const player = createPlayer({
      element: el,
      diag,
      onState: (snapshot) => emit("state", snapshot),
      onError: (message) => emit("error", message),
      onEnded: () => emit("ended")
    });
    const loader = createLoader({
      el,
      diag,
      onLoading: (value) => emit("loading", value),
      onProgress: (value) => emit("progress", value),
      onPlaying: (value) => emit("playing", value),
      onError: (message) => emit("error", message)
    });
    engine = {
      player,
      loader,
      /** 订阅状态事件，返回退订函数。 */
      subscribe(handler) {
        handlers.add(handler);
        return () => handlers.delete(handler);
      },
      /** 当前播放快照：重新挂载时用来立刻对齐界面。 */
      snapshot: () => player.snapshot()
    };
    return engine;
  }

  // client/bar-boundary.js
  function createBarBoundary({ React, diag: diag2 }) {
    const h = React.createElement;
    return class BarBoundary extends React.Component {
      constructor(props) {
        super(props);
        this.state = { err: null };
      }
      static getDerivedStateFromError(err) {
        return { err };
      }
      componentDidCatch(err) {
        diag2("bar-crash", { err: String(err && err.message) });
      }
      render() {
        if (this.state.err) {
          return h(
            "div",
            {
              style: {
                flex: "0 0 100%",
                width: "100%",
                padding: "4px 8px",
                margin: "4px 0",
                font: "12px/1.5 system-ui, sans-serif",
                color: "var(--dsw-alias-state-error-primary, #c62828)",
                border: "1px solid var(--dsw-alias-state-error-primary, #c62828)",
                borderRadius: 8
              }
            },
            `\u64AD\u653E\u6761\u51FA\u9519\uFF1A${this.state.err.message}\uFF08\u53F3\u952E\u65F6\u95F4\u4F4D\u7F6E\u53EF\u53CD\u9988\u7ED9\u5F00\u53D1\u8005\uFF09`
          );
        }
        return this.props.children;
      }
    };
  }

  // client/theme.js
  var ACTIONS = [
    { key: "like", icon: "\u{1F44D}", label: "\u559C\u6B22", tip: "\u6536\u8FDB\u300C\u70B9\u6B4C\u52A9\u624B\u300D\u6536\u85CF\u5939" },
    { key: "skip", icon: "\u23ED", label: "\u8DF3\u8FC7", tip: "\u8DF3\u8FC7\uFF0C\u6743\u91CD\u51E0\u4E4E\u4E0D\u53D8" },
    { key: "dislike", icon: "\u{1F44E}", label: "\u4E0D\u559C\u6B22", tip: "\u4E4B\u540E\u4E0D\u518D\u63A8\u8350\u8FD9\u9996" }
  ];
  var MODE_KEY = "bili-music-mode";
  var STYLE_ID = "bili-music-bar-style";
  var COLORS = {
    label: "var(--dsw-alias-label-primary, #1f1f1f)",
    label2: "var(--dsw-alias-label-secondary, #666)",
    label3: "var(--dsw-alias-label-caption, #8a8a8a)",
    border: "var(--dsw-alias-border-l2, #e2e2e2)",
    layer1: "var(--dsw-alias-bg-layer-1, #fff)",
    layer2: "var(--dsw-alias-bg-layer-2, #f7f7f7)",
    layer3: "var(--dsw-alias-bg-layer-3, #eee)",
    brand: "var(--dsw-alias-brand-primary, #4a7cff)",
    ok: "var(--dsw-alias-state-success-primary, #12805c)",
    err: "var(--dsw-alias-state-error-primary, #c62828)"
  };
  function ensureDockStyle() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = "[data-composer-dock]{flex-wrap:wrap!important}";
    document.head.appendChild(style);
  }

  // client/hooks.js
  function createHooks(React) {
    const { useCallback, useEffect, useRef, useState } = React;
    const NOTICE_TTL_MS = 2400;
    function useServerState() {
      const [state, setState] = useState({ current: null, history: [] });
      const refreshing = useRef(false);
      const mounted = useRef(false);
      const refresh = useCallback(async () => {
        if (refreshing.current) return;
        refreshing.current = true;
        try {
          const res = await fetch("/bili-music/state", { cache: "no-store" });
          if (!res.ok) return;
          const data = await res.json();
          if (!mounted.current) return;
          setState({ current: data.current || null, history: data.history || [] });
        } catch {
        } finally {
          refreshing.current = false;
        }
      }, []);
      useEffect(() => {
        mounted.current = true;
        refresh();
        const timer = setInterval(refresh, 5e3);
        return () => {
          mounted.current = false;
          clearInterval(timer);
        };
      }, [refresh]);
      return { state, refresh, setState };
    }
    function useNotice(anchorRef) {
      const [notice, setNotice] = useState(null);
      const timer = useRef(null);
      const mounted = useRef(true);
      const show = useCallback(
        (text, tone = "ok", ev) => {
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
        [anchorRef]
      );
      useEffect(() => {
        mounted.current = true;
        return () => {
          mounted.current = false;
          if (timer.current) clearTimeout(timer.current);
        };
      }, []);
      return { notice, show };
    }
    function useMode() {
      const [mode, setMode] = useState(() => {
        try {
          return localStorage.getItem(MODE_KEY) || "recommend";
        } catch {
          return "recommend";
        }
      });
      useEffect(() => {
        try {
          localStorage.setItem(MODE_KEY, mode);
        } catch {
        }
      }, [mode]);
      return [mode, setMode];
    }
    return { useServerState, useNotice, useMode };
  }

  // client/parts/buttons.js
  function createButtons({ React, colors }) {
    const h = React.createElement;
    function iconButton({ glyph, title, onClick, disabled = false, active = false, size = 13 }) {
      return h(
        "button",
        {
          type: "button",
          title,
          onClick,
          disabled,
          style: {
            border: "none",
            background: "transparent",
            color: active ? colors.brand : colors.label2,
            borderRadius: 6,
            width: 24,
            height: 22,
            cursor: "pointer",
            fontSize: size,
            lineHeight: 1,
            padding: 0,
            flexShrink: 0,
            fontWeight: active ? 700 : 400
          }
        },
        glyph
      );
    }
    function feedbackButton({ item, active, pending, onClick }) {
      const isActive = active === item.key;
      const isBusy = pending === item.key;
      return h(
        "button",
        {
          key: item.key,
          type: "button",
          title: isActive ? `\u5DF2\u6807\u8BB0\uFF1A${item.label}\uFF08\u518D\u70B9\u4E00\u6B21\u53D6\u6D88\uFF09` : item.tip,
          disabled: !!pending,
          "aria-pressed": isActive,
          onClick,
          style: {
            border: "none",
            background: isActive ? `color-mix(in srgb, ${colors.brand} 16%, transparent)` : "transparent",
            color: isActive ? colors.brand : colors.label2,
            borderRadius: 6,
            width: 24,
            height: 22,
            cursor: pending ? "wait" : "pointer",
            fontSize: 13,
            lineHeight: 1,
            padding: 0,
            flexShrink: 0,
            fontWeight: isActive ? 700 : 400
          }
        },
        isBusy ? "\u2026" : isActive ? "\u2713" : item.icon
      );
    }
    function modeButton({ mode, onToggle }) {
      const loop = mode === "loop";
      return iconButton({
        glyph: loop ? "\u{1F501}" : "\u25B6\u25B6",
        title: loop ? "\u5355\u66F2\u5FAA\u73AF\uFF08\u70B9\u51FB\u6539\u4E3A\u63A8\u8350\u8FDE\u64AD\uFF09" : "\u63A8\u8350\u8FDE\u64AD\uFF08\u70B9\u51FB\u6539\u4E3A\u5355\u66F2\u5FAA\u73AF\uFF09",
        onClick: () => onToggle(loop ? "recommend" : "loop"),
        active: true,
        size: 11
      });
    }
    return { iconButton, feedbackButton, modeButton };
  }

  // client/parts/feedback.js
  function createFeedbackArea({ buttons, actions }) {
    return function feedbackArea({ active, pending, onSend }) {
      return actions.map(
        (item) => buttons.feedbackButton({
          item,
          active,
          pending,
          onClick: (event) => onSend(item.key, "", event)
        })
      );
    };
  }

  // client/parts/history.js
  function createHistoryPanel({ React, colors, actions }) {
    const h = React.createElement;
    const feedbackText = (feedback) => feedback === "like" ? "\u559C\u6B22" : feedback === "skip" ? "\u8DF3\u8FC7" : feedback ? "\u4E0D\u559C\u6B22" : "";
    return function HistoryPanel({ open, history, currentBvid, onClose, onFeedback }) {
      if (!open) return null;
      return h(
        "div",
        {
          style: {
            position: "absolute",
            bottom: "100%",
            left: 0,
            right: 0,
            marginBottom: 6,
            maxHeight: 260,
            overflowY: "auto",
            border: `1px solid ${colors.border}`,
            borderRadius: 10,
            background: colors.layer1,
            color: colors.label,
            boxShadow: "0 8px 24px rgba(0,0,0,.18)",
            padding: 6,
            zIndex: 30,
            font: "12px/1.5 system-ui, sans-serif"
          }
        },
        h(
          "div",
          {
            style: {
              display: "flex",
              justifyContent: "space-between",
              padding: "2px 6px 6px",
              color: colors.label3
            }
          },
          h("span", null, `\u64AD\u653E\u5386\u53F2\uFF08${history.length}\uFF09`),
          h("span", { style: { cursor: "pointer" }, onClick: onClose }, "\u6536\u8D77 \u2715")
        ),
        history.length === 0 ? h("div", { style: { padding: 8, color: colors.label3 } }, "\u8FD8\u6CA1\u6709\u64AD\u653E\u8BB0\u5F55") : history.map((item) => {
          const isCurrent = currentBvid === item.bvid;
          return h(
            "div",
            {
              key: item.bvid,
              style: {
                display: "flex",
                alignItems: "center",
                gap: 8,
                padding: "4px 6px",
                borderRadius: 6,
                background: isCurrent ? colors.layer2 : "transparent"
              }
            },
            h(
              "div",
              { style: { minWidth: 0, flex: 1 } },
              h(
                "div",
                {
                  style: {
                    whiteSpace: "nowrap",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    fontWeight: isCurrent ? 600 : 400
                  }
                },
                item.title
              ),
              h(
                "div",
                {
                  style: {
                    color: colors.label3,
                    whiteSpace: "nowrap",
                    overflow: "hidden",
                    textOverflow: "ellipsis"
                  }
                },
                `${item.artist || ""}${item.feedback ? ` \xB7 \u5DF2${feedbackText(item.feedback)}` : ""}`
              )
            ),
            ...actions.map((action) => {
              const on = item.feedback === action.key;
              return h(
                "button",
                {
                  key: action.key,
                  type: "button",
                  title: action.tip,
                  onClick: (event) => onFeedback(action.key, item.bvid, event),
                  style: {
                    border: "none",
                    background: on ? `color-mix(in srgb, ${colors.brand} 16%, transparent)` : "transparent",
                    color: on ? colors.brand : colors.label3,
                    borderRadius: 6,
                    width: 22,
                    height: 20,
                    cursor: "pointer",
                    fontSize: 12,
                    lineHeight: 1,
                    padding: 0
                  }
                },
                on ? "\u2713" : action.icon
              );
            })
          );
        })
      );
    };
  }

  // client/parts/notice.js
  function createNoticePart({ React, colors }) {
    const h = React.createElement;
    return function Notice({ notice, anchor }) {
      if (!notice) return null;
      const rect = anchor ? anchor.getBoundingClientRect() : null;
      const left = rect ? Number.isFinite(notice.x) ? notice.x - rect.left : rect.width / 2 : void 0;
      const top = rect ? Number.isFinite(notice.y) ? notice.y - rect.top : -6 : void 0;
      return h(
        "div",
        {
          role: "status",
          style: {
            position: "absolute",
            left,
            top,
            transform: "translate(-50%, -100%)",
            background: "var(--dsw-alias-toast-bg, rgba(20,20,20,.92))",
            color: "var(--dsw-alias-toast-label, #fff)",
            border: `1px solid ${notice.tone === "err" ? colors.err : "transparent"}`,
            padding: "5px 10px",
            borderRadius: 8,
            fontSize: 12,
            lineHeight: 1.4,
            maxWidth: 320,
            whiteSpace: "nowrap",
            overflow: "hidden",
            textOverflow: "ellipsis",
            boxShadow: "0 6px 20px rgba(0,0,0,.28)",
            pointerEvents: "none",
            zIndex: 9999
          }
        },
        `${notice.tone === "err" ? "!" : notice.tone === "ok" ? "\u2713" : "\xB7"} ${notice.text}`
      );
    };
  }
  function createErrorToast({ React, colors }) {
    const h = React.createElement;
    return function ErrorToast({ message }) {
      if (!message) return null;
      return h(
        "div",
        {
          role: "status",
          style: {
            position: "absolute",
            left: 90,
            top: -8,
            transform: "translateY(-100%)",
            background: "var(--dsw-alias-toast-bg, rgba(20,20,20,.92))",
            color: "var(--dsw-alias-toast-label, #fff)",
            border: `1px solid ${colors.err}`,
            padding: "5px 10px",
            borderRadius: 8,
            fontSize: 12,
            maxWidth: 380,
            boxShadow: "0 6px 20px rgba(0,0,0,.28)",
            pointerEvents: "none",
            zIndex: 9999
          }
        },
        message
      );
    };
  }

  // client/parts/progress.js
  function createProgressPart({ React, colors, getAudio: getAudio2 }) {
    const h = React.createElement;
    const fmt = (sec) => {
      if (!Number.isFinite(sec) || sec < 0) return "0:00";
      return `${Math.floor(sec / 60)}:${String(Math.floor(sec % 60)).padStart(2, "0")}`;
    };
    function timeLabel({ loading, loadPct, now, duration, onToggleDebug }) {
      return h(
        "span",
        {
          title: "\u70B9\u51FB\u5207\u6362\u8C03\u8BD5\u4FE1\u606F\uFF08\u684C\u9762\u7248\u6CA1\u6709 DevTools \u4E5F\u80FD\u770B\uFF09",
          onClick: onToggleDebug,
          style: {
            color: loading ? colors.brand : colors.label3,
            fontVariantNumeric: "tabular-nums",
            flexShrink: 0,
            width: 82,
            textAlign: "right",
            cursor: "pointer"
          }
        },
        loading ? `\u52A0\u8F7D ${Math.round(loadPct * 100)}%` : `${fmt(now)}/${fmt(duration)}`
      );
    }
    function progressBar({ now, dur, onSeek }) {
      return h(
        "div",
        {
          onClick: onSeek,
          title: "\u70B9\u51FB\u8DF3\u8F6C",
          style: {
            flex: 1,
            minWidth: 60,
            height: 14,
            display: "flex",
            alignItems: "center",
            cursor: "pointer"
          }
        },
        h(
          "div",
          {
            style: {
              position: "relative",
              width: "100%",
              height: 3,
              background: colors.layer3,
              borderRadius: 2
            }
          },
          h("div", {
            style: {
              position: "absolute",
              inset: 0,
              width: `${dur ? Math.min(100, now / dur * 100) : 0}%`,
              background: colors.brand,
              borderRadius: 2
            }
          })
        )
      );
    }
    function debugReadout() {
      const el = getAudio2();
      let seekable = "-";
      try {
        seekable = el.seekable && el.seekable.length ? `${el.seekable.start(0).toFixed(0)}-${el.seekable.end(el.seekable.length - 1).toFixed(0)}` : "none";
      } catch {
      }
      return h(
        "span",
        {
          title: "\u8C03\u8BD5\uFF1AreadyState / duration / currentTime / seekable",
          style: { color: colors.err, fontFamily: "monospace", fontSize: 10, flexShrink: 0 }
        },
        `rs${el.readyState} d${Number.isFinite(el.duration) ? el.duration.toFixed(0) : "\u221E"} t${el.currentTime.toFixed(1)} sk${seekable}`
      );
    }
    return { timeLabel, progressBar, debugReadout };
  }

  // client/bar.js
  function createBar(React) {
    const h = React.createElement;
    const { useEffect, useRef, useState, useCallback } = React;
    const hooks = createHooks(React);
    const buttons = createButtons({ React, colors: COLORS });
    const feedbackArea = createFeedbackArea({ buttons, actions: ACTIONS });
    const Notice = createNoticePart({ React, colors: COLORS });
    const ErrorToast = createErrorToast({ React, colors: COLORS });
    const progress = createProgressPart({ React, colors: COLORS, getAudio });
    const HistoryPanel = createHistoryPanel({ React, colors: COLORS, actions: ACTIONS });
    const BarBoundary = createBarBoundary({ React, diag });
    function Bar() {
      const [playing, setPlaying] = useState(false);
      const [now, setNow] = useState(0);
      const [dur, setDur] = useState(0);
      const [pending, setPending] = useState(null);
      const [error, setError] = useState("");
      const [mode, setMode] = hooks.useMode();
      const [showHistory, setShowHistory] = useState(false);
      const [debugOn, setDebugOn] = useState(() => {
        try {
          return localStorage.getItem("bili-music-debug") === "1";
        } catch {
          return false;
        }
      });
      const [vol, setVol] = useState(() => {
        try {
          const v = parseFloat(localStorage.getItem("bili-music-volume"));
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
      const engineRef = useRef(null);
      const volRef = useRef(0.5);
      const modeRef = useRef("recommend");
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
        if (engineRef.current) engineRef.current.player.setVolume(vol);
        try {
          localStorage.setItem("bili-music-volume", String(vol));
        } catch {
        }
      }, [vol]);
      useEffect(() => {
        ensureDockStyle();
      }, []);
      const current = state.current;
      const active = current && current.feedback || null;
      useEffect(() => {
        const engine2 = getAudioEngine();
        engineRef.current = engine2;
        engine2.player.setVolume(volRef.current);
        const off = engine2.subscribe((name, value) => {
          if (name === "state") {
            setPlaying(value.playing);
            setNow(value.now);
            setDur(value.dur);
          } else if (name === "playing") setPlaying(value);
          else if (name === "loading") setLoading(value);
          else if (name === "progress") setLoadPct(value);
          else if (name === "error") setError(value);
          else if (name === "ended") {
            if (modeRef.current === "loop") {
              const { player } = engine2;
              player.el.currentTime = 0;
              player.el.play().then(() => setPlaying(true)).catch(() => setError("\u5FAA\u73AF\u64AD\u653E\u88AB\u6D4F\u89C8\u5668\u62E6\u622A\uFF0C\u70B9 \u25B6 \u7EE7\u7EED"));
              return;
            }
            goNextRef.current?.();
          }
        });
        const snapshot = engine2.snapshot();
        setPlaying(snapshot.playing);
        setNow(snapshot.now);
        setDur(snapshot.dur);
        return () => {
          off();
          engineRef.current = null;
        };
      }, []);
      const loadAndMaybePlay = useCallback((track) => {
        const engine2 = engineRef.current;
        if (!engine2) return;
        const key = `${track.bvid}|${track.startedAt || ""}`;
        if (engine2.loader.key === key) return;
        const streamUrl = `${track.stream}?t=${encodeURIComponent(track.startedAt || "")}`;
        setNow(0);
        setDur(0);
        const shouldPlay = autoNextRef.current;
        autoNextRef.current = false;
        setPlaying(false);
        engine2.loader.load({ track, key, shouldPlay, streamUrl });
      }, []);
      useEffect(() => {
        if (!current) return;
        loadAndMaybePlay(current);
      }, [current, loadAndMaybePlay]);
      const toggle = useCallback(async () => {
        if (!current) return;
        setError("");
        const engine2 = engineRef.current;
        if (!engine2) return;
        if (engine2.loader.failed || engine2.player.el.error) {
          engine2.loader.reset();
          loadAndMaybePlay(current);
          return;
        }
        try {
          await engine2.player.toggle();
        } catch (e) {
          if (e && e.name === "NotAllowedError") setError("\u6D4F\u89C8\u5668\u62E6\u622A\u4E86\u81EA\u52A8\u64AD\u653E\uFF0C\u70B9\u4E00\u4E0B\u9875\u9762\u518D\u6309 \u25B6");
          else setError(`\u64AD\u653E\u5931\u8D25\uFF1A${e && e.message || e}`);
          setPlaying(false);
        }
      }, [current, loadAndMaybePlay]);
      const go = useCallback(
        async (dir, ev) => {
          if (switchingRef.current) return;
          switchingRef.current = true;
          setSwitching(true);
          try {
            const res = await fetch(`/bili-music/${dir}`, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ mode })
            });
            const data = await res.json().catch(() => ({}));
            if (!res.ok || !data.ok) throw new Error(data.error || `HTTP ${res.status}`);
            if (data.atEnd) {
              autoNextRef.current = false;
              showNotice(
                data.message || (dir === "next" ? "\u6CA1\u6709\u4E0B\u4E00\u9996\u4E86\u55B5" : "\u6CA1\u6709\u4E0A\u4E00\u9996\u6B4C\u4E86\u55B5"),
                "info",
                ev
              );
              return;
            }
            autoNextRef.current = true;
            await refresh();
          } catch (e) {
            autoNextRef.current = false;
            setError(`${dir === "next" ? "\u4E0B\u4E00\u9996" : "\u4E0A\u4E00\u9996"}\u5931\u8D25\uFF1A${e.message || e}`);
          } finally {
            switchingRef.current = false;
            setSwitching(false);
          }
        },
        [mode, refresh, showNotice]
      );
      goNextRef.current = () => {
        void go("next");
      };
      const seek = useCallback(
        (event) => {
          const rect = event.currentTarget.getBoundingClientRect();
          if (!rect.width) return;
          const ratio = Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width));
          diag("click", { ratio: +ratio.toFixed(3), biliDur: current && current.duration });
          engineRef.current?.player.seekRatio(ratio, current && current.duration);
        },
        [current]
      );
      const send = useCallback(
        async (action, targetBvid, ev) => {
          if (pendingRef.current) return;
          const bvid = targetBvid || current && current.bvid;
          const curFb = targetBvid ? (state.history.find((x) => x.bvid === targetBvid) || {}).feedback : active;
          const next = curFb === action ? "clear" : action;
          pendingRef.current = true;
          setPending(action + (targetBvid || ""));
          try {
            const res = await fetch("/bili-music/feedback", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ action: next, bvid: targetBvid || "" })
            });
            const data = await res.json().catch(() => ({}));
            if (!res.ok || !data.ok) throw new Error(data.error || `HTTP ${res.status}`);
            setState((s) => ({
              ...s,
              current: s.current && s.current.bvid === (bvid || s.current.bvid) ? { ...s.current, feedback: next === "clear" ? null : next } : s.current,
              history: s.history.map(
                (row) => row.bvid === bvid ? { ...row, feedback: next === "clear" ? null : next } : row
              )
            }));
            if (next === "clear") {
              if (data.saved && data.saved.error)
                showNotice(`\u5DF2\u53D6\u6D88\u6807\u8BB0\uFF0C\u4F46\u4ECE\u6536\u85CF\u5939\u64A4\u51FA\u5931\u8D25\uFF1A${data.saved.error}`, "err", ev);
              else showNotice("\u5DF2\u53D6\u6D88\u6807\u8BB0", "info", ev);
            } else if (action === "like") {
              if (data.saved && data.saved.folder)
                showNotice(`\u5DF2\u559C\u6B22 \xB7 \u6536\u8FDB\u300C${data.saved.folder}\u300D`, "ok", ev);
              else if (data.saved && data.saved.error)
                showNotice(`\u5DF2\u559C\u6B22\uFF0C\u4F46\u6536\u85CF\u5931\u8D25\uFF1A${data.saved.error}`, "err", ev);
              else showNotice("\u5DF2\u559C\u6B22", "ok", ev);
            } else if (action === "dislike") showNotice("\u5DF2\u8BB0\u4E0D\u559C\u6B22 \xB7 \u4E0D\u518D\u63A8\u8350", "err", ev);
            else showNotice("\u5DF2\u8DF3\u8FC7", "info", ev);
            await refresh();
          } catch (e) {
            showNotice(`\u53CD\u9988\u5931\u8D25\uFF1A${e.message || e}`, "err", ev);
          } finally {
            pendingRef.current = false;
            setPending(null);
          }
        },
        [active, current, refresh, showNotice, state.history]
      );
      if (!current) return null;
      const iconBtn = (glyph, title, onClick, opts = {}) => buttons.iconButton({ glyph, title, onClick, ...opts });
      return h(
        "div",
        {
          "data-bili-music-bar": "1",
          ref: barRef,
          style: {
            position: "relative",
            flex: "0 0 100%",
            order: -1,
            width: "100%",
            maxWidth: "100%",
            boxSizing: "border-box",
            margin: "0 auto",
            justifyContent: "flex-start",
            padding: "2px 0 4px",
            font: "12px/1.4 system-ui, sans-serif",
            color: COLORS.label
          }
        },
        h(
          "div",
          {
            style: {
              display: "flex",
              alignItems: "center",
              gap: 6,
              width: "100%",
              justifyContent: "flex-start"
            }
          },
          // 左侧控制簇固定宽度，标题/进度变化时按钮不会位移
          h(
            "div",
            { style: { display: "flex", alignItems: "center", gap: 2, flexShrink: 0, width: 78 } },
            iconBtn("\u23EE", "\u4E0A\u4E00\u9996", (e) => go("prev", e), { disabled: switching }),
            iconBtn(
              loading ? "\u2026" : playing ? "\u23F8" : "\u25B6",
              loading ? "\u52A0\u8F7D\u4E2D" : playing ? "\u6682\u505C" : "\u64AD\u653E",
              toggle,
              { size: 14 }
            ),
            iconBtn("\u23ED", "\u4E0B\u4E00\u9996", (e) => go("next", e), { disabled: switching })
          ),
          // 封面：切歌时能一眼认出来
          current.cover ? h("img", {
            src: current.cover,
            alt: "",
            referrerPolicy: "no-referrer",
            style: {
              width: 26,
              height: 26,
              borderRadius: 4,
              objectFit: "cover",
              flexShrink: 0,
              background: COLORS.layer3
            },
            onError: (e) => {
              e.currentTarget.style.display = "none";
            }
          }) : null,
          h(
            "div",
            {
              style: {
                minWidth: 0,
                flex: "0 0 214px",
                width: 214,
                maxWidth: 214,
                display: "flex",
                gap: 6,
                alignItems: "baseline",
                overflow: "hidden"
              },
              title: current.title
            },
            h(
              "span",
              {
                style: {
                  fontWeight: 600,
                  whiteSpace: "nowrap",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  flexShrink: 1
                }
              },
              current.title
            ),
            h(
              "span",
              {
                style: {
                  color: COLORS.label2,
                  whiteSpace: "nowrap",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  flexShrink: 2
                }
              },
              current.artist || ""
            )
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
                  localStorage.setItem("bili-music-debug", next ? "1" : "0");
                } catch {
                }
                return next;
              });
            }
          }),
          debugOn ? progress.debugReadout() : null,
          progress.progressBar({ now, dur, onSeek: seek }),
          // 音量：喇叭点一下静音/恢复，滑条微调
          h(
            "div",
            { style: { display: "flex", alignItems: "center", gap: 3, flexShrink: 0 } },
            h(
              "span",
              {
                title: vol > 0 ? "\u9759\u97F3" : "\u6062\u590D\u97F3\u91CF",
                onClick: () => setVol(vol > 0 ? 0 : 0.8),
                style: { fontSize: 11, cursor: "pointer", color: COLORS.label3, lineHeight: 1 }
              },
              vol === 0 ? "\u{1F507}" : vol < 0.5 ? "\u{1F509}" : "\u{1F50A}"
            ),
            h("input", {
              type: "range",
              min: 0,
              max: 1,
              step: 0.01,
              value: vol,
              onChange: (e) => setVol(Number(e.currentTarget.value)),
              title: `\u97F3\u91CF ${Math.round(vol * 100)}%`,
              style: { width: 48, height: 14, cursor: "pointer", accentColor: COLORS.brand, margin: 0 }
            })
          ),
          buttons.modeButton({ mode, onToggle: setMode }),
          iconBtn(
            "\u{1F558}",
            "\u64AD\u653E\u5386\u53F2 / \u8865\u53CD\u9988",
            () => {
              setShowHistory((v) => !v);
              refresh();
            },
            { active: showHistory, size: 12 }
          ),
          feedbackArea({ active, pending, onSend: send })
        ),
        // 浮动提示与错误条：定位与样式在 parts/notice.js
        h(Notice, { notice, anchor: barRef.current }),
        h(ErrorToast, { message: error }),
        h(HistoryPanel, {
          open: showHistory,
          history: state.history,
          currentBvid: current.bvid,
          onClose: () => setShowHistory(false),
          onFeedback: send
        })
      );
    }
    function BarWithBoundary() {
      return h(BarBoundary, null, h(Bar));
    }
    return BarWithBoundary;
  }

  // client/index.js
  window.__ModuleLoader__.load({
    id: "dsh-bili-music-player",
    factory(require2) {
      const React = require2("react");
      const Bar = createBar(React);
      return {
        inject: ["slots"],
        apply(ctx) {
          ctx.slots.inject(
            "conversation.composer.dock",
            () => ctx.slots.register(
              {
                name: "conversation.composer.dock",
                id: "bili-music-bar",
                order: 20
              },
              Bar
            )
          );
        }
      };
    }
  });
})();
