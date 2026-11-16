import fs from 'fs';

const SEGMENT_ID = 0x18538067;
const INFO_ID = 0x1549a966;
const TIMECODE_SCALE_ID = 0x2ad7b1;
const DURATION_ID = 0x4489;
/** Segment Info 位于文件头部（EBML 头、SeekHead 之后），只读取开头这部分 */
const HEAD_BYTES = 64 * 1024;

/**
 * 读取 WebM Segment Info 中的 Duration（毫秒）。没有 Duration 或结构无法解析时返回 undefined。
 */
export function readWebmDurationMs(fd: number): number | undefined {
  const buf = Buffer.alloc(HEAD_BYTES);
  const length = fs.readSync(fd, buf, 0, HEAD_BYTES, 0);
  const segment = findChild(buf, 0, length, SEGMENT_ID);
  if (!segment) {
    return undefined;
  }
  const info = findChild(buf, segment.start, segment.end, INFO_ID);
  if (!info) {
    return undefined;
  }
  const duration = findChild(buf, info.start, info.end, DURATION_ID);
  if (!duration || (duration.end - duration.start !== 4 && duration.end - duration.start !== 8)) {
    return undefined;
  }
  const scale = findChild(buf, info.start, info.end, TIMECODE_SCALE_ID);
  const timecodeScaleNs = scale ? buf.readUIntBE(scale.start, scale.end - scale.start) : 1000000;
  const value = duration.end - duration.start === 4 ? buf.readFloatBE(duration.start) : buf.readDoubleBE(duration.start);
  return Math.round((value * timecodeScaleNs) / 1e6);
}

/** 在 [from, end) 内按顺序查找指定 ID 的子元素，返回其数据区间；未知长度的元素视为延伸到 end */
function findChild(buf: Buffer, from: number, end: number, id: number): { start: number; end: number } | undefined {
  let pos = from;
  while (pos < end) {
    const idLength = vintLength(buf[pos]);
    if (!idLength || idLength > 4 || pos + idLength > end) {
      return undefined;
    }
    const elementId = buf.readUIntBE(pos, idLength);
    pos += idLength;
    const sizeLength = vintLength(buf[pos]);
    if (!sizeLength || pos + sizeLength > end) {
      return undefined;
    }
    let size = buf[pos] & (0xff >> sizeLength);
    let unknownSize = size === 0xff >> sizeLength;
    for (let i = 1; i < sizeLength; i++) {
      size = size * 256 + buf[pos + i];
      unknownSize = unknownSize && buf[pos + i] === 0xff;
    }
    pos += sizeLength;
    const dataEnd = unknownSize ? end : Math.min(pos + size, end);
    if (elementId === id) {
      return { start: pos, end: dataEnd };
    }
    if (unknownSize) {
      return undefined;
    }
    pos += size;
  }
  return undefined;
}

function vintLength(firstByte: number | undefined): number {
  if (!firstByte) {
    return 0;
  }
  let length = 1;
  while (!(firstByte & (0x80 >> (length - 1)))) {
    length++;
  }
  return length;
}
