import fs from 'node:fs';
import path from 'node:path';

const CACHE_MAX_FILES = 40;
const COMPLETE_MIN_BYTES = 100 * 1024; // 小于这个体积视为半截文件，重新下载
const PART_TTL_MS = 60 * 60 * 1000; // 进程被杀留下的 .part，超过一小时清掉

/**
 * 本地音频缓存：整首下载成 `${bvid}.m4a`，浏览器随后按 Range 取稳定字节。
 * 上游直链会过期、会抖动，落盘后再提供是播放器通行做法。
 *
 * @param {{dir: string, resolveStream: (bvid: string, cid: number, opts?: {fresh?: boolean}) => Promise<{url: string}>,
 *   userAgent: string, downloadTimeoutMs?: number}} deps
 */
export function createAudioCache({ dir, resolveStream, userAgent, downloadTimeoutMs = 40000 }) {
  const downloading = new Map(); // bvid -> Promise<filePath>

  const fileOf = (bvid) => path.join(dir, `${bvid}.m4a`);
  const isComplete = (file) => fs.existsSync(file) && fs.statSync(file).size > COMPLETE_MIN_BYTES;

  /** 清掉超期半成品与超出上限的旧缓存。 */
  function prune() {
    try {
      const now = Date.now();
      for (const name of fs.readdirSync(dir)) {
        if (!name.endsWith('.part')) continue;
        const full = path.join(dir, name);
        try {
          if (now - fs.statSync(full).mtimeMs > PART_TTL_MS) fs.unlinkSync(full);
        } catch {
          /* 忽略 */
        }
      }
      const files = fs
        .readdirSync(dir)
        .filter((name) => name.endsWith('.m4a'))
        .map((name) => {
          const full = path.join(dir, name);
          return { full, at: fs.statSync(full).mtimeMs };
        })
        .sort((a, b) => a.at - b.at);
      while (files.length > CACHE_MAX_FILES) {
        const oldest = files.shift();
        try {
          fs.unlinkSync(oldest.full);
        } catch {
          /* 忽略 */
        }
      }
    } catch {
      /* 目录可能还不存在 */
    }
  }

  /** 下载一次；失败会清掉半成品，是否重取直链由上层决定。 */
  async function downloadOnce(bvid, cid, file, fresh) {
    const stream = await resolveStream(bvid, cid, { fresh });
    const res = await fetch(stream.url, {
      headers: { 'User-Agent': userAgent, Referer: 'https://www.bilibili.com/' },
      signal: AbortSignal.timeout(downloadTimeoutMs),
    });
    if (!res.ok || !res.body) throw new Error(`下载音频失败: HTTP ${res.status}`);
    const part = `${file}.part`;
    const handle = fs.createWriteStream(part);
    let ended = false;
    const endOnce = () =>
      new Promise((resolve) => {
        if (ended) {
          resolve();
          return;
        }
        ended = true;
        handle.end(resolve);
      });
    try {
      for await (const chunk of res.body) {
        if (!handle.write(chunk)) await new Promise((r) => handle.once('drain', r));
      }
    } catch (error) {
      await endOnce();
      try {
        fs.unlinkSync(part);
      } catch {
        /* 忽略 */
      }
      throw error;
    } finally {
      await endOnce();
    }
    if (fs.statSync(part).size < 1024) {
      try {
        fs.unlinkSync(part);
      } catch {
        /* 忽略 */
      }
      throw new Error('下载的音频为空');
    }
    fs.renameSync(part, file);
    return file;
  }

  return {
    dir,
    fileOf,
    isComplete,
    prune,
    /**
     * 保证本地有完整文件：已存在直接返回；并发请求共用同一次下载。
     * 首次失败会强制重取直链再试一次（直链默认 30 分钟过期）。
     */
    async ensure(bvid, cid) {
      fs.mkdirSync(dir, { recursive: true });
      const file = fileOf(bvid);
      if (isComplete(file)) return file;
      if (downloading.has(bvid)) return downloading.get(bvid);

      const task = (async () => {
        try {
          return await downloadOnce(bvid, cid, file, false);
        } catch (firstError) {
          console.error(
            '[bili-music] 首次下载失败，重取直链重试',
            bvid,
            String(firstError.message || firstError),
          );
          return await downloadOnce(bvid, cid, file, true);
        } finally {
          prune();
        }
      })().finally(() => downloading.delete(bvid));

      downloading.set(bvid, task);
      return task;
    },
  };
}
