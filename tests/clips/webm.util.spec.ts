import fs from 'fs';
import os from 'os';
import path from 'path';
import { describe, expect, it } from 'vitest';
import { readWebmDurationMs } from '@server/modules/clips/webm.util';

describe('readWebmDurationMs', () => {
  it('reads float64 duration with default timecode scale', () => {
    expect(readFromBuffer(webm([element([0x44, 0x89], float64(7320))]))).toBe(7320);
  });

  it('applies timecode scale and float32 duration', () => {
    const info = [element([0x2a, 0xd7, 0xb1], Buffer.from([0x0f, 0x42, 0x40])), element([0x44, 0x89], float32(4))];
    expect(readFromBuffer(webm(info))).toBe(4);
  });

  it('skips sibling elements before Info inside an unknown-size segment', () => {
    const seekHead = element([0x11, 0x4d, 0x9b, 0x74], Buffer.alloc(20));
    const info = element([0x15, 0x49, 0xa9, 0x66], element([0x44, 0x89], float64(3000)));
    const segment = Buffer.concat([Buffer.from([0x18, 0x53, 0x80, 0x67, 0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]), seekHead, info]);
    expect(readFromBuffer(Buffer.concat([ebmlHeader(), segment]))).toBe(3000);
  });

  it('returns undefined when duration is absent or data is not webm', () => {
    expect(readFromBuffer(webm([element([0x2a, 0xd7, 0xb1], Buffer.from([0x0f, 0x42, 0x40]))]))).toBeUndefined();
    expect(readFromBuffer(Buffer.from('not a webm file'))).toBeUndefined();
  });
});

function readFromBuffer(buf: Buffer): number | undefined {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'webm-util-')), 'a.webm');
  fs.writeFileSync(file, buf);
  const fd = fs.openSync(file, 'r');
  try {
    return readWebmDurationMs(fd);
  } finally {
    fs.closeSync(fd);
    fs.rmSync(path.dirname(file), { recursive: true, force: true });
  }
}

function webm(infoChildren: Buffer[]): Buffer {
  const info = element([0x15, 0x49, 0xa9, 0x66], Buffer.concat(infoChildren));
  return Buffer.concat([ebmlHeader(), element([0x18, 0x53, 0x80, 0x67], info)]);
}

function ebmlHeader(): Buffer {
  return element([0x1a, 0x45, 0xdf, 0xa3], element([0x42, 0x82], Buffer.from('webm')));
}

/** 数据长度统一用 8 字节 vint 编码 */
function element(id: number[], data: Buffer): Buffer {
  const size = Buffer.alloc(8);
  size.writeUIntBE(data.length, 2, 6);
  size[0] = 0x01;
  return Buffer.concat([Buffer.from(id), size, data]);
}

function float64(value: number): Buffer {
  const buf = Buffer.alloc(8);
  buf.writeDoubleBE(value);
  return buf;
}

function float32(value: number): Buffer {
  const buf = Buffer.alloc(4);
  buf.writeFloatBE(value);
  return buf;
}
