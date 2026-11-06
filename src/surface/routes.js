import fs from 'node:fs';
import path from 'node:path';

/**
 * HTTP 入口：只做参数解析、调用领域动作、拼状态码与响应体。
 * 播放/反馈/推荐规则都在 domain/，传输细节在 adapters/。
 */

/**
 * @param {{base: string, store: object, state: object, feedbackStats: Function, feedbackOf: Function,
 *   profileSummary: Function, playNext: Function, playPrev: Function, submitFeedback: Function,
 *   videoInfo: Function, audioStream: Function, manifestReader: object, audioCache: object,
 *   ensureAudioFile: Function, userAgent: string}} deps
 */
export function createHandler(deps) {
  const {
    base,
    store,
    state,
    feedbackStats,
    feedbackOf,
    profileSummary,
    playNext,
    playPrev,
    submitFeedback,
    videoInfo,
    audioStream,
    manifestReader,
    audioCache,
    ensureAudioFile,
    userAgent,
  } = deps;

  const sendJson = (res, code, payload) => {
    res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(payload));
  };

  const readBody = async (req) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    try {
      return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
    } catch {
      return {};
    }
  };

  /** 本地缓存直接按 Range 返回；未缓存时把 Range 透传 CDN 并后台落盘。 */
  async function serveStream(req, res, bvid) {
    const range = req.headers.range;
    const info = await videoInfo(bvid);
    const cachedFile = audioCache.fileOf(bvid);
    const cachedReady = audioCache.isComplete(cachedFile);

    if (!cachedReady) {
      ensureAudioFile(bvid, info.cid).catch((error) =>
        console.error('[bili-music] 后台缓存失败', bvid, String(error.message || error)),
      );
      const stream = await audioStream(bvid, info.cid);
      const upstream = await fetch(stream.url, {
        headers: {
          'User-Agent': userAgent,
          Referer: 'https://www.bilibili.com/',
          ...(range ? { Range: range } : {}),
        },
        signal: AbortSignal.timeout(30000),
      });
      const length = upstream.headers.get('content-length');
      const contentRange = upstream.headers.get('content-range');
      res.writeHead(upstream.status, {
        'content-type': 'audio/mp4',
        ...(length ? { 'content-length': length } : {}),
        ...(contentRange ? { 'content-range': contentRange } : {}),
        'accept-ranges': 'bytes',
        'cache-control': 'private, max-age=3600',
      });
      if (upstream.body) {
        for await (const chunk of upstream.body) res.write(chunk);
      }
      res.end();
      return;
    }

    const size = fs.statSync(cachedFile).size;
    let start = 0;
    let end = size - 1;
    let partial = false;
    if (range) {
      const match = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
      if (match) {
        partial = true;
        if (match[1] === '' && match[2] !== '') {
          start = Math.max(0, size - Number(match[2])); // 后缀范围：最后 N 字节
          end = size - 1;
        } else {
          start = match[1] === '' ? 0 : Number(match[1]);
          end = match[2] === '' ? size - 1 : Math.min(Number(match[2]), size - 1);
        }
      }
    }
    if (start > end || start >= size) {
      res.writeHead(416, { 'content-range': `bytes */${size}` });
      res.end();
      return;
    }

    res.writeHead(partial ? 206 : 200, {
      'content-type': 'audio/mp4',
      'content-length': String(end - start + 1),
      'accept-ranges': 'bytes',
      ...(partial ? { 'content-range': `bytes ${start}-${end}/${size}` } : {}),
      'cache-control': 'private, max-age=3600',
    });
    const stream = fs.createReadStream(cachedFile, { start, end });
    stream.on('error', () => {
      try {
        res.end();
      } catch {
        /* 忽略 */
      }
    });
    stream.pipe(res);
  }

  return async function handler(req, res) {
    const url = new URL(req.url, 'http://127.0.0.1');

    if (url.pathname === '/bili-music/state') {
      const stats = feedbackStats();
      const map = store.readFeedbackState();
      const current = state.current
        ? { ...state.current, feedback: feedbackOf(state.current.bvid) }
        : null;
      const history = (state.history || []).slice(0, 50).map((entry, index) => ({
        ...entry,
        feedback: map[entry.bvid]?.action || null,
        current: index === (state.cursor || 0),
      }));
      return sendJson(res, 200, {
        ok: true,
        current,
        feedbackTotal: stats.total,
        history,
        cursor: state.cursor || 0,
      });
    }

    if (url.pathname === '/bili-music/next' && req.method === 'POST') {
      await readBody(req);
      try {
        return sendJson(res, 200, { ok: true, ...(await playNext()) });
      } catch (error) {
        return sendJson(res, 400, { ok: false, error: String(error.message || error) });
      }
    }

    if (url.pathname === '/bili-music/prev' && req.method === 'POST') {
      try {
        return sendJson(res, 200, { ok: true, ...(await playPrev()) });
      } catch (error) {
        return sendJson(res, 400, { ok: false, error: String(error.message || error) });
      }
    }

    if (url.pathname === '/bili-music/profile') {
      return sendJson(res, 200, {
        ok: true,
        profile: profileSummary(),
        feedback: { total: feedbackStats().total },
      });
    }

    if (url.pathname === '/bili-music/feedback' && req.method === 'POST') {
      const body = await readBody(req);
      try {
        return sendJson(res, 200, {
          ok: true,
          ...(await submitFeedback(
            String(body.action),
            String(body.reason || ''),
            String(body.bvid || ''),
          )),
        });
      } catch (error) {
        return sendJson(res, 400, { ok: false, error: String(error.message || error) });
      }
    }

    if (url.pathname.startsWith('/bili-music/manifest/')) {
      const bvid = url.pathname.slice('/bili-music/manifest/'.length).replace(/[^A-Za-z0-9]/g, '');
      try {
        const info = await videoInfo(bvid);
        const manifest = await manifestReader.get(bvid, info.cid);
        if (!manifest) {
          return sendJson(res, 415, { ok: false, error: '该音频没有分段索引，无法边下边播' });
        }
        return sendJson(res, 200, manifest);
      } catch (error) {
        return sendJson(res, 502, { ok: false, error: String(error.message || error) });
      }
    }

    if (url.pathname.startsWith('/bili-music/stream/')) {
      const bvid = url.pathname.slice('/bili-music/stream/'.length).replace(/[^A-Za-z0-9]/g, '');
      try {
        return await serveStream(req, res, bvid);
      } catch (error) {
        return sendJson(res, 502, { ok: false, error: String(error.message || error) });
      }
    }

    // 前端诊断通道：桌面版没有 DevTools 时，把日志写进文件由 agent 读取
    if (url.pathname === '/bili-music/debug' && req.method === 'POST') {
      try {
        const body = await readBody(req);
        const line = JSON.stringify(body).slice(0, 4000);
        fs.mkdirSync(base, { recursive: true });
        const logFile = path.join(base, 'debug.log');
        fs.appendFileSync(logFile, `${new Date().toISOString()} ${line}\n`, 'utf8');
        const stat = fs.statSync(logFile);
        if (stat.size > 512 * 1024) fs.writeFileSync(logFile, '', 'utf8');
        return sendJson(res, 200, { ok: true });
      } catch (error) {
        return sendJson(res, 500, { ok: false, error: String(error.message || error) });
      }
    }

    return sendJson(res, 404, { ok: false, error: 'not found' });
  };
}

/** 把路由挂到宿主 webServer 上；返回卸载函数由 ctx.effect 管理。 */
export function registerRoutes(ctx, deps) {
  const handler = createHandler(deps);
  return ctx.effect(() => ctx.webServer.register({ kind: 'prefix', path: '/bili-music', handler }));
}
