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

  // client/bar.js
  function createBar(React) {
    const h = React.createElement;
    const { useEffect, useRef, useState, useCallback } = React;
    let sharedKey = "";
    const ACTIONS = [
      { key: "like", icon: "\u{1F44D}", label: "\u559C\u6B22", tip: "\u6536\u8FDB\u300C\u70B9\u6B4C\u52A9\u624B\u300D\u6536\u85CF\u5939" },
      { key: "skip", icon: "\u23ED", label: "\u8DF3\u8FC7", tip: "\u8DF3\u8FC7\uFF0C\u6743\u91CD\u51E0\u4E4E\u4E0D\u53D8" },
      { key: "dislike", icon: "\u{1F44E}", label: "\u4E0D\u559C\u6B22", tip: "\u4E4B\u540E\u4E0D\u518D\u63A8\u8350\u8FD9\u9996" }
    ];
    const MODE_KEY = "bili-music-mode";
    const STYLE_ID = "bili-music-bar-style";
    const C = {
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
    const fmt = (sec) => {
      if (!Number.isFinite(sec) || sec < 0) return "0:00";
      return `${Math.floor(sec / 60)}:${String(Math.floor(sec % 60)).padStart(2, "0")}`;
    };
    function Bar() {
      const [state, setState] = useState({ current: null, history: [] });
      const [playing, setPlaying] = useState(false);
      const [now, setNow] = useState(0);
      const [dur, setDur] = useState(0);
      const [notice, setNotice] = useState(null);
      const [pending, setPending] = useState(null);
      const [error, setError] = useState("");
      const [mode, setMode] = useState(() => {
        try {
          return localStorage.getItem(MODE_KEY) || "recommend";
        } catch {
          return "recommend";
        }
      });
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
      const noticeTimer = useRef(null);
      const autoNextRef = useRef(false);
      const mountRef = useRef(true);
      const goNextRef = useRef(null);
      const barRef = useRef(null);
      const lastSeekAt = useRef(0);
      const switchingRef = useRef(false);
      const refreshingRef = useRef(false);
      const failKeyRef = useRef("");
      const pendingRef = useRef(false);
      const showNotice = useCallback((text, tone = "ok", ev) => {
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
        if (refreshingRef.current) return;
        refreshingRef.current = true;
        try {
          const res = await fetch("/bili-music/state", { cache: "no-store" });
          if (!res.ok) return;
          const data = await res.json();
          if (!mountRef.current) return;
          setState({ current: data.current || null, history: data.history || [] });
        } catch {
        } finally {
          refreshingRef.current = false;
        }
      }, []);
      useEffect(() => {
        mountRef.current = true;
        refresh();
        const timer = setInterval(refresh, 5e3);
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
        }
      }, [mode]);
      useEffect(() => {
        setDiagEnabled(debugOn);
      }, [debugOn]);
      useEffect(() => {
        getAudio().volume = vol;
        try {
          localStorage.setItem("bili-music-volume", String(vol));
        } catch {
        }
      }, [vol]);
      useEffect(() => {
        if (document.getElementById(STYLE_ID)) return;
        const st = document.createElement("style");
        st.id = STYLE_ID;
        st.textContent = "[data-composer-dock]{flex-wrap:wrap!important}";
        document.head.appendChild(st);
      }, []);
      const current = state.current;
      const active = current && current.feedback || null;
      useEffect(() => {
        const el = getAudio();
        setPlaying(!el.paused);
        setNow(el.currentTime || 0);
        setDur(Number.isFinite(el.duration) ? el.duration : 0);
        const onTime = () => {
          setNow(el.currentTime || 0);
          setDur(Number.isFinite(el.duration) ? el.duration : 0);
        };
        const onPlay = () => {
          setPlaying(true);
          setError("");
        };
        const onPause = () => setPlaying(false);
        const onEnded = () => {
          if (Date.now() - lastSeekAt.current < 800) return;
          const total = el.duration;
          if (Number.isFinite(total) && el.currentTime < total - 0.5) return;
          setPlaying(false);
          if (mode === "loop") {
            el.currentTime = 0;
            el.play().then(() => setPlaying(true)).catch(() => setError("\u5FAA\u73AF\u64AD\u653E\u88AB\u6D4F\u89C8\u5668\u62E6\u622A\uFF0C\u70B9 \u25B6 \u7EE7\u7EED"));
          } else if (goNextRef.current) {
            goNextRef.current();
          }
        };
        const onError = () => {
          if (el.error) setError(`\u97F3\u9891\u52A0\u8F7D\u5931\u8D25\uFF08${el.error.code}\uFF09\uFF0C\u70B9 \u25B6 \u91CD\u8BD5`);
        };
        const resolveDuration = () => {
          setDur(Number.isFinite(el.duration) ? el.duration : 0);
          if (Number.isFinite(el.duration)) return;
          diag("duration-infinity", { rs: el.readyState, cur: el.currentTime });
          const onDuration = () => {
            el.removeEventListener("durationchange", onDuration);
            if (Number.isFinite(el.duration)) {
              diag("duration-resolved", { dur: +el.duration.toFixed(2) });
              try {
                el.currentTime = 0;
              } catch {
              }
              setDur(el.duration);
            }
          };
          el.addEventListener("durationchange", onDuration);
          try {
            el.currentTime = 1e101;
          } catch {
          }
        };
        el.addEventListener("loadedmetadata", resolveDuration);
        el.addEventListener("timeupdate", onTime);
        el.addEventListener("loadedmetadata", onTime);
        el.addEventListener("play", onPlay);
        el.addEventListener("pause", onPause);
        el.addEventListener("ended", onEnded);
        el.addEventListener("error", onError);
        return () => {
          el.removeEventListener("timeupdate", onTime);
          el.removeEventListener("loadedmetadata", onTime);
          el.removeEventListener("loadedmetadata", resolveDuration);
          el.removeEventListener("play", onPlay);
          el.removeEventListener("pause", onPause);
          el.removeEventListener("ended", onEnded);
          el.removeEventListener("error", onError);
        };
      }, [mode]);
      const blobUrlRef = useRef(null);
      const mediaSrcRef = useRef(null);
      const mseStartedRef = useRef(false);
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
      const loadMse = useCallback(async (track, key, shouldPlay, streamUrl) => {
        const el = getAudio();
        const res = await fetch(`/bili-music/manifest/${track.bvid}`, { cache: "no-store" });
        if (!res.ok) throw new Error(`manifest HTTP ${res.status}`);
        const mf = await res.json();
        if (!mf.ok || !mf.segments?.length) throw new Error("no segments");
        const ms = new MediaSource();
        mediaSrcRef.current = ms;
        if (blobUrlRef.current) URL.revokeObjectURL(blobUrlRef.current);
        const url = URL.createObjectURL(ms);
        blobUrlRef.current = url;
        el.src = url;
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
        if (sharedKey !== key) return;
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
        let started = false;
        const tryStart = () => {
          if (started) return;
          started = true;
          mseStartedRef.current = true;
          setLoading(false);
          failKeyRef.current = "";
          setError("");
          diag("mse-ready", { bvid: track.bvid, segments: total, duration: mf.duration });
          if (shouldPlay) {
            el.play().then(() => setPlaying(true)).catch(() => setError("\u6D4F\u89C8\u5668\u62E6\u622A\u4E86\u81EA\u52A8\u64AD\u653E\uFF0C\u70B9 \u25B6 \u7EE7\u7EED"));
          }
        };
        for (; ; ) {
          const { done, value } = await reader.read();
          if (sharedKey !== key) {
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
            const seg = mf.segments[segIndex];
            await waitUpdate();
            sb.appendBuffer(slicer.slice(seg.start, seg.end));
            await waitUpdate();
            segIndex++;
            setLoadPct(segIndex / total);
            if (segIndex >= 1) tryStart();
          }
        }
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
        }
      }, []);
      const loadBlob = useCallback(async (track, key, shouldPlay, streamUrl) => {
        const el = getAudio();
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
            const now2 = Date.now();
            if (total && now2 - lastTick > 200) {
              lastTick = now2;
              setLoadPct(Math.min(0.99, received / total));
              if (sharedKey !== key) {
                try {
                  await reader.cancel();
                } catch {
                }
                break;
              }
            }
          }
          if (sharedKey !== key) return;
          const blob = new Blob(chunks, { type: "audio/mp4" });
          if (blobUrlRef.current) URL.revokeObjectURL(blobUrlRef.current);
          const url = URL.createObjectURL(blob);
          blobUrlRef.current = url;
          el.src = url;
          el.load();
          setLoading(false);
          setLoadPct(1);
          setError("");
          failKeyRef.current = "";
          diag("blob-ready", { bvid: track.bvid, size: blob.size });
          if (shouldPlay) {
            el.play().then(() => setPlaying(true)).catch(() => setError("\u6D4F\u89C8\u5668\u62E6\u622A\u4E86\u81EA\u52A8\u64AD\u653E\uFF0C\u70B9 \u25B6 \u7EE7\u7EED"));
          }
        } finally {
          clearTimeout(timer);
        }
      }, []);
      const loadAndMaybePlay = useCallback(
        (track) => {
          const el = getAudio();
          const key = `${track.bvid}|${track.startedAt || ""}`;
          if (sharedKey === key) return;
          sharedKey = key;
          const streamUrl = `${track.stream}?t=${encodeURIComponent(track.startedAt || "")}`;
          setNow(0);
          setDur(0);
          setLoadPct(0);
          setLoading(true);
          const shouldPlay = autoNextRef.current;
          autoNextRef.current = false;
          try {
            el.pause();
          } catch {
          }
          setPlaying(false);
          mseStartedRef.current = false;
          const watchdog = setTimeout(() => {
            if (sharedKey !== key || mseStartedRef.current) return;
            diag("mse-watchdog", { bvid: track.bvid });
            try {
              mediaSrcRef.current?.endOfStream();
            } catch {
            }
            loadBlob(track, key, true, streamUrl).catch(() => {
              if (sharedKey !== key) return;
              setLoading(false);
              failKeyRef.current = key;
              setError("\u97F3\u6E90\u52A0\u8F7D\u5931\u8D25\uFF0C\u70B9 \u25B6 \u91CD\u8BD5");
            });
          }, 1e4);
          loadMse(track, key, shouldPlay, streamUrl).catch((e) => {
            if (sharedKey !== key) return;
            clearTimeout(watchdog);
            diag("mse-fail", { bvid: track.bvid, err: String(e && e.message) });
            loadBlob(track, key, shouldPlay, streamUrl).catch((e2) => {
              if (sharedKey !== key) return;
              setLoading(false);
              failKeyRef.current = key;
              const reason = e2 && e2.name === "AbortError" ? "\u52A0\u8F7D\u8D85\u65F6" : e2.message || e2;
              setError(`\u97F3\u6E90\u52A0\u8F7D\u5931\u8D25\uFF08${reason}\uFF09\uFF0C\u70B9 \u25B6 \u91CD\u8BD5`);
            });
          });
        },
        [loadMse, loadBlob]
      );
      useEffect(() => {
        if (!current) return;
        loadAndMaybePlay(current);
      }, [current, loadAndMaybePlay]);
      const toggle = useCallback(async () => {
        const el = getAudio();
        if (!current) return;
        setError("");
        if (failKeyRef.current || el.error) {
          sharedKey = "";
          el.removeAttribute("src");
          el.load();
          loadAndMaybePlay(current);
          return;
        }
        if (el.ended || el.duration && el.currentTime >= el.duration - 0.2) el.currentTime = 0;
        try {
          if (el.paused) {
            await el.play();
            setPlaying(true);
          } else {
            el.pause();
            setPlaying(false);
          }
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
      const seekTo = useCallback((target) => {
        const el = getAudio();
        if (!Number.isFinite(target) || target < 0) return;
        let bounded = target;
        if (Number.isFinite(el.duration) && el.duration > 0) {
          bounded = Math.min(bounded, el.duration - 0.25);
        }
        try {
          if (el.seekable && el.seekable.length > 0) {
            const s = el.seekable.start(el.seekable.length - 1);
            const e = el.seekable.end(el.seekable.length - 1);
            if (e > s && bounded <= e) bounded = Math.min(Math.max(bounded, s), e - 0.25);
          }
        } catch {
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
                return el.seekable && el.seekable.length ? [el.seekable.start(0), el.seekable.end(el.seekable.length - 1)] : [];
              } catch {
                return [];
              }
            })()
          });
          try {
            el.currentTime = bounded;
            setNow(bounded);
          } catch (e) {
            diag("seek-throw", { target: bounded, err: String(e && e.message) });
            return;
          }
          diag("seek-before", { target: +bounded.toFixed(2), ...snap() });
          setTimeout(() => diag("seek-after", { target: +bounded.toFixed(2), ...snap() }), 350);
          setTimeout(() => diag("seek-after-1s", { target: +bounded.toFixed(2), ...snap() }), 1100);
        };
        if (el.readyState >= 2) {
          apply();
          return;
        }
        const onReady = () => {
          el.removeEventListener("canplay", onReady);
          el.removeEventListener("loadeddata", onReady);
          apply();
        };
        el.addEventListener("canplay", onReady);
        el.addEventListener("loadeddata", onReady);
      }, []);
      const seek = useCallback(
        (event) => {
          const el = getAudio();
          const rect = event.currentTarget.getBoundingClientRect();
          if (!rect.width) return;
          const ratio = Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width));
          const total = Number.isFinite(el.duration) && el.duration > 0 ? el.duration : current && current.duration || 0;
          if (!total) return;
          diag("click", {
            ratio: +ratio.toFixed(3),
            total: +total.toFixed(1),
            rs: el.readyState,
            cur: +el.currentTime.toFixed(2),
            dur: el.duration,
            biliDur: current && current.duration,
            paused: el.paused
          });
          seekTo(ratio * total);
        },
        [current, seekTo]
      );
      const send = useCallback(
        async (action, targetBvid, ev) => {
          if (pendingRef.current) return;
          const bvid = targetBvid || current && current.bvid;
          const curFb = targetBvid ? (state.history.find((x) => x.bvid === targetBvid) || {}).feedback : active;
          if (curFb === action) {
            showNotice("\u5DF2\u7ECF\u662F\u8FD9\u4E2A\u53CD\u9988\u4E86", "info", ev);
            return;
          }
          pendingRef.current = true;
          setPending(action + (targetBvid || ""));
          try {
            const res = await fetch("/bili-music/feedback", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ action, bvid: targetBvid || "" })
            });
            const data = await res.json().catch(() => ({}));
            if (!res.ok || !data.ok) throw new Error(data.error || `HTTP ${res.status}`);
            setState((s) => ({
              ...s,
              current: s.current && s.current.bvid === (bvid || s.current.bvid) ? { ...s.current, feedback: action } : s.current,
              history: s.history.map(
                (row) => row.bvid === bvid ? { ...row, feedback: action } : row
              )
            }));
            if (action === "like") {
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
      const iconBtn = (glyph, title, onClick, opts = {}) => h(
        "button",
        {
          type: "button",
          title,
          onClick,
          disabled: !!opts.disabled,
          style: {
            border: "none",
            background: "transparent",
            color: opts.active ? C.brand : C.label2,
            borderRadius: 6,
            width: 24,
            height: 22,
            cursor: "pointer",
            fontSize: opts.size || 13,
            lineHeight: 1,
            padding: 0,
            flexShrink: 0,
            fontWeight: opts.active ? 700 : 400
          }
        },
        glyph
      );
      const fbBtn = (item) => {
        const on = active === item.key;
        const busy = pending === item.key;
        return h(
          "button",
          {
            type: "button",
            title: on ? `\u5DF2\u6807\u8BB0\uFF1A${item.label}` : item.tip,
            disabled: !!pending,
            "aria-pressed": on,
            onClick: (e) => send(item.key, "", e),
            style: {
              border: "none",
              background: on ? `color-mix(in srgb, ${C.brand} 16%, transparent)` : "transparent",
              color: on ? C.brand : C.label2,
              borderRadius: 6,
              width: 24,
              height: 22,
              cursor: pending ? "wait" : "pointer",
              fontSize: 13,
              lineHeight: 1,
              padding: 0,
              flexShrink: 0,
              fontWeight: on ? 700 : 400
            }
          },
          busy ? "\u2026" : on ? "\u2713" : item.icon
        );
      };
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
            color: C.label
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
              background: C.layer3
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
                  color: C.label2,
                  whiteSpace: "nowrap",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  flexShrink: 2
                }
              },
              current.artist || ""
            )
          ),
          h(
            "span",
            {
              title: "\u70B9\u51FB\u5207\u6362\u8C03\u8BD5\u4FE1\u606F\uFF08\u684C\u9762\u7248\u6CA1\u6709 DevTools \u4E5F\u80FD\u770B\uFF09",
              onClick: () => {
                setDebugOn((v) => {
                  const next = !v;
                  try {
                    localStorage.setItem("bili-music-debug", next ? "1" : "0");
                  } catch {
                  }
                  return next;
                });
              },
              style: {
                color: loading ? C.brand : C.label3,
                fontVariantNumeric: "tabular-nums",
                flexShrink: 0,
                width: 82,
                textAlign: "right",
                cursor: "pointer"
              }
            },
            loading ? `\u52A0\u8F7D ${Math.round(loadPct * 100)}%` : `${fmt(now)}/${fmt(dur || current.duration || 0)}`
          ),
          debugOn ? h(
            "span",
            {
              title: "\u8C03\u8BD5\uFF1AreadyState / duration / currentTime / seekable",
              style: { color: C.err, fontFamily: "monospace", fontSize: 10, flexShrink: 0 }
            },
            (() => {
              const el = getAudio();
              let sk = "-";
              try {
                sk = el.seekable && el.seekable.length ? `${el.seekable.start(0).toFixed(0)}-${el.seekable.end(el.seekable.length - 1).toFixed(0)}` : "none";
              } catch {
              }
              return `rs${el.readyState} d${Number.isFinite(el.duration) ? el.duration.toFixed(0) : "\u221E"} t${el.currentTime.toFixed(1)} sk${sk}`;
            })()
          ) : null,
          h(
            "div",
            {
              onClick: seek,
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
                  background: C.layer3,
                  borderRadius: 2
                }
              },
              h("div", {
                style: {
                  position: "absolute",
                  inset: 0,
                  width: `${dur ? Math.min(100, now / dur * 100) : 0}%`,
                  background: C.brand,
                  borderRadius: 2
                }
              })
            )
          ),
          // 音量：喇叭点一下静音/恢复，滑条微调
          h(
            "div",
            { style: { display: "flex", alignItems: "center", gap: 3, flexShrink: 0 } },
            h(
              "span",
              {
                title: vol > 0 ? "\u9759\u97F3" : "\u6062\u590D\u97F3\u91CF",
                onClick: () => setVol(vol > 0 ? 0 : 0.8),
                style: { fontSize: 11, cursor: "pointer", color: C.label3, lineHeight: 1 }
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
              style: { width: 48, height: 14, cursor: "pointer", accentColor: C.brand, margin: 0 }
            })
          ),
          iconBtn(
            mode === "loop" ? "\u{1F501}" : "\u25B6\u25B6",
            mode === "loop" ? "\u5355\u66F2\u5FAA\u73AF\uFF08\u70B9\u51FB\u6539\u4E3A\u63A8\u8350\u8FDE\u64AD\uFF09" : "\u63A8\u8350\u8FDE\u64AD\uFF08\u70B9\u51FB\u6539\u4E3A\u5355\u66F2\u5FAA\u73AF\uFF09",
            () => setMode(mode === "loop" ? "recommend" : "loop"),
            { active: true, size: 11 }
          ),
          iconBtn(
            "\u{1F558}",
            "\u64AD\u653E\u5386\u53F2 / \u8865\u53CD\u9988",
            () => {
              setShowHistory((v) => !v);
              refresh();
            },
            { active: showHistory, size: 12 }
          ),
          ...ACTIONS.map(fbBtn)
        ),
        // 浮动提示：贴在鼠标点击处（没有坐标时退回播放条上方）
        notice ? h(
          "div",
          {
            role: "status",
            style: {
              position: "fixed",
              left: Number.isFinite(notice.x) ? notice.x : void 0,
              top: Number.isFinite(notice.y) ? notice.y - 34 : void 0,
              transform: "translate(-50%, -100%)",
              background: "var(--dsw-alias-toast-bg, rgba(20,20,20,.92))",
              color: "var(--dsw-alias-toast-label, #fff)",
              border: `1px solid ${notice.tone === "err" ? C.err : "transparent"}`,
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
        ) : null,
        error ? h(
          "div",
          {
            role: "status",
            style: {
              position: "fixed",
              left: barRef.current ? barRef.current.getBoundingClientRect().left + 90 : void 0,
              top: barRef.current ? barRef.current.getBoundingClientRect().top - 8 : void 0,
              transform: "translateY(-100%)",
              background: "var(--dsw-alias-toast-bg, rgba(20,20,20,.92))",
              color: "var(--dsw-alias-toast-label, #fff)",
              border: `1px solid ${C.err}`,
              padding: "5px 10px",
              borderRadius: 8,
              fontSize: 12,
              maxWidth: 380,
              boxShadow: "0 6px 20px rgba(0,0,0,.28)",
              pointerEvents: "none",
              zIndex: 9999
            }
          },
          error
        ) : null,
        showHistory ? h(
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
              border: `1px solid ${C.border}`,
              borderRadius: 10,
              background: C.layer1,
              color: C.label,
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
                color: C.label3
              }
            },
            h("span", null, `\u64AD\u653E\u5386\u53F2\uFF08${state.history.length}\uFF09`),
            h(
              "span",
              { style: { cursor: "pointer" }, onClick: () => setShowHistory(false) },
              "\u6536\u8D77 \u2715"
            )
          ),
          state.history.length === 0 ? h("div", { style: { padding: 8, color: C.label3 } }, "\u8FD8\u6CA1\u6709\u64AD\u653E\u8BB0\u5F55") : state.history.map(
            (item) => h(
              "div",
              {
                key: item.bvid,
                style: {
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  padding: "4px 6px",
                  borderRadius: 6,
                  background: current.bvid === item.bvid ? C.layer2 : "transparent"
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
                      fontWeight: current.bvid === item.bvid ? 600 : 400
                    }
                  },
                  item.title
                ),
                h(
                  "div",
                  {
                    style: {
                      color: C.label3,
                      whiteSpace: "nowrap",
                      overflow: "hidden",
                      textOverflow: "ellipsis"
                    }
                  },
                  `${item.artist || ""}${item.feedback ? " \xB7 \u5DF2" + (item.feedback === "like" ? "\u559C\u6B22" : item.feedback === "skip" ? "\u8DF3\u8FC7" : "\u4E0D\u559C\u6B22") : ""}`
                )
              ),
              ...ACTIONS.map((a) => {
                const on = item.feedback === a.key;
                return h(
                  "button",
                  {
                    key: a.key,
                    type: "button",
                    title: a.tip,
                    onClick: (e) => send(a.key, item.bvid, e),
                    style: {
                      border: "none",
                      background: on ? `color-mix(in srgb, ${C.brand} 16%, transparent)` : "transparent",
                      color: on ? C.brand : C.label3,
                      borderRadius: 6,
                      width: 22,
                      height: 20,
                      cursor: "pointer",
                      fontSize: 12,
                      lineHeight: 1,
                      padding: 0
                    }
                  },
                  on ? "\u2713" : a.icon
                );
              })
            )
          )
        ) : null
      );
    }
    class BarBoundary extends React.Component {
      constructor(props) {
        super(props);
        this.state = { err: null };
      }
      static getDerivedStateFromError(err) {
        return { err };
      }
      componentDidCatch(err) {
        diag("bar-crash", { err: String(err && err.message) });
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
