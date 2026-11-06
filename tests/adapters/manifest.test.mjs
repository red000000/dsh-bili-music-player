import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseManifest } from '../../src/adapters/manifest.js';

/** 造一个最小的 fMP4 头部：ftyp + moov + sidx（1 个分段）。 */
function buildHeader({ timescale = 1000, duration = 500, refSize = 100 } = {}) {
  const ftyp = Buffer.alloc(16);
  ftyp.writeUInt32BE(16, 0);
  ftyp.write('ftyp', 4);

  const moov = Buffer.alloc(16);
  moov.writeUInt32BE(16, 0);
  moov.write('moov', 4);

  const sidx = Buffer.alloc(44);
  sidx.writeUInt32BE(44, 0);
  sidx.write('sidx', 4);
  sidx[8] = 0; // version
  sidx.writeUInt32BE(timescale, 16);
  sidx.writeUInt32BE(0, 20); // earliest_presentation_time
  sidx.writeUInt32BE(0, 24); // first_offset
  sidx.writeUInt16BE(1, 30); // reference count
  sidx.writeUInt32BE(refSize, 32);
  sidx.writeUInt32BE(duration, 36);

  return Buffer.concat([ftyp, moov, sidx]);
}

test('解析出 init 段与分段表', () => {
  const manifest = parseManifest(buildHeader(), 'BV1');
  assert.equal(manifest.bvid, 'BV1');
  assert.equal(manifest.timescale, 1000);
  assert.equal(manifest.duration, 0.5);
  assert.equal(manifest.init.end, 31, 'init 应覆盖 ftyp 与 moov');
  assert.equal(manifest.segments.length, 1);
  assert.equal(manifest.segments[0].start, 76);
  assert.equal(manifest.segments[0].end, 175);
  assert.equal(manifest.segments[0].tEnd, 0.5);
});

test('没有 sidx 的普通 MP4 返回 null', () => {
  const buf = Buffer.alloc(16);
  buf.writeUInt32BE(16, 0);
  buf.write('ftyp', 4);
  assert.equal(parseManifest(buf), null);
});

test('sidx 声明 0 个分段时返回 null', () => {
  const buf = buildHeader();
  buf.writeUInt16BE(0, buf.length - 14); // count 置 0
  assert.equal(parseManifest(buf), null);
});

test('非 MP4 垃圾数据不会抛错', () => {
  assert.equal(parseManifest(Buffer.from('not a video')), null);
});

test('sidx 记录数超出盒子时返回 null 而不是抛错', () => {
  const buf = buildHeader();
  buf.writeUInt16BE(60000, 62); // count 字段；44 字节的盒子放不下 6 万条记录
  assert.equal(parseManifest(buf), null);
});

test('sidx 盒子过短时返回 null', () => {
  const ftyp = Buffer.alloc(16);
  ftyp.writeUInt32BE(16, 0);
  ftyp.write('ftyp', 4);
  const moov = Buffer.alloc(16);
  moov.writeUInt32BE(16, 0);
  moov.write('moov', 4);
  const sidx = Buffer.alloc(8);
  sidx.writeUInt32BE(8, 0);
  sidx.write('sidx', 4);

  assert.equal(parseManifest(Buffer.concat([ftyp, moov, sidx])), null);
});
