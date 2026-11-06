import fs from 'node:fs';
import path from 'node:path';

/**
 * 解析 fMP4 的 sidx 索引，得出「每个分段在文件里的字节区间」和它覆盖的时长。
 * 客户端有了这张表就能边下边播：只要 init 段到达就能出声，后续分段按表追加。
 *
 * @param {Buffer} buf 完整文件或文件头部（至少覆盖到 sidx 结束）
 * @param {string} bvid 稿件号，仅写入返回值
 * @returns {{ok: true, bvid: string, codec: string, timescale: number, duration: number,
 *   startTime: number, init: {start: number, end: number},
 *   segments: Array<{start: number, end: number, tStart: number, tEnd: number}>} | null}
 */
export function parseManifest(buf, bvid = '') {
  const boxes = (start, end) => {
    const out = [];
    let offset = start;
    while (offset + 8 <= end) {
      const size = buf.readUInt32BE(offset);
      if (size < 8 || offset + size > end) break;
      out.push({ type: buf.toString('ascii', offset + 4, offset + 8), start: offset, size });
      offset += size;
    }
    return out;
  };

  const top = boxes(0, buf.length);
  const moov = top.find((b) => b.type === 'moov');
  const sidx = top.find((b) => b.type === 'sidx');
  if (!moov || !sidx) return null;

  const s = sidx.start;
  // sidx 的固定字段：8 字节头 + 版本与标志 + 参考号 + timescale + 两个时间字段 + 保留 + 计数
  if (sidx.size < 32) return null;
  const version = buf[s + 8];
  if (version !== 0 && sidx.size < 40) return null;
  const timescale = buf.readUInt32BE(s + 16);
  let o = s + 20;
  const earliest = version === 0 ? buf.readUInt32BE(o) : Number(buf.readBigUInt64BE(o));
  o += version === 0 ? 4 : 8;
  const firstOffset = version === 0 ? buf.readUInt32BE(o) : Number(buf.readBigUInt64BE(o));
  o += version === 0 ? 4 : 8;
  o += 2; // reserved
  const count = buf.readUInt16BE(o);
  o += 2;
  // 记录区必须完整落在 sidx 盒子里：裁剪过的头部或损坏的 count 直接判为不可用
  if (o + count * 12 > s + sidx.size) return null;

  const segments = [];
  let pos = s + sidx.size + firstOffset;
  let elapsed = 0;
  for (let i = 0; i < count; i++) {
    const ref = buf.readUInt32BE(o);
    const refSize = ref & 0x7fffffff;
    const dur = buf.readUInt32BE(o + 4);
    o += 12;
    if (ref >>> 31 === 1) continue; // 只处理 media 分段
    if (refSize <= 0) continue;
    segments.push({
      start: pos,
      end: pos + refSize - 1,
      tStart: elapsed / timescale,
      tEnd: (elapsed + dur) / timescale,
    });
    pos += refSize;
    elapsed += dur;
  }
  if (!segments.length || !timescale) return null;

  return {
    ok: true,
    bvid,
    codec: 'mp4a.40.2',
    timescale,
    duration: elapsed / timescale,
    startTime: earliest / timescale,
    init: { start: 0, end: s - 1 },
    segments,
  };
}

/**
 * 清单读取器：本地已有完整缓存就直接解析，否则只取文件头部（moov + sidx）解析，
 * 避免为了拿索引而等整首下载完。
 *
 * @param {{cacheDir: string, resolveStream: (bvid: string, cid: number) => Promise<{url: string}>,
 *   userAgent: string, headerBytes?: number, timeoutMs?: number}} deps
 */
export function createManifestReader({
  cacheDir,
  resolveStream,
  userAgent,
  headerBytes = 262144,
  timeoutMs = 15000,
}) {
  const cache = new Map();
  return {
    async get(bvid, cid) {
      if (cache.has(bvid)) return cache.get(bvid);
      const file = path.join(cacheDir, `${bvid}.m4a`);
      let manifest = null;
      if (fs.existsSync(file) && fs.statSync(file).size > 100 * 1024) {
        manifest = parseManifest(fs.readFileSync(file), bvid);
      }
      if (!manifest) {
        const stream = await resolveStream(bvid, cid);
        const res = await fetch(stream.url, {
          headers: {
            'User-Agent': userAgent,
            Referer: 'https://www.bilibili.com/',
            Range: `bytes=0-${headerBytes - 1}`,
          },
          signal: AbortSignal.timeout(timeoutMs),
        });
        if (!res.ok && res.status !== 206) throw new Error(`取头部失败: HTTP ${res.status}`);
        manifest = parseManifest(Buffer.from(await res.arrayBuffer()), bvid);
      }
      if (manifest) cache.set(bvid, manifest);
      return manifest;
    },
  };
}
