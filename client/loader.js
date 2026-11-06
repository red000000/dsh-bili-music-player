/**
 * 音频资源加载：把一首歌的音频送进 <audio>。
 *
 * 两条路：MSE 分片流式起播（首段到齐就能播），失败或 10 秒没起来就退回
 * 整首下载（实现简单、能 seek）。组件只决定「什么时候换歌」，取消、竞态与
 * object URL 的生命周期都留在这里，避免把命令式时序摊进渲染逻辑。
 *
 * @param {{
 *   el: HTMLAudioElement,
 *   diag: (tag: string, data?: object) => void,
 *   onLoading: (loading: boolean) => void,
 *   onProgress: (ratio: number) => void,
 *   onPlaying: (playing: boolean) => void,
 *   onError: (message: string) => void,
 * }} deps
 */
export function createLoader({ el, diag, onLoading, onProgress, onPlaying, onError }) {
  /** 当前已加载的曲目键；异步回调靠它判断自己是否已经过期。 */
  let currentKey = '';
  /** 上一次加载是否失败：失败后点播放要整条重来，而不是调 toggle。 */
  let failed = false;
  /** 看门狗已接管、MSE 循环必须停下来的曲目键。 */
  let abortedKey = '';
  /** 本次加载里 MSE 是否已经起播（看门狗据此放行）。 */
  let started = false;
  let blobUrl = null;
  let mediaSource = null;
  let watchdog = null;

  const isCurrent = (key) => currentKey === key;

  /** 换掉元素上的音频源；旧 object URL 要撤销，否则每次换歌泄漏一份内存。 */
  const setObjectUrl = (url, reload) => {
    if (blobUrl) {
      try {
        URL.revokeObjectURL(blobUrl);
      } catch {
        /* 忽略 */
      }
    }
    blobUrl = url;
    el.src = url;
    if (reload) el.load();
  };

  const stopWatchdog = (key) => {
    if (!watchdog || (key && watchdog.key !== key)) return;
    clearTimeout(watchdog.timer);
    watchdog = null;
  };

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

  async function loadMse(track, key, shouldPlay, streamUrl) {
    const res = await fetch(`/bili-music/manifest/${track.bvid}`, { cache: 'no-store' });
    if (!res.ok) throw new Error(`manifest HTTP ${res.status}`);
    const mf = await res.json();
    if (!mf.ok || !mf.segments?.length) throw new Error('no segments');

    const ms = new MediaSource();
    mediaSource = ms;
    setObjectUrl(URL.createObjectURL(ms));

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
    if (!isCurrent(key)) return;

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

    const tryStart = () => {
      if (started) return;
      started = true;
      stopWatchdog(key);
      onLoading(false);
      failed = false;
      onError('');
      diag('mse-ready', { bvid: track.bvid, segments: total, duration: mf.duration });
      if (shouldPlay) {
        el.play()
          .then(() => onPlaying(true))
          .catch(() => onError('浏览器拦截了自动播放，点 ▶ 继续'));
      }
    };

    for (;;) {
      const { done, value } = await reader.read();
      if (!isCurrent(key) || abortedKey === key) {
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
        // append 之间可能已经换歌或看门狗接管，别把旧数据继续灌给新曲目
        if (!isCurrent(key) || abortedKey === key) return;
        const seg = mf.segments[segIndex];
        await waitUpdate();
        sb.appendBuffer(slicer.slice(seg.start, seg.end));
        await waitUpdate();
        segIndex++;
        onProgress(segIndex / total);
        // 第一段就绪即可起播
        if (segIndex >= 1) tryStart();
      }
    }
    // 文件读完：把剩余分段补完
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
      /* 忽略 */
    }
  }

  async function loadBlob(track, key, shouldPlay, streamUrl) {
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
        const tick = Date.now();
        if (total && tick - lastTick > 200) {
          lastTick = tick;
          onProgress(Math.min(0.99, received / total));
          if (!isCurrent(key)) {
            try {
              await reader.cancel();
            } catch {
              /* 忽略 */
            }
            break;
          }
        }
      }
      if (!isCurrent(key)) return;
      const blob = new Blob(chunks, { type: 'audio/mp4' });
      setObjectUrl(URL.createObjectURL(blob), true);
      onLoading(false);
      onProgress(1);
      onError('');
      failed = false;
      diag('blob-ready', { bvid: track.bvid, size: blob.size });
      if (shouldPlay) {
        el.play()
          .then(() => onPlaying(true))
          .catch(() => onError('浏览器拦截了自动播放，点 ▶ 继续'));
      }
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * 换到指定曲目：先停旧音频，再走 MSE；10 秒没起播就让看门狗切整首下载。
   * 同一个 key 重复调用直接忽略，避免轮询把正在播的歌重新加载一遍。
   */
  function load({ track, key, shouldPlay, streamUrl }) {
    if (currentKey === key) return;
    currentKey = key;
    started = false;
    abortedKey = '';
    onLoading(true);
    onProgress(0);

    // 先停掉旧音频，避免「标题是新歌、声音还是上一首」
    try {
      el.pause();
    } catch {
      /* 忽略 */
    }

    stopWatchdog();
    watchdog = {
      key,
      timer: setTimeout(() => {
        if (!isCurrent(key) || started) return;
        diag('mse-watchdog', { bvid: track.bvid });
        abortedKey = key;
        try {
          mediaSource?.endOfStream();
        } catch {
          /* 忽略 */
        }
        loadBlob(track, key, true, streamUrl).catch(() => {
          if (!isCurrent(key)) return;
          onLoading(false);
          failed = true;
          onError('音源加载失败，点 ▶ 重试');
        });
      }, 10000),
    };

    loadMse(track, key, shouldPlay, streamUrl).catch((error) => {
      if (!isCurrent(key)) return;
      stopWatchdog(key);
      diag('mse-fail', { bvid: track.bvid, err: String(error && error.message) });
      // 看门狗已经切到整首下载，避免两条链路同时写同一个 audio
      if (abortedKey === key) return;
      // MSE 不可用（极少见）时退回整首下载，保证能播且能 seek
      loadBlob(track, key, shouldPlay, streamUrl).catch((blobError) => {
        if (!isCurrent(key)) return;
        onLoading(false);
        failed = true;
        const reason =
          blobError && blobError.name === 'AbortError'
            ? '加载超时'
            : blobError.message || blobError;
        onError(`音源加载失败（${reason}），点 ▶ 重试`);
      });
    });
  }

  /** 放弃当前曲目（加载失败后重试时用）：清掉键与元素上的旧源。 */
  function reset() {
    currentKey = '';
    abortedKey = '';
    started = false;
    try {
      el.removeAttribute('src');
      el.load();
    } catch {
      /* 忽略 */
    }
  }

  function destroy() {
    stopWatchdog();
    currentKey = '';
    if (blobUrl) {
      try {
        URL.revokeObjectURL(blobUrl);
      } catch {
        /* 忽略 */
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
    destroy,
  };
}
